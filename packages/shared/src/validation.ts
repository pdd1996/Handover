/**
 * 表单校验引擎 —— 三端同源（TK-06，F1-08「必填校验、数值范围校验」+ C-09「报错必须点名」）。
 *
 * 定位：**F1-08 校验逻辑的单一权威实现**。h5 在「完成本卡」时本地拦截（本文件的消费方），
 * api 将在 TK-12 的 `POST /records/today/submit` 第 1 步（契约 §4「必填/范围校验 → 失败 400」）
 * 复用同一函数产出同构错误——两端同一口径，杜绝「前端拦一套、后端拦一套」。
 *
 * 产出结构与《API 契约》§2 对齐：`missing_fields[]` 逐条点名
 * （field/section/label/anchor，由 errors.ts `toMissingField` 生成，前端据此跳转定位），
 * `code` 按「缺失优先、越界其次」取错误码（两者同时存在时清单合并展示，C-09 不允许只报其一）。
 *
 * 数值范围口径（分层，避免擅定案数值——AGENTS.md 铁律）：
 * 1. **结构性约束（本阶段即生效）**：数值字段必须可解析为有限数且 ≥ `NUMERIC_MIN`（读数/压力
 *    /温度非负——负读数无业务意义，属录入错误而非运营阈值）；
 * 2. **精度上限与小数位（TK-12 起生效，TK-06 评审 M4 挂账的接入轮；小数位为 TK-12 评审
 *    修复轮 M1 增补）**：由 `FIELD_PRECISION`（§4.2 DECIMAL/INT 逐列精度）派生——
 *    位数上限 max = 10^(p−s) − 10^−s（INT 列取整）防超出列容量；小数位超列 s 点名越界
 *    （否则被 MySQL 静默四舍五入/抹零），两项合起来保证「提交侧写入值能原样落库」；
 * 3. **运营区间（预留，❓ 待科长确认）**：`FIELD_RANGES` 为逐字段 min/max，区间定稿后由
 *    configs 下发（TK-27 配置中心，F4-11「保存即全员生效」），届时填充本表或改为运行时注入，
 *    校验流程不变；与精度上限**合流使用**（两者交集，运营区间不得宽于列精度）。
 *    预警区间（lo_press_range 等，F4-04）是**预警**口径、不是**录入**校验口径，两者不混用。
 * 4. **文本长度与多选元素（TK-12 评审修复轮 M2/L3）**：`FIELD_LENGTHS`（varchar 列照录
 *    §4.2 DDL）超限点名；多选元素须为 string（成员性仍不校验，契约 §3.7）。
 */

import type { ErrorCode } from './enums';
import { FIELD_BY_NAME, FIELD_LENGTHS, FIELD_PRECISION, type RecordFieldName } from './fields';
import { toMissingField, type MissingField } from './errors';
import { isFilledValue, isRequiredField, type FieldValueGetter } from './cards';

/** 结构性下限：全部数值字段非负（负读数属录入错误；上限由列精度与 FIELD_RANGES 合流派生） */
export const NUMERIC_MIN = 0;

/** 逐字段数值区间（❓ 运营区间待科长确认；定稿前为空 = 仅做非负结构校验） */
export type FieldRange = { readonly min?: number; readonly max?: number };
export const FIELD_RANGES: Readonly<Partial<Record<RecordFieldName, FieldRange>>> = {};

/**
 * 把输入值解析为数值：number 原样校验有限性；字符串（表单输入、decimal 列回显）仅接受
 * **十进制字面量**（TK-12 收紧，TK-06 评审 M5 挂账项：原 `Number()` 宽松口径会把 '0x10'
 * 当 16、'1e3' 当 1000 放行，与「纸质表单抄录十进制读数」的业务语义不符）；
 * 空串/非十进制字面量/Infinity → null（调用方按「越界/非法」处理）。
 */
const DECIMAL_LITERAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

export function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '' || !DECIMAL_LITERAL.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 由列精度派生的录入上限（TK-12，F1-08-T2「数值超范围 → 拦截并点名」的上限半边）：
 * max = 10^(p−s) − 10^−s——整数位最多 p−s 位、小数位最多 s 位（如 t1_p830 (5,2) → 999.99；
 * 瓶库 INT (10,0) → 9999999999）。未登记精度的数值字段返回 null（不做精度上限校验，
 * 漏登记由 fields.ts NUMERIC_FIELDS_MISSING_PRECISION 哨兵暴露）。
 */
export function numericMaxOf(name: RecordFieldName): number | null {
  const precision = FIELD_PRECISION[name];
  if (!precision) return null;
  const [p, s] = precision;
  return 10 ** (p - s) - 10 ** -s;
}

/** 校验结果：缺失（必填未填）与越界（数值非法/超区间）分列，均为契约 §2 点名结构 */
export interface ValidationResult {
  /** 必填未填（code → VALIDATION_MISSING_FIELDS） */
  readonly missing: readonly MissingField[];
  /** 数值非法/越界（code → VALIDATION_OUT_OF_RANGE） */
  readonly outOfRange: readonly MissingField[];
}

/**
 * 对给定字段清单执行 F1-08 校验。
 *
 * - `names` 传单卡字段即「完成本卡」的卡内校验（h5）；传全量 `FIELD_NAMES` 即提交级校验（TK-12）；
 * - 必填判定走 `isRequiredField` 动态口径（条件必填按已填值触发）；
 * - 数值字段仅对**已填**值做范围校验（未填且必填 → missing，未填且选填 → 跳过）。
 */
export function validateFields(
  names: readonly RecordFieldName[],
  get: FieldValueGetter,
): ValidationResult {
  const missing: MissingField[] = [];
  const outOfRange: MissingField[] = [];

  for (const name of names) {
    const value = get(name);
    if (!isFilledValue(value)) {
      if (isRequiredField(name, get)) missing.push(toMissingField(name));
      continue;
    }
    // 文本列长度（TK-12 评审修复轮 M2）：varchar 列超限会被 MySQL 严格模式拒绝（500），
    // 拦为 400 点名；含 kind='enum' 但列承载为 varchar 的 boiler_no（configs 候选原文可超长）
    const maxLen = FIELD_LENGTHS[name];
    if (maxLen !== undefined && typeof value === 'string' && value.trim().length > maxLen) {
      outOfRange.push(toMissingField(name));
      continue;
    }
    // 多选元素类型（TK-12 评审修复轮 L3）：hvac_locs 原样落库（契约 §3.7 不校验成员性），
    // 但非字符串元素会使 h5 复选框渲染与展示失真，拦为 400 点名
    if (FIELD_BY_NAME[name].kind === 'multi') {
      if (Array.isArray(value) && !value.every((item) => typeof item === 'string')) {
        outOfRange.push(toMissingField(name));
      }
      continue;
    }
    if (FIELD_BY_NAME[name].kind !== 'number') continue;
    const n = parseNumeric(value);
    if (n === null || n < NUMERIC_MIN) {
      outOfRange.push(toMissingField(name));
      continue;
    }
    // 列精度小数位（TK-12 评审修复轮 M1）：max = 10^(p−s) − 10^−s 只能拦位数上限，
    // 拦不住超 scale 的静默改写（实证：100.05 入 (12,1) 被四舍五入 100.1、0.0000001
    // 入 (5,2) 被抹零 0.00）——小数位超列 s 点名越界，与「写入值必须能原样落库」
    // 的承诺对齐。toFixed 往返比对对浮点误差安全（999.99 in (5,2) 等边界不误报）
    const precision = FIELD_PRECISION[name];
    if (precision) {
      const scale = precision[1];
      if (Number(n.toFixed(scale)) !== n) {
        outOfRange.push(toMissingField(name));
        continue;
      }
    }
    // 运营区间与精度上限合流（TK-12）：有效区间 = 两者交集——运营区间不得宽于列精度，
    // 一方未定义时以另一方为准
    const range = FIELD_RANGES[name];
    const min = Math.max(NUMERIC_MIN, range?.min ?? NUMERIC_MIN);
    const max = Math.min(numericMaxOf(name) ?? Infinity, range?.max ?? Infinity);
    if (n < min || n > max) outOfRange.push(toMissingField(name));
  }

  return { missing, outOfRange };
}

/** 组装后的错误体（契约 §2 除 request_id 外的字段）；无任何违规时为 null */
export interface ValidationErrorBody {
  readonly code: ErrorCode;
  /** 人类可读概要（C-09 禁止模糊提示——概要只计数量，逐条点名交给 missing_fields） */
  readonly message: string;
  /** 缺失在前、越界在后，前端逐条展示并支持锚点跳转 */
  readonly missing_fields: readonly MissingField[];
}

/** 校验结果 → 契约 §2 错误体；无违规返回 null（可直接用于 400 响应或本地错误面板） */
export function buildValidationError(result: ValidationResult): ValidationErrorBody | null {
  const { missing, outOfRange } = result;
  if (missing.length === 0 && outOfRange.length === 0) return null;

  // 缺失优先：必填未填比数值越界更「上游」，先补齐再谈数值（TK-12 submit 第 1 步同序）
  if (missing.length > 0) {
    return {
      code: 'VALIDATION_MISSING_FIELDS',
      message: `有 ${missing.length} 项必填未填，请逐条补齐`,
      missing_fields: [...missing, ...outOfRange],
    };
  }
  return {
    code: 'VALIDATION_OUT_OF_RANGE',
    message: `有 ${outOfRange.length} 项数值超出允许范围`,
    missing_fields: [...outOfRange],
  };
}

/** 便捷封装：一步完成「校验 + 组装错误体」，无违规返回 null */
export function validateForError(
  names: readonly RecordFieldName[],
  get: FieldValueGetter,
): ValidationErrorBody | null {
  return buildValidationError(validateFields(names, get));
}
