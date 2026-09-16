/**
 * TK-21 撤回窗口测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - F2-08-T1：提交后窗口内且未确认 → 撤回 → status=draft、submitted_at 清空、审计 record.withdraw（谁、何时）；
 * - F2-08-T2：撤回后重新提交 → version+1；
 * - F2-09-T2：撤回后 → 接班人待确认列表该单消失（入口同步消失，不留脏数据）；
 * - F2-10-T1/T2/T3：超窗口 / 接班人已确认 / 处于有异议 → 409 WITHDRAW_NOT_ALLOWED，
 *   reason 依次 WINDOW_EXPIRED / ALREADY_CONFIRMED / IN_OBJECTION（契约 §2 reason 字段）；
 * - 附加回归：撤回闸门（非交班人 403、chief 角色守卫 403、未登录 401、当前班次无记录 404、
 *   draft 重复撤回 409 同族）、GET /records/today 回传 withdraw_window_minutes（两端同源）。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`（接口用例强依赖
 * 当天重灌种子——C-08 班次边界跨灌种日后相邻班次落空档，任务分解修订 27 运维前提）；必须串行跑
 * （--runInBand）。自建记录（zhang 提交当班次，receiver=次日排班人），**不触碰种子 D-1**；
 * 窗口过期/已确认两态以 DB 直改 submitted_at/status 构造（confirm 全流程已由 records-confirm.spec
 * F2-05-T1 覆盖，此处只验撤回闸门对状态的判定）；afterAll 全部还原（含审计水位线）。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, gt } from 'drizzle-orm';
import request from 'supertest';
import type {
  PendingListDto,
  SubmitPayloadDto,
  SubmitResultDto,
  TodayDto,
  WithdrawResultDto,
} from '@handover/shared';
import { localMeasuredAt } from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import {
  alerts,
  auditLogs,
  elevatorChecks,
  recordVersions,
  records,
  sessions,
  users,
} from '../db/schema';
import { RecordsService } from './records.service';

const PASSWORD = 'Handover@2026';
const WITHDRAW_API = '/api/v1/records/today/withdraw';
const SUBMIT_API = '/api/v1/records/today/submit';
const PENDING_API = '/api/v1/records/pending';
const TODAY_API = '/api/v1/records/today';
const OBJECTION_API = (id: number) => `/api/v1/records/${id}/objection`;

/** 相邻上一班的班次日期（测试内联；与 duty-date.ts minusOneDay 同式，勿改口径） */
function minusOneDayOf(dutyDate: string): string {
  const d = new Date(`${dutyDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe('TK-21 撤回窗口（接口）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let auditHighWater = 0;
  let zhangCookie = ''; // 交班人（撤回主角）
  let receiverCookie = ''; // 次日排班接班人（待确认入口 / 标注异议）
  let chiefCookie = '';
  let zhangId = 0;
  let receiverId = 0;
  let dutyDate = '';
  let recordId = 0;
  let recordNo = '';
  let windowMinutes = 10; // GET /today 回传的撤回窗口（两端同源断言用）
  let payload: SubmitPayloadDto;

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

    zhangCookie = await login('zhang');
    chiefCookie = await login('chief');
    dutyDate = (await app.get(RecordsService).resolveDutyDate()).dutyDate;

    const zhangUser = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, 'zhang'))
      .limit(1);
    zhangId = zhangUser[0]!.id;

    // 种子相邻上一班（D-1）水表读数——防呆基线；缺失即显式失败（当天未重灌种子）
    const adjacent = await db
      .select({ water: records.waterReading })
      .from(records)
      .where(eq(records.dutyDate, minusOneDayOf(dutyDate)))
      .limit(1);
    const seedPrevWater = Number(adjacent[0]?.water ?? '0');
    if (!(seedPrevWater > 0)) {
      throw new Error(
        `相邻班次 ${minusOneDayOf(dutyDate)} 无种子记录——请先 db:setup 重灌种子（任务分解修订 27 运维前提）`,
      );
    }

    // 干净 payload（全 status=ok、handover_note 空、无电梯核对）→ 零标红行：撤回清 alerts 的
    // 断言不被标红重建干扰，且 F2-10-T2 的 completed 态无需走 acknowledge/confirm 全流程。
    // 读数基线高于种子 D-1（同 records-objection.spec），不命中防呆
    payload = {
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

    // 接班人 = 带出的次日排班人（DB 反查，不硬编码轮转账号）
    const recRows = await db
      .select({ receiverId: records.receiverId })
      .from(records)
      .where(eq(records.id, recordId))
      .limit(1);
    receiverId = recRows[0]!.receiverId!;
    const recvUser = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, receiverId))
      .limit(1);
    receiverCookie = await login(recvUser[0]!.username);
  });

  afterAll(async () => {
    // 还原：自建记录（alerts/elevator_checks/record_versions 子行——FK 无级联）与审计水位线以上
    if (recordId) {
      await db.delete(alerts).where(eq(alerts.recordId, recordId));
      await db.delete(elevatorChecks).where(eq(elevatorChecks.recordId, recordId));
      await db.delete(recordVersions).where(eq(recordVersions.recordId, recordId));
      await db.delete(records).where(eq(records.id, recordId));
    }
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  test('GET /records/today 回传 withdraw_window_minutes（服务端读 configs，两端同源）', async () => {
    const res = await request(server).get(TODAY_API).set('Cookie', zhangCookie).expect(200);
    const body = res.body as TodayDto;
    // 黄金值哨兵：种子 withdraw_window_minutes=10（《开发种子数据》§五，D-P05）
    expect(body.withdraw_window_minutes).toBe(10);
    windowMinutes = body.withdraw_window_minutes;
    expect(body.record?.status).toBe('submitted');
  });

  test('F2-08-T1 + F2-09-T2：窗口内撤回 → draft/清 submitted_at/审计留痕；待确认入口消失；重复撤回 409', async () => {
    // 撤回前：接班人待确认列表含本单（F2-02 取数口径 status=submitted）
    const before = await request(server).get(PENDING_API).set('Cookie', receiverCookie).expect(200);
    expect((before.body as PendingListDto).items.some((i) => i.id === recordId)).toBe(true);

    // 交班人窗口内撤回 → 201，转 draft、version 不变（重提才 +1，F2-08-T2）
    const res = await request(server).post(WITHDRAW_API).set('Cookie', zhangCookie).expect(201);
    const body = res.body as WithdrawResultDto;
    expect(body.id).toBe(recordId);
    expect(body.record_no).toBe(recordNo);
    expect(body.status).toBe('draft');
    expect(body.version).toBe(1);

    // 库内：status=draft、submitted_at 清空（回到可编辑，F2-08）；读数列保留（师傅继续改）
    const row = (
      await db
        .select({
          status: records.status,
          submittedAt: records.submittedAt,
          version: records.version,
          water: records.waterReading,
        })
        .from(records)
        .where(eq(records.id, recordId))
        .limit(1)
    )[0]!;
    expect(row.status).toBe('draft');
    expect(row.submittedAt).toBeNull();
    expect(row.version).toBe(1);
    expect(row.water).toBe('12300.0'); // 读数列保留

    // 撤回留痕（F2-08-T1 判据：audit_logs 谁、何时）：actor=交班人、old_value 记 submitted 起点
    const audit = (
      await db
        .select({
          actorId: auditLogs.actorId,
          oldValue: auditLogs.oldValue,
          newValue: auditLogs.newValue,
        })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'record.withdraw'), eq(auditLogs.targetId, recordNo)))
        .limit(1)
    )[0]!;
    expect(audit.actorId).toBe(zhangId);
    expect(audit.oldValue).toMatchObject({ status: 'submitted' });
    expect(audit.newValue).toMatchObject({ status: 'draft' });

    // F2-09-T2：撤回后接班人待确认列表该单消失（入口同步消失，不留脏数据）
    const after = await request(server).get(PENDING_API).set('Cookie', receiverCookie).expect(200);
    expect((after.body as PendingListDto).items.some((i) => i.id === recordId)).toBe(false);

    // draft 重复撤回 → 409 同族（无「撤回」语义，错误码 13 项不增设）
    const repeat = await request(server).post(WITHDRAW_API).set('Cookie', zhangCookie).expect(409);
    expect((repeat.body as { code: string }).code).toBe('CONFIRM_INCOMPLETE');
  });

  test('F2-08-T2：撤回后重新提交 → version+1', async () => {
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', zhangCookie)
      .send(payload)
      .expect(201);
    const body = res.body as SubmitResultDto;
    expect(body.id).toBe(recordId); // 同班次同一条（duty_date UNIQUE，draft 行走更新分支）
    expect(body.status).toBe('submitted');
    expect(body.version).toBe(2); // 撤回后重提版本 +1（F2-08-T2 判据）
  });

  test('F2-10-T1：超过撤回窗口 → 409 WITHDRAW_NOT_ALLOWED / reason=WINDOW_EXPIRED', async () => {
    // DB 直改 submitted_at 到窗口 + 1 分钟之前（时间注入，不真实等待）
    const expiredAt = localMeasuredAt(new Date(Date.now() - (windowMinutes + 1) * 60000));
    await db.update(records).set({ submittedAt: expiredAt }).where(eq(records.id, recordId));

    const res = await request(server).post(WITHDRAW_API).set('Cookie', zhangCookie).expect(409);
    const body = res.body as { code: string; reason: string; message: string };
    expect(body.code).toBe('WITHDRAW_NOT_ALLOWED');
    expect(body.reason).toBe('WINDOW_EXPIRED');
    expect(body.message).toContain('异议'); // 提示走异议流程（F2-10）

    // 还原 submitted_at 到当下（后续闸门/异议用例需窗口内）
    await db
      .update(records)
      .set({ submittedAt: localMeasuredAt(new Date()) })
      .where(eq(records.id, recordId));
  });

  test('撤回闸门：非交班人 403、chief 角色守卫 403、未登录 401', async () => {
    // 非交班人（接班人不可撤回交班人的单——撤回是交班人单方纠错，D-P05）
    const byReceiver = await request(server)
      .post(WITHDRAW_API)
      .set('Cookie', receiverCookie)
      .expect(403);
    expect((byReceiver.body as { code: string }).code).toBe('FORBIDDEN');
    // chief：角色守卫拦外（契约 §3.2 角色列 master，写链路不适用 chief 只读回写）
    const byChief = await request(server).post(WITHDRAW_API).set('Cookie', chiefCookie).expect(403);
    expect((byChief.body as { code: string }).code).toBe('FORBIDDEN');
    // 未登录 → 401
    await request(server).post(WITHDRAW_API).expect(401);
  });

  test('F2-10-T3：处于有异议 → 409 WITHDRAW_NOT_ALLOWED / reason=IN_OBJECTION', async () => {
    // 接班人标注异议（真实 API 路径，records-objection.spec 已验本体）→ status=objection
    await request(server)
      .post(OBJECTION_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ note: '水表读数存疑，请核对' })
      .expect(201);
    // 交班人撤回 → 409 IN_OBJECTION（异议锁定，走异议修改流程）
    const res = await request(server).post(WITHDRAW_API).set('Cookie', zhangCookie).expect(409);
    const body = res.body as { code: string; reason: string };
    expect(body.code).toBe('WITHDRAW_NOT_ALLOWED');
    expect(body.reason).toBe('IN_OBJECTION');
  });

  test('F2-10-T2：接班人已确认 → 409 WITHDRAW_NOT_ALLOWED / reason=ALREADY_CONFIRMED', async () => {
    // DB 直改 status=completed（confirm 全流程含签名/逐条知晓已由 records-confirm.spec F2-05-T1
    // 覆盖；此处只验撤回闸门对 completed 态的判定，状态检查先于窗口）
    await db
      .update(records)
      .set({ status: 'completed', confirmedAt: localMeasuredAt(new Date()) })
      .where(eq(records.id, recordId));
    const res = await request(server).post(WITHDRAW_API).set('Cookie', zhangCookie).expect(409);
    const body = res.body as { code: string; reason: string };
    expect(body.code).toBe('WITHDRAW_NOT_ALLOWED');
    expect(body.reason).toBe('ALREADY_CONFIRMED');
  });

  test('撤回闸门：当前班次无记录 → 404 NOT_FOUND', async () => {
    // 删除自建记录（末项用例，afterAll 再删无副作用）→ 当前班次无单可撤回
    await db.delete(alerts).where(eq(alerts.recordId, recordId));
    await db.delete(elevatorChecks).where(eq(elevatorChecks.recordId, recordId));
    await db.delete(recordVersions).where(eq(recordVersions.recordId, recordId));
    await db.delete(records).where(eq(records.id, recordId));
    const res = await request(server).post(WITHDRAW_API).set('Cookie', zhangCookie).expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });
});
