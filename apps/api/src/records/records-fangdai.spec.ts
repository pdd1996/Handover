/**
 * TK-14 防呆三则 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - F1-12-T1（接口）读数小于上一班 → 提交 409 要求确认；带确认原因重提 → 成功（确认与原因写 audit_logs.reason）
 * - F1-12-T2（接口）收到 409 后不带确认直接重提 → 仍被拒（服务端不因重试而放行）
 * - F1-13-T1（接口）主卡剩余量增大 → 充气确认 → 该卡按 0、另一卡正常计算；充气留痕
 * - F1-13-T2（接口）双卡剩余量均增大且均确认 → 双卡按 0 计，不出现负用量
 * - F3-07-T1（接口）上一班数据缺失 → 补录上一班读数 → 可计算（补录后计算正确）
 *
 * 口径出处：技术方案 §5.2（用量计算与防呆）；决策记录 D-P14（充气按单卡判定）、
 * D-T17（上一班 = 相邻班次已提交记录）、D-T19（防呆判定范围与补录协议——补录值不落
 * records 列、审计 record.prev_backfill 留痕、仅缺失态消费）。
 *
 * **接口部分需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * 串行跑（--runInBand，与其它 spec 共库）。上一班数据源 = 种子 D-1 行（标准日模板 k=9：
 * 水 12250.0 / 电 53420.0+43150.0 / 气 310.0+210.0），读数基准以哨兵钉死——种子模板改动
 * 时此处显式红。F3-07-T1 用 try/finally 临时平移相邻班次行构造缺失态，离开前无条件还原。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, gt } from 'drizzle-orm';
import request from 'supertest';
import type { SubmitPayloadDto } from '@handover/shared';
import {
  decreasedReadingsOf,
  gasDayUseOf,
  refillCardsOf,
  type FieldValueGetter,
} from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, records, sessions } from '../db/schema';
import { minusOneDay } from './duty-date';
import { RecordsService } from './records.service';

// ── 单元：防呆判定纯函数（shared guard.ts）与充气取数层（calc.ts refilled 参数）────────

/** getter 构造（未列字段 → null，FieldValueGetter 口径） */
function getterOf(values: Partial<Record<string, number | string>>): FieldValueGetter {
  return (name) => values[name] ?? null;
}

describe('防呆判定纯函数（F1-12/F1-13 判定层，与用量计算分层）', () => {
  const cur = getterOf({
    water_reading: '12000.0',
    e1_reading: '53600.0',
    g1_remaining: '350.0',
    g2_remaining: '180.0',
  });
  const prev = getterOf({
    water_reading: '12250.0',
    e1_reading: '53420.0',
    g1_remaining: '310.0',
    g2_remaining: '210.0',
  });

  test('回退命中清单：只命中减小的走字字段，气卡不混入（判定范围 D-T19）', () => {
    expect(decreasedReadingsOf(cur, prev)).toEqual([
      { field: 'water_reading', prev: 12250, current: 12000 },
    ]);
  });

  test('充气命中清单：按卡逐项（D-P14），正常卡不混入', () => {
    expect(refillCardsOf(cur, prev)).toEqual([{ card: 1, prev: 310, current: 350 }]);
  });

  test('任一侧读数缺失 → 不判定（缺失态/首班放行，不误伤 F3-07/F1-15）', () => {
    expect(decreasedReadingsOf(getterOf({ water_reading: '1.0' }), getterOf({}))).toEqual([]);
    expect(refillCardsOf(getterOf({}), getterOf({ g1_remaining: '1.0' }))).toEqual([]);
  });
});

describe('gasDayUseOf 充气确认取数层（D-P14：确认卡按 0 计、另一卡正常）', () => {
  const cur = getterOf({ g1_remaining: '350.0', g2_remaining: '180.0' });
  const prev = getterOf({ g1_remaining: '310.0', g2_remaining: '210.0' });

  test('未确认 → 负差原样不夹逼（计算层与防呆判定分层的既有口径）', () => {
    expect(gasDayUseOf(cur, prev)).toEqual({ line1: -40, line2: 30, total: -10 });
  });

  test('确认主卡 → 主卡 0 + 副卡正常（F1-13-T1 口径）', () => {
    expect(gasDayUseOf(cur, prev, new Set([1]))).toEqual({ line1: 0, line2: 30, total: 30 });
  });

  test('双卡确认 → 双 0，不出现负用量（F1-13-T2 口径）', () => {
    expect(gasDayUseOf(cur, prev, new Set([1, 2]))).toEqual({ line1: 0, line2: 0, total: 0 });
  });
});

// ── 接口：提交侧防呆 409 与确认重提、补录协议（需真实 MySQL 与种子数据）──────────────

const PASSWORD = 'Handover@2026';
const PREVIEW_API = '/api/v1/records/today/preview';
const SUBMIT_API = '/api/v1/records/today/submit';

/** 种子 D-1（标准日模板 k=9）的上一班读数基准——模板改动时哨兵显式红（见文件头） */
const PREV = {
  water_reading: 12250.0,
  e1_reading: 53420.0,
  e2_reading: 43150.0,
  g1_remaining: 310.0,
  g2_remaining: 210.0,
};

/** 本班基准读数（相对 PREV 的黄金差值，同 records-usage.spec；用例内按需覆写） */
const CUR = {
  water_reading: '12500.0',
  e1_reading: '53800.0',
  e2_reading: '43520.0',
  g1_remaining: '280.0',
  g2_remaining: '180.0',
};

/** 全量合法 payload（基准同 records-usage.spec 的 usageSections） */
function validSections(): Record<string, unknown> {
  return {
    ...CUR,
    hp_status: 'ok',
    tank_in_use: 1,
    t1_c830: '2.80',
    t1_p830: '1.20',
    t1_c2030: '2.60',
    t1_p2030: '1.15',
    t2_c830: '48.00',
    t2_p830: '1.20',
    t2_c2030: '47.80',
    t2_p2030: '1.15',
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

function payload(over: {
  set?: Record<string, unknown>;
  confirm?: unknown[];
  backfill?: Record<string, unknown>;
}): SubmitPayloadDto {
  const p = { sections: { ...validSections(), ...(over.set ?? {}) } } as SubmitPayloadDto;
  if (over.confirm) (p as { confirmations?: unknown[] }).confirmations = over.confirm;
  if (over.backfill) (p as { prev_readings?: unknown }).prev_readings = over.backfill;
  return p;
}

describe('TK-14 提交侧防呆 409 与补录协议（F1-12-T1/T2、F1-13-T1/T2、F3-07-T1）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let service: RecordsService;
  let auditHighWater = 0;
  let masterCookie = '';
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
    configureApp(app);
    await app.init();
    db = app.get<Db>(DB);
    service = app.get(RecordsService);
    server = app.getHttpServer() as Server;

    await db.delete(sessions);
    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);

    masterCookie = await login('zhang');
    dutyDate = (await service.resolveDutyDate()).dutyDate;

    // 上一班基准哨兵：种子 D-1 行（相邻班次、非 draft）必须与文件头模板一致（TK-07 评审教训）
    const prevRows = await db
      .select()
      .from(records)
      .where(eq(records.dutyDate, minusOneDay(dutyDate)))
      .limit(1);
    const prev = prevRows[0];
    expect(prev).toBeDefined();
    expect(prev?.status).not.toBe('draft');
    expect(Number(prev?.waterReading)).toBe(PREV.water_reading);
    expect(Number(prev?.e1Reading)).toBe(PREV.e1_reading);
    expect(Number(prev?.e2Reading)).toBe(PREV.e2_reading);
    expect(Number(prev?.g1Remaining)).toBe(PREV.g1_remaining);
    expect(Number(prev?.g2Remaining)).toBe(PREV.g2_remaining);
  });

  afterAll(async () => {
    await db.delete(records).where(eq(records.dutyDate, dutyDate));
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  async function cleanRecord(): Promise<void> {
    await db.delete(records).where(eq(records.dutyDate, dutyDate));
  }

  async function recordRow() {
    const rows = await db.select().from(records).where(eq(records.dutyDate, dutyDate)).limit(1);
    return rows[0];
  }

  /** 409 之上新增的审计行（确认/补录留痕断言用） */
  async function newAudits(action: string) {
    return db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), gt(auditLogs.id, auditHighWater)));
  }

  it('F1-12-T1：读数小于上一班 → 409 要求确认；带确认原因重提 → 成功且原因留痕', async () => {
    // 首提：本次水表 12000 < 上一班 12250 → 409 + need_confirm 可解释清单
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ set: { water_reading: '12000.0' } }))
      .expect(409);
    expect(res.body.code).toBe('READINGS_DECREASED');
    expect(res.body.need_confirm).toHaveLength(1);
    expect(res.body.need_confirm[0]).toMatchObject({
      type: 'reading_decreased',
      field: 'water_reading',
      prev: 12250,
      current: 12000,
    });
    expect(await recordRow()).toBeUndefined(); // 拦截即未落库

    // 带确认原因重提 → 成功；用量按原始差值固化（确认 ≠ 改值，负差原样）
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { water_reading: '12000.0' },
          confirm: [
            { type: 'reading_decreased', field: 'water_reading', reason: '水表更换新表底数' },
          ],
        }),
      )
      .expect(201);
    const row = await recordRow();
    expect(Number(row?.waterUse)).toBe(-250);

    // 确认与原因写入 audit_logs（契约 §5：record.submit + 各确认原因）
    const audits = await newAudits('record.submit');
    const confirmed = audits.filter((a) => a.reason === '水表更换新表底数');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.newValue).toMatchObject({
      type: 'reading_decreased',
      field: 'water_reading',
      prev: 12250,
      current: 12000,
    });
    await cleanRecord();
  });

  it('F1-12-T2：收到 409 后不带确认重提 → 仍被拒；空白原因确认同待（不因重试放行）', async () => {
    const first = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ set: { water_reading: '12000.0' } }))
      .expect(409);
    expect(first.body.code).toBe('READINGS_DECREASED');

    // 不带确认直接重提 → 仍 409
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ set: { water_reading: '12000.0' } }))
      .expect(409);

    // 空白原因的确认视为未确认（与未上送同待）
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { water_reading: '12000.0' },
          confirm: [{ type: 'reading_decreased', field: 'water_reading', reason: '   ' }],
        }),
      )
      .expect(409);
    expect(await recordRow()).toBeUndefined();
  });

  it('F1-13-T1：主卡剩余量增大 → 充气确认 → 该卡按 0、另一卡正常计算；充气留痕', async () => {
    // 首提：主卡 350 > 上一班 310（充气）、副卡正常 → 409 GAS_REFILL_CONFIRMED 按卡点名
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ set: { g1_remaining: '350.0' } }))
      .expect(409);
    expect(res.body.code).toBe('GAS_REFILL_CONFIRMED');
    expect(res.body.need_confirm).toHaveLength(1);
    expect(res.body.need_confirm[0]).toMatchObject({
      type: 'gas_refill',
      card: 1,
      prev: 310,
      current: 350,
    });

    // 只确认副卡 → 主卡命中项仍未确认，仍 409（确认与命中项一一对应，不张冠李戴）
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { g1_remaining: '350.0' },
          confirm: [{ type: 'gas_refill', card: 2, reason: '副卡充气（错位确认不消费）' }],
        }),
      )
      .expect(409);

    // 确认主卡充气 → 主卡按 0、副卡正常：gas_use = 0 + (210 − 180) = 30
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { g1_remaining: '350.0' },
          confirm: [{ type: 'gas_refill', card: 1, reason: '上午充气 50 立方米' }],
        }),
      )
      .expect(201);
    const row = await recordRow();
    expect(Number(row?.gasUse)).toBe(30);

    const audits = await newAudits('record.submit');
    const confirmed = audits.filter((a) => a.reason === '上午充气 50 立方米');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.newValue).toMatchObject({
      type: 'gas_refill',
      card: 1,
      prev: 310,
      current: 350,
    });
    await cleanRecord();
  });

  it('F1-13-T2：双卡剩余量均增大且均确认 → 双卡按 0 计，不出现负用量', async () => {
    const set = { g1_remaining: '350.0', g2_remaining: '250.0' };
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ set }))
      .expect(409);
    expect(res.body.code).toBe('GAS_REFILL_CONFIRMED');
    expect(res.body.need_confirm).toHaveLength(2);

    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set,
          confirm: [
            { type: 'gas_refill', card: 1, reason: '主卡充气' },
            { type: 'gas_refill', card: 2, reason: '副卡购卡' },
          ],
        }),
      )
      .expect(201);
    const row = await recordRow();
    expect(Number(row?.gasUse)).toBe(0); // 双 0，不出现 −40 + −40 的负合计
    await cleanRecord();
  });

  it('补录读数非法（非十进制字面量）→ 400 越界点名（校验与消费解耦）', async () => {
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ backfill: { water_reading: '1e3' } }))
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
    expect((res.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).toContain(
      'water_reading',
    );
    // 阻止即未落库（垃圾补录值无论上一班是否缺失都不放行）
    expect(await recordRow()).toBeUndefined();
  });

  it('评审修复轮 L1：补录值超列容量/负值 → 400 越界点名（脏基线不进文案与审计）', async () => {
    // 超上限：(12,1) 列上限 99999999999.9，1000 亿不可作上一班基线
    const over = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ backfill: { water_reading: '999999999999' } }))
      .expect(400);
    expect(over.body.code).toBe('VALIDATION_OUT_OF_RANGE');
    expect((over.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).toContain(
      'water_reading',
    );
    // 负值：读数无负值语义（validation.ts 非负同门），-500 曾实证流入 need_confirm 文案
    const neg = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ backfill: { g1_remaining: '-500' } }))
      .expect(400);
    expect((neg.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).toContain(
      'g1_remaining',
    );
    expect(await recordRow()).toBeUndefined();
  });

  it('评审修复轮 M1：确认原因超 200 字 → 400 越界点名（字段字典名义），不再 500', async () => {
    // 评审探针实证：原实现直写 audit_logs.reason varchar(200) → 1406 → 事务回滚 500
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { water_reading: '12000.0' },
          confirm: [
            { type: 'reading_decreased', field: 'water_reading', reason: '长'.repeat(201) },
          ],
        }),
      )
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
    expect((res.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).toContain(
      'water_reading',
    );
    expect(await recordRow()).toBeUndefined();
  });

  it('评审修复轮 M1：充气确认原因超长 → 400 点名对应气卡字段（g1_remaining）', async () => {
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { g1_remaining: '350.0' },
          confirm: [{ type: 'gas_refill', card: 1, reason: '长'.repeat(201) }],
        }),
      )
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
    expect((res.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).toContain(
      'g1_remaining',
    );
    expect(await recordRow()).toBeUndefined();
  });

  it('评审修复轮 M1（M3/L4 同纪律）：preview 对超长确认原因同口径预检（预览即点名）', async () => {
    const res = await request(server)
      .post(PREVIEW_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { water_reading: '12000.0' },
          confirm: [
            { type: 'reading_decreased', field: 'water_reading', reason: '长'.repeat(201) },
          ],
        }),
      )
      .expect(201);
    expect((res.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).toContain(
      'water_reading',
    );
  });

  it('评审修复轮 M2：confirmations / usage_overrides 非数组 → 400 合成定位项点名（不再 500）', async () => {
    // 评审探针实证：原 for..of 迭代器异常 → 500 INTERNAL
    const badConfirm = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({ sections: validSections(), confirmations: { type: 'gas_refill' } })
      .expect(400);
    const confirmLabels = (badConfirm.body.missing_fields as Array<{ label: string }>).map(
      (m) => m.label,
    );
    expect(confirmLabels).toContain('防呆确认项格式非法（须为数组）');

    const badOverrides = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({ sections: validSections(), usage_overrides: { field: 'lo_day_use' } })
      .expect(400);
    const overrideLabels = (badOverrides.body.missing_fields as Array<{ label: string }>).map(
      (m) => m.label,
    );
    expect(overrideLabels).toContain('用量覆盖项格式非法（须为数组）');
    expect(await recordRow()).toBeUndefined();
  });

  it('F3-07-T1：上一班缺失 → 补录上一班读数 → 可计算（补录后计算正确）', async () => {
    // 构造缺失态（D-T17：相邻班次为 draft 即缺失，不回落）：相邻班次 D-1 行临时置 draft，
    // 旧行本体不动（种子行挂 record_versions 外键，插删行会撞约束；置 draft 无此风险），
    // finally 无条件还原（与其它 spec 共库，脏状态会污染后续 spec）
    const adjacent = minusOneDay(dutyDate);
    const snapshot = await db.select().from(records).where(eq(records.dutyDate, adjacent));
    expect(snapshot.length).toBe(1);
    const originalStatus = snapshot[0]?.status;
    expect(originalStatus).not.toBe('draft');
    try {
      await db.update(records).set({ status: 'draft' }).where(eq(records.dutyDate, adjacent));

      // 缺失态提交：不带补录时上一班 getter 全 null → 用量列留 null（不臆算）；
      // 带补录读数 → 以补录值为上一班基线计算
      await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(
          payload({
            backfill: {
              water_reading: '12000.0',
              e1_reading: '53000.0',
              e2_reading: '43000.0',
              g1_remaining: '300.0',
              g2_remaining: '200.0',
            },
          }),
        )
        .expect(201);
      const row = await recordRow();
      // 水 12500−12000=500；电 (53800−53000)+(43520−43000)=1320；气 (300−280)+(200−180)=40
      expect(Number(row?.waterUse)).toBe(500);
      expect(Number(row?.eUse)).toBe(1320);
      expect(Number(row?.gasUse)).toBe(40);

      // 补录留痕：record.prev_backfill 审计行存全量补录值（缺失班次不建行，F6-06 不受影响）
      const backfills = await newAudits('record.prev_backfill');
      expect(backfills).toHaveLength(1);
      expect(backfills[0]?.newValue).toMatchObject({
        readings: {
          water_reading: 12000,
          e1_reading: 53000,
          e2_reading: 43000,
          g1_remaining: 300,
          g2_remaining: 200,
        },
      });
      await cleanRecord();

      // 无补录的缺失态：用量列留 null（宁缺毋错，F3-07 缺失态与 F1-15 首班同「无上一班」口径）
      await request(server)
        .post(SUBMIT_API)
        .set('Cookie', masterCookie)
        .send(payload({}))
        .expect(201);
      const nullRow = await recordRow();
      expect(nullRow?.waterUse).toBeNull();
      expect(nullRow?.eUse).toBeNull();
      expect(nullRow?.gasUse).toBeNull();
      await cleanRecord();
    } finally {
      await db
        .update(records)
        .set({ status: originalStatus })
        .where(eq(records.dutyDate, adjacent));
    }
  });

  it('有上一班记录时补录值被忽略（服务端仅缺失态消费，防客户端缓存串台）', async () => {
    // 相邻班次正常在场：payload 里塞一份与 D-1 冲突的补录值 → 计算仍以 D-1 为基线，
    // 且不产生新的 prev_backfill 审计行（F3-07-T1 产生的行在计数比对中排除）
    const backfillAuditsBefore = (await newAudits('record.prev_backfill')).length;
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          backfill: {
            water_reading: '1.0',
            e1_reading: '1.0',
            e2_reading: '1.0',
            g1_remaining: '999.0',
            g2_remaining: '999.0',
          },
        }),
      )
      .expect(201);
    const row = await recordRow();
    // 黄金值同 records-usage.spec：水 250 / 电 750 / 气 60（与补录值无关）
    expect(Number(row?.waterUse)).toBe(250);
    expect(Number(row?.eUse)).toBe(750);
    expect(Number(row?.gasUse)).toBe(60);
    expect(await newAudits('record.prev_backfill')).toHaveLength(backfillAuditsBefore);
    await cleanRecord();
  });
});
