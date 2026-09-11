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

import type { RecordFieldName } from './fields';
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
