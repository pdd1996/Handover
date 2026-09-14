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
import type { ConfirmItem, MissingField } from './errors';
import { toMissingField } from './errors';
import type { RecordFieldName } from './fields';
import { numericMaxOf, parseNumeric } from './validation';

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

/**
 * 未确认命中项 → 409 need_confirm 可解释清单（契约 §4 第 2 步，C-03 可解释文案的单一权威实现）。
 * api 提交侧组装 409 与 h5 离线提交预检（TK-15）共用：离线时无服务端 409 补救路径，
 * 确认收集必须前置到入队前——判定范围与文案若两端各写一套，离线入队的队列项会在
 * 同步时刻被服务端 409 拒绝而滞留。confirmed* 为已带确认的命中项（重提时不重复要求确认）。
 */
export function unconfirmedNeedConfirmItems(
  cur: FieldValueGetter,
  prev: FieldValueGetter,
  confirmedDecreased: ReadonlySet<DecreasedGuardField> = new Set(),
  confirmedRefills: ReadonlySet<1 | 2> = new Set(),
): ConfirmItem[] {
  return needConfirmItemsOf(
    cur,
    prev,
    (d) => !confirmedDecreased.has(d.field),
    (r) => !confirmedRefills.has(r.card),
  );
}

/**
 * 回退命中的**复用键**（TK-16 评审二轮 L1）：`field:prev:current` 三元组。
 * 重算（records.service recalcDownstreamInTx）会改变上一班基线，若按字段名复用旧确认，
 * 「新基线下更大/更小的回退」会被旧确认静默解锁（D-T20 M6「确认不跨提交复用」的同族
 * 陷阱）；仅当重算命中与原提交确认**完全相同**（三元组一致）才视为已确认。
 */
export function decreaseHitKey(field: DecreasedGuardField, prev: number, current: number): string {
  return `${field}:${prev}:${current}`;
}

/**
 * need_confirm 清单的**值匹配复用**变体（TK-16 评审二轮）：供重算链路消费——下游单原提交
 * 已确认过的回退（record.submit 审计 type=reading_decreased 行）只在重算命中与其**完全相同**
 * 时消音；基线变化产生的新命中一律重新标出。充气卡仍按卡号复用（D-P14 事实语义：
 * 「该卡确实充过气」不随基线变化，已确认卡按 0 计取数）。
 */
export function needConfirmItemsExcludingHits(
  cur: FieldValueGetter,
  prev: FieldValueGetter,
  confirmedDecreaseHits: ReadonlySet<string> = new Set(),
  confirmedRefills: ReadonlySet<1 | 2> = new Set(),
): ConfirmItem[] {
  return needConfirmItemsOf(
    cur,
    prev,
    (d) => !confirmedDecreaseHits.has(decreaseHitKey(d.field, d.prev, d.current)),
    (r) => !confirmedRefills.has(r.card),
  );
}

/** 两变体共用的清单组装（判定范围与文案单一来源，勿在消费方另写映射） */
function needConfirmItemsOf(
  cur: FieldValueGetter,
  prev: FieldValueGetter,
  keepDecreased: (d: DecreasedItem) => boolean,
  keepRefill: (r: RefillItem) => boolean,
): ConfirmItem[] {
  return [
    ...decreasedReadingsOf(cur, prev)
      .filter(keepDecreased)
      .map((d): ConfirmItem => ({
        type: 'reading_decreased',
        field: d.field,
        prev: d.prev,
        current: d.current,
        message: `本次读数 ${d.current} 小于上一班 ${d.prev}，请确认是否属实（换表底数/错抄须说明）`,
      })),
    ...refillCardsOf(cur, prev)
      .filter(keepRefill)
      .map((r): ConfirmItem => ({
        type: 'gas_refill',
        card: r.card,
        prev: r.prev,
        current: r.current,
        message: `${r.card === 1 ? '主卡' : '副卡'}剩余量 ${r.current} 大于上一班 ${r.prev}，如已充气请确认`,
      })),
  ];
}

/**
 * 补录上一班读数校验（TK-14 F3-07 / D-T19；TK-15 评审修复轮 L1 自 api records.service
 * 下沉 shared）：合法键集 `PREV_BACKFILL_FIELDS`，白名单外键忽略（与 sections 同一口径）；
 * 值须为十进制字面量且**非负、不超列容量上限**——脏基线不得进入 need_confirm 可解释文案
 * 与 record.prev_backfill 审计（TK-14 修复轮 L1 实证 '-500' 曾流入）。校验与消费解耦：
 * 垃圾值无论上一班是否缺失都不放行。api 提交侧与 h5 离线预检消费同一实现。
 */
export function validatePrevBackfillReadings(
  input: Readonly<Partial<Record<PrevBackfillField, unknown>>> | undefined,
): { outOfRange: MissingField[]; readings: Partial<Record<PrevBackfillField, number>> } {
  const outOfRange: MissingField[] = [];
  const readings: Partial<Record<PrevBackfillField, number>> = {};
  for (const [name, raw] of Object.entries(input ?? {})) {
    if (!PREV_BACKFILL_FIELDS.includes(name as PrevBackfillField)) continue;
    const n = parseNumeric(raw);
    const max = numericMaxOf(name as PrevBackfillField);
    if (n === null || n < 0 || n > (max ?? Infinity)) {
      outOfRange.push(toMissingField(name as PrevBackfillField));
      continue;
    }
    readings[name as PrevBackfillField] = n;
  }
  return { outOfRange, readings };
}
