/**
 * TK-05 今日交接首页测试 —— 挂钩台账 F1-01 / F1-02 / F1-03（AGENTS.md「需求即测试」：用例名以 -T 编号挂钩台账）。
 *
 * 覆盖台账用例：
 * - F1-01-T1 当日无记录 → 打开首页 → 全天仅一条记录（判据：duty_date 当日唯一；无重复入口）
 * - F1-02-T1 首页 12 张任务卡按点位组织，液氧拆 8:30/20:30 两张到点卡（判据：卡片数与组织顺序与 PRD §6.0 一致）
 * - F1-02-T2 进入板块填写页只见本板块字段（判据：板块间无字段串扰）
 * - F1-03-T1 角标与顶部进度条实时汇总已填/待填/异常（判据：计数与实际一致；异常角标变色）
 * 另附 C-08 班次口径验收（台账 C-08 验收方式即「跨天用例（23:59 当班、次日提交）」，非独立 -T 编号）。
 *
 * **层级说明**：《测试用例清单》将上述四条标为 E2E 层级。本文件是其**接口层**落地（服务端判据：
 * 卡片数与顺序、字段归属、角标计数、duty_date 唯一与跨天归属），随 `pnpm test` 进 CI；
 * **UI 层判据**（卡片渲染、进度条宽度、角标变色）见 `tests/e2e/tests/today.spec.ts`。
 * E2E 全量回归与"每次提交自动回归"属 TK-31（依赖 M1–M4），故 e2e 包脚本名为 `test:e2e`、暂不入 CI。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * CI 由 workflow 的 mysql service 提供。测试对库的改动在 afterAll 全部还原，
 * 不破坏《开发种子数据》的计数口径（records=10、configs=19）。
 *
 * **必须串行跑**（api 的 test 脚本为 `jest --runInBand` + `maxWorkers: 1`）：
 * 本文件与 auth.spec.ts 共用同一真实 MySQL，两者都需清空 `sessions` 并清理 `login` 审计行；
 * 并行跑文件会互删对方的登录态与审计证据（待每 spec 独立库或事务回滚的隔离方案落地后可放开）。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, gt } from 'drizzle-orm';
import request from 'supertest';
import {
  CARD_COUNT,
  COUNTABLE_FIELD_TOTAL,
  COVERED_SECTIONS,
  DUPLICATE_CARD_FIELD_OWNERS,
  FIELD_BY_NAME,
  TASK_CARDS,
  cardCountableFields,
  type RecordFieldName,
  type TodayDto,
} from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, records, sessions } from '../db/schema';
import { RecordsService } from './records.service';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';
/** 契约 §1 基础路径 + §3.2 今日交接路由 */
const API = '/api/v1/records/today';
/** 本测试自造的 draft 行标识（record_no NOT NULL UNIQUE，提交时才生成正式号——见契约 §4 第 5 步） */
const TEST_RECORD_NO = 'HB-TEST-TK05-01';

describe('F1-01/F1-02/F1-03 今日交接首页（TK-05）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let service: RecordsService;
  let auditHighWater = 0;
  /** 师傅会话 Cookie（zhang，master 角色） */
  let masterCookie = '';
  /** 科长会话 Cookie（chief，验证契约 §1「chief：全部 + 配置」覆盖师傅端接口） */
  let chiefCookie = '';
  /** 当日班次日期（C-08）；测试内自造 draft 行与 afterAll 清理均以它为准 */
  let dutyDate = '';

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
    configureApp(app); // 与 main.ts 共用同一份配置，避免前缀/Cookie 解析漂移
    await app.init();
    db = app.get<Db>(DB);
    service = app.get(RecordsService);
    server = app.getHttpServer() as Server;

    // 种子不含会话数据，清空以保证登录断言干净（与 auth.spec.ts 同一纪律）
    await db.delete(sessions);
    const rows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = rows.reduce((max, r) => Math.max(max, r.id), 0);

    masterCookie = await login('zhang');
    chiefCookie = await login('chief');
    dutyDate = (await service.resolveDutyDate()).dutyDate;
  });

  afterAll(async () => {
    // 还原测试对库的改动：自造的 draft 行、新增审计行（按 id 上界只删本测试新增的）、会话存根。
    // 种子 D0 刻意留空（《开发种子数据》§六「无记录，测试填写全流程」），故必须清掉以还原 records=10。
    await db.delete(records).where(eq(records.recordNo, TEST_RECORD_NO));
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    // 关闭应用触发 DbModule.onApplicationShutdown 结束连接池，否则 Jest 进程不退出
    await app.close();
  });

  /** 取首页响应（师傅身份） */
  async function fetchToday(cookie = masterCookie): Promise<TodayDto> {
    const res = await request(server).get(API).set('Cookie', cookie).expect(200);
    return res.body as TodayDto;
  }

  describe('F1-01-T1：一天一条记录，首页即"今日交接"', () => {
    it('当日无记录 → 首页返回该班次日期且 record 为 null（种子 D0 留空）', async () => {
      const body = await fetchToday();

      // 判据「duty_date 当日唯一」：接口按班次日期查，返回单条对象而非数组
      expect(body.duty_date).toBe(dutyDate);
      expect(body.record).toBeNull();
      expect(Array.isArray(body.record)).toBe(false);

      // 库中该 duty_date 至多一行（records.duty_date UNIQUE 约束，F1-01 技术方案列）
      const rows = await db
        .select({ id: records.id })
        .from(records)
        .where(eq(records.dutyDate, dutyDate));
      expect(rows.length).toBeLessThanOrEqual(1);
    });

    it('判据「无重复入口」：反复请求首页不产生第二条记录（GET 纯读，不建 draft 行）', async () => {
      const before = await db.select({ id: records.id }).from(records);

      // 首页是唯一入口：连打三次，duty_date 恒定、record 恒为 null
      const bodies = await Promise.all([fetchToday(), fetchToday(), fetchToday()]);
      for (const b of bodies) {
        expect(b.duty_date).toBe(dutyDate);
        expect(b.record).toBeNull();
      }

      // 关键：GET 不带写副作用——records 行数不变（否则占位 record_no 与种子计数口径都会被破坏）
      const after = await db.select({ id: records.id }).from(records);
      expect(after).toHaveLength(before.length);
    });

    it('交班人恒为登录账号（技术方案修订 9：submitter_id 以登录人为准）', async () => {
      const body = await fetchToday();
      expect(body.submitter.real_name).toBe('张师傅');
      // 接班人按排班表自动带出属 TK-12（DATA-10），本阶段恒为 null
      expect(body.receiver).toBeNull();
    });

    it('科长亦可访问（契约 §1「chief：全部 + 配置」覆盖师傅端接口）', async () => {
      const body = await fetchToday(chiefCookie);
      expect(body.cards).toHaveLength(CARD_COUNT);
      expect(body.submitter.real_name).toBe('陈科长');
    });

    it('未登录 → 401 UNAUTHENTICATED（契约 §2 结构，C-09）', async () => {
      const res = await request(server).get(API).expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(res.body.missing_fields).toBeNull();
      expect(res.body.need_confirm).toBeNull();
      expect(res.body.request_id).toMatch(/^req-/);
    });
  });

  describe('C-08 班次口径：duty_date = 班次起始日（跨天用例）', () => {
    /**
     * 全部以 **UTC 时刻**构造入参：service 内部按 Asia/Shanghai 显式换算，
     * 故断言不依赖测试机时区，同时反证"不能用 UTC 或服务器本地时区判分界"
     * （北京 10:00 = UTC 02:00，若按 UTC 判会误归昨日班次）。
     */
    const cases: Array<[string, string, string]> = [
      // [UTC 时刻, 对应北京时刻, 期望 duty_date]
      ['2026-09-02T18:00:00Z', '09-03 02:00 凌晨地下表房抄表', '2026-09-02'],
      ['2026-09-03T00:29:00Z', '09-03 08:29 分界前一刻', '2026-09-02'],
      ['2026-09-03T00:30:00Z', '09-03 08:30 恰为分界（含）', '2026-09-03'],
      ['2026-09-03T02:00:00Z', '09-03 10:00 白班填写', '2026-09-03'],
      ['2026-09-03T15:59:00Z', '09-03 23:59 当班（C-08 验收方式原文）', '2026-09-03'],
      ['2026-09-03T16:00:00Z', '09-04 00:00 次日提交', '2026-09-03'],
    ];

    it.each(cases)('%s → %s → duty_date=%s', async (utc, _desc, expected) => {
      const { dutyDate: got, shiftStart } = await service.resolveDutyDate(new Date(utc));
      expect(got).toBe(expected);
      expect(shiftStart).toBe('08:30'); // 种子值（❓ 待科长确认，台账待确认清单第 8 项）
    });
  });

  describe('F1-02-T1：12 张任务卡按点位组织，液氧拆 8:30/20:30 两张到点卡', () => {
    it('卡片数 = 12（11 个点位，液氧站拆两张到点卡 → 10 + 2）', async () => {
      const body = await fetchToday();
      // 判据「卡片数与 PRD §6.0 一致」；CARD_COUNT 由 shared 字典在编译期锁定为字面量 12
      expect(body.cards).toHaveLength(CARD_COUNT);
      expect(CARD_COUNT).toBe(12);
      expect(body.cards).toHaveLength(TASK_CARDS.length);
    });

    it('组织顺序 = spots.sort_no 升序，液氧两卡在液氧站位置连续且 8:30 在前', async () => {
      const body = await fetchToday();

      // 判据「组织顺序与 PRD §6.0 一致」：点位顺序取自《开发种子数据》§三 sort_no
      expect(body.cards.map((c) => c.spot_name)).toEqual([
        '表房',
        '高配房',
        '燃气表房',
        '液氧站',
        '液氧站',
        '瓶库',
        '锅炉房',
        '制冷机房',
        '泵房',
        '新风机房',
        '电梯厅',
        '值班室',
      ]);
      const sortNos = body.cards.map((c) => c.sort_no);
      expect(sortNos).toEqual([...sortNos].sort((a, b) => a - b));

      // 液氧拆两张「到点卡」：仅这两张带时段，且 8:30 在 20:30 之前
      expect(body.cards.map((c) => c.slot_label)).toEqual([
        null,
        null,
        null,
        '8:30',
        '20:30',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(body.cards.map((c) => c.slot)).toEqual([
        null,
        null,
        null,
        'am',
        'pm',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      // 到点卡共享同一 spots 行（同点位拆两卡，非两个点位）
      expect(body.cards[3]?.spot_id).toBe(body.cards[4]?.spot_id);
    });

    it('卡片 key 序列与 shared 字典一致（前后端同源，杜绝各写一份）', async () => {
      const body = await fetchToday();
      expect(body.cards.map((c) => c.key)).toEqual(TASK_CARDS.map((c) => c.key));
    });

    it('板块八由值班室卡兼管、板块 0 不占卡（守住 12 这个数字且十板块全覆盖）', async () => {
      const body = await fetchToday();

      // PRD §6.1 In Scope「十个板块的完整结构化填写」的可执行校验：12 卡覆盖板块 1–10 全部
      expect(COVERED_SECTIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const covered = [...new Set(body.cards.flatMap((c) => c.sections))].sort((a, b) => a - b);
      expect(covered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // 板块八无 spots 点位（附录 A 仅 energy_note 且"无则可留空"），但必须有填写入口
      // → 由值班室卡兼管（sections=[10,8]），免去为它新增点位而改种子与计数
      const desk = body.cards.find((c) => c.key === 'duty_desk');
      expect(desk?.sections).toEqual([10, 8]);
      expect(desk?.section).toBe(10); // 主板块仍为十，卡片标题按主板块归类
      expect(desk?.fields.map((f) => f.name)).toEqual(['handover_note', 'energy_note']);

      // 板块 0（基础信息）自动带出，属页面头部与提交预览（TK-12），不占巡检卡
      expect(body.cards.flatMap((c) => c.sections)).not.toContain(0);

      // 电梯卡走 elevator_checks 逐台核对（契约 §3.3），不在 records 字段字典内
      expect(body.cards.find((c) => c.key === 'elevator')?.kind).toBe('elevator');
      expect(body.cards.find((c) => c.key === 'elevator')?.fields).toEqual([]);
    });
  });

  describe('F1-02-T2：只见本板块字段，板块间无字段串扰', () => {
    it('每张卡的字段集合恰等于 shared 字典定义（无增减、无越界）', async () => {
      const body = await fetchToday();
      for (const card of body.cards) {
        const def = TASK_CARDS.find((c) => c.key === card.key);
        expect(card.fields.map((f) => f.name)).toEqual([...(def?.fields ?? [])]);
      }
    });

    it('卡内每个字段的板块号都落在该卡声明的板块内（串扰即在此暴露）', async () => {
      const body = await fetchToday();
      for (const card of body.cards) {
        for (const field of card.fields) {
          const def = FIELD_BY_NAME[field.name as RecordFieldName];
          // 板块四拆液氧站/瓶库三张卡、板块五拆锅炉房/制冷机房两张卡，故"同板块多卡"合法；
          // 值班室卡兼管板块十与板块八，故一卡可声明多板块；
          // 但"卡内出现未声明板块的字段"即串扰（F1-02-T2 判据「板块间无字段串扰」）
          if (!card.sections.includes(def.section)) {
            throw new Error(
              `卡「${card.key}」声明板块 [${card.sections.join(',')}]，` +
                `却含板块 ${def.section} 的字段 ${field.name}`,
            );
          }
        }
      }
    });

    it('卡片两两无共享字段（一个字段只属一张卡，否则角标重复计数）', async () => {
      // 字典层不变量：归属重复清单恒为空
      expect(DUPLICATE_CARD_FIELD_OWNERS).toEqual([]);

      const body = await fetchToday();
      const seen = new Map<string, string>();
      for (const card of body.cards) {
        for (const field of card.fields) {
          const owner = seen.get(field.name);
          // Jest 的 expect() 不受理第二参数自定义消息（那是 Chai 的 API），故显式抛错以保留定位信息
          if (owner !== undefined) {
            throw new Error(
              `字段 ${field.name} 同时出现在「${owner}」与「${card.key}」两张卡（应只属一张）`,
            );
          }
          seen.set(field.name, card.key);
        }
      }
    });

    it('板块汇总为聚合视角：板块四含三张卡、板块五含两张卡', async () => {
      const body = await fetchToday();
      const sec4 = body.cards.filter((c) => c.section === 4).map((c) => c.key);
      const sec5 = body.cards.filter((c) => c.section === 5).map((c) => c.key);
      expect(sec4).toEqual(['lo_am', 'lo_pm', 'cylinder']);
      expect(sec5).toEqual(['boiler', 'cooling']);

      // 契约 §3.2「各板块填写状态」：sections 按**字段真实板块号**聚合，覆盖板块 1–10
      // （energy_note 归板块八而非值班室卡的板块十；板块九无 records 字段但电梯卡存在，故 total=0 仍可见）
      expect(body.sections.map((s) => s.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(body.sections.find((s) => s.no === 9)?.badge.total).toBe(0);
      // 板块八与板块十的字段均为选填（附录 A："无则可留空" / "有内容时逐条确认"），故不计入分母
      expect(body.sections.find((s) => s.no === 8)?.badge.total).toBe(0);
      expect(body.sections.find((s) => s.no === 10)?.badge.total).toBe(0);
      const sec4Badge = body.sections.find((s) => s.no === 4)?.badge;
      const sec4Sum = body.cards
        .filter((c) => c.section === 4)
        .reduce((n, c) => n + c.badge.total, 0);
      expect(sec4Badge?.total).toBe(sec4Sum);
      // 板块汇总与顶部进度条同源：各板块 total 之和 == progress.total
      const sectionTotal = body.sections.reduce((n, s) => n + s.badge.total, 0);
      expect(sectionTotal).toBe(body.progress.total);
    });
  });

  describe('F1-03-T1：角标与顶部进度条实时汇总已填/待填/异常', () => {
    it('分母黄金值 = 38（哨兵：改分母口径必须以可读失败强制人工核对规格）', () => {
      // 其余用例用 COUNTABLE_FIELD_TOTAL 与接口对照，属同一字典自证（同源盲区）；
      // 此处钉死字面量：若 cards.ts 的 fill 口径、CONDITIONAL/OPTIONAL 集合或卡片字段清单
      // 变化导致分母漂移，本用例会爆，需人工比对台账 F1-03 与决策记录 D-T16 后再改数。
      // 实算分解（12 卡）：water 1 + electricity 3 + gas 2 + lo_am 5 + lo_pm 2 + cylinder 9
      //   + boiler 2 + cooling 2 + pump 10 + hvac 2 + elevator 0 + duty_desk 0 = 38
      expect(COUNTABLE_FIELD_TOTAL).toBe(38);
    });

    it('当日无记录 → 全部待填：filled=0、pending=total、abnormal=0', async () => {
      const body = await fetchToday();

      for (const card of body.cards) {
        expect(card.badge.filled).toBe(0);
        expect(card.badge.pending).toBe(card.badge.total);
        expect(card.badge.abnormal).toBe(0);
      }

      // 判据「计数与实际一致」：分母 = shared 字典派生的应填字段总数（非硬编码魔数）
      expect(body.progress.filled).toBe(0);
      expect(body.progress.total).toBe(COUNTABLE_FIELD_TOTAL);
      expect(body.progress.pending).toBe(COUNTABLE_FIELD_TOTAL);
      expect(body.progress.abnormal).toBe(0);
    });

    it('分母只数"师傅需亲手填/选"的字段：排除 auto 派生列与条件必填', async () => {
      const body = await fetchToday();

      // 每卡分母 = 字典中该卡 fill∈{manual,select} 且非条件必填的字段数
      for (const card of body.cards) {
        const def = TASK_CARDS.find((c) => c.key === card.key);
        expect(card.badge.total).toBe(cardCountableFields(def!).length);
      }

      // auto 派生列（water_use / e_use / gas_use 等）不计入分母——它们提交前恒为 NULL
      // （契约 §4 第 3 步：用量由服务端提交时计算固化），计入会让进度条永远到不了 100%
      const waterCard = body.cards.find((c) => c.key === 'water');
      expect(waterCard?.fields.map((f) => f.name)).toEqual(['water_reading', 'water_use']);
      expect(waterCard?.fields.find((f) => f.name === 'water_reading')?.required).toBe(true);
      expect(waterCard?.fields.find((f) => f.name === 'water_use')?.required).toBe(false);
      expect(waterCard?.badge.total).toBe(1);

      // 条件必填（hp_note 仅 hp_status=bad 时填，附录 A「异常时必填备注」）不计入分母，
      // 但仍出现在字段清单里供 TK-06 渲染；TK-06 落地 F1-08 后转动态判定
      const hpCard = body.cards.find((c) => c.key === 'electricity');
      expect(hpCard?.fields.find((f) => f.name === 'hp_note')?.required).toBe(false);
      expect(hpCard?.badge.total).toBe(3); // e1_reading、e2_reading、hp_status
    });

    it('填写一项 → 该卡与进度条 filled +1、pending −1（实时汇总）', async () => {
      // 造一条 draft 行模拟 TK-08（PUT /records/today/draft）的产物；GET 本身不建行（见 F1-01-T1）
      const submitter = await db.select({ id: records.submitterId }).from(records).limit(1);
      await db.insert(records).values({
        recordNo: TEST_RECORD_NO,
        dutyDate,
        submitterId: submitter[0]?.id ?? 1,
        status: 'draft',
        waterReading: '49239.0',
      });

      const body = await fetchToday();

      // 今日记录状态由 null 转 draft（契约 §3.2「今日记录状态」）
      expect(body.record?.status).toBe('draft');
      expect(body.record?.record_no).toBe(TEST_RECORD_NO);

      // 判据「计数与实际一致」：只有表房卡的水表读数被填，其余卡不受影响
      const waterCard = body.cards.find((c) => c.key === 'water');
      expect(waterCard?.badge).toEqual({ filled: 1, total: 1, pending: 0, abnormal: 0 });
      expect(waterCard?.fields.find((f) => f.name === 'water_reading')?.filled).toBe(true);
      expect(waterCard?.fields.find((f) => f.name === 'water_reading')?.value).toBe('49239.0');
      expect(body.cards.find((c) => c.key === 'electricity')?.badge.filled).toBe(0);

      // 顶部进度条 = 12 张卡角标之和
      expect(body.progress.filled).toBe(1);
      expect(body.progress.pending).toBe(COUNTABLE_FIELD_TOTAL - 1);
      expect(body.progress.total).toBe(COUNTABLE_FIELD_TOTAL);
      const sumFilled = body.cards.reduce((n, c) => n + c.badge.filled, 0);
      expect(body.progress.filled).toBe(sumFilled);

      // 板块汇总同步反映（板块一 = 表房卡）
      expect(body.sections.find((s) => s.no === 1)?.badge.filled).toBe(1);
    });

    it('出现异常项 → 异常角标计数 +1 且逐字段可定位（异常角标变色的数据源）', async () => {
      // 高配房状态选"异常"：附录 A「异常时必填备注，触发预警」；
      // PRD §6.2 明确 Phase 1 无独立预警，"预警项"即表单级标红项，故实时判 status='bad'
      await db
        .update(records)
        .set({ hpStatus: 'bad', hpNote: '高压配电室温度偏高（TK-05 测试）' })
        .where(eq(records.recordNo, TEST_RECORD_NO));

      const body = await fetchToday();
      const hpCard = body.cards.find((c) => c.key === 'electricity');

      // 判据「异常角标变色」的数据源：badge.abnormal 转为 1，前端据此换色
      expect(hpCard?.badge.abnormal).toBe(1);
      const abnormalFields = hpCard?.fields.filter((f) => f.abnormal).map((f) => f.name);
      expect(abnormalFields).toEqual(['hp_status']);
      // hp_status 选“异常”**同时命中两个独立维度**：它是 countable 字段故 filled+1，
      // 值为 bad 故 abnormal+1——“已填”与“异常”不是互斥状态，前端据此分别画进度与变色角标。
      // hp_note 为条件必填：不计入分母，故填了它也不改 total。
      expect(hpCard?.badge).toEqual({ filled: 1, total: 3, pending: 2, abnormal: 1 });

      // 异常沿卡片→板块→进度条三级汇总（F1-03「实时汇总」）
      expect(body.sections.find((s) => s.no === 2)?.badge.abnormal).toBe(1);
      expect(body.progress.abnormal).toBe(1);

      // 数值 0 算已填（0 是有效读数，不可用 falsy 判定）
      await db
        .update(records)
        .set({ bPulm: 0, waterReading: '0.0' })
        .where(eq(records.recordNo, TEST_RECORD_NO));
      const zeroBody = await fetchToday();
      const cyl = zeroBody.cards.find((c) => c.key === 'cylinder');
      expect(cyl?.fields.find((f) => f.name === 'b_pulm')?.filled).toBe(true);
      expect(cyl?.badge.filled).toBe(1);
      expect(zeroBody.cards.find((c) => c.key === 'water')?.fields[0]?.filled).toBe(true);
    });

    it('待同步标记为占位 false：离线队列在客户端，服务器零感知（F1-07-T2 口径）', async () => {
      const body = await fetchToday();
      // 契约 §3.2 要求返回"待同步标记"，但离线待同步队列存于客户端 IndexedDB，
      // F1-07-T2 判据即「服务器无感知（无 draft 泄露）」→ 服务端恒返回占位 false，
      // 真值由前端本地队列 OR 合并（TK-08 草稿层 / TK-15 离线三层缓冲接管）
      expect(body.pending_sync).toBe(false);
    });
  });
});
