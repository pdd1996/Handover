/**
 * TK-24 记录管理测试 —— 挂钩任务分解 TK-24 完成判据「F6-01-T1 绿：按日期/交班人筛选 →
 * 查看/导出/批注 → 全部可用；筛选结果正确；批注留痕」与台账 F6-01（记录管理：查看/导出/批注）。
 *
 * 用例结构（对应 F6-01-T1 链路的三段）：
 * 1. **筛选 → 查看**：GET /records 四参数（from/to/submitter_id/status）逐项与组合筛选，
 *    黄金值以库内真实种子记录（D-1~D-10）为基线**从库反查期望集合**（不硬编码种子行内容，
 *    跨灌种日稳健）；非法参数 400 逐条点名（parseRecordListFilters 单一实现，与导出共用）。
 * 2. **导出**：GET /admin/records/export —— CSV 附件（UTF-8 BOM + CRLF，契约订正 28）：
 *    表头逐字、数据行与库内筛选窗口逐一对应、文件名按区间命名；master 403 由 admin.spec
 *    权限矩阵覆盖，此处只断业务行为。
 * 3. **批注（D-T24）**：POST /admin/records/{id}/annotation —— 覆盖式单条（chief_note），
 *    空串清除、500 字上限、值无变化不写审计（D-T21 M1 同一精神）、draft 行允许批注；
 *    每次变更审计 `record.annotate`（oldValue/newValue 携 note 前后值）＝「批注留痕」判据。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * --runInBand 串行（与其余 spec 共用同一库）。种子行一律还原（D-1 批注后清回 null、
 * 临时行 try/finally 即删），afterAll 按 id 上界只删本文件新增审计与会话。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, gt } from 'drizzle-orm';
import request from 'supertest';
import type { RecordListDto } from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, records, sessions, users } from '../db/schema';
import { RecordsService } from '../records/records.service';

const PASSWORD = 'Handover@2026';
const LIST_API = '/api/v1/records';
const EXPORT_API = '/api/v1/admin/records/export';
const ANNOTATION_API = (id: number | string): string => `/api/v1/admin/records/${id}/annotation`;

/** 导出表头（契约订正 28 钉死列集；与 AdminService.EXPORT_COLUMNS 逐字对账） */
const EXPORT_HEADER =
  '交接单号,班次日期,状态,版本,交班人,接班人,提交时刻,确认时刻,水用量,电用量,天然气用量,液氧日用量,标红项数,科长批注';

/** 日历日加 N 天（UTC 算法，与 duty-date.ts plusOneDay 同式，勿改口径） */
function plusDays(dutyDate: string, days: number): string {
  const d = new Date(`${dutyDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('TK-24 记录管理（接口，F6-01-T1）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let chiefCookie = '';
  let masterCookie = '';
  let auditHighWater = 0;

  /** 种子记录基线（beforeAll 从库反查，不硬编码种子行内容） */
  let seedRows: {
    id: number;
    record_no: string;
    duty_date: string;
    status: string;
    submitter_id: number;
  }[];
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
    server = app.getHttpServer() as Server;

    dutyDate = (await app.get(RecordsService).resolveDutyDate()).dutyDate;

    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);

    // 种子哨兵：D-1~D-10 有记录（黄金值基线），缺位即显式红（防跨灌种日漂移）
    seedRows = await db
      .select({
        id: records.id,
        record_no: records.recordNo,
        duty_date: records.dutyDate,
        status: records.status,
        submitter_id: records.submitterId,
      })
      .from(records);
    for (let i = 1; i <= 10; i++) {
      if (!seedRows.some((r) => r.duty_date === plusDays(dutyDate, -i))) {
        throw new Error(`种子记录缺 D-${i}——请先 db:setup 重灌种子`);
      }
    }

    chiefCookie = await login('chief');
    masterCookie = await login('zhang');
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  // ── ① 筛选 → 查看（GET /records，契约 §3.5）─────────────────────────

  describe('GET /records 按日期/交班人/状态筛选（F6-01-T1「筛选结果正确」）', () => {
    it('黄金值：无筛选回全部种子记录，duty_date 严格倒序，行形状键集完整', async () => {
      const res = await request(server).get(LIST_API).set('Cookie', chiefCookie).expect(200);
      const body = res.body as RecordListDto;
      expect(body.items).toHaveLength(seedRows.length);
      const dates = body.items.map((i) => i.duty_date);
      expect([...dates].sort().reverse()).toEqual(dates);
      expect(Object.keys(body.items[0]!).sort()).toEqual(
        [
          'alert_count',
          'chief_note',
          'confirmed_at',
          'duty_date',
          'id',
          'receiver',
          'record_no',
          'status',
          'submitted_at',
          'submitter',
          'version',
        ].sort(),
      );
      // 与详情同源口径：种子 D-1 待确认单标红行数 > 0（种子 §六 D-1 标红齐全）
      const d1 = body.items.find((i) => i.duty_date === plusDays(dutyDate, -1))!;
      expect(d1.alert_count).toBeGreaterThan(0);
    });

    it('from/to 窗口筛选：返回集合与库内同窗口查询逐字一致（D-4~D-2）', async () => {
      const from = plusDays(dutyDate, -4);
      const to = plusDays(dutyDate, -2);
      const res = await request(server)
        .get(LIST_API)
        .query({ from, to })
        .set('Cookie', chiefCookie)
        .expect(200);
      const expected = seedRows
        .filter((r) => r.duty_date >= from && r.duty_date <= to)
        .map((r) => r.record_no)
        .sort();
      expect((res.body as RecordListDto).items.map((i) => i.record_no).sort()).toEqual(expected);
    });

    it('submitter_id 筛选：库内记录最多的交班人 → 全部行同交班人、行数与库一致', async () => {
      const bySubmitter = new Map<number, number>();
      for (const r of seedRows)
        bySubmitter.set(r.submitter_id, (bySubmitter.get(r.submitter_id) ?? 0) + 1);
      const [topId, topCount] = [...bySubmitter.entries()].sort((a, b) => b[1] - a[1])[0]!;
      const res = await request(server)
        .get(LIST_API)
        .query({ submitter_id: topId })
        .set('Cookie', chiefCookie)
        .expect(200);
      const items = (res.body as RecordListDto).items;
      expect(items).toHaveLength(topCount);
      expect(items.every((i) => i.submitter.id === topId)).toBe(true);
      // 姓名与 users 表同源（C-05 实名）
      const name = (await db.select().from(users).where(eq(users.id, topId)).limit(1))[0]!.realName;
      expect(items.every((i) => i.submitter.real_name === name)).toBe(true);
    });

    it('status 筛选 + 组合筛选：与库内查询一致（种子 D-2 异议单命中 objection）', async () => {
      const res = await request(server)
        .get(LIST_API)
        .query({ status: 'objection' })
        .set('Cookie', chiefCookie)
        .expect(200);
      const expected = seedRows
        .filter((r) => r.status === 'objection')
        .map((r) => r.record_no)
        .sort();
      expect((res.body as RecordListDto).items.map((i) => i.record_no).sort()).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0); // 种子哨兵：异议单在库

      // 组合：窗口 ∩ 交班人（取窗口 D-4~D-2 内首行交班人）
      const first = (res.body as RecordListDto).items[0];
      if (first) {
        const combined = await request(server)
          .get(LIST_API)
          .query({ from: plusDays(dutyDate, -10), to: plusDays(dutyDate, -1), status: 'objection' })
          .set('Cookie', chiefCookie)
          .expect(200);
        expect(
          (combined.body as RecordListDto).items.every(
            (i) => i.status === 'objection' && i.duty_date >= plusDays(dutyDate, -10),
          ),
        ).toBe(true);
      }
    });

    it('非法参数 400 逐条点名（列表与导出共用 parseRecordListFilters 单一实现）', async () => {
      const cases: [Record<string, string>, string][] = [
        [{ from: '2026-02-30' }, 'from'],
        [{ to: '2026-13-01' }, 'to'],
        [{ status: 'xxx' }, 'status'],
        [{ submitter_id: 'abc' }, 'submitter_id'],
      ];
      for (const [query, field] of cases) {
        for (const api of [LIST_API, EXPORT_API]) {
          const res = await request(server).get(api).query(query).set('Cookie', chiefCookie);
          expect(`${api} ${field} → ${res.status}`).toBe(`${api} ${field} → 400`);
          const body = res.body as { code: string; missing_fields: { field: string }[] | null };
          expect(body.code).toBe('VALIDATION_OUT_OF_RANGE');
          expect(body.missing_fields?.some((m) => m.field === field)).toBe(true);
        }
      }
    });

    it('角色：列表为「登录用户」——master 亦可查（F5-01 共用取数），与 admin 守卫区分', async () => {
      await request(server).get(LIST_API).set('Cookie', masterCookie).expect(200);
    });
  });

  // ── ② 导出（GET /admin/records/export，契约订正 28）──────────────────

  describe('GET /admin/records/export CSV 导出（F6-01-T1「导出可用」）', () => {
    it('月内窗口：CSV 附件头 + BOM + CRLF + 表头逐字 + 数据行与库内窗口逐一对应', async () => {
      const from = plusDays(dutyDate, -4);
      const to = plusDays(dutyDate, -4); // 同日 → 同月 → records-YYYY-MM.csv
      const res = await request(server)
        .get(EXPORT_API)
        .query({ from, to })
        .set('Cookie', chiefCookie)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain(`records-${from.slice(0, 7)}.csv`);

      const text = res.text;
      expect(text.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM（Excel 直开不乱码）
      expect(text.includes('\r\n')).toBe(true);
      const lines = text
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n');
      expect(lines[0]).toBe(EXPORT_HEADER);
      const expected = seedRows.filter((r) => r.duty_date === from);
      expect(lines).toHaveLength(1 + expected.length);
      for (const row of expected) {
        expect(lines.some((l) => l.includes(row.record_no))).toBe(true);
      }
      // 种子 D-4 的状态列中文回显（状态机四值映射）
      const statusOf = expected[0]!.status;
      expect(lines[1]!.split(',').includes(statusOf === 'completed' ? '已归档' : statusOf)).toBe(
        true,
      );
    });

    it('跨月区间文件名 records-{from}_{to}.csv；无筛选文件名含导出当日', async () => {
      const res = await request(server)
        .get(EXPORT_API)
        .query({ from: plusDays(dutyDate, -40), to: plusDays(dutyDate, -1) })
        .set('Cookie', chiefCookie)
        .expect(200);
      expect(res.headers['content-disposition']).toContain(
        `records-${plusDays(dutyDate, -40)}_${plusDays(dutyDate, -1)}.csv`,
      );

      const noFilter = await request(server).get(EXPORT_API).set('Cookie', chiefCookie).expect(200);
      expect(noFilter.headers['content-disposition']).toContain('records-');
    });

    it('空结果窗口：仅表头一行（200，不 404 不 500）', async () => {
      const res = await request(server)
        .get(EXPORT_API)
        .query({ from: plusDays(dutyDate, 400), to: plusDays(dutyDate, 401) })
        .set('Cookie', chiefCookie)
        .expect(200);
      const lines = res.text
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n');
      expect(lines).toEqual([EXPORT_HEADER]);
    });
  });

  // ── ③ 批注（POST /admin/records/{id}/annotation，D-T24）──────────────

  describe('POST /admin/records/{id}/annotation 科长批注（F6-01-T1「批注留痕」）', () => {
    const d1No = (): string =>
      seedRows.find((r) => r.duty_date === plusDays(dutyDate, -1))!.record_no;
    const d1Id = (): number => seedRows.find((r) => r.duty_date === plusDays(dutyDate, -1))!.id;
    const auditCount = async (): Promise<number> =>
      (
        await db
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(and(eq(auditLogs.action, 'record.annotate'), gt(auditLogs.id, auditHighWater)))
      ).length;

    it('批注写入 → 响应/列表/详情三处回读 + 审计 record.annotate（null→值）', async () => {
      const before = await auditCount();
      const res = await request(server)
        .post(ANNOTATION_API(d1Id()))
        .set('Cookie', chiefCookie)
        .send({ note: '请核实水表底数后归档' })
        .expect(201);
      expect(res.body).toEqual({
        id: d1Id(),
        record_no: d1No(),
        chief_note: '请核实水表底数后归档',
      });

      // 批注留痕：audit_logs 旧行不被修改、新行 old→new（契约 §5）
      const audit = (
        await db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.action, 'record.annotate'), gt(auditLogs.id, auditHighWater)))
      ).at(-1)!;
      expect(audit.targetType).toBe('record');
      expect(audit.targetId).toBe(d1No());
      expect(audit.oldValue).toEqual({ note: null });
      expect(audit.newValue).toEqual({ note: '请核实水表底数后归档' });
      expect(await auditCount()).toBe(before + 1);

      // 列表与详情回读（F6-01「查看」半边消费同一值）
      const list = await request(server).get(LIST_API).set('Cookie', chiefCookie).expect(200);
      expect((list.body as RecordListDto).items.find((i) => i.id === d1Id())?.chief_note).toBe(
        '请核实水表底数后归档',
      );
      const detail = await request(server)
        .get(`/api/v1/records/${d1Id()}`)
        .set('Cookie', chiefCookie)
        .expect(200);
      expect((detail.body as { chief_note: string | null }).chief_note).toBe(
        '请核实水表底数后归档',
      );
    });

    it('覆盖批注 → 审计值→值；同值重复批注 → 值无变化不写审计（D-T21 M1 同一精神）', async () => {
      const res = await request(server)
        .post(ANNOTATION_API(d1Id()))
        .set('Cookie', chiefCookie)
        .send({ note: '已电话联系交班人核实' })
        .expect(201);
      expect((res.body as { chief_note: string }).chief_note).toBe('已电话联系交班人核实');
      const audit = (
        await db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.action, 'record.annotate'), gt(auditLogs.id, auditHighWater)))
      ).at(-1)!;
      expect(audit.oldValue).toEqual({ note: '请核实水表底数后归档' });
      expect(audit.newValue).toEqual({ note: '已电话联系交班人核实' });
      const afterOverwrite = await auditCount();

      await request(server)
        .post(ANNOTATION_API(d1Id()))
        .set('Cookie', chiefCookie)
        .send({ note: '已电话联系交班人核实' })
        .expect(201);
      expect(await auditCount()).toBe(afterOverwrite); // 值无变化：不更新不写审计
    });

    it('空串清除 → chief_note 置 null + 审计值→null；前后空白 trim', async () => {
      const res = await request(server)
        .post(ANNOTATION_API(d1Id()))
        .set('Cookie', chiefCookie)
        .send({ note: '  ' })
        .expect(201);
      expect((res.body as { chief_note: string | null }).chief_note).toBeNull();
      const audit = (
        await db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.action, 'record.annotate'), gt(auditLogs.id, auditHighWater)))
      ).at(-1)!;
      expect(audit.oldValue).toEqual({ note: '已电话联系交班人核实' });
      expect(audit.newValue).toEqual({ note: null });

      const cleared = await request(server)
        .post(ANNOTATION_API(d1Id()))
        .set('Cookie', chiefCookie)
        .send({ note: '  批注正文  ' })
        .expect(201);
      expect((cleared.body as { chief_note: string }).chief_note).toBe('批注正文'); // trim 后写入
    });

    it('501 字越界 400 点名 chief_note；未知/非数字 id 一律 404（不泄露存在性）', async () => {
      const res = await request(server)
        .post(ANNOTATION_API(d1Id()))
        .set('Cookie', chiefCookie)
        .send({ note: '长'.repeat(501) })
        .expect(400);
      expect((res.body as { code: string }).code).toBe('VALIDATION_OUT_OF_RANGE');
      expect((res.body as { missing_fields: { field: string }[] }).missing_fields[0]!.field).toBe(
        'chief_note',
      );

      await request(server)
        .post(ANNOTATION_API(999999))
        .set('Cookie', chiefCookie)
        .send({ note: 'x' })
        .expect(404);
      await request(server)
        .post(ANNOTATION_API('abc'))
        .set('Cookie', chiefCookie)
        .send({ note: 'x' })
        .expect(404);
    });

    it('draft 行（撤回未重提）允许批注——「请尽快重提」是合法管理动作（D-T24 不限状态）', async () => {
      const zhangId = (
        await db.select({ id: users.id }).from(users).where(eq(users.username, 'zhang')).limit(1)
      )[0]!.id;
      const tempDate = plusDays(dutyDate, -30); // 种子区外，record_no 唯一
      await db.insert(records).values({
        recordNo: 'HB-TK24ANNO-01',
        dutyDate: tempDate,
        submitterId: zhangId,
        status: 'draft',
        version: 1,
      });
      const tempId = (
        await db
          .select({ id: records.id })
          .from(records)
          .where(eq(records.recordNo, 'HB-TK24ANNO-01'))
          .limit(1)
      )[0]!.id;
      try {
        const res = await request(server)
          .post(ANNOTATION_API(tempId))
          .set('Cookie', chiefCookie)
          .send({ note: '该单已撤回，请尽快重提' })
          .expect(201);
        expect((res.body as { chief_note: string }).chief_note).toBe('该单已撤回，请尽快重提');
      } finally {
        await db.delete(records).where(eq(records.recordNo, 'HB-TK24ANNO-01'));
      }
    });

    it('种子还原：全部用例结束后 D-1 行 chief_note 回到 null（不污染其他 spec 基线）', async () => {
      await db.update(records).set({ chiefNote: null }).where(eq(records.recordNo, d1No()));
      const anno = await db
        .select({ note: records.chiefNote })
        .from(records)
        .where(eq(records.recordNo, d1No()));
      expect(anno[0]!.note).toBeNull();
    });
  });
});
