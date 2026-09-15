/**
 * TK-17 电梯核对（表单端）测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - ELE-02-T1（接口半边）三种运行计划（24 小时/按时段/长期停运）在预期计算端点均正确解析
 *   （字典落库写半边随 TK-28；本文件锁定解析与计算半边）
 * - ELE-03-T1（单元）扶梯 06:00–22:00、核对 23:00 → 预期停运（check_time 锁定在接口用例断言）
 * - ELE-04-T1 一致一键确认 → actual=match 免填说明；ELE-04-T2 不一致未填说明 → 409 点名
 * - ELE-05-T1 预期按核对时刻锁定、提交时不重算（防「核对时一致、提交时翻转」假预警）
 * - ELE-06-T1 预期停运实际运行 → 提交生成标红项（alerts 行，Phase 1 标红 / P2 中预警）
 * - ELE-07-T1 预期运行实际停运且无说明 → 拦截并点名
 * - ELE-09-T1（单元）跨零点时段 22:00–06:00 的两端判定
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * 必须串行跑（--runInBand）。种子电梯窗口为占位 06:00–21:00（《开发种子数据》❓ 待总务科），
 * 时点断言以该窗口为基准；提交成功类用例在用例内即删自建记录（含 alerts/elevator_checks
 * 子行——FK 无级联，须先删子行），afterAll 兜底清理。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, gt } from 'drizzle-orm';
import request from 'supertest';
import {
  clockMinutesOf,
  expectedStatusAt,
  isMismatchOf,
  normalizeActualOf,
  parseWindowsOf,
  validateElevatorChecks,
  type ElevatorExpectedDto,
  type SubmitPayloadDto,
  type SubmitResultDto,
} from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import {
  alerts,
  auditLogs,
  elevatorChecks,
  elevators,
  records,
  sessions,
  users,
} from '../db/schema';
import { ElevatorsService } from '../elevators/elevators.service';
import { recordNoOf, RecordsService } from './records.service';

const PASSWORD = 'Handover@2026';
const EXPECTED_API = '/api/v1/elevators/expected';
const PREVIEW_API = '/api/v1/records/today/preview';
const SUBMIT_API = '/api/v1/records/today/submit';

// ── ELE-03-T1 / ELE-09-T1：shared expectedStatusAt 单元权威实现 ──────────────────

/** 台账用例原文口径的扶梯计划：06:00–22:00 运行 */
const ESCALATOR_0600_2200 = { plan_type: 'scheduled' as const, windows: [['06:00', '22:00']] };
/** ELE-09 跨零点：22:00–06:00 运行 */
const CROSS_MIDNIGHT = { plan_type: 'scheduled' as const, windows: [['22:00', '06:00']] };

function expectedOfPlan(
  plan: { plan_type: 'always' | 'scheduled' | 'stopped'; windows: unknown },
  time: string,
) {
  const minutes = clockMinutesOf(time);
  if (minutes === null) throw new Error(`非法时刻 ${time}`);
  return expectedStatusAt(plan, minutes);
}

describe('TK-17 电梯核对：ELE-03-T1 / ELE-09-T1（单元，shared 纯函数）', () => {
  test('ELE-03-T1：扶梯 06:00–22:00，核对 23:00 → 预期停运；白天 → 预期运行', () => {
    expect(expectedOfPlan(ESCALATOR_0600_2200, '23:00')).toBe('stop');
    expect(expectedOfPlan(ESCALATOR_0600_2200, '10:00')).toBe('run');
    // 边界（[start, end) 起含止不含）：22:00 整已停运、06:00 整已运行
    expect(expectedOfPlan(ESCALATOR_0600_2200, '22:00')).toBe('stop');
    expect(expectedOfPlan(ESCALATOR_0600_2200, '06:00')).toBe('run');
  });

  test('ELE-09-T1：跨零点 22:00–06:00 → 23:00 运行 / 07:00 停运（跨零点表达正确）', () => {
    expect(expectedOfPlan(CROSS_MIDNIGHT, '23:00')).toBe('run');
    expect(expectedOfPlan(CROSS_MIDNIGHT, '07:00')).toBe('stop');
    expect(expectedOfPlan(CROSS_MIDNIGHT, '05:59')).toBe('run');
    expect(expectedOfPlan(CROSS_MIDNIGHT, '22:00')).toBe('run');
  });

  test('ELE-02-T1（单元半边）：三选一解析——24 小时恒运行、长期停运恒停运、脏配置回落不炸', () => {
    expect(expectedOfPlan({ plan_type: 'always', windows: null }, '23:00')).toBe('run');
    expect(expectedOfPlan({ plan_type: 'stopped', windows: null }, '10:00')).toBe('stop');
    // 脏配置（windows 缺失/空/非法）→ 回落 run（不放大为满屏「预期停运」；配置修复即生效）
    expect(expectedOfPlan({ plan_type: 'scheduled', windows: null }, '10:00')).toBe('run');
    expect(expectedOfPlan({ plan_type: 'scheduled', windows: [] }, '10:00')).toBe('run');
    expect(expectedOfPlan({ plan_type: 'scheduled', windows: [['6点', '22:00']] }, '10:00')).toBe(
      'run',
    );
    // 零长度窗口（start === end）→ 全天停运（[start,end) 语义的自然结果）
    expect(expectedOfPlan({ plan_type: 'scheduled', windows: [['08:00', '08:00']] }, '10:00')).toBe(
      'stop',
    );
    // 多窗口：任一命中即运行
    expect(
      expectedOfPlan(
        {
          plan_type: 'scheduled',
          windows: [
            ['06:00', '08:00'],
            ['17:00', '20:00'],
          ],
        },
        '18:00',
      ),
    ).toBe('run');
  });

  test('parseWindowsOf：windows JSON 形态合法性（§4.2 [["06:00","22:00"]]）', () => {
    expect(parseWindowsOf([['06:00', '22:00']])).toEqual([[360, 1320]]);
    expect(parseWindowsOf(null)).toBeNull();
    expect(parseWindowsOf('06:00')).toBeNull();
    expect(parseWindowsOf([['06:00']])).toBeNull();
    expect(
      parseWindowsOf([
        ['06:00', '22:00'],
        ['x', 'y'],
      ]),
    ).toBeNull();
  });

  test('normalizeActualOf / isMismatchOf：直选实际状态与预期相同归一为一致；fault 恒不一致', () => {
    expect(normalizeActualOf('run', 'run')).toBe('match');
    expect(normalizeActualOf('stop', 'stop')).toBe('match');
    expect(normalizeActualOf('run', 'stop')).toBe('run');
    expect(normalizeActualOf('stop', 'run')).toBe('stop');
    expect(normalizeActualOf('fault', 'run')).toBe('fault');
    for (const a of ['run', 'stop', 'fault'] as const) expect(isMismatchOf(a)).toBe(true);
    expect(isMismatchOf('match')).toBe(false);
  });

  test('validateElevatorChecks（api 与 h5 离线预检同源）：说明缺失点名 elevator:{id}、越值/重复/时刻非法 400 级点名', () => {
    const resolve = (id: number) =>
      id === 3 ? ('stop' as const) : id === 4 ? ('run' as const) : null;
    // 非数组 → 合成定位项（M2 同族：for..of 迭代器异常 500 的预防）
    expect(validateElevatorChecks('x', resolve).outOfRange).toHaveLength(1);
    // 未上送 = 未核对，合法
    expect(validateElevatorChecks(undefined, resolve).valid).toHaveLength(0);
    // 不一致（expected stop + actual run）未填说明 → explanationMissing，field 以 elevator:{id} 点名
    const miss = validateElevatorChecks(
      [{ elevator_id: 3, check_time: '2026-09-14 21:30:00', expected: 'stop', actual: 'run' }],
      resolve,
    );
    expect(miss.explanationMissing).toHaveLength(1);
    expect(miss.explanationMissing[0]!.field).toBe('elevator:3');
    expect(miss.explanationMissing[0]!.section).toBe(9);
    expect(miss.explanationMissing[0]!.anchor).toBe('#sec-9-elevator-3');
    // 填了说明 → valid，且 expected 为解析器重算值（服务端权威，客户端值不落库）
    const ok = validateElevatorChecks(
      [
        {
          elevator_id: 3,
          check_time: '2026-09-14 21:30:00',
          expected: 'run', // 客户端展示值与重算不符也不影响落库口径
          actual: 'run',
          explanation: '夜间急诊转运临时启用',
        },
      ],
      resolve,
    );
    expect(ok.explanationMissing).toHaveLength(0);
    expect(ok.valid[0]!).toMatchObject({
      expected: 'stop',
      actual: 'run',
      explanation: '夜间急诊转运临时启用',
    });
    // actual 与 expected 相同 → 归一 match、说明清空不落库
    const self = validateElevatorChecks(
      [
        {
          elevator_id: 3,
          check_time: '2026-09-14 21:30:00',
          expected: 'stop',
          actual: 'stop',
          explanation: 'x',
        },
      ],
      resolve,
    );
    expect(self.valid[0]!.actual).toBe('match');
    expect(self.valid[0]!.explanation).toBeNull();
    // 说明超 varchar(300) → 400 级点名（同 confirmations 超长口径）
    const long = validateElevatorChecks(
      [
        {
          elevator_id: 3,
          check_time: '2026-09-14 21:30:00',
          expected: 'stop',
          actual: 'run',
          explanation: '长'.repeat(301),
        },
      ],
      resolve,
    );
    expect(long.outOfRange).toHaveLength(1);
    // 同一电梯重复上送 → 400 级点名（uk_rec_lift 唯一，多行落库失真，L4 同纪律）
    const dup = validateElevatorChecks(
      [
        { elevator_id: 3, check_time: '2026-09-14 21:30:00', expected: 'stop', actual: 'match' },
        { elevator_id: 3, check_time: '2026-09-14 21:30:00', expected: 'stop', actual: 'match' },
      ],
      resolve,
    );
    expect(dup.outOfRange).toHaveLength(1);
    // L1（评审修复轮）：elevator_id 只接受整型 number——'3'/'1e2'/'3.0'/[3] 等形态不得被
    // Number() 宽松转换成**另一台电梯的 id**（串台核对；与 TK-12 收紧 parseNumeric 同纪律）
    for (const badId of ['3', '1e2', '3.0', [3], ' 3 ', true, null, undefined, 0, -1, 2.5]) {
      const r = validateElevatorChecks(
        [
          {
            elevator_id: badId as never,
            check_time: '2026-09-14 21:30:00',
            expected: 'stop',
            actual: 'match',
          },
        ],
        resolve,
      );
      expect(r.outOfRange).toHaveLength(1);
      expect(r.valid).toHaveLength(0);
    }
    // L2（评审修复轮）：多条脏项的 field/锚点必须互不相同——C-09 面板与预览弹窗都以
    // item.field 作 :key，原实现统一兑成 elevator:0 会撞 key（实证 [1,2,3] → 三条同名）
    const dirty = validateElevatorChecks([1, 'x', null], resolve);
    expect(dirty.outOfRange).toHaveLength(3);
    const keys = new Set(dirty.outOfRange.map((m) => m.field));
    expect(keys.size).toBe(3);
    expect(dirty.outOfRange.map((m) => m.anchor)).toEqual([
      '#sec-9-elevator-checks-0',
      '#sec-9-elevator-checks-1',
      '#sec-9-elevator-checks-2',
    ]);
    // check_time 非法（分域正则拦 13 月；日历有效性拦 02-30）→ 400 级点名
    for (const bad of ['2026-13-01 08:00:00', '2026-02-30 08:00:00', '21:30', '']) {
      const r = validateElevatorChecks(
        [{ elevator_id: 3, check_time: bad, expected: 'stop', actual: 'match' }],
        resolve,
      );
      expect(r.outOfRange).toHaveLength(1);
    }
    // 电梯不存在（解析器 null）→ 400 级点名 elevator:{id}
    const unknown = validateElevatorChecks(
      [{ elevator_id: 999, check_time: '2026-09-14 21:30:00', expected: 'run', actual: 'match' }],
      resolve,
    );
    expect(unknown.outOfRange[0]!.field).toBe('elevator:999');
    // actual 越枚举 → 400 级点名
    const badActual = validateElevatorChecks(
      [
        {
          elevator_id: 3,
          check_time: '2026-09-14 21:30:00',
          expected: 'stop',
          actual: 'broken' as never,
        },
      ],
      resolve,
    );
    expect(badActual.outOfRange).toHaveLength(1);
  });
});

// ── 接口层：ELE-02-T1（解析半边）/ ELE-04-T1/T2 / ELE-05-T1 / ELE-06-T1 / ELE-07-T1 ──

/** 全量合法 payload（基准值同 records-submit.spec：高于种子 D-1 不命中防呆） */
function fullSections(): Record<string, unknown> {
  return {
    water_reading: '12300.0',
    e1_reading: '53500.0',
    e2_reading: '43200.0',
    hp_status: 'ok',
    g1_remaining: '300.0',
    g2_remaining: '200.0',
    tank_in_use: 1,
    t1_c830: '5000.00',
    t1_p830: '0.80',
    t2_c830: '4900.00',
    t2_p830: '0.80',
    t1_c2030: '4800.00',
    t1_p2030: '0.80',
    t2_c2030: '4700.00',
    t2_p2030: '0.80',
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

describe('TK-17 电梯核对（接口）：ELE-02/04/05/06/07', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let auditHighWater = 0;
  let masterCookie = '';
  let chiefCookie = '';
  let dutyDate = '';
  /** 种子电梯 id（按名称索引；《开发种子数据》§四：窗口占位 06:00–21:00）。
   * noUncheckedIndexedAccess 下索引访问为 number|undefined——经 elevId 收窄（缺行显式抛错） */
  const eid: Record<string, number> = {};
  function elevId(name: string): number {
    const id = eid[name];
    if (id === undefined) throw new Error(`种子电梯缺行：${name}（请先 db:setup 重灌）`);
    return id;
  }

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

    masterCookie = await login('zhang');
    chiefCookie = await login('chief');
    dutyDate = (await app.get(RecordsService).resolveDutyDate()).dutyDate;

    const elevRows = await db.select().from(elevators);
    for (const e of elevRows) eid[e.name] = e.id;
  });

  afterAll(async () => {
    // 还原：自建记录（先删 alerts/elevator_checks 子行——FK 无级联）、审计、会话（种子 D0 留空口径）
    await cleanRecord();
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  /** 删除当前班次自建记录（含电梯核对与标红子行；提交成功类用例的用例内清理） */
  async function cleanRecord(): Promise<void> {
    const rows = await db
      .select({ id: records.id })
      .from(records)
      .where(eq(records.dutyDate, dutyDate));
    for (const r of rows) {
      await db.delete(alerts).where(eq(alerts.recordId, r.id));
      await db.delete(elevatorChecks).where(eq(elevatorChecks.recordId, r.id));
    }
    await db.delete(records).where(eq(records.dutyDate, dutyDate));
  }

  /** 当前班次记录行 */
  async function recordRow() {
    const rows = await db.select().from(records).where(eq(records.dutyDate, dutyDate)).limit(1);
    return rows[0];
  }

  /** 核对项构造（check_time 时钟分量决定预期：种子窗口 06:00–21:00） */
  function checkOf(name: string, time: string, actual: string, explanation?: string) {
    return {
      elevator_id: elevId(name),
      check_time: `${dutyDate} ${time}`,
      expected: time >= '06:00' && time < '21:00' ? 'run' : 'stop',
      actual,
      ...(explanation !== undefined ? { explanation } : {}),
    };
  }

  function payload(over: {
    set?: Record<string, unknown>;
    del?: readonly string[];
  }): SubmitPayloadDto {
    const sections = fullSections();
    for (const k of over.del ?? []) delete sections[k];
    Object.assign(sections, over.set ?? {});
    return { sections };
  }

  test('ELE-02-T1（接口半边）：GET /elevators/expected 三种计划均正确解析（含跨零点形态的窗口回显）', async () => {
    const res = await request(server).get(EXPECTED_API).set('Cookie', masterCookie).expect(200);
    const body = res.body as ElevatorExpectedDto;
    // check_time 为服务端本地时间戳（核对时刻基准，客户端锁定入草稿）
    expect(body.check_time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const byName = new Map(body.elevators.map((e) => [e.name, e]));
    // 24 小时 → run；长期停运 → stop 且原因回显（确定性断言，不依赖测试运行时刻）
    expect(byName.get('test-24h')?.expected).toBe('run');
    for (const name of ['5号电梯', '8号电梯', '人防电梯', '发热门诊电梯']) {
      expect(byName.get(name)?.expected).toBe('stop');
      expect(byName.get(name)?.stop_reason).toContain('停用检修');
      expect(byName.get(name)?.plan_type).toBe('stopped');
    }
    // 按时段：预期 = shared 纯函数按响应 check_time 的重算值（单元已锁死该函数；端点只做取数与回显）
    const minutes = clockMinutesOf(body.check_time.slice(11, 16));
    for (const name of ['1号电梯', '2号电梯', '扶梯']) {
      const item = byName.get(name)!;
      expect(item.plan_type).toBe('scheduled');
      expect(item.expected).toBe(
        expectedStatusAt({ plan_type: 'scheduled', windows: item.windows }, minutes ?? 0),
      );
      expect(item.windows).toEqual([['06:00', '21:00']]);
    }
    // 科长巡查同口径（契约订正 20：只读接口放宽 chief）
    await request(server).get(EXPECTED_API).set('Cookie', chiefCookie).expect(200);
    // 未登录 401
    await request(server).get(EXPECTED_API).expect(401);
  });

  test('ELE-05-T1：预期按核对时刻锁定、提交时不重算——同班次两行核对（20:30 运行 / 21:30 停运）各自按 check_time 固化，不生成标红', async () => {
    // 两条核对项的 check_time 各落在窗口内/外（expected(run) ≠ expected(stop)）——若实现按
    // 提交时刻重算，两行只能同时等于 expected(提交时刻)，本断言必红（判据「提交时不重算」）
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({
        ...payload({}),
        elevator_checks: [
          checkOf('1号电梯', '20:30:00', 'match'),
          checkOf('扶梯', '21:30:00', 'match'),
        ],
      })
      .expect(201);
    expect((res.body as SubmitResultDto).record_no).toBeDefined();

    const record = await recordRow();
    expect(record).toBeDefined();
    const checks = await db
      .select()
      .from(elevatorChecks)
      .where(eq(elevatorChecks.recordId, record!.id));
    expect(checks).toHaveLength(2);
    const byElevator = new Map(checks.map((c) => [c.elevatorId, c]));
    expect(byElevator.get(elevId('1号电梯'))).toMatchObject({
      expected: 'run',
      actual: 'match',
      explanation: null,
    });
    expect(byElevator.get(elevId('扶梯'))).toMatchObject({ expected: 'stop', actual: 'match' });
    // check_time 原样落库（核对时刻锁定，ELE-05）
    expect(byElevator.get(elevId('扶梯'))?.checkTime).toBe(`${dutyDate} 21:30:00`);
    // 一致不生成标红（ELE-06 的对面）
    const alertRows = await db.select().from(alerts).where(eq(alerts.recordId, record!.id));
    expect(alertRows).toHaveLength(0);
    await cleanRecord();
  });

  test('ELE-04-T1：一致一键确认 → actual=match 免填说明落库', async () => {
    // 预期运行（08:00 在 06:00–21:00 窗口内）+ 一致：无 explanation 字段即合法
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({ ...payload({}), elevator_checks: [checkOf('2号电梯', '08:00:00', 'match')] })
      .expect(201);
    expect((res.body as SubmitResultDto).status).toBe('submitted');
    const record = await recordRow();
    const checks = await db
      .select()
      .from(elevatorChecks)
      .where(eq(elevatorChecks.recordId, record!.id));
    expect(checks[0]).toMatchObject({
      elevatorId: elevId('2号电梯'),
      expected: 'run',
      actual: 'match',
      explanation: null,
    });
    await cleanRecord();
  });

  test('ELE-04-T2：不一致未填说明 → 409 ELEVATOR_EXPLANATION_REQUIRED，逐台以 elevator:{id} 点名（section=9）', async () => {
    // 预期停运（21:30 在窗口外）+ 实际运行（不一致）+ 无说明
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({ ...payload({}), elevator_checks: [checkOf('扶梯', '21:30:00', 'run')] })
      .expect(409);
    const body = res.body as {
      code: string;
      message: string;
      missing_fields: Array<{ field: string; section: number; anchor: string; label: string }>;
    };
    expect(body.code).toBe('ELEVATOR_EXPLANATION_REQUIRED');
    expect(body.missing_fields).toHaveLength(1);
    expect(body.missing_fields[0]!.field).toBe(`elevator:${elevId('扶梯')}`);
    expect(body.missing_fields[0]!.section).toBe(9);
    expect(body.missing_fields[0]!.anchor).toBe(`#sec-9-elevator-${elevId('扶梯')}`);
    expect(body.missing_fields[0]!.label).toContain('扶梯');
    // 未落任何记录（409 前无写入）
    expect(await recordRow()).toBeUndefined();
  });

  test('ELE-06-T1：预期停运实际运行 + 说明 → 提交生成标红项（alerts 行 rule_key=elevator_mismatch level=mid）', async () => {
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({
        ...payload({}),
        elevator_checks: [checkOf('扶梯', '21:30:00', 'run', '夜间急诊转运临时启用')],
      })
      .expect(201);
    const record = await recordRow();
    // 明细行落库（expected=服务端按 check_time 重算的 stop）
    const checks = await db
      .select()
      .from(elevatorChecks)
      .where(eq(elevatorChecks.recordId, record!.id));
    expect(checks[0]).toMatchObject({
      expected: 'stop',
      actual: 'run',
      explanation: '夜间急诊转运临时启用',
    });
    // 标红确认行（Phase 1 标红 + 必填说明；P2 转中预警推送——level 已按 mid 落库）
    const alertRows = await db.select().from(alerts).where(eq(alerts.recordId, record!.id));
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]).toMatchObject({
      ruleKey: 'elevator_mismatch',
      target: `elevator:${elevId('扶梯')}`,
      level: 'mid',
    });
    expect(alertRows[0]!.message).toContain('扶梯');
    expect(alertRows[0]!.message).toContain('预期停运');
    expect(alertRows[0]!.message).toContain('实际运行');
    expect(alertRows[0]!.message).toContain('夜间急诊转运临时启用');
    await cleanRecord();
  });

  test('ELE-07-T1：预期运行实际停运且无说明 → 拦截并点名（同 409 协议）', async () => {
    const res = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({ ...payload({}), elevator_checks: [checkOf('1号电梯', '08:00:00', 'stop')] })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('ELEVATOR_EXPLANATION_REQUIRED');
    expect(
      (res.body as { missing_fields: Array<{ field: string }> }).missing_fields[0]!.field,
    ).toBe(`elevator:${elevId('1号电梯')}`);
  });

  test('故障（fault）同属不一致：无说明 409、有说明落库并标红（D-T22 ③ 任一不一致均标红）', async () => {
    // 无说明 → 拦截
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({ ...payload({}), elevator_checks: [checkOf('2号电梯', '08:00:00', 'fault')] })
      .expect(409);
    // 有说明 → 落库 + 标红
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({
        ...payload({}),
        elevator_checks: [checkOf('2号电梯', '08:00:00', 'fault', '轿厢门故障停用')],
      })
      .expect(201);
    const record = await recordRow();
    const checks = await db
      .select()
      .from(elevatorChecks)
      .where(eq(elevatorChecks.recordId, record!.id));
    expect(checks[0]).toMatchObject({ actual: 'fault' });
    const alertRows = await db.select().from(alerts).where(eq(alerts.recordId, record!.id));
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]!.message).toContain('实际故障');
    await cleanRecord();
  });

  test('payload 校验回归：重复上送 / 电梯不存在 / 非数组 / 非法时刻 / 说明超长 → 400 逐条点名', async () => {
    // 重复
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({
        ...payload({}),
        elevator_checks: [
          checkOf('扶梯', '21:30:00', 'match'),
          checkOf('扶梯', '21:30:00', 'match'),
        ],
      })
      .expect(400);
    // 不存在
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({
        ...payload({}),
        elevator_checks: [{ ...checkOf('扶梯', '21:30:00', 'match'), elevator_id: 99999 }],
      })
      .expect(400);
    // 非数组（M2 同族：防迭代器 500）
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({ ...payload({}), elevator_checks: { elevator_id: 1 } })
      .expect(400);
    // 非法时刻（13 月，shared isValidLocalTimestamp 分域拦截）
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({
        ...payload({}),
        elevator_checks: [
          {
            ...checkOf('扶梯', '21:30:00', 'match'),
            check_time: `${dutyDate.slice(0, 5)}13-01 21:30:00`,
          },
        ],
      })
      .expect(400);
    // 说明超 varchar(300)
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({
        ...payload({}),
        elevator_checks: [checkOf('扶梯', '21:30:00', 'run', '长'.repeat(301))],
      })
      .expect(400);
  });

  test('preview 与 submit 同口径（M3/L4 纪律）：不一致未填说明在预览即点名', async () => {
    const res = await request(server)
      .post(PREVIEW_API)
      .set('Cookie', masterCookie)
      .send({ ...payload({}), elevator_checks: [checkOf('扶梯', '21:30:00', 'run')] })
      .expect(201);
    const items = (res.body as { missing_fields: Array<{ field: string }> }).missing_fields;
    expect(items.map((m) => m.field)).toContain(`elevator:${elevId('扶梯')}`);
  });

  test('未上送 elevator_checks = 本班次未核对，合法且不落明细、不标红（核对不强制，追责载体为逐条知晓）', async () => {
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send(payload({}))
      .expect(201);
    const record = await recordRow();
    const checks = await db
      .select()
      .from(elevatorChecks)
      .where(eq(elevatorChecks.recordId, record!.id));
    expect(checks).toHaveLength(0);
    // 首页电梯卡角标维持 0/0（D-T16 分母为字段维度，逐台核对不计入——客户端以草稿判定已填）
    const today = await request(server)
      .get('/api/v1/records/today')
      .set('Cookie', masterCookie)
      .expect(200);
    const elevCard = (
      today.body as { cards: Array<{ kind: string; badge: { total: number } }> }
    ).cards.find((c) => c.kind === 'elevator');
    expect(elevCard?.badge.total).toBe(0);
    await cleanRecord();
  });

  test('L4（评审修复轮）：注入固定核对时刻的黄金值断言——避开「与 shared 函数互推」的同源盲区', async () => {
    // 接口层原用例的 scheduled 断言是用 expectedStatusAt 复算响应值（同一函数自证，宽窄一起红），
    // 本例绕开它：直接给服务注入时刻，按《开发种子数据》电梯窗口（06:00–21:00）硬编算黄金值
    const elevatorsService = app.get(ElevatorsService);
    const at = (hhmm: string) => new Date(`${dutyDate}T${hhmm}:00`);
    const byName = async (hhmm: string) => {
      const dto = await elevatorsService.expected(at(hhmm));
      expect(dto.check_time).toBe(`${dutyDate} ${hhmm}:00`);
      return new Map(dto.elevators.map((e) => [e.name, e]));
    };
    // 21:30（窗口外）→ 定时段电梯预期停运；10:00（窗口内）→ 运行
    expect((await byName('21:30')).get('扶梯')?.expected).toBe('stop');
    expect((await byName('10:00')).get('扶梯')?.expected).toBe('run');
    // 边界：21:00 整即停运（[start,end) 起含止不含，台账 ELE-02/03 口径）；06:00 整已运行
    expect((await byName('21:00')).get('扶梯')?.expected).toBe('stop');
    expect((await byName('06:00')).get('扶梯')?.expected).toBe('run');
    // 不随时刻变化的两分支（ELE-02）：24 小时恒运行、长期停运恒停运
    const late = await byName('23:00');
    expect(late.get('test-24h')?.expected).toBe('run');
    expect(late.get('5号电梯')?.expected).toBe('stop');
  });

  test('L3（评审修复轮）：重提（draft 接管）同事务重建标红行——旧 elevator_checks 与旧 alerts 不累积', async () => {
    const zhang = await db.select().from(users).where(eq(users.username, 'zhang')).limit(1);
    const submitterId = zhang[0]!.id;
    // 造一个撤回后的 draft 行，并预置「上一次提交」留下的核对明细与标红行
    const inserted = await db.insert(records).values({
      recordNo: recordNoOf(dutyDate),
      dutyDate,
      submitterId,
      status: 'draft',
    });
    const draftId = inserted[0].insertId;
    await db.insert(elevatorChecks).values({
      recordId: draftId,
      elevatorId: elevId('8号电梯'),
      checkTime: `${dutyDate} 09:00:00`,
      expected: 'stop',
      actual: 'match',
    });
    await db.insert(alerts).values({
      recordId: draftId,
      ruleKey: 'elevator_mismatch',
      target: `elevator:${elevId('8号电梯')}`,
      level: 'mid',
      message: '过期标红行（上一次提交残留）',
    });

    // 重提：本次只核对扶梯一台不一致
    await request(server)
      .post(SUBMIT_API)
      .set('Cookie', masterCookie)
      .send({ ...payload({}), elevator_checks: [checkOf('扶梯', '21:30:00', 'run', '夜间转运')] })
      .expect(201);

    const checks = await db
      .select()
      .from(elevatorChecks)
      .where(eq(elevatorChecks.recordId, draftId));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.elevatorId).toBe(elevId('扶梯'));
    const alertRows = await db.select().from(alerts).where(eq(alerts.recordId, draftId));
    // 只余本次的一条（原实现只清明细不清标红 → 此处会是 2 条）
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]!.target).toBe(`elevator:${elevId('扶梯')}`);
    await cleanRecord();
  });
});
