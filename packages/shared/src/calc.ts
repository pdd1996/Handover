/**
 * 用量计算与时刻派生 —— 三端同源（TK-09 液氧板块专项起步，TK-13 计算引擎扩展）。
 *
 * 定位：技术方案 §4.3 计算口径的**纯函数实现**（无 IO、无框架依赖）。TK-09 先落液氧部分
 * （DATA-04 日间用量按在用罐取数 + DATA-13 实际测量时刻），TK-13 将以同一模块补齐
 * 水/电/气三类口径并在提交时服务端计算固化（契约 §4 第 3 步）——届时本文件即计算引擎主体，
 * h5 预览展示与 api 提交计算消费同一实现，杜绝两端各算一套。
 *
 * 出处：技术方案 §4.3「液氧日间用量 = 在用罐 c830 − c2030」（PRD v0.2.5 修订 2 定案，
 * 决策记录修订 10 联动）；DATA-13/D-P12「读数自动记录实际测量时刻，名义时段仅用于卡片组织」。
 */

import { FIELD_PRECISION, type RecordFieldName } from './fields';
import { tankInUseOf, type FieldValueGetter, type TankNo } from './cards';
import { parseNumeric } from './validation';

/** 在用罐号 → 8:30 含量字段（显式映射，避免模板字符串拼接绕过 RecordFieldName 拼写检查） */
const CONTENT_830: Readonly<Record<TankNo, RecordFieldName>> = {
  1: 't1_c830',
  2: 't2_c830',
};

/** 在用罐号 → 20:30 含量字段 */
const CONTENT_2030: Readonly<Record<TankNo, RecordFieldName>> = {
  1: 't1_c2030',
  2: 't2_c2030',
};

/** 用量保留位数：与 records.decimal(8,2) 列一致（§4.2），防浮点差值尾差入库 */
const USE_SCALE = 100;

/** 水/电/气读数与用量的列小数位（(12,1)，FIELD_PRECISION）×10 */
const METER_SCALE = 10;

/**
 * 服务端计算固化的用量字段清单（契约 §4 第 3 步「用量计算并固化」；TK-13）。
 * 同时是**覆盖协议的唯一合法键集**（dto `UsageOverridePayload.field`）：sections 里的
 * `*_use` 键恒不被信任，显式覆盖必须走 `usage_overrides[]` 并填原因（F3-06-T2）。
 * `lo_night_use` 不在其中——夜间用量是跨记录派生列（非 records 存储，F3-05，Phase 2）。
 */
export const USAGE_FIELDS = ['water_use', 'e_use', 'gas_use', 'lo_day_use'] as const;
export type UsageFieldName = (typeof USAGE_FIELDS)[number];

/** 用量字段的列精度小数位（来源 fields.ts `FIELD_PRECISION`，§4.2 DDL 抄录；未登记回落 2） */
export function usageScaleOf(field: UsageFieldName): number {
  return FIELD_PRECISION[field]?.[1] ?? 2;
}

/** 用量值按所在列的小数位取整（四舍五入）——自动值与覆盖值同一取整口径，防尾差入库 */
export function roundToScaleOf(field: UsageFieldName, value: number): number {
  const scale = usageScaleOf(field);
  return Math.round(value * 10 ** scale) / 10 ** scale;
}

/**
 * 液氧日间用量（DATA-04-T1 判据的单一权威实现）：**按所选在用罐取数**——
 * 在用罐 `c830 − c2030`，**备用罐读数不参与**（两罐均有读数时结果只随在用罐变化）。
 *
 * 返回 null 的情形（调用方按"无法自动计算"处理，提交时由 TK-12 校验接管）：
 * - `tank_in_use` 未选；
 * - 在用罐任一时点含量缺失或不可解析（**不回落备用罐**——备用罐读数与用量无关）。
 *
 * 差值可为负（日间补液使 20:30 > 8:30 的真实场景）：不夹逼、原样返回，补液/手工覆盖
 * 走 F3-06 原因留痕；TK-13 服务端计算将复用本函数口径并四舍五入到 2 位小数（USE_SCALE）。
 */
export function loDayUseOf(get: FieldValueGetter): number | null {
  const inUse = tankInUseOf(get);
  if (inUse === null) return null;
  const c830 = parseNumeric(get(CONTENT_830[inUse]));
  const c2030 = parseNumeric(get(CONTENT_2030[inUse]));
  if (c830 === null || c2030 === null) return null;
  return Math.round((c830 - c2030) * USE_SCALE) / USE_SCALE;
}

// ── TK-13 计算引擎：水/电/气三类口径（§4.3；上一班取数 = 相邻班次已提交记录，D-T17）──────

/**
 * 分线/分卡差值与合计的返回形状：电为「如意线 + 工贸线」（F3-02 分线同屏展示，D-P09），
 * 气为「主卡 + 副卡」（F3-03 剩余量减少值合计）。`total = line1 + line2`（再取整一次，
 * 防两线各自取整后和的尾差）。
 */
export interface LineUse {
  readonly line1: number;
  readonly line2: number;
  readonly total: number;
}

/**
 * 每日用水量（F3-01-T1 判据的单元权威实现）：本次读数 − 上一班读数（§4.3）。
 *
 * 返回 null 的情形（调用方按「无法自动计算」处理，用量列固化 null）：
 * - 上一班缺失（相邻班次无已提交记录，F3-07；补录随 TK-14）；
 * - 任一侧读数缺失或不可解析。
 *
 * 差值为负（换表底数等真实场景）不夹逼、原样返回；读数小于上一班的防呆确认（F1-12）
 * 属 TK-14 判定层，与本计算分层。
 */
export function waterDayUseOf(get: FieldValueGetter, prev: FieldValueGetter): number | null {
  const cur = parseNumeric(get('water_reading'));
  const base = parseNumeric(prev('water_reading'));
  if (cur === null || base === null) return null;
  return Math.round((cur - base) * METER_SCALE) / METER_SCALE;
}

/**
 * 每日用电量（F3-02-T1 单元权威实现）：**如意线差值 + 工贸线差值**（两线之和，D-P09），
 * 分线差值随 `line1/line2` 返回供同屏展示——严禁「读数之和」当用量（纸质曾犯，决策记录
 * D-P09 的立项理由）。四项读数任一缺失/不可解析 → null（不做单线部分计算，宁缺毋错）。
 */
export function eDayUseOf(get: FieldValueGetter, prev: FieldValueGetter): LineUse | null {
  const c1 = parseNumeric(get('e1_reading'));
  const b1 = parseNumeric(prev('e1_reading'));
  const c2 = parseNumeric(get('e2_reading'));
  const b2 = parseNumeric(prev('e2_reading'));
  if (c1 === null || b1 === null || c2 === null || b2 === null) return null;
  const line1 = Math.round((c1 - b1) * METER_SCALE) / METER_SCALE;
  const line2 = Math.round((c2 - b2) * METER_SCALE) / METER_SCALE;
  return { line1, line2, total: Math.round((line1 + line2) * METER_SCALE) / METER_SCALE };
}

/**
 * 每日天然气用量（F3-03-T1 单元权威实现）：主卡+副卡**剩余量减少值**合计——方向与水/电
 *相反（剩余量递减，差值 = 上一班 − 本次）。任一卡读数缺失 → null。
 *
 * 剩余量增大（充气）的负差**原样返回不夹逼**：「充气确认后该卡当日用量按 0 计、另一卡
 * 正常计算」（D-P14/技术方案修订 2）是**防呆确认成立后**的取数规则，属 TK-14 判定层——
 * 本函数在未确认时按原始差值返回，TK-14 接入 `confirmations` 后按卡清零再合计。
 */
export function gasDayUseOf(get: FieldValueGetter, prev: FieldValueGetter): LineUse | null {
  const c1 = parseNumeric(get('g1_remaining'));
  const b1 = parseNumeric(prev('g1_remaining'));
  const c2 = parseNumeric(get('g2_remaining'));
  const b2 = parseNumeric(prev('g2_remaining'));
  if (c1 === null || b1 === null || c2 === null || b2 === null) return null;
  const line1 = Math.round((b1 - c1) * METER_SCALE) / METER_SCALE;
  const line2 = Math.round((b2 - c2) * METER_SCALE) / METER_SCALE;
  return { line1, line2, total: Math.round((line1 + line2) * METER_SCALE) / METER_SCALE };
}

/**
 * 实际测量时刻的**本地时间戳**（DATA-13/D-P12）：格式 `YYYY-MM-DD HH:mm:ss`（与 MySQL
 * DATETIME 字面量同形，无时区歧义），取**本机时钟**——离线填写时服务端时刻不可得且不可信
 * （T2 判据：同步后不得被同步时刻覆盖），本机时间戳即唯一权威来源。
 *
 * 消费方：h5 `SectionView` 在写入液氧读数时调用（new Date() 默认参数）并写入草稿；
 * 提交时随 payload 上送（TK-12），服务端原样落库 `lo_measured_am/pm`。
 */
export function localMeasuredAt(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}
