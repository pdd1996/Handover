import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import {
  localMeasuredAt,
  localTimestampToDate,
  type NotificationListDto,
  type NotificationReadResultDto,
} from '@handover/shared';
import { DB, type Db } from '../db/db.module';
import { configs, notifications, records, schedules, sessions, users } from '../db/schema';
import { localWallClock, minusDays, plusOneDay } from '../records/duty-date';
import { ApiException } from '../common/api-error';
import { RecordsService } from '../records/records.service';

/** configs.confirm_due_hours 缺失/非法时的兜底（种子值 2，❓ 时长建议值待科长确认，F2-11「建议 2 小时，可调」） */
const DEFAULT_CONFIRM_DUE_HOURS = 2;
/** configs.objection_escalate_hours 缺失/非法时的兜底（种子值 24；F2-12「超 24 小时自动升级」） */
const DEFAULT_OBJECTION_ESCALATE_HOURS = 24;
/** configs.missing_submit_deadline 缺失/非法时的兜底（种子值 09:00；F6-06「默认次日 9:00，可调」） */
const DEFAULT_MISSING_SUBMIT_DEADLINE = '09:00';

/** 数值型配置的限幅：防科长误填（0 或负数使扫描每轮全量触发、超大值形同关闭） */
const clampHours = (n: number, min: number, max: number): number =>
  Number.isFinite(n) && n >= min && n <= max ? n : NaN;

/** F6-06 通知的标题模板：`{duty_date} 应提交未提交`——title 兼作该扫描的幂等去重键（同日期不重复提醒） */
function missingSubmitTitle(dutyDate: string): string {
  return `${dutyDate} 应提交未提交`;
}

/**
 * 站内通知服务（TK-22）：
 *
 * **读侧**（契约 §3.5）：GET /notifications 回当前登录人未读通知（id 倒序）+ 未读总数；
 * POST /notifications/{id}/read 标记已读（幂等，重复调用回首次时刻；非本人/不存在 404，
 * 不向他方泄露通知存在性）。kind 枚举与注释见 shared `NOTIFICATION_KINDS`。
 *
 * **写侧＝服务端定时任务四件**（本文件四个 run* 扫描；**时间可注入**——`now` 一律由调用方
 * 传入，生产由 NotificationsScheduler 以系统时钟轮询，测试以构造时刻直调，判据 F2-11-T1/
 * F2-12-T1/F6-06-T1 均按「定时」层验证扫描本体而非等真实时钟）：
 *
 * 1. `runConfirmDueScan`（F2-11）：提交后 `configs.confirm_due_hours`（默认 2）仍未确认
 *    （status 恒 'submitted'——objection 是接班人已过问、completed 已归档，均不再提醒）→
 *    站内提醒接班人。**去重键 = (kind=confirm_due, record, receiver)**，且仅认「晚于当前
 *    submitted_at 创建」的通知——撤回重提会刷新 submitted_at 并给接班人新的确认窗口，
 *    旧提醒不压制新一轮扫描（notifications.createdAt 与 records.submittedAt 同为
 *    localMeasuredAt 本地墙钟串，字符串比较即时刻比较）。
 * 2. `runObjectionEscalationScan`（F2-12）：异议 `configs.objection_escalate_hours`（默认 24）
 *    未解决（status='objection'）→ 升级提醒科长。**防重复 = escalated_at 原子闸门**：
 *    UPDATE … WHERE escalated_at IS NULL（命中行数 1 才发通知），并发扫描也只成功一次，
 *    与技术方案 §5.4「升级后记 escalated_at 防重复提醒」一致。
 * 3. `runMissingSubmitScan`（F6-06）：排班日 D 过约定时点（(D+1) 日 `configs.
 *    missing_submit_deadline`，默认 09:00）仍无交接单 → 提醒科长（日期+排班人）。
 *    **漏交判定以 records 行存在为准**（台账增补 #27：任意状态含 draft 撤回未重提均不算漏交，
 *    补交/接管后自然消失）；**扫描窗口 = 当前班次 − configs.backfill_window_days**——窗口外
 *    班次已无法经 POST /records/backfill 补救（D-T21 L3），提醒无对象，且防历史排班在首次
 *    部署/长期停机后集中刷屏。**去重键 = (chief, title)**，title 即 `missingSubmitTitle(D)`。
 * 4. `runSessionsCleanup`：删除 `expires_at` 已过期的会话存根行（技术方案 §6「过期行由定时
 *    任务清理」，运维卫生类、无台账规格）。sessions 列为 UTC 串（auth.service utcDateTime
 *    口径），比较必须同 UTC 空间——与 records 列的本地墙钟口径（localMeasuredAt）不同源，
 *    两套口径各随其列、勿混用。
 *
 * 提醒目标：F2-11 → 记录接班人（receiver_id）；F2-12 / F6-06 → 全部 active 科长
 * （role='chief'，PRD §6.6「科长后台显示应提交未提交提醒」）。扫描为只读判定 + 单表插入，
 * 不走审计拦截器（非用户变更类路由，契约 §5 审计联动表不含定时任务）。
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
  ) {}

  // ── 读侧（契约 §3.5）───────────────────────────────────────────

  /** GET /notifications：当前登录人未读通知（id 倒序）+ 未读总数 */
  async list(userId: number): Promise<NotificationListDto> {
    const rows = await this.db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        title: notifications.title,
        message: notifications.message,
        recordId: notifications.recordId,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .orderBy(desc(notifications.id));
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind as NotificationListDto['items'][number]['kind'],
        title: r.title,
        message: r.message,
        record_id: r.recordId,
        created_at: r.createdAt,
        read_at: r.readAt,
      })),
      unread: rows.length,
    };
  }

  /** POST /notifications/{id}/read：标记已读；幂等（已读回首次时刻）；非本人/不存在 404 */
  async markRead(userId: number, notificationId: number): Promise<NotificationReadResultDto> {
    const rows = await this.db
      .select({ id: notifications.id, readAt: notifications.readAt })
      .from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiException('NOT_FOUND', '通知不存在或无权操作');
    if (row.readAt) return { id: row.id, read_at: row.readAt };
    const readAt = localMeasuredAt();
    await this.db.update(notifications).set({ readAt }).where(eq(notifications.id, row.id));
    return { id: row.id, read_at: readAt };
  }

  // ── 写侧：定时任务四件（时间可注入，now 由调用方传）─────────────

  /**
   * 任务一（F2-11）：接班人超时未确认扫描。返回本轮新建通知数。
   * submitted_at 列为本地墙钟串（localMeasuredAt 口径），截止线同格式字符串比较。
   */
  async runConfirmDueScan(now: Date): Promise<number> {
    const hours = await this.confirmDueHours();
    const cutoff = localMeasuredAt(new Date(now.getTime() - hours * 3_600_000));
    const candidates = await this.db
      .select({
        id: records.id,
        recordNo: records.recordNo,
        receiverId: records.receiverId,
        submittedAt: records.submittedAt,
      })
      .from(records)
      .where(
        and(
          eq(records.status, 'submitted'),
          isNotNull(records.receiverId),
          isNotNull(records.submittedAt),
          lte(records.submittedAt, cutoff),
        ),
      );
    if (candidates.length === 0) return 0;

    // 去重：仅认「晚于当前 submitted_at 创建」的 confirm_due（撤回重提刷新窗口后旧提醒不压制）。
    // createdAt 由库端 CURRENT_TIMESTAMP 产生（连接 timezone='Z' → UTC 串），submittedAt 为
    // 本地墙钟串（localMeasuredAt 口径）——比较前先把 submitted_at 换算成 UTC 串，防 8 小时
    // 口径差把已发提醒误判为未发（重复刷屏）。
    const submittedUtcOf = new Map<number, string>();
    for (const c of candidates) {
      if (c.submittedAt == null) continue;
      const t = localTimestampToDate(c.submittedAt);
      if (t) submittedUtcOf.set(c.id, utcDateTime(t.getTime()));
    }
    const sent = await this.db
      .select({
        recordId: notifications.recordId,
        userId: notifications.userId,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.kind, 'confirm_due'));
    const sentKeys = new Set(
      sent
        .filter(
          (n) =>
            n.recordId != null &&
            submittedUtcOf.has(n.recordId) &&
            (submittedUtcOf.get(n.recordId) as string) <= n.createdAt,
        )
        .map((n) => `${n.recordId}:${n.userId}`),
    );
    const fresh = candidates.filter((c) => !sentKeys.has(`${c.id}:${c.receiverId}`));
    if (fresh.length === 0) return 0;

    await this.db.insert(notifications).values(
      fresh.map((c) => ({
        userId: c.receiverId as number,
        kind: 'confirm_due',
        title: '交接记录待确认',
        message: `交接单 ${c.recordNo} 已提交超过 ${hours} 小时未确认，请尽快处理（F2-11）`,
        recordId: c.id,
      })),
    );
    return fresh.length;
  }

  /**
   * 任务二（F2-12）：异议 24 小时未解决升级科长扫描。返回本轮升级记录数（每单至多一次）。
   * escalated_at 与 objection_at 同列族口径（localMeasuredAt 本地墙钟串）。
   */
  async runObjectionEscalationScan(now: Date): Promise<number> {
    const hours = await this.objectionEscalateHours();
    const cutoff = localMeasuredAt(new Date(now.getTime() - hours * 3_600_000));
    const candidates = await this.db
      .select({
        id: records.id,
        recordNo: records.recordNo,
        submitterId: records.submitterId,
        objectionAt: records.objectionAt,
      })
      .from(records)
      .where(
        and(
          eq(records.status, 'objection'),
          isNull(records.escalatedAt),
          isNotNull(records.objectionAt),
          lte(records.objectionAt, cutoff),
        ),
      );
    if (candidates.length === 0) return 0;
    const chiefs = await this.activeChiefs();
    if (chiefs.length === 0) {
      this.logger.warn('异议升级扫描：无 active 科长可提醒，本轮跳过（请检查 users 表）');
      return 0;
    }
    const submitterNames = await this.realNameMap(candidates.map((c) => c.submitterId));

    let escalated = 0;
    for (const rec of candidates) {
      // 原子闸门：escalated_at 仅在仍为 NULL 时写入——并发扫描/重复轮询只有一次命中，防重复提醒
      const gate = await this.db
        .update(records)
        .set({ escalatedAt: localMeasuredAt(now) })
        .where(and(eq(records.id, rec.id), isNull(records.escalatedAt)));
      if (gate[0].affectedRows === 0) continue;
      escalated += 1;
      await this.db.insert(notifications).values(
        chiefs.map((c) => ({
          userId: c.id,
          kind: 'objection_escalated',
          title: '异议超时升级',
          message: `交接单 ${rec.recordNo} 的异议已超过 ${hours} 小时未解决（提交人：${
            submitterNames.get(rec.submitterId) ?? '未知'
          }），请跟进处理（F2-12）`,
          recordId: rec.id,
        })),
      );
    }
    return escalated;
  }

  /**
   * 任务三（F6-06）：应提交未提交扫描。返回本轮新建通知数（每缺失班次 × 每科长至多一条）。
   * 截止判定在**墙钟空间**：班次 D 的截止 =（D+1）日 deadline 'HH:MM'，与 now 的当地墙钟
   * 直接比较日历日与分钟（localWallClock，见 duty-date.ts 导出注）。
   */
  async runMissingSubmitScan(now: Date): Promise<number> {
    const missing = await this.missingSubmitShifts(now);
    if (missing.length === 0) return 0;
    const chiefs = await this.activeChiefs();
    if (chiefs.length === 0) {
      this.logger.warn('漏交扫描：无 active 科长可提醒，本轮跳过（请检查 users 表）');
      return 0;
    }

    // 去重键 = (chief, title)；title 携带 duty_date（missingSubmitTitle），同班次不重复提醒
    const titles = [...new Set(missing.map((m) => missingSubmitTitle(m.dutyDate)))];
    const sent = await this.db
      .select({ userId: notifications.userId, title: notifications.title })
      .from(notifications)
      .where(and(eq(notifications.kind, 'missing_submit'), inArray(notifications.title, titles)));
    const sentKeys = new Set(sent.map((n) => `${n.userId}:${n.title}`));

    const inserts = missing.flatMap((m) =>
      chiefs
        .filter((c) => !sentKeys.has(`${c.id}:${missingSubmitTitle(m.dutyDate)}`))
        .map((c) => ({
          userId: c.id,
          kind: 'missing_submit',
          title: missingSubmitTitle(m.dutyDate),
          message: `${m.dutyDate} 班次应提交未提交，排班人：${m.realName}，请核实处理（F6-06）`,
          recordId: null,
        })),
    );
    if (inserts.length > 0) await this.db.insert(notifications).values(inserts);
    return inserts.length;
  }

  /**
   * F6-06 漏交班次集合（**单一判定实现**，扫描与后台视图 GET /admin/missing-submits 共用，
   * 契约 §3.6「数据源与 missing_submit 通知一致」）：
   * - 截止判定在墙钟空间：班次 D 过（D+1）日 `missing_submit_deadline`（默认 09:00）仍未提交；
   * - 漏交判定以 records 行存在为准（台账增补 #27：任意状态含 draft 撤回未重提均不算漏交）；
   * - 扫描窗口 = 当前班次 − `backfill_window_days`（窗口外班次无法经补交端点补救，
   *   D-T21 L3——视图与扫描同样不列出，否则首次部署/长期停机后集中刷屏且无处置入口）。
   */
  async missingSubmitShifts(
    now: Date,
  ): Promise<Array<{ dutyDate: string; userId: number; realName: string }>> {
    const deadline = await this.missingSubmitDeadline();
    const deadlineMinutes = parseClockMinutes(deadline);
    const { dutyDate: currentShift } = await this.recordsService.resolveDutyDate(now);
    const windowDays = await this.recordsService.backfillWindowDays();
    const lowerBound = minusDays(currentShift, windowDays); // 窗口外班次无法补交（D-T21 L3），不再提醒
    const { date: today, minutes: nowMinutes } = localWallClock(now);

    const rows = await this.db
      .select({ dutyDate: schedules.dutyDate, userId: schedules.userId, realName: users.realName })
      .from(schedules)
      .innerJoin(users, eq(users.id, schedules.userId))
      .where(gte(schedules.dutyDate, lowerBound));
    const due = rows.filter((r) => {
      const dueDate = plusOneDay(r.dutyDate); // 截止日 = 排班日 + 1 天
      return dueDate < today || (dueDate === today && deadlineMinutes <= nowMinutes);
    });
    if (due.length === 0) return [];

    // 漏交判定以 records 行存在为准（台账增补 #27；draft 撤回未重提也不算漏交）
    const existing = await this.db
      .select({ dutyDate: records.dutyDate })
      .from(records)
      .where(
        inArray(
          records.dutyDate,
          due.map((d) => d.dutyDate),
        ),
      );
    const hasRecord = new Set(existing.map((e) => e.dutyDate));
    return due.filter((d) => !hasRecord.has(d.dutyDate));
  }

  /** 任务四：清理过期的会话存根行（技术方案 §6）。sessions 列为 UTC 串，比较同 UTC 空间 */
  async runSessionsCleanup(now: Date): Promise<number> {
    const res = await this.db
      .delete(sessions)
      .where(lte(sessions.expiresAt, utcDateTime(now.getTime())));
    return res[0].affectedRows;
  }

  /** 全量跑一轮（生产调度入口；返回各任务计数供日志） */
  async runAll(now: Date = new Date()): Promise<Record<string, number>> {
    return {
      confirm_due: await this.runConfirmDueScan(now),
      objection_escalated: await this.runObjectionEscalationScan(now),
      missing_submit: await this.runMissingSubmitScan(now),
      sessions_deleted: await this.runSessionsCleanup(now),
    };
  }

  // ── 配置读取（F4-11 精神：运营口径后台可配；非法回落种子默认值并限幅防错字）──

  /** 接班人确认超时阈值（小时）：configs `confirm_due_hours`，限 1–72 */
  async confirmDueHours(): Promise<number> {
    return this.readHourConfig('confirm_due_hours', DEFAULT_CONFIRM_DUE_HOURS, 1, 72);
  }

  /** 异议升级阈值（小时）：configs `objection_escalate_hours`，限 1–168 */
  async objectionEscalateHours(): Promise<number> {
    return this.readHourConfig(
      'objection_escalate_hours',
      DEFAULT_OBJECTION_ESCALATE_HOURS,
      1,
      168,
    );
  }

  /** 漏交扫描时点：configs `missing_submit_deadline`（'HH:MM'），非法回落 09:00 */
  async missingSubmitDeadline(): Promise<string> {
    const rows = await this.db
      .select({ value: configs.configValue })
      .from(configs)
      .where(eq(configs.configKey, 'missing_submit_deadline'))
      .limit(1);
    const raw = (rows[0]?.value ?? '').trim();
    return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(raw) ? raw : DEFAULT_MISSING_SUBMIT_DEADLINE;
  }

  private async readHourConfig(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): Promise<number> {
    const rows = await this.db
      .select({ value: configs.configValue })
      .from(configs)
      .where(eq(configs.configKey, key))
      .limit(1);
    const n = clampHours(Number((rows[0]?.value ?? '').trim()), min, max);
    if (!Number.isFinite(n)) {
      this.logger.warn(`configs.${key} 非法（值见库），回落 ${fallback}（限 ${min}–${max} 小时）`);
      return fallback;
    }
    return n;
  }

  /** 全部 active 科长（F2-12 / F6-06 的提醒目标） */
  private async activeChiefs(): Promise<Array<{ id: number; realName: string }>> {
    return this.db
      .select({ id: users.id, realName: users.realName })
      .from(users)
      .where(and(eq(users.role, 'chief'), eq(users.status, 'active')));
  }

  /** 一批用户 id → realName 映射（异议升级通知文案用） */
  private async realNameMap(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, realName: users.realName })
      .from(users)
      .where(inArray(users.id, unique));
    return new Map(rows.map((r) => [r.id, r.realName]));
  }
}

/** 本地墙钟串（localMeasuredAt 同格式）的截止解析用：'HH:MM' → 当日分钟数 */
function parseClockMinutes(value: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return 9 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** sessions 列的 UTC 串格式化（与 auth.service utcDateTime 同式；勿与 records 列的本地串混用） */
function utcDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
