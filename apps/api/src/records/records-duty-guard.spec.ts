/**
 * TK-26 排班安全阀测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - **F6-05-T1 排班为甲、乙登录提交 → 409 要求确认 → 确认后提交成功并留痕**
 *   （audit action=record.guard_confirm）：登录提交人 ≠ 当日排班 → 409 DUTY_MISMATCH
 *   （need_confirm 携 type='duty_guard' 项与排班人姓名，文案同 PRD §6.6/demo）；随
 *   payload.duty_guard_confirm {confirmed:true} 重提放行，记录正常落库，审计
 *   record.guard_confirm 携排班基线（oldValue）/实际提交人（newValue）/调班原因（reason）。
 * - **F6-05-T2 排班不符且拒绝确认 → 不提交**（记录不落库）：不带确认、confirmed=false、
 *   畸形确认三种形态一律再 409，records 无该班次行。
 *
 * 同门语义补充用例（不新增清单行，比照 TK-16「同端点约束用例作回归防护」先例）：
 * - 当日排班人本人提交 → 不触发（门只对「不符者」上闸）；
 * - 排班一致时上送 duty_guard_confirm 被忽略（不写审计，同「未命中确认不入账」口径）；
 * - 当日无排班行 → 不判定（无可比基线，同防呆「任一侧缺失不判定」精神）；
 * - **补交班次排班归属校验**（D-T21 挂账闭环）：补交他人排班的历史班次 → 同一出口
 *   409 DUTY_MISMATCH，确认后放行（防冒名补交他人班次记在自己名下）。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * --runInBand 串行（与其它 spec 共库）。种子 D0/D-1 排班人从库反查（不硬编码轮值序——
 * 防同源盲区，records-submit.spec 先例）；提交成功用例用例内即删自建记录（duty_date 唯一，
 * 免后续 409 与补交重算的交叉）；「无排班」用例临时删当日排班行 try/finally 无条件还原
 * （records-submit.spec withoutTomorrowSchedule 同纪律）；审计断言一律按用例前水位过滤
 * （m3 纪律：afterAll 才统一截断，用例间互不看见对方的审计行）。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, gt } from 'drizzle-orm';
import request from 'supertest';
import type { SubmitPayloadDto, SubmitResultDto } from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, configs, records, schedules, sessions, users } from '../db/schema';
import { minusDays } from './duty-date';
import { recordNoOf, RecordsService } from './records.service';

const PASSWORD = 'Handover@2026';
const SUBMIT_API = '/api/v1/records/today/submit';
const BACKFILL_API = '/api/v1/records/backfill';

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

/**
 * 全量合法 payload（判据基准值，records-submit.spec 同式）：必填齐全、状态全「正常」、
 * 锅炉停机（三项停机列不参与必填）；读数全高于种子 D-1 基准，不命中防呆 409——
 * 本文件的安全阀判定不被防呆判定抢先（安全阀门在防呆 409 之前）。
 */
function fullPayload(over?: { guard?: { confirmed: boolean; reason?: string } }): SubmitPayloadDto {
  const p: SubmitPayloadDto = {
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
  if (over?.guard) {
    p.duty_guard_confirm = { confirmed: over.guard.confirmed, reason: over.guard.reason ?? '' };
  }
  return p;
}

describe('TK-26 排班安全阀（F6-05，接口）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let auditHighWater = 0;
  let dutyDate = '';
  /** 当日排班人（种子 D0 行从库反查；门比对的期望身份来源） */
  let dutyUser = { id: 0, username: '', real_name: '' };
  /** 与当日排班不符的另一位师傅（门的触发方；F6-05-T1/T2 登录者） */
  let otherUser = { id: 0, username: '', real_name: '' };
  /** 补交用例自建的记录日期（afterAll 兜底清理；种子历史行不动） */
  let backfillDate = '';

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

    dutyDate = (await app.get(RecordsService).resolveDutyDate()).dutyDate;

    const userRows = await db
      .select({
        id: users.id,
        username: users.username,
        realName: users.realName,
        role: users.role,
      })
      .from(users);
    const dutyRows = await db
      .select({ userId: schedules.userId })
      .from(schedules)
      .where(eq(schedules.dutyDate, dutyDate))
      .limit(1);
    if (!dutyRows[0]) throw new Error(`种子排班缺当日行（${dutyDate}），请先 db:setup 重灌种子`);
    const duty = userRows.find((u) => u.id === dutyRows[0]!.userId)!;
    dutyUser = { id: duty.id, username: duty.username, real_name: duty.realName };
    // 触发方 = 任意非当日排班的师傅（不硬编码轮值序，防同源盲区）
    const other = userRows.find((u) => u.role === 'master' && u.id !== dutyUser.id)!;
    otherUser = { id: other.id, username: other.username, real_name: other.realName };
  });

  afterAll(async () => {
    // 只删本文件自建行（当日提交用例 + 补交用例的自建日期）；种子历史行（D-10~D-1，含
    // alerts 子行）不碰——FK RESTRICT 下删除必失败，且种子数据本就不是本文件的所有物
    await db.delete(records).where(eq(records.dutyDate, dutyDate));
    if (backfillDate) await db.delete(records).where(eq(records.dutyDate, backfillDate));
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  /** 用例前审计水位（审计断言按「本用例起点之后」过滤，用例间互不看见对方行，m3 纪律） */
  async function auditHighNow(): Promise<number> {
    const rows = await db.select({ id: auditLogs.id }).from(auditLogs);
    return rows.reduce((max, r) => Math.max(max, r.id), auditHighWater);
  }

  /** 水位之后的 record.guard_confirm 审计行 */
  async function guardAudits(since: number): Promise<Array<typeof auditLogs.$inferSelect>> {
    const rows = await db.select().from(auditLogs).where(gt(auditLogs.id, since));
    return rows.filter((r) => r.action === 'record.guard_confirm');
  }

  /** 当前班次记录行（无则为 undefined） */
  async function recordRow() {
    const rows = await db.select().from(records).where(eq(records.dutyDate, dutyDate)).limit(1);
    return rows[0];
  }

  // ── F6-05-T1 排班不符 → 409 要求确认 → 确认后提交成功并留痕 ─────────

  describe('F6-05-T1 排班安全阀确认放行（audit action=record.guard_confirm）', () => {
    it('排班为甲、乙登录提交 → 409 DUTY_MISMATCH（need_confirm 携排班人，记录不落库）', async () => {
      const since = await auditHighNow();
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', await login(otherUser.username))
        .send(fullPayload())
        .expect(409);
      expect(res.body.code).toBe('DUTY_MISMATCH');
      const items = res.body.need_confirm as Array<{
        type: string;
        scheduled_name?: string;
        message: string;
      }>;
      expect(items).toHaveLength(1);
      expect(items[0]!.type).toBe('duty_guard');
      expect(items[0]!.scheduled_name).toBe(dutyUser.real_name);
      // 可解释文案（C-03）：排班人与实际登录人齐备（PRD §6.6 原文口径）
      expect(items[0]!.message).toContain(dutyUser.real_name);
      expect(items[0]!.message).toContain(otherUser.real_name);
      expect(await recordRow()).toBeUndefined();
      expect(await guardAudits(since)).toHaveLength(0);
    });

    it('确认实际当班后重提 → 201 落库，审计 record.guard_confirm 留痕（基线/提交人/原因）', async () => {
      const since = await auditHighNow();
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', await login(otherUser.username))
        .send(fullPayload({ guard: { confirmed: true, reason: '张师傅临时调班，顶班一天' } }))
        .expect(201);
      const body = res.body as SubmitResultDto;
      const row = await recordRow();
      expect(row).toBeTruthy();
      expect(row!.submitterId).toBe(otherUser.id);
      expect(row!.recordNo).toBe(recordNoOf(dutyDate));

      // 留痕（F6-05-T1 判据）：排班基线 vs 实际提交人对账两端齐备，原因入 reason 列
      const audits = await guardAudits(since);
      expect(audits).toHaveLength(1);
      const audit = audits[0]!;
      expect(audit.actorId).toBe(otherUser.id);
      expect(audit.targetType).toBe('record');
      expect(audit.targetId).toBe(body.record_no);
      expect(audit.oldValue).toMatchObject({
        user_id: dutyUser.id,
        real_name: dutyUser.real_name,
      });
      expect(audit.newValue).toMatchObject({
        user_id: otherUser.id,
        real_name: otherUser.real_name,
      });
      expect(audit.reason).toBe('张师傅临时调班，顶班一天');
      // 提交本体审计照常（record.submit），与 guard 留痕并行不悖
      const submits = (await db.select().from(auditLogs).where(gt(auditLogs.id, since))).filter(
        (r) => r.action === 'record.submit' && r.targetId === body.record_no,
      );
      expect(submits.length).toBeGreaterThanOrEqual(1);
      // 用例内即删自建记录（duty_date 唯一，免后续用例 409 RECORD_EXISTS）
      await db.delete(records).where(eq(records.dutyDate, dutyDate));
    });

    it('当日排班人本人提交 → 不触发安全阀（409 缺席，直接 201）', async () => {
      const since = await auditHighNow();
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', await login(dutyUser.username))
        .send(fullPayload())
        .expect(201);
      expect((res.body as SubmitResultDto).record_no).toBe(recordNoOf(dutyDate));
      expect(await guardAudits(since)).toHaveLength(0);
      await db.delete(records).where(eq(records.dutyDate, dutyDate));
    });

    it('排班一致时上送 duty_guard_confirm 被忽略（不写审计，同「未命中确认不入账」口径）', async () => {
      const since = await auditHighNow();
      // 排班人本人提交且显式带确认 → 不应产生任何 guard 审计行
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', await login(dutyUser.username))
        .send(fullPayload({ guard: { confirmed: true, reason: '多余确认' } }))
        .expect(201);
      expect(res.body.record_no).toBe(recordNoOf(dutyDate));
      expect(await guardAudits(since)).toHaveLength(0);
      await db.delete(records).where(eq(records.dutyDate, dutyDate));
    });
  });

  // ── F6-05-T2 拒绝确认 → 不提交 ──────────────────────────────────

  describe('F6-05-T2 排班不符且拒绝确认 → 不提交（记录不落库）', () => {
    it('未确认（缺省）/ confirmed=false / 畸形确认 → 均 409，records 无行', async () => {
      const since = await auditHighNow();
      const cookie = await login(otherUser.username);
      const cases: Array<[string, SubmitPayloadDto]> = [
        ['不带确认', fullPayload()],
        ['confirmed=false', fullPayload({ guard: { confirmed: false, reason: '不是我在当班' } })],
        // 畸形确认（confirmed 非布尔）：类型层断言放行，运行期服务端不得解锁也不得 500
        [
          '畸形确认',
          {
            ...fullPayload(),
            duty_guard_confirm: {
              confirmed: 'yes',
            } as unknown as SubmitPayloadDto['duty_guard_confirm'],
          },
        ],
      ];
      for (const [label, payload] of cases) {
        const res = await request(server)
          .post(SUBMIT_API)
          .set('Cookie', cookie)
          .send(payload)
          .expect(409);
        expect(`${label} → ${res.body.code}`).toBe(`${label} → DUTY_MISMATCH`);
        expect(await recordRow()).toBeUndefined();
      }
      expect(await guardAudits(since)).toHaveLength(0);
    });

    it('当日无排班行 → 不判定（无可比基线放行；排班行 try/finally 无条件还原）', async () => {
      const since = await auditHighNow();
      const saved = await db.select().from(schedules).where(eq(schedules.dutyDate, dutyDate));
      await db.delete(schedules).where(eq(schedules.dutyDate, dutyDate));
      try {
        const res = await request(server)
          .post(SUBMIT_API)
          .set('Cookie', await login(otherUser.username))
          .send(fullPayload())
          .expect(201);
        expect(res.body.record_no).toBe(recordNoOf(dutyDate));
        expect(await guardAudits(since)).toHaveLength(0);
      } finally {
        await db.delete(records).where(eq(records.dutyDate, dutyDate));
        const row = saved[0]!;
        await db.insert(schedules).values({ dutyDate: row.dutyDate, userId: row.userId });
      }
    });

    it('补交他人排班的历史班次 → 同一出口 409，确认后放行（D-T21 挂账归属校验闭环）', async () => {
      // 种子 D-10~D-1 已有历史记录（补交会撞 RECORD_EXISTS），选 D-11：有排班、无记录；
      // 但它在默认 7 天窗口外——比照 records-backfill.spec 手法临时把 backfill_window_days
      // 调为 30，finally 无条件还原（补交归属校验与窗口正交，窗口用例不归本文件）
      const target = minusDays(dutyDate, 11);
      backfillDate = target; // afterAll 兜底清理（本用例末自删，此处防 finally 链漏）
      const seedWindow = (
        await db
          .select({ v: configs.configValue })
          .from(configs)
          .where(eq(configs.configKey, 'backfill_window_days'))
          .limit(1)
      )[0]!.v;
      const tRows = await db
        .select({ userId: schedules.userId })
        .from(schedules)
        .where(eq(schedules.dutyDate, target))
        .limit(1);
      if (!tRows[0]) throw new Error(`种子排班缺 ${target}（D-11）——种子覆盖 D-14~D+7`);
      expect(
        await db.select({ id: records.id }).from(records).where(eq(records.dutyDate, target)),
      ).toHaveLength(0); // 种子哨兵：D-11 无历史记录
      // 以「非该班次排班人」的身份补交（排班人本人补交不触发，属常规链路）
      const impostor = tRows[0].userId === otherUser.id ? dutyUser : otherUser;
      const payload = { ...fullPayload(), duty_date: target } as SubmitPayloadDto & {
        duty_date: string;
      };
      const cookie = await login(impostor.username);
      const since = await auditHighNow();
      try {
        await db
          .update(configs)
          .set({ configValue: '30' })
          .where(eq(configs.configKey, 'backfill_window_days'));

        const denied = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', cookie)
          .send(payload)
          .expect(409);
        expect(denied.body.code).toBe('DUTY_MISMATCH');
        expect(
          (denied.body.need_confirm as Array<{ scheduled_name: string }>)[0]!.scheduled_name,
        ).toBeTruthy();
        expect(
          await db.select({ id: records.id }).from(records).where(eq(records.dutyDate, target)),
        ).toHaveLength(0);

        const allowed = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', cookie)
          .send({
            ...payload,
            duty_guard_confirm: { confirmed: true, reason: '当日实际由我顶班，现补交' },
          })
          .expect(201);
        expect((allowed.body as SubmitResultDto).record_no).toBe(recordNoOf(target));
        const audits = await guardAudits(since);
        expect(audits).toHaveLength(1);
        expect(audits[0]!.reason).toBe('当日实际由我顶班，现补交');
        expect(audits[0]!.oldValue).toMatchObject({ user_id: tRows[0].userId });
      } finally {
        await db
          .update(configs)
          .set({ configValue: seedWindow })
          .where(eq(configs.configKey, 'backfill_window_days'));
        await db.delete(records).where(eq(records.dutyDate, target));
        backfillDate = '';
      }
    });
  });
});
