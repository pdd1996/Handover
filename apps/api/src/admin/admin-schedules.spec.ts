/**
 * TK-26 排班管理测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - **F6-03-T1 修改排班 → 审计 → 记录新旧值**（schedules 与 audit_logs 一致）：
 *   PUT /admin/schedules 单日 upsert（一天一人 duty_date UNIQUE，契约 §3.6）→
 *   变更与审计 `schedule.update` 同事务，oldValue/newValue 搔 `{user_id, real_name}` 前后值、
 *   targetId = duty_date、操作人/时刻即 actor_id/created_at；同值重复 PUT 值无变化
 *   不写审计（D-T21 M1 同一精神）；新增日（无排班行）oldValue=null；
 *   参数违法（非日历日 / 未知或 chief 值班人 / 非法 month）400 逐条点名。
 * - **F6-04-T1 某日提交交接单 → 接班人 → 自动为次日排班人**（带出与排班表一致；
 *   漏交检测数据可查）：提交链路消费同一张 schedules 表——submit 响应 receiver = 次日
 *   （D+1）排班人；GET /admin/missing-submits 返回 200 且排班人姓名与 users 同源
 *   （黄金值对账归 admin.spec 注入时刻用例，本文件只断「可查」与同源）。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * --runInBand 串行（与其它 spec 共库）。改派用例 try/finally 还原种子行（含清空
 * updated_by/updated_at，保持种子行形态）；F6-04 自建记录用例内即删（duty_date 唯一）；
 * afterAll 还原审计（高水位截断）与会话存根。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, gt, gte, lte } from 'drizzle-orm';
import request from 'supertest';
import type {
  MissingSubmitListDto,
  ScheduleMonthDto,
  SubmitPayloadDto,
  SubmitResultDto,
} from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, records, schedules, sessions, users } from '../db/schema';
import { localWallClock, plusOneDay } from '../records/duty-date';
import { RecordsService } from '../records/records.service';

const PASSWORD = 'Handover@2026';
const SCHEDULES_API = '/api/v1/admin/schedules';
const MISSING_SUBMITS_API = '/api/v1/admin/missing-submits';
const SUBMIT_API = '/api/v1/records/today/submit';

/** DATA-01 液氧 8 项读数（两罐两时点含量/压力；台账 DATA-01 原文清单） */
const LO_EIGHT: readonly string[] = [
  't1_c830',
  't1_p830',
  't2_c830',
  't2_p830',
  't1_c2030',
  't1_p2030',
  't2_c2030',
  't2_p2030',
];

/** 月份最后一天（YYYY-MM → YYYY-MM-DD；UTC 日历算术，与 AdminService.schedulesMonth 同式） */
function lastDayOfMonth(month: string): string {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * 全量合法 payload（判据基准值，records-submit.spec 同式）：状态全「正常」→ 备注类条件
 * 必填不触发；锅炉选「停机」→ 三项停机列不参与必填。读数全部高于种子 D-1 基准，不命中防呆。
 */
function fullPayload(): SubmitPayloadDto {
  return {
    sections: {
      water_reading: '12300.0',
      e1_reading: '53500.0',
      e2_reading: '43200.0',
      hp_status: 'ok',
      g1_remaining: '300.0',
      g2_remaining: '200.0',
      tank_in_use: 1,
      ...Object.fromEntries(LO_EIGHT.map((n) => [n, n.includes('_p') ? '0.80' : '5000.00'])),
      lo_measured_am: '2026-09-17 08:12:00',
      lo_measured_pm: '2026-09-17 20:15:00',
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
      supply_temp: '65.5',
      boiler_no: '1号',
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
    },
  };
}

describe('TK-26 排班管理与安全阀（接口）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let auditHighWater = 0;
  let chiefCookie = '';
  let dutyDate = '';
  let chiefId = 0;
  /** 种子 D+1 排班行原状（改派用例 finally 还原，保持种子行形态） */
  let seedNext: { dutyDate: string; userId: number; updatedBy: number | null } | undefined;
  /** 当日排班人（F6-04 提交用例以该人登录，规避 F6-05 安全阀 409 的交叉干扰） */
  let dutyUser = { id: 0, username: '', real_name: '' };
  let masters: Array<{ id: number; username: string; real_name: string }> = [];

  async function login(username: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username, password: PASSWORD })
      .expect(200);
    return String(res.headers['set-cookie']?.[0] ?? '');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get<Db>(DB);
    server = app.getHttpServer() as Server;

    await db.delete(sessions);
    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);

    chiefCookie = await login('chief');
    dutyDate = (await app.get(RecordsService).resolveDutyDate()).dutyDate;

    const userRows = await db
      .select({
        id: users.id,
        username: users.username,
        realName: users.realName,
        role: users.role,
      })
      .from(users);
    chiefId = userRows.find((u) => u.role === 'chief')!.id;
    masters = userRows
      .filter((u) => u.role === 'master')
      .map((u) => ({ id: u.id, username: u.username, real_name: u.realName }));

    const dutyRows = await db
      .select({ userId: schedules.userId })
      .from(schedules)
      .innerJoin(users, eq(users.id, schedules.userId))
      .where(eq(schedules.dutyDate, dutyDate))
      .limit(1);
    const duty = userRows.find((u) => u.id === dutyRows[0]!.userId)!;
    dutyUser = { id: duty.id, username: duty.username, real_name: duty.realName };

    const nextRows = await db
      .select({
        dutyDate: schedules.dutyDate,
        userId: schedules.userId,
        updatedBy: schedules.updatedBy,
      })
      .from(schedules)
      .where(eq(schedules.dutyDate, plusOneDay(dutyDate)))
      .limit(1);
    seedNext = nextRows[0];
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  /** schedule.update 审计行（按高水位过滤，只看本文件新增） */
  /** 用例前审计水位（审计断言按「本用例起点之后」过滤，用例间互不看见对方行，m3 纪律） */
  async function auditHighNow(): Promise<number> {
    const rows = await db.select({ id: auditLogs.id }).from(auditLogs);
    return rows.reduce((max, r) => Math.max(max, r.id), auditHighWater);
  }

  /** 水位之后的 schedule.update 审计行 */
  async function scheduleAudits(since: number): Promise<Array<typeof auditLogs.$inferSelect>> {
    const rows = await db.select().from(auditLogs).where(gt(auditLogs.id, since));
    return rows.filter((r) => r.action === 'schedule.update');
  }

  // ── F6-03-T1 修改排班 → 审计 → 记录新旧值 ─────────────────────────

  describe('F6-03-T1 排班月视图维护（GET/PUT /admin/schedules）', () => {
    it('GET 月视图黄金值：种子行稀疏列示、duty_date 升序、形状键集、姓名与 users 同源', async () => {
      const res = await request(server)
        .get(`${SCHEDULES_API}?month=${dutyDate.slice(0, 7)}`)
        .set('Cookie', chiefCookie)
        .expect(200);
      const body = res.body as ScheduleMonthDto;

      expect(body.month).toBe(dutyDate.slice(0, 7));
      // 升序 + 全部落在查询月内
      const dates = body.items.map((i) => i.duty_date);
      expect([...dates].sort()).toEqual(dates);
      for (const d of dates) expect(d.startsWith(body.month)).toBe(true);

      // 形状键集（契约权威形状 shared ScheduleItemDto）
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'duty_date',
          'real_name',
          'updated_at',
          'user_id',
        ]);
      }
      // 姓名与 users 表同源（从库反查，不硬编码种子值）
      const nameOf = new Map(masters.map((m) => [m.id, m.real_name]));
      for (const item of body.items) expect(item.real_name).toBe(nameOf.get(item.user_id));

      // 种子排班 D-14~D+7 落在本月的部分必须全部出现（种子哨兵，跨灌种日缺位即红）
      const seeded = await db
        .select({ dutyDate: schedules.dutyDate })
        .from(schedules)
        .where(
          and(
            gte(schedules.dutyDate, `${body.month}-01`),
            lte(schedules.dutyDate, lastDayOfMonth(body.month)),
          ),
        );
      const got = new Set(body.items.map((i) => i.duty_date));
      for (const row of seeded) {
        expect(got.has(row.dutyDate) ? 'ok' : `种子排班 ${row.dutyDate} 未出现在月视图`).toBe('ok');
      }
    });

    it('GET 缺省 month → 当前墙钟月；非法 month → 400 点名 month', async () => {
      const def = await request(server).get(SCHEDULES_API).set('Cookie', chiefCookie).expect(200);
      expect((def.body as ScheduleMonthDto).month).toBe(
        localWallClock(new Date()).date.slice(0, 7),
      );

      const bad = await request(server)
        .get(`${SCHEDULES_API}?month=2026-13`)
        .set('Cookie', chiefCookie)
        .expect(400);
      expect(bad.body.code).toBe('VALIDATION_OUT_OF_RANGE');
      expect(bad.body.missing_fields.map((m: { field: string }) => m.field)).toContain('month');
    });

    it('PUT 改派 D+1 → changed=true、库内行与 updated_by 更新、审计新旧值与操作人齐备', async () => {
      const target = masters.find((m) => m.id !== seedNext!.userId)!;
      const since = await auditHighNow();
      try {
        const res = await request(server)
          .put(SCHEDULES_API)
          .set('Cookie', chiefCookie)
          .send({ duty_date: seedNext!.dutyDate, user_id: target.id })
          .expect(200);
        expect(res.body).toMatchObject({
          duty_date: seedNext!.dutyDate,
          user_id: target.id,
          real_name: target.real_name,
          changed: true,
        });
        expect(res.body.updated_at).toBeTruthy();

        // 库内行与审计一致（F6-03-T1 判据「schedules 与 audit_logs 一致」）
        const row = (
          await db.select().from(schedules).where(eq(schedules.dutyDate, seedNext!.dutyDate))
        )[0]!;
        expect(row.userId).toBe(target.id);
        expect(row.updatedBy).toBe(chiefId);
        expect(row.updatedAt).toBe(res.body.updated_at);

        const audits = await scheduleAudits(since);
        expect(audits).toHaveLength(1);
        const audit = audits[0]!;
        expect(audit.targetType).toBe('schedule');
        expect(audit.targetId).toBe(seedNext!.dutyDate);
        expect(audit.actorId).toBe(chiefId);
        expect(audit.oldValue).toMatchObject({
          user_id: seedNext!.userId,
          real_name: masters.find((m) => m.id === seedNext!.userId)!.real_name,
        });
        expect(audit.newValue).toMatchObject({ user_id: target.id, real_name: target.real_name });
      } finally {
        // 还原种子行（清空 updated_by/updated_at，保持种子形态；不影响他 spec 的带出取数）
        await db
          .update(schedules)
          .set({ userId: seedNext!.userId, updatedBy: null, updatedAt: null })
          .where(eq(schedules.dutyDate, seedNext!.dutyDate));
      }
    });

    it('PUT 同值重复 → changed=false、不写审计（D-T21 M1 同一精神）', async () => {
      const since = await auditHighNow();
      const res = await request(server)
        .put(SCHEDULES_API)
        .set('Cookie', chiefCookie)
        .send({ duty_date: seedNext!.dutyDate, user_id: seedNext!.userId })
        .expect(200);
      expect(res.body.changed).toBe(false);
      expect(res.body.updated_at).toBeNull();
      expect(await scheduleAudits(since)).toHaveLength(0);
    });

    it('PUT 新增日（种子 D+8 无排班行）→ 建行 + 审计 oldValue=null', async () => {
      // 种子排班覆盖 D-14~D+7，D+8 必无行（种子哨兵；命中即红，防用例语义漂移）
      const dPlus8 = new Date(`${dutyDate}T00:00:00Z`);
      dPlus8.setUTCDate(dPlus8.getUTCDate() + 8);
      const target = dPlus8.toISOString().slice(0, 10);
      const existing = await db
        .select({ id: schedules.id })
        .from(schedules)
        .where(eq(schedules.dutyDate, target));
      expect(existing).toHaveLength(0);
      const pick = masters[0]!;
      const since = await auditHighNow();
      try {
        const res = await request(server)
          .put(SCHEDULES_API)
          .set('Cookie', chiefCookie)
          .send({ duty_date: target, user_id: pick.id })
          .expect(200);
        expect(res.body).toMatchObject({
          duty_date: target,
          user_id: pick.id,
          real_name: pick.real_name,
          changed: true,
        });
        const audits = await scheduleAudits(since);
        expect(audits).toHaveLength(1);
        expect(audits[0]!.oldValue).toBeNull();
        expect(audits[0]!.newValue).toMatchObject({ user_id: pick.id, real_name: pick.real_name });
      } finally {
        await db.delete(schedules).where(eq(schedules.dutyDate, target));
      }
    });

    it('参数违法 400 逐条点名：非日历日 duty_date、未知/chief 值班人 user_id', async () => {
      const since = await auditHighNow();
      const bad = await request(server)
        .put(SCHEDULES_API)
        .set('Cookie', chiefCookie)
        .send({ duty_date: '2026-02-30', user_id: masters[0]!.id })
        .expect(400);
      expect(bad.body.missing_fields.map((m: { field: string }) => m.field)).toContain('duty_date');

      const unknown = await request(server)
        .put(SCHEDULES_API)
        .set('Cookie', chiefCookie)
        .send({ duty_date: plusOneDay(dutyDate), user_id: 99999 })
        .expect(400);
      expect(unknown.body.missing_fields.map((m: { field: string }) => m.field)).toContain(
        'user_id',
      );

      const chiefTarget = await request(server)
        .put(SCHEDULES_API)
        .set('Cookie', chiefCookie)
        .send({ duty_date: plusOneDay(dutyDate), user_id: chiefId })
        .expect(400);
      expect(chiefTarget.body.missing_fields.map((m: { field: string }) => m.field)).toContain(
        'user_id',
      );
      expect(await scheduleAudits(since)).toHaveLength(0);
    });
  });

  // ── F6-04-T1 排班驱动带出与漏交检测 ──────────────────────────────

  describe('F6-04-T1 排班驱动接班人自动带出与漏交检测', () => {
    it('提交 → 接班人 = 次日（D+1）排班人；漏交检测数据可查且姓名同源', async () => {
      const tomorrow = await db
        .select({ userId: schedules.userId })
        .from(schedules)
        .where(eq(schedules.dutyDate, plusOneDay(dutyDate)))
        .limit(1);
      expect(tomorrow[0]).toBeTruthy(); // 种子哨兵：D+1 有排班

      // 以当日排班人登录提交（规避 F6-05 安全阀 409 的交叉，本用例只验带出）
      const cookie = await login(dutyUser.username);
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', cookie)
        .send(fullPayload())
        .expect(201);
      const body = res.body as SubmitResultDto;
      expect(body.receiver).toMatchObject({ id: tomorrow[0]!.userId });
      expect(body.receiver!.real_name).toBe(
        masters.find((m) => m.id === tomorrow[0]!.userId)!.real_name,
      );
      await db.delete(records).where(eq(records.dutyDate, dutyDate));

      // 漏交检测数据可查（F6-04-T1 后半判据）：视图 200、行形状与姓名同源
      // （黄金值对账归 admin.spec 注入时刻用例；实时列表因墙钟时刻不同而不同，不硬断行集）
      const miss = await request(server)
        .get(MISSING_SUBMITS_API)
        .set('Cookie', chiefCookie)
        .expect(200);
      const missBody = miss.body as MissingSubmitListDto;
      expect(Array.isArray(missBody.items)).toBe(true);
      const nameOf = new Map(masters.map((m) => [m.id, m.real_name]));
      for (const item of missBody.items) {
        expect(Object.keys(item).sort()).toEqual(['duty_date', 'real_name', 'user_id']);
        expect(item.real_name).toBe(nameOf.get(item.user_id));
      }
    });

    it('改派 D+1 后带出随之生效（F6-03 落库 → F6-04 消费同一张表）', async () => {
      const target = masters.find((m) => m.id !== seedNext!.userId)!;
      try {
        await request(server)
          .put(SCHEDULES_API)
          .set('Cookie', chiefCookie)
          .send({ duty_date: seedNext!.dutyDate, user_id: target.id })
          .expect(200);

        const cookie = await login(dutyUser.username);
        const res = await request(server)
          .post(SUBMIT_API)
          .set('Cookie', cookie)
          .send(fullPayload())
          .expect(201);
        expect((res.body as SubmitResultDto).receiver).toMatchObject({
          id: target.id,
          real_name: target.real_name,
        });
      } finally {
        await db.delete(records).where(eq(records.dutyDate, dutyDate));
        await db
          .update(schedules)
          .set({ userId: seedNext!.userId, updatedBy: null, updatedAt: null })
          .where(eq(schedules.dutyDate, seedNext!.dutyDate));
      }
    });
  });
});
