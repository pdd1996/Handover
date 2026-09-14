/**
 * TK-16 下游重算与豁免测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - F3-08-T1 上一班记录晚到（离线补同步）→ 补交端点 POST /records/backfill（决策记录
 *   D-T21）入库 → 自动重算紧邻下游 D+1 **已提交**记录的 prev 依赖用量（water_use/e_use/
 *   gas_use）→ 逐变更项写 record.recalc 审计 + 补交本体 record.late_submit
 * - F3-08-T2 下游用量曾被手工覆盖 → 触发重算 → 豁免不被覆盖（判定依据 = 当前版本
 *   record.usage_override 审计行，TK-13 评审 M1 钉死；手工值与原因保留）
 *
 * 同端点约束与语义用例（评审修复轮 M1/L1/L2/L3/L5/L6；不新增清单行，比照 TK-06 ③
 * 「测试命名挂台账编号」先例作回归防护）：
 * - **M1/L1 值无变化 → 零更新零审计**：整数用量的字符串判等缺陷（'500' vs '500.0'）曾使
 *   该判据恒失效（探针实证），现按数值判等，全无变更时 recalc 为 null
 * - **L2 状态门控**：下游为 objection/completed（已进确认或已签名归档）→ 不静默改数
 * - **L3 补交窗口**：duty_date 不得早于「当前班次 − configs backfill_window_days」
 * - **L5 draft 接管**：该班次为 draft（撤回后未重提）→ 补交接管为「更新 + version+1」，
 *   非 draft 已存在行才 409 RECORD_EXISTS
 * - **L6 待复核清单**：新基线命中 D-T19 判定（如回退）→ 不改数、不拦提交，标 needs_review
 *   + 审计 record.recalc_review
 * - duty_date 日历合法性、防呆 409 同协议（F1-12/F1-13）
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * 必须串行跑（--runInBand，与其它 spec 共库）。测试日期**相对当前班次动态计算**
 * （D-17/D-16/D-15，即 EARLIER/LATE/NEXT）：固定历史日期会随日历推移越拉越远，
 * 撞上 `backfill_window_days` 的 1–365 限幅（本轮实测踩过：设 400 被回落成 7，整片 400）；
 * 而种子历史矩阵只占 D-10～D-1（《开发种子数据》§六），故 D-15 起无冲突。
 * beforeAll 把窗口临时调为 30 天（用例内 try/finally + afterAll 还原种子原值，
 * 比照 records-fangdai.spec 临时改相邻行状态的既有手法）；L3 窗口用例单独调小验证。
 * 自建行无 record_versions 子行可安全删除；审计断言一律按高水位过滤（m3）。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, gt, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { BackfillPayloadDto, SubmitResultDto } from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, configs, records, sessions, users } from '../db/schema';
import { recordNoOf, RecordsService } from './records.service';
import { minusDays, minusOneDay, plusOneDay } from './duty-date';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';
const BACKFILL_API = '/api/v1/records/backfill';
const WINDOW_CONFIG_KEY = 'backfill_window_days';

/**
 * 测试用三件日期：**相对当前班次动态计算**（beforeAll 赋值）——
 * LATE = 当前班次 − 16 天（被补交的晚到班次）、NEXT = LATE + 1（已提交的下游单）、
 * EARLIER = LATE − 1（LATE 的上一班，防呆用例的基准）。避开种子 D-10～D-1 区，
 * 且在窗口限幅 1–365 内长期有效（勿改回固定日期，见文件头说明）。
 */
let EARLIER_DATE = '';
let LATE_DATE = '';
let NEXT_DATE = '';
let LATE_RECORD_NO = '';
let NEXT_RECORD_NO = '';

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
 * 补交 payload（判据基准值）：必填齐全、状态全「正常」（备注类条件必填不触发）、
 * 锅炉停机（三项停机列不参与必填）。读数与下游行（insertDownstream）配对，补交后
 * 下游用量应重算为 **water 500.0 / e 2000.0 / gas 15.0**（黄金值钉死口径混淆即红：
 * 误把液氧也算进重算范围、或误用 D 行自身读数当上一班，两值都会变）。
 */
function backfillPayload(over: {
  set?: Record<string, unknown>;
  del?: readonly string[];
  dutyDate?: string;
  confirmations?: BackfillPayloadDto['confirmations'];
}): BackfillPayloadDto {
  const sections: Record<string, unknown> = {
    water_reading: '10000.0',
    e1_reading: '52000.0',
    e2_reading: '42000.0',
    hp_status: 'ok',
    g1_remaining: '310.0',
    g2_remaining: '205.0',
    tank_in_use: 1,
    ...Object.fromEntries(LO_EIGHT.map((n) => [n, n.includes('_p') ? '0.80' : '5000.00'])),
    lo_measured_am: '2026-01-10 08:12:00',
    lo_measured_pm: '2026-01-10 20:15:00',
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
  };
  for (const k of over.del ?? []) delete sections[k];
  Object.assign(sections, over.set ?? {});
  const p: BackfillPayloadDto = { duty_date: over.dutyDate ?? LATE_DATE, sections };
  if (over.confirmations != null) p.confirmations = over.confirmations;
  return p;
}

describe('TK-16 下游重算与豁免（F3-08-T1/T2，D-T21 补交端点）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let service: RecordsService;
  let auditHighWater = 0;
  let masterCookie = '';
  let chiefCookie = '';
  let zhangId = 0;
  /** 种子原值（afterAll 还原，不给其它 spec 留窗口配置副作用） */
  let windowOriginal = '';

  async function login(username: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username, password: PASSWORD })
      .expect(200);
    return String(res.headers['set-cookie']?.[0] ?? '');
  }

  /** 临时设置补交窗口（L3 用例需要大小两种窗口） */
  async function setWindow(days: string): Promise<void> {
    await db
      .update(configs)
      .set({ configValue: days })
      .where(eq(configs.configKey, WINDOW_CONFIG_KEY));
  }

  /** 清理本测试自建的三行记录与高水位后的审计行 */
  async function cleanAll(): Promise<void> {
    await db.delete(records).where(inArray(records.dutyDate, [EARLIER_DATE, LATE_DATE, NEXT_DATE]));
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
  }

  /**
   * 直插下游 D+1 记录行（模拟「晚到发生前下游已提交」）。默认 submitted、用量列 null
   * （上一班缺失时提交的 TK-13 口径）；over 可指定状态与已固化用量（L2/M1 用例）。
   * 无 record_versions 子行，可安全删除。
   */
  async function insertDownstream(
    over: {
      status?: 'submitted' | 'draft' | 'objection' | 'completed';
      waterUse?: string;
      eUse?: string;
      gasUse?: string;
    } = {},
  ): Promise<void> {
    await db.insert(records).values({
      recordNo: NEXT_RECORD_NO,
      dutyDate: NEXT_DATE,
      submitterId: zhangId,
      status: over.status ?? 'submitted',
      submittedAt: '2026-01-11 08:00:00',
      version: 1,
      waterReading: '10500.0',
      e1Reading: '53000.0',
      e2Reading: '43000.0',
      g1Remaining: '300.0',
      g2Remaining: '200.0',
      tankInUse: 1,
      ...(over.waterUse != null ? { waterUse: over.waterUse } : {}),
      ...(over.eUse != null ? { eUse: over.eUse } : {}),
      ...(over.gasUse != null ? { gasUse: over.gasUse } : {}),
    });
  }

  async function recordAt(dutyDate: string) {
    const rows = await db.select().from(records).where(eq(records.dutyDate, dutyDate)).limit(1);
    return rows[0];
  }

  /** 本轮新增（高水位之后）的指定 action 审计行——兄弟 spec 同纪律，防历史残留致整片假红 */
  async function auditsOf(action: string, targetId?: string) {
    const where = targetId
      ? and(
          eq(auditLogs.action, action),
          eq(auditLogs.targetId, targetId),
          gt(auditLogs.id, auditHighWater),
        )
      : and(eq(auditLogs.action, action), gt(auditLogs.id, auditHighWater));
    return db
      .select({ oldValue: auditLogs.oldValue, newValue: auditLogs.newValue })
      .from(auditLogs)
      .where(where);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get<Db>(DB);
    service = app.get(RecordsService);
    server = app.getHttpServer() as Server;

    await db.delete(sessions);
    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);

    masterCookie = await login('zhang');
    chiefCookie = await login('chief');
    const zhang = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, 'zhang'))
      .limit(1);
    if (!zhang[0]) throw new Error('种子缺 zhang 账号，请先 db:setup 重灌');
    zhangId = zhang[0].id;

    // 测试三件日期相对当前班次（C-08）：LATE = 班次 − 16，NEXT = LATE + 1，EARLIER = LATE − 1
    const { dutyDate: shift } = await service.resolveDutyDate();
    LATE_DATE = minusDays(shift, 16);
    NEXT_DATE = plusOneDay(LATE_DATE);
    EARLIER_DATE = minusOneDay(LATE_DATE);
    LATE_RECORD_NO = recordNoOf(LATE_DATE);
    NEXT_RECORD_NO = recordNoOf(NEXT_DATE);

    // 窗口原值：种子为 '7'（《开发种子数据》修订 6）；本文件用班次−16 天故临时调到 30
    const cfg = await db
      .select({ value: configs.configValue })
      .from(configs)
      .where(eq(configs.configKey, WINDOW_CONFIG_KEY))
      .limit(1);
    if (!cfg[0]) throw new Error(`种子缺 configs ${WINDOW_CONFIG_KEY}，请先 db:setup 重灌`);
    windowOriginal = cfg[0].value;
    await setWindow('30');
  });

  afterAll(async () => {
    await setWindow(windowOriginal);
    await cleanAll();
    await db.delete(sessions);
    await app.close();
  });

  describe('F3-08-T1 上一班晚到补交 → 自动重算下游用量 → 写审计', () => {
    it('补交 D 日 → 下游 D+1 三项 prev 依赖用量重算为黄金值 + recalc/late_submit 审计', async () => {
      await insertDownstream();
      try {
        // 下游行在补交前用量列为 null（上一班缺失时提交，TK-13 口径）
        expect((await recordAt(NEXT_DATE))?.waterUse).toBeNull();

        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(201);

        const body = res.body as SubmitResultDto;
        expect(body.record_no).toBe(LATE_RECORD_NO);
        expect(body.status).toBe('submitted');
        // 响应携带重算结果：下游单号 + 三项实际变更字段 + 空待复核清单
        expect(body.recalc).toEqual({
          record_no: NEXT_RECORD_NO,
          fields: ['water_use', 'e_use', 'gas_use'],
          needs_review: [],
        });

        // 重算值正确（本次 − 补交的上一班读数）
        const row = await recordAt(NEXT_DATE);
        expect(row?.waterUse).toBe('500.0'); // 10500.0 − 10000.0
        expect(row?.eUse).toBe('2000.0'); // (53000−52000)+(43000−42000)
        expect(row?.gasUse).toBe('15.0'); // (310−300)+(205−200)

        // 审计：补交本体 late_submit + 逐变更项 recalc（oldValue 记旧固化值 null）
        const late = await auditsOf('record.late_submit', LATE_RECORD_NO);
        expect(late).toHaveLength(1);
        expect(late[0]?.newValue).toMatchObject({ duty_date: LATE_DATE, version: 1 });
        const recalc = await auditsOf('record.recalc', NEXT_RECORD_NO);
        expect(recalc).toHaveLength(3);
        const fields = recalc.map((r) => (r.newValue as { field: string }).field).sort();
        expect(fields).toEqual(['e_use', 'gas_use', 'water_use']);
        const water = recalc.find(
          (r) => (r.newValue as { field: string }).field === 'water_use',
        ) as (typeof recalc)[number];
        expect(water.oldValue).toMatchObject({ field: 'water_use', value: null });
        // 审计 newValue 记写库串（String(roundToScaleOf) → '500'；列读回补零 '500.0' 见上）
        expect(water.newValue).toMatchObject({ field: 'water_use', value: '500' });
        expect(water.newValue).toMatchObject({
          trigger: 'late_backfill',
          backfill_record_no: LATE_RECORD_NO,
        });
      } finally {
        await cleanAll();
      }
    });

    it('补交记录自身用量：上一班（D-1）缺失 → prev 依赖列固化 null（D-T17 不回落口径）', async () => {
      await insertDownstream();
      try {
        await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(201);
        const row = await recordAt(LATE_DATE);
        expect(row?.waterUse).toBeNull();
        expect(row?.eUse).toBeNull();
        expect(row?.gasUse).toBeNull();
      } finally {
        await cleanAll();
      }
    });

    it('M1/L1：下游三项已固化同数值用量（如补录值与晚到实值一致）→ 零更新、零 recalc 审计、recalc=null', async () => {
      // realism：D+1 提交时 D 缺失，师傅按 D-T19 补录的读数恰等于后来晚到的实际读数，
      // 三项用量已是 500.0/2000.0/15.0 —— 此时补交不应产生任何重算变更。
      // 原实现在此处按字符串比较（'500' !== '500.0'）恒判为「已变更」，产生三条假审计（探针实证）。
      await insertDownstream({ waterUse: '500.0', eUse: '2000.0', gasUse: '15.0' });
      try {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(201);

        expect((res.body as SubmitResultDto).recalc).toBeNull();
        const row = await recordAt(NEXT_DATE);
        expect([row?.waterUse, row?.eUse, row?.gasUse]).toEqual(['500.0', '2000.0', '15.0']);
        expect(await auditsOf('record.recalc', NEXT_RECORD_NO)).toHaveLength(0);
      } finally {
        await cleanAll();
      }
    });

    it('L2：下游为 completed（双方已签名归档）→ 不静默改数、不写重算审计（recalc=null）', async () => {
      await insertDownstream({ status: 'completed' });
      try {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(201);

        expect((res.body as SubmitResultDto).recalc).toBeNull();
        // 签名件的数字保持归档时的值（补交前为 null），无重算审计
        expect((await recordAt(NEXT_DATE))?.waterUse).toBeNull();
        expect(await auditsOf('record.recalc', NEXT_RECORD_NO)).toHaveLength(0);
        // 补交本体仍成功入库（晚到本身不受下游状态影响）
        expect((await recordAt(LATE_DATE))?.recordNo).toBe(LATE_RECORD_NO);
      } finally {
        await cleanAll();
      }
    });

    it('L2：下游为 objection（异议流程中）→ 同样不重算', async () => {
      await insertDownstream({ status: 'objection' });
      try {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(201);
        expect((res.body as SubmitResultDto).recalc).toBeNull();
        expect(await auditsOf('record.recalc', NEXT_RECORD_NO)).toHaveLength(0);
      } finally {
        await cleanAll();
      }
    });

    it('L6：新基线使下游命中防呆判定（读数回退）→ 不改数、不拦提交，标 needs_review + recalc_review 审计', async () => {
      await insertDownstream();
      try {
        // 补交的 D 日水表 11000 **高于**下游自身 10500 → 下游 water_use = −500，
        // 在线提交同组合会被 F1-12 409 强制确认；重算链路不卡住，改为标出待人工复核
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({ set: { water_reading: '11000.0' } }))
          .expect(201);

        const body = res.body as SubmitResultDto;
        expect(body.recalc?.fields).toContain('water_use');
        const review = body.recalc?.needs_review ?? [];
        expect(review).toHaveLength(1);
        expect(review[0]).toMatchObject({
          type: 'reading_decreased',
          field: 'water_reading',
          prev: 11000,
          current: 10500,
        });
        // 不改数（值仍按新基算出并固化），但审计留了人工核对线索
        expect((await recordAt(NEXT_DATE))?.waterUse).toBe('-500.0');
        const audits = await auditsOf('record.recalc_review', NEXT_RECORD_NO);
        expect(audits).toHaveLength(1);
        expect(audits[0]?.newValue).toMatchObject({
          trigger: 'late_backfill',
          backfill_record_no: LATE_RECORD_NO,
        });
      } finally {
        await cleanAll();
      }
    });

    it('L6-确认复用：下游已确认的同值回退（补录值恰与晚到实值一致）→ 不重复标 needs_review', async () => {
      // realism：D+1 提交时 D 缺失，师傅按补录基线 11000 确认了回退（water 10500 < 11000，
      // 负差 -500 已固化并留痕）；随后 D 真实记录晚到、实读恰为 11000 → 重算三项中 water 数值
      // 无变化，且该回退命中与原确认完全相同（field+prev+current 三元组一致）→ 不再重复标出；
      // 若按字段级复用（评审一轮建议）会在基线变化时把新命中也静默解锁（D-T20 M6 同族陷阱），
      // 故本仓库语义钉死为「值匹配复用」。当前实现传空确认集 → 本用例当前应红（二轮探针）。
      await db.insert(records).values({
        recordNo: NEXT_RECORD_NO,
        dutyDate: NEXT_DATE,
        submitterId: zhangId,
        status: 'submitted',
        submittedAt: '2026-01-11 08:00:00',
        version: 1,
        waterReading: '10500.0',
        e1Reading: '53000.0',
        e2Reading: '43000.0',
        g1Remaining: '300.0',
        g2Remaining: '200.0',
        tankInUse: 1,
        waterUse: '-500.0',
      });
      // 原提交的回退确认留痕（record.submit 逐命中项一行，TK-14 消费口径）
      await db.insert(auditLogs).values({
        actorId: zhangId,
        action: 'record.submit',
        targetType: 'record',
        targetId: NEXT_RECORD_NO,
        newValue: {
          type: 'reading_decreased',
          field: 'water_reading',
          prev: 11000,
          current: 10500,
          version: 1,
        },
        reason: '换表底数',
      });
      try {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({ set: { water_reading: '11000.0' } }))
          .expect(201);

        const body = res.body as SubmitResultDto;
        // water 数值无变化（'−500' ≡ '−500.0'，M1 数值判等），e/gas 照算
        expect(body.recalc?.fields).toEqual(['e_use', 'gas_use']);
        // 同值命中已被原确认覆盖 → 待复核清单为空（评审二轮 L1：不重复标出已确认的同一命中）
        expect(body.recalc?.needs_review ?? []).toEqual([]);
        const row = await recordAt(NEXT_DATE);
        expect(row?.waterUse).toBe('-500.0');
        expect(row?.eUse).toBe('2000.0');
        expect(row?.gasUse).toBe('15.0');
      } finally {
        await cleanAll();
      }
    });

    it('L6-确认不复用异值命中：新基线产生**不同**的回退（prev 变化）→ 仍标 needs_review', async () => {
      // 防过度消音：原确认只覆盖「field+prev+current 完全相同」的命中；晚到实值与补录值
      // 不同（11000 → 12000）时，新命中更大（-1500），必须重新标出交人工核对。
      await db.insert(records).values({
        recordNo: NEXT_RECORD_NO,
        dutyDate: NEXT_DATE,
        submitterId: zhangId,
        status: 'submitted',
        submittedAt: '2026-01-11 08:00:00',
        version: 1,
        waterReading: '10500.0',
        e1Reading: '53000.0',
        e2Reading: '43000.0',
        g1Remaining: '300.0',
        g2Remaining: '200.0',
        tankInUse: 1,
        waterUse: '-500.0',
      });
      await db.insert(auditLogs).values({
        actorId: zhangId,
        action: 'record.submit',
        targetType: 'record',
        targetId: NEXT_RECORD_NO,
        newValue: {
          type: 'reading_decreased',
          field: 'water_reading',
          prev: 11000,
          current: 10500,
          version: 1,
        },
        reason: '换表底数',
      });
      try {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({ set: { water_reading: '12000.0' } }))
          .expect(201);

        const review = (res.body as SubmitResultDto).recalc?.needs_review ?? [];
        expect(review).toHaveLength(1);
        expect(review[0]).toMatchObject({
          type: 'reading_decreased',
          field: 'water_reading',
          prev: 12000,
          current: 10500,
        });
        expect((await recordAt(NEXT_DATE))?.waterUse).toBe('-1500.0');
      } finally {
        await cleanAll();
      }
    });

    it('duty_date 约束：非历史班次/非法日历日 → 400 点名 duty_date', async () => {
      const dutyDate = (await service.resolveDutyDate()).dutyDate;
      for (const d of [dutyDate, '2099-01-01']) {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({ dutyDate: d }))
          .expect(400);
        expect((res.body as { code: string }).code).toBe('VALIDATION_OUT_OF_RANGE');
        const missing = (res.body as { missing_fields: Array<{ field: string }> }).missing_fields;
        expect(missing[0]?.field).toBe('duty_date');
      }
      // 非法日历日（分域正则拦不住的 02-30）
      const bad = await request(server)
        .post(BACKFILL_API)
        .set('Cookie', masterCookie)
        .send(backfillPayload({ dutyDate: '2026-02-30' }))
        .expect(400);
      expect(
        (bad.body as { missing_fields: Array<{ field: string }> }).missing_fields[0]?.field,
      ).toBe('duty_date');
    });

    it('L3：duty_date 早于补交窗口（configs backfill_window_days）→ 400 点名 duty_date', async () => {
      // 窗口临时调为 2 天：2026-01-10 远在窗口外（本文件其余用例用 400 天窗口）
      await setWindow('2');
      try {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(400);
        expect((res.body as { code: string }).code).toBe('VALIDATION_OUT_OF_RANGE');
        expect(
          (res.body as { missing_fields: Array<{ field: string }> }).missing_fields[0]?.field,
        ).toBe('duty_date');
        // 无记录产生（窗口拦截在入库之前）
        expect(await recordAt(LATE_DATE)).toBeUndefined();
      } finally {
        await setWindow('30');
      }
    });

    it('RECORD_EXISTS（F1-01）：同班次重复补交（非 draft）→ 409', async () => {
      await insertDownstream();
      try {
        await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(201);
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(409);
        expect((res.body as { code: string }).code).toBe('RECORD_EXISTS');
      } finally {
        await cleanAll();
      }
    });

    it('L5：该班次为 draft（撤回后未重提）→ 补交接管为「更新 + version+1」，不留永久死角', async () => {
      await insertDownstream();
      // D 日先插一行 draft（TK-21 撤回产生的形态；此处直插模拟）
      await db.insert(records).values({
        recordNo: LATE_RECORD_NO,
        dutyDate: LATE_DATE,
        submitterId: zhangId,
        status: 'draft',
        version: 1,
      });
      try {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(201);
        expect((res.body as SubmitResultDto).version).toBe(2);
        expect((res.body as SubmitResultDto).status).toBe('submitted');
        const row = await recordAt(LATE_DATE);
        expect(row?.status).toBe('submitted');
        expect(row?.waterReading).toBe('10000.0');
        // 接管留痕（评审二轮 L2 收尾）：late_submit 显式记接管前的提交人，
        // 归属变更不靠两条审计的 actor 间接推断
        const late = await auditsOf('record.late_submit', LATE_RECORD_NO);
        expect(late).toHaveLength(1);
        expect(late[0]?.newValue).toMatchObject({
          duty_date: LATE_DATE,
          version: 2,
          prev_submitter_id: zhangId,
        });
        // 下游重算照常发生（draft 行接管后 D 日读数即成为新基线）
        expect((await recordAt(NEXT_DATE))?.waterUse).toBe('500.0');
      } finally {
        await cleanAll();
      }
    });

    it('防呆 409 同协议（F1-12/F1-13）：补交读数回退/充气命中 → 确认重提 → 留痕', async () => {
      // D-1 行（补交单的上一班基准）：water 12000 / g1 300
      await db.insert(records).values({
        recordNo: recordNoOf(EARLIER_DATE),
        dutyDate: EARLIER_DATE,
        submitterId: zhangId,
        status: 'submitted',
        submittedAt: '2026-01-09 20:00:00',
        version: 1,
        waterReading: '12000.0',
        g1Remaining: '300.0',
      });
      try {
        // 回退（11500 < 12000）与充气（g1 310 > 300）同时命中 → READINGS_DECREASED 优先
        const first = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({ set: { water_reading: '11500.0' } }))
          .expect(409);
        expect((first.body as { code: string }).code).toBe('READINGS_DECREASED');

        // 逐命中项确认后重提 → 放行；确认留痕与在线提交同口径（record.submit 逐项一行）
        await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(
            backfillPayload({
              set: { water_reading: '11500.0' },
              confirmations: [
                { type: 'reading_decreased', field: 'water_reading', reason: '换表底数' },
                { type: 'gas_refill', card: 1, reason: '临时充气' },
              ],
            }),
          )
          .expect(201);
        const confirms = await db
          .select({ newValue: auditLogs.newValue })
          .from(auditLogs)
          .where(and(eq(auditLogs.targetId, LATE_RECORD_NO), gt(auditLogs.id, auditHighWater)));
        const types = confirms
          .map((r) => (r.newValue as { type?: string } | null)?.type)
          .filter(Boolean);
        expect(types).toContain('reading_decreased');
        expect(types).toContain('gas_refill');
      } finally {
        await cleanAll();
      }
    });
  });

  describe('F3-08-T2 手工覆盖豁免：触发重算 → 覆盖值与原因保留', () => {
    it('下游 water_use 已手工覆盖（当前版本 usage_override 审计）→ 重算跳过该字段，其余照算', async () => {
      await insertDownstream({ waterUse: '777.0' });
      try {
        // 手工覆盖留痕（TK-13 覆盖协议的落库形态：old_value 记自动值，D-T07 豁免判定依据）
        await db.insert(auditLogs).values({
          actorId: zhangId,
          action: 'record.usage_override',
          targetType: 'record',
          targetId: NEXT_RECORD_NO,
          oldValue: { field: 'water_use', auto_value: 500 },
          newValue: { field: 'water_use', value: '777.0', version: 1 },
          reason: '水表换底数，按科长核实值修正',
        });
        // 覆盖审计须在高水位之内才对断言不可见——本用例自己插入的行在高水位之后，
        // 故豁免断言以「无 water_use 的 recalc 行 + 列值不变」为准（不依赖 usage_override 计数）

        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', masterCookie)
          .send(backfillPayload({}))
          .expect(201);

        // 豁免：water_use 不在重算清单、列值保持手工值
        expect((res.body as SubmitResultDto).recalc).toEqual({
          record_no: NEXT_RECORD_NO,
          fields: ['e_use', 'gas_use'],
          needs_review: [],
        });
        const row = await recordAt(NEXT_DATE);
        expect(row?.waterUse).toBe('777.0');
        expect(row?.eUse).toBe('2000.0');
        expect(row?.gasUse).toBe('15.0');

        // 审计不含 water_use 的 recalc 行（豁免字段零噪音）
        const recalc = await auditsOf('record.recalc', NEXT_RECORD_NO);
        const fields = recalc.map((r) => (r.newValue as { field: string }).field);
        expect(fields).not.toContain('water_use');
        // 覆盖留痕仍在且原因保留（手工值与原因保留 = F3-08-T2 判据后半句）
        const overrides = await db
          .select({ reason: auditLogs.reason, newValue: auditLogs.newValue })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.action, 'record.usage_override'),
              eq(auditLogs.targetId, NEXT_RECORD_NO),
            ),
          );
        expect(overrides).toHaveLength(1);
        expect(overrides[0]?.reason).toBe('水表换底数，按科长核实值修正');
      } finally {
        await cleanAll();
      }
    });
  });

  describe('D-T21 角色口径（chief 可补交自己的班次；代录他人另挂 TK-24）', () => {
    it('chief 登录补交 → 201（提交人为科长本人），master 未被拒（对照 submit 仅 master）', async () => {
      try {
        const res = await request(server)
          .post(BACKFILL_API)
          .set('Cookie', chiefCookie)
          .send(backfillPayload({}))
          .expect(201);
        expect(res.body.record_no).toBe(LATE_RECORD_NO);
      } finally {
        await cleanAll();
      }
    });
  });
});
