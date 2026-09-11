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
 * 2. **运营区间（预留，❓ 待科长确认）**：`FIELD_RANGES` 为逐字段 min/max，区间定稿后由
 *    configs 下发（TK-27 配置中心，F4-11「保存即全员生效」），届时填充本表或改为运行时注入，
 *    校验流程不变。预警区间（lo_press_range 等，F4-04）是**预警**口径、不是**录入**校验口径，
 *    两者不混用。
 */

import type { ErrorCode } from './enums';
import { FIELD_BY_NAME, type RecordFieldName } from './fields';
import { toMissingField, type MissingField } from './errors';
import { isFilledValue, isRequiredField, type FieldValueGetter } from './cards';

/** 结构性下限：全部数值字段非负（负读数属录入错误；上限见 FIELD_RANGES，本阶段为空） */
export const NUMERIC_MIN = 0;

/** 逐字段数值区间（❓ 运营区间待科长确认；定稿前为空 = 仅做非负结构校验） */
export type FieldRange = { readonly min?: number; readonly max?: number };
export const FIELD_RANGES: Readonly<Partial<Record<RecordFieldName, FieldRange>>> = {};

/**
 * 把输入值解析为数值：number 原样校验有限性；字符串（表单输入、decimal 列回显）转数字；
 * 空串/非数字/Infinity → null（调用方按「越界/非法」处理）。
 */
export function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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
    if (FIELD_BY_NAME[name].kind !== 'number') continue;
    const n = parseNumeric(value);
    if (n === null || n < NUMERIC_MIN) {
      outOfRange.push(toMissingField(name));
      continue;
    }
    const range = FIELD_RANGES[name];
    if (range) {
      const { min, max } = range;
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        outOfRange.push(toMissingField(name));
      }
    }
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
