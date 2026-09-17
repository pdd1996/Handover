import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import type {
  MissingField,
  MissingSubmitItemDto,
  MissingSubmitListDto,
  RecordStatus,
  ScheduleItemDto,
  ScheduleMonthDto,
  SchedulePutPayloadDto,
  SchedulePutResultDto,
  UserCreatePayloadDto,
  UserCreateResultDto,
  UserListItemDto,
  UserListDto,
  UserStatusPatchPayloadDto,
  UserStatusPatchResultDto,
} from '@handover/shared';
import { localMeasuredAt } from '@handover/shared';
import { ApiException } from '../common/api-error';
import { DB, type Db } from '../db/db.module';
import { auditLogs, schedules, users } from '../db/schema';
import { isValidCalendarDate, localWallClock } from '../records/duty-date';
import { AuthService, type SessionUser } from '../auth/auth.service';
import type { RecordListFilters } from '../records/records.service';
import { RecordsService } from '../records/records.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * 人员表单点名项（username/real_name/password/status 非交接单表单字段，锚点指向后台
 * 人员管理表单栏；FILTER_BAD 同式先例，records.service.ts）。
 */
const USER_BAD = (field: string, label: string): MissingField => ({
  field: field as MissingField['field'],
  section: 0,
  label,
  anchor: '#people-form',
});

/** username 规则：1~32 位字母/数字/下划线（users.username varchar(32) UNIQUE，D-T25 ①） */
const USERNAME_RE = /^\w{1,32}$/;

/** 排班月视图参数（GET ?month=）与点名项（非表单字段，锚点指向后台排班卡；USER_BAD 同式先例） */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SCHEDULE_BAD = (field: string, label: string): MissingField => ({
  field: field as MissingField['field'],
  section: 0,
  label,
  anchor: '#schedule-form',
});

/** 审计 `schedule.update`（契约 §5「新旧值」）的新旧值载荷 */
type ScheduleAuditValue = { user_id: number; real_name: string };

/** 初始密码长度界（D-T25 ①）：8~64 字；bcrypt 加盐哈希落库，明文不落库不回显 */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;

/** 审计 `user.update`（契约 §5）的新旧值载荷（开通/启停共用同一 action，D-T25 ④） */
type UserAuditValue = {
  username?: string;
  real_name?: string;
  role?: string;
  status?: string;
};

/**
 * 管理后台服务（TK-23 起架、TK-24 扩记录管理、TK-25 扩人员管理）：契约 §3.6 已落地路由
 * 的查询/组装层。记录域取数复用 RecordsService 单一实现（列表筛选、导出取数、批注写入
 * 均在 records 模块，admin 仅做后台侧编排——CSV 形态与文件名是后台展示关注点，落在本服务）；
 * 人员管理为 admin 域自有实现（账号启停联动 AuthService 的会话存根吊销，D-T25）。
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly records: RecordsService,
    private readonly auth: AuthService,
  ) {}

  /**
   * GET /admin/missing-submits（F6-06 后台半边，PRD §6.6「科长打开后台 → 显示应提交未提交
   * 提醒（日期 + 排班人）」）：漏交判定复用 NotificationsService.missingSubmitShifts 单一
   * 实现——契约 §3.6「数据源与 missing_submit 通知一致」由此结构保证，视图与扫描永不漂移。
   * 响应按 duty_date 倒序（最近漏交的班次排最前，处置时最急）。
   */
  async missingSubmits(now: Date = new Date()): Promise<MissingSubmitListDto> {
    const rows = await this.notifications.missingSubmitShifts(now);
    const items: MissingSubmitItemDto[] = rows
      .map((r) => ({ duty_date: r.dutyDate, user_id: r.userId, real_name: r.realName }))
      .sort((a, b) => (a.duty_date > b.duty_date ? -1 : a.duty_date < b.duty_date ? 1 : 0));
    return { items };
  }

  // ── GET /admin/records/export：记录导出（F6-01，TK-24；契约订正 28）─────────────

  /** 状态列中文名（与技术方案 §5.4 状态机同义；Phase 1 本地映射，P2 月报（F5-04）统一） */
  private static readonly STATUS_LABELS: Readonly<Record<RecordStatus, string>> = {
    draft: '草稿',
    submitted: '已提交',
    objection: '有异议',
    completed: '已归档',
  };

  /**
   * Phase 1 导出列集（契约订正 28 钉死）：记录标识与状态 + 四项日用量（F3 主结果）+
   * 标红项数 + 科长批注。明细读数不入 CSV——「查看」走 GET /records/{id} 详情，
   * 全列倾倒会让导出文件不可读，正式月报（每日用量明细 + 异常汇总）随 P2 F5-04 细化。
   */
  private static readonly EXPORT_COLUMNS: readonly {
    header: string;
    value: (row: Awaited<ReturnType<RecordsService['exportRows']>>[number]) => string;
  }[] = [
    { header: '交接单号', value: (r) => r.record_no },
    { header: '班次日期', value: (r) => r.duty_date },
    { header: '状态', value: (r) => AdminService.STATUS_LABELS[r.status] },
    { header: '版本', value: (r) => String(r.version) },
    { header: '交班人', value: (r) => r.submitter.real_name },
    { header: '接班人', value: (r) => r.receiver?.real_name ?? '' },
    { header: '提交时刻', value: (r) => r.submitted_at ?? '' },
    { header: '确认时刻', value: (r) => r.confirmed_at ?? '' },
    { header: '水用量', value: (r) => r.water_use ?? '' },
    { header: '电用量', value: (r) => r.e_use ?? '' },
    { header: '天然气用量', value: (r) => r.gas_use ?? '' },
    { header: '液氧日用量', value: (r) => r.lo_day_use ?? '' },
    { header: '标红项数', value: (r) => String(r.alert_count) },
    { header: '科长批注', value: (r) => r.chief_note ?? '' },
  ];

  /**
   * GET /admin/records/export（F6-01「导出」，TK-24）：按与 GET /records 完全相同的筛选参数
   * （parseRecordListFilters 单一实现）取数，组装 **CSV（UTF-8 带 BOM + CRLF）**——
   * BOM 使 Excel 直接打开不乱码（中文表头/批注），契约「CSV/Excel」的 Phase 1 交付即此
   * （Excel 兼容的 CSV；xlsx 生成挂 P2 与正式月报 F5-04 一并评估）。文件名含筛选区间：
   * 同月区间 `records-YYYY-MM.csv`，跨月/自定义区间 `records-{from}_{to}.csv`，无筛选
   * `records-{导出当日}.csv`。
   */
  async recordsExportCsv(
    filters: RecordListFilters,
    now: Date = new Date(),
  ): Promise<{ filename: string; body: string }> {
    const rows = await this.records.exportRows(filters);
    const escape = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    const lines = [
      AdminService.EXPORT_COLUMNS.map((c) => escape(c.header)).join(','),
      ...rows.map((r) => AdminService.EXPORT_COLUMNS.map((c) => escape(c.value(r))).join(',')),
    ];
    return {
      filename: AdminService.exportFilename(filters, now),
      // \uFEFF BOM 在最前，Excel 按带签名 UTF-8 解码
      body: `\uFEFF${lines.join('\r\n')}\r\n`,
    };
  }

  /** 导出文件名（按筛选区间命名，见 recordsExportCsv 注） */
  private static exportFilename(filters: RecordListFilters, now: Date): string {
    const { from, to } = filters;
    if (from !== null && to !== null) {
      if (from.slice(0, 7) === to.slice(0, 7)) return `records-${from.slice(0, 7)}.csv`;
      return `records-${from}_${to}.csv`;
    }
    const today = now.toISOString().slice(0, 10);
    return `records-${today.replaceAll('-', '')}.csv`;
  }

  // ── 人员管理（F6-02，TK-25；契约 §3.6 GET/POST /admin/users、PATCH /admin/users/{id}）─────

  /** users 行 → 契约查询面（passwordHash 凭证不出网；datetime 列读回 string 原样出网） */
  private static toItem(row: typeof users.$inferSelect): UserListItemDto {
    return {
      id: row.id,
      username: row.username,
      real_name: row.realName,
      role: row.role,
      status: row.status,
      created_at: row.createdAt,
    };
  }

  /**
   * GET /admin/users（F6-02 查询半边）：全量账号，id 升序（= 开通顺序）。含科长行——
   * 列表是账号全景的只读展示面（role/status 列透明），启停操作仅对师傅账号开放（见
   * userPatchStatus 的 chief 403 门）；前端师傅卡按 demo 口径只对 master 渲染启停按钮。
   */
  async usersList(): Promise<UserListDto> {
    const rows = await this.db.select().from(users).orderBy(asc(users.id));
    return { items: rows.map(AdminService.toItem) };
  }

  /**
   * POST /admin/users（F6-02「开通」，D-T25 ①）：开通**师傅账号**——角色恒 master
   * （科长账号经部署初始化发放，不走本接口；payload 中的多余字段一律忽略，同全站口径），
   * 初始状态 active。校验：username 1~32 位字母/数字/下划线、real_name 1~32 字、
   * 初始密码 8~64 字，违规 400 逐条点名（USER_BAD 锚点指向后台人员表单栏）；username
   * 重复 400 点名（预查 + 捕获 ER_DUP_ENTRY 兜并发窗口，消息一致不泄露竞争细节）。
   * 密码 bcrypt 加盐哈希（cost 10，与登录侧 DUMMY_HASH 同 cost）落库，明文不落库不回显。
   * 审计 `user.update`（契约 §5 既有行，D-T25 ④）：oldValue=null、newValue 携开通值，
   * 操作人与时刻即 actor_id / created_at（F6-02-T1「记录操作人、时间」）。
   */
  async userCreate(
    actor: SessionUser,
    payload: UserCreatePayloadDto,
  ): Promise<UserCreateResultDto> {
    const username = typeof payload?.username === 'string' ? payload.username.trim() : '';
    const realName = typeof payload?.real_name === 'string' ? payload.real_name.trim() : '';
    const password = typeof payload?.password === 'string' ? payload.password : '';

    const missing: MissingField[] = [];
    if (!USERNAME_RE.test(username)) {
      missing.push(USER_BAD('username', '登录名（1~32 位字母/数字/下划线）'));
    }
    if (realName.length < 1 || realName.length > 32) {
      missing.push(USER_BAD('real_name', '姓名（1~32 字）'));
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      missing.push(USER_BAD('password', `初始密码（${PASSWORD_MIN}~${PASSWORD_MAX} 字）`));
    }
    if (missing.length > 0) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '开通信息不完整或不合规', {
        missingFields: missing,
      });
    }

    const dup = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (dup.length > 0) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', `登录名 ${username} 已存在`, {
        missingFields: [USER_BAD('username', '登录名（不得与现有账号重复）')],
      });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    try {
      await this.db
        .insert(users)
        .values({ username, realName, role: 'master', passwordHash, status: 'active' });
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ApiException('VALIDATION_OUT_OF_RANGE', `登录名 ${username} 已存在`, {
          missingFields: [USER_BAD('username', '登录名（不得与现有账号重复）')],
        });
      }
      throw err;
    }
    // MySQL insert 无 returning：回查创建行（username UNIQUE 定位唯一）
    const createdRows = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    const created = createdRows[0]!;

    await this.db.insert(auditLogs).values({
      actorId: actor.id,
      action: 'user.update',
      targetType: 'user',
      targetId: String(created.id),
      oldValue: null,
      newValue: {
        username,
        real_name: realName,
        role: 'master',
        status: 'active',
      } satisfies UserAuditValue,
    });
    return AdminService.toItem(created);
  }

  /**
   * PATCH /admin/users/{id}（F6-02「停用/启用」，D-T25 ②③）：Phase 1 的账号管理动作仅
   * 状态启停一项。口径：
   * - body `{status: 'active'|'disabled'}`，越值 400 点名 status；非数字/未知 id 404
   *   （同 GET /records/{id} 既有口径）；
   * - **仅师傅账号可操作**：目标为 chief → 403 FORBIDDEN（F6-02 范围 = 师傅账号；科长账号
   *   生命周期经部署初始化发放，科长误停自己/另一科长由此门拦下）；
   * - **值无变化不更新不写审计**（D-T21 M1 同一精神，TK-24 annotate 先例）；
   * - **停用即不可登录（D-T13）**：状态改 disabled 与审计同事务提交后，删除该用户全部
   *   sessions 存根（AuthService.revokeAllForUser 单一实现）——已在线设备下一次请求即 401；
   *   会话解析侧另有「status=disabled → 再吊销一次」双保险兜并发窗口；
   * - 变更审计 `user.update`：oldValue/newValue 携 status 前后值（契约 §5「新旧值」）。
   */
  async userPatchStatus(
    actor: SessionUser,
    id: number,
    payload: UserStatusPatchPayloadDto,
  ): Promise<UserStatusPatchResultDto> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiException('NOT_FOUND', '账号不存在或已被删除');
    }
    const status = payload?.status;
    if (status !== 'active' && status !== 'disabled') {
      throw new ApiException(
        'VALIDATION_OUT_OF_RANGE',
        `账号状态取值越界，可选：active / disabled`,
        {
          missingFields: [USER_BAD('status', '账号状态（active 在用 / disabled 停用）')],
        },
      );
    }

    const changed = await this.db.transaction(async (tx) => {
      const locked = await tx.select().from(users).where(eq(users.id, id)).limit(1).for('update');
      const row = locked[0];
      if (!row) throw new ApiException('NOT_FOUND', '账号不存在或已被删除');
      if (row.role === 'chief') {
        throw new ApiException('FORBIDDEN', '科长账号不随本接口启停（本接口管理范围为师傅账号）');
      }
      if (row.status === status) return false;
      await tx.update(users).set({ status }).where(eq(users.id, id));
      await tx.insert(auditLogs).values({
        actorId: actor.id,
        action: 'user.update',
        targetType: 'user',
        targetId: String(row.id),
        oldValue: { status: row.status } satisfies UserAuditValue,
        newValue: { status } satisfies UserAuditValue,
      });
      return true;
    });

    // 提交后再吊销存根：失败也不破坏正确性——resolveSession 对 status=disabled 的双保险
    // 会在该账号下一次请求时再吊销并 401（AuthService.resolveSession，D-T13）
    if (changed && status === 'disabled') {
      await this.auth.revokeAllForUser(id);
    }

    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return AdminService.toItem(rows[0]!);
  }

  // ── 排班管理（F6-03/F6-04，TK-26；契约 §3.6 GET/PUT /admin/schedules）─────────────

  /**
   * GET /admin/schedules（F6-03 查询半边）：排班月视图，`?month=YYYY-MM` 缺省取当前墙钟月
   * （SHIFT_TIMEZONE 本地日历，与班次分界同一时区口径）。**稀疏列示**——仅返回该月内
   * schedules 既有行（无排班日不出行，前端渲染空位），duty_date 升序；排班人姓名联 users
   * 回显（停用账号的历史排班仍显原名，demo 口径「已停用」标注属前端展示层）。
   */
  async schedulesMonth(month?: string): Promise<ScheduleMonthDto> {
    const raw = typeof month === 'string' ? month.trim() : '';
    if (raw !== '' && !MONTH_RE.test(raw)) {
      throw new ApiException(
        'VALIDATION_OUT_OF_RANGE',
        '月份参数非法（应为 YYYY-MM，如 2026-09）',
        { missingFields: [SCHEDULE_BAD('month', '月份（YYYY-MM）')] },
      );
    }
    const m = raw !== '' ? raw : localWallClock(new Date()).date.slice(0, 7);
    const [y, mo] = [Number(m.slice(0, 4)), Number(m.slice(5, 7))];
    const first = `${m}-01`;
    // 月末 = 下月 0 号（UTC 日历算术，纯日期无时区歧义）
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const rows = await this.db
      .select({
        dutyDate: schedules.dutyDate,
        userId: schedules.userId,
        realName: users.realName,
        updatedAt: schedules.updatedAt,
      })
      .from(schedules)
      .innerJoin(users, eq(users.id, schedules.userId))
      .where(and(gte(schedules.dutyDate, first), lte(schedules.dutyDate, last)))
      .orderBy(asc(schedules.dutyDate));
    const items: ScheduleItemDto[] = rows.map((r) => ({
      duty_date: r.dutyDate,
      user_id: r.userId,
      real_name: r.realName,
      updated_at: r.updatedAt,
    }));
    return { month: m, items };
  }

  /**
   * PUT /admin/schedules（F6-03「科长维护排班表，改即审计」）：单日单条 upsert——
   * 一天一人由 schedules.duty_date UNIQUE 承载（契约 §3.6），同日已有排班即为改派。
   * 口径：
   * - duty_date 须为日历有效 `YYYY-MM-DD`（isValidCalendarDate 单一权威，拦 02-30 等），
   *   user_id 须为**存在的师傅账号**（chief 目标与未知 id 均 400 点名 user_id——排班人
   *   恒为师傅，C-05；停用账号不新增指派但历史行保留，前端候选只列 active，demo 口径）；
   * - **同值重复 PUT 值无变化不更新不写审计**（D-T21 M1 同一精神，TK-24/25 先例）；
   * - 变更与审计 `schedule.update`（契约 §5「新旧值」）同事务：oldValue/newValue 携
   *   `{user_id, real_name}` 前后值，targetId = duty_date，操作人/时刻即 actor_id/created_at；
   * - upsert 走 INSERT … ON DUPLICATE KEY UPDATE（并发窗口不撞 1062，userCreate 兜并发
   *   同理），并回写 updated_by/updated_at（表列既有结构，无迁移）。
   * 驱动面（F6-04）零改动：接班人带出（scheduledReceiverOf）与漏交扫描
   * （missingSubmitShifts）读同一张 schedules 表，本处落库次班即生效。
   */
  async schedulePut(
    actor: SessionUser,
    payload: SchedulePutPayloadDto,
  ): Promise<SchedulePutResultDto> {
    const dutyDate = typeof payload?.duty_date === 'string' ? payload.duty_date.trim() : '';
    if (!isValidCalendarDate(dutyDate)) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '值班日期非法（应为日历有效 YYYY-MM-DD）', {
        missingFields: [SCHEDULE_BAD('duty_date', '值班日期（YYYY-MM-DD）')],
      });
    }
    const userId = payload?.user_id;
    if (!Number.isInteger(userId) || (userId as number) <= 0) {
      throw new ApiException('VALIDATION_OUT_OF_RANGE', '值班师傅非法', {
        missingFields: [SCHEDULE_BAD('user_id', '值班师傅')],
      });
    }

    const changed = await this.db.transaction(async (tx) => {
      const targets = await tx
        .select({ id: users.id, realName: users.realName, role: users.role })
        .from(users)
        .where(eq(users.id, userId as number))
        .limit(1);
      const target = targets[0];
      if (!target || target.role !== 'master') {
        throw new ApiException('VALIDATION_OUT_OF_RANGE', '值班师傅须为师傅账号（C-05）', {
          missingFields: [SCHEDULE_BAD('user_id', '值班师傅（师傅账号）')],
        });
      }

      const prevRows = await tx
        .select({ userId: schedules.userId, realName: users.realName })
        .from(schedules)
        .innerJoin(users, eq(users.id, schedules.userId))
        .where(eq(schedules.dutyDate, dutyDate))
        .limit(1);
      const prev = prevRows[0] ?? null;
      if (prev && prev.userId === target.id) {
        return { changed: false, realName: target.realName, updatedAt: null };
      }

      const now = localMeasuredAt();
      await tx
        .insert(schedules)
        .values({ dutyDate, userId: target.id, updatedBy: actor.id, updatedAt: now })
        .onDuplicateKeyUpdate({
          set: { userId: target.id, updatedBy: actor.id, updatedAt: now },
        });
      await tx.insert(auditLogs).values({
        actorId: actor.id,
        action: 'schedule.update',
        targetType: 'schedule',
        targetId: dutyDate,
        oldValue: prev ? { user_id: prev.userId, real_name: prev.realName } : null,
        newValue: { user_id: target.id, real_name: target.realName } satisfies ScheduleAuditValue,
      });
      return { changed: true, realName: target.realName, updatedAt: now };
    });

    return {
      duty_date: dutyDate,
      user_id: userId as number,
      real_name: changed.realName,
      changed: changed.changed,
      updated_at: changed.updatedAt,
    };
  }
}
