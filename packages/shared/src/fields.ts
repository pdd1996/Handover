/**
 * 字段字典 —— 三端同源（TK-03，DATA-11「十板块字段结构与纸质表单一致」落地）。
 *
 * 出处：PRD v0.2.8 附录 A 数据字典 + 技术方案 §4.2 records 建表列。
 * 每个字段 = records 一个列名（snake_case），带板块号、中文 label、单位、输入类型、填写方式。
 * 用途：C-09 报错点名（missing_fields[].field/section/label/anchor）、前端表单渲染、单位标注（F1-08）。
 *
 * 说明：
 * - 液氧含量/用量单位 ❓ 随 DATA-12 全局待核实，暂沿用 'L'（与种子 configs.lo_unit 一致），确认后此处与 configs 同步改。
 * - `lo_night_use`（液氧夜间用量，PRD v0.2.8 定案）是唯一例外：跨记录派生值（昨日 20:30 → 今日 8:30 差值，
 *   换罐日不计算并标注「当日换罐」），非 records 存储列；因表单展示与趋势（F5-02）需要其 label/单位，纳入字典。
 * - 板块九「电梯」的核对明细落 elevator_checks 表（逐台一行），非 records 单列，故不在本字典；
 *   电梯不一致说明缺失走 ELEVATOR_EXPLANATION_REQUIRED（target=elevator:{id}），见《API 契约》§3.3。
 * - 系统/流程列非表单填写字段，不纳入本字典：id、record_no、status、version、objection_note、
 *   confirmed_at、objection_at、escalated_at、created_at、updated_at、signature_path
 *   （submitted_at 为附录 A 表首「交接时间」字段，纳入；duty_date、submitter_id 同为附录 A 字段，纳入）。
 */

import type { SectionNo } from './sections';

/** 输入类型（附录 A「类型说明」）：数值/状态/枚举/多选/文本/时间/日期/自动 */
export const FieldKind = [
  'number',
  'status',
  'enum',
  'multi',
  'text',
  'time',
  'date',
  'auto',
] as const;
export type FieldKind = (typeof FieldKind)[number];

/** 填写方式（附录 A「填写方式」列） */
export const FieldFill = ['manual', 'auto', 'select', 'auto_editable'] as const;
export type FieldFill = (typeof FieldFill)[number];

export interface FieldDef {
  /** records 列名（missing_fields[].field） */
  readonly name: string;
  /** 所属板块号（missing_fields[].section） */
  readonly section: SectionNo;
  /** 中文名（missing_fields[].label，取自附录 A） */
  readonly label: string;
  /** 单位（F1-08 单位全程标注；无单位则省略） */
  readonly unit?: string;
  /** 输入类型 */
  readonly kind: FieldKind;
  /** 填写方式 */
  readonly fill: FieldFill;
}

/**
 * 字段字典（按板块归组；板块内顺序大体沿用附录 A）。
 * 以 `as const satisfies` 保留字面量类型（供 RecordFieldName 派生）并校验结构。
 */
export const FIELDS = [
  // ── 0 基础信息 ──────────────────────────────
  { name: 'duty_date', section: 0, label: '日期（班次起始日）', kind: 'date', fill: 'auto' },
  { name: 'submitted_at', section: 0, label: '交接时间', kind: 'time', fill: 'auto' },
  { name: 'submitter_id', section: 0, label: '交班人', kind: 'auto', fill: 'auto' },
  { name: 'receiver_id', section: 0, label: '接班人', kind: 'auto', fill: 'auto_editable' },
  {
    name: 'receiver_change_reason',
    section: 0,
    label: '接班人修改原因',
    kind: 'text',
    fill: 'manual',
  },

  // ── 1 水 ────────────────────────────────────
  {
    name: 'water_reading',
    section: 1,
    label: '水表读数',
    unit: '吨',
    kind: 'number',
    fill: 'manual',
  },
  { name: 'water_use', section: 1, label: '每日用水量', unit: '吨', kind: 'number', fill: 'auto' },

  // ── 2 电 ────────────────────────────────────
  {
    name: 'e1_reading',
    section: 2,
    label: '电表1（如意线）读数',
    unit: '度',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'e2_reading',
    section: 2,
    label: '电表2（工贸线）读数',
    unit: '度',
    kind: 'number',
    fill: 'manual',
  },
  { name: 'e_use', section: 2, label: '每日用电量', unit: '度', kind: 'number', fill: 'auto' },
  { name: 'hp_status', section: 2, label: '高配房是否正常', kind: 'status', fill: 'select' },
  { name: 'hp_note', section: 2, label: '高配房异常备注', kind: 'text', fill: 'manual' },

  // ── 3 天然气 ────────────────────────────────
  {
    name: 'g1_remaining',
    section: 3,
    label: '表1（主卡）剩余量',
    unit: '立方米',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'g2_remaining',
    section: 3,
    label: '表2（副卡）剩余量',
    unit: '立方米',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'gas_use',
    section: 3,
    label: '每日天然气用量',
    unit: '立方米',
    kind: 'number',
    fill: 'auto',
  },

  // ── 4 医用气体（单位 ❓ DATA-12）──────────────
  { name: 'tank_in_use', section: 4, label: '使用罐号', kind: 'enum', fill: 'select' },
  {
    name: 't1_c830',
    section: 4,
    label: '1号液氧罐8:30含量',
    unit: 'L',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 't1_p830',
    section: 4,
    label: '1号液氧罐8:30压力',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 't1_c2030',
    section: 4,
    label: '1号液氧罐20:30含量',
    unit: 'L',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 't1_p2030',
    section: 4,
    label: '1号液氧罐20:30压力',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 't2_c830',
    section: 4,
    label: '2号液氧罐8:30含量',
    unit: 'L',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 't2_p830',
    section: 4,
    label: '2号液氧罐8:30压力',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 't2_c2030',
    section: 4,
    label: '2号液氧罐20:30含量',
    unit: 'L',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 't2_p2030',
    section: 4,
    label: '2号液氧罐20:30压力',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  { name: 'lo_measured_am', section: 4, label: '液氧早间测量时刻', kind: 'time', fill: 'auto' },
  { name: 'lo_measured_pm', section: 4, label: '液氧晚间测量时刻', kind: 'time', fill: 'auto' },
  {
    name: 'lo_day_use',
    section: 4,
    label: '液氧日间用量',
    unit: 'L',
    kind: 'number',
    fill: 'auto_editable',
  },
  // 派生字段（非 records 列，见头部说明）：夜间用量 = 昨日 20:30 → 今日 8:30 跨记录差值
  {
    name: 'lo_night_use',
    section: 4,
    label: '液氧夜间用量',
    unit: 'L',
    kind: 'number',
    fill: 'auto',
  },
  {
    name: 'lo_station_press',
    section: 4,
    label: '液氧站出口压力',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'hbo_press',
    section: 4,
    label: '液氧站高压氧舱回路出口压力',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  { name: 'b40', section: 4, label: '40L氧气满瓶', unit: '瓶', kind: 'number', fill: 'manual' },
  { name: 'b10', section: 4, label: '10L氧气满瓶', unit: '瓶', kind: 'number', fill: 'manual' },
  { name: 'b6', section: 4, label: '6L氧气满瓶', unit: '瓶', kind: 'number', fill: 'manual' },
  { name: 'b_co2', section: 4, label: '二氧化碳满瓶', unit: '瓶', kind: 'number', fill: 'manual' },
  {
    name: 'b_pulm',
    section: 4,
    label: '肺功能气体满瓶',
    unit: '瓶',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'manifold_press',
    section: 4,
    label: '瓶氧汇流排进口压力',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'co2_out_press',
    section: 4,
    label: '二氧化碳（手术室）出口压力',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  { name: 'neg_status', section: 4, label: '负压是否正常', kind: 'status', fill: 'select' },
  { name: 'neg_note', section: 4, label: '负压异常备注', kind: 'text', fill: 'manual' },
  { name: 'air_status', section: 4, label: '空气是否正常', kind: 'status', fill: 'select' },
  { name: 'air_note', section: 4, label: '空气异常备注', kind: 'text', fill: 'manual' },

  // ── 5 供暖/冷系统（停机时温度类置灰不填，DATA-05）──
  { name: 'boiler_status', section: 5, label: '锅炉房是否正常', kind: 'status', fill: 'select' },
  { name: 'boiler_note', section: 5, label: '锅炉房异常备注', kind: 'text', fill: 'manual' },
  { name: 'boiler_run', section: 5, label: '锅炉是否运行', kind: 'enum', fill: 'select' },
  { name: 'boiler_no', section: 5, label: '使用锅炉号', kind: 'enum', fill: 'select' },
  {
    name: 'supply_temp',
    section: 5,
    label: '出水温度',
    unit: '°C',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'return_temp',
    section: 5,
    label: '回水温度',
    unit: '°C',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'coolroom_status',
    section: 5,
    label: '制冷机房是否正常',
    kind: 'status',
    fill: 'select',
  },
  { name: 'coolroom_note', section: 5, label: '制冷机房异常备注', kind: 'text', fill: 'manual' },
  { name: 'cool_run', section: 5, label: '制冷是否运行', kind: 'enum', fill: 'select' },

  // ── 6 生活水泵（热/冷）──────────────────────
  {
    name: 'h1_set_temp',
    section: 6,
    label: '1号楼热水设置温度',
    unit: '°C',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'h1_out_temp',
    section: 6,
    label: '1号楼热水出口水温',
    unit: '°C',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'h3_set_temp',
    section: 6,
    label: '3号楼热水设置温度',
    unit: '°C',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'h3_out_temp',
    section: 6,
    label: '3号楼热水出口水温',
    unit: '°C',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'p1_press',
    section: 6,
    label: '1号楼水泵出口水压',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  { name: 'p1_level', section: 6, label: '1号楼水泵水位', kind: 'enum', fill: 'select' },
  {
    name: 'p1_height',
    section: 6,
    label: '1号楼水泵水位高度',
    unit: 'm',
    kind: 'number',
    fill: 'manual',
  },
  {
    name: 'p3_press',
    section: 6,
    label: '3号楼水泵出口水压',
    unit: 'MPa',
    kind: 'number',
    fill: 'manual',
  },
  { name: 'p3_level', section: 6, label: '3号楼水泵水位', kind: 'enum', fill: 'select' },
  {
    name: 'p3_height',
    section: 6,
    label: '3号楼水泵水位高度',
    unit: 'm',
    kind: 'number',
    fill: 'manual',
  },

  // ── 7 新风/空调系统 ─────────────────────────
  { name: 'hvac_status', section: 7, label: '新风性能情况', kind: 'status', fill: 'select' },
  { name: 'hvac_note', section: 7, label: '新风异常备注', kind: 'text', fill: 'manual' },
  { name: 'hvac_locs', section: 7, label: '新风使用位置', kind: 'multi', fill: 'select' },

  // ── 8 节能减排 ──────────────────────────────
  { name: 'energy_note', section: 8, label: '节能减排事项', kind: 'text', fill: 'manual' },

  // ── 10 其它（板块 9 电梯见 elevator_checks，不在本字典）──
  {
    name: 'handover_note',
    section: 10,
    label: '未完成/需强调的交接事项',
    kind: 'text',
    fill: 'manual',
  },
] as const satisfies readonly FieldDef[];

/** 字段名联合类型（由 FIELDS 字面量派生） */
export type RecordFieldName = (typeof FIELDS)[number]['name'];

/** 字段名 → 定义（编译期已知键均有值） */
export const FIELD_BY_NAME: Readonly<Record<RecordFieldName, FieldDef>> = Object.fromEntries(
  FIELDS.map((f) => [f.name, f]),
) as Readonly<Record<RecordFieldName, FieldDef>>;

/** 全部字段名（运行期遍历/校验用） */
export const FIELD_NAMES: readonly RecordFieldName[] = FIELDS.map((f) => f.name);
