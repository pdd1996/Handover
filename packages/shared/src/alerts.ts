/**
 * 标红确认行（alerts）生成口径 —— 三端同源（TK-18）。
 *
 * 出处：技术方案 §5.3「确认项统一落 alerts 表：Phase 1 的表单级标红项（状态异常、
 * 电梯不一致）与交接事项（板块十有内容时，按条拆分为多条确认行——以换行或编号分条）」、
 * 《API 契约》§4 提交协议第 4 步、台账 DEP-08（Phase 1 标红项纳入逐条"已知晓"）。
 *
 * api 端在提交事务内据此生成 alerts 行（rule_key/target/level 形态与《开发种子数据》
 * §六 D-1 待确认单的配套标红行同形：状态异常 `{field}_bad`/`field:{field}`/high、
 * 交接事项 `handover_note`/`field:handover_note`/low，种子即口径的演示样例）；
 * h5 端消费 detail 响应的 alerts 置顶展示，不重复生成。
 */

/** alerts 行的 level（技术方案 §4.2 alerts.level 枚举） */
export type AlertLevel = 'high' | 'mid' | 'low';

/** level → 置顶序权重（F2-03「标红项置顶高亮」：高在前，同级按生成序） */
export const ALERT_LEVEL_RANK: Readonly<Record<AlertLevel, number>> = {
  high: 0,
  mid: 1,
  low: 2,
};

/** 状态异常标红行（PRD §6.4 预警规则表「状态=异常 → 高」的 Phase 1 标红过渡，DEP-07） */
export const STATUS_ALERT_LEVEL: AlertLevel = 'high';

/** 电梯不一致标红行（ELE-06/D-T22：level=mid，P2 转中预警推送） */
export const ELEVATOR_ALERT_LEVEL: AlertLevel = 'mid';

/** 交接事项标红行（板块十逐条确认，DATA-08：提示性质，非异常） */
export const HANDOVER_ALERT_LEVEL: AlertLevel = 'low';

/**
 * 交接事项拆条（技术方案 §5.3「按条拆分——以换行或编号分条」的单一权威实现）：
 * - 以换行分条；行首编号（`1.`、`1、`、`（1）`、`(1)`、`一、`）剥离后作为条目正文；
 * - 无换行时整段视为一条（师傅一行写完是合法输入，不强行再切）；
 * - 空行与纯编号行剔除；条目首尾空白裁剪。
 * 与《开发种子数据》§六 D-1 的两条交接事项拆条结果一致（'1. 扶梯异常…；' 与
 * '2. 表房…。' → 两条无编号正文），种子即本函数的黄金样例。
 */
export function handoverItemsOf(note: unknown): string[] {
  if (typeof note !== 'string') return [];
  const items: string[] = [];
  for (const rawLine of note.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    // 行首编号：全/半角括号包裹（（2）/ (3)）或阿拉伯/中文数字 + 分隔符（1. / 一、）；
    // 括号形态后无分隔符亦剥离
    const stripped = line.replace(
      /^(?:[（(][0-9一二三四五六七八九十]+[）)]|[0-9一二三四五六七八九十]+[.、．])\s*/,
      '',
    );
    if (stripped === '') continue; // 纯编号行（编号后无正文）不生成确认行
    items.push(stripped);
  }
  return items;
}
