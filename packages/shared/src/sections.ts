/**
 * 十板块定义 —— 三端同源（TK-03）。
 *
 * 出处：PRD v0.2.8 附录 A 数据字典（十板块逐字段）；板块编号即 missing_fields[].section，
 * 与《API 契约》§2 示例一致（hp_status → section 2「电」）。
 * 0 号为「基础信息」（附录 A 表首，日期/交接时间/交班人/接班人，多为自动带出）。
 */

/** 板块编号：0=基础信息，1~10=十个业务板块 */
export const SectionNo = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type SectionNo = (typeof SectionNo)[number];

/** 板块 key（英文标识，用于 i18n / 锚点前缀 / 前端路由） */
export const SectionKey = [
  'base',
  'water',
  'electricity',
  'gas',
  'medical_gas',
  'heating_cooling',
  'water_pump',
  'hvac',
  'energy',
  'elevator',
  'other',
] as const;
export type SectionKey = (typeof SectionKey)[number];

export interface SectionDef {
  /** 板块序号（missing_fields[].section） */
  readonly no: SectionNo;
  /** 英文标识 */
  readonly key: SectionKey;
  /** 中文名（附录 A 板块标题） */
  readonly label: string;
}

/** 板块清单（顺序即附录 A 顺序；编号只增不复用） */
export const SECTIONS: readonly SectionDef[] = [
  { no: 0, key: 'base', label: '基础信息' },
  { no: 1, key: 'water', label: '水' },
  { no: 2, key: 'electricity', label: '电' },
  { no: 3, key: 'gas', label: '天然气' },
  { no: 4, key: 'medical_gas', label: '医用气体' },
  { no: 5, key: 'heating_cooling', label: '供暖/冷系统' },
  { no: 6, key: 'water_pump', label: '生活水泵' },
  { no: 7, key: 'hvac', label: '新风/空调系统' },
  { no: 8, key: 'energy', label: '节能减排' },
  { no: 9, key: 'elevator', label: '电梯' },
  { no: 10, key: 'other', label: '其它' },
] as const;

/** 板块号 → 定义（运行时查表用） */
export const SECTION_BY_NO: Readonly<Record<SectionNo, SectionDef>> = Object.fromEntries(
  SECTIONS.map((s) => [s.no, s]),
) as Readonly<Record<SectionNo, SectionDef>>;

/** 业务板块号（1~10，不含基础信息），供遍历表单板块用 */
export const BUSINESS_SECTION_NOS: readonly Exclude<SectionNo, 0>[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
];

/**
 * 电梯板块号：核对明细落 elevator_checks 逐台一行（records 无对应列），
 * 点名时 `missing_fields[].section` 取此值（ELE-04、ELE-07）。
 */
export const ELEVATOR_SECTION_NO = 9 satisfies SectionNo;
