import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq, lt } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import {
  FIELDS,
  FIELD_BY_NAME,
  FIELD_LENGTHS,
  FIELD_NAMES,
  SECTION_BY_NO,
  TASK_CARDS,
  buildValidationError,
  isFilledValue,
  isRequiredField,
  localMeasuredAt,
  parseNumeric,
  toMissingField,
  validateFields,
  type BadgeDto,
  type CardDef,
  type CardDto,
  type CardFieldStateDto,
  type FieldValueGetter,
  type MissingField,
  type PrevDto,
  type PrevRecordDto,
  type PreviewDto,
  type RecordFieldName,
  type SectionNo,
  type SectionStateDto,
  type SubmitPayloadDto,
  type SubmitResultDto,
  type TodayDto,
} from '@handover/shared';
import type { SessionUser } from '../auth/auth.service';
import { ApiException } from '../common/api-error';
import { DB, type Db } from '../db/db.module';
import { auditLogs, configs, records, schedules, spots, users } from '../db/schema';
import { DEFAULT_SHIFT_START, minusOneDay, plusOneDay, shiftDutyDate } from './duty-date';

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

/** 本地时间戳字面量格式（DATA-13 测量时刻随 payload 上送的形态，calc.ts localMeasuredAt）；
 * 分域捕获组（TK-12 评审修复轮 M3：原 \d 宽松正则放过 '2026-13-45 99:99:99'，MySQL 拒绝 → 500） */
const MEASURED_AT_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;

/**
 * 测量时刻合法性（TK-12 评审修复轮 M3）：分域正则 + **日历有效性**（Date 构造往返比对，
 * 拦住 02-30、04-31 等分域正则拦不住的非法日期）。非法值置 NULL（不拦提交、不覆盖为
 * 服务端时刻——本机时刻是唯一权威，无效即无从记录，D-P12）。
 */
function isValidMeasuredAt(s: string): boolean {
  const g = MEASURED_AT_PATTERN.exec(s);
  if (!g) return false;
  // noUncheckedIndexedAccess 下捕获组为 string|undefined；正则命中时组必存在，?? NaN 仅安抚类型
  const num = (v: string | undefined): number => Number(v ?? NaN);
  const y = num(g[1]);
  const mo = num(g[2]);
  const d = num(g[3]);
  const h = num(g[4]);
  const mi = num(g[5]);
  const sec = num(g[6]);
  const date = new Date(y, mo - 1, d, h, mi, sec);
  return (
    date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi &&
    date.getSeconds() === sec
  );
}

/**
 * record_no 生成（TK-12 评审修复轮 L5 抽为纯函数供黄金值哨兵）：格式钉死自技术方案 §4.2
 * DDL 注释原文示例 'HB-20260827-001'；duty_date 唯一（F1-01）→ 每班次恒 -001。
 */
export function recordNoOf(dutyDate: string): string {
  return `HB-${dutyDate.replaceAll('-', '')}-001`;
}

/** 用量列（契约 §4 第 3 步：服务端计算固化、客户端传值不信任）——TK-13 计算引擎落地前先置 NULL */
const SERVER_CALCULATED_KEYS = ['waterUse', 'eUse', 'gasUse', 'loDayUse'] as const;

/** records 表的 DB 列名集合（用于识别字典里的派生字段，如 lo_night_use 非存储列） */
const RECORD_DB_COLUMNS: ReadonlySet<string> = new Set(
  getTableConfig(records).columns.map((c) => c.name),
);

/** records 表对象的 TS 属性名集合（camelCase） */
const RECORD_TS_KEYS: ReadonlySet<string> = new Set(Object.keys(records));

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

  /** GET /records/today 的完整响应 */
  async today(user: SessionUser, now: Date = new Date()): Promise<TodayDto> {
    const { dutyDate, shiftStart } = await this.resolveDutyDate(now);

    // 三路并发取数：当日记录、点位字典（卡片由它驱动）、次日排班（接班人带出，F2-01/DATA-10）
    const [recordRows, spotRows, scheduled] = await Promise.all([
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
    ]);

    const recordRow = recordRows[0]?.row;
    const cards = this.buildCards(spotRows, recordRow);
    const progress = sumBadges(cards.map((c) => c.badge));
    const sections = aggregateSections(cards);

    return {
      duty_date: dutyDate,
      shift_start_time: shiftStart,
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

    // D-T17（TK-07 评审定案）：「上一班」= **相邻班次**的记录——duty_date 恰为今日班次日期 − 1 天
    // （日历事实，复用 duty-date.ts 的 minusOneDay，勿另写日历推算）。相邻日无行（漏交，F6-06
    // 检测的场景）或该行为 draft（上一班未提交）→ 上一班缺失（F3-07，前端显"—"并允许补录），
    // **不回落更早记录**——以旧值冒充上一班违反 F1-05-T2 判据「不显示脏数据」，且 TK-13 复用
    // 同一取数时会把跨天用量当 1 天固化。首班（F1-15）= 今日之前无任何记录。
    const prevDate = minusOneDay(dutyDate);
    const [adjacentRows, anyEarlier] = await Promise.all([
      this.db.select({ row: records }).from(records).where(eq(records.dutyDate, prevDate)).limit(1),
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
    const adjacent = adjacentRows[0]?.row;
    if (!adjacent || adjacent.status === 'draft') {
      // F1-05-T2 / F3-07：相邻班次无已提交记录（漏交或未提交）→ 缺失态（非首班）：
      // 草稿值不作为带出数据源，也不跳过缺失班次回落更早记录
      return { duty_date: dutyDate, first_day: false, prev: null };
    }
    return { duty_date: dutyDate, first_day: false, prev: this.toPrevRecord(adjacent) };
  }

  /**
   * records 行 → 上一班带出体（dto.ts PrevRecordDto）：readings 仅回传字段字典内的
   * records 存储列（板块 ≥1）——基础信息列在记录级字段已回显，lo_night_use 等派生列
   * 非存储列。字典与 schema 漂移时经 recordKeyOf 记错误日志而非静默丢字段。
   */
  private toPrevRecord(row: typeof records.$inferSelect): PrevRecordDto {
    const readings: Record<string, unknown> = {};
    for (const def of FIELDS) {
      if (def.section === 0) continue; // 基础信息（duty_date/submitted_at 等）走记录级字段
      const key = recordKeyOf(def.name, this.logger);
      if (!key) continue;
      readings[def.name] = row[key as keyof typeof row] ?? null;
    }
    return {
      duty_date: row.dutyDate,
      record_no: row.recordNo,
      status: row.status,
      submitted_at: row.submittedAt,
      version: row.version,
      readings,
    };
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
        // M3：分域正则 + 日历有效性（isValidMeasuredAt），非法置 NULL 而非把垃圾送进 MySQL（500）
        values[key] = isValidMeasuredAt(s) ? s : null;
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
   * 步骤对照契约 §4：① 必填/范围校验 → 400（C-09 结构）；② 防呆判定随 TK-14 接入
   * （confirmations/duty_guard_confirm 本阶段仅接收不判定）；③ 用量固化随 TK-13（先置 NULL）；
   * ④ 标红确认行（alerts）随 TK-17/TK-22 落地；⑤ 转 submitted、submitted_at=服务端收到时刻、
   * 生成 record_no；⑥ 写审计（record.submit + 接班人修改原因留痕）。
   */
  async submit(user: SessionUser, payload: SubmitPayloadDto): Promise<SubmitResultDto> {
    const { dutyDate } = await this.resolveDutyDate();
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
    const body = buildValidationError(result);
    if (body) {
      throw new ApiException(body.code, body.message, {
        missingFields: [...body.missing_fields],
      });
    }

    // 当日唯一（F1-01）：已存在非 draft 行 → 409 RECORD_EXISTS；draft（撤回重提）→ 更新 + version+1
    const existingRows = await this.db
      .select({ id: records.id, version: records.version, status: records.status })
      .from(records)
      .where(eq(records.dutyDate, dutyDate))
      .limit(1);
    const existing = existingRows[0];
    if (existing && existing.status !== 'draft') {
      throw new ApiException('RECORD_EXISTS', '当日记录已提交，不可重复提交');
    }

    const receiverId = receiverChanged
      ? (payload.receiver_id as number)
      : (scheduled?.id ?? (receiverProvided ? (payload.receiver_id as number) : null));
    const recordNo = recordNoOf(dutyDate);
    const submittedAt = localMeasuredAt(); // DATA-09：服务端收到时刻（离线场景下即同步成功时刻）
    const version = existing ? existing.version + 1 : 1;

    // 第 ⑤⑥ 步同事务：记录行（新建或撤回重提更新）+ 审计
    const saved = await this.db.transaction(async (tx) => {
      let recordId: number;
      if (existing) {
        await tx
          .update(records)
          // 快照写 NULL（评审 M5）：字典存储列未上送的一律清空，撤回重提不残留服务端旧值；
          // 提交人/接班人/状态/时刻/版本等记录级字段在后续键显式覆盖
          .set({
            ...SNAPSHOT_NULL_DEFAULTS,
            ...values,
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
        });
        recordId = inserted[0].insertId;
      }

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
      return recordId;
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
        cards.push(this.buildCard(def, spot, recordRow));
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
      };
    });

    // 角标分母只数 required 字段：未触发的条件必填（异常备注、停机时的锅炉三项）不计入，
    // 否则师傅填完该填的进度条也到不了 100%，违反 F1-03-T1「计数与实际一致」。口径见 cards.ts isRequiredField。
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
