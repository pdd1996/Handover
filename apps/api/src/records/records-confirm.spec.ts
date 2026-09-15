/**
 * TK-19 逐条知晓与签名归档测试 —— 挂钩台账用例（AGENTS.md「需求即测试」）：
 * - DEP-08-T1 / DATA-08-T1：提交含状态异常+电梯不一致+交接事项 → 三类确认行齐全
 *   （交接事项 2 行拆 2 条确认行），确认机制共用同一 acknowledge 端点；
 * - F2-04-T1：存在未知晓确认行 → 直接签名 → 409 CONFIRM_INCOMPLETE（服务端权威校验，
 *   与转 completed 同事务防并发中间态入档）；
 * - F2-04-T2：全部逐条点击"已知晓" → acknowledged_by/at 逐条落库（幂等：重复知晓
 *   不覆盖首次时刻）；
 * - F2-05-T1：签名归档 → status=completed、confirmed_at/signature_path 落库、
 *   签名图落盘、审计 record.confirm；双方姓名/确认时间/签名图经 GET /records/{id} 可查，
 *   且 completed 单不再产生待确认入口（F2-02 取数口径闭环）。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * 必须串行跑（--runInBand）。测试用自建记录（zhang 提交当班次，receiver=次日排班人），
 * **不触碰种子 D-1**（records-pending.spec 的黄金锚点）；UPLOAD_DIR 注入临时目录，
 * 签名图不落仓库。afterAll 还原自建记录与审计。
 */
import { promises as fsp } from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, gt } from 'drizzle-orm';
import request from 'supertest';
import type {
  AcknowledgeResultDto,
  ConfirmResultDto,
  PendingListDto,
  RecordDetailDto,
  SubmitPayloadDto,
  SubmitResultDto,
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

const PASSWORD = 'Handover@2026';
const ACK_API = (id: number) => `/api/v1/records/${id}/acknowledge`;
const CONFIRM_API = (id: number) => `/api/v1/records/${id}/confirm`;
const DETAIL_API = (id: number) => `/api/v1/records/${id}`;
const PENDING_API = '/api/v1/records/pending';
const SUBMIT_API = '/api/v1/records/today/submit';

/** 1×1 合法 PNG（魔数与 CRC 齐全）的 data URL——签名图校验的合法样本 */
const VALID_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('TK-19 逐条知晓与签名归档（接口）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let uploadDir = '';
  let auditHighWater = 0;
  let zhangCookie = ''; // 提交人（非接班人 → 403 反例）
  let receiverCookie = ''; // 次日排班接班人（正向链路主角）
  let receiverId = 0;
  let chiefCookie = '';
  let dutyDate = '';
  let recordId = 0;
  let recordNo = '';
  let alertIds: number[] = [];

  async function login(username: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username, password: PASSWORD })
      .expect(200);
    return String(res.headers['set-cookie']?.[0] ?? '');
  }

  beforeAll(async () => {
    // 签名图落盘目录注入临时目录（writeSignatureFile 读 UPLOAD_DIR，不落仓库）
    uploadDir = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'handover-sig-'));
    process.env.UPLOAD_DIR = uploadDir;

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

    // 提交一份含三类标红源的单：高配房异常 + 交接事项两行 + 扶梯不一致（有说明）
    // 基准值高于种子 D-1，不命中防呆（同 records-pending.spec 的提交回归用例）
    const elevRows = await db
      .select({ id: elevators.id })
      .from(elevators)
      .where(eq(elevators.name, '扶梯'))
      .limit(1);
    const escalatorId = elevRows[0]?.id;
    if (!escalatorId) throw new Error('种子电梯缺行：扶梯');
    const payload: SubmitPayloadDto = {
      sections: {
        water_reading: '12300.0',
        e1_reading: '53500.0',
        e2_reading: '43200.0',
        hp_status: 'bad',
        hp_note: '高压配电室温度偏高',
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
        handover_note: '1. 事项甲需要跟进；\n2. 事项乙明日复核。',
      },
      elevator_checks: [
        {
          elevator_id: escalatorId,
          check_time: `${dutyDate} 21:30:00`,
          expected: 'stop',
          actual: 'run',
          explanation: '夜间转运临时启用',
        },
      ],
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
      .select({ username: users.username, id: users.id })
      .from(users)
      .where(eq(users.id, receiverId))
      .limit(1);
    expect(recvUser[0]).toBeDefined();
    receiverCookie = await login(recvUser[0]!.username);

    // 确认行 id 清单（置顶序返回，逐条知晓按 id 上送）
    const detail = await request(server)
      .get(DETAIL_API(recordId))
      .set('Cookie', receiverCookie)
      .expect(200);
    alertIds = (detail.body as RecordDetailDto).alerts.map((a) => a.id);
  });

  afterAll(async () => {
    // 还原：自建记录（含 alerts/elevator_checks 子行——FK 无级联）与审计
    if (recordId) {
      await db.delete(alerts).where(eq(alerts.recordId, recordId));
      await db.delete(elevatorChecks).where(eq(elevatorChecks.recordId, recordId));
      await db.delete(records).where(eq(records.id, recordId));
    }
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  test('DEP-08-T1 / DATA-08-T1：三类确认行齐全，交接事项 2 行拆 2 条确认行', async () => {
    expect(alertIds).toHaveLength(4); // 1 状态异常 + 1 电梯不一致 + 2 交接事项
    const detail = await request(server)
      .get(DETAIL_API(recordId))
      .set('Cookie', receiverCookie)
      .expect(200);
    const body = detail.body as RecordDetailDto;
    const ruleKeys = body.alerts.map((a) => a.rule_key).sort();
    expect(ruleKeys).toEqual([
      'elevator_mismatch',
      'handover_note',
      'handover_note',
      'hp_status_bad',
    ]);
    // 三类来源齐全（DEP-08-T1 判据）；交接事项逐条拆分（DATA-08-T1 判据）
    const handover = body.alerts.filter((a) => a.rule_key === 'handover_note');
    expect(handover[0]!.message).toContain('事项甲需要跟进');
    expect(handover[1]!.message).toContain('事项乙明日复核');
    // 初始均未知晓（acknowledged_* 字段先行、TK-19 起写入）
    for (const a of body.alerts) {
      expect(a.acknowledged_by).toBeNull();
      expect(a.acknowledged_at).toBeNull();
    }
  });

  test('F2-04-T1：存在未知晓确认行 → 直接签名被拒（409 CONFIRM_INCOMPLETE）', async () => {
    const res = await request(server)
      .post(CONFIRM_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ signature: VALID_PNG_DATA_URL })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('CONFIRM_INCOMPLETE');

    // 部分知晓仍被拒：先知晓 1 条，剩余 3 条未知晓
    const ackRes = await request(server)
      .post(ACK_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ alert_ids: [alertIds[0]] })
      .expect(201);
    expect((ackRes.body as AcknowledgeResultDto).acknowledged).toBe(1);

    const res2 = await request(server)
      .post(CONFIRM_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ signature: VALID_PNG_DATA_URL })
      .expect(409);
    expect((res2.body as { code: string }).code).toBe('CONFIRM_INCOMPLETE');
  });

  test('权限与路由边界：chief/非接班人 403、404、请求体形态 400、跨单 id 忽略', async () => {
    // chief：角色不足（契约 §3.4 角色列 master）
    const chiefAck = await request(server)
      .post(ACK_API(recordId))
      .set('Cookie', chiefCookie)
      .send({ alert_ids: [alertIds[1]!] })
      .expect(403);
    expect((chiefAck.body as { code: string }).code).toBe('FORBIDDEN');
    const chiefConfirm = await request(server)
      .post(CONFIRM_API(recordId))
      .set('Cookie', chiefCookie)
      .send({ signature: VALID_PNG_DATA_URL })
      .expect(403);
    expect((chiefConfirm.body as { code: string }).code).toBe('FORBIDDEN');

    // 非接班人的师傅（提交人不是确认人，D-P06 责任锚点/C-05 实名）
    const other = await request(server)
      .post(ACK_API(recordId))
      .set('Cookie', zhangCookie)
      .send({ alert_ids: [alertIds[1]!] })
      .expect(403);
    expect((other.body as { code: string }).code).toBe('FORBIDDEN');

    // 未登录 → 401
    await request(server)
      .post(ACK_API(recordId))
      .send({ alert_ids: [alertIds[1]!] })
      .expect(401);

    // 404：不存在的单（含非数字 id，不走框架默认 400）
    const missing = await request(server)
      .post(ACK_API(99999999))
      .set('Cookie', receiverCookie)
      .send({ alert_ids: [1] })
      .expect(404);
    expect((missing.body as { code: string }).code).toBe('NOT_FOUND');
    const notNumber = await request(server)
      .post(ACK_API(Number.NaN))
      .set('Cookie', receiverCookie)
      .send({ alert_ids: [1] })
      .expect(404);
    expect((notNumber.body as { code: string }).code).toBe('NOT_FOUND');

    // 请求体形态：alert_ids 非数组 → 400 合成定位项点名（confirmations 先例同门）
    const badBody = await request(server)
      .post(ACK_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ alert_ids: 'nope' })
      .expect(400);
    expect((badBody.body as { code: string }).code).toBe('VALIDATION_OUT_OF_RANGE');

    // 跨单/未知 id 容错忽略：不命中即 0 行（不写别的单的确认行）
    const stray = await request(server)
      .post(ACK_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ alert_ids: [987654321] })
      .expect(201);
    expect((stray.body as AcknowledgeResultDto).acknowledged).toBe(0);
  });

  test('F2-04-T2：剩余确认行逐条知晓 → acknowledged_by/at 逐条落库；重复知晓不覆盖首次时刻', async () => {
    // 逐条（一次一条，非批量）知晓剩余行；已知晓的首条重复上送 → 0（幂等）
    for (const id of alertIds.slice(1)) {
      const res = await request(server)
        .post(ACK_API(recordId))
        .set('Cookie', receiverCookie)
        .send({ alert_ids: [id] })
        .expect(201);
      expect((res.body as AcknowledgeResultDto).acknowledged).toBe(1);
    }

    const rows = await db
      .select({ id: alerts.id, by: alerts.acknowledgedBy, at: alerts.acknowledgedAt })
      .from(alerts)
      .where(eq(alerts.recordId, recordId));
    expect(rows).toHaveLength(4);
    const firstAckAt = new Map(rows.map((r) => [r.id, r.at]));
    for (const r of rows) {
      expect(r.by).toBe(receiverId);
      expect(r.at).not.toBeNull();
    }

    // 全量重复上送 → 全部已被知晓拦在 isNull 条件外（0 行），首次知晓时刻不覆盖
    const repeat = await request(server)
      .post(ACK_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ alert_ids: alertIds })
      .expect(201);
    expect((repeat.body as AcknowledgeResultDto).acknowledged).toBe(0);

    const after = await db
      .select({ id: alerts.id, by: alerts.acknowledgedBy, at: alerts.acknowledgedAt })
      .from(alerts)
      .where(eq(alerts.recordId, recordId));
    for (const r of after) {
      expect(r.by).toBe(receiverId);
      expect(r.at).toBe(firstAckAt.get(r.id));
    }
  });

  test('F2-05-T1：签名归档 → completed、confirmed_at/signature_path 落库、签名图落盘、审计留痕、双方信息可查', async () => {
    // 签名图校验：缺失 → 400 点名；非法 PNG → 400 越界
    const noSig = await request(server)
      .post(CONFIRM_API(recordId))
      .set('Cookie', receiverCookie)
      .send({})
      .expect(400);
    expect((noSig.body as { code: string }).code).toBe('VALIDATION_MISSING_FIELDS');
    const badSig = await request(server)
      .post(CONFIRM_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ signature: 'data:image/png;base64,AAAA' })
      .expect(400);
    expect((badSig.body as { code: string }).code).toBe('VALIDATION_OUT_OF_RANGE');

    const res = await request(server)
      .post(CONFIRM_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ signature: VALID_PNG_DATA_URL })
      .expect(201);
    const body = res.body as ConfirmResultDto;
    expect(body.id).toBe(recordId);
    expect(body.record_no).toBe(recordNo);
    expect(body.status).toBe('completed');
    expect(body.confirmed_at).not.toBeNull();
    expect(body.signature_path).toBe(`/uploads/signatures/${recordNo}.png`);
    expect(body.receiver?.id).toBe(receiverId);

    // 签名图已落盘（UPLOAD_DIR 临时目录内）
    const file = await fsp.readFile(nodePath.join(uploadDir, 'signatures', `${recordNo}.png`));
    expect(file.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 库内落库口径
    const row = (
      await db
        .select({
          status: records.status,
          confirmedAt: records.confirmedAt,
          signaturePath: records.signaturePath,
        })
        .from(records)
        .where(eq(records.id, recordId))
        .limit(1)
    )[0]!;
    expect(row.status).toBe('completed');
    expect(row.confirmedAt).toBe(body.confirmed_at);
    expect(row.signaturePath).toBe(body.signature_path);

    // 审计 record.confirm（契约 §5）
    const audit = await db
      .select({ action: auditLogs.action, actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, recordNo));
    const confirmAudits = audit.filter((a) => a.action === 'record.confirm');
    expect(confirmAudits).toHaveLength(1);
    expect(confirmAudits[0]!.actorId).toBe(receiverId);

    // 双方姓名、确认时间、签名图可查（GET /records/{id}，F2-05-T1 判据）
    const detail = await request(server)
      .get(DETAIL_API(recordId))
      .set('Cookie', receiverCookie)
      .expect(200);
    const detailBody = detail.body as RecordDetailDto;
    expect(detailBody.status).toBe('completed');
    expect(detailBody.submitter.real_name).toBeTruthy();
    expect(detailBody.receiver?.real_name).toBeTruthy();
    expect(detailBody.confirmed_at).toBe(body.confirmed_at);
    expect(detailBody.signature_path).toBe(body.signature_path);

    // 归档后不再产生待确认入口（F2-02 取数口径：completed 不在列）
    const pending = await request(server)
      .get(PENDING_API)
      .set('Cookie', receiverCookie)
      .expect(200);
    const items = (pending.body as PendingListDto).items;
    expect(items.some((i) => i.id === recordId)).toBe(false);
  });

  test('归档后闸门：acknowledge/confirm 均拒绝（409 CONFIRM_INCOMPLETE）', async () => {
    const ack = await request(server)
      .post(ACK_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ alert_ids: alertIds })
      .expect(409);
    expect((ack.body as { code: string }).code).toBe('CONFIRM_INCOMPLETE');
    const confirm = await request(server)
      .post(CONFIRM_API(recordId))
      .set('Cookie', receiverCookie)
      .send({ signature: VALID_PNG_DATA_URL })
      .expect(409);
    expect((confirm.body as { code: string }).code).toBe('CONFIRM_INCOMPLETE');
  });
});
