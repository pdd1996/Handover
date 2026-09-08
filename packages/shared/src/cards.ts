/**
 * 首页 12 张任务卡字典 —— 三端同源（TK-05，F1-02「12 张任务卡按巡检点位/时段组织」）。
 *
 * ## 12 的确切构成（逐项有据，不靠凑）
 * 《开发种子数据 v0.1》§三 spots 表共 11 个点位，其中「液氧站」按 F1-02 拆为 8:30 / 20:30
 * 两张到点卡，其余 10 个点位各一张 → **10 + 2 = 12**。组织顺序 = spots.sort_no 升序，
 * 液氧两卡在液氧站位置连续排列（8:30 在前）。
 *
 * ## 为什么按「巡检点位」而非「板块」组织
 * PRD §6.0 原文把两件事分开说：「按**巡检点位/时段**组织的 12 张任务卡」+「点卡片进入**板块**
 * 填写页」——组织维度是点位，进入目标才是板块。PRD §6.1 举的例子（表房、液氧站、锅炉房、泵房、
 * 电梯）与 spots 表点位名逐字吻合；台账 F1-02「技术方案」列亦明确 = `spots 表`。
 *
 * 与 demo v0.3 的差异（demo 按板块组织：板块五合一卡、板块八独立一卡，凑成 12）属**历史漂移**：
 * spots 表于 2026-08-29（技术方案修订 4）新增、demo v0.3 于 2026-08-31 验收、11 个具体点位
 * 于 2026-09-01 才在种子数据定案——demo 制作时尚无点位清单，只能按板块凑数。且 demo 自身亦不一致：
 * 其首页提示语写「按巡检路线到点位点开卡片填写」，卡片却以板块序号为主标题。
 * 按 AGENTS.md「Demo 不是正式实现，正式系统仍须按台账逐条实现与验收」，正式系统以 spots 表为准；
 * 该切分差异记入 TK-39（demo v0.4 状态补齐）。
 *
 * ## 与 spots 表的分工
 * - **点位存在性与顺序由 spots 表驱动**（status='active'，按 sort_no 升序）——科长可在后台增删（F6-07）
 * - **卡片 → 字段映射由本字典提供**：一个板块会被多个点位分摊（板块四拆液氧站/瓶库、
 *   板块五拆锅炉房/制冷机房），故映射必须精确到字段名。这属 DATA-11「字段结构与纸质表单一致」
 *   范畴，与 fields.ts 同源放 shared，杜绝前后端各存一份而漂移。
 * - spots 表中本字典无映射的点位 → 不出卡并记警告日志（后台新增点位后需回补本字典）
 *
 * ## 板块覆盖：12 卡恰好覆盖板块 1–10 全部
 * - **板块八「节能减排」无对应点位**（附录 A 该板块仅 energy_note 一字段且注明"无则可留空"，
 *   《开发种子数据》§三亦写明"板块八随附录 A 落位"）。但 PRD §6.1 In Scope 要求"十个板块的
 *   完整结构化填写"，故必须有入口 → 由**值班室卡兼管**（sections=[10, 8]）：两者同属文字记录类、
 *   同为选填，师傅在值班室一并记录符合实际巡检动线。此举免去为板块八新增 spots 点位
 *   （那要改种子与计数、且点位名需总务科确认）。
 * - **板块 0「基础信息」**（日期/交接时间/交班人/接班人）：自动带出，属页面头部与提交预览
 *   （TK-12）范畴，非巡检点位卡，故不占卡。
 *
 * ## 卡片 → 字段的切分依据
 * 附录 A 板块四**未**规定哪些字段归 8:30 卡、哪些归 20:30 卡（仅注明"名义时段 8:30/20:30
 * 只用于卡片组织与展示"）。本字典按字段语义与时点的绑定关系切分：带 `830` 后缀与早间测量时刻
 * 归 8:30 卡，带 `2030` 后缀与晚间测量时刻归 20:30 卡。
 * ❓ **液氧站出口压力、高压氧舱回路出口压力**两项不分时点（一天一份），暂归 8:30 卡
 * （早间接班首次到站时记录），归属待科长确认后调整——只影响卡片组织，不影响字段与计算口径。
 */

import type { RecordFieldName } from './fields';
import { FIELD_BY_NAME } from './fields';
import type { SectionNo } from './sections';

/** 卡片 key（稳定标识；不用 sort_no，因后台可调整点位排序） */
export const CardKey = [
  'water',
  'electricity',
  'gas',
  'lo_am',
  'lo_pm',
  'cylinder',
  'boiler',
  'cooling',
  'pump',
  'hvac',
  'elevator',
  'duty_desk',
] as const;
export type CardKey = (typeof CardKey)[number];

/** 到点卡的时段槽（PRD §6.1：液氧拆 8:30 / 20:30 两张"到点卡"） */
export const CardSlot = ['am', 'pm'] as const;
export type CardSlot = (typeof CardSlot)[number];

/** 卡片形态：form = 走 records 字段填写；elevator = 走 elevator_checks 逐台核对（契约 §3.3） */
export const CardKind = ['form', 'elevator'] as const;
export type CardKind = (typeof CardKind)[number];

export interface CardDef {
  /** 稳定标识（前端锚点 / 路由参数） */
  readonly key: CardKey;
  /** 匹配 spots.name —— 卡片是否出现由 spots 表驱动 */
  readonly spotName: string;
  /** 到点卡的时段槽；非到点卡为 null */
  readonly slot: CardSlot | null;
  /** 时段展示文案（PRD 与台账均写作 8:30 / 20:30） */
  readonly slotLabel: string | null;
  /**
   * 本卡覆盖的板块号，**首位为主板块**（用于卡片标题与 UI 归类）。
   * 多数卡为单板块；值班室卡为 `[10, 8]`——兼管板块八「节能减排」（该板块无点位，见头部说明）。
   * 注意与"字段自身的板块号"（`FIELD_BY_NAME[name].section`）区分：C-09 报错点名用的
   * `missing_fields[].section` 取**字段真实板块号**（跳转定位到表单板块），不取卡片归属。
   */
  readonly sections: readonly SectionNo[];
  /** 卡片标题（点位名；到点卡在 UI 上叠加时段） */
  readonly title: string;
  /** 卡片形态 */
  readonly kind: CardKind;
  /**
   * 本卡覆盖的全部字段（含 fill='auto' 的派生列，供 TK-06 渲染"自动计算"展示值）。
   * 计入进度条分母的子集由 `cardCountableFields()` 过滤得出。
   * 电梯卡为空数组——核对明细落 elevator_checks 逐台一行，不在 records 字段字典内。
   */
  readonly fields: readonly RecordFieldName[];
}

/**
 * 12 张任务卡（顺序即首页展示顺序：spots.sort_no 升序，液氧 8:30 在 20:30 之前）。
 * `satisfies` + `RecordFieldName` 使写错字段名在编译期即失败。
 */
export const TASK_CARDS = [
  {
    key: 'water',
    spotName: '表房',
    slot: null,
    slotLabel: null,
    sections: [1],
    title: '表房',
    kind: 'form',
    fields: ['water_reading', 'water_use'],
  },
  {
    key: 'electricity',
    spotName: '高配房',
    slot: null,
    slotLabel: null,
    sections: [2],
    title: '高配房',
    kind: 'form',
    fields: ['e1_reading', 'e2_reading', 'e_use', 'hp_status', 'hp_note'],
  },
  {
    key: 'gas',
    spotName: '燃气表房',
    slot: null,
    slotLabel: null,
    sections: [3],
    title: '燃气表房',
    kind: 'form',
    fields: ['g1_remaining', 'g2_remaining', 'gas_use'],
  },
  {
    key: 'lo_am',
    spotName: '液氧站',
    slot: 'am',
    slotLabel: '8:30',
    sections: [4],
    title: '液氧站',
    kind: 'form',
    fields: [
      'tank_in_use',
      't1_c830',
      't1_p830',
      't2_c830',
      't2_p830',
      'lo_measured_am',
      'lo_night_use',
      // ❓ 以下两项不分时点，暂归 8:30 卡（早间首次到站记录），归属待科长确认
      'lo_station_press',
      'hbo_press',
    ],
  },
  {
    key: 'lo_pm',
    spotName: '液氧站',
    slot: 'pm',
    slotLabel: '20:30',
    sections: [4],
    title: '液氧站',
    kind: 'form',
    fields: ['t1_c2030', 't1_p2030', 't2_c2030', 't2_p2030', 'lo_measured_pm', 'lo_day_use'],
  },
  {
    key: 'cylinder',
    spotName: '瓶库',
    slot: null,
    slotLabel: null,
    sections: [4],
    title: '瓶库',
    kind: 'form',
    fields: [
      'b40',
      'b10',
      'b6',
      'b_co2',
      'b_pulm',
      'manifold_press',
      'co2_out_press',
      'neg_status',
      'neg_note',
      'air_status',
      'air_note',
    ],
  },
  {
    key: 'boiler',
    spotName: '锅炉房',
    slot: null,
    slotLabel: null,
    sections: [5],
    title: '锅炉房',
    kind: 'form',
    fields: [
      'boiler_status',
      'boiler_note',
      'boiler_run',
      'boiler_no',
      'supply_temp',
      'return_temp',
    ],
  },
  {
    key: 'cooling',
    spotName: '制冷机房',
    slot: null,
    slotLabel: null,
    sections: [5],
    title: '制冷机房',
    kind: 'form',
    fields: ['coolroom_status', 'coolroom_note', 'cool_run'],
  },
  {
    key: 'pump',
    spotName: '泵房',
    slot: null,
    slotLabel: null,
    sections: [6],
    title: '泵房',
    kind: 'form',
    fields: [
      'h1_set_temp',
      'h1_out_temp',
      'h3_set_temp',
      'h3_out_temp',
      'p1_press',
      'p1_level',
      'p1_height',
      'p3_press',
      'p3_level',
      'p3_height',
    ],
  },
  {
    key: 'hvac',
    spotName: '新风机房',
    slot: null,
    slotLabel: null,
    sections: [7],
    title: '新风机房',
    kind: 'form',
    fields: ['hvac_status', 'hvac_note', 'hvac_locs'],
  },
  {
    key: 'elevator',
    spotName: '电梯厅',
    slot: null,
    slotLabel: null,
    sections: [9],
    title: '电梯厅',
    kind: 'elevator',
    // 核对明细落 elevator_checks（逐台一行），不在 records 字段字典；见 fields.ts 头部说明
    fields: [],
  },
  {
    key: 'duty_desk',
    spotName: '值班室',
    slot: null,
    slotLabel: null,
    // 兼管板块八「节能减排」：该板块无 spots 点位，但 PRD §6.1 要求十板块完整可填（见头部说明）
    sections: [10, 8],
    title: '值班室',
    kind: 'form',
    fields: ['handover_note', 'energy_note'],
  },
] as const satisfies readonly CardDef[];

/**
 * 编译期锁定 F1-02 的「12 张」：TASK_CARDS 因 `as const` 使 length 为字面量 12，
 * 若增删卡片，此行的类型注解即报错——把"12 张任务卡"这条规格钉在类型系统里。
 */
export const CARD_COUNT: 12 = TASK_CARDS.length;

/**
 * key → 卡片定义。
 * 元组显式标注为 `[CardKey, CardDef]`：TASK_CARDS 经 `as const` 后元素为字面量类型，
 * 不标注则 fromEntries 的值型是字面量联合，与 CardDef 重叠不足而报错。
 */
export const CARD_BY_KEY: Readonly<Record<CardKey, CardDef>> = Object.fromEntries(
  TASK_CARDS.map((c) => [c.key, c] as [CardKey, CardDef]),
) as Readonly<Record<CardKey, CardDef>>;

/**
 * 编译期校验：`CardKey` 联合与 TASK_CARDS 实际 key 集合**双向一致**。
 * 上行用了 `as` 断言（fromEntries 只能给出字符串索引签名），故补此校验：
 * 字典增删卡而未同步 CardKey（或反之）时，类型为 never，下行赋 true 即编译失败。
 */
type CardKeysInDict = (typeof TASK_CARDS)[number]['key'];
type AssertCardKeysMatch = [CardKey] extends [CardKeysInDict]
  ? [CardKeysInDict] extends [CardKey]
    ? true
    : never
  : never;
export const CARD_KEYS_MATCH: AssertCardKeysMatch = true;

/**
 * 条件必填字段：是否需要填**取决于同卡其他字段的值**，故不计入进度条分母——
 * 否则师傅把该填的都填完，进度条仍到不了 100%，违反 F1-03-T1 判据「计数与实际一致」。
 *
 * 逐条出处：
 * - `hp_note` / `neg_note` / `air_note` / `boiler_note` / `coolroom_note` / `hvac_note`：
 *   附录 A 板块二「高配房是否正常 —— **异常时必填备注**」，其余状态字段同理（仅 status='bad' 时必填）
 * - `boiler_no` / `supply_temp` / `return_temp`：附录 A 板块五「**停机时置灰不填**」；
 *   DATA-05、TK-10「锅炉停机联动：停机时不参与必填校验」
 * - `t2_c830` / `t2_p830` / `t2_c2030` / `t2_p2030`：仅当 `tank_in_use`=2 时必填
 *   （PRD v0.2.5「在用罐由枚举选择驱动」；DATA-03/04、TK-09）
 *
 * **TK-06 落地 F1-08（必填校验）时，此处升级为按已填值动态判定**（如 tank_in_use 已选 2 号
 * 则 t2_* 转为必填并重算分母）；届时只需改本集合的求值方式，卡片与接口结构不变。
 */
export const CONDITIONAL_FIELDS: ReadonlySet<RecordFieldName> = new Set<RecordFieldName>([
  'hp_note',
  'neg_note',
  'air_note',
  'boiler_note',
  'coolroom_note',
  'hvac_note',
  'boiler_no',
  'supply_temp',
  'return_temp',
  't2_c830',
  't2_p830',
  't2_c2030',
  't2_p2030',
]);

/**
 * 纯选填字段：附录 A 明示可留空，无内容不算缺失（与"条件必填"语义不同，故分列）。
 * - `handover_note`：附录 A 板块十「**有内容时**接班人必须逐条确认」；DATA-08 同口径
 * - `energy_note`：附录 A 板块八「**无则可留空**」
 */
export const OPTIONAL_FIELDS: ReadonlySet<RecordFieldName> = new Set<RecordFieldName>([
  'handover_note',
  'energy_note',
]);

/** 不计入分母的字段 = 条件必填 + 纯选填 */
export const NON_COUNTABLE_FIELDS: ReadonlySet<RecordFieldName> = new Set<RecordFieldName>([
  ...CONDITIONAL_FIELDS,
  ...OPTIONAL_FIELDS,
]);

/**
 * 该字段是否计入「应填」分母（F1-03 角标与顶部进度条）。
 *
 * 口径：只数**师傅需要亲手填或选**的字段——`fill ∈ {manual, select}` 且非条件必填/纯选填。
 * 排除 `auto`（water_use / e_use / gas_use / lo_night_use / lo_measured_am|pm 等服务端派生列）
 * 与 `auto_editable`（lo_day_use 自动推荐值即视为已填），因为它们在提交前恒为 NULL
 * （契约 §4 第 3 步：用量由服务端提交时计算固化），计入分母会让进度条永远到不了 100%。
 */
export function isCountableField(name: RecordFieldName): boolean {
  const fill = FIELD_BY_NAME[name].fill;
  return (fill === 'manual' || fill === 'select') && !NON_COUNTABLE_FIELDS.has(name);
}

/** 某张卡计入分母的字段名清单（顺序沿用字典定义） */
export function cardCountableFields(card: CardDef): readonly RecordFieldName[] {
  return card.fields.filter(isCountableField);
}

/** 全部卡片计入分母的字段总数（顶部进度条分母） */
export const COUNTABLE_FIELD_TOTAL: number = TASK_CARDS.reduce(
  (sum, card) => sum + cardCountableFields(card).length,
  0,
);

/**
 * 字段名 → 所属卡 key（前端定位、C-09 锚点跳转用）。
 * 不变量：**一个字段只属一张卡**——否则角标与顶部进度条会重复计数，
 * 直接违反 F1-03-T1 判据「计数与实际一致」。重复项由 `DUPLICATE_CARD_FIELD_OWNERS` 暴露。
 */
export const CARD_BY_FIELD: Readonly<Partial<Record<RecordFieldName, CardKey>>> =
  Object.fromEntries(TASK_CARDS.flatMap((card) => card.fields.map((f) => [f, card.key])));

/**
 * 归属重复的字段名清单（**应恒为空**，由测试断言）。
 * 不在模块加载时抛错，避免 shared 被三端 import 时因静态字典笔误直接崩掉；
 * 改为显式导出，让违规在用例里以可读的失败信息暴露。
 */
export const DUPLICATE_CARD_FIELD_OWNERS: readonly RecordFieldName[] = (() => {
  const seen = new Set<RecordFieldName>();
  const dup: RecordFieldName[] = [];
  for (const card of TASK_CARDS) {
    for (const name of card.fields) {
      if (seen.has(name)) dup.push(name);
      seen.add(name);
    }
  }
  return dup;
})();

/**
 * 卡片覆盖的板块全集（应等于业务板块 1–10）——PRD §6.1 In Scope「十个板块的完整结构化填写」
 * 的可执行校验。板块 0（基础信息）为自动带出、不属巡检卡，故不在内。
 */
export const COVERED_SECTIONS: readonly SectionNo[] = [
  ...new Set<SectionNo>(TASK_CARDS.flatMap((c) => [...c.sections])).values(),
].sort((a, b) => a - b);
