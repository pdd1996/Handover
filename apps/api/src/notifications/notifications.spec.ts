/**
 * TK-22 服务端定时任务四件测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - F2-11-T1：提交后 2 小时（configs confirm_due_hours 可配）未确认 → 定时扫描 → 站内提醒
 *   接班人（notifications.kind=confirm_due）；阈值未到不提醒；重复扫描不重复提醒；
 *   撤回重提刷新 submitted_at 后旧提醒不压制新一轮（去重键带 submitted_at 水位）。
 * - F2-12-T1：异议 24 小时未解决 → 自动升级（escalated_at 写入）→ 提醒科长且不重复
 *   （notifications.kind=objection_escalated；escalated_at 原子闸门防重复）。
 * - F6-06-T1：排班日过约定时点（configs missing_submit_deadline，默认次日 9:00）无已提交
 *   记录 → 扫描 → 提醒科长（通知含日期+排班人；时点可配以 deadline 前后两轮扫描验证；
 *   补交窗口外班次不提醒，D-T21 L3）。
 * - 附加回归：会话过期存根行清理（技术方案 §6，运维卫生类）、GET /notifications 未读列表、
 *   POST /notifications/{id}/read 幂等与 404（非本人/不存在）、未登录 401。
 *
 * **时间可注入**：四个扫描的 now 一律由测试构造传入（「定时」层判据验扫描本体，
 * 不等真实时钟）；调度器在 jest 环境静默（notifications.scheduler.ts inTest 闸）。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`（接口用例强依赖
 * 当天重灌种子——任务分解修订 27 运维前提）；--runInBand 串行。自建记录（zhang 提交当班次，
 * receiver=次日排班人）不触碰种子 D-1；F6-06 用种子 D+1～D+7 的排班（无记录）构造缺失班次，
 * 注入 now = 当前班次 + 8 天正午（补交窗口 7 天内、截止已过、不触碰任何种子行）；
 * missing_submit_deadline 两轮扫描间临时改值、afterAll 还原（records-backfill.spec 同法）。
 * afterAll 还原：notifications 水位线（FK 先于记录行删除）、configs、审计水位线、会话。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, gt, gte, inArray } from 'drizzle-orm';
import request from 'supertest';
import {
  localTimestampToDate,
  type NotificationListDto,
  type NotificationReadResultDto,
  type ObjectionResultDto,
  type SubmitPayloadDto,
  type SubmitResultDto,
} from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import {
  alerts,
  auditLogs,
  configs,
  elevatorChecks,
  notifications,
  recordVersions,
  records,
  schedules,
  sessions,
  users,
} from '../db/schema';
import { RecordsService } from '../records/records.service';
import { NotificationsService } from './notifications.service';

const PASSWORD = 'Handover@2026';
const SUBMIT_API = '/api/v1/records/today/submit';
const OBJECTION_API = (id: number) => `/api/v1/records/${id}/objection`;
const NOTIFICATIONS_API = '/api/v1/notifications';
const readApi = (id: number) => `/api/v1/notifications/${id}/read`;
const DEADLINE_CONFIG_KEY = 'missing_submit_deadline';

/** 相邻上一班的班次日期（测试内联；与 duty-date.ts minusOneDay 同式，勿改口径） */
function minusOneDayOf(dutyDate: string): string {
  const d = new Date(`${dutyDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 日历日加 N 天（UTC 算法，与 duty-date.ts plusOneDay 同式） */
function plusDays(dutyDate: string, days: number): string {
  const d = new Date(`${dutyDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 注入时刻：上海墙钟 dateStr 当日 12:00（Asia/Shanghai = UTC+8 恒定无夏令时，04:00Z 即正午）。
 * 与 duty-date localWallClock 同一默认时区——无论测试机时区为何，扫描看到的墙钟日期恒为 dateStr。
 */
function shanghaiNoon(dateStr: string): Date {
  return new Date(`${dateStr}T04:00:00Z`);
}

/** 本地墙钟串（localMeasuredAt 口径）+ 偏移毫秒 → 注入 Date */
function atOffset(localStr: string, offsetMs: number): Date {
  const t = localTimestampToDate(localStr);
  if (!t) throw new Error(`本地时间戳非法：${localStr}`);
  return new Date(t.getTime() + offsetMs);
}

describe('TK-22 服务端定时任务四件（接口）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let jobs: NotificationsService;
  let auditHighWater = 0;
  let ntfHighWater = 0;
  let zhangCookie = '';
  let receiverCookie = '';
  let chiefCookie = '';
  let zhangId = 0;
  let receiverId = 0;
  let chiefId = 0;
  let dutyDate = '';
  let recordId = 0;
  let recordNo = '';
  let submittedAt = '';
  let deadlineOriginal = '';
  /** settle 轮落定的历史异议单（种子 D-2 演示单；afterAll 还原其 escalated_at） */
  let settledObjectionIds: number[] = [];
  const HOUR = 3_600_000;

  async function login(username: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username, password: PASSWORD })
      .expect(200);
    return String(res.headers['set-cookie']?.[0] ?? '');
  }

  /** 某用户 kind 通知行（断言用） */
  async function kindRows(userId: number, kind: string) {
    return db
      .select({
        id: notifications.id,
        title: notifications.title,
        message: notifications.message,
        recordId: notifications.recordId,
      })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, kind)));
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get<Db>(DB);
    server = app.getHttpServer() as Server;
    jobs = app.get(NotificationsService);

    await db.delete(sessions);
    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);
    const ntfRows = await db.select({ id: notifications.id }).from(notifications);
    ntfHighWater = ntfRows.reduce((max, r) => Math.max(max, r.id), 0);

    // settle 轮（真实时钟）：种子 D-2 是长挂异议演示单（objectionAt=D-2 21:05、escalated_at 空），
    // 首轮扫描按 F2-12 语义本就会将其升级——先落定，后续用例只断言自建单；落定产生的通知行
    // 在水位线之上由 afterAll 清除，escalated_at 亦由 afterAll 还原（不污染其他 spec）。
    await jobs.runAll(new Date());
    settledObjectionIds = (
      await db
        .select({ id: records.id })
        .from(records)
        .where(and(eq(records.status, 'objection'), gt(records.escalatedAt, '1970-01-01 00:00:00')))
    ).map((r) => r.id);
    expect(settledObjectionIds.length).toBeGreaterThanOrEqual(1); // D-2 落定，防种子漂移

    zhangCookie = await login('zhang');
    chiefCookie = await login('chief');
    dutyDate = (await app.get(RecordsService).resolveDutyDate()).dutyDate;

    const uid = Object.fromEntries(
      (await db.select({ id: users.id, username: users.username }).from(users)).map((r) => [
        r.username,
        r.id,
      ]),
    ) as Record<string, number>;
    zhangId = uid['zhang'] as number;
    chiefId = uid['chief'] as number;
    if (!zhangId || !chiefId) throw new Error('种子缺 zhang/chief——请先 db:setup 重灌');

    // 种子相邻上一班（D-1）水表读数——防呆基线；缺失即显式失败（当天未重灌种子）
    const adjacent = await db
      .select({ water: records.waterReading })
      .from(records)
      .where(eq(records.dutyDate, minusOneDayOf(dutyDate)))
      .limit(1);
    if (!(Number(adjacent[0]?.water ?? '0') > 0)) {
      throw new Error(
        `相邻班次 ${minusOneDayOf(dutyDate)} 无种子记录——请先 db:setup 重灌种子（任务分解修订 27 运维前提）`,
      );
    }
    // F6-06 依赖种子排班覆盖 D+1～D+7（《开发种子数据》§二 D-14～D+7），跨灌种日会缺位
    const futureSched = await db
      .select({ dutyDate: schedules.dutyDate })
      .from(schedules)
      .where(gte(schedules.dutyDate, plusDays(dutyDate, 1)));
    if (futureSched.length < 7) {
      throw new Error('种子排班未覆盖 D+1～D+7——请先 db:setup 重灌种子');
    }
    const dl = await db
      .select({ value: configs.configValue })
      .from(configs)
      .where(eq(configs.configKey, DEADLINE_CONFIG_KEY))
      .limit(1);
    if (!dl[0]) throw new Error(`种子缺 configs ${DEADLINE_CONFIG_KEY}，请先 db:setup 重灌`);
    deadlineOriginal = dl[0].value;

    // ── 自建记录：干净 payload（全 status=ok）→ 零标红行；读数基线高于种子 D-1，不命中防呆
    const payload = {
      sections: {
        water_reading: '12300.0',
        e1_reading: '53500.0',
        e2_reading: '43200.0',
        hp_status: 'ok',
        g1_remaining: '300.0',
        g2_remaining: '200.0',
        tank_in_use: 1,
        t1_c830: '4800.00',
        t1_p830: '0.80',
        t2_c830: '4900.00',
        t2_p830: '0.80',
        t1_c2030: '4700.00',
        t1_p2030: '0.80',
        t2_c2030: '4800.00',
        t2_p2030: '0.80',
        lo_measured_am: `${dutyDate} 08:12:00`,
        lo_measured_pm: `${dutyDate} 20:15:00`,
        lo_station_press: '0.50',
        hbo_press: '0.45',
        b40: 10,
        b10: 20,
        b6: 30,
        b_co2: 40,
        b_pulm: 50,
        manifold_press: '1.00',
        co2_out_press: '0.90',
        neg_status: 'ok',
        air_status: 'ok',
        boiler_status: 'ok',
        boiler_run: 'stop',
        coolroom_status: 'ok',
        cool_run: 'run',
        h1_set_temp: '45.0',
        h1_out_temp: '40.0',
        h3_set_temp: '46.0',
        h3_out_temp: '41.0',
        p1_press: '0.40',
        p1_level: 'ok',
        p1_height: '2.50',
        p3_press: '0.42',
        p3_level: 'ok',
        p3_height: '2.60',
        hvac_status: 'ok',
        hvac_locs: ['手术部', 'ICU'],
        handover_note: '',
      },
    } as SubmitPayloadDto;

    const submitRes = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', zhangCookie)
      .send(payload)
      .expect(201);
    const saved = submitRes.body as SubmitResultDto;
    recordId = saved.id;
    recordNo = saved.record_no;

    const recRows = await db
      .select({ receiverId: records.receiverId, submittedAt: records.submittedAt })
      .from(records)
      .where(eq(records.id, recordId))
      .limit(1);
    receiverId = recRows[0]!.receiverId!;
    submittedAt = recRows[0]!.submittedAt as string;
    const recvUser = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, receiverId))
      .limit(1);
    receiverCookie = await login(recvUser[0]!.username);
  });

  afterAll(async () => {
    // 还原：notifications（FK 指向 records，先于记录行删）、自建记录子行、configs、审计水位线、会话
    await db.delete(notifications).where(gt(notifications.id, ntfHighWater));
    if (recordId) {
      await db.delete(alerts).where(eq(alerts.recordId, recordId));
      await db.delete(elevatorChecks).where(eq(elevatorChecks.recordId, recordId));
      await db.delete(recordVersions).where(eq(recordVersions.recordId, recordId));
      await db.delete(records).where(eq(records.id, recordId));
    }
    if (deadlineOriginal) {
      await db
        .update(configs)
        .set({ configValue: deadlineOriginal })
        .where(eq(configs.configKey, DEADLINE_CONFIG_KEY));
    }
    for (const id of settledObjectionIds) {
      await db.update(records).set({ escalatedAt: null }).where(eq(records.id, id));
    }
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  describe('F2-11-T1 接班人超时未确认 → 定时扫描 → 站内提醒', () => {
    it('阈值未到不提醒；过阈值扫描产生 confirm_due；重复扫描不重复', async () => {
      const hours = await jobs.confirmDueHours(); // 种子 2

      // 阈值未到（2h − 5min）：不提醒
      expect(await jobs.runConfirmDueScan(atOffset(submittedAt, hours * HOUR - 5 * 60_000))).toBe(
        0,
      );
      expect(await kindRows(receiverId, 'confirm_due')).toHaveLength(0);

      // 过阈值（2h + 5min）：提醒接班人
      expect(await jobs.runConfirmDueScan(atOffset(submittedAt, hours * HOUR + 5 * 60_000))).toBe(
        1,
      );
      const rows = await kindRows(receiverId, 'confirm_due');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.recordId).toBe(recordId);
      expect(rows[0]!.message).toContain(recordNo);

      // 重复扫描：去重不再发（防重复提醒）
      expect(await jobs.runConfirmDueScan(atOffset(submittedAt, hours * HOUR + 6 * 60_000))).toBe(
        0,
      );
      expect(await kindRows(receiverId, 'confirm_due')).toHaveLength(1);
    });

    it('GET /notifications 未读列表可见 → POST read 标记已读（幂等）→ 未读数回落', async () => {
      const list1 = (await request(server)
        .get(NOTIFICATIONS_API)
        .set('Cookie', receiverCookie)
        .expect(200)) as unknown as { body: NotificationListDto };
      expect(list1.body.unread).toBe(1); // 种子 confirm_due 演示行属 D0 当班人（wang），与本接班人无关
      const item = list1.body.items.find(
        (i) => i.kind === 'confirm_due' && i.record_id === recordId,
      );
      expect(item).toBeDefined();
      expect(item!.read_at).toBeNull();

      const read1 = (await request(server)
        .post(readApi(item!.id))
        .set('Cookie', receiverCookie)
        .expect(201)) as unknown as { body: NotificationReadResultDto };
      expect(read1.body.read_at).toBeTruthy();

      // 幂等：重复标记回首次时刻
      const read2 = (await request(server)
        .post(readApi(item!.id))
        .set('Cookie', receiverCookie)
        .expect(201)) as unknown as { body: NotificationReadResultDto };
      expect(read2.body.read_at).toBe(read1.body.read_at);

      const list2 = (await request(server)
        .get(NOTIFICATIONS_API)
        .set('Cookie', receiverCookie)
        .expect(200)) as unknown as { body: NotificationListDto };
      expect(list2.body.unread).toBe(0);
    });

    it('闸门：非本人通知 404（不泄露存在性）、未知 id 404、未登录 401', async () => {
      const mine = await kindRows(receiverId, 'confirm_due');
      const res = await request(server)
        .post(readApi(mine[0]!.id))
        .set('Cookie', chiefCookie)
        .expect(404);
      expect((res.body as { code: string }).code).toBe('NOT_FOUND');

      const res2 = await request(server)
        .post(readApi(999999999))
        .set('Cookie', receiverCookie)
        .expect(404);
      expect((res2.body as { code: string }).code).toBe('NOT_FOUND');

      await request(server).get(NOTIFICATIONS_API).expect(401);
    });
  });

  describe('F2-12-T1 异议 24 小时未解决 → 自动升级 → 提醒科长且不重复', () => {
    it('24h 内不升级；过 24h 扫描写 escalated_at 并通知科长；重复扫描不重复', async () => {
      const objectionRes = await request(server)
        .post(OBJECTION_API(recordId))
        .set('Cookie', receiverCookie)
        .send({ note: '水表读数疑似抄错，请核实（TK-22 F2-12 驱动）' })
        .expect(201);
      const objectionAt = (objectionRes.body as ObjectionResultDto).objection_at;
      const hours = await jobs.objectionEscalateHours(); // 种子 24

      // 24h 内：不升级
      expect(
        await jobs.runObjectionEscalationScan(atOffset(objectionAt, hours * HOUR - 30 * 60_000)),
      ).toBe(0);
      const notEscalated = await db
        .select({ escalatedAt: records.escalatedAt })
        .from(records)
        .where(eq(records.id, recordId))
        .limit(1);
      expect(notEscalated[0]!.escalatedAt).toBeNull();

      // 过 24h：escalated_at 写入 + 科长收到 objection_escalated（settle 轮给 D-2 的历史通知不计入）
      expect(
        await jobs.runObjectionEscalationScan(atOffset(objectionAt, hours * HOUR + 30 * 60_000)),
      ).toBe(1);
      const escalated = await db
        .select({ escalatedAt: records.escalatedAt })
        .from(records)
        .where(eq(records.id, recordId))
        .limit(1);
      expect(escalated[0]!.escalatedAt).toBeTruthy();

      const chiefRows = (await kindRows(chiefId, 'objection_escalated')).filter(
        (r) => r.recordId === recordId,
      );
      expect(chiefRows).toHaveLength(1);
      expect(chiefRows[0]!.message).toContain(recordNo);

      // 重复扫描：escalated_at 闸门防重复提醒
      expect(
        await jobs.runObjectionEscalationScan(atOffset(objectionAt, hours * HOUR + 60 * 60_000)),
      ).toBe(0);
      expect(
        (await kindRows(chiefId, 'objection_escalated')).filter((r) => r.recordId === recordId),
      ).toHaveLength(1);
    });
  });

  describe('F6-06-T1 应提交未提交 → 扫描提醒科长（日期+排班人；时点可配；窗口外不提醒）', () => {
    /** 当前班次 +N 天内、有排班且无记录的缺失班次（期望值从库动态计算，不硬编码） */
    async function missingDates(
      maxOffset: number,
    ): Promise<Array<{ dutyDate: string; realName: string }>> {
      const rows = await db
        .select({ dutyDate: schedules.dutyDate, realName: users.realName })
        .from(schedules)
        .innerJoin(users, eq(users.id, schedules.userId))
        .where(gte(schedules.dutyDate, plusDays(dutyDate, 1)));
      const dated = rows.filter((r) => r.dutyDate <= plusDays(dutyDate, maxOffset));
      if (dated.length === 0) return [];
      const existing = await db
        .select({ dutyDate: records.dutyDate })
        .from(records)
        .where(
          inArray(
            records.dutyDate,
            dated.map((d) => d.dutyDate),
          ),
        );
      const has = new Set(existing.map((e) => e.dutyDate));
      return dated.filter((d) => !has.has(d.dutyDate));
    }

    it('时点可配：deadline 23:59 时 D+7 未到点；改回 09:00 后同刻扫描 D+7 到点（日期+排班人）', async () => {
      const futureNoon = shanghaiNoon(plusDays(dutyDate, 8)); // D+8 正午：D+1～D+7 的截止全部涉及

      // 第一轮：临时把时点调到 23:59 → D+7（截止 D+8 23:59）未到点，只提醒 D+1～D+6
      await db
        .update(configs)
        .set({ configValue: '23:59' })
        .where(eq(configs.configKey, DEADLINE_CONFIG_KEY));
      const expected1 = await missingDates(6);
      expect(await jobs.runMissingSubmitScan(futureNoon)).toBe(expected1.length);
      for (const m of expected1) {
        const rows = await kindRows(chiefId, 'missing_submit');
        const hit = rows.find((r) => r.title === `${m.dutyDate} 应提交未提交`);
        expect(hit).toBeDefined(); // 通知含日期
        expect(hit!.message).toContain(`排班人：${m.realName}`); // 通知含排班人
      }
      expect(await kindRows(chiefId, 'missing_submit')).toHaveLength(expected1.length);

      // 第二轮：还原 09:00 → 同一刻扫描，恰好 D+7（截止 D+8 09:00 ≤ 正午）新增一条
      await db
        .update(configs)
        .set({ configValue: deadlineOriginal })
        .where(eq(configs.configKey, DEADLINE_CONFIG_KEY));
      const expected2 = await missingDates(7);
      expect(expected2.length).toBe(expected1.length + 1); // D+7 补入缺失集合
      expect(await jobs.runMissingSubmitScan(futureNoon)).toBe(1);
      const rows2 = await kindRows(chiefId, 'missing_submit');
      expect(rows2).toHaveLength(expected2.length);
      expect(rows2.find((r) => r.title === `${plusDays(dutyDate, 7)} 应提交未提交`)).toBeDefined();

      // 重复扫描：同班次不重复提醒（title 兼作去重键）
      expect(await jobs.runMissingSubmitScan(futureNoon)).toBe(0);
      expect(await kindRows(chiefId, 'missing_submit')).toHaveLength(expected2.length);
    });

    it('窗口外班次不提醒（补交窗口 D-T21 L3 对齐）：注入更远未来，缺失班次全部老化出窗', async () => {
      // currentShift 变为 D+16 → 扫描下界 D+9，种子排班最远 D+7：无可提醒班次；
      // 历史缺失班次（种子 D-14～D-11 有排班无记录）也从未被提醒（恒在窗口界外）
      const before = await kindRows(chiefId, 'missing_submit');
      expect(await jobs.runMissingSubmitScan(shanghaiNoon(plusDays(dutyDate, 16)))).toBe(0);
      expect(await kindRows(chiefId, 'missing_submit')).toHaveLength(before.length);
    });
  });

  describe('附加回归：会话过期存根行清理（技术方案 §6，运维卫生类）', () => {
    it('过期行删除、未过期行保留', async () => {
      const pastToken = 'a'.repeat(64);
      const futureToken = 'b'.repeat(64);
      const expiredAt = new Date(Date.now() - HOUR).toISOString().slice(0, 19).replace('T', ' ');
      const liveUntil = new Date(Date.now() + HOUR).toISOString().slice(0, 19).replace('T', ' ');
      await db.insert(sessions).values([
        { tokenHash: pastToken, userId: zhangId, channel: 'cookie', expiresAt: expiredAt },
        { tokenHash: futureToken, userId: zhangId, channel: 'cookie', expiresAt: liveUntil },
      ]);

      expect(await jobs.runSessionsCleanup(new Date())).toBe(1);
      const left = await db
        .select({ tokenHash: sessions.tokenHash })
        .from(sessions)
        .where(inArray(sessions.tokenHash, [pastToken, futureToken]));
      expect(left.map((r) => r.tokenHash)).toEqual([futureToken]);
      await db.delete(sessions).where(inArray(sessions.tokenHash, [pastToken, futureToken]));
    });
  });
});
