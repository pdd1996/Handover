/**
 * TK-18 待确认入口与逐项浏览测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - F2-02-T1（接口半边）：接班人登录 → GET /records/pending 仅返回「我为 receiver 且
 *   status=submitted」的交接单，含逐单标红行数（E2E 半边见 tests/e2e/tests/pending-confirm.spec.ts）
 * - F2-03-T1：GET /records/{id} 逐项浏览数据齐备——标红项来自 alerts（状态异常/电梯不一致/
 *   交接事项拆条）且按**置顶序**返回（level high→mid→low，shared ALERT_LEVEL_RANK）
 * - 契约 §4 第 4 步回归：提交事务生成状态异常与交接事项拆条标红行（TK-18 补全；
 *   电梯不一致半边已在 records-elevator.spec.ts ELE-06-T1 钉死）
 * - shared handoverItemsOf 拆条纯函数（技术方案 §5.3「以换行或编号分条」的单元半边）
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * 必须串行跑（--runInBand）。种子 D-1 为待确认单（《开发种子数据》§六：status=submitted、
 * 接收人=王师傅=dutyOf(0)、hp_status=bad、交接事项两条、扶梯核对不一致），配套标红行
 * 恰 4 条——本文件以其为黄金值锚点。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, gt } from 'drizzle-orm';
import request from 'supertest';
import {
  ALERT_LEVEL_RANK,
  handoverItemsOf,
  type PendingListDto,
  type RecordDetailDto,
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
import { RecordsService } from './records.service';
import { minusOneDay } from './duty-date';

const PASSWORD = 'Handover@2026';
const PENDING_API = '/api/v1/records/pending';
const DETAIL_API = (id: number) => `/api/v1/records/${id}`;
const SUBMIT_API = '/api/v1/records/today/submit';

// ── shared handoverItemsOf：交接事项拆条（§5.3 单元半边；种子 D-1 即黄金样例）──────────

describe('TK-18 交接事项拆条（单元，shared handoverItemsOf）', () => {
  test('种子 D-1 黄金样例：编号+换行两条 → 两条无编号正文，顺序不变', () => {
    // 《开发种子数据》§六 D-1 handover_note 原文
    const seedNote =
      '1. 扶梯异常已联系维保处理，明早复核；\n2. 表房 2 号阀门有轻微渗水，需跟进检查。';
    expect(handoverItemsOf(seedNote)).toEqual([
      '扶梯异常已联系维保处理，明早复核；',
      '表房 2 号阀门有轻微渗水，需跟进检查。',
    ]);
  });

  test('编号形态：中文编号/全角括号编号均剥离；无换行整段一条；空行与纯编号行剔除', () => {
    expect(handoverItemsOf('一、事项甲。\n（2）事项乙。\n(3)事项丙。')).toEqual([
      '事项甲。',
      '事项乙。',
      '事项丙。',
    ]);
    expect(handoverItemsOf('单行无编号事项')).toEqual(['单行无编号事项']);
    expect(handoverItemsOf('1.\n2. 事项乙')).toEqual(['事项乙']);
    expect(handoverItemsOf('  \n\n  ')).toEqual([]);
    expect(handoverItemsOf(null)).toEqual([]);
    expect(handoverItemsOf(undefined)).toEqual([]);
    expect(handoverItemsOf(42)).toEqual([]);
  });
});

// ── 接口层：F2-02-T1（接口半边）/ F2-03-T1 / 404 / 契约 §4 第 4 步回归 ────────────────

describe('TK-18 待确认入口与逐项浏览（接口）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let auditHighWater = 0;
  let receiverCookie = ''; // D-1 待确认单的接班人（从库反查，不硬编码轮值序——防同源盲区）
  let receiverName = '';
  let shiCookie = ''; // 非接班人（无待确认单）
  let chiefCookie = '';
  let zhangCookie = ''; // 提交链路回归用
  let dutyDate = '';
  let d1Date = '';
  let d1Id = 0;
  let d1RecordNo = '';

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

    shiCookie = await login('shi');
    chiefCookie = await login('chief');
    zhangCookie = await login('zhang');
    dutyDate = (await app.get(RecordsService).resolveDutyDate()).dutyDate;
    d1Date = minusOneDay(dutyDate);

    // 种子 D-1 待确认单（《开发种子数据》§六；receiver 已在上方从库反查）
    const d1Rows = await db
      .select({ id: records.id, recordNo: records.recordNo })
      .from(records)
      .where(eq(records.dutyDate, d1Date))
      .limit(1);
    if (!d1Rows[0]) throw new Error('种子 D-1 待确认单缺失（请先 db:setup 重灌）');
    d1Id = d1Rows[0].id;
    d1RecordNo = d1Rows[0].recordNo;

    // D-1 待确认单的接班人从库反查（种子 D-1 记录 receiver=dutyOf(0)；轮值相位变更时
    // 本用例仍成立，TK-26 种子相位锚定说明见 seed.ts 注）
    const receiverUserId = (
      await db
        .select({ receiverId: records.receiverId })
        .from(records)
        .where(eq(records.id, d1Id))
        .limit(1)
    )[0]!.receiverId as number;
    const receiverUser = (
      await db
        .select({ username: users.username, realName: users.realName })
        .from(users)
        .where(eq(users.id, receiverUserId))
        .limit(1)
    )[0]!;
    receiverName = receiverUser.realName;
    receiverCookie = await login(receiverUser.username);
  });

  afterAll(async () => {
    // 还原：自建记录与审计（种子 D-1 不动）
    await cleanRecord();
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  /** 删除当前班次自建记录（含 alerts/elevator_checks 子行——FK 无级联；提交回归用例清理） */
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

  test('F2-02-T1（接口半边）：D-1 接班人登录 → 待确认列表恰含种子 D-1 一条，标红数与实际一致', async () => {
    const res = await request(server).get(PENDING_API).set('Cookie', receiverCookie).expect(200);
    const body = res.body as PendingListDto;
    // 黄金值：种子中 receiver=王师傅 且 status=submitted 的记录恰一条（D-1）
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.id).toBe(d1Id);
    expect(item.duty_date).toBe(d1Date);
    // record_no 黄金值：HB-YYYYMMDD-001（duty_date 唯一 → 每班次恒 -001，技术方案 §4.2）
    expect(item.record_no).toBe(`HB-${d1Date.replaceAll('-', '')}-001`);
    expect(item.record_no).toBe(d1RecordNo);
    expect(item.status).toBe('submitted');
    expect(item.submitter.real_name).toBeTruthy(); // 种子 D-1 交班人（轮值相位无关断言，姓名与 users 同源）
    // 黄金值：种子配套三为 D-1 铺设恰 4 条标红行（1 状态异常 + 1 电梯不一致 + 2 交接事项拆条）
    expect(item.alert_count).toBe(4);
  });

  test('取数口径：非接班人/无待确认 → 空列表；chief → 403（契约角色列 master）；未登录 → 401', async () => {
    const shiRes = await request(server).get(PENDING_API).set('Cookie', shiCookie).expect(200);
    expect((shiRes.body as PendingListDto).items).toHaveLength(0);

    const chiefRes = await request(server).get(PENDING_API).set('Cookie', chiefCookie).expect(403);
    expect((chiefRes.body as { code: string }).code).toBe('FORBIDDEN');

    await request(server).get(PENDING_API).expect(401);
  });

  test('F2-03-T1：详情齐备——标红项来自三类 alerts 且按置顶序返回，读数/电梯核对可逐项浏览', async () => {
    const res = await request(server)
      .get(DETAIL_API(d1Id))
      .set('Cookie', receiverCookie)
      .expect(200);
    const body = res.body as RecordDetailDto;

    // 记录级字段（F2-03 浏览的"是谁交给我"语境）
    expect(body.record_no).toBe(d1RecordNo);
    expect(body.duty_date).toBe(d1Date);
    expect(body.status).toBe('submitted');
    expect(body.version).toBe(1);
    expect(body.submitter.real_name).toBeTruthy();
    expect(body.receiver?.real_name).toBe(receiverName);
    // 待确认单未归档（F2-05 确认信息随 TK-19）
    expect(body.confirmed_at).toBeNull();
    expect(body.signature_path).toBeNull();

    // 标红项三类来源齐全（F2-03-T1 判据：标红项来自 alerts——状态异常/电梯不一致/交接事项）
    expect(body.alerts).toHaveLength(4);
    const ruleKeys = body.alerts.map((a) => a.rule_key).sort();
    expect(ruleKeys).toEqual([
      'elevator_mismatch',
      'handover_note',
      'handover_note',
      'hp_status_bad',
    ]);

    // 置顶序（F2-03 置顶高亮）：level 权重单调不降，首位恰为高等级状态异常
    expect(body.alerts[0]!.rule_key).toBe('hp_status_bad');
    expect(body.alerts[0]!.level).toBe('high');
    for (let i = 1; i < body.alerts.length; i++) {
      const prev = body.alerts[i - 1]!;
      const cur = body.alerts[i]!;
      expect(ALERT_LEVEL_RANK[cur.level]).toBeGreaterThanOrEqual(ALERT_LEVEL_RANK[prev.level]);
    }
    const mismatch = body.alerts.find((a) => a.rule_key === 'elevator_mismatch')!;
    expect(mismatch.level).toBe('mid');
    expect(mismatch.message).toContain('扶梯');
    const handover = body.alerts.filter((a) => a.rule_key === 'handover_note');
    expect(handover).toHaveLength(2);
    expect(handover[0]!.message).toContain('扶梯异常已联系维保处理');
    expect(handover[1]!.message).toContain('表房 2 号阀门');

    // 全部读数可逐项浏览（含标红源字段与交接事项原文）
    expect(body.readings.hp_status).toBe('bad');
    expect(String(body.readings.handover_note)).toContain('扶梯异常已联系维保处理');
    expect(body.readings.water_reading).not.toBeNull();

    // 电梯核对逐台明细（联字典回显电梯名；扶梯不一致行带说明）
    const escalator = body.elevator_checks.find((c) => c.elevator_name === '扶梯');
    expect(escalator).toBeDefined();
    expect(escalator!.expected).toBe('stop');
    expect(escalator!.actual).toBe('run');
    expect(escalator!.explanation).toBeTruthy();
  });

  test('404：不存在的 id / 非数字 id → NOT_FOUND 统一错误结构（不走框架默认 400）', async () => {
    const missing = await request(server)
      .get(DETAIL_API(99999999))
      .set('Cookie', receiverCookie)
      .expect(404);
    expect((missing.body as { code: string }).code).toBe('NOT_FOUND');

    const notNumber = await request(server)
      .get(DETAIL_API(NaN))
      .set('Cookie', receiverCookie)
      .expect(404);
    expect((notNumber.body as { code: string }).code).toBe('NOT_FOUND');
  });

  test('契约 §4 第 4 步回归：提交生成状态异常与交接事项拆条标红行（与电梯不一致同事务）', async () => {
    // 提交人 zhang；payload 基准值高于种子 D-1 不命中防呆（同 records-elevator.spec）
    const payload = (over: { set?: Record<string, unknown> }): SubmitPayloadDto => {
      const sections: Record<string, unknown> = {
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
      };
      Object.assign(sections, over.set ?? {});
      return { sections };
    };
    const elevId = async (name: string): Promise<number> => {
      const rows = await db
        .select({ id: elevators.id })
        .from(elevators)
        .where(eq(elevators.name, name))
        .limit(1);
      if (!rows[0]) throw new Error(`种子电梯缺行：${name}`);
      return rows[0].id;
    };

    // 三类标红源同时携带：高配房异常 + 交接事项两条 + 扶梯不一致（有说明）
    const submitRes = await request(server)
      .post(SUBMIT_API)
      .set('Cookie', zhangCookie)
      .send({
        ...payload({
          set: {
            hp_status: 'bad',
            hp_note: '高压配电室温度偏高',
            handover_note: '1. 事项甲需要跟进；\n2. 事项乙明日复核。',
          },
        }),
        elevator_checks: [
          {
            elevator_id: await elevId('扶梯'),
            check_time: `${dutyDate} 21:30:00`,
            expected: 'stop',
            actual: 'run',
            explanation: '夜间转运临时启用',
          },
        ],
      })
      .expect(201);
    const saved = submitRes.body as SubmitResultDto;

    // 待确认列表随之出现一条（F2-02 提交即产生接班人待办；receiver=次日排班人，从库反查后以其登录）
    const receiverRows = await db
      .select({ receiverId: records.receiverId })
      .from(records)
      .where(and(eq(records.id, saved.id), eq(records.status, 'submitted')))
      .limit(1);
    expect(receiverRows[0]?.receiverId).not.toBeNull();

    const detailRes = await request(server)
      .get(DETAIL_API(saved.id))
      .set('Cookie', zhangCookie)
      .expect(200);
    const detail = detailRes.body as RecordDetailDto;
    // 状态异常标红行：rule_key=`{field}_bad`、level=high、文案含字段名与异常备注
    const hpAlert = detail.alerts.find((a) => a.rule_key === 'hp_status_bad');
    expect(hpAlert).toBeDefined();
    expect(hpAlert!.level).toBe('high');
    expect(hpAlert!.message).toContain('高配房是否正常');
    expect(hpAlert!.message).toContain('高压配电室温度偏高');
    // 交接事项拆条：两条、正文剥离行首编号
    const handoverAlerts = detail.alerts.filter((a) => a.rule_key === 'handover_note');
    expect(handoverAlerts).toHaveLength(2);
    expect(handoverAlerts[0]!.message).toContain('事项甲需要跟进');
    expect(handoverAlerts[1]!.message).toContain('事项乙明日复核');
    // 电梯不一致标红行（TK-17 半边，同事务共存）
    expect(detail.alerts.some((a) => a.rule_key === 'elevator_mismatch')).toBe(true);
    // alert_count 口径与详情 alerts 数一致（F2-02 列表角标与详情同源）
    const listRes = await request(server)
      .get(PENDING_API)
      .set(
        'Cookie',
        await login(
          (
            await db
              .select({ username: users.username })
              .from(users)
              .where(eq(users.id, receiverRows[0]!.receiverId as number))
              .limit(1)
          )[0]!.username,
        ),
      )
      .expect(200);
    const listItem = (listRes.body as PendingListDto).items.find((i) => i.id === saved.id);
    expect(listItem?.alert_count).toBe(detail.alerts.length);

    await cleanRecord();
  });
});
