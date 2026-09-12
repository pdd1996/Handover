/**
 * TK-12 在线提交与预览测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - F1-10-T1 提交前汇总预览：未填项/异常项清单与实际数据一致（C-09 逐条点名结构）
 * - F2-01-T1 提交 → 生成正式交接单（record_no）→ 接班人按排班表自动带出（receiver=排班表次日人）
 * - F1-08-T2 数值超范围 → 提交 → 拦截并点名（VALIDATION_OUT_OF_RANGE + 字段定位）；
 *   含 TK-06 评审挂账复验：parseNumeric 十进制字面量收紧（'0x10'/'1e3' 不放行）与
 *   FIELD_PRECISION 派生录入上限（t1_p830 max=999.99）
 * - DATA-01-T1 液氧 8 项读数缺任一 → 拦截并点名（逐项遍历）
 * - DATA-05-T1 接口层复验（TK-10 挂账）：停机整卡放行 + **submit 时停机三项强制写 NULL**
 *   （台账增补 #16：落库第二道防线，撤回重提/离线重放旧值不复活）；运行缺项 400 逐条点名
 * - DATA-07-T1 数组落库复验（TK-11 挂账）：hvac_locs 多选值以 JSON 数组原样落库
 * - DATA-09-T1 交接时间 = 服务端收到时刻（离线场景下即同步成功时刻）；客户端上送的
 *   submitted_at/duty_date 不被采信（记录级字段服务端为准）
 * - DATA-10-T1 修改接班人 → 必填原因 → 留痕（receiver_change_reason 落库 + 审计 reason）
 * - DATA-13-T1/T2 服务端半边复验（TK-09 挂账）：lo_measured_am/pm 原样落库、不被同步时刻覆盖
 * - RECORD_EXISTS 当日已提交不可重复提交（F1-01 duty_date 唯一）
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * 必须串行跑（--runInBand，与其它 spec 共库）。每次提交成功的用例在用例内即删自建记录
 * （duty_date 唯一，不删会令后续提交 409），afterAll 兜底清理并还原审计/会话。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, gt } from 'drizzle-orm';
import request from 'supertest';
import type { PreviewDto, SubmitPayloadDto, SubmitResultDto, TodayDto } from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, records, schedules, sessions, users } from '../db/schema';
import { plusOneDay } from './duty-date';
import { recordNoOf, RecordsService } from './records.service';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';
const PREVIEW_API = '/api/v1/records/today/preview';
const SUBMIT_API = '/api/v1/records/today/submit';
const TODAY_API = '/api/v1/records/today';

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
 * 全量合法 payload（判据基准值）：状态全「正常」→ 备注类条件必填不触发；
 * 锅炉选「停机」→ 三项停机列不参与必填（且带残留值验证强制 NULL）。
 */
function fullSections(): Record<string, unknown> {
  return {
    water_reading: '100.0',
    e1_reading: '200.0',
    e2_reading: '150.0',
    hp_status: 'ok',
    g1_remaining: '300.0',
    g2_remaining: '250.0',
    tank_in_use: 1,
    ...Object.fromEntries(
      LO_EIGHT.map((n) => [n, n.endsWith('_p') || n.includes('_p') ? '0.80' : '5000.00']),
    ),
    lo_measured_am: '2026-09-12 08:12:00',
    lo_measured_pm: '2026-09-12 20:15:00',
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
    // 停机残留值：校验层放行（DATA-05-T1 判据），落库层强制 NULL（增补 #16）
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
  };
}

/** 全量 payload（可覆写字段；del 键从 sections 删除而非置 null，模拟「未填」） */
function payload(over: {
  set?: Record<string, unknown>;
  del?: readonly string[];
  receiverId?: number;
  reason?: string;
}): SubmitPayloadDto {
  const sections = fullSections();
  for (const k of over.del ?? []) delete sections[k];
  Object.assign(sections, over.set ?? {});
  const p: SubmitPayloadDto = { sections };
  if (over.receiverId != null) p.receiver_id = over.receiverId;
  if (over.reason != null) p.receiver_change_reason = over.reason;
  return p;
}

describe('TK-12 在线提交与预览（F1-10/F2-01/F1-08/DATA-01/05/07/09/10/13）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let service: RecordsService;
  let auditHighWater = 0;
  let masterCookie = '';
  let chiefCookie = '';
  let dutyDate = '';
  /** 次日排班人（F2-01-T1 判据基准；从种子排班表取，不硬编码轮值序——防同源盲区） */
  let scheduled: { id: number; real_name: string };

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
    service = app.get(RecordsService);
    server = app.getHttpServer() as Server;

    await db.delete(sessions);
    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);

    masterCookie = await login('zhang');
    chiefCookie = await login('chief');
    dutyDate = (await service.resolveDutyDate()).dutyDate;

    const rows = await db
      .select({ id: users.id, realName: users.realName })
      .from(schedules)
      .innerJoin(users, eq(schedules.userId, users.id))
      .where(eq(schedules.dutyDate, plusOneDay(dutyDate)))
      .limit(1);
    if (!rows[0]) throw new Error('种子排班表缺次日行（D+1），请先 db:setup 重灌');
    scheduled = { id: rows[0].id, real_name: rows[0].realName };
  });

  afterAll(async () => {
    // 还原：本测试自建的记录（按班次日期）、新增审计行、会话存根（种子 D0 留空，records=10 口径）
    await db.delete(records).where(eq(records.dutyDate, dutyDate));
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  /** 删除当前班次自建记录（提交成功类用例的用例内清理，避免后续 409） */
  async function cleanRecord(): Promise<void> {
    await db.delete(records).where(eq(records.dutyDate, dutyDate));
  }

  /** 当前班次的记录行（无则为 undefined） */
  async function recordRow() {
    const rows = await db.select().from(records).where(eq(records.dutyDate, dutyDate)).limit(1);
    return rows[0];
  }

  describe('F1-10-T1 提交前汇总预览（TK-12）', () => {
    it('部分填写 → 未填项清单与实际数据一致（C-09 逐条点名 + 锚点）', async () => {
      const res = await request(server)
        .post(PREVIEW_API)
        .set('Cookie', masterCookie)
        .send(payload({ del: ['water_reading', 'hvac_locs', 'p1_level'] }))
        .expect(201);

      const body = res.body as PreviewDto;
      expect(body.duty_date).toBe(dutyDate);
      const fields = body.missing_fields.map((m) => m.field);
      for (const name of ['water_reading', 'hvac_locs', 'p1_level']) {
        expect(fields).toContain(name);
      }
      // 清单结构与契约 §2 同构：label/section/anchor 齐备（点击跳转可达）
      const water = body.missing_fields.find((m) => m.field === 'water_reading')!;
      expect(water.label).toBe('水表读数');
      expect(water.section).toBe(1);
      expect(water.anchor).toBe('#sec-1-water-reading');

      // 异常项：hp_status='bad' → 进异常清单；未填项不受其影响（两清单独立）
      const abnormalRes = await request(server)
        .post(PREVIEW_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { hp_status: 'bad' }, del: ['hp_note'] }))
        .expect(201);
      const abnormal = (abnormalRes.body as PreviewDto).abnormal_fields.map((m) => m.field);
      expect(abnormal).toContain('hp_status');
      expect((abnormalRes.body as PreviewDto).missing_fields.map((m) => m.field)).toContain(
        'hp_note',
      );
    });

    it('预览与提交同口径（评审修复轮 L4）：枚举越值在预览即点名', async () => {
      const res = await request(server)
        .post(PREVIEW_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { boiler_run: 'unknown' } }))
        .expect(201);
      expect((res.body as PreviewDto).missing_fields.map((m) => m.field)).toContain('boiler_run');
    });

    it('全量合法 payload → 未填项清零（仅剩异常项清单为空）', async () => {
      const res = await request(server)
        .post(PREVIEW_API)
        .set('Cookie', masterCookie)
        .send(payload({}))
        .expect(201);
      expect((res.body as PreviewDto).missing_fields).toHaveLength(0);
      expect((res.body as PreviewDto).abnormal_fields).toHaveLength(0);
    });
  });

  describe('F2-01-T1 提交生成正式交接单 + 接班人带出（TK-12）', () => {
    it('提交 → record_no 生成、status=submitted、receiver=排班表次日人；首页回显接班人', async () => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({}))
        .expect(201);

      const body = res.body as SubmitResultDto;
      expect(body.record_no).toBe(recordNoOf(dutyDate));
      expect(body.record_no).toMatch(/^HB-\d{8}-\d{3}$/);
      expect(body.status).toBe('submitted');
      expect(body.receiver).toEqual({ id: scheduled.id, real_name: scheduled.real_name });
      expect(body.receiver_changed).toBe(false);

      const row = await recordRow();
      expect(row?.recordNo).toBe(body.record_no);
      expect(row?.status).toBe('submitted');
      expect(row?.receiverId).toBe(scheduled.id);
      expect(row?.version).toBe(1);

      // 首页回显（DATA-10 带出口径对 GET /records/today 生效）
      const today = await request(server).get(TODAY_API).set('Cookie', masterCookie).expect(200);
      expect((today.body as TodayDto).receiver).toEqual({
        id: scheduled.id,
        real_name: scheduled.real_name,
      });
      await cleanRecord();
    });

    it('当日已提交 → 再提交 409 RECORD_EXISTS（F1-01 duty_date 唯一）', async () => {
      await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({}))
        .expect(201);
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({}))
        .expect(409);
      expect(res.body.code).toBe('RECORD_EXISTS');
      await cleanRecord();
    });

    it('科长提交 → 403 FORBIDDEN（提交是师傅端写操作，契约 §3.2 角色列 master）', async () => {
      await request(server)
        .post(SUBMIT_API)
        .set('Cookie', chiefCookie)
        .send(payload({}))
        .expect(403);
    });

    it('撤回重提快照（评审修复轮 M5）：draft 行未上送的列被清空，不再残留旧值', async () => {
      // 预置 draft 行（模拟撤回后的记录态，正式号与提交生成式同源）
      await db.insert(records).values({
        recordNo: recordNoOf(dutyDate),
        dutyDate,
        submitterId: 1,
        status: 'draft',
        version: 1,
        energyNote: '上一版遗留的节能减排事项',
        waterReading: '999.9',
      });
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({})) // 全量 payload 不含 energy_note（选填未填）
        .expect(201);
      expect((res.body as SubmitResultDto).version).toBe(2);
      const row = await recordRow();
      expect(row?.status).toBe('submitted');
      expect(row?.energyNote).toBeNull(); // 未上送 → 快照清列（不再残留）
      expect(row?.waterReading).toBe('100.0'); // 上送覆盖
      await cleanRecord();
    });
  });

  describe('F1-08-T2 数值超范围 → 拦截并点名（含 TK-06 评审挂账复验）', () => {
    it('越界值 → 400 VALIDATION_OUT_OF_RANGE + 字段定位（锚点）', async () => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { water_reading: '999999999999' } })) // (12,1) 上限 99999999999.9
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
      const fields = res.body.missing_fields.map((m: { field: string }) => m.field);
      expect(fields).toContain('water_reading');
      expect(res.body.missing_fields[0].anchor).toBe('#sec-1-water-reading');
    });

    it('FIELD_PRECISION 派生上限（TK-06 评审 M4）：t1_p830 (5,2) → 999.99 放行 / 1000 拦截', async () => {
      const ok = await request(server)
        .post(PREVIEW_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { t1_p830: '999.99' } }))
        .expect(201);
      expect((ok.body as PreviewDto).missing_fields).toHaveLength(0);

      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { t1_p830: '1000' } }))
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
      expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain('t1_p830');
    });

    it('parseNumeric 十进制字面量收紧（TK-06 评审 M5）：0x10 / 1e3 不再放行', async () => {
      for (const bad of ['0x10', '1e3', 'Infinity']) {
        const res = await request(server)
          .post(SUBMIT_API)
          .set('Cookie', masterCookie)
          .send(payload({ set: { e1_reading: bad } }))
          .expect(400);
        expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
        expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain(
          'e1_reading',
        );
      }
    });

    it('枚举列越值 → 400 点名（防 MySQL 层 500）；INT 列越精度同拦', async () => {
      const enumRes = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { boiler_run: 'unknown' } }))
        .expect(400);
      expect(enumRes.body.code).toBe('VALIDATION_OUT_OF_RANGE');
      expect(enumRes.body.missing_fields.map((m: { field: string }) => m.field)).toContain(
        'boiler_run',
      );

      const intRes = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { b40: 99999999999 } })) // INT (10,0) 上限 9999999999
        .expect(400);
      expect(intRes.body.missing_fields.map((m: { field: string }) => m.field)).toContain('b40');
    });

    it('列精度小数位（评审修复轮 M1）：water_reading(12,1) 上送 100.05 → 400 点名（不再静默四舍五入）', async () => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { water_reading: '100.05' } }))
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
      expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain(
        'water_reading',
      );
    });

    it('小数位边界（评审修复轮 M1）：合法 2 位不误报；0.0000001（7 位入 (5,2)）→ 400（不再被抹零）', async () => {
      const ok = await request(server)
        .post(PREVIEW_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { lo_station_press: '0.01' } }))
        .expect(201);
      expect((ok.body as PreviewDto).missing_fields).toHaveLength(0);

      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { lo_station_press: '0.0000001' } }))
        .expect(400);
      expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain(
        'lo_station_press',
      );
    });

    it('INT 列小数（评审修复轮 M1）：b40 上送 10.7 → 400 点名（不再静默截断为 10）', async () => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { b40: '10.7' } }))
        .expect(400);
      expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain('b40');
    });

    it('文本列长度（评审修复轮 M2）：hp_note varchar(200) 上送 300 字 → 400 点名（不再 500）', async () => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { hp_note: 'x'.repeat(300) } }))
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
      expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain('hp_note');
    });

    it('多选元素类型（评审修复轮 L3）：hvac_locs 混入非字符串 → 400 点名（成员性仍不校验）', async () => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { hvac_locs: ['手术部', { a: 1 }, null] } }))
        .expect(400);
      expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain('hvac_locs');
    });

    it('测量时刻日历非法（评审修复轮 M3）：2026-13-45 99:99:99 → 提交通过且落库 NULL（不再 500）', async () => {
      await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ set: { lo_measured_am: '2026-13-45 99:99:99' } }))
        .expect(201);
      const row = await recordRow();
      expect(row?.loMeasuredAm).toBeNull(); // 非法置 NULL，不覆盖为服务端时刻（D-P12）
      expect(row?.loMeasuredPm).toBe('2026-09-12 20:15:00'); // 合法值仍原样
      await cleanRecord();
    });
  });

  describe('DATA-01-T1 液氧 8 项读数缺任一 → 拦截并点名（TK-12 复验）', () => {
    it.each(LO_EIGHT)('缺 %s → 400 且点名该列（8 列全必填）', async (field) => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ del: [field] }))
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_MISSING_FIELDS');
      expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain(field);
    });
  });

  describe('DATA-05-T1 接口层复验（TK-10 挂账：落库第二道防线）', () => {
    it('停机 + 停机列残留值 → 提交通过，三项强制写 NULL（增补 #16）', async () => {
      await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({}))
        .expect(201);
      const row = await recordRow();
      expect(row?.boilerRun).toBe('stop');
      expect(row?.boilerNo).toBeNull();
      expect(row?.supplyTemp).toBeNull();
      expect(row?.returnTemp).toBeNull();
      await cleanRecord();
    });

    it('锅炉运行但三项缺项 → 400 逐条点名（停机放行、运行拦截的双向复验）', async () => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(
          payload({ set: { boiler_run: 'run' }, del: ['boiler_no', 'supply_temp', 'return_temp'] }),
        )
        .expect(400);
      const fields = res.body.missing_fields.map((m: { field: string }) => m.field);
      for (const name of ['boiler_no', 'supply_temp', 'return_temp'])
        expect(fields).toContain(name);
    });
  });

  describe('DATA-07-T1 数组落库复验（TK-11 挂账）+ DATA-13 服务端半边复验（TK-09 挂账）', () => {
    it('hvac_locs 多选值以 JSON 数组原样落库；测量时刻原样落库不被服务端时刻覆盖', async () => {
      await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({}))
        .expect(201);
      const row = await recordRow();
      // DATA-07-T1：数组原样（不做候选成员性校验，契约 §3.7）
      expect(row?.hvacLocs).toEqual(['手术部', 'ICU']);
      // DATA-13-T1/T2：客户端本机时间戳原样落库（≠ 服务端收到时刻，2026-09-12 08:12:00 为上送值）
      expect(row?.loMeasuredAm).toBe('2026-09-12 08:12:00');
      expect(row?.loMeasuredPm).toBe('2026-09-12 20:15:00');
      // DATA-09-T1：submitted_at = 服务端收到时刻（与上送的固定测量时刻不同、且贴近当前时刻）
      expect(row?.submittedAt).not.toBe('2026-09-12 08:12:00');
      // 本地时间字符串比较：同一格式化函数双向归一（Asia/Shanghai，与 duty-date.ts 同口径）
      const toMs = (v: string) => Date.parse(v.replace(' ', 'T') + 'Z');
      const serverNow = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date());
      expect(Math.abs(toMs(row!.submittedAt!) - toMs(serverNow))).toBeLessThan(5 * 60 * 1000);
      // 客户端伪造 submitted_at / duty_date 不被采信（记录级字段服务端为准）
      expect(row?.dutyDate).toBe(dutyDate);
      await cleanRecord();
    });

    it('用量列不信任客户端传值，由服务端按上一班（种子 D-1）计算固化（TK-13，契约 §4 第 3 步）', async () => {
      await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(
          payload({ set: { water_use: '999', e_use: '999', gas_use: '999', lo_day_use: '999' } }),
        )
        .expect(201);
      const row = await recordRow();
      // 诱饵传值 999 全部不采信；服务端按种子 D-1（水 12250 / 电 53420+43150 / 气 310+210）
      // 与本班 fullSections 基准值计算（黄金期望口径同 records-usage.spec.ts）：
      // 水子 100−12250=−12150；电 (200−53420)+(150−43150)=−96220；气 (310−300)+(210−250)=−30；
      // 液氧 tank 1 在用罐 5000.00−5000.00=0。负差不夹逼（换表/充气真实场景原样固化，
      // 防呆确认与覆盖留痕分属 TK-14/F3-06）
      expect(Number(row?.waterUse)).toBe(-12150);
      expect(Number(row?.eUse)).toBe(-96220);
      expect(Number(row?.gasUse)).toBe(-30);
      expect(Number(row?.loDayUse)).toBe(0);
      await cleanRecord();
    });
  });

  describe('DATA-10-T1 修改接班人 → 必填原因 → 留痕（TK-12）', () => {
    it('修改接班人不填原因 → 400 点名 receiver_change_reason（section 0）', async () => {
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ receiverId: scheduled.id === 1 ? 2 : 1 }))
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_MISSING_FIELDS');
      const item = res.body.missing_fields.find(
        (m: { field: string }) => m.field === 'receiver_change_reason',
      );
      expect(item).toBeDefined();
      expect(item.section).toBe(0);
      expect(item.anchor).toBe('#sec-0-receiver-change-reason');
    });

    it('修改接班人 + 原因 → 落库 + 审计留痕（reason 列），响应 receiver_changed=true', async () => {
      const others = await db.select({ id: users.id, realName: users.realName }).from(users);
      const target = others.find((u) => u.id !== scheduled.id && u.realName !== '陈科长')!;
      // 审计水位线（用例内）：前面用例已有成功提交的 record.submit 行，只断言本用例新增的一行
      const allAuditIds = await db.select({ id: auditLogs.id }).from(auditLogs);
      const auditHigh = allAuditIds.reduce((max, r) => Math.max(max, r.id), 0);
      const res = await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({ receiverId: target.id, reason: '次日张师傅请假，改为他人顶班' }))
        .expect(201);

      const body = res.body as SubmitResultDto;
      expect(body.receiver_changed).toBe(true);
      expect(body.receiver).toEqual({ id: target.id, real_name: target.realName });

      const row = await recordRow();
      expect(row?.receiverId).toBe(target.id);
      expect(row?.receiverChangeReason).toBe('次日张师傅请假，改为他人顶班');

      // 留痕：审计 reason 列含修改原因（契约 §5 record.submit + 各确认原因）
      const audits = await db.select().from(auditLogs).where(gt(auditLogs.id, auditHigh));
      expect(audits).toHaveLength(1);
      const audit = audits[0]!;
      expect(audit.reason).toContain('次日张师傅请假，改为他人顶班');
      expect(audit.targetId).toBe(body.record_no);
      await cleanRecord();
    });

    describe('无次日排班基线（评审修复轮 M4 保守口径：由空改为有人亦是修改）', () => {
      /** 临时删除 D+1 排班行制造「无带出基线」态，finally 无条件还原（records-prev.spec 同纪律） */
      async function withoutTomorrowSchedule<T>(run: () => Promise<T>): Promise<T> {
        const target = plusOneDay(dutyDate);
        const saved = await db.select().from(schedules).where(eq(schedules.dutyDate, target));
        await db.delete(schedules).where(eq(schedules.dutyDate, target));
        try {
          return await run();
        } finally {
          const savedRow = saved[0];
          if (savedRow) {
            // 显式列重建（避开 lint 对未用解构变量的告警），id 自增不回写
            await db.insert(schedules).values({
              dutyDate: savedRow.dutyDate,
              userId: savedRow.userId,
              updatedBy: savedRow.updatedBy,
              updatedAt: savedRow.updatedAt,
            });
          }
          const restored = await db
            .select({ id: schedules.id })
            .from(schedules)
            .where(eq(schedules.dutyDate, target));
          expect(restored).toHaveLength(1); // 还原哨兵
        }
      }

      it('伪造 receiver_id=99999 → 400 点名 receiver_id（不再绕过校验直撞 FK 500）', async () => {
        await withoutTomorrowSchedule(async () => {
          const res = await request(server)
            .post(SUBMIT_API)
            .set('Cookie', masterCookie)
            .send(payload({ receiverId: 99999 }))
            .expect(400);
          expect(res.body.code).toBe('VALIDATION_MISSING_FIELDS');
          expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain(
            'receiver_id',
          );
        });
      });

      it('无基线指定他人、未填原因 → 400 点名 receiver_change_reason（不再无留痕放行）', async () => {
        const others = await db.select({ id: users.id }).from(users);
        const target = others.find((u) => u.id !== scheduled.id && u.id !== 5)!; // 5=chief
        await withoutTomorrowSchedule(async () => {
          const res = await request(server)
            .post(SUBMIT_API)
            .set('Cookie', masterCookie)
            .send(payload({ receiverId: target.id }))
            .expect(400);
          expect(res.body.missing_fields.map((m: { field: string }) => m.field)).toContain(
            'receiver_change_reason',
          );
        });
      });

      it('无基线 + 原因 + 有效 id → 201 留痕（receiver_changed=true）', async () => {
        const others = await db.select({ id: users.id, realName: users.realName }).from(users);
        const target = others.find((u) => u.id !== scheduled.id && u.realName !== '陈科长')!;
        await withoutTomorrowSchedule(async () => {
          const res = await request(server)
            .post(SUBMIT_API)
            .set('Cookie', masterCookie)
            .send(payload({ receiverId: target.id, reason: '当日排班空缺，临时指定顶班' }))
            .expect(201);
          const body = res.body as SubmitResultDto;
          expect(body.receiver_changed).toBe(true);
          expect(body.receiver).toEqual({ id: target.id, real_name: target.realName });
          const row = await recordRow();
          expect(row?.receiverId).toBe(target.id);
          expect(row?.receiverChangeReason).toBe('当日排班空缺，临时指定顶班');
          await cleanRecord();
        });
      });
    });
  });

  describe('黄金值哨兵：record_no 格式（评审修复轮 L5）', () => {
    it('recordNoOf 钉死技术方案 §4.2 DDL 注释原文示例（防期望与实现同构盲区）', () => {
      expect(recordNoOf('2026-08-27')).toBe('HB-20260827-001');
      expect(recordNoOf('2026-09-12')).toMatch(/^HB-\d{8}-\d{3}$/);
    });
  });
});
