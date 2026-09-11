import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq, lt } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import {
  FIELDS,
  FIELD_BY_NAME,
  SECTION_BY_NO,
  TASK_CARDS,
  isFilledValue,
  isRequiredField,
  type BadgeDto,
  type CardDef,
  type CardDto,
  type CardFieldStateDto,
  type FieldValueGetter,
  type PrevDto,
  type PrevRecordDto,
  type RecordFieldName,
  type SectionNo,
  type SectionStateDto,
  type TodayDto,
} from '@handover/shared';
import type { SessionUser } from '../auth/auth.service';
import { DB, type Db } from '../db/db.module';
import { configs, records, spots } from '../db/schema';
import { DEFAULT_SHIFT_START, minusOneDay, shiftDutyDate } from './duty-date';

/** 状态类字段取此值即为"异常"（PRD §6.2：Phase 1 无独立预警，"预警项"指表单级标红项；与 cards.ts STATUS_BAD 同口径） */
const ABNORMAL_STATUS = 'bad';

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
 * GET 建行会污染 records=10 的计数口径。draft 行的产生留给 TK-08（PUT /records/today/draft）。
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

    // 两路并发取数：当日记录、点位字典（卡片由它驱动）；当日排班取数（接班人带出）随 TK-12 落地后接入
    const [recordRows, spotRows] = await Promise.all([
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
      receiver: null,
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
