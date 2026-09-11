/**
 * TK-07 上一班读数带出测试 —— 挂钩台账 F1-05 / F1-15 / DATA-02 / F3-07（AGENTS.md「需求即测试」）。
 *
 * 覆盖台账用例：
 * - F1-05-T1 存在前一条已提交记录 → 打开板块 → 上一班读数带出显示（判据：带出值为前一条**已提交**记录，非草稿）
 * - F1-05-T2 昨日无已提交记录 → 打开板块 → 无带出值（判据：不报错、不显示脏数据）
 * - DATA-02-T1 打开 8:30 液氧卡 → 带出昨日 20:30 值 → 供比对显示（判据：取昨日记录 20:30，非今日）
 * - F1-15-T1 系统无任何历史数据 → 填写读数 → 用量显示"—"（接口层：first_day 标记；提示"首班记录"由前端消费）
 * - F3-07-T1 上一班数据缺失 → 显示"—" → 补录上一班读数 → 可计算
 *   （**本阶段锁缺失态接口契约**：前一条为 draft → first_day=false 且 prev=null；
 *   "补录入口"与"补录后计算正确"两个半句属提交链路（TK-12）与计算引擎（TK-13/TK-14，防呆三则含
 *   「上一班缺失显'—'允许补录」），任务分解 TK-14 判据已补列 F3-07-T1，端点落地后复验并闭环。）
 *
 * **层级说明**：《测试用例清单》将上述用例标为接口层级。本文件即其接口层落地（服务端判据：
 * 紧邻前一条、非草稿、跨时点映射、首班/缺失两态），随 `pnpm test` 进 CI；
 * UI 层（比对值渲染、"—"与"首班记录"提示）见 apps/h5 SectionView（E2E 全量回归属 TK-31）。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`（**须当天重灌**）。
 * 基准取种子的灌种日 D-1（《开发种子数据》场景矩阵：待确认单，status=submitted，标准日模板 k=9），
 * 按 **D-T17**「上一班 = 相邻班次（今日班次日期 − 1 天）」口径，测试基准取**日历事实**
 * `minusOneDay(dutyDate)`，并由相邻性哨兵钉死：种子隔日未重灌产生空档时 F1-05-T1 显式红提示
 * 重灌（而非静默把更早记录认作上一班——TK-07 评审 M1/M2 的教训：期望值与实现同谓词查询，
 * 回落多远都绿）。测试对库的改动（该行状态临时置 draft、该行 duty_date 临时平移模拟漏交、
 * 全体 duty_date 临时 +1000 天模拟首班）在测试内 try/finally 与 afterAll 双重还原，
 * 不破坏种子计数口径（records=10）。
 *
 * **必须串行跑**（api 的 test 脚本为 `jest --runInBand` + `maxWorkers: 1`）：与 auth/records
 * 两个 spec 共用同一真实 MySQL，并行会互删登录态与审计证据（见 records.spec.ts 同款说明）。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import {
  PREV_SOURCE_FIELD,
  prevSourceField,
  type PrevDto,
  type RecordFieldName,
} from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, records, sessions } from '../db/schema';
import { RecordsService } from './records.service';
import { minusOneDay } from './duty-date';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';
/** 契约 §1 基础路径 + §3.2 上一班带出路由 */
const API = '/api/v1/records/today/prev';

describe('F1-05/DATA-02/F1-15/F3-07 上一班读数带出（TK-07）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let service: RecordsService;
  let auditHighWater = 0;
  let masterCookie = '';
  let chiefCookie = '';
  /** 当日班次日期（C-08；与种子 D0 同源，duty-date.ts 唯一实现） */
  let dutyDate = '';
  /** 上一班（相邻班次）的 duty_date = 今日班次日期 − 1 天（D-T17；日历事实，非库内最新行） */
  let prevDate = '';
  /** 还原标记：测试中途失败也不让种子带病留给后续用例 */
  let prevStatusMutated = false;
  let adjacentShifted = false;
  let adjacentId = 0;
  let datesShifted = false;

  async function login(username: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username, password: PASSWORD })
      .expect(200);
    return String(res.headers['set-cookie']?.[0] ?? '');
  }

  async function fetchPrev(cookie = masterCookie): Promise<PrevDto> {
    const res = await request(server).get(API).set('Cookie', cookie).expect(200);
    return res.body as PrevDto;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app); // 与 main.ts 共用同一份配置，避免前缀/Cookie 解析漂移
    await app.init();
    db = app.get<Db>(DB);
    service = app.get(RecordsService);
    server = app.getHttpServer() as Server;

    // 种子不含会话数据，清空以保证登录断言干净（与 auth/records spec 同一纪律）
    await db.delete(sessions);
    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);

    masterCookie = await login('zhang');
    chiefCookie = await login('chief');
    dutyDate = (await service.resolveDutyDate()).dutyDate;
    // D-T17：上一班 = 相邻班次（今日班次日期 − 1 天），日历事实而非库内最新行——
    // 种子隔日未重灌产生空档时由相邻性哨兵显式红，而非静默回落更早记录
    prevDate = minusOneDay(dutyDate);
  });

  afterAll(async () => {
    // 双重还原（try/finally 之外的最后防线）：种子相邻行状态/位置、被整体平移的 duty_date
    if (prevStatusMutated) {
      await db.update(records).set({ status: 'submitted' }).where(eq(records.dutyDate, prevDate));
    }
    if (adjacentShifted) {
      await db.execute(
        sql`UPDATE records SET duty_date = DATE_ADD(duty_date, INTERVAL 1000 DAY) WHERE id = ${adjacentId}`,
      );
    }
    if (datesShifted) {
      await db.execute(sql`UPDATE records SET duty_date = DATE_SUB(duty_date, INTERVAL 1000 DAY)`);
    }
    // 还原测试对库的其余改动：新增审计行（按 id 上界只删本测试新增的）、会话存根
    await db.delete(auditLogs).where(sql`${auditLogs.id} > ${auditHighWater}`);
    await db.delete(sessions);
    // 关闭应用触发 DbModule.onApplicationShutdown 结束连接池，否则 Jest 进程不退出
    await app.close();
  });

  describe('F1-05-T1：存在前一条已提交记录 → 带出其读数', () => {
    it('prev = 紧邻前一条（种子 D-1，submitted），记录级字段与 duty_date 逐项吻合', async () => {
      const body = await fetchPrev();

      expect(body.duty_date).toBe(dutyDate); // 当前班次日期回显（C-08 口径互核）
      expect(body.first_day).toBe(false);
      expect(body.prev).not.toBeNull();
      expect(body.prev?.duty_date).toBe(prevDate);
      // 种子 record_no 规则：HB-YYYYMMDD-001（《开发种子数据》§六）
      expect(body.prev?.record_no).toBe(`HB-${prevDate.replaceAll('-', '')}-001`);
      expect(body.prev?.status).toBe('submitted'); // 种子最后一条（灌种日 D-1）为待确认单：已提交、未确认
      expect(body.prev?.version).toBe(1);
      expect(body.prev?.submitted_at).toContain(prevDate);
    });

    it('带出值为 D-1 记录值（黄金值钉死种子标准日模板 k=9，防种子漂移被同源断言放过）', async () => {
      const body = await fetchPrev();
      const r = body.prev?.readings ?? {};

      // 标准日模板递变（水 +250/日、电 +380/+350/日、气卡 −30/日）：D-1 即 k=9
      expect(r['water_reading']).toBe('12250.0');
      expect(r['e1_reading']).toBe('53420.0');
      expect(r['e2_reading']).toBe('43150.0');
      expect(r['g1_remaining']).toBe('310.0');
      expect(r['g2_remaining']).toBe('210.0');
      // D-1 在用罐 = 2（换罐日 D-3 起）；两罐读数均在
      expect(r['tank_in_use']).toBe(2);
      expect(r['t2_c830']).toBe('48.20');
      expect(r['t2_c2030']).toBe('48.00');
      expect(r['t1_c2030']).toBe('48.00');

      // 只回传字段字典内的存储列：基础信息列与跨记录派生列不进 readings
      expect(r['duty_date']).toBeUndefined();
      expect(r['lo_night_use']).toBeUndefined();
    });

    it('相邻性哨兵：带出源必须是今日班次 − 1 天（红 → 种子未当天重灌或存在漏交空档，先 db:setup 重灌；业务上确需跨空档带出须先修订 D-T17 与 F1-05-T2 判据）', async () => {
      // 黄金值哨兵的日期版（TK-07 评审 M2）：上一版用「与实现同一谓词」查库算期望，
      // 回落多远都绿（同源盲区）——此处钉死日历事实，空档以可读失败强制人工核对
      expect(prevDate).toBe(minusOneDay(dutyDate));
      const body = await fetchPrev();
      expect(body.prev?.duty_date).toBe(minusOneDay(dutyDate));
    });
  });

  describe('DATA-02-T1：液氧 8:30 卡带出昨日 20:30 值', () => {
    it('shared 带出映射：四项 830 字段的源字段均为对应 2030 字段（三端同源，前端据此渲染）', () => {
      // 映射本身是 shared 字典（与 h5 渲染同一实现），此处钉死其内容
      expect(prevSourceField('t1_c830')).toBe('t1_c2030');
      expect(prevSourceField('t1_p830')).toBe('t1_p2030');
      expect(prevSourceField('t2_c830')).toBe('t2_c2030');
      expect(prevSourceField('t2_p830')).toBe('t2_p2030');
      expect(Object.keys(PREV_SOURCE_FIELD)).toHaveLength(4);
      // 20:30 卡与其余卡片取同名字段（同时点跨记录比对）
      expect(prevSourceField('t1_c2030')).toBe('t1_c2030');
      expect(prevSourceField('water_reading')).toBe('water_reading');
    });

    it('映射结果落在上一班 readings 内，且取的是 20:30 值（非上一班同名 8:30 值）', async () => {
      const body = await fetchPrev();
      // 显式标注而非 as 断言（评审 m3）：键与值都受 RecordFieldName 编译期检查
      const r: Readonly<Partial<Record<RecordFieldName, unknown>>> = body.prev?.readings ?? {};

      // 判据「取昨日记录 20:30（非今日）」：8:30 卡带出源 = 上一班记录的 2030 字段
      for (const src of Object.values(PREV_SOURCE_FIELD)) {
        expect(r[src]).toBeDefined();
      }
      // 上一班记录中 2030 与 830 值可区分（k=9 模板：830=48.20、2030=48.00），
      // 若错取同名 830 字段，此断言即红
      expect(r['t2_c2030']).not.toBe(r['t2_c830']);
    });
  });

  describe('F1-05-T2：昨日无已提交记录 → 无带出值', () => {
    it('前一条临时置 draft → prev=null 且 first_day=false；不报错、不回落更早记录', async () => {
      const orig = await db
        .select({ status: records.status })
        .from(records)
        .where(eq(records.dutyDate, prevDate))
        .limit(1);
      await db.update(records).set({ status: 'draft' }).where(eq(records.dutyDate, prevDate));
      prevStatusMutated = true;
      try {
        const body = await fetchPrev();

        // 判据「不报错」：200 而非 4xx/5xx（fetchPrev 内 expect(200) 已断言）
        // 判据「无带出值 / 不显示脏数据」：草稿不作为带出数据源，且**不跳过缺失班次**
        // 回落 D-2（更早记录冒充上一班）——prev 为 null 而非 D-2 的读数
        expect(body.first_day).toBe(false); // 有历史记录，非首班（区别于 F1-15）
        expect(body.prev).toBeNull();
        expect(body.duty_date).toBe(dutyDate);
      } finally {
        await db
          .update(records)
          .set({ status: orig[0]?.status ?? 'submitted' })
          .where(eq(records.dutyDate, prevDate));
        prevStatusMutated = false;
      }
    });

    it('相邻日整日无行（漏交，F6-06 检测的场景）→ 缺失态且不回落更早记录（D-T17 修复回归）', async () => {
      // 评审 M1 的现场：把相邻班次行整体平移走，若实现是「取 duty_date < 今日的最新一条」
      // 会回落 D-2 冒充上一班（跨 2 班）——正确行为是缺失态，交由 F3-07 补录
      const adjacent = await db
        .select({ id: records.id })
        .from(records)
        .where(eq(records.dutyDate, prevDate))
        .limit(1);
      adjacentId = adjacent[0]?.id ?? 0;
      await db.execute(
        sql`UPDATE records SET duty_date = DATE_SUB(duty_date, INTERVAL 1000 DAY) WHERE id = ${adjacentId}`,
      );
      adjacentShifted = true;
      try {
        const body = await fetchPrev();
        expect(body.first_day).toBe(false); // 更早记录仍在，非首班（区别于 F1-15）
        expect(body.prev).toBeNull(); // 不以更早记录冒充上一班
      } finally {
        await db.execute(
          sql`UPDATE records SET duty_date = DATE_ADD(duty_date, INTERVAL 1000 DAY) WHERE id = ${adjacentId}`,
        );
        adjacentShifted = false;
      }
    });
  });

  describe('F3-07-T1（接口层缺失态）：上一班数据缺失 → 前端显"—"并允许补录', () => {
    it('缺失态响应契约：prev=null + first_day=false（补录入口与「补录后计算正确」随 TK-12/13/14 复验）', async () => {
      // 与 F1-05-T2 同场景、不同侧重：此处锁 F3-07 消费的响应形状——
      // 前端据 first_day=false && prev===null 判定「缺失（可补录）」而非「首班」
      const orig = await db
        .select({ status: records.status })
        .from(records)
        .where(eq(records.dutyDate, prevDate))
        .limit(1);
      await db.update(records).set({ status: 'draft' }).where(eq(records.dutyDate, prevDate));
      prevStatusMutated = true;
      try {
        const body = await fetchPrev();
        expect(body).toEqual({ duty_date: dutyDate, first_day: false, prev: null });
      } finally {
        await db
          .update(records)
          .set({ status: orig[0]?.status ?? 'submitted' })
          .where(eq(records.dutyDate, prevDate));
        prevStatusMutated = false;
      }
    });
  });

  describe('F1-15-T1：系统无任何历史数据 → first_day=true（首班）', () => {
    it('全体种子记录 duty_date 临时 +1000 天 → prev=null 且 first_day=true（区别于缺失态）', async () => {
      // 首班语义 = 今日之前**无任何记录**（种子 D-10 场景）。直接清库会破坏种子与外键，
      // 故整体平移 duty_date 造「无历史」窗口（UNIQUE 约束随整体平移保持成立），测毕还原
      await db.execute(sql`UPDATE records SET duty_date = DATE_ADD(duty_date, INTERVAL 1000 DAY)`);
      datesShifted = true;
      try {
        const body = await fetchPrev();
        expect(body.first_day).toBe(true);
        expect(body.prev).toBeNull();
        expect(body.duty_date).toBe(dutyDate);
      } finally {
        await db.execute(
          sql`UPDATE records SET duty_date = DATE_SUB(duty_date, INTERVAL 1000 DAY)`,
        );
        datesShifted = false;
      }
    });
  });

  describe('契约角色与鉴权', () => {
    it('chief 亦可访问（契约 §1「chief：全部 + 配置」覆盖师傅端只读接口，与 GET /records/today 同口径）', async () => {
      const body = await fetchPrev(chiefCookie);
      expect(body.prev).not.toBeNull();
      expect(body.prev?.duty_date).toBe(prevDate);
    });

    it('未登录 → 401 UNAUTHENTICATED（契约 §2 结构）', async () => {
      const res = await request(server).get(API).expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(res.body.request_id).toMatch(/^req-/);
    });
  });
});
