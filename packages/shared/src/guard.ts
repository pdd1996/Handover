/**
 * 防呆判定纯函数 —— 三端同源（TK-14，F1-12/F1-13）。
 *
 * 定位：技术方案 §5.2「防呆规则」的**判定层**，与 calc.ts 的用量计算分层——
 * 计算层（§4.3）在防呆未确认时按原始差值返回（负差原样、不夹逼），确认后的取数规则
 * （充气卡按 0 计，D-P14）经 gasDayUseOf 的 refilled 参数接入；本模块只回答「哪些读数
 * 命中了防呆规则」，供 api 提交侧组装 409 need_confirm 清单（契约 §4 第 2 步）。
 *
 * 判定范围定案（决策记录 D-T19）：读数回退只看**累计走字表**（水/电两线，只能增不能减，
 * 减小 = 换表底数或错抄）；液氧含量随消耗递减是常态（补液走 F3-06 覆盖留痕），不在回退
 * 判定范围；气卡剩余量**增大**才是异常方向，单独走充气判定（F1-13/D-P14 单卡判定）。
 */

import type { FieldValueGetter } from './cards';
import type { RecordFieldName } from './fields';
import { parseNumeric } from './validation';

/** F1-12 读数回退判定字段：累计走字表读数（本次 < 上一班 → 409 要求确认） */
export const DECREASED_GUARD_FIELDS = ['water_reading', 'e1_reading', 'e2_reading'] as const;
export type DecreasedGuardField = (typeof DECREASED_GUARD_FIELDS)[number];

/** F1-13 充气判定：气卡号 → 剩余量字段（本次 > 上一班 → 409 要求充气确认，按卡逐项） */
export const GAS_CARD_FIELDS: Readonly<Record<1 | 2, RecordFieldName>> = {
  1: 'g1_remaining',
  2: 'g2_remaining',
};

/**
 * 补录白名单（F3-07）：上一班读数**参与计算**的全部字段 = 回退判定三字段 + 气卡两字段。
 * 液氧不含——日间用量只取本班两时点（loDayUseOf 不依赖上一班），夜间用量属 Phase 2 跨记录
 * 派生（F3-05）。补录值仅服务端消费（防呆比对基线 + 用量计算），见 dto `SubmitPayloadDto.prev_readings`。
 */
export const PREV_BACKFILL_FIELDS = [
  ...DECREASED_GUARD_FIELDS,
  'g1_remaining',
  'g2_remaining',
] as const;
export type PrevBackfillField = (typeof PREV_BACKFILL_FIELDS)[number];

/** 回退命中项（prev/current 为解析后的数值，供 need_confirm 可解释文案与审计留痕） */
export interface DecreasedItem {
  field: DecreasedGuardField;
  prev: number;
  current: number;
}

/** 充气命中项 */
export interface RefillItem {
  card: 1 | 2;
  prev: number;
  current: number;
}

/**
 * 读数回退命中清单（F1-12）：任一侧读数缺失/不可解析 → 不判定（上一班缺失属 F3-07
 * 缺失态，首班 F1-15 无比对基线——都放行，不误伤）。
 */
export function decreasedReadingsOf(
  cur: FieldValueGetter,
  prev: FieldValueGetter,
): DecreasedItem[] {
  const items: DecreasedItem[] = [];
  for (const field of DECREASED_GUARD_FIELDS) {
    const current = parseNumeric(cur(field));
    const base = parseNumeric(prev(field));
    if (current === null || base === null) continue;
    if (current < base) items.push({ field, prev: base, current });
  }
  return items;
}

/**
 * 充气命中清单（F1-13，D-P14 单卡判定）：任一卡剩余量**大于**上一班即命中——
 * 「合计为负才触发」会漏掉单卡小幅充气叠加另一卡正常用量的场景（决策记录 D-P14 立项理由）。
 */
export function refillCardsOf(cur: FieldValueGetter, prev: FieldValueGetter): RefillItem[] {
  const items: RefillItem[] = [];
  for (const card of [1, 2] as const) {
    const current = parseNumeric(cur(GAS_CARD_FIELDS[card]));
    const base = parseNumeric(prev(GAS_CARD_FIELDS[card]));
    if (current === null || base === null) continue;
    if (current > base) items.push({ card, prev: base, current });
  }
  return items;
}
