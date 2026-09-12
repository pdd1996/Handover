/**
 * TK-13 用量计算引擎 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - F3-01-T1（单元）每日用水量 = 本次读数 − 上一班读数 → "每日用水量 300（自动计算）"
 * - F3-02-T1（单元）如意线 +400 / 工贸线 +370、合计 770（分线差值 + 两线和，D-P09）
 * - F3-03-T1（单元）气卡剩余量减少值合计（方向与水表相反的口径正确）
 * - F3-04-T1（单元）在用罐 8:30→20:30 含量差 = 日间用量（按所选在用罐取数，loDayUseOf 同源）
 * - F3-04-T2（接口）手工修正日间用量 → 强制填写原因 → 原因留痕；修正值固化
 * - F3-06-T1（接口）自动计算字段带"自动计算"标识；标识与人工值可区分（manual 旗标）
 * - F3-06-T2（接口）覆盖自动值但不填原因 → 提交阻止（服务端校验，非仅前端）
 *
 * 口径出处：技术方案 §4.3（四类公式与上一班取数）、§5.2；决策记录 D-P08/D-P09/D-P14/D-T07、
 * D-T17（上一班 = 相邻班次已提交记录）。服务端与 h5 预览消费 shared calc.ts 同一纯函数。
 *
 * **接口部分需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * 串行跑（--runInBand，与其它 spec 共库）。上一班数据源 = 种子 D-1 行（标准日模板 k=9：
 * 水 12250.0 / 电 53420.0+43150.0 / 气 310.0+210.0，模板口径见《开发种子数据》§六），
 * 读数基准以哨兵钉死——种子模板改动时此处显式红，防期望值与实现同源盲区。
 * 提交成功类用例在用例内即删自建记录（duty_date 唯一），afterAll 兜底清理审计/会话。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, gt } from 'drizzle-orm';
import request from 'supertest';
import type { CardDto, SubmitPayloadDto, SubmitResultDto, TodayDto } from '@handover/shared';
import {
  eDayUseOf,
  gasDayUseOf,
  loDayUseOf,
  roundToScaleOf,
  USAGE_FIELDS,
  usageScaleOf,
  waterDayUseOf,
  type FieldValueGetter,
  type LineUse,
} from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, records, sessions } from '../db/schema';
import { minusOneDay } from './duty-date';
import { recordNoOf, RecordsService } from './records.service';

// ── 单元：四类口径黄金值（§4.3 公式的权威实现，无 IO）───────────────────────────

/** 上一班/本次读数的getter 构造（未列字段 → null，FieldValueGetter 口径） */
function getterOf(values: Partial<Record<string, number | string>>): FieldValueGetter {
  return (name) => values[name] ?? null;
}

describe('F3-01-T1 每日用水量 = 本次读数 − 上一班读数', () => {
  test('黄金值：上一班 48939、本次 49239 → 300（用例清单原文基准）', () => {
    expect(
      waterDayUseOf(getterOf({ water_reading: '49239.0' }), getterOf({ water_reading: '48939.0' })),
    ).toBe(300);
  });

  test('(12,1) 列小数位取整：0.069999… 尾差不得入库（100.05 − 99.98 → 0.1）', () => {
    expect(
      waterDayUseOf(getterOf({ water_reading: '100.05' }), getterOf({ water_reading: '99.98' })),
    ).toBe(0.1);
  });

  test('上一班缺失（getter 返回 null）→ null（用量列留空，不臆算；补录随 TK-14）', () => {
    expect(waterDayUseOf(getterOf({ water_reading: '100.0' }), getterOf({}))).toBeNull();
    expect(waterDayUseOf(getterOf({}), getterOf({ water_reading: '100.0' }))).toBeNull();
  });
});

describe('F3-02-T1 每日用电量 = 如意线差值 + 工贸线差值（分线同屏展示）', () => {
  test('黄金值：21000/16300 → 21400/16670 → 分线 +400/+370、合计 770（用例清单原文基准）', () => {
    const cur = getterOf({ e1_reading: '21400.0', e2_reading: '16670.0' });
    const prev = getterOf({ e1_reading: '21000.0', e2_reading: '16300.0' });
    expect(eDayUseOf(cur, prev)).toEqual({ line1: 400, line2: 370, total: 770 });
  });

  test('禁「读数之和」当用量（D-P09 立项理由）：合计恒为差值之和，与读数之和无关', () => {
    const cur = getterOf({ e1_reading: '21400.0', e2_reading: '16670.0' });
    const prev = getterOf({ e1_reading: '21000.0', e2_reading: '16300.0' });
    const r = eDayUseOf(cur, prev) as LineUse;
    expect(r.total).toBe(r.line1 + r.line2);
    expect(r.total).not.toBe(21400 + 16670);
  });

  test('任一线读数缺失 → null（不做单线部分计算，宁缺毋错）', () => {
    const prev = getterOf({ e1_reading: '21000.0', e2_reading: '16300.0' });
    expect(eDayUseOf(getterOf({ e1_reading: '21400.0' }), prev)).toBeNull();
    expect(
      eDayUseOf(getterOf({ e1_reading: '21400.0', e2_reading: '1.0' }), getterOf({})),
    ).toBeNull();
  });
});

describe('F3-03-T1 每日天然气用量 = 主卡+副卡剩余量减少值合计', () => {
  test('黄金值：500/480 → 470/450 → 30 + 30 = 60（方向与水表相反：剩余量递减为正）', () => {
    const cur = getterOf({ g1_remaining: '470.0', g2_remaining: '450.0' });
    const prev = getterOf({ g1_remaining: '500.0', g2_remaining: '480.0' });
    expect(gasDayUseOf(cur, prev)).toEqual({ line1: 30, line2: 30, total: 60 });
  });

  test('充气（剩余量增大）→ 负差原样返回不夹逼；「该卡按 0 计」是 TK-14 确认后的取数层', () => {
    const cur = getterOf({ g1_remaining: '550.0', g2_remaining: '450.0' });
    const prev = getterOf({ g1_remaining: '500.0', g2_remaining: '480.0' });
    expect(gasDayUseOf(cur, prev)).toEqual({ line1: -50, line2: 30, total: -20 });
  });

  test('任一卡读数缺失 → null', () => {
    const prev = getterOf({ g1_remaining: '500.0', g2_remaining: '480.0' });
    expect(gasDayUseOf(getterOf({ g1_remaining: '470.0' }), prev)).toBeNull();
  });
});

describe('F3-04-T1 液氧日间用量 = 在用罐 8:30→20:30 含量差（loDayUseOf 同源复用）', () => {
  test('黄金值：在用罐 8:30 含量 2.8、20:30 含量 2.6 → 0.2（用例清单原文基准）', () => {
    const get: FieldValueGetter = (name) =>
      name === 'tank_in_use'
        ? 1
        : name === 't1_c830'
          ? '2.80'
          : name === 't1_c2030'
            ? '2.60'
            : null;
    expect(loDayUseOf(get)).toBe(0.2);
  });

  test('备用罐读数不参与（与 DATA-04-T1 同一口径，两罐数值错开混淆即红）', () => {
    const get: FieldValueGetter = (name) =>
      name === 'tank_in_use'
        ? 2
        : name === 't2_c830'
          ? '9.90'
          : name === 't2_c2030'
            ? '9.60'
            : name === 't1_c830'
              ? '2.80'
              : name === 't1_c2030'
                ? '2.60'
                : null;
    expect(loDayUseOf(get)).toBe(0.3);
  });
});

describe('用量字段清单与取整口径哨兵（覆盖协议与服务端固化的键集/精度同源）', () => {
  test('USAGE_FIELDS 恰为四个服务端固化用量字段；lo_night_use（跨记录派生列）不在其内', () => {
    expect([...USAGE_FIELDS].sort()).toEqual(['e_use', 'gas_use', 'lo_day_use', 'water_use']);
  });

  test('usageScaleOf 与 FIELD_PRECISION 列小数位一致（水/电/气 (12,1)、液氧 (8,2)）', () => {
    expect(usageScaleOf('water_use')).toBe(1);
    expect(usageScaleOf('e_use')).toBe(1);
    expect(usageScaleOf('gas_use')).toBe(1);
    expect(usageScaleOf('lo_day_use')).toBe(2);
    expect(roundToScaleOf('lo_day_use', 0.2 + 0.05)).toBe(0.25);
    expect(roundToScaleOf('water_use', 250.049)).toBe(250);
  });
});

// ── 接口：提交时服务端计算固化 + 覆盖协议（需真实 MySQL 与种子数据）────────────────

const PASSWORD = 'Handover@2026';
const PREVIEW_API = '/api/v1/records/today/preview';
const SUBMIT_API = '/api/v1/records/today/submit';
const TODAY_API = '/api/v1/records/today';

/** 种子 D-1（标准日模板 k=9）的上一班读数基准——模板改动时哨兵显式红（见文件头） */
const PREV = {
  water_reading: 12250.0,
  e1_reading: 53420.0,
  e2_reading: 43150.0,
  g1_remaining: 310.0,
  g2_remaining: 210.0,
};

/** 本班读数（相对 PREV 的黄金差值：水 +250 / 电 +380+370 / 气 −30−30） */
const CUR = {
  water_reading: '12500.0',
  e1_reading: '53800.0',
  e2_reading: '43520.0',
  g1_remaining: '280.0',
  g2_remaining: '180.0',
};

/** 全量合法 payload（基准值同 records-submit.spec；液氧取 tank 1、c830 2.80 → c2030 2.60） */
function usageSections(): Record<string, unknown> {
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

function payload(over: { set?: Record<string, unknown>; overrides?: unknown[] }): SubmitPayloadDto {
  const p: SubmitPayloadDto = { sections: { ...usageSections(), ...(over.set ?? {}) } };
  if (over.overrides) {
    (p as { usage_overrides?: unknown[] }).usage_overrides = over.overrides;
  }
  return p;
}

describe('TK-13 提交侧用量固化与覆盖协议（F3-01/02/03/04-T2、F3-06-T1/T2）', () => {
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

    // 上一班基准哨兵：种子 D-1 行（相邻班次、非 draft）必须与文件头模板一致，
    // 否则本文件黄金期望失真——显式红比静默同源盲区好（TK-07 评审教训）；
    // 日历推算用生产侧 minusOneDay（评审修复轮：测试不再自行复刻日历算术，防同源盲区反向盲区）
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

  /** 今日首页各卡字段平铺（按字段名查找；lo_day_use 在 20:30 卡） */
  function fieldOf(cards: CardDto[], name: string) {
    for (const card of cards) {
      const f = card.fields.find((x) => x.name === name);
      if (f) return f;
    }
    return undefined;
  }

  it('F3-01/02/03/04 接口半边：提交 → 四类用量服务端计算固化；sections 里的 *_use 传值不采信', async () => {
    // 埋诱饵：客户端把错误的用量值塞进 sections——契约 §4 第 3 步必须忽略（不信任）
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { water_use: '999.9', e_use: '888.8', gas_use: '777.7', lo_day_use: '666.6' },
        }),
      )
      .expect(201);
    expect((res.body as SubmitResultDto).record_no).toBe(recordNoOf(dutyDate));

    const row = await recordRow();
    // 黄金值：水 12500−12250=250；电 (53800−53420)+(43520−43150)=380+370=750；
    // 气 (310−280)+(210−180)=30+30=60；液氧在用罐 2.80−2.60=0.2
    expect(Number(row?.waterUse)).toBe(250);
    expect(Number(row?.eUse)).toBe(750);
    expect(Number(row?.gasUse)).toBe(60);
    expect(Number(row?.loDayUse)).toBe(0.2);

    // F3-06-T1：自动计算字段带标识且与人工值可区分——无人覆盖时 manual 旗标缺省
    const today = await request(server).get(TODAY_API).set('Cookie', masterCookie).expect(200);
    const cards = (today.body as TodayDto).cards;
    for (const name of ['water_use', 'e_use', 'gas_use', 'lo_day_use']) {
      const f = fieldOf(cards, name);
      expect(f?.filled).toBe(true);
      expect(f?.manual).toBeUndefined();
    }
    await cleanRecord();
  });

  it('F3-04-T2：手工修正液氧日间用量（带原因）→ 修正值固化 + 原因留痕 + F3-06-T1 人工标识', async () => {
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          overrides: [{ field: 'lo_day_use', value: '0.50', reason: '日间补液 0.3L，按实际修正' }],
        }),
      )
      .expect(201);

    // 修正值固化（0.2 → 0.50，按 (8,2) 列口径）
    const row = await recordRow();
    expect(Number(row?.loDayUse)).toBe(0.5);
    // 未覆盖的三类仍为自动值
    expect(Number(row?.waterUse)).toBe(250);

    // 原因留痕：audit_logs.reason（技术方案 §5.5），oldValue 记覆盖前自动值
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'record.usage_override'), gt(auditLogs.id, auditHighWater)));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe('日间补液 0.3L，按实际修正');
    expect(audits[0]?.oldValue).toEqual({ field: 'lo_day_use', auto_value: 0.2 });
    expect(audits[0]?.newValue).toEqual({
      field: 'lo_day_use',
      value: '0.5',
      version: expect.any(Number),
    });

    // F3-06-T1：人工值标识——lo_day_use manual=true、其余自动字段 manual 缺省（可区分）
    const today = await request(server).get(TODAY_API).set('Cookie', masterCookie).expect(200);
    const cards = (today.body as TodayDto).cards;
    expect(fieldOf(cards, 'lo_day_use')?.manual).toBe(true);
    expect(fieldOf(cards, 'water_use')?.manual).toBeUndefined();
    await cleanRecord();
  });

  it('F3-06-T2：覆盖自动值但不填原因 → 提交阻止（服务端校验，400 点名该用量字段）', async () => {
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ overrides: [{ field: 'lo_day_use', value: '0.50', reason: '   ' }] }))
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_MISSING_FIELDS');
    const fields = (res.body.missing_fields as Array<{ field: string }>).map((m) => m.field);
    expect(fields).toContain('lo_day_use');
    // 阻止即未落库
    expect(await recordRow()).toBeUndefined();
  });

  it('覆盖值非法（非十进制字面量/超列上限）或越键 → 400 越界点名', async () => {
    const bad = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ overrides: [{ field: 'lo_day_use', value: '1e3', reason: '试' }] }))
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_OUT_OF_RANGE');
    expect((bad.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).toContain(
      'lo_day_use',
    );

    const overLimit = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({ overrides: [{ field: 'water_use', value: '99999999999999', reason: '试' }] }))
      .expect(400);
    expect(overLimit.body.code).toBe('VALIDATION_OUT_OF_RANGE');

    const badField = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({ overrides: [{ field: 'lo_night_use', value: '1', reason: '夜间用量不可覆盖' }] }),
      )
      .expect(400);
    expect(
      (badField.body.missing_fields as Array<{ label: string }>).map((m) => m.label),
    ).toContain('不支持的用量覆盖字段');
  });

  it('评审修复轮 M3：preview 对 usage_overrides 同口径预检（缺原因/越值点名，合法不误报）', async () => {
    // 缺原因 → 预览即点名（提交按钮不点亮），不再「预览全就绪、提交却 400」
    const noReason = await request(server)
      .post(PREVIEW_API)
      .set('Cookie', masterCookie)
      .send(payload({ overrides: [{ field: 'lo_day_use', value: '0.5', reason: '  ' }] }))
      .expect(201);
    expect(
      (noReason.body.missing_fields as Array<{ field: string }>).map((m) => m.field),
    ).toContain('lo_day_use');

    // 值越界 → 预览即点名
    const badValue = await request(server)
      .post(PREVIEW_API)
      .set('Cookie', masterCookie)
      .send(payload({ overrides: [{ field: 'lo_day_use', value: '1e3', reason: '试' }] }))
      .expect(201);
    expect(
      (badValue.body.missing_fields as Array<{ field: string }>).map((m) => m.field),
    ).toContain('lo_day_use');

    // 合法覆盖 → 预览不误报
    const ok = await request(server)
      .post(PREVIEW_API)
      .set('Cookie', masterCookie)
      .send(payload({ overrides: [{ field: 'lo_day_use', value: '0.50', reason: '按实际修正' }] }))
      .expect(201);
    expect((ok.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).not.toContain(
      'lo_day_use',
    );
  });

  it('评审修复轮 M4：覆盖原因超长 → 400 越界且以字段字典名义点名（非「不支持的用量覆盖字段」）', async () => {
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          overrides: [{ field: 'water_use', value: '1.0', reason: '长'.repeat(201) }],
        }),
      )
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE');
    const items = res.body.missing_fields as Array<{ field: string; label: string }>;
    const item = items.find((m) => m.field === 'water_use');
    expect(item?.label).toBe('每日用水量'); // 字典名义（section 1），不再误导为「不支持的字段」
  });

  it('评审修复轮 L4：同一字段重复上送覆盖项 → 400 点名（多行审计失真）', async () => {
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          overrides: [
            { field: 'lo_day_use', value: '0.50', reason: '第一次' },
            { field: 'lo_day_use', value: '0.60', reason: '第二次静默改写' },
          ],
        }),
      )
      .expect(400);
    expect((res.body.missing_fields as Array<{ field: string }>).map((m) => m.field)).toContain(
      'lo_day_use',
    );
  });

  it('评审修复轮 L3：两线差值之和超 DECIMAL(12,1) → e_use 置 null 不入库（不 500），其余列正常', async () => {
    // 两线读数各自合法（(12,1) 上限 99999999999.9）但差值之和超列容量：
    // (99999999999.8−53420)+(99999999999.8−43150)≈2e11 > 99999999999.9
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          set: { e1_reading: '99999999999.8', e2_reading: '99999999999.8' },
        }),
      )
      .expect(201); // 不再 500（DECIMAL 溢出 1264）
    const row = await recordRow();
    expect(row?.eUse).toBeNull();
    expect(Number(row?.waterUse)).toBe(250); // 其余列不受影响
    expect(Number(row?.gasUse)).toBe(60);
    await cleanRecord();
  });

  it('评审修复轮 M1：撤回重提（v2 无覆盖）→ manual 不再被 v1 覆盖审计污染，值回自动', async () => {
    // v1：带覆盖提交 → manual=true
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(
        payload({
          overrides: [{ field: 'lo_day_use', value: '0.50', reason: '日间补液按实际修正' }],
        }),
      )
      .expect(201);
    let today = await request(server).get(TODAY_API).set('Cookie', masterCookie).expect(200);
    expect(fieldOf((today.body as TodayDto).cards, 'lo_day_use')?.manual).toBe(true);

    // 模拟撤回（F2-08）：status 回 draft，重提不带覆盖 → v2 落自动值
    await db.update(records).set({ status: 'draft' }).where(eq(records.dutyDate, dutyDate));
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({}))
      .expect(201);
    expect((res.body as SubmitResultDto).version).toBe(2);
    const row = await recordRow();
    expect(Number(row?.loDayUse)).toBe(0.2); // 自动值

    // v2 的 manual 不得因 v1 的审计行而残留 true（record_no 同、版本不同）
    today = await request(server).get(TODAY_API).set('Cookie', masterCookie).expect(200);
    expect(fieldOf((today.body as TodayDto).cards, 'lo_day_use')?.manual).toBeUndefined();
    await cleanRecord();
  });
});
