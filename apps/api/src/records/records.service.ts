import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, lt } from 'drizzle-orm';
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import { alias, getTableConfig } from 'drizzle-orm/mysql-core';
import {
  ALERT_LEVEL_RANK,
  FIELDS,
  FIELD_BY_NAME,
  FIELD_LENGTHS,
  FIELD_NAMES,
  SECTION_BY_NO,
  TASK_CARDS,
  USAGE_FIELDS,
  handoverItemsOf,
  ELEVATOR_ALERT_LEVEL,
  HANDOVER_ALERT_LEVEL,
  STATUS_ALERT_LEVEL,
  buildValidationError,
  clockMinutesOf,
  DECREASED_GUARD_FIELDS,
  decreasedReadingsOf,
  eDayUseOf,
  elevatorActualLabel,
  elevatorExpectedLabel,
  GAS_CARD_FIELDS,
  gasDayUseOf,
  isFilledValue,
  isMismatchOf,
  isRequiredField,
  expectedStatusAt,
  loDayUseOf,
  localMeasuredAt,
  localTimestampToDate,
  numericMaxOf,
  parseNumeric,
  refillCardsOf,
  roundToScaleOf,
  RecordStatus,
  toMissingField,
  unconfirmedNeedConfirmItems,
  needConfirmItemsExcludingHits,
  decreaseHitKey,
  validateElevatorChecks,
  validatePrevBackfillReadings,
  validateFields,
  waterDayUseOf,
  isValidLocalTimestamp,
  type AlertDto,
  type AcknowledgePayloadDto,
  type AcknowledgeResultDto,
  type AnnotationPayloadDto,
  type AnnotationResultDto,
  type BackfillPayloadDto,
  type ConfirmPayloadDto,
  type ConfirmResultDto,
  type BadgeDto,
  type CardDef,
  type ElevatorCheckRecordDto,
  type CardDto,
  type CardFieldStateDto,
  type ConfirmationPayload,
  type ElevatorPlanLike,
  type FieldValueGetter,
  type MissingField,
  type PrevBackfillField,
  type DecreasedGuardField,
  type PendingListDto,
  type PrevDto,
  type PrevRecordDto,
  type PreviewDto,
  type RecordDetailDto,
  type RecordFieldName,
  type RecordListItemDto,
  type RecordListDto,
  type RecalcResultDto,
  type SectionNo,
  type SectionStateDto,
  type SubmitPayloadDto,
  type SubmitResultDto,
  type TodayDto,
  type MissingTarget,
  type ObjectionListDto,
  type ObjectionPayloadDto,
  type ObjectionResultDto,
  type RecordUpdatePayloadDto,
  type RecordUpdateResultDto,
  type RecordVersionSummaryDto,
  type ResubmitPayloadDto,
  type ResubmitResultDto,
  type UsageFieldName,
  type UsageOverridePayload,
  type WithdrawNotAllowedReason,
  type WithdrawResultDto,
} from '@handover/shared';
import type { SessionUser } from '../auth/auth.service';
import { ApiException } from '../common/api-error';
import { DB, type Db } from '../db/db.module';
import {
  alerts,
  auditLogs,
  configs,
  elevatorChecks,
  elevators,
  recordVersions,
  records,
  schedules,
  spots,
  users,
} from '../db/schema';
import {
  DEFAULT_BACKFILL_WINDOW_DAYS,
  DEFAULT_SHIFT_START,
  isValidCalendarDate,
  minusDays,
  minusOneDay,
  plusOneDay,
  shiftDutyDate,
} from './duty-date';

/** 事务执行器：submitCore 的审计/重算助手在同事务内消费（Drizzle tx 与 Db 同 select/update/insert API） */
type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * 'YYYY-MM-DD' → 日历有效性（拦 02-30、13 月等）。校验本体已上移 duty-date `isValidCalendarDate`
 * （TK-24 起后台筛选参数共用同一实现，单一权威防漂移）；此处保留「非法返回空串」的消费形态。
 */
function calendarDateOf(s: string): string {
  return isValidCalendarDate(s) ? s : '';
}

// ── 历史记录筛选（GET /records 与 GET /admin/records/export 共用，TK-24；F5-01、F6-01）─────────

/** GET /records 筛选参数（契约 §3.5：`from/to/submitter_id/status`，全部可选取交集） */
export interface RecordListFilters {
  from: string | null;
  to: string | null;
  submitterId: number | null;
  status: RecordStatus | null;
}

/** 筛选参数点名项（查询参数非表单字段，锚点指向后台筛选栏） */
const FILTER_BAD = (field: string, label: string): MissingField => ({
  field: field as MissingTarget,
  section: 0,
  label,
  anchor: '#records-filters',
});

/**
 * 解析并校验 GET /records 与 GET /admin/records/export 的查询参数（单一实现，防两处口径漂移）。
 * 全部可选：缺省/空串 = 不筛；非法取值（非日历日、非正整数、状态越值）→ 400 逐条点名——
 * 静默忽略会让「筛选无结果」与「参数写错」不可分辨（C-09 可解释原则）。
 */
export function parseRecordListFilters(
  query: Readonly<Record<string, string | undefined>>,
): RecordListFilters {
  const text = (k: string): string | null => {
    const v = query[k]?.trim();
    return v ? v : null;
  };
  const from = text('from');
  if (from !== null && !isValidCalendarDate(from)) {
    throw new ApiException(
      'VALIDATION_OUT_OF_RANGE',
      '筛选参数 from 不是合法日历日（YYYY-MM-DD）',
      {
        missingFields: [FILTER_BAD('from', '筛选起始日期')],
      },
    );
  }
  const to = text('to');
  if (to !== null && !isValidCalendarDate(to)) {
    throw new ApiException('VALIDATION_OUT_OF_RANGE', '筛选参数 to 不是合法日历日（YYYY-MM-DD）', {
      missingFields: [FILTER_BAD('to', '筛选截止日期')],
    });
  }
  const submitterRaw = text('submitter_id');
  let submitterId: number | null = null;
  if (submitterRaw !== null) {
    const n = Number(submitterRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '筛选参数 submitter_id 须为正整数', {
        missingFields: [FILTER_BAD('submitter_id', '交班人')],
      });
    }
    submitterId = n;
  }
  const status = text('status');
  if (status !== null && !(RecordStatus as readonly string[]).includes(status)) {
    throw new ApiException(
      'VALIDATION_OUT_OF_RANGE',
      `筛选参数 status 取值越界（${status}），可选：${RecordStatus.join(' / ')}`,
      { missingFields: [FILTER_BAD('status', '记录状态')] },
    );
  }
  return { from, to, submitterId, status: (status ?? null) as RecordStatus | null };
}

/**
 * 撤回窗口回落值（TK-21，F2-08）：configs `withdraw_window_minutes` 非法/缺失时回落。
 * 与种子值同源（《开发种子数据》§五 `withdraw_window_minutes=10`，D-P05 拍板 10 分钟）；
 * 值本身 ❓ 待科长确认（台账待确认清单），运营口径后台可配（F4-11）。
 */
const DEFAULT_WITHDRAW_WINDOW_MINUTES = 10;

// 本地时间戳解析（submitted_at → Date，撤回窗口判定用）已上移 shared `calc.ts localTimestampToDate`
// （api 与 h5 倒计时同一解析，三端同源纪律，勿各写一份）。

/** 状态类字段取此值即为"异常"（PRD §6.2：Phase 1 无独立预警，"预警项"指表单级标红项；与 cards.ts STATUS_BAD 同口径） */
const ABNORMAL_STATUS = 'bad';

/**
 * 枚举/状态列合法值白名单（与 schema.ts mysqlEnum 逐项同源抄录，enums.ts 为类型来源）。
 * 提交侧不校验候选成员性的仅是**配置驱动清单**（hvac_locs/boiler_list，契约 §3.7）；
 * schema 枚举列的越值会直接在 MySQL 层报错（500），故在此拦为 400 点名（VALIDATION_OUT_OF_RANGE）。
 */
const ENUM_VALUES: Readonly<Partial<Record<RecordFieldName, readonly (string | number)[]>>> = {
  hp_status: ['ok', 'bad'],
  neg_status: ['ok', 'bad'],
  air_status: ['ok', 'bad'],
  boiler_status: ['ok', 'bad'],
  coolroom_status: ['ok', 'bad'],
  hvac_status: ['ok', 'bad'],
  boiler_run: ['run', 'stop'],
  cool_run: ['run', 'stop'],
  p1_level: ['ok', 'high', 'low'],
  p3_level: ['ok', 'high', 'low'],
  tank_in_use: [1, 2],
};

/** INT 列（瓶库五项，schema tinyint/int）：落库前转 number，decimal 列以字符串保精度 */
const INT_COLUMNS: ReadonlySet<RecordFieldName> = new Set<RecordFieldName>([
  'b40',
  'b10',
  'b6',
  'b_co2',
  'b_pulm',
]);

/** 本地时间戳字面量格式与合法性校验已上移 shared `calc.ts isValidLocalTimestamp`（TK-17：
 * 电梯核对时刻 D-T22 与测量时刻 DATA-13 同形态同校验；分域正则 + 日历有效性，TK-12 评审 M3） */

/**
 * record_no 生成（TK-12 评审修复轮 L5 抽为纯函数供黄金值哨兵）：格式钉死自技术方案 §4.2
 * DDL 注释原文示例 'HB-20260827-001'；duty_date 唯一（F1-01）→ 每班次恒 -001。
 */
export function recordNoOf(dutyDate: string): string {
  return `HB-${dutyDate.replaceAll('-', '')}-001`;
}

// ── 签名图解码与落盘（TK-19，F2-05「签名图可查」）────────────────────────────────

/** 签名图大小护栏（data URL 解码后 ≤ 512KB；canvas 签名远小于此，防恶意超大 base64） */
const SIGNATURE_MAX_BYTES = 512 * 1024;

/** PNG 文件魔数（\x89PNG\r\n\x1a\n）：只认魔数不看扩展名，防改名上传任意内容 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 签名图 data URL → PNG 字节流（不合法返回 null）：仅接受
 * `data:image/png;base64,` 前缀（h5 签名板 canvas toDataURL('image/png') 产物）。
 */
function decodeSignature(dataUrl: string): Buffer | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl.trim());
  if (!m) return null;
  const buf = Buffer.from(m[1]!, 'base64');
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return null;
  }
  return buf;
}

/**
 * 签名图落盘（库内记可服务路径，与《开发种子数据》§六 completed 单的
 * `/uploads/signatures/*.png` 形态一致；生产由 Nginx 静态服 `/uploads`）。
 * 目录由环境变量 `UPLOAD_DIR` 指定（测试注入临时目录），默认 `<cwd>/data/uploads`。
 * 返回入库的 signature_path。
 */
async function writeSignatureFile(recordNo: string, png: Buffer): Promise<string> {
  const dir = nodePath.join(
    process.env.UPLOAD_DIR ?? nodePath.join(process.cwd(), 'data', 'uploads'),
    'signatures',
  );
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(nodePath.join(dir, `${recordNo}.png`), png);
  return `/uploads/signatures/${recordNo}.png`;
}

/**
 * 用量列（契约 §4 第 3 步：服务端计算固化、客户端传值不信任）。normalizeSections 先置 NULL
 * （sections里的 *_use 键恒不采信），提交时由 computeUsageValues 以计算值覆盖（TK-13），
 * 手工覆盖再经 resolveUsageOverrides 改写（F3-04/F3-06）。
 */
const SERVER_CALCULATED_KEYS = ['waterUse', 'eUse', 'gasUse', 'loDayUse'] as const;

/** 运行期非法覆盖键的点名项（dto 类型已编译期收窄，此处仅防恶意 payload 越键） */
const USAGE_OVERRIDE_BAD_FIELD = (raw: string): MissingField => ({
  // MissingTarget 收窄（记录列名 | elevator:{id}）；恶意 payload 的越键串仅作回显定位用
  field: raw as MissingTarget,
  section: 4,
  label: '不支持的用量覆盖字段',
  anchor: '#sec-4-usage-override',
});

/** 非数组清单的合成定位项（评审修复轮 M2）：field 不在 §2 取值域内，域外回显同上先例 */
const CONFIRMATION_BAD_PAYLOAD = (): MissingField => ({
  field: 'confirmations' as MissingTarget,
  section: 0,
  label: '防呆确认项格式非法（须为数组）',
  anchor: '#sec-0-confirmations',
});

/** 知晓确认行请求体的合成定位项（TK-19，域外回显同 confirmations 先例） */
const ALERT_IDS_BAD_PAYLOAD = (): MissingField => ({
  field: 'alert_ids' as MissingTarget,
  section: 0,
  label: '知晓确认行格式非法（须为 id 数组）',
  anchor: '#sec-0-alert-ids',
});

/** 签名图缺失/非法的合成定位项（TK-19，F2-05；同为域外回显先例） */
const SIGNATURE_MISSING = (): MissingField => ({
  field: 'signature' as MissingTarget,
  section: 0,
  label: '接班人签名',
  anchor: '#sec-0-signature',
});
const SIGNATURE_BAD_PAYLOAD = (): MissingField => ({
  field: 'signature' as MissingTarget,
  section: 0,
  label: '签名图格式非法（须为 PNG 图片）',
  anchor: '#sec-0-signature',
});

/** 异议原因缺失/超长的合成定位项（TK-20，F2-06；域外回显同 signature 先例——
 * objection_note 是记录级列、非附录 A 表单字段，不在 MissingTarget 取值域） */
const OBJECTION_NOTE_MISSING = (): MissingField => ({
  field: 'objection_note' as MissingTarget,
  section: 0,
  label: '异议原因',
  anchor: '#sec-0-objection-note',
});

const CHIEF_NOTE_MISSING = (): MissingField => ({
  field: 'chief_note' as MissingTarget,
  section: 0,
  label: '批注内容',
  anchor: '#sec-0-chief-note',
});

const USAGE_OVERRIDE_BAD_PAYLOAD = (): MissingField => ({
  field: 'usage_overrides' as MissingTarget,
  section: 4,
  label: '用量覆盖项格式非法（须为数组）',
  anchor: '#sec-4-usage-overrides',
});

/** 类型守卫：payload 的 field 是宽字典类型，命中判定必须收窄到回退三字段 */
const isDecreasedField = (v: unknown): v is DecreasedGuardField =>
  DECREASED_GUARD_FIELDS.includes(v as DecreasedGuardField);

/** records 表的 DB 列名集合（用于识别字典里的派生字段，如 lo_night_use 非存储列） */
const RECORD_DB_COLUMNS: ReadonlySet<string> = new Set(
  getTableConfig(records).columns.map((c) => c.name),
);

/** records 表对象的 TS 属性名集合（camelCase） */
const RECORD_TS_KEYS: ReadonlySet<string> = new Set(Object.keys(records));

/**
 * TS 属性名（camelCase）→ 字段字典名（snake_case，仅 records 存储列）：PUT 变更清单与
 * 快照 diff 的键空间归一（record_versions.changed/snapshot 以字典名存储，人读友好且与
 * FIELDS 字典对齐；normalizeSections 产出的 TS 键经此映射回字典名）。
 */
const TS_KEY_TO_FIELD: ReadonlyMap<string, RecordFieldName> = new Map(
  FIELDS.filter((f) => RECORD_TS_KEYS.has(toTsKey(f.name))).map((f) => [toTsKey(f.name), f.name]),
);

/** DB 列名（snake_case）→ Drizzle TS 属性名（camelCase） */
function toTsKey(columnName: string): string {
  return columnName.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * 更新路径的快照兑底（TK-12 评审修复轮 M5）：字典内 section ≥1 的全部 records 存储列 → null。
 * 撤回重提（draft 行）走 update 时未上送的列一律清空——提交 payload 是「十板块全部字段」的
 * 全量快照语义（契约 §4），未上送即未填；否则本机清空的字段会以服务端旧值残留（实证：
 * draft 行 energy_note 重提不送上送仍残留）。这正是台账增补 #16 只给停机三项单点打补丁的
 * 同源缺口的一般化；h5 侧另有「草稿 ?? 服务端值」合并视图配合（清空字段显式上送 null）。
 */
const SNAPSHOT_NULL_DEFAULTS: Readonly<Record<string, null>> = Object.fromEntries(
  FIELDS.filter((f) => f.section >= 1)
    .map((f) => toTsKey(f.name))
    .filter((key) => RECORD_TS_KEYS.has(key))
    .map((key) => [key, null]),
);

/**
 * 取字段在 records 行上的 TS 属性名。
 * 返回 null 表示**该字段不是 records 存储列**（如 `lo_night_use` 为跨记录派生值，见 fields.ts 头部）；
 * 若列确实存在却映射不到 TS 键，说明字典与 schema 漂移，记错误日志暴露而非静默当作"未填"。
 */
function recordKeyOf(fieldName: string, logger: Logger): string | null {
  const key = toTsKey(fieldName);
  if (RECORD_TS_KEYS.has(key)) return key;
  if (RECORD_DB_COLUMNS.has(fieldName)) {
    logger.error(`字段字典与 records schema 漂移：列 ${fieldName} 映射不到 TS 键 ${key}`);
  }
  return null;
}

/** 是否异常项：状态类字段（kind='status'）值为 bad（附录 A「异常时必填备注，触发预警」） */
function isAbnormal(name: RecordFieldName, value: unknown): boolean {
  return FIELD_BY_NAME[name].kind === 'status' && value === ABNORMAL_STATUS;
}

/**
 * 用量值判等（TK-16 评审修复轮 M1）：**按数值而非字符串**比，null 与非 null 视为不同。
 * 写库侧固化的字符串来自 `String(roundToScaleOf(field, n))`（500 → '500'），而 DECIMAL(12,1)/
 * (8,2) 列读回为补零形态（'500.0'）——字符串相等会把数值完全相同的重算误判为变更。
 * 无法解析为十进制的库值（理论不应存在）按「不等」处理，交由改写纠正而非静默保留。
 */
function sameUsageValue(a: unknown, b: unknown): boolean {
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : parseNumeric(String(v));
  // 直接 === 即可：number 与 null 比为 false（null 与非 null 视为不同）、null===null 为 true、
  // 数值比数值（评审二轮 m1：原三元两分支一字不差，纯误导）
  return num(a) === num(b);
}

/**
 * 字段值判等（TK-20 快照 diff 用，与 recalc 的 sameUsageValue 同一数值判等纪律，M1 教训）：
 * 两值均可解析为数值时按数值比（客户端 '50' 与 DECIMAL 列读回 '50.0' 同值，字符串比对会把
 * 数值相同的修改误判为变更）；数组（hvac_locs）JSON 序列化比对；其余按字符串；
 * null 与非 null 恒不等。注意与 sameUsageValue 的差异：非数值字符串各自比对（不判等），
 * 'ok' 与 'bad' 不会被误判相同。
 */
function sameFieldValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  const pa = parseNumeric(String(a));
  const pb = parseNumeric(String(b));
  if (pa !== null && pb !== null) return pa === pb;
  return String(a) === String(b);
}

/**
 * 快照 diff（TK-20，F2-07-T1「变更字段、旧值」）：基线（字段名字典空间）vs 修改后，
 * 产出 record_versions.changed 形态（字段名 → { old, new }）。
 */
function diffSnapshotValues(
  baseline: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): Record<string, { old: unknown; new: unknown }> {
  const changed: Record<string, { old: unknown; new: unknown }> = {};
  for (const [name, nextV] of Object.entries(next)) {
    const oldV = baseline[name] ?? null;
    if (!sameFieldValue(oldV, nextV)) changed[name] = { old: oldV, new: nextV };
  }
  return changed;
}

/**
 * MySQL 唯一键冲突归一（TK-16 挂账闭环，契约订正 18 ⑧）：existing 预检与 INSERT 之间的
 * 并发窗口撞 duty_date/record_no UNIQUE 时 mysql2 抛 ER_DUP_ENTRY（errno 1062），
 * 按 RECORD_EXISTS 409 语义归一而非 500（与 recalc 下游行锁同批补齐）。
 */
function isDuplicateEntryError(e: unknown): boolean {
  const err = e as { code?: string; errno?: number } | null;
  return err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
}

// 班次日期纯函数（localParts/minusOneDay/parseClock/shiftDutyDate）已抽取至 ./duty-date：
// seed.ts 与 service 必须共用同一份 C-08 分界逻辑，否则凌晨窗口种子 D0 与接口 duty_date 错位。

// 响应形状（《API 契约》§3.2 GET /records/today）的类型定义已上移至 `@handover/shared` 的 dto 模块：
// api 端产出、h5 端消费同一份契约类型，杜绝前后端各写一份 interface 而随迭代漂移。
// 引入的类型：TodayDto / CardDto / CardFieldStateDto / BadgeDto / SectionStateDto。

/**
 * 今日交接首页服务（TK-05）：契约 §3.2 GET /records/today。
 *
 * 规格落点：F1-01（一天一条记录，按 C-08 班次口径取当日）、F1-02（12 张任务卡按点位/时段组织）、
 * F1-03（角标与顶部进度条实时汇总已填/待填/异常）。
 *
 * **本服务对数据库只读**：当日无记录时返回 `record: null` 与 12 张全待填的卡片，**不创建 draft 行**。
 * 理由三条——① `records.record_no` 为 NOT NULL UNIQUE，而契约 §4 第 5 步与 TK-12 均定"提交时生成
 * record_no"，GET 建行就得先造占位号；② 技术方案 §11 遗留项「服务端 draft 行的产生时机」尚未关闭，
 * 不宜由只读接口擅自定案；③ 种子数据 D0 刻意留空（《开发种子数据》§六「无记录，测试填写全流程」），
 * GET 建行会污染 records=10 的计数口径。draft 行的产生时机已随 TK-08 闭环（决策记录 D-T18）：
 * 服务端不设在线草稿端点（草稿在客户端 IndexedDB），records 行提交时一次性创建，
 * draft 状态仅由撤回（F2-08，TK-21）产生。
 */
@Injectable()
export class RecordsService {
  private readonly logger = new Logger(RecordsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** 班次分界时刻（configs `shift_start_time`，❓ 待科长确认；F4-11 精神——运营口径后台可配） */
  async shiftStartTime(): Promise<string> {
    const rows = await this.db
      .select({ value: configs.configValue })
      .from(configs)
      .where(eq(configs.configKey, 'shift_start_time'))
      .limit(1);
    const raw = rows[0]?.value ?? '';
    return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(raw.trim()) ? raw.trim() : DEFAULT_SHIFT_START;
  }

  /**
   * 解析班次起始日（C-08「记录日期=班次起始日，非提交日」）。
   *
   * 24 小时班跨两个自然日：当地时刻**早于** `shift_start_time` 时仍在前一班次内
   * （如 09-03 02:00 在地下表房抄表，属 09-02 那一班），故 duty_date 取昨日。
   * 台账 C-08 的验收方式即「跨天用例（23:59 当班、次日提交）」。
   * 分界纯函数见 ./duty-date（与 seed.ts 同源）。
   */
  async resolveDutyDate(now: Date = new Date()): Promise<{ dutyDate: string; shiftStart: string }> {
    const shiftStart = await this.shiftStartTime();
    return { dutyDate: shiftDutyDate(now, shiftStart), shiftStart };
  }

  /**
   * 补交窗口天数（TK-16 评审修复轮 L3，D-T21 修订）：configs `backfill_window_days`，
   * 非法/缺失回落 DEFAULT_BACKFILL_WINDOW_DAYS（7）——取值方式与 shiftStartTime 同构
   * （运营口径后台可配，F4-11；❓ 待科长确认）。限幅 1–365 防配置错字把窗口关零。
   */
  async backfillWindowDays(): Promise<number> {
    const rows = await this.db
      .select({ value: configs.configValue })
      .from(configs)
      .where(eq(configs.configKey, 'backfill_window_days'))
      .limit(1);
    const n = Number((rows[0]?.value ?? '').trim());
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_BACKFILL_WINDOW_DAYS;
  }

  /**
   * 撤回窗口分钟数（TK-21，F2-08/F2-09）：configs `withdraw_window_minutes`，非法/缺失
   * 回落 DEFAULT_WITHDRAW_WINDOW_MINUTES（10，与种子同源）——取值方式与 backfillWindowDays
   * 同构（运营口径后台可配，F4-11；❓ 待科长确认）。限幅 1–1440（≤1 天）防配置错字
   * 把窗口关零或开到无限。**today() 回传与 withdraw() 校验共用本方法**，两端同源不漂移。
   */
  async withdrawWindowMinutes(): Promise<number> {
    const rows = await this.db
      .select({ value: configs.configValue })
      .from(configs)
      .where(eq(configs.configKey, 'withdraw_window_minutes'))
      .limit(1);
    const n = Number((rows[0]?.value ?? '').trim());
    return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : DEFAULT_WITHDRAW_WINDOW_MINUTES;
  }

  /** GET /records/today 的完整响应 */
  async today(user: SessionUser, now: Date = new Date()): Promise<TodayDto> {
    const { dutyDate, shiftStart } = await this.resolveDutyDate(now);

    // 三路并发取数：当日记录、点位字典（卡片由它驱动）、次日排班（接班人带出，F2-01/DATA-10）
    const [recordRows, spotRows, scheduled, withdrawWindow] = await Promise.all([
      this.db
        .select({
          id: records.id,
          recordNo: records.recordNo,
          status: records.status,
          version: records.version,
          submittedAt: records.submittedAt,
          row: records,
        })
        .from(records)
        .where(eq(records.dutyDate, dutyDate))
        .limit(1),
      this.db
        .select({ id: spots.id, name: spots.name, sortNo: spots.sortNo })
        .from(spots)
        .where(eq(spots.status, 'active'))
        .orderBy(asc(spots.sortNo)),
      this.scheduledReceiverOf(dutyDate),
      this.withdrawWindowMinutes(),
    ]);

    const recordRow = recordRows[0]?.row;
    // 人工覆盖标识（TK-13，F3-06-T1「标识与人工值可区分」）：audit 留痕反查，不另设存储列
    const manualFields = recordRow
      ? await this.usageOverrideFieldsOf(recordRow.recordNo, recordRow.version, this.db)
      : new Set<string>();
    const cards = this.buildCards(spotRows, recordRow, manualFields);
    const progress = sumBadges(cards.map((c) => c.badge));
    const sections = aggregateSections(cards);

    return {
      duty_date: dutyDate,
      shift_start_time: shiftStart,
      withdraw_window_minutes: withdrawWindow,
      // F1-01：一天一条记录——duty_date UNIQUE 约束保证至多一行，接口按班次日期查故无重复入口
      record: recordRows[0]
        ? {
            id: recordRows[0].id,
            record_no: recordRows[0].recordNo,
            status: recordRows[0].status,
            version: recordRows[0].version,
            submitted_at: recordRows[0].submittedAt,
          }
        : null,
      pending_sync: false,
      submitter: { id: user.id, real_name: user.realName },
      receiver: scheduled ? { id: scheduled.id, real_name: scheduled.realName } : null,
      progress,
      sections,
      cards,
    };
  }

  /** GET /records/today/prev 的完整响应 */
  async prev(now: Date = new Date()): Promise<PrevDto> {
    const { dutyDate } = await this.resolveDutyDate(now);

    // 「上一班」= 相邻班次已提交记录（D-T17，取数实现见 adjacentPrevRow）；首班（F1-15）
    // = 今日之前无任何记录；相邻班次无行（漏交，F6-06 检测的场景）或该行为 draft →
    // 上一班缺失（F3-07，前端显“—”并允许补录）——**不回落更早记录**（以旧值冒充上一班
    // 违反 F1-05-T2 判据「不显示脏数据」，且用量计算复用同一取数会把跨天用量当 1 天固化）。
    const [adjacent, anyEarlier] = await Promise.all([
      this.adjacentPrevRow(dutyDate),
      this.db
        .select({ id: records.id })
        .from(records)
        .where(lt(records.dutyDate, dutyDate))
        .limit(1),
    ]);

    if (anyEarlier.length === 0) {
      // F1-15 首班：今日之前无任何记录（首次启用，《开发种子数据》D-10 场景）
      return { duty_date: dutyDate, first_day: true, prev: null };
    }
    // F1-05-T2 / F3-07：相邻班次无已提交记录（漏交或未提交）→ 缺失态（非首班）：
    // 草稿值不作为带出数据源，也不跳过缺失班次回落更早记录
    return {
      duty_date: dutyDate,
      first_day: false,
      prev: adjacent ? this.toPrevRecord(adjacent) : null,
    };
  }

  /**
   * 相邻班次的已提交记录（**D-T17「前一条」口径的单一实现**）：duty_date 恰为今日班次日期 − 1 天
   * （日历事实，复用 duty-date.ts 的 minusOneDay，勿另写日历推算）+ 非 draft 资格（draft 仅由
   * 撤回产生，D-T18）。返回 null = 上一班缺失（F3-07），不回落更早记录。
   * 消费方：GET /records/today/prev 带出（TK-07）与提交时用量计算（TK-13）——两者**必须共用
   * 同一取数**，否则带出显示与用量固化各取各的「上一班」，出现「显示 A 班值、算的是 B 班差」。
   */
  private async adjacentPrevRow(dutyDate: string): Promise<typeof records.$inferSelect | null> {
    const rows = await this.db
      .select({ row: records })
      .from(records)
      .where(eq(records.dutyDate, minusOneDay(dutyDate)))
      .limit(1);
    const row = rows[0]?.row;
    return row && row.status !== 'draft' ? row : null;
  }

  /**
   * records 行 → 上一班带出体（dto.ts PrevRecordDto）：readings 取数范围与说明见
   * readingsOf（TK-18 抽取，与交接单详情共用）。
   */
  private toPrevRecord(row: typeof records.$inferSelect): PrevRecordDto {
    return {
      duty_date: row.dutyDate,
      record_no: row.recordNo,
      status: row.status,
      submitted_at: row.submittedAt,
      version: row.version,
      readings: this.readingsOf(row),
    };
  }

  /**
   * records 行 → 全部读数映射（TK-18 抽取复用）：字段字典内板块 ≥1 的 records 存储列，
   * 蛇形列名 → 原值（decimal 为字符串）。消费方：上一班带出（toPrevRecord，TK-07）与
   * 交接单详情（detail，TK-18）——两处同一取数范围，不得各写一份。
   */
  private readingsOf(row: typeof records.$inferSelect): Record<string, unknown> {
    const readings: Record<string, unknown> = {};
    for (const def of FIELDS) {
      if (def.section === 0) continue; // 基础信息（duty_date/submitted_at 等）走记录级字段
      const key = recordKeyOf(def.name, this.logger);
      if (!key) continue;
      readings[def.name] = row[key as keyof typeof row] ?? null;
    }
    return readings;
  }

  // ── 交接确认（TK-18：契约 §3.4；F2-02 待确认入口、F2-03 逐项浏览）───────────────────

  /**
   * GET /records/pending（F2-02「接班人登录首页显示醒目『有 N 份交接单待确认』入口」）。
   *
   * 取数口径（契约 §3.4）：**我为 receiver 且 status=submitted**——draft（撤回未重提，
   * D-T18）与 objection/completed 均不产生待确认入口；`alert_count` 为该单标红确认行数
   * （alerts，三类来源：状态异常/电梯不一致/交接事项拆条），供列表角标与 N 的展示。
   * 按 duty_date 降序（最近的待确认单在前）。
   */
  async pending(user: SessionUser): Promise<PendingListDto> {
    const rows = await this.db
      .select({
        id: records.id,
        recordNo: records.recordNo,
        dutyDate: records.dutyDate,
        version: records.version,
        submittedAt: records.submittedAt,
        submitterId: users.id,
        submitterName: users.realName,
      })
      .from(records)
      .innerJoin(users, eq(records.submitterId, users.id))
      .where(and(eq(records.receiverId, user.id), eq(records.status, 'submitted')))
      .orderBy(desc(records.dutyDate));
    if (rows.length === 0) return { items: [] };

    // 标红行计数逐单聚合（一次 group by，不 N+1）；无 alerts 的单显示 0
    const countRows = await this.db
      .select({ recordId: alerts.recordId, n: count(alerts.id) })
      .from(alerts)
      .where(
        inArray(
          alerts.recordId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(alerts.recordId);
    const counts = new Map(countRows.map((c) => [c.recordId, Number(c.n)]));

    return {
      items: rows.map((r) => ({
        id: r.id,
        record_no: r.recordNo,
        duty_date: r.dutyDate,
        status: 'submitted' as const,
        version: r.version,
        submitted_at: r.submittedAt,
        submitter: { id: r.submitterId, real_name: r.submitterName },
        alert_count: counts.get(r.id) ?? 0,
      })),
    };
  }

  /**
   * GET /records（TK-24，契约 §3.5；F6-01 科长筛选半边 + F5-01 共用取数）。
   *
   * 筛选参数 `from/to/submitter_id/status` 全部可选取交集（解析与校验单一实现
   * parseRecordListFilters，与导出共用），`duty_date` 倒序；不分页（班次一天一条，
   * 量级日增 1 行，与 pending/notifications 同口径）。师傅看全部、科长同（登录用户）。
   */
  async list(filters: RecordListFilters): Promise<RecordListDto> {
    const rows = await this.listRows(filters);
    return {
      items: rows.map((r) => ({
        id: r.id,
        record_no: r.recordNo,
        duty_date: r.dutyDate,
        status: r.status,
        version: r.version,
        submitted_at: r.submittedAt,
        confirmed_at: r.confirmedAt,
        submitter: { id: r.submitterId, real_name: r.submitterName },
        receiver: r.receiverId === null ? null : { id: r.receiverId, real_name: r.receiverName! },
        alert_count: r.alertCount,
        chief_note: r.chiefNote,
      })),
    };
  }

  /**
   * 导出取数（GET /admin/records/export 的数据半边，TK-24）：与 list 同一筛选与排序，
   * 额外携带四项日用量原值（decimal 列字符串回读保精度）供 CSV 组装——
   * 列表 DTO 不携带用量列（保持视图轻量），导出经本方法单独取数。
   */
  async exportRows(filters: RecordListFilters): Promise<
    (RecordListItemDto & {
      water_use: string | null;
      e_use: string | null;
      gas_use: string | null;
      lo_day_use: string | null;
    })[]
  > {
    const submitterU = alias(users, 'submitter_user');
    const receiverU = alias(users, 'receiver_user');
    const rows = await this.db
      .select({
        row: records,
        submitterId: submitterU.id,
        submitterName: submitterU.realName,
        receiverName: receiverU.realName,
      })
      .from(records)
      .innerJoin(submitterU, eq(records.submitterId, submitterU.id))
      .leftJoin(receiverU, eq(records.receiverId, receiverU.id))
      .where(this.listWhere(filters))
      .orderBy(desc(records.dutyDate));
    if (rows.length === 0) return [];

    const countRows = await this.db
      .select({ recordId: alerts.recordId, n: count(alerts.id) })
      .from(alerts)
      .where(
        inArray(
          alerts.recordId,
          rows.map((r) => r.row.id),
        ),
      )
      .groupBy(alerts.recordId);
    const counts = new Map(countRows.map((c) => [c.recordId, Number(c.n)]));

    return rows.map(({ row, submitterId, submitterName, receiverName }) => ({
      id: row.id,
      record_no: row.recordNo,
      duty_date: row.dutyDate,
      status: row.status,
      version: row.version,
      submitted_at: row.submittedAt,
      confirmed_at: row.confirmedAt,
      submitter: { id: submitterId, real_name: submitterName },
      receiver:
        row.receiverId === null ? null : { id: row.receiverId, real_name: receiverName ?? '' },
      alert_count: counts.get(row.id) ?? 0,
      chief_note: row.chiefNote,
      water_use: row.waterUse,
      e_use: row.eUse,
      gas_use: row.gasUse,
      lo_day_use: row.loDayUse,
    }));
  }

  /** list/exportRows 共用的筛选条件（单一实现，防列表与导出口径漂移） */
  private listWhere(filters: RecordListFilters) {
    const conds = [];
    if (filters.from !== null) conds.push(gte(records.dutyDate, filters.from));
    if (filters.to !== null) conds.push(lte(records.dutyDate, filters.to));
    if (filters.submitterId !== null) conds.push(eq(records.submitterId, filters.submitterId));
    if (filters.status !== null) conds.push(eq(records.status, filters.status));
    return conds.length > 0 ? and(...conds) : undefined;
  }

  /** list 的取数本体（联双方姓名 + 标红行数聚合，一次 group by 不 N+1） */
  private async listRows(filters: RecordListFilters) {
    const submitterU = alias(users, 'submitter_user');
    const receiverU = alias(users, 'receiver_user');
    const rows = await this.db
      .select({
        id: records.id,
        recordNo: records.recordNo,
        dutyDate: records.dutyDate,
        status: records.status,
        version: records.version,
        submittedAt: records.submittedAt,
        confirmedAt: records.confirmedAt,
        chiefNote: records.chiefNote,
        submitterId: submitterU.id,
        submitterName: submitterU.realName,
        receiverId: records.receiverId,
        receiverName: receiverU.realName,
      })
      .from(records)
      .innerJoin(submitterU, eq(records.submitterId, submitterU.id))
      .leftJoin(receiverU, eq(records.receiverId, receiverU.id))
      .where(this.listWhere(filters))
      .orderBy(desc(records.dutyDate));
    if (rows.length === 0) return [];

    const countRows = await this.db
      .select({ recordId: alerts.recordId, n: count(alerts.id) })
      .from(alerts)
      .where(
        inArray(
          alerts.recordId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(alerts.recordId);
    const counts = new Map(countRows.map((c) => [c.recordId, Number(c.n)]));

    return rows.map((r) => ({ ...r, alertCount: counts.get(r.id) ?? 0 }));
  }

  /**
   * GET /records/{id}（F2-03 逐项浏览、F5-01 历史详情共用，契约 §3.4「含全部读数、
   * 标红项（alerts）、电梯核对、版本摘要、双方确认信息」）。
   *
   * 角色为登录用户（master/chief 均可，契约 §3.4 角色列「登录用户」）：接班人浏览待确认
   * 单、科长巡查历史单共用同一详情视图。alerts 返回**置顶序**（level high→mid→low、
   * 同级按 id 升序，shared ALERT_LEVEL_RANK 单一权威），前端顺序渲染即满足
   * F2-03-T1「标红项置顶高亮」；elevator_checks 联字典回显电梯名（按落库序）。
   */
  async detail(id: number): Promise<RecordDetailDto> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    }
    const submitterU = alias(users, 'submitter_user');
    const receiverU = alias(users, 'receiver_user');
    const rows = await this.db
      .select({
        row: records,
        submitterId: submitterU.id,
        submitterName: submitterU.realName,
        receiverName: receiverU.realName,
      })
      .from(records)
      .innerJoin(submitterU, eq(records.submitterId, submitterU.id))
      .leftJoin(receiverU, eq(records.receiverId, receiverU.id))
      .where(eq(records.id, id))
      .limit(1);
    const found = rows[0];
    if (!found) throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    const row = found.row;

    const [alertRows, checkRows, versionRows] = await Promise.all([
      this.db.select().from(alerts).where(eq(alerts.recordId, id)),
      this.db
        .select({
          elevatorId: elevatorChecks.elevatorId,
          elevatorName: elevators.name,
          checkTime: elevatorChecks.checkTime,
          expected: elevatorChecks.expected,
          actual: elevatorChecks.actual,
          explanation: elevatorChecks.explanation,
        })
        .from(elevatorChecks)
        .leftJoin(elevators, eq(elevatorChecks.elevatorId, elevators.id))
        .where(eq(elevatorChecks.recordId, id))
        .orderBy(asc(elevatorChecks.id)),
      // 历史版本摘要（TK-20，F2-07-T1「历史版本可查」）：editor 联 users 回显姓名；
      // 全字段快照不入响应（record_versions.snapshot 留库供审计/双轨比对深查）
      this.db
        .select({
          version: recordVersions.version,
          changed: recordVersions.changed,
          editedAt: recordVersions.editedAt,
          editorId: users.id,
          editorName: users.realName,
        })
        .from(recordVersions)
        .leftJoin(users, eq(recordVersions.editorId, users.id))
        .where(eq(recordVersions.recordId, id))
        .orderBy(desc(recordVersions.version)),
    ]);
    // 置顶序（F2-03）：shared ALERT_LEVEL_RANK 同一权重表，前端不再各排一套
    const sortedAlerts: AlertDto[] = [...alertRows]
      .sort((a, b) => ALERT_LEVEL_RANK[a.level] - ALERT_LEVEL_RANK[b.level] || a.id - b.id)
      .map((a) => ({
        id: a.id,
        rule_key: a.ruleKey,
        target: a.target,
        level: a.level,
        message: a.message,
        acknowledged_by: a.acknowledgedBy,
        acknowledged_at: a.acknowledgedAt,
      }));

    const checks: ElevatorCheckRecordDto[] = checkRows.map((c) => ({
      elevator_id: c.elevatorId,
      elevator_name: c.elevatorName,
      check_time: c.checkTime,
      expected: c.expected,
      actual: c.actual,
      explanation: c.explanation,
    }));

    const versions: RecordVersionSummaryDto[] = versionRows.map((v) => ({
      version: v.version,
      editor:
        v.editorId != null
          ? { id: v.editorId, real_name: v.editorName ?? String(v.editorId) }
          : null,
      edited_at: v.editedAt,
      changed: (v.changed ?? {}) as Record<string, { old: unknown; new: unknown }>,
    }));

    return {
      id: row.id,
      record_no: row.recordNo,
      duty_date: row.dutyDate,
      status: row.status,
      version: row.version,
      submitted_at: row.submittedAt,
      submitter: { id: found.submitterId, real_name: found.submitterName },
      receiver:
        row.receiverId != null
          ? { id: row.receiverId, real_name: found.receiverName ?? String(row.receiverId) }
          : null,
      receiver_change_reason: row.receiverChangeReason,
      readings: this.readingsOf(row),
      alerts: sortedAlerts,
      elevator_checks: checks,
      confirmed_at: row.confirmedAt,
      signature_path: row.signaturePath,
      chief_note: row.chiefNote,
      versions,
    };
  }

  // ── 逐条知晓与签名归档（TK-19：契约 §3.4；F2-04、F2-05、DATA-08、DEP-08）─────────

  /**
   * 待确认单闸门（acknowledge/confirm 共用的存在性/归属/状态校验，单一实现防两套口径）：
   * - 404 NOT_FOUND：单不存在（含非数字 id，与 detail 同一口径）；
   * - 403 FORBIDDEN：登录人非该单接班人——逐条知晓与签名是责任界定的锚点（D-P06），
   *   实名制 C-05 下只有接班人本人可确认；chief 被角色守卫挡在外（契约 §3.4 角色列 master）；
   * - 409 CONFIRM_INCOMPLETE：非 submitted（draft/objection/completed 均无确认语义）——
   *   契约错误码表 13 项之外不增设新码，按状态归入同一 409 族，文案区分语义。
   */
  private async confirmableRecordOf(
    id: number,
    user: SessionUser,
  ): Promise<typeof records.$inferSelect> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    }
    const rows = await this.db.select().from(records).where(eq(records.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    if (row.receiverId !== user.id) {
      throw new ApiException('FORBIDDEN', '仅接班人本人可逐条知晓与签名确认');
    }
    if (row.status !== 'submitted') {
      throw new ApiException('CONFIRM_INCOMPLETE', '交接单当前状态不允许确认操作');
    }
    return row;
  }

  /**
   * POST /records/{id}/acknowledge（F2-04/DATA-08/DEP-08 逐条"已知晓"）。
   *
   * 消费口径：非数组请求体 → 400 合成定位项点名（同 confirmations 先例）；跨单/不存在
   * 的 id 在 where 条件下不命中即忽略（容错同提交侧确认消费）；已知晓的行不重复写
   * （首次知晓时刻即留痕，不覆盖——acked_by/at 由 DB 层 isNull 条件保证幂等）。
   * 留痕落 alerts 行本身（acknowledged_by/at 逐条落库），不另写审计
   * （契约 §5 审计表无 acknowledge 行，行级归属即审计）。
   */
  async acknowledge(
    user: SessionUser,
    id: number,
    payload: AcknowledgePayloadDto,
  ): Promise<AcknowledgeResultDto> {
    const row = await this.confirmableRecordOf(id, user);
    const raw = payload?.alert_ids;
    if (raw != null && !Array.isArray(raw)) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '知晓确认行格式非法', {
        missingFields: [ALERT_IDS_BAD_PAYLOAD()],
      });
    }
    const ids = [...new Set((raw ?? []).filter((v): v is number => Number.isInteger(v) && v > 0))];
    if (ids.length === 0) return { acknowledged: 0 };
    const result = await this.db
      .update(alerts)
      .set({ acknowledgedBy: user.id, acknowledgedAt: localMeasuredAt() })
      .where(
        and(
          eq(alerts.recordId, row.id),
          inArray(alerts.id, ids),
          // 幂等：只写未知晓行，首次知晓时刻不被后续重复点击覆盖
          isNull(alerts.acknowledgedBy),
        ),
      );
    return { acknowledged: result[0].affectedRows ?? 0 };
  }

  /**
   * POST /records/{id}/confirm（F2-05 签名归档；409 CONFIRM_INCOMPLETE 见契约 §2）。
   *
   * 处理顺序：闸门校验（含接班人本人）→ 签名图解码校验（PNG 魔数 + ≤512KB）→ 落盘 →
   * 事务内**完整性终校**（F2-04-T1 服务端权威：仍有未知晓标红行 → 409，与转 completed
   * 同事务防「知晓与归档并发」竞态）→ status=completed + confirmed_at=服务端时刻 +
   * signature_path → 审计 `record.confirm`（契约 §5）。
   * 无标红行的单（alerts 空）直接可确认——逐条知晓只约束**存在的**确认行。
   */
  async confirm(
    user: SessionUser,
    id: number,
    payload: ConfirmPayloadDto,
  ): Promise<ConfirmResultDto> {
    const row = await this.confirmableRecordOf(id, user);
    const sig = typeof payload?.signature === 'string' ? payload.signature : '';
    if (sig.trim() === '') {
      throw new ApiException('VALIDATION_MISSING_FIELDS', '请签名后确认归档', {
        missingFields: [SIGNATURE_MISSING()],
      });
    }
    const png = decodeSignature(sig);
    if (!png) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '签名图格式非法（须为 PNG 图片）', {
        missingFields: [SIGNATURE_BAD_PAYLOAD()],
      });
    }
    if (png.length > SIGNATURE_MAX_BYTES) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '签名图过大，请重新签名', {
        missingFields: [SIGNATURE_BAD_PAYLOAD()],
      });
    }
    // 先落盘再进事务：路径按 record_no 确定性可重入，事务失败残留文件无副作用（重试覆盖）
    const signaturePath = await writeSignatureFile(row.recordNo, png);
    const confirmedAt = localMeasuredAt(); // DATA-09 同口径：服务端收到时刻

    return this.db.transaction(async (tx) => {
      // 完整性终校（F2-04-T1）：与下方 update 同事务，防知晓与归档并发的中间态入档
      const open = await tx
        .select({ id: alerts.id })
        .from(alerts)
        .where(and(eq(alerts.recordId, row.id), isNull(alerts.acknowledgedBy)));
      if (open.length > 0) {
        throw new ApiException(
          'CONFIRM_INCOMPLETE',
          `仍有 ${open.length} 项标红/交接事项未逐条知晓，请先逐条确认`,
        );
      }
      await tx
        .update(records)
        .set({ status: 'completed', confirmedAt, signaturePath })
        .where(eq(records.id, row.id));
      await tx.insert(auditLogs).values({
        actorId: user.id,
        action: 'record.confirm',
        targetType: 'record',
        targetId: row.recordNo,
        newValue: { version: row.version },
      });
      return {
        id: row.id,
        record_no: row.recordNo,
        status: 'completed' as const,
        version: row.version,
        confirmed_at: confirmedAt,
        receiver: row.receiverId != null ? { id: row.receiverId, real_name: user.realName } : null,
        signature_path: signaturePath,
      } satisfies ConfirmResultDto;
    });
  }

  // ── 异议与版本（TK-20：契约 §3.2/§3.4；F2-06、F2-07；决策记录 D-T23）────────────

  /**
   * 标注异议闸门（objection 专用，与 confirmableRecordOf 同构的单一实现）：
   * - 404 NOT_FOUND：单不存在（含非数字 id，与 detail 同一口径）；
   * - 403 FORBIDDEN：登录人非该单接班人——异议是接班人的责任界定动作（D-P06），
   *   他人代标会弱化责任归属；chief 由角色守卫拦外（契约 §3.4 角色列 master）；
   * - 409 CONFIRM_INCOMPLETE：非 submitted（draft/objection/completed 均无「退回」语义）——
   *   错误码 13 项外不增设新码，同族 409 文案区分（TK-19 先例）。
   */
  private async objectionMarkableRecordOf(
    id: number,
    user: SessionUser,
  ): Promise<typeof records.$inferSelect> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    }
    const rows = await this.db.select().from(records).where(eq(records.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    if (row.receiverId !== user.id) {
      throw new ApiException('FORBIDDEN', '仅接班人本人可标注异议退回');
    }
    if (row.status !== 'submitted') {
      throw new ApiException('CONFIRM_INCOMPLETE', '交接单当前状态不允许标注异议');
    }
    return row;
  }

  /**
   * 异议单编辑闸门（PUT 修改与 resubmit 重提共用，单一实现防两套口径）：
   * - 404 NOT_FOUND：单不存在（含非数字 id）；
   * - 403 FORBIDDEN：登录人非该单交班人——退回对象是交班人，修改是其责任动作
   *   （D-P06 留痕责任链；接班人/他人代改 403，chief 由角色守卫拦外）；
   * - 409 CONFIRM_INCOMPLETE：仅 objection 可编辑——submitted 单的修改走撤回（F2-08，
   *   TK-21），draft/completed 亦无异议修改语义（同族 409 文案区分）。
   */
  private async objectionEditableRecordOf(
    id: number,
    user: SessionUser,
  ): Promise<typeof records.$inferSelect> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    }
    const rows = await this.db.select().from(records).where(eq(records.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    if (row.submitterId !== user.id) {
      throw new ApiException('FORBIDDEN', '仅交班人本人可修改被退回的异议单');
    }
    if (row.status !== 'objection') {
      throw new ApiException('CONFIRM_INCOMPLETE', '交接单当前状态不允许异议修改或重提');
    }
    return row;
  }

  /**
   * GET /records/mine/objections（F2-06「退回交班人」的取数半边 + F2-13 下次到岗处理）：
   * 我为 submitter 且 status='objection'（重提后转回 submitted 即从清单消失）。
   * 按 duty_date 降序（最近被退回的在前）。
   */
  async objections(user: SessionUser): Promise<ObjectionListDto> {
    const receiverU = alias(users, 'objection_receiver');
    const rows = await this.db
      .select({
        id: records.id,
        recordNo: records.recordNo,
        dutyDate: records.dutyDate,
        status: records.status,
        version: records.version,
        submittedAt: records.submittedAt,
        objectionNote: records.objectionNote,
        objectionAt: records.objectionAt,
        receiverId: receiverU.id,
        receiverName: receiverU.realName,
      })
      .from(records)
      .leftJoin(receiverU, eq(records.receiverId, receiverU.id))
      .where(and(eq(records.submitterId, user.id), eq(records.status, 'objection')))
      .orderBy(desc(records.dutyDate));
    return {
      items: rows.map((r) => ({
        id: r.id,
        record_no: r.recordNo,
        duty_date: r.dutyDate,
        status: r.status,
        version: r.version,
        submitted_at: r.submittedAt,
        objection_note: r.objectionNote ?? '',
        objection_at: r.objectionAt ?? '',
        receiver:
          r.receiverId != null
            ? { id: r.receiverId, real_name: r.receiverName ?? String(r.receiverId) }
            : null,
      })),
    };
  }

  /**
   * POST /records/{id}/objection（F2-06，D-T23 拍板：仅接班人本人）：
   * note 必填（空白 400 点名、超 objection_note 列容量 varchar(500) 400 越界）→
   * 行锁下转 objection + objection_at=服务端时刻 + 审计 `record.objection`（契约 §5：
   * reason 列「—」，原因记 newValue.note）。重提后 objection_note/at 保留在行上
   * （「曾被退回及原因」的历史，详情页可直接展示；escalated_at 主权随 TK-22 定时任务）。
   */
  async objection(
    user: SessionUser,
    id: number,
    payload: ObjectionPayloadDto,
  ): Promise<ObjectionResultDto> {
    const row = await this.objectionMarkableRecordOf(id, user);
    const note = typeof payload?.note === 'string' ? payload.note.trim() : '';
    if (note === '') {
      throw new ApiException('VALIDATION_MISSING_FIELDS', '请填写异议原因', {
        missingFields: [OBJECTION_NOTE_MISSING()],
      });
    }
    if (note.length > 500) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '异议原因过长（上限 500 字）', {
        missingFields: [OBJECTION_NOTE_MISSING()],
      });
    }
    const objectionAt = localMeasuredAt();
    await this.db.transaction(async (tx) => {
      // 行锁串行化：标注与接班人确认/交班人撤回并发时，必有一方在锁上看到对方提交后的状态
      const locked = await tx
        .select({ status: records.status })
        .from(records)
        .where(eq(records.id, row.id))
        .limit(1)
        .for('update');
      if (locked[0]?.status !== 'submitted') {
        throw new ApiException('CONFIRM_INCOMPLETE', '交接单当前状态不允许标注异议');
      }
      await tx
        .update(records)
        .set({ status: 'objection', objectionNote: note, objectionAt })
        .where(eq(records.id, row.id));
      await tx.insert(auditLogs).values({
        actorId: user.id,
        action: 'record.objection',
        targetType: 'record',
        targetId: row.recordNo,
        oldValue: { status: 'submitted', version: row.version },
        newValue: { status: 'objection', version: row.version, note },
      });
    });
    return {
      id: row.id,
      record_no: row.recordNo,
      status: 'objection',
      version: row.version,
      objection_note: note,
      objection_at: objectionAt,
    } satisfies ObjectionResultDto;
  }

  /**
   * POST /admin/records/{id}/annotation（TK-24，契约 §3.6；F6-01「批注」、D-T24）。
   *
   * 科长对交接单的管理备注：**覆盖式单条**（records.chief_note 当前值），trim 后空串 =
   * 清除（置 NULL），≤500 字（越界 400 点名 chief_note，同 objection_note 容量口径）。
   * **不限记录状态**——draft（撤回未重提）单上批注「请尽快重提」是合法管理动作；
   * 值无变化不更新不写审计（D-T21 M1 数值判等同一精神，防重复提交制造审计噪音）；
   * 写入/清除/历次修改均以审计 `record.annotate` 留痕（oldValue/newValue 携 note 前后值，
   * 契约 §5），批注不进 record_versions（非交接单数据变更，version 不动）。
   * 404 口径与 detail 同一（非数字 id 一并 404）。
   */
  async annotate(
    user: SessionUser,
    id: number,
    payload: AnnotationPayloadDto,
  ): Promise<AnnotationResultDto> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
    }
    const note = typeof payload?.note === 'string' ? payload.note.trim() : '';
    if (note.length > 500) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '批注内容过长（上限 500 字）', {
        missingFields: [CHIEF_NOTE_MISSING()],
      });
    }
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select({ recordNo: records.recordNo, chiefNote: records.chiefNote })
        .from(records)
        .where(eq(records.id, id))
        .limit(1)
        .for('update');
      const row = locked[0];
      if (!row) throw new ApiException('NOT_FOUND', '交接单不存在或已被删除');
      const next = note === '' ? null : note;
      if (row.chiefNote !== next) {
        await tx.update(records).set({ chiefNote: next }).where(eq(records.id, id));
        await tx.insert(auditLogs).values({
          actorId: user.id,
          action: 'record.annotate',
          targetType: 'record',
          targetId: row.recordNo,
          oldValue: { note: row.chiefNote },
          newValue: { note: next },
        });
      }
      return { id, record_no: row.recordNo, chief_note: next } satisfies AnnotationResultDto;
    });
  }

  /**
   * PUT /records/{id}（F2-07 异议单修改，D-T23 拍板「直写行 + 首改快照」）：
   * - 语义：**部分合并**——仅上送字段写入（异议修改场景是「改值」；清空字段暂不支持，
   *   随 h5 修改页需要时扩展显式 null 语义）；status 仍 objection、version 不变；
   * - 快照：本版本**首次修改**时把修改前全字段定格入 record_versions（version=当前版本、
   *   snapshot=旧全字段、changed=差异、editor=修改人）；重复 PUT 不重复插行
   *   （UNIQUE(record_id, version)），原版定格于首改前，changed 按基线重算累计口径；
   * - 校验：字段级形状（枚举/数值/长度/停机清列）与 submit 同一 normalizeSections，
   *   越值 400 点名；**必填完整性不在此拦**（允许分次修改，重提时把关）。
   */
  async updateObjectionRecord(
    user: SessionUser,
    id: number,
    payload: RecordUpdatePayloadDto,
  ): Promise<RecordUpdateResultDto> {
    const row = await this.objectionEditableRecordOf(id, user);
    const sections = (payload?.sections ?? {}) as Readonly<
      Partial<Record<RecordFieldName, unknown>>
    >;
    const { values, outOfRange } = this.normalizeSections(sections);
    // 用量列不随 PUT 改写（normalize 已置 null——剔除后重提前保留原固化值，重提时重算固化）
    for (const key of SERVER_CALCULATED_KEYS) delete values[key];
    if (outOfRange.length > 0) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '部分字段取值越界，请核对后重试', {
        missingFields: outOfRange,
      });
    }

    let changed: Record<string, { old: unknown; new: unknown }> = {};
    await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(records)
        .where(eq(records.id, row.id))
        .limit(1)
        .for('update');
      const current = locked[0];
      if (!current || current.status !== 'objection') {
        throw new ApiException('CONFIRM_INCOMPLETE', '交接单当前状态不允许修改（可能已被重提）');
      }
      // 首改快照：本版本快照缺行时定格修改前状态；已有则基于快照重算累计 diff
      const prior = await tx
        .select({ snapshot: recordVersions.snapshot })
        .from(recordVersions)
        .where(
          and(eq(recordVersions.recordId, row.id), eq(recordVersions.version, current.version)),
        )
        .limit(1);
      const baseline = (prior[0]?.snapshot ?? this.readingsOf(current)) as Record<string, unknown>;
      // 合并视图（提交侧「草稿 ?? 服务端值」同思路）：以**当前行状态**（含此前 PUT 已落库
      // 修改）叠加本次上送合成 prospective 状态，相对快照基线 diff——changed 恒为
      // 「原版 → 当前待重提状态」的累计口径（基于快照合并会丢失首改字段）；
      // 两侧统一映射到字段字典名空间（baseline 快照即字典名键，勿混 TS 键）
      const merged: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(this.rowValuesOf(current))) {
        const name = TS_KEY_TO_FIELD.get(key);
        if (name) merged[name] = v;
      }
      for (const [key, v] of Object.entries(values)) {
        const name = TS_KEY_TO_FIELD.get(key);
        if (name) merged[name] = v;
      }
      changed = diffSnapshotValues(baseline, merged);
      if (prior[0]) {
        await tx
          .update(recordVersions)
          .set({ changed, editorId: user.id, editedAt: localMeasuredAt() })
          .where(
            and(eq(recordVersions.recordId, row.id), eq(recordVersions.version, current.version)),
          );
      } else {
        await tx.insert(recordVersions).values({
          recordId: row.id,
          version: current.version,
          snapshot: baseline,
          changed,
          editorId: user.id,
          editedAt: localMeasuredAt(),
        });
      }
      if (Object.keys(values).length > 0) {
        await tx.update(records).set(values).where(eq(records.id, row.id));
      }
    });
    return {
      id: row.id,
      record_no: row.recordNo,
      status: 'objection',
      version: row.version,
      changed: Object.keys(changed),
    } satisfies RecordUpdateResultDto;
  }

  /**
   * POST /records/{id}/resubmit（F2-07 异议修改后重提，D-T23 拍板）：
   * 表单值以 PUT 已写入行的值为准（重提从行上读数重走校验/防呆/计算，与 submit 消费
   * 同一套函数）；请求体仅可选 confirmations/usage_overrides（防呆 409 与覆盖协议同 §4）。
   * - 完整性把关：validateForSubmit 对行上值全量校验，缺项 400 点名（不放行半张单）；
   * - version+1、submitted_at=服务端时刻（PRD 附录 A：重新提交即更新交接时间）；
   * - 标红重建（快照语义，TK-17 L3 同纪律）：alerts 先清后插，旧逐条知晓随旧版本作废；
   * - 下游重算（TK-16 挂账闭环）：复用 recalcDownstreamInTx（行锁已补），trigger=_OBJ；
   * - objection_note/at 保留在行上（历史留痕）；审计复用 record.submit（契约 §5 无独立行）。
   */
  async resubmit(
    user: SessionUser,
    id: number,
    payload: ResubmitPayloadDto,
  ): Promise<ResubmitResultDto> {
    const row = await this.objectionEditableRecordOf(id, user);
    const overrideCheck = this.validateUsageOverrides(payload?.usage_overrides);
    const confirmCheck = this.validateConfirmations(payload?.confirmations);

    // 必填完整性把关：以行上当前值（含 PUT 修改）为表单快照，与 submit 同一引擎
    const result = this.validateForSubmit(this.readingsOf(row));
    result.missing.push(...overrideCheck.missing);
    result.outOfRange.push(...overrideCheck.outOfRange, ...confirmCheck.outOfRange);
    const body = buildValidationError(result);
    if (body) {
      throw new ApiException(body.code, body.message, {
        missingFields: [...body.missing_fields],
      });
    }

    // 上一班取数与 submitCore 同源（adjacentPrevRow，D-T17）；相邻班次仍缺失时回落
    // **原提交的补录基线**（record.prev_backfill 审计，D-T19 留痕即真值）——否则重提会把
    // 原按补录值算好的用量清成 null
    const prevRow = await this.adjacentPrevRow(row.dutyDate);
    const backfillBase = prevRow ? null : await this.latestPrevBackfillOf(row.recordNo);
    const prevGet: FieldValueGetter = prevRow
      ? (name) => {
          const key = recordKeyOf(name, this.logger);
          return key ? ((prevRow[key as keyof typeof prevRow] as unknown) ?? null) : null;
        }
      : (name) => backfillBase?.[name as PrevBackfillField] ?? null;
    const cur: FieldValueGetter = (name) => {
      const key = recordKeyOf(name, this.logger);
      return key ? ((row[key as keyof typeof row] as unknown) ?? null) : null;
    };

    // 防呆 409（与 submitCore 同口径：确认以归一清单为准、错位确认不消费）
    const confirmedDecrease = new Map<DecreasedGuardField, string>();
    const confirmedRefill = new Map<1 | 2, string>();
    for (const c of confirmCheck.normalized) {
      if (c.type === 'reading_decreased') {
        if (!confirmedDecrease.has(c.field)) confirmedDecrease.set(c.field, c.reason);
      } else if (!confirmedRefill.has(c.card)) {
        confirmedRefill.set(c.card, c.reason);
      }
    }
    const decreased = decreasedReadingsOf(cur, prevGet);
    const refills = refillCardsOf(cur, prevGet);
    const needConfirm = unconfirmedNeedConfirmItems(
      cur,
      prevGet,
      new Set(confirmedDecrease.keys()),
      new Set(confirmedRefill.keys()),
    );
    if (needConfirm.length > 0) {
      const hasDecreased = needConfirm.some((c) => c.type === 'reading_decreased');
      throw new ApiException(
        hasDecreased ? 'READINGS_DECREASED' : 'GAS_REFILL_CONFIRMED',
        '存在异常读数，请逐条确认后重新提交',
        { needConfirm },
      );
    }

    // 用量计算与覆盖（同 submitCore 第 ③ 步：确认充气卡按 0 计 D-P14、覆盖值固化）
    const refilled = new Set<1 | 2>(
      [...confirmedRefill.keys()].filter((card) => refills.some((r) => r.card === card)),
    );
    const usage = this.computeUsageValues(cur, prevGet, refilled);
    const overrides = this.applyUsageOverrides(overrideCheck.valid, usage.auto);
    Object.assign(usage.values, overrides.values);

    const submittedAt = localMeasuredAt();
    const version = row.version + 1;
    const sourceValues = this.rowValuesOf(row); // 重算 prev 源（TS 键空间）
    let recalc: ResubmitResultDto['recalc'] = null;
    await this.db.transaction(async (tx) => {
      const locked = await tx
        .select({ status: records.status })
        .from(records)
        .where(eq(records.id, row.id))
        .limit(1)
        .for('update');
      if (locked[0]?.status !== 'objection') {
        throw new ApiException('CONFIRM_INCOMPLETE', '交接单当前状态不允许重提');
      }
      // 兜底快照：无 PUT 直接重提时本版本快照缺行——定格重提前状态，保证每个被替换的
      // 版本在 record_versions 都有行（UNIQUE(record_id, version) 幂等）
      const prior = await tx
        .select({ id: recordVersions.id })
        .from(recordVersions)
        .where(and(eq(recordVersions.recordId, row.id), eq(recordVersions.version, row.version)))
        .limit(1);
      if (!prior[0]) {
        await tx.insert(recordVersions).values({
          recordId: row.id,
          version: row.version,
          snapshot: this.readingsOf(row),
          changed: {},
          editorId: user.id,
          editedAt: localMeasuredAt(),
        });
      }
      await tx
        .update(records)
        .set({ ...usage.values, status: 'submitted', submittedAt, version })
        .where(eq(records.id, row.id));

      // 标红重建（快照语义）：先清后插——电梯不一致沿行上核对明细重标（PUT 不改核对），
      // 状态异常/交接事项按重提值重建（insertStatusAndHandoverAlertsInTx 与 submit 同一实现）
      await tx.delete(alerts).where(eq(alerts.recordId, row.id));
      const plans = await this.elevatorPlanMapOf();
      const checkRows = await tx
        .select()
        .from(elevatorChecks)
        .where(eq(elevatorChecks.recordId, row.id));
      for (const c of checkRows) {
        // actual 可空（schema 无 NOT NULL，§4.2 原样）：脏历史行按未核对处理，不标红
        if (c.actual === null || !isMismatchOf(c.actual)) continue;
        const name = plans.get(c.elevatorId)?.name ?? `电梯#${c.elevatorId}`;
        const message =
          `${name} 预期${elevatorExpectedLabel(c.expected)}、实际${elevatorActualLabel(c.actual)}` +
          (c.explanation ? `：${c.explanation}` : '');
        await tx.insert(alerts).values({
          recordId: row.id,
          ruleKey: 'elevator_mismatch',
          target: `elevator:${c.elevatorId}`,
          level: ELEVATOR_ALERT_LEVEL,
          message: message.slice(0, 300),
        });
      }
      await this.insertStatusAndHandoverAlertsInTx(tx, row.id, sourceValues);

      // 审计（契约 §5 无独立 resubmit 行——重提即一次提交，复用 record.submit；
      // newValue 记 resubmitted 供复核检索与版本归属区分）
      await tx.insert(auditLogs).values({
        actorId: user.id,
        action: 'record.submit',
        targetType: 'record',
        targetId: row.recordNo,
        reason: '异议修改后重提',
        newValue: {
          receiver_id: row.receiverId,
          receiver_changed: false,
          version,
          resubmitted: true,
        },
      });
      // 用量覆盖留痕（同 submitCore：逐覆盖项一行，oldValue 记覆盖前自动值）
      for (const o of overrides.applied) {
        await tx.insert(auditLogs).values({
          actorId: user.id,
          action: 'record.usage_override',
          targetType: 'record',
          targetId: row.recordNo,
          oldValue: { field: o.field, auto_value: o.auto },
          newValue: { field: o.field, value: o.value, version },
          reason: o.reason,
        });
      }
      // 防呆确认留痕（同 submitCore：仅命中项入账，逐命中项一行）
      const confirmAudits = [
        ...decreased.map((d) => ({
          type: 'reading_decreased' as const,
          field: d.field as string,
          card: null as 1 | 2 | null,
          prev: d.prev,
          current: d.current,
          reason: confirmedDecrease.get(d.field) ?? '',
        })),
        ...refills.map((r) => ({
          type: 'gas_refill' as const,
          field: GAS_CARD_FIELDS[r.card] as string,
          card: r.card as 1 | 2 | null,
          prev: r.prev,
          current: r.current,
          reason: confirmedRefill.get(r.card) ?? '',
        })),
      ];
      for (const c of confirmAudits) {
        await tx.insert(auditLogs).values({
          actorId: user.id,
          action: 'record.submit',
          targetType: 'record',
          targetId: row.recordNo,
          newValue:
            c.card === null
              ? { type: c.type, field: c.field, prev: c.prev, current: c.current, version }
              : { type: c.type, card: c.card, prev: c.prev, current: c.current, version },
          reason: c.reason,
        });
      }

      // 下游重算（TK-16 挂账闭环：行锁与 1062→409 已随本任务补齐，D-T21 修订）
      recalc = await this.recalcDownstreamInTx(
        tx,
        row.dutyDate,
        sourceValues,
        user.id,
        row.recordNo,
        'objection_resubmit',
      );
    });
    return {
      id: row.id,
      record_no: row.recordNo,
      status: 'submitted',
      version,
      submitted_at: submittedAt,
      recalc,
    } satisfies ResubmitResultDto;
  }

  // ── 撤回窗口（TK-21：契约 §3.2；F2-08、F2-09、F2-10；决策记录 D-P05）────────────

  /**
   * 撤回闸门（POST /records/today/withdraw 专用，与 objectionMarkableRecordOf 同构）：
   * 按当前班次日期（C-08）定位记录（duty_date UNIQUE → 至多一行）——
   * - 404 NOT_FOUND：当前班次无记录（无可撤回的单）；
   * - 403 FORBIDDEN：登录人非该单交班人——撤回是交班人的单方纠错动作（D-P05），
   *   他人代撤会弱化责任归属；chief 由角色守卫拦外（契约 §3.2 角色列 master）。
   * 状态机判定（三不可撤条件 + draft 重复撤回）在 withdraw() 行锁内做，闸门只管归属与存在性。
   */
  private async withdrawableRecordOf(
    user: SessionUser,
    dutyDate: string,
  ): Promise<typeof records.$inferSelect> {
    const rows = await this.db
      .select()
      .from(records)
      .where(eq(records.dutyDate, dutyDate))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiException('NOT_FOUND', '当前班次无交接单可撤回');
    if (row.submitterId !== user.id) {
      throw new ApiException('FORBIDDEN', '仅交班人本人可撤回本班次交接单');
    }
    return row;
  }

  /**
   * POST /records/today/withdraw（F2-08/F2-09/F2-10，D-P05 拍板：提交后 10 分钟内且接班人
   * 未确认，交班人可单方撤回重改）：
   * - 三不可撤条件（F2-10，服务端权威校验，行锁下判定）：接班人已确认（completed）→
   *   ALREADY_CONFIRMED；处于有异议（objection）→ IN_OBJECTION；超窗口（submitted 但
   *   now − submitted_at > withdraw_window_minutes）→ WINDOW_EXPIRED——均 409 WITHDRAW_NOT_ALLOWED
   *   携 reason（契约 §2），提示走异议流程；
   * - draft（已撤回或从未提交，D-T18：draft 仅由撤回产生）→ 409 CONFIRM_INCOMPLETE 同族（无「撤回」语义）；
   * - 成功：转 draft + 清 submitted_at（回到可编辑，F2-08）、version 不变（重提才 +1，F2-08-T2）、
   *   读数列保留（师傅继续改）；提交时生成的 alerts/elevator_checks 同事务清空（快照语义，
   *   与 submitCore 重提先清后插同源；draft 单不带标红/核对明细）；接班人端待确认入口随
   *   status 转 draft 同步消失（F2-09-T2，pending 取数口径 status='submitted'）；
   * - 审计 record.withdraw（契约 §5「谁、何时」：actor_id=谁、created_at=何时；old_value 记
   *   submitted 起点与提交时刻、new_value 记 draft 归宿）。
   * 行锁串行化：撤回与接班人确认/标注异议并发时，必有一方在锁上看到对方提交后的状态
   * （确认已落库→撤回撞 ALREADY_CONFIRMED；撤回已转 draft→确认/异议撞各自的状态闸）。
   */
  async withdraw(user: SessionUser, now: Date = new Date()): Promise<WithdrawResultDto> {
    const { dutyDate } = await this.resolveDutyDate(now);
    const row = await this.withdrawableRecordOf(user, dutyDate);
    const windowMinutes = await this.withdrawWindowMinutes();

    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(records)
        .where(eq(records.id, row.id))
        .limit(1)
        .for('update');
      const current = locked[0];
      if (!current) throw new ApiException('NOT_FOUND', '当前班次无交接单可撤回');

      // 三不可撤条件（F2-10）：状态锁定（已确认/有异议）先于窗口判定——锁定后窗口再长也不可撤，
      // 先报状态因由更贴责任语义（D-P06「确认是责任界定的锚点」）
      if (current.status === 'completed') {
        throw new ApiException(
          'WITHDRAW_NOT_ALLOWED',
          '接班人已完成确认，交接单已锁定，请联系接班人走异议流程',
          { reason: 'ALREADY_CONFIRMED' satisfies WithdrawNotAllowedReason },
        );
      }
      if (current.status === 'objection') {
        throw new ApiException(
          'WITHDRAW_NOT_ALLOWED',
          '交接单处于有异议状态，不可撤回，请走异议修改流程',
          { reason: 'IN_OBJECTION' satisfies WithdrawNotAllowedReason },
        );
      }
      if (current.status === 'draft') {
        // 已撤回（draft 仅由撤回产生，D-T18）或从未提交：无「撤回」语义，同族 409 文案区分
        throw new ApiException('CONFIRM_INCOMPLETE', '交接单尚未提交或已撤回，无法再次撤回');
      }
      // status === 'submitted'：校验撤回窗口（F2-08「10 分钟内」/F2-10-T1「超窗口拒绝」）。
      // submitted_at 缺失（理论不应存在）按无法核实→保守拒绝（WINDOW_EXPIRED）
      const submittedDate = localTimestampToDate(current.submittedAt ?? '');
      const elapsedMinutes =
        submittedDate === null ? Infinity : (now.getTime() - submittedDate.getTime()) / 60000;
      if (elapsedMinutes > windowMinutes) {
        throw new ApiException(
          'WITHDRAW_NOT_ALLOWED',
          `已超过 ${windowMinutes} 分钟撤回窗口，请联系接班人走异议流程`,
          { reason: 'WINDOW_EXPIRED' satisfies WithdrawNotAllowedReason },
        );
      }

      // 撤回：转 draft + 清 submitted_at（回到可编辑，F2-08）；version 不变（重提才 +1）；读数列保留。
      // alerts/elevator_checks 同事务清空（快照语义，与 submitCore 重提先清后插同源）
      await tx
        .update(records)
        .set({ status: 'draft', submittedAt: null })
        .where(eq(records.id, current.id));
      await tx.delete(alerts).where(eq(alerts.recordId, current.id));
      await tx.delete(elevatorChecks).where(eq(elevatorChecks.recordId, current.id));
      // 撤回留痕（契约 §5 record.withdraw「谁、何时」：actor_id=谁、created_at=何时自动）
      await tx.insert(auditLogs).values({
        actorId: user.id,
        action: 'record.withdraw',
        targetType: 'record',
        targetId: current.recordNo,
        oldValue: {
          status: 'submitted',
          version: current.version,
          submitted_at: current.submittedAt,
        },
        newValue: { status: 'draft', version: current.version },
      });

      return {
        id: current.id,
        record_no: current.recordNo,
        status: 'draft' as const,
        version: current.version,
      } satisfies WithdrawResultDto;
    });
  }

  /**
   * 原提交的补录基线（TK-20 重提专用）：`record.prev_backfill` 审计最新版本的 readings
   * （D-T19「留痕即真值」）。重提场景上一班仍缺失时以此作计算/防呆基线，避免把原按
   * 补录值固化的用量清成 null。无补录史返回 null（上一班真缺失）。
   */
  private async latestPrevBackfillOf(
    recordNo: string,
  ): Promise<Partial<Record<PrevBackfillField, number>> | null> {
    const rows = await this.db
      .select({ newValue: auditLogs.newValue })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'record.prev_backfill'), eq(auditLogs.targetId, recordNo)));
    let latest: { version: number; readings: Partial<Record<PrevBackfillField, number>> } | null =
      null;
    for (const r of rows) {
      const nv = r.newValue as { readings?: unknown; version?: unknown } | null;
      if (nv && typeof nv === 'object' && nv.readings && typeof nv.readings === 'object') {
        const v = Number(nv.version ?? 0);
        if (!latest || v > latest.version) {
          latest = {
            version: v,
            readings: nv.readings as Partial<Record<PrevBackfillField, number>>,
          };
        }
      }
    }
    return latest?.readings ?? null;
  }

  /**
   * records 行 → TS 键值映射（resubmit 的重算 prev 源与标红重建入参）：与 readingsOf
   * 同取数范围（板块 ≥1 存储列）、不同键空间（TS camelCase）——recalcDownstream 的
   * prev getter 与 insertStatusAndHandoverAlertsInTx 的 values 均按 TS 键取值。
   */
  private rowValuesOf(row: typeof records.$inferSelect): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const def of FIELDS) {
      if (def.section === 0) continue;
      const key = recordKeyOf(def.name, this.logger);
      if (!key) continue;
      values[key] = row[key as keyof typeof row] ?? null;
    }
    return values;
  }

  /**
   * 状态异常 + 交接事项标红行（契约 §4 第 4 步「生成标红确认行」的共用实现：TK-18 落地、
   * TK-20 抽取供 resubmit 复用——电梯不一致行由各调用方按其核对数据源自行写入）：
   * 状态字段=bad 逐字段一行（异常备注并入文案）、交接事项按 shared handoverItemsOf 拆条。
   * 快照语义（先清后插）由调用方保证。
   */
  private async insertStatusAndHandoverAlertsInTx(
    tx: DbExecutor,
    recordId: number,
    values: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    for (const def of FIELDS) {
      if (def.kind !== 'status') continue;
      const key = recordKeyOf(def.name, this.logger);
      if (!key || values[key] !== ABNORMAL_STATUS) continue;
      const noteKey = recordKeyOf(
        def.name.replace(/_status$/, '_note') as RecordFieldName,
        this.logger,
      );
      const noteRaw = noteKey ? values[noteKey] : null;
      const note = typeof noteRaw === 'string' ? noteRaw.trim() : '';
      await tx.insert(alerts).values({
        recordId,
        ruleKey: `${def.name}_bad`,
        target: `field:${def.name}`,
        level: STATUS_ALERT_LEVEL,
        message: `「${def.label}」填写为异常${note ? `：${note}` : ''}`.slice(0, 300),
      });
    }
    const handoverItems = handoverItemsOf(values['handoverNote']);
    for (const [i, item] of handoverItems.entries()) {
      await tx.insert(alerts).values({
        recordId,
        ruleKey: 'handover_note',
        target: 'field:handover_note',
        level: HANDOVER_ALERT_LEVEL,
        message: `交接事项 ${i + 1}：${item}`.slice(0, 300),
      });
    }
  }

  // ── 提交协议（TK-12：契约 §3.2 preview/submit、§4；F1-10、F2-01、DATA-05/07/09/10/13）─────

  /**
   * 接班人带出（F2-01/DATA-10）：**次日排班人**——排班表是「日期→当日值班人」语义，
   * 本班交接的接收方是下一个班次的人（F2-01-T1 判据「receiver=排班表次日人」）。
   * 日期推算用 duty-date.ts plusOneDay（勿另写日历算术，防漂移纪律同 minusOneDay 注）。
   */
  private async scheduledReceiverOf(
    dutyDate: string,
  ): Promise<{ id: number; realName: string } | null> {
    const rows = await this.db
      .select({ id: users.id, realName: users.realName })
      .from(schedules)
      .innerJoin(users, eq(schedules.userId, users.id))
      .where(eq(schedules.dutyDate, plusOneDay(dutyDate)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 该班次**当日**排班人（TK-26，F6-05 排班安全阀比对基线）：与 scheduledReceiverOf 同族
   * 取数、日期取本班次当日（带出取 +1 天，安全阀取当天——「登录提交人 ≠ 当日排班」，
   * PRD §6.6）。排班缺失返回 null（无可比基线不判定，同防呆「任一侧缺失不判定」精神）。
   */
  private async scheduledDutyOf(
    dutyDate: string,
  ): Promise<{ id: number; realName: string } | null> {
    const rows = await this.db
      .select({ id: users.id, realName: users.realName })
      .from(schedules)
      .innerJoin(users, eq(schedules.userId, users.id))
      .where(eq(schedules.dutyDate, dutyDate))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 提交侧校验入口（契约 §4 第 1 步）：shared validateFields 同一引擎（F1-08），
   * 字段清单排除 `receiver_change_reason`——它是**条件必填**（DATA-10：仅修改接班人时必填），
   * 依赖接班人上下文，不属静态字段引擎的判定范围，由调用方按带出值判定后追加点名。
   */
  private validateForSubmit(sections: Readonly<Partial<Record<RecordFieldName, unknown>>>): {
    missing: MissingField[];
    outOfRange: MissingField[];
  } {
    const get: FieldValueGetter = (name) => sections[name] ?? null;
    const result = validateFields(
      FIELD_NAMES.filter((name) => name !== 'receiver_change_reason'),
      get,
    );
    // 拷为可变副本：接班人修改原因的条件点名（DATA-10）由调用方追加
    return { missing: [...result.missing], outOfRange: [...result.outOfRange] };
  }

  /** 异常项清单（F1-10「异常项一目了然」）：状态字段选「异常」的点名，不拦提交（PRD §6.2） */
  private abnormalFieldsOf(
    sections: Readonly<Partial<Record<RecordFieldName, unknown>>>,
  ): MissingField[] {
    return FIELD_NAMES.filter(
      (name) => FIELD_BY_NAME[name].kind === 'status' && sections[name] === ABNORMAL_STATUS,
    ).map((name) => toMissingField(name));
  }

  /**
   * 该记录**当前版本**被手工覆盖的用量字段集合（F3-06-T1 读取侧）：audit_logs 的
   * `record.usage_override` 行反查（留痕即真值来源，不另设存储列）。
   *
   * **按版本过滤（评审修复轮 M1）**：record_no 恒为 `HB-YYYYMMDD-001`（duty_date UNIQUE），
   * 撤回重提/异议重提跨版本共用同一 targetId 且审计只增不删（D-T09）——不过滤会把旧版本的
   * 覆盖标到已回到自动值的当前版本上（违反 F3-06-T1），且该集合是 TK-16 重算豁免（D-T07）
   * 的判定依据，误标会导致豁免不该豁免的字段。
   */
  private async usageOverrideFieldsOf(
    recordNo: string,
    version: number,
    // **无默认值（评审修复轮 m5）**：默认 `this.db` 会让「在事务里忘传 executor」退化为
    // 静默读到事务外旧快照而非编译错误；调用方显式传 this.db 或 tx
    executor: DbExecutor,
  ): Promise<Set<string>> {
    const rows = await executor
      .select({ newValue: auditLogs.newValue })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'record.usage_override'), eq(auditLogs.targetId, recordNo)));
    const fields = new Set<string>();
    for (const r of rows) {
      const nv = r.newValue;
      if (nv && typeof nv === 'object' && 'field' in nv && 'version' in nv) {
        if (Number((nv as { version: unknown }).version) === version) {
          fields.add(String((nv as { field: unknown }).field));
        }
      }
    }
    return fields;
  }

  /**
   * 用量列计算（TK-13，契约 §4 第 3 步的单一落点；TK-14 接入防呆取数）：四类口径全部
   * 消费 shared calc.ts 同一纯函数（与 h5 实时预览同源，杜绝两端各算一套）。当前值与
   * 上一班 getter 均由调用方构造（提交侧读 payload、重算侧读库行，TK-16）——
   * 相邻班次记录行（adjacentPrevRow，D-T17）或缺失态下的补录值（F3-07，D-T19）。
   * 无法计算（上一班缺失/读数缺）→ 列置 null 固化，不拦提交（用量列非必填）。
   * 返回 `auto` 供覆盖协议回填审计 oldValue（覆盖前服务端算出的自动值）。
   *
   * **充气确认取数层（TK-14，D-P14）**：`refilled` 为确认充气的卡号集合——gasDayUseOf
   * 据此把该卡差值按 0 计、另一卡正常计算；未确认时负差原样固化（契约订正 13 口径）。
   *
   * **列容量护栏（评审修复轮 L3）**：两线读数各自合法但差值**之和**可超 DECIMAL(12,1) 上限
   * （与「服务端未校验直接入库 → 500」同族）——超容量的用量列置 null 并记 error 日志，
   * 不送 MySQL（严格模式下 DECIMAL 溢出会 1264 → 500）。
   */
  private computeUsageValues(
    cur: FieldValueGetter,
    prev: FieldValueGetter,
    refilled: ReadonlySet<1 | 2>,
  ): {
    values: Record<string, string | null>;
    auto: Partial<Record<UsageFieldName, number>>;
  } {
    const water = waterDayUseOf(cur, prev);
    const e = eDayUseOf(cur, prev);
    const gas = gasDayUseOf(cur, prev, refilled);
    const lo = loDayUseOf(cur);
    // 列容量护栏：|计算值| 超列上限 → null（不入库），而非让 MySQL 严格模式报 500
    const capped = (field: UsageFieldName, n: number): string | null => {
      const max = numericMaxOf(field);
      if (max !== null && Math.abs(n) > max) {
        this.logger.error(
          `用量计算值超列容量：${field}=${n} 超出 DECIMAL 上限 ${max}，该列置 null 不入库`,
        );
        return null;
      }
      return String(roundToScaleOf(field, n));
    };
    const waterV = water === null ? null : capped('water_use', water);
    const eV = e === null ? null : capped('e_use', e.total);
    const gasV = gas === null ? null : capped('gas_use', gas.total);
    const loV = lo === null ? null : capped('lo_day_use', lo);
    return {
      values: {
        waterUse: waterV,
        eUse: eV,
        gasUse: gasV,
        loDayUse: loV,
      },
      auto: {
        ...(waterV === null ? {} : { water_use: Number(waterV) }),
        ...(eV === null ? {} : { e_use: Number(eV) }),
        ...(gasV === null ? {} : { gas_use: Number(gasV) }),
        ...(loV === null ? {} : { lo_day_use: Number(loV) }),
      },
    };
  }

  /**
   * 用量覆盖项**纯校验**（评审修复轮 M3/L4 拆分）：不依赖上一班与自动值，preview 与 submit
   * 消费同一函数，消除「预览全就绪、提交却 400」的不对称（TK-12 评审 L4 同纪律）。
   *
   * 规则：合法键集 shared `USAGE_FIELDS`；同一字段重复上送 → 越界点名（多行审计失真，
   * L4）；`reason` 空白 → missing 点名该用量字段（F3-06-T2 服务端强制，非仅前端）；
   * `reason` 超长（audit_logs.reason varchar(200)）与 `receiver_change_reason` 超长同口径
   * 以字段字典名义点名（评审修复轮 M4：不再误用「不支持的用量覆盖字段」）；值须为十进制
   * 字面量且不超列精度上限（numericMaxOf），否则越界点名；非数组上送 → 合成定位项点名
   * （评审修复轮 M2：原 for..of 迭代器异常会 500，收敛为一律 400）。
   */
  private validateUsageOverrides(input: unknown): {
    missing: MissingField[];
    outOfRange: MissingField[];
    valid: Array<{ field: UsageFieldName; value: number; reason: string }>;
  } {
    const missing: MissingField[] = [];
    const outOfRange: MissingField[] = [];
    const valid: Array<{ field: UsageFieldName; value: number; reason: string }> = [];
    // 未上送（undefined/null）= 无覆盖，合法；上送了但非数组才 400（评审修复轮 M2）
    if (input != null && !Array.isArray(input)) {
      outOfRange.push(USAGE_OVERRIDE_BAD_PAYLOAD());
      return { missing, outOfRange, valid };
    }
    const seen = new Set<UsageFieldName>();
    for (const o of (input ?? []) as readonly UsageOverridePayload[]) {
      if (!USAGE_FIELDS.includes(o.field)) {
        outOfRange.push(USAGE_OVERRIDE_BAD_FIELD(String(o.field)));
        continue;
      }
      const field = o.field as UsageFieldName;
      if (seen.has(field)) {
        outOfRange.push(toMissingField(field));
        continue;
      }
      seen.add(field);
      const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
      if (reason === '') {
        missing.push(toMissingField(field));
        continue;
      }
      if (reason.length > 200) {
        outOfRange.push(toMissingField(field));
        continue;
      }
      const n = parseNumeric(o.value);
      const max = numericMaxOf(field);
      if (n === null || n < -Math.abs(max ?? Infinity) || n > (max ?? Infinity)) {
        outOfRange.push(toMissingField(field));
        continue;
      }
      valid.push({ field, value: n, reason });
    }
    return { missing, outOfRange, valid };
  }

  /**
   * 补录上一班读数校验（TK-14，F3-07；D-T19）：实现已下沉 shared `guard.ts
   * validatePrevBackfillReadings`（TK-15 评审修复轮 L1，h5 离线预检与 api 同一实现），
   * 此处仅保留调用点签名。校验与消费解耦：垃圾值无论上一班是否缺失都不放行。
   */
  private validatePrevBackfill(
    input: Readonly<Partial<Record<PrevBackfillField, unknown>>> | undefined,
  ): { outOfRange: MissingField[]; readings: Partial<Record<PrevBackfillField, number>> } {
    return validatePrevBackfillReadings(input);
  }

  /**
   * 防呆确认项校验与归一（评审修复轮 M1/M2）：preview 与 submit 消费同一函数（M3/L4
   * 「预检即点名」同纪律）。规则：
   * - 非数组 → 400 合成定位项点名（M2：原 for..of 迭代器异常会 500）；
   * - `reason` 空白 → 视为未确认，从归一清单剔除（与未上送同待，F1-12-T2 不另 400）；
   * - `reason` 超长（audit_logs.reason varchar(200)）→ 400 越界点名，以字段字典名义
   *   （reading_decreased 点该 field、gas_refill 点对应气卡字段，与覆盖原因超长 M4 同口径；
   *   原直写审计列会撞 MySQL 1406 → 事务回滚 500，评审探针实证）；
   * - type 越值 / field 与类型不符的项保持容错忽略（消费侧不命中即不消费，不另 400）。
   */
  private validateConfirmations(input: unknown): {
    outOfRange: MissingField[];
    normalized: Array<
      | { type: 'reading_decreased'; field: DecreasedGuardField; reason: string }
      | { type: 'gas_refill'; card: 1 | 2; reason: string }
    >;
  } {
    const outOfRange: MissingField[] = [];
    const normalized: Array<
      | { type: 'reading_decreased'; field: DecreasedGuardField; reason: string }
      | { type: 'gas_refill'; card: 1 | 2; reason: string }
    > = [];
    // 未上送（undefined/null）= 无确认项，合法（F1-12-T2 语义）；上送了但非数组才 400（M2）
    if (input != null && !Array.isArray(input)) {
      outOfRange.push(CONFIRMATION_BAD_PAYLOAD());
      return { outOfRange, normalized };
    }
    for (const raw of (input ?? []) as readonly ConfirmationPayload[]) {
      const reason = typeof raw?.reason === 'string' ? raw.reason.trim() : '';
      if (reason === '') continue;
      if (raw.type === 'reading_decreased' && isDecreasedField(raw.field)) {
        if (reason.length > 200) {
          outOfRange.push(toMissingField(raw.field));
          continue;
        }
        normalized.push({ type: 'reading_decreased', field: raw.field, reason });
      } else if (raw.type === 'gas_refill' && (raw.card === 1 || raw.card === 2)) {
        const card = raw.card as 1 | 2;
        if (reason.length > 200) {
          outOfRange.push(toMissingField(GAS_CARD_FIELDS[card]));
          continue;
        }
        normalized.push({ type: 'gas_refill', card, reason });
      }
    }
    return { outOfRange, normalized };
  }

  /**
   * 用量覆盖项应用（submit 专用）：在服务端自动值之上改写（按列小数位取整，
   * roundToScaleOf）并产出留痕清单（写 audit_logs.reason，F3-04-T2「原因留痕；修正值固化」）。
   */
  private applyUsageOverrides(
    valid: ReadonlyArray<{ field: UsageFieldName; value: number; reason: string }>,
    auto: Readonly<Partial<Record<UsageFieldName, number>>>,
  ): {
    values: Record<string, string>;
    applied: Array<{ field: UsageFieldName; auto: number | null; value: string; reason: string }>;
  } {
    const values: Record<string, string> = {};
    const applied = valid.map(({ field, value, reason }) => {
      const v = String(roundToScaleOf(field, value));
      values[recordKeyOf(field, this.logger) ?? field] = v;
      return { field, auto: auto[field] ?? null, value: v, reason };
    });
    return { values, applied };
  }

  /**
   * 下游重算（TK-16，F3-08；在触发源的事务内执行）：上一班班次 D 的读数变化（补交晚到
   * 或异议修改重提，TK-20）后，重算紧邻下游 D+1 **已提交**记录的 prev 依赖用量——
   * 技术方案 §4.3 四类口径均只依赖紧邻上一班，故重算范围恰为 D+1（水/电/气三项；
   * 液氧日间用量只取本班两时点、不依赖上一班，不在重算范围）。下游无行或 draft
   * （待重提单，提交链路本就会全量重算）→ 无事可做。
   *
   * **行锁（TK-16 挂账闭环，契约订正 18 ⑧）**：下游行 SELECT ... FOR UPDATE 串行化——
   * 并发两个触发源（补交/异议重提）同时重算同一 D+1 行时读-改-写不再互相覆盖。
   *
   * trigger 语境（TK-20 参数化）：late_backfill（补交）/ objection_resubmit（异议重提），
   * 决定审计 reason 与 newValue 的复核检索键（后者沿用 late_backfill 的历史键名
   * backfill_record_no，records-backfill.spec 断言锚点不变）。
   *
   * 豁免（D-T07）：当前版本被师傅手工覆盖的字段跳过——判定依据 = `record.usage_override`
   * 审计行按版本过滤（TK-13 评审 M1 钉死），与 F3-06-T1 manual 旗标同源。
   *
   * 充气确认延续（D-P14）：重算不重跑防呆，下游原提交时确认充气的卡（`record.submit`
   * 审计 type=gas_refill 行反查，confirmedRefillCardsOf）仍按 0 计取数；原未确认的卡
   * 维持「负差原样固化」语义。
   *
   * 审计：逐**变更项**一行 `record.recalc`（oldValue 旧固化值 / newValue 新自动值与触发
   * 语境）；值无变化不更新不写审计（防与补录值相同的补交产生噪音审计行；判等口径
   * 见 sameUsageValue——**数值而非字符串**，M1）。三项全无变更时返回 null（L1）。
   */
  private async recalcDownstreamInTx(
    tx: DbExecutor,
    sourceDutyDate: string,
    sourceValues: Readonly<Record<string, unknown>>,
    actorId: number,
    sourceRecordNo: string,
    trigger: 'late_backfill' | 'objection_resubmit',
  ): Promise<RecalcResultDto | null> {
    // 行锁（TK-16 挂账闭环）：FOR UPDATE 串行化并发重算的读-改-写
    const nextRows = await tx
      .select()
      .from(records)
      .where(eq(records.dutyDate, plusOneDay(sourceDutyDate)))
      .limit(1)
      .for('update');
    const next = nextRows[0];
    if (!next) return null;
    // **状态门控（评审修复轮 L2，2026-09-14 拍板）**：只重算 submitted。
    // draft：待重提单，提交链路本就会全量重算，此处补算多余；
    // objection/completed：已进接班人确认流程、或已双方签名归档——**不静默改数**：
    // §5.4 与 DEP-08 下签名件的历史版本（record_versions）与库值会背离，且接班人与科长
    // 得知的数字悄然变化。原实现仅排除 draft，已签名单的数字可被一次补交改掉（评审发现）。
    // 这类晚到的下游单需人工处置（异议流程 TK-20 / 科长后台），故只留日志不改数。
    if (next.status !== 'submitted') {
      this.logger.warn(
        `重算触发源 ${sourceRecordNo}（${trigger}）的下游 ${next.recordNo}（${next.dutyDate}）处于 ` +
          `status=${next.status}，**不重算**（L2 拍板：不静默修改进确认/已归档单据的用量）；` +
          `如需修正该单数字，请走异议流程或科长后台处理`,
      );
      return null;
    }

    const exempt = await this.usageOverrideFieldsOf(next.recordNo, next.version, tx);
    const refilled = await this.confirmedRefillCardsOf(next.recordNo, next.version, tx);
    const cur: FieldValueGetter = (name) => {
      const key = recordKeyOf(name, this.logger);
      return key ? ((next as unknown as Record<string, unknown>)[key] ?? null) : null;
    };
    const prev: FieldValueGetter = (name) => {
      const key = recordKeyOf(name, this.logger);
      return key ? (sourceValues[key] ?? null) : null;
    };
    const usage = this.computeUsageValues(cur, prev, refilled);

    const changed: UsageFieldName[] = [];
    for (const field of ['water_use', 'e_use', 'gas_use'] as const) {
      if (exempt.has(field)) continue;
      const key = recordKeyOf(field, this.logger);
      if (!key) continue;
      const newV = usage.values[key] ?? null;
      const oldV = (next as unknown as Record<string, unknown>)[key] ?? null;
      // **数值判等（评审修复轮 M1）**：计算侧产出的字符串与 DECIMAL 列读回值形态不同
      // （'500' vs '500.0'，roundToScaleOf 返回 number、String 不补零），字符串相等对
      // **整数用量恒为“已变更”**——假 UPDATE + 假 record.recalc 审计，且使下方「值无变化
      // 不写审计」的明文承诺（契约 §5 / 技术方案 §4.3 / D-T21）静默失效（探针实证）。
      if (sameUsageValue(newV, oldV)) continue;
      await tx
        .update(records)
        .set({ [key]: newV })
        .where(eq(records.id, next.id));
      await tx.insert(auditLogs).values({
        actorId,
        action: 'record.recalc',
        targetType: 'record',
        targetId: next.recordNo,
        oldValue: { field, value: oldV, duty_date: next.dutyDate },
        newValue: {
          field,
          value: newV,
          version: next.version,
          trigger,
          // 复核检索键：late_backfill 沿用历史键名 backfill_record_no（records-backfill.spec
          // 断言锚点不变），异议重提语境记 source_record_no（两类触发源各自检索）
          ...(trigger === 'late_backfill'
            ? { backfill_record_no: sourceRecordNo }
            : { source_record_no: sourceRecordNo }),
        },
        reason:
          trigger === 'late_backfill'
            ? '上一班记录晚到补交，自动重算'
            : '上一班异议修改重提，自动重算',
      });
      changed.push(field);
    }
    // **待复核清单（评审修复轮 L6，2026-09-14 拍板）**：重算不重跑防呆拦截（不得在无人
    // 值守的回写链路上 409 卡住），但新基线可能使下游出现 D-T19 命中项（如补交的 D 日读数
    // 高于 D+1 自己 → 本应强制确认的回退却以负差直接入库，旁路 F1-12）。**不改数、不拦提交**，
    // 而是随响应与审计 `record.recalc_review` 一并标出，交人工走异议流程核对。
    // 确认复用口径（评审二轮 L1）：充气按卡号复用（D-P14 事实语义，confirmedRefillCardsOf），
    // 回退按「field+prev+current 三元组」值匹配复用（confirmedDecreaseHitsOf）——字段级复用
    // 会让新基线下更大的回退被旧确认静默解锁（D-T20 M6 同族陷阱），同值命中（如补录值恰与
    // 晚到实值一致）才消音。
    const needsReview = needConfirmItemsExcludingHits(
      cur,
      prev,
      await this.confirmedDecreaseHitsOf(next.recordNo, next.version, tx),
      refilled,
    );
    if (needsReview.length > 0) {
      await tx.insert(auditLogs).values({
        actorId,
        action: 'record.recalc_review',
        targetType: 'record',
        targetId: next.recordNo,
        newValue: {
          items: needsReview,
          version: next.version,
          trigger,
          ...(trigger === 'late_backfill'
            ? { backfill_record_no: sourceRecordNo }
            : { source_record_no: sourceRecordNo }),
        },
        reason: '重算新基线命中防呆判定，未自动确认——请走异议流程人工核对',
      });
    }
    // 无实际变更且无待复核项 → 不产生空壳重算结果（契约 SubmitResultDto.recalc「值无变化时
    // 为 null」，评审修复轮 L1：原实现返回 {fields: []} 与注释不符）
    if (changed.length === 0 && needsReview.length === 0) return null;
    return { record_no: next.recordNo, fields: changed, needs_review: needsReview };
  }

  /**
   * 指定记录原提交时**已确认回退**的命中键集合（TK-16 评审二轮 L1）：从 `record.submit`
   * 审计 type=reading_decreased 行按当前版本反查，键 = shared `decreaseHitKey`（field:prev:
   * current 三元组）。重算链路仅消音**完全相同**的命中；基线变化的新命中照常标 needs_review
   * （字段级复用会让新基线下更大的回退被旧确认静默解锁，D-T20 M6 同族陷阱）。
   */
  private async confirmedDecreaseHitsOf(
    recordNo: string,
    version: number,
    executor: DbExecutor,
  ): Promise<ReadonlySet<string>> {
    const rows = await executor
      .select({ newValue: auditLogs.newValue })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'record.submit'), eq(auditLogs.targetId, recordNo)));
    const hits = new Set<string>();
    for (const r of rows) {
      const nv = r.newValue;
      if (nv && typeof nv === 'object' && 'type' in nv && 'version' in nv) {
        if (
          (nv as { type: unknown }).type === 'reading_decreased' &&
          Number((nv as { version: unknown }).version) === version
        ) {
          const nv2 = nv as unknown as { field: unknown; prev: unknown; current: unknown };
          const field = String(nv2.field);
          const prev = Number(nv2.prev);
          const current = Number(nv2.current);
          if (Number.isFinite(prev) && Number.isFinite(current)) {
            hits.add(decreaseHitKey(field as DecreasedGuardField, prev, current));
          }
        }
      }
    }
    return hits;
  }

  /**
   * 指定记录原提交时确认充气的卡集合（TK-16 重算的取数层延续，D-P14）：从 `record.submit`
   * 审计行的 type=gas_refill（confirmAudits 写入形态）按当前版本反查，供 gasDayUseOf 的
   * refilled 参数复用原提交的确认语义。
   */
  private async confirmedRefillCardsOf(
    recordNo: string,
    version: number,
    executor: DbExecutor, // 同上：无默认值，防事务内漏传退化静默旧读
  ): Promise<ReadonlySet<1 | 2>> {
    const rows = await executor
      .select({ newValue: auditLogs.newValue })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'record.submit'), eq(auditLogs.targetId, recordNo)));
    const cards = new Set<1 | 2>();
    for (const r of rows) {
      const nv = r.newValue;
      if (nv && typeof nv === 'object' && 'type' in nv && 'version' in nv) {
        if (
          (nv as { type: unknown }).type === 'gas_refill' &&
          Number((nv as { version: unknown }).version) === version
        ) {
          const card = Number((nv as unknown as { card: unknown }).card);
          if (card === 1 || card === 2) cards.add(card);
        }
      }
    }
    return cards;
  }

  /**
   * 电梯字典判定映射（TK-17，D-T22）：仅在 payload 携带核对项时加载。存在性以**全字典行**
   * 判定（含 retired——后台停用后撤回重提的既有核对仍可落库）；预期计算用行上
   * plan_type/windows（status 不改变运行计划语义）。返回 null = 电梯不存在。
   */
  private async elevatorPlanMapOf(): Promise<
    Map<number, { name: string; plan: ElevatorPlanLike }>
  > {
    const rows = await this.db.select().from(elevators);
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: r.name,
          plan: { plan_type: r.planType, windows: r.windows } satisfies ElevatorPlanLike,
        },
      ]),
    );
  }

  /**
   * 电梯核对结果校验（TK-17，D-T22）：shared `validateElevatorChecks` 纯校验（api 与 h5
   * 离线预检同源）+ 服务端按 check_time 重算 expected 的解析器——**ELE-05「提交时不重算」
   * 的实现口径 = 不按提交/重提时刻重算，预期恒按核对时刻（D-P16 字面）**，客户端 expected
   * 仅为展示留痕不落库。check_time 时钟分量非法时解析器返回 null（该校验项已在纯校验内
   * 先行 400 点名，此处仅防御性兑底）。
   */
  private async validateElevatorCheckPayload(input: unknown): Promise<
    ReturnType<typeof validateElevatorChecks> & {
      /** 电梯字典判定映射（alerts 标红文案需电梯名；payload 未携带核对项时为 null） */
      plans: Map<number, { name: string; plan: ElevatorPlanLike }> | null;
    }
  > {
    const plans = input == null ? null : await this.elevatorPlanMapOf();
    return {
      ...validateElevatorChecks(
        input,
        (id, checkTime) => {
          const entry = plans?.get(id);
          if (!entry) return null;
          const minutes = clockMinutesOf(checkTime.slice(11, 16));
          return minutes === null ? null : expectedStatusAt(entry.plan, minutes);
        },
        (id) => plans?.get(id)?.name ?? null,
      ),
      plans,
    };
  }

  /**
   * payload.sections → records 列值（TS 键）。职责边界：
   * - 字典外键忽略；派生列（lo_night_use 等非存储列）经 recordKeyOf 判定后不落库；
   * - 数值：parseNumeric（十进制字面量）复验后，decimal 列存字符串保精度、INT 列转 number；
   * - 枚举/状态：白名单越值 → outOfRange 点名（防 MySQL 500）；tank_in_use 转 number；
   * - 多选 hvac_locs：仅接受数组，JSON 列**原样数组落库**（DATA-07-T1；不做候选成员性校验，
   *   契约 §3.7——离线降级候选不得变 400）；
   * - 时间：lo_measured_am/pm 仅接受 `YYYY-MM-DD HH:mm:ss` 本地时间戳，**原样落库不覆盖**
   *   （DATA-13-T2/D-P12）；格式非法置 NULL（客户端时钟异常不拦截提交）；
   * - 停机强制清列（DATA-05/台账增补 #16）：boiler_run='stop' → 三项停机列强制 NULL
   *   （落库第二道防线：撤回重提/异议重提/离线重放时服务端旧值不因本机草稿为空而复活）；
   * - 用量列恒置 NULL（契约 §4 第 3 步不信任客户端传值；TK-13 计算引擎落地后在此固化）。
   */
  private normalizeSections(sections: Readonly<Partial<Record<RecordFieldName, unknown>>>): {
    values: Record<string, unknown>;
    outOfRange: MissingField[];
  } {
    const values: Record<string, unknown> = {};
    const outOfRange: MissingField[] = [];

    for (const [name, raw] of Object.entries(sections)) {
      const def = FIELD_BY_NAME[name as RecordFieldName];
      if (!def || !isFilledValue(raw)) continue;
      // 板块 0（基础信息）全部为记录级字段：duty_date/submitted_at/submitter_id 以服务端为准
      // （C-08/DATA-09；接收随 payload 上送也不得覆盖），receiver_id/receiver_change_reason
      // 由 submit 流程单独处理——payload sections 一律不落基础信息列
      if (def.section === 0) continue;
      const key = recordKeyOf(name, this.logger);
      if (!key) continue; // 派生列（lo_night_use）不落库

      if (def.kind === 'number') {
        const n = parseNumeric(raw);
        if (n === null) {
          outOfRange.push(toMissingField(name as RecordFieldName));
          continue;
        }
        values[key] = INT_COLUMNS.has(name as RecordFieldName) ? Math.trunc(n) : String(n);
      } else if (def.kind === 'enum' || def.kind === 'status') {
        const allowed = ENUM_VALUES[name as RecordFieldName];
        if (allowed && !allowed.includes(raw as string | number)) {
          outOfRange.push(toMissingField(name as RecordFieldName));
          continue;
        }
        values[key] = name === 'tank_in_use' ? Number(raw) : raw;
      } else if (def.kind === 'multi') {
        if (!Array.isArray(raw)) {
          outOfRange.push(toMissingField(name as RecordFieldName));
          continue;
        }
        values[key] = raw;
      } else if (def.kind === 'time') {
        const s = typeof raw === 'string' ? raw.trim() : '';
        // M3：分域正则 + 日历有效性（shared isValidLocalTimestamp），非法置 NULL 而非把垃圾送进 MySQL（500）
        values[key] = isValidLocalTimestamp(s) ? s : null;
      } else {
        values[key] = typeof raw === 'string' ? raw.trim() : raw;
      }
    }

    if (values['boilerRun'] === 'stop') {
      values['boilerNo'] = null;
      values['supplyTemp'] = null;
      values['returnTemp'] = null;
    }
    for (const key of SERVER_CALCULATED_KEYS) values[key] = null;

    return { values, outOfRange };
  }

  /** POST /records/today/preview（F1-10）：未填项与异常项汇总，结构与契约 §2 同构 */
  async preview(payload: SubmitPayloadDto): Promise<PreviewDto> {
    const { dutyDate } = await this.resolveDutyDate();
    const sections = (payload?.sections ?? {}) as Readonly<
      Partial<Record<RecordFieldName, unknown>>
    >;

    const result = this.validateForSubmit(sections);
    // 评审 L4：与 submit 同口径——normalize 的枚举/多选/长度越值在预览即点名，
    // 消除「预览全就绪、提交却 400」的不对称；并入 outOfRange 保持缺失优先选码
    result.outOfRange.push(...this.normalizeSections(sections).outOfRange);
    // 接班人修改原因条件必填（DATA-10；评审 M4 保守口径：无带出基线时显式指定亦视为修改）
    const scheduled = await this.scheduledReceiverOf(dutyDate);
    const receiverChanged =
      payload?.receiver_id != null && (scheduled === null || payload.receiver_id !== scheduled.id);
    if (receiverChanged && !isFilledValue(payload.receiver_change_reason)) {
      result.missing.push(toMissingField('receiver_change_reason'));
    }
    // 用量覆盖同口径预检（评审修复轮 M3）：与 submit 消费同一 validateUsageOverrides，
    // 消除「预览全就绪、提交却 400」的不对称（TK-12 评审 L4 同纪律）；不在此做上一班取数
    // 与计算（预览只读不落库，计算结果也不属未填/异常两张清单的范畴）
    const overrideCheck = this.validateUsageOverrides(payload?.usage_overrides);
    result.missing.push(...overrideCheck.missing);
    result.outOfRange.push(...overrideCheck.outOfRange);
    // 防呆确认项同口径预检（评审修复轮 M1）：超长原因/非数组在预览即点名
    const confirmCheck = this.validateConfirmations(payload?.confirmations);
    result.outOfRange.push(...confirmCheck.outOfRange);
    // 电梯核对同口径预检（TK-17，D-T22；M3/L4「预检即点名」纪律）：与 submit 消费同一
    // validateElevatorChecks——越值/重复/时刻非法在预览即点名，不一致未填说明进未填清单
    const elevatorCheck = await this.validateElevatorCheckPayload(payload?.elevator_checks);
    result.missing.push(...elevatorCheck.explanationMissing);
    result.outOfRange.push(...elevatorCheck.outOfRange);

    const body = buildValidationError(result);
    return {
      duty_date: dutyDate,
      missing_fields: body ? body.missing_fields : [],
      abnormal_fields: this.abnormalFieldsOf(sections),
    };
  }

  /**
   * POST /records/today/submit（契约 §4 提交协议；F2-01/DATA-09/10/13，含 TK-09/10/11 挂账复验）。
   *
   * 步骤对照契约 §4：① 必填/范围校验 → 400（C-09 结构，含用量覆盖/补录读数同口径预检，
   * 评审修复轮 M3 + TK-14）；② 防呆判定已随 TK-14 落地（F1-12 读数回退 / F1-13 充气，
   * 409 need_confirm 清单；confirmations 消费口径见下；排班安全阀 409 DUTY_MISMATCH 已随
   * TK-26 落地、置于防呆 409 之前，duty_guard_confirm 消费口径见「第 ② 步前置门」注）；
   * ③ 用量固化已随 TK-13 落地（服务端计算 + 覆盖协议，评审修复轮 L1 起在校验与 409 判定之后执行；
   * 上一班取数 = 相邻班次记录行或缺失态补录值，充气确认后的卡按 0 计 D-P14）；
   * ④ 标红确认行（alerts）已随 TK-17（电梯不一致）与 TK-18（状态异常、交接事项拆条）落地；
   * ⑤ 转 submitted、submitted_at=服务端收到时刻、
   * 生成 record_no；⑥ 写审计（record.submit + record.usage_override + 接班人修改原因留痕）。
   *
   * TK-16 起：提交主体抽为 submitCore（跨班次补交 backfill 同口径复用，dutyDate 由调用方
   * 决定，防两套提交口径漂移）。
   */
  async submit(user: SessionUser, payload: SubmitPayloadDto): Promise<SubmitResultDto> {
    const { dutyDate } = await this.resolveDutyDate();
    return this.submitCore(user, payload, dutyDate, { late: false });
  }

  /**
   * POST /records/backfill（TK-16，F3-08-T1 触发载体；决策记录 **D-T21**，2026-09-13 拍板）：
   * 上一班记录晚到（离线滞留单，被 D-T20 M1 挡在排空引擎外）的合法入库路径。
   * - duty_date 显式上送：日历合法且**严格早于当前班次日期**（当日/未来班次走 /today/submit）；
   * - 提交人恒为登录人本人（不代录他人；科长代录他人挂 TK-24 处置面板）；**登录人须与补交
   *   班次排班人一致（或经排班安全阀确认）**——TK-26 起 D-T21 挂账「补交班次排班归属校验，
   *   防冒名补交他人班次」以 DUTY_MISMATCH 同一出口闭环（F6-05）；
   * - 校验/防呆/覆盖/补录协议与 /today/submit 完全同口径（submitCore 单一实现）；
   * - 该班次已有任何记录（含 draft）→ 409 RECORD_EXISTS；
   * - 补交成功后**同事务**触发下游重算（F3-08：仅紧邻 D+1 已提交记录、手工覆盖豁免，
   *   见 recalcDownstreamInTx），响应带 recalc 结果，审计 record.late_submit + record.recalc。
   */
  async backfill(user: SessionUser, payload: BackfillPayloadDto): Promise<SubmitResultDto> {
    const { dutyDate: currentShift } = await this.resolveDutyDate();
    const raw = typeof payload?.duty_date === 'string' ? payload.duty_date.trim() : '';
    // 单次读取（评审二轮 m2）：原实现校验与错误文案各调一次，两次读取之间配置被修改
    // 会出现「按 7 天被拒、文案却说 30 天」的竞态
    const windowDays = await this.backfillWindowDays();
    const earliest = minusDays(currentShift, windowDays);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
      calendarDateOf(raw) !== raw ||
      raw >= currentShift ||
      raw < earliest // L3：无下限时可凭空补交 2000-01-01 并触发下游重算，污染 F6-06 与报表
    ) {
      throw new ApiException(
        'VALIDATION_OUT_OF_RANGE',
        `补交班次日期非法（仅限早于当前班次且在 ${windowDays} 天窗口内的历史班次）`,
        { missingFields: [toMissingField('duty_date')] },
      );
    }
    return this.submitCore(user, payload, raw, { late: true });
  }

  /**
   * 提交主体（在线提交与跨班次补交的单一实现，TK-16 抽取）：dutyDate 由调用方决定——
   * 在线提交恒为当前班次（C-08），补交为显式上送且早于当前班次的历史班次（D-T21）。
   */
  private async submitCore(
    user: SessionUser,
    payload: SubmitPayloadDto,
    dutyDate: string,
    opts: { late: boolean },
  ): Promise<SubmitResultDto> {
    const sections = (payload?.sections ?? {}) as Readonly<
      Partial<Record<RecordFieldName, unknown>>
    >;
    const scheduled = await this.scheduledReceiverOf(dutyDate);
    const reason =
      typeof payload?.receiver_change_reason === 'string'
        ? payload.receiver_change_reason.trim()
        : '';
    const receiverProvided = payload?.receiver_id != null;

    // 第 0 步（TK-12 评审修复轮 M4）：receiver_id 显式上送时**一律校验存在性**——原实现只在
    // 「修改」分支查，无次日排班基线时伪造 id 会绕过留痕直撞 FK（500）；有基线时提前拦也
    // 免得先报「原因缺失」掩盖真正的 id 错误。合法 id 的姓名缓存供审计与响应回显
    let receiverName: string | null = scheduled?.realName ?? null;
    if (receiverProvided) {
      const target = await this.db
        .select({ id: users.id, realName: users.realName })
        .from(users)
        .where(eq(users.id, payload.receiver_id as number))
        .limit(1);
      if (!target[0]) {
        throw new ApiException('VALIDATION_MISSING_FIELDS', '接班人不存在，请核对后重试', {
          missingFields: [toMissingField('receiver_id')],
        });
      }
      receiverName = target[0].realName;
    }

    // 接班人口径（DATA-10；评审 M4 定案的保守口径）：与次日排班带出值不同，**或无带出基线时
    // 显式指定**（由空改为有人同样是改），均视为修改 → 原因必填；省略 receiver_id = 自动带出
    const receiverChanged =
      receiverProvided && (scheduled === null || payload.receiver_id !== scheduled.id);

    // 第 1 步：必填/范围校验 → 400（C-09：逐条点名 + 锚点）。评审 L4：normalize 的枚举/多选
    // /长度越值并入同一张清单（原「预览全就绪、提交却 400」的不对称由此消除）；并入
    // outOfRange 让 buildValidationError 按「缺失优先」选码（纯越界仍报 VALIDATION_OUT_OF_RANGE）；
    // 原因超长走越界（FIELD_LENGTHS.receiver_change_reason，静态引擎不含 section 0）
    const result = this.validateForSubmit(sections);
    const { values, outOfRange } = this.normalizeSections(sections);
    result.outOfRange.push(...outOfRange);
    if (receiverChanged && reason === '') {
      result.missing.push(toMissingField('receiver_change_reason'));
    }
    if (reason.length > (FIELD_LENGTHS.receiver_change_reason ?? 200)) {
      result.outOfRange.push(toMissingField('receiver_change_reason'));
    }

    // 覆盖项纯校验先行（评审修复轮 M3/L1 拆分）：与 preview 同一函数、并入同一张 400 清单，
    // 且不依赖上一班取数——校验不通过就不白跑相邻班次查询与四类计算
    const overrideCheck = this.validateUsageOverrides(payload?.usage_overrides);
    result.missing.push(...overrideCheck.missing);
    result.outOfRange.push(...overrideCheck.outOfRange);
    // 补录上一班读数校验（TK-14，F3-07）：与用量覆盖同口径并入第 1 步 400 清单
    const backfillCheck = this.validatePrevBackfill(payload?.prev_readings);
    result.outOfRange.push(...backfillCheck.outOfRange);
    // 防呆确认项校验（评审修复轮 M1/M2）：与用量覆盖同口径预检（M3/L4 纪律），
    // 超长原因/非数组在第 1 步即 400 点名，不再带病走到第 2 步撞审计列容量
    const confirmCheck = this.validateConfirmations(payload?.confirmations);
    result.outOfRange.push(...confirmCheck.outOfRange);
    // 电梯核对校验（TK-17，ELE-04/06/07；D-T22）：与 preview 消费同一 validateElevatorChecks
    // 纯校验 + 服务端按 check_time 重算 expected 的解析器（plans 仅在有核对项时加载）；
    // 越值/重复/时刻非法/电梯不存在并入第 1 步 400 清单，说明缺失在防呆 409 之后单独 409
    const elevatorCheck = await this.validateElevatorCheckPayload(payload?.elevator_checks);
    result.outOfRange.push(...elevatorCheck.outOfRange);

    const body = buildValidationError(result);
    if (body) {
      throw new ApiException(body.code, body.message, {
        missingFields: [...body.missing_fields],
      });
    }

    // 当日唯一（F1-01）：已存在非 draft 行 → 409 RECORD_EXISTS；draft（撤回重提）→ 更新 + version+1
    const existingRows = await this.db
      .select({
        id: records.id,
        version: records.version,
        status: records.status,
        submitterId: records.submitterId,
      })
      .from(records)
      .where(eq(records.dutyDate, dutyDate))
      .limit(1);
    const existing = existingRows[0];
    // 当日唯一（F1-01）：**两条链路均**只对非 draft 行 409；draft 行走下方「更新 + version+1」
    // 分支。补交接管 draft 行（评审修复轮 L5，2026-09-14 拍板）：原补交对任何已存在行一律 409，
    // 与「submit 只认当前班次」合起来构成死角——D 日提交 → 撤回（TK-21 产生 draft）→ 师傅离院
    // 未重提 → 之后再无任何路径能让 D 日入库（补交 409、submit 只能建 D+1），该日永停在 draft、
    // 用量永不固化、F6-06 误报漏交。晚到入库与撤回重提在此同一出口，语义不冲突（D-T21 修订）。
    if (existing && existing.status !== 'draft') {
      throw new ApiException(
        'RECORD_EXISTS',
        opts.late ? '该班次记录已存在，不可重复补交' : '当日记录已提交，不可重复提交',
      );
    }

    // 第 ② 步前置门（TK-26，F6-05 排班安全阀；决策记录 D-T26）：登录提交人 ≠ 该班次排班人
    // → 409 DUTY_MISMATCH，客户端确认实际当班后随 payload.duty_guard_confirm 重提放行。
    // 置于防呆 409 之前——身份对账先于业务防呆（先解决「谁在提交」，再解决「读数对不对」，
    // 与「未登录 401 先于 403」同族门序）；补交链路同门（D-T21 挂账「补交班次排班归属校验，
    // 防冒名补交他人班次」的出口）。排班缺失不判定（无可比基线，同防呆缺失态放行精神）；
    // 提交链路角色列 master（chief 无此门——无提交权，403 已在前）。确认消费口径：
    // `duty_guard_confirm.confirmed === true` 是唯一解锁（拒绝确认/未确认/畸形一律再 409，
    // F6-05-T2）；reason 选填（demo 口径确认即留痕），仅命中的本次提交写审计 record.guard_confirm；
    // 排班与登录人一致时该字段被忽略（不写审计，同「未命中确认不入账」口径）。
    const scheduledDuty = await this.scheduledDutyOf(dutyDate);
    const guardMismatch = scheduledDuty !== null && scheduledDuty.id !== user.id;
    if (guardMismatch && payload?.duty_guard_confirm?.confirmed !== true) {
      const guardMessage = opts.late
        ? `${dutyDate} 班次排班为${scheduledDuty.realName}，您以 ${user.realName} 身份补交，请确认实际当班`
        : `今日排班为${scheduledDuty.realName}，您以 ${user.realName} 身份提交，请确认实际当班`;
      throw new ApiException('DUTY_MISMATCH', guardMessage, {
        needConfirm: [
          {
            type: 'duty_guard',
            scheduled_name: scheduledDuty.realName,
            message: guardMessage,
          },
        ],
      });
    }
    const guardReason =
      typeof payload?.duty_guard_confirm?.reason === 'string'
        ? payload.duty_guard_confirm.reason.trim()
        : '';

    // 第 ② 步（TK-14，契约 §4 防呆判定）：上一班取数与 GET /prev 同源（adjacentPrevRow，D-T17）；
    // 相邻班次缺失时补录值（F3-07，已过 validatePrevBackfill）成为比对与计算基线——仅**非首班的
    // 缺失态**消费（D-T19）：首班（first_day）无缺失语境，补录值忽略
    const prevRow = await this.adjacentPrevRow(dutyDate);
    let backfill: Partial<Record<PrevBackfillField, number>> | null = null;
    if (prevRow === null && Object.keys(backfillCheck.readings).length > 0) {
      const anyEarlier = await this.db
        .select({ id: records.id })
        .from(records)
        .where(lt(records.dutyDate, dutyDate))
        .limit(1);
      if (anyEarlier.length > 0) backfill = backfillCheck.readings;
    }
    const prevGet: FieldValueGetter = prevRow
      ? (name) => {
          const key = recordKeyOf(name, this.logger);
          return key ? ((prevRow[key as keyof typeof prevRow] as unknown) ?? null) : null;
        }
      : (name) => backfill?.[name as PrevBackfillField] ?? null;

    // 防呆判定（F1-12/F1-13，shared guard.ts 三端同源纯函数）：确认以归一后的 confirmCheck
    // 为准（超长原因/非数组已在第 1 步 400 点名）；空白原因项已在归一时剔除（与未上送
    // 同待，F1-12-T2「重试不放行」）；与命中项对不上号的确认在下方 filter 中不消费
    // （防张冠李戴的确认解锁别的防呆项）
    const confirmedDecrease = new Map<DecreasedGuardField, string>();
    const confirmedRefill = new Map<1 | 2, string>();
    for (const c of confirmCheck.normalized) {
      if (c.type === 'reading_decreased') {
        if (!confirmedDecrease.has(c.field)) confirmedDecrease.set(c.field, c.reason);
      } else if (!confirmedRefill.has(c.card)) {
        confirmedRefill.set(c.card, c.reason);
      }
    }
    const cur: FieldValueGetter = (name) => sections[name] ?? null;
    const decreased = decreasedReadingsOf(cur, prevGet);
    const refills = refillCardsOf(cur, prevGet);
    // 需确认清单组装下沉 shared（TK-15：h5 离线提交预检与 api 同源，判定范围与文案单一权威实现）；
    // decreased/refills 本身仍供下方确认留痕清单与充气取数层（refilled）消费
    const needConfirm = unconfirmedNeedConfirmItems(
      cur,
      prevGet,
      new Set(confirmedDecrease.keys()),
      new Set(confirmedRefill.keys()),
    );
    if (needConfirm.length > 0) {
      // code 选择口径（契约订正 15）：回退与充气同时命中时 READINGS_DECREASED 优先
      const hasDecreased = needConfirm.some((c) => c.type === 'reading_decreased');
      throw new ApiException(
        hasDecreased ? 'READINGS_DECREASED' : 'GAS_REFILL_CONFIRMED',
        '存在异常读数，请逐条确认后重新提交',
        { needConfirm },
      );
    }
    // 电梯不一致未填说明（TK-17，ELE-04-T2/ELE-07-T1）：409 ELEVATOR_EXPLANATION_REQUIRED，
    // 逐台以 `elevator:{id}` 点名（C-09 电梯点名形态，契约 §2；明细落 elevator_checks 逐台
    // 一行、records 无对应列）——置于防呆 409 之后（契约 §4 第 2 步判定先于电梯说明缺失暴露，
    // 同为 409 族；合法 payload 才走到这里，不会掩盖第 1 步的 400 点名）
    if (elevatorCheck.explanationMissing.length > 0) {
      throw new ApiException(
        'ELEVATOR_EXPLANATION_REQUIRED',
        '电梯核对与预期不一致，请逐台填写说明后重新提交',
        { missingFields: elevatorCheck.explanationMissing },
      );
    }
    // 确认留痕清单（契约 §5「record.submit + 各确认原因」）：仅**命中项**的确认入账——
    // 对未命中字段的确认不写审计（确认与防呆项一一对应，多行失真同覆盖重复项 L4 纪律）
    const confirmAudits = [
      ...decreased.map((d) => ({
        type: 'reading_decreased' as const,
        field: d.field as string,
        card: null as 1 | 2 | null,
        prev: d.prev,
        current: d.current,
        reason: confirmedDecrease.get(d.field) ?? '',
      })),
      ...refills.map((r) => ({
        type: 'gas_refill' as const,
        field: GAS_CARD_FIELDS[r.card] as string,
        card: r.card as 1 | 2 | null,
        prev: r.prev,
        current: r.current,
        reason: confirmedRefill.get(r.card) ?? '',
      })),
    ];

    // 第 ③ 步（TK-13，契约 §4；评审修复轮 L1：移到校验/409 判定之后，无效与重复提交不白跑）：
    // 用量由服务端计算固化；确认充气的卡经 refilled 按 0 计（D-P14，TK-14 确认后的取数层）；
    // 手工覆盖（F3-04/F3-06，已过 validateUsageOverrides）在计算值之上改写。
    const refilled = new Set<1 | 2>(
      [...confirmedRefill.keys()].filter((card) => refills.some((r) => r.card === card)),
    );
    const usage = this.computeUsageValues(cur, prevGet, refilled);
    const overrides = this.applyUsageOverrides(overrideCheck.valid, usage.auto);
    Object.assign(usage.values, overrides.values);

    const receiverId = receiverChanged
      ? (payload.receiver_id as number)
      : (scheduled?.id ?? (receiverProvided ? (payload.receiver_id as number) : null));
    const recordNo = recordNoOf(dutyDate);
    const submittedAt = localMeasuredAt(); // DATA-09：服务端收到时刻（离线场景下即同步成功时刻）
    const version = existing ? existing.version + 1 : 1;

    // 第 ⑤⑥ 步同事务：记录行（新建或撤回重提更新）+ 审计（补交再加晚到留痕与下游重算）
    let recalc: SubmitResultDto['recalc'] = null;
    const saved = await this.db
      .transaction(async (tx) => {
        let recordId: number;
        if (existing) {
          await tx
            .update(records)
            // 快照写 NULL（评审 M5）：字典存储列未上送的一律清空，撤回重提不残留服务端旧值；
            // 提交人/接班人/状态/时刻/版本等记录级字段在后续键显式覆盖
            .set({
              ...SNAPSHOT_NULL_DEFAULTS,
              ...values,
              ...usage.values,
              submitterId: user.id,
              receiverId,
              receiverChangeReason: receiverChanged ? reason : null,
              status: 'submitted',
              submittedAt,
              version,
            })
            .where(eq(records.id, existing.id));
          recordId = existing.id;
        } else {
          const inserted = await tx.insert(records).values({
            recordNo,
            dutyDate,
            submitterId: user.id,
            receiverId,
            receiverChangeReason: receiverChanged ? reason : null,
            status: 'submitted',
            submittedAt,
            version,
            ...values,
            ...usage.values,
          });
          recordId = inserted[0].insertId;
        }

        // 电梯核对明细与标红（TK-17，D-T22）：快照语义——重提（撤回/补交接管 draft）先清后插，
        // 核对以本次提交为准；expected 为服务端按 check_time 重算值（ELE-05「锁定核对时刻」：
        // 提交/重提时刻不参与计算，D-P16）；任一不一致写 alerts 标红行（ELE-06，level=mid：
        // Phase 1 标红 + 必填说明，P2 转中预警推送；契约 §4 第 4 步「电梯不一致」）。
        // 核对不强制：未上送或空数组 = 本班次未核对，无明细行也无标红（追责载体为逐条知晓）
        // L3（评审修复轮）：alerts 与明细行**同一快照语义**——原只清 elevator_checks，重提时
        // 旧标红行会累积（同一条不一致重复入行、已不成立的旧项残留），接班人逐条知晓（TK-19）
        // 会看到重复/过期标红项。标红确认行由本提交事务生成（契约 §4 第 4 步），故重建也在此：
        // 后续若新增其它来源的 alerts 写入方，需按其主权环节同步调整本处范围
        await tx.delete(elevatorChecks).where(eq(elevatorChecks.recordId, recordId));
        await tx.delete(alerts).where(eq(alerts.recordId, recordId));
        for (const c of elevatorCheck.valid) {
          await tx.insert(elevatorChecks).values({
            recordId,
            elevatorId: c.elevator_id,
            checkTime: c.check_time,
            expected: c.expected,
            actual: c.actual,
            explanation: c.explanation,
          });
          if (isMismatchOf(c.actual)) {
            const name = elevatorCheck.plans?.get(c.elevator_id)?.name ?? `电梯#${c.elevator_id}`;
            const message =
              `${name} 预期${elevatorExpectedLabel(c.expected)}、实际${elevatorActualLabel(c.actual)}` +
              (c.explanation ? `：${c.explanation}` : '');
            await tx.insert(alerts).values({
              recordId,
              ruleKey: 'elevator_mismatch',
              target: `elevator:${c.elevator_id}`,
              level: ELEVATOR_ALERT_LEVEL,
              message: message.slice(0, 300),
            });
          }
        }

        // 状态异常标红行 + 交接事项拆条（TK-18 落地、TK-20 抽取为 insertStatusAndHandoverAlertsInTx
        // 供 resubmit 复用——rule_key/target 形态与种子 D-1 配套标红行同形，
        // `{field}_bad` / `field:{field}`、level=high/low；快照语义：上方已整单清空 alerts，
        // 撤回/异议重提按本次提交重建，旧标红不残留）
        await this.insertStatusAndHandoverAlertsInTx(tx, recordId, values);

        // 审计（契约 §5：action=record.submit；接班人修改原因记 reason 列，DATA-10 留痕）
        await tx.insert(auditLogs).values({
          actorId: user.id,
          action: 'record.submit',
          targetType: 'record',
          targetId: recordNo,
          reason: receiverChanged
            ? `接班人改为 ${receiverName ?? payload.receiver_id}：${reason}`
            : null,
          newValue: { receiver_id: receiverId, receiver_changed: receiverChanged, version },
        });

        // 用量覆盖留痕（F3-04-T2/F3-06）：逐覆盖项一行，原因记 reason 列（技术方案 §5.5），
        // oldValue 记覆盖前服务端算出的自动值——留痕即 F3-06-T1「人工值」标识的数据源，
        // 亦为 TK-16 重算豁免（师傅手工覆盖过的值不被重算覆盖）的判定依据
        for (const o of overrides.applied) {
          await tx.insert(auditLogs).values({
            actorId: user.id,
            action: 'record.usage_override',
            targetType: 'record',
            targetId: recordNo,
            oldValue: { field: o.field, auto_value: o.auto },
            newValue: { field: o.field, value: o.value, version },
            reason: o.reason,
          });
        }

        // 防呆确认留痕（TK-14，契约 §5「record.submit + 各确认原因」）：逐确认项一行，
        // 原因记 reason 列，newValue 记命中项的上一班/本次值与版本（复核口径：确认的是
        // 「当时看到什么」；仅命中项入账，confirmAudits 构造处已过滤未命中的确认）
        for (const c of confirmAudits) {
          await tx.insert(auditLogs).values({
            actorId: user.id,
            action: 'record.submit',
            targetType: 'record',
            targetId: recordNo,
            newValue:
              c.card === null
                ? { type: c.type, field: c.field, prev: c.prev, current: c.current, version }
                : { type: c.type, card: c.card, prev: c.prev, current: c.current, version },
            reason: c.reason,
          });
        }

        // 排班安全阀留痕（TK-26，F6-05「确认后方可提交并留痕」；契约 §5 record.guard_confirm）：
        // 仅**命中**（登录人 ≠ 该班次排班人且确认放行）的本次提交写入一行——oldValue 记
        // 排班基线、newValue 记实际提交人（对账两端的姓名/id 齐备，demo「身份对账」行同源），
        // reason 携调班说明（选填，空白置 null）
        if (guardMismatch) {
          await tx.insert(auditLogs).values({
            actorId: user.id,
            action: 'record.guard_confirm',
            targetType: 'record',
            targetId: recordNo,
            oldValue: { user_id: scheduledDuty!.id, real_name: scheduledDuty!.realName },
            newValue: { user_id: user.id, real_name: user.realName, version },
            reason: guardReason !== '' ? guardReason : null,
          });
        }

        // 补录留痕（TK-14，F3-07/D-T19）：补录读数不落 records 列（缺失班次不建行，
        // F6-06 漏交检测不受影响），审计存全量补录值供台账与双轨比对核对
        if (backfill) {
          await tx.insert(auditLogs).values({
            actorId: user.id,
            action: 'record.prev_backfill',
            targetType: 'record',
            targetId: recordNo,
            newValue: { readings: backfill, version },
          });
        }

        // 晚到补交留痕与下游重算（TK-16/F3-08，D-T21）：补交本体即 record.submit（上方），
        // 本行补记晚到语境；F6-06 漏交检测以 records 行存在为准，该日自此不再计漏交。
        // 重算在同事务内执行——补交行与下游重算同生共死，防「补交成功、重算失败」半态
        if (opts.late) {
          await tx.insert(auditLogs).values({
            actorId: user.id,
            action: 'record.late_submit',
            targetType: 'record',
            targetId: recordNo,
            newValue: {
              duty_date: dutyDate,
              version,
              // draft 接管（L5）：显式记接管前的提交人，归属变更 A→B 不靠两条审计的 actor 间接推断
              ...(existing ? { prev_submitter_id: existing.submitterId } : {}),
            },
            reason: '上一班记录晚到，跨班次补交',
          });
          recalc = await this.recalcDownstreamInTx(
            tx,
            dutyDate,
            values,
            user.id,
            recordNo,
            'late_backfill',
          );
        }
        return recordId;
      })
      // 1062→409 归一（TK-16 挂账闭环，契约订正 18 ⑧）：existing 预检与 INSERT 之间的
      // 并发窗口撞 duty_date/record_no UNIQUE（MySQL 1062 → 500），按 RECORD_EXISTS
      // 409 语义归一（与 recalc 下游行锁同批补齐）
      .catch((e: unknown) => {
        if (isDuplicateEntryError(e)) {
          throw new ApiException(
            'RECORD_EXISTS',
            opts.late ? '该班次记录已存在，不可重复补交' : '当日记录已提交，不可重复提交',
          );
        }
        throw e;
      });

    return {
      id: saved,
      record_no: recordNo,
      status: 'submitted',
      version,
      submitted_at: submittedAt,
      receiver:
        receiverId != null
          ? { id: receiverId, real_name: receiverName ?? String(receiverId) }
          : null,
      receiver_changed: receiverChanged,
      // 仅补交响应携带重算结果（在线提交无重算语义，缺省不传，契约 SubmitResultDto.recalc）
      ...(opts.late ? { recalc } : {}),
    };
  }

  /**
   * 组装 12 张任务卡（F1-02）。
   *
   * **点位存在性与顺序由 spots 表驱动**（status='active'，sort_no 升序），卡片→字段映射取自
   * shared `cards.ts`。两侧对不上时不出卡并记日志：后台新增点位（F6-07）而未回补字典 → 警告；
   * 字典有点位而 spots 表已停用/删除 → 提示。这样 12 这个数字随字典编译期锁定（CARD_COUNT），
   * 而实际出卡数跟随后台字典，两者不一致时有日志可循。
   */
  private buildCards(
    spotRows: ReadonlyArray<{ id: number; name: string; sortNo: number }>,
    recordRow: Record<string, unknown> | undefined,
    manualFields: ReadonlySet<string> = new Set<string>(),
  ): CardDto[] {
    const cards: CardDto[] = [];
    const matched = new Set<string>();

    for (const spot of spotRows) {
      const defs = TASK_CARDS.filter((c) => c.spotName === spot.name);
      if (defs.length === 0) {
        this.logger.warn(
          `点位「${spot.name}」(sort_no=${spot.sortNo}) 在 shared cards 字典中无卡片映射，本次不出卡；` +
            `若为后台新增点位（F6-07），请回补 packages/shared/src/cards.ts`,
        );
        continue;
      }
      matched.add(spot.name);
      for (const def of defs) {
        cards.push(this.buildCard(def, spot, recordRow, manualFields));
      }
    }

    for (const def of TASK_CARDS) {
      if (!matched.has(def.spotName)) {
        this.logger.warn(
          `卡片「${def.title}${def.slotLabel ? ` ${def.slotLabel}` : ''}」对应的点位「${def.spotName}」` +
            `不在 spots 表（或已停用），本次不出卡`,
        );
      }
    }
    return cards;
  }

  /** 单张卡：字段状态 → 角标（F1-03） */
  private buildCard(
    def: CardDef,
    spot: { id: number; name: string; sortNo: number },
    recordRow: Record<string, unknown> | undefined,
    manualFields: ReadonlySet<string>,
  ): CardDto {
    // 动态必填的取值函数：从 records 行按字段名取值（未存列/无记录 → null）
    const getValue: FieldValueGetter = (fieldName) => {
      const key = recordKeyOf(fieldName, this.logger);
      return key ? (recordRow?.[key] ?? null) : null;
    };

    const fields: CardFieldStateDto[] = def.fields.map((name) => {
      const value = getValue(name);
      return {
        name,
        // 动态必填（TK-06）：条件必填按已填值触发（备注看状态是否 'bad'、锅炉三项看 boiler_run），
        // 分母随之动态化——师傅填完该填的进度条即可到 100%（F1-03-T1）。判定函数与 h5 同源（shared cards.ts）。
        required: isRequiredField(name, getValue),
        filled: isFilledValue(value),
        abnormal: isAbnormal(name, value),
        value,
        // 用量字段被师傅手工覆盖时标人工值（F3-06-T1）；其余字段恒 undefined（自动）
        manual: manualFields.has(name) || undefined,
      };
    });

    // 角标分母只数 required 字段：未触发的条件必填（异常备注、停机时的锅炉三项）不计入，
    // 否则师傅填完该填的进度条也到不了 100%，违反 F1-03-T1「计数与实际一致」。口径见 cards.ts isRequiredField。
    // 电梯卡（TK-17）无 records 字段：不把逐台核对计入分母——D-T16 分母口径为**字段维度**
    // （fill ∈ manual/select 且非条件必填/选填），改动须先修决策；电梯卡维持 0/0 的「待核对」态
    // （TaskCard），客户端首页以草稿核对项判定「已填」（TodayView anyFilledOf），不进度条分母
    const countable = fields.filter((f) => f.required);
    const filled = countable.filter((f) => f.filled).length;
    const abnormal = fields.filter((f) => f.abnormal).length;

    return {
      key: def.key,
      spot_id: spot.id,
      spot_name: spot.name,
      sort_no: spot.sortNo,
      title: def.title,
      slot: def.slot,
      slot_label: def.slotLabel,
      section: def.sections[0] as SectionNo,
      section_label: SECTION_BY_NO[def.sections[0] as SectionNo].label,
      sections: [...def.sections],
      kind: def.kind,
      badge: { filled, total: countable.length, pending: countable.length - filled, abnormal },
      fields,
    };
  }
}

/** 角标求和（顶部进度条 = 12 张卡角标之和） */
function sumBadges(badges: readonly BadgeDto[]): BadgeDto {
  return badges.reduce<BadgeDto>(
    (acc, b) => ({
      filled: acc.filled + b.filled,
      total: acc.total + b.total,
      pending: acc.pending + b.pending,
      abnormal: acc.abnormal + b.abnormal,
    }),
    { filled: 0, total: 0, pending: 0, abnormal: 0 },
  );
}

/**
 * 按板块聚合角标（契约 §3.2「各板块填写状态」）。
 *
 * 按**字段真实板块号**（`FIELD_BY_NAME[name].section`）而非卡片归属累加：值班室卡兼管板块八，
 * `energy_note` 须计入板块八而不是板块十，汇总才能与附录 A 的十板块一一对应。
 * 板块四拆液氧站 8:30/20:30 与瓶库三张卡、板块五拆锅炉房与制冷机房两张卡，故此处为**聚合**视角。
 *
 * 先按卡片的 sections 置入空角标，保证**有卡但无 records 字段**的板块也出现在汇总里：
 * 板块九（电梯）走 elevator_checks 逐台核对，字段清单为空，但板块必须可见（total=0）。
 * 板块 0（基础信息）不属巡检卡，故不在汇总内。
 */
function aggregateSections(cards: readonly CardDto[]): SectionStateDto[] {
  const byNo = new Map<SectionNo, BadgeDto>();
  for (const card of cards) {
    for (const no of card.sections) {
      if (!byNo.has(no)) byNo.set(no, emptyBadge());
    }
    for (const field of card.fields) {
      const no = FIELD_BY_NAME[field.name as RecordFieldName].section;
      const acc = byNo.get(no) ?? emptyBadge();
      byNo.set(no, {
        filled: acc.filled + (field.required && field.filled ? 1 : 0),
        total: acc.total + (field.required ? 1 : 0),
        pending: acc.pending + (field.required && !field.filled ? 1 : 0),
        abnormal: acc.abnormal + (field.abnormal ? 1 : 0),
      });
    }
  }
  return [...byNo.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([no, badge]) => ({
      no,
      key: SECTION_BY_NO[no].key,
      label: SECTION_BY_NO[no].label,
      badge,
    }));
}

function emptyBadge(): BadgeDto {
  return { filled: 0, total: 0, pending: 0, abnormal: 0 };
}
