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
import type { BadgeDto } from './dto';
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
 * 条件必填字段：是否需要填**取决于同卡其他字段的值**，故未触发前不计入进度条分母——
 * 否则师傅把该填的都填完，进度条仍到不了 100%，违反 F1-03-T1 判据「计数与实际一致」。
 *
 * 逐条出处：
 * - `hp_note` / `neg_note` / `air_note` / `boiler_note` / `coolroom_note` / `hvac_note`：
 *   附录 A 板块二「高配房是否正常 —— **异常时必填备注**」，其余状态字段同理（仅 status='bad' 时必填）
 * - `boiler_no` / `supply_temp` / `return_temp`：附录 A 板块五「**停机时置灰不填**」；
 *   DATA-05、TK-10「锅炉停机联动：停机时不参与必填校验」
 *
 * **本集合是「条件必填」的定义清单（静态），动态判定见 `isRequiredField`**：触发条件由同卡
 * 其他字段的已填值求值（备注类看状态是否 'bad'、锅炉三项看 boiler_run 是否 'run'），
 * 卡片与接口结构不变。
 *
 * 注：`t2_c830/t2_p830/t2_c2030/t2_p2030` 曾在本集合（TK-05 按「仅 tank_in_use=2 时必填」
 * 处理），与台账 **DATA-01「液氧两罐两时点的含量/压力均为必填（共 8 项，含 1 号罐压力）」**
 * （PRD v0.2.5 修订 3：demo 曾漏 1 号罐压力，已补齐）冲突——TK-06 起按 DATA-01 归位为**恒必填**。
 * 「在用罐由枚举选择驱动」（DATA-03/04）驱动的是**日间用量取数与卡片标题**，不是必填口径。
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
 * 该字段是否计入「应填」分母（F1-03 角标与顶部进度条）——**静态口径**。
 *
 * 口径：只数**师傅需要亲手填或选**的字段——`fill ∈ {manual, select}` 且非条件必填/纯选填。
 * 排除 `auto`（water_use / e_use / gas_use / lo_night_use / lo_measured_am|pm 等服务端派生列）
 * 与 `auto_editable`（lo_day_use 自动推荐值即视为已填），因为它们在提交前恒为 NULL
 * （契约 §4 第 3 步：用量由服务端提交时计算固化），计入分母会让进度条永远到不了 100%。
 *
 * **运行期请优先用 `isRequiredField(name, get)` 动态判定**（TK-06 起，dto.ts
 * `CardFieldStateDto.required` 已转动态口径）；本函数保留为「字段值全空时的静态分母」，
 * 供 `COUNTABLE_FIELD_TOTAL` 等总量常量与编译期锁定使用。
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

// ── 动态必填与实时角标（TK-06，F1-08 / F1-03）───────────────────────────────

/** 字段取值函数：入参字段名，返回当前值（无值为 null）。api 传 records 行取值，h5 传「草稿 ?? 服务端」合并取值 */
export type FieldValueGetter = (name: RecordFieldName) => unknown;

/**
 * 是否已填。**数值 0 与布尔 false 均算已填**（0 是有效读数），故不可用 falsy 判定；
 * 空字符串与空数组算未填（handover_note 留空、hvac_locs 未勾选）。
 * （与 records.service.ts 的 isFilled 同口径——三端共用本实现，防两处漂移。）
 */
export function isFilledValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * 备注类条件必填的触发字段：状态选「异常」（'bad'）时对应备注转必填
 * （附录 A「异常时必填备注」；ABNORMAL_STATUS 口径见 records.service.ts）。
 */
const NOTE_REQUIRED_WHEN_BAD: Readonly<Partial<Record<RecordFieldName, RecordFieldName>>> = {
  hp_note: 'hp_status',
  neg_note: 'neg_status',
  air_note: 'air_status',
  boiler_note: 'boiler_status',
  coolroom_note: 'coolroom_status',
  hvac_note: 'hvac_status',
};

/** 运行期才必填的字段：锅炉运行（boiler_run='run'）时锅炉号/出水/回水温度必填，停机不填（DATA-05） */
const REQUIRED_WHEN_BOILER_RUN: ReadonlySet<RecordFieldName> = new Set<RecordFieldName>([
  'boiler_no',
  'supply_temp',
  'return_temp',
]);

/** 锅炉「运行」枚举值（enums.ts RunStop；直接引用字面量避免循环依赖负担） */
const BOILER_RUN_ON = 'run';

/** 状态「异常」枚举值（enums.ts OkBadStatus） */
const STATUS_BAD = 'bad';

/**
 * 动态必填判定（F1-08 必填校验的单一权威实现，三端同源）：
 *
 * 0. **推定原则**（留痕，TK-06 评审遗漏二）：附录 A 数据字典**未设「必填」列**，除附录 A /
 *    台账明示的例外（备注类「异常时必填备注」、DATA-05「停机时置灰」、纯选填两条）外，
 *    其余 manual/select 字段**默认必填**——分支 5 的「恒必填」即该推定的落点。推定属保守
 *    口径（宁多点名、不漏校验）；若业务上存在新例外（如多选字段 hvac_locs 是否允许全不勾，
 *    新风停用季节是真实场景，见台账待确认清单第 9 项），须待确认后回改本函数与分母口径，
 *    消费端不得自行放宽；
 * 1. `fill ∉ {manual, select}`（auto/auto_editable 派生列）→ 恒不必填；
 * 2. 纯选填（OPTIONAL_FIELDS：handover_note / energy_note）→ 恒不必填；
 * 3. 备注类：对应状态字段 = 'bad' 时必填；
 * 4. 锅炉运行三项：boiler_run = 'run' 时必填；
 * 5. 其余 manual/select 字段**恒必填**——含液氧两罐两时点 8 项读数（DATA-01）。
 *
 * 分母口径随之动态化（dto.ts `CardFieldStateDto.required` 的 TK-06 转正）：
 * 未触发的条件必填不计入「应填」，师傅填完该填的进度条即可到 100%（F1-03-T1）。
 */
export function isRequiredField(name: RecordFieldName, get: FieldValueGetter): boolean {
  const def = FIELD_BY_NAME[name];
  if (def.fill !== 'manual' && def.fill !== 'select') return false;
  if (OPTIONAL_FIELDS.has(name)) return false;
  const noteTrigger = NOTE_REQUIRED_WHEN_BAD[name];
  if (noteTrigger) return get(noteTrigger) === STATUS_BAD;
  if (REQUIRED_WHEN_BOILER_RUN.has(name)) return get('boiler_run') === BOILER_RUN_ON;
  return true;
}

/**
 * 按当前字段值实时计算卡片角标（F1-03「实时汇总已填/待填/异常」）。
 *
 * api 端（GET /records/today）与 h5 端（草稿合并值）共用：服务端传 records 行取值，
 * h5 传「本地草稿 ?? 服务端值」的合并取值，两端同一函数、同一口径，杜绝各算一套。
 * 「已填」与「异常」不互斥：状态字段 = 'bad' 时 filled 与 abnormal 同时 +1（dto.ts 注）。
 */
export function computeCardBadge(card: CardDef, get: FieldValueGetter): BadgeDto {
  let filled = 0;
  let total = 0;
  let abnormal = 0;
  for (const name of card.fields) {
    const value = get(name);
    const required = isRequiredField(name, get);
    if (required) {
      total += 1;
      if (isFilledValue(value)) filled += 1;
    }
    if (FIELD_BY_NAME[name].kind === 'status' && value === STATUS_BAD) abnormal += 1;
  }
  return { filled, total, pending: total - filled, abnormal };
}

// ── 液氧使用罐号与测量时刻（TK-09，DATA-03 / DATA-04 / DATA-13）────────────────

/** 使用罐号（schema `mysqlEnum('1','2')`；前端 radio name 与草稿可能存数字或字符串） */
export type TankNo = 1 | 2;

/** 两罐角色（DATA-03：标题随选择动态显示在用/备用） */
export type TankRole = 'in_use' | 'backup';

/** 字段名 → 罐号（`t1_*` → 1、`t2_*` → 2；非两罐读数字段返回 null） */
export function tankNoOfField(name: RecordFieldName): TankNo | null {
  if (name.startsWith('t1_')) return 1;
  if (name.startsWith('t2_')) return 2;
  return null;
}

/**
 * 当前在用罐号（DATA-03 枚举取数的单一入口）：`tank_in_use` 未选或非法时为 null。
 * 消费方：h5 卡片标题/行标签动态渲染、shared `loDayUseOf` 取数（DATA-04）。
 */
export function tankInUseOf(get: FieldValueGetter): TankNo | null {
  const v = get('tank_in_use');
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return n === 1 || n === 2 ? n : null;
}

/**
 * 某字段（两罐读数）当前的角色：在用 / 备用；罐号未选或字段非两罐读数时为 null。
 * 判据 DATA-03-T1「选 1 号 → 1 号'在用'、2 号'备用'」的单一权威实现——
 * h5 SectionView 行标签与首页液氧卡标题后缀共用，杜绝两处各写一套。
 */
export function tankRoleOf(name: RecordFieldName, get: FieldValueGetter): TankRole | null {
  const tank = tankNoOfField(name);
  const inUse = tankInUseOf(get);
  if (tank === null || inUse === null) return null;
  return tank === inUse ? 'in_use' : 'backup';
}

/** 测量时刻字段（DATA-13，records 列名） */
export type MeasuredAtField = 'lo_measured_am' | 'lo_measured_pm';

/**
 * 液氧读数 → 所在时点的测量时刻字段（DATA-13/D-P12：填写时自动记录实际测量时刻）。
 *
 * 映射与 cards.ts 头部「830/2030 后缀切分」同源：带 `830` 后缀的读数归属 8:30 卡，
 * 写入时自动钉 `lo_measured_am`；带 `2030` 后缀的钉 `lo_measured_pm`。消费方：
 * h5 `SectionView` 写值联动（时刻随读数进草稿，离线即本机时间戳）；单元哨兵
 * `records-lo.spec.ts` 断言本表键集合恰为液氧 8 项读数，漏项/多项显式红。
 */
export const MEASURED_AT_TARGET: Readonly<Partial<Record<RecordFieldName, MeasuredAtField>>> = {
  t1_c830: 'lo_measured_am',
  t1_p830: 'lo_measured_am',
  t2_c830: 'lo_measured_am',
  t2_p830: 'lo_measured_am',
  t1_c2030: 'lo_measured_pm',
  t1_p2030: 'lo_measured_pm',
  t2_c2030: 'lo_measured_pm',
  t2_p2030: 'lo_measured_pm',
};

/** 当前字段的测量时刻落点（非液氧读数返回 null） */
export function measuredAtTarget(name: RecordFieldName): MeasuredAtField | null {
  return MEASURED_AT_TARGET[name] ?? null;
}

// ── 上一班读数带出映射（TK-07，F1-05 / DATA-02）────────────────────────────────────────

/**
 * 带出取值映射：当前字段 → 上一班记录中的**源字段名**（未列出者取同名字段）。
 *
 * 唯一的跨时点映射在液氧 8:30 卡：DATA-02「液氧 8:30 填写时带出**昨日 20:30** 值供比对」
 * （测试用例判据原文「取昨日记录 20:30（非今日）」）——今日 8:30 读数的前一基准是
 * 上一班记录的 20:30 读数，而非上一班记录的同名 8:30 字段。20:30 卡（lo_pm）与
 * 其余卡片均取同名字段（同时点跨记录比对）。
 *
 * 消费方：api 端不做映射（GET /records/today/prev 原样回传上一班 readings，见 dto.ts），
 * h5 端渲染上一班比对值时经本函数取源字段——三端同源，杜绝前端各写一份映射而漂移。
 */
export const PREV_SOURCE_FIELD: Readonly<Partial<Record<RecordFieldName, RecordFieldName>>> = {
  t1_c830: 't1_c2030',
  t1_p830: 't1_p2030',
  t2_c830: 't2_c2030',
  t2_p830: 't2_p2030',
};

/** 当前字段的上一班比对源字段名（未列入映射者取同名字段） */
export function prevSourceField(name: RecordFieldName): RecordFieldName {
  return PREV_SOURCE_FIELD[name] ?? name;
}
