/**
 * TK-25 人员管理测试 —— 挂钩任务分解 TK-25 完成判据「F6-02-T1 绿：开通/停用账号 → 审计 →
 * 记录操作人、时间；停用后登录拒绝（联动 F1-11-T3）」与台账 F6-02（师傅账号开通/停用，
 * users.status + audit_logs + sessions 停用即吊销存根 D-T13）。
 *
 * 用例结构（对应 F6-02-T1 链路的三段）：
 * 1. **查询**：GET /admin/users 全量账号黄金值——种子 5 账号、id 升序、行形状键集，
 *    username/real_name/role/status 逐行从库反查（不硬编码种子姓名，跨灌种日稳健）。
 * 2. **开通**：POST /admin/users —— 角色恒 master（D-T25 ①）、bcrypt 哈希落库（明文
 *    不出网不落库）、审计 `user.update`（oldValue=null、newValue 携开通值，操作人=登录
 *    科长、时刻=created_at）；缺字段/越界/重复名 400 逐条点名。
 * 3. **停用/启用**：PATCH /admin/users/{id} —— 停用后已建会话存根即删（已在线设备下一次
 *    请求 401，D-T13）、再次登录拒绝且提示停用而非报错（联动 F1-11-T3，auth.spec 同源
 *    断言的服务端联动半边）；启用后恢复登录；停用/启用均审计新旧值；同值重复 PATCH 不写
 *    审计（D-T21 M1 精神）；chief 目标 403（F6-02 范围 = 师傅账号）、未知/非数字 id 404、
 *    status 越值 400 点名。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * --runInBand 串行（与其余 spec 共用同一库）。afterAll 按 id 上界删本文件新增审计、
 * 删本文件开通的测试账号（前缀 tk25-，无排班/通知引用，sessions 随 FK 级联）与会话。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, gt, like } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { UserListDto } from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, sessions, users } from '../db/schema';

const PASSWORD = 'Handover@2026';
const LIST_API = '/api/v1/admin/users';
const LOGIN_API = '/api/v1/auth/login';

/** 本文件开通的测试账号（前缀隔离，afterAll 按前缀清除；种子账号不受影响） */
const TEST_USER = 'tk25wang';
const TEST_PASSWORD = 'Tk25Passw0rd';

describe('TK-25 人员管理（接口，F6-02-T1）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let chiefCookie = '';
  let chiefId = 0;
  let auditHighWater = 0;

  /** chief 会话调 PATCH 的便捷封装（body 由调用方给定） */
  function patchStatus(id: number | string, body: object): request.Test {
    return request(server).patch(`${LIST_API}/${id}`).set('Cookie', chiefCookie).send(body);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get<Db>(DB);
    server = app.getHttpServer() as Server;

    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);

    // 清掉本前缀可能的历史残留（重跑不累积），再清会话（与既有 spec 同纪律）
    await db.delete(users).where(like(users.username, 'tk25%'));
    await db.delete(sessions);

    chiefCookie = (
      await request(server)
        .post(LOGIN_API)
        .send({ username: 'chief', password: PASSWORD })
        .expect(200)
    ).headers['set-cookie']?.[0] as string;
    chiefId = (
      await db.select({ id: users.id }).from(users).where(eq(users.username, 'chief')).limit(1)
    )[0]!.id;
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(users).where(like(users.username, 'tk25%'));
    await db.delete(sessions);
    await app.close();
  });

  // ── ① 查询（GET /admin/users）───────────────────────────────────────

  describe('GET /admin/users 账号全景（F6-02 查询半边）', () => {
    it('黄金值：种子 5 账号全列、id 升序、行形状键集、逐行从库反查一致', async () => {
      const res = await request(server).get(LIST_API).set('Cookie', chiefCookie).expect(200);
      const body = res.body as UserListDto;

      const dbRows = await db.select().from(users).orderBy(users.id);
      expect(body.items).toHaveLength(dbRows.length);
      // dbRows 恒按 id 升序：id 序列逐位相等即证明响应同为升序（= 开通顺序）
      expect(body.items.map((u) => u.id)).toEqual(dbRows.map((r) => r.id));

      for (const [i, item] of body.items.entries()) {
        const row = dbRows[i]!;
        expect(Object.keys(item).sort()).toEqual(
          ['created_at', 'id', 'real_name', 'role', 'status', 'username'].sort(),
        );
        expect(item.username).toBe(row.username);
        expect(item.real_name).toBe(row.realName);
        expect(item.role).toBe(row.role);
        expect(item.status).toBe(row.status);
        expect(item.created_at).toBe(row.createdAt);
      }
    });
  });

  // ── ② 开通（POST /admin/users）─────────────────────────────────────

  describe('POST /admin/users 开通师傅账号（F6-02-T1「开通 → 审计 → 记录操作人、时间」）', () => {
    it('开通成功：角色恒 master、初始状态 active、bcrypt 哈希落库、响应不回显凭证', async () => {
      const res = await request(server)
        .post(LIST_API)
        .set('Cookie', chiefCookie)
        .send({ username: TEST_USER, real_name: '王测试', password: TEST_PASSWORD })
        .expect(201);

      const body = res.body as {
        id: number;
        username: string;
        real_name: string;
        role: string;
        status: string;
      };
      expect(body.username).toBe(TEST_USER);
      expect(body.real_name).toBe('王测试');
      expect(body.role).toBe('master'); // D-T25 ①：科长账号不走本接口开通
      expect(body.status).toBe('active');
      expect(JSON.stringify(body)).not.toContain(TEST_PASSWORD); // 明文不出网
      expect(JSON.stringify(body)).not.toContain('password_hash');

      const row = (await db.select().from(users).where(eq(users.username, TEST_USER)).limit(1))[0]!;
      expect(row.status).toBe('active');
      expect(await bcrypt.compare(TEST_PASSWORD, row.passwordHash)).toBe(true);
    });

    it('开通审计：action=user.update、操作人=登录科长、newValue 携开通值、created_at 有时刻', async () => {
      const row = (
        await db.select({ id: users.id }).from(users).where(eq(users.username, TEST_USER)).limit(1)
      )[0]!;
      const audits = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.targetId, String(row.id)));
      const audit = audits.find((a) => a.action === 'user.update');
      expect(audit).toBeDefined();
      expect(audit!.actorId).toBe(chiefId); // F6-02-T1「记录操作人」
      expect(audit!.targetType).toBe('user');
      expect(audit!.createdAt).toBeTruthy(); // F6-02-T1「（记录）时间」
      expect(audit!.oldValue).toBeNull(); // 开通无旧值
      expect(audit!.newValue).toEqual({
        username: TEST_USER,
        real_name: '王测试',
        role: 'master',
        status: 'active',
      });
    });

    it('参数校验：缺 username/real_name/短密码 → 400 逐条点名；越界 username → 400', async () => {
      const res = await request(server)
        .post(LIST_API)
        .set('Cookie', chiefCookie)
        .send({ username: '', real_name: '', password: 'short' })
        .expect(400);
      const fields = (
        res.body as { missing_fields: { field: string }[] | null }
      ).missing_fields?.map((f) => f.field);
      expect(fields).toEqual(['username', 'real_name', 'password']);

      await request(server)
        .post(LIST_API)
        .set('Cookie', chiefCookie)
        .send({ username: 'x'.repeat(33), real_name: '超长', password: TEST_PASSWORD })
        .expect(400);
    });

    it('重复登录名 → 400 点名 username（预查路径与并发 ER_DUP_ENTRY 同一文案）', async () => {
      const res = await request(server)
        .post(LIST_API)
        .set('Cookie', chiefCookie)
        .send({ username: TEST_USER, real_name: '重复名', password: TEST_PASSWORD })
        .expect(400);
      expect((res.body as { message: string }).message).toContain(TEST_USER);
      const fields = (res.body as { missing_fields: { field: string }[] }).missing_fields;
      expect(fields?.map((f) => f.field)).toEqual(['username']);
    });
  });

  // ── ③ 停用/启用（PATCH /admin/users/{id}）──────────────────────────

  describe('PATCH /admin/users/{id} 停用即不可登录（F6-02-T1「停用后登录拒绝」、D-T13）', () => {
    it('停用：状态翻转 + 该账号全部会话存根即删 + 审计新旧值（操作人、时间）', async () => {
      const row = (
        await db.select({ id: users.id }).from(users).where(eq(users.username, TEST_USER)).limit(1)
      )[0]!;

      // 先建一条在线会话（停用前有效）
      await request(server)
        .post(LOGIN_API)
        .send({ username: TEST_USER, password: TEST_PASSWORD })
        .expect(200);
      expect((await db.select().from(sessions).where(eq(sessions.userId, row.id))).length).toBe(1);

      const res = await patchStatus(row.id, { status: 'disabled' }).expect(200);
      expect((res.body as { status: string }).status).toBe('disabled');
      // 停用即吊销存根：已在线设备下一次请求即 401（D-T13，契约 §1）
      expect((await db.select().from(sessions).where(eq(sessions.userId, row.id))).length).toBe(0);

      const audit = (
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.targetId, String(row.id)))
      ).filter(
        (a) => a.action === 'user.update' && (a.oldValue as { status?: string } | null)?.status,
      );
      const disableAudit = audit.at(-1)!;
      expect(disableAudit.actorId).toBe(chiefId);
      expect(disableAudit.oldValue).toEqual({ status: 'active' });
      expect(disableAudit.newValue).toEqual({ status: 'disabled' });
      expect(disableAudit.createdAt).toBeTruthy();
    });

    it('停用后登录拒绝：401 UNAUTHENTICATED、提示停用而非报错（联动 F1-11-T3）', async () => {
      const res = await request(server)
        .post(LOGIN_API)
        .send({ username: TEST_USER, password: TEST_PASSWORD })
        .expect(401);
      expect((res.body as { code: string }).code).toBe('UNAUTHENTICATED');
      expect((res.body as { message: string }).message).toContain('停用');
    });

    it('启用：恢复 active、可重新登录成功、审计 disabled→active', async () => {
      const row = (
        await db.select({ id: users.id }).from(users).where(eq(users.username, TEST_USER)).limit(1)
      )[0]!;
      const before = (
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.targetId, String(row.id)))
      ).filter((a) => a.action === 'user.update').length;

      const res = await patchStatus(row.id, { status: 'active' }).expect(200);
      expect((res.body as { status: string }).status).toBe('active');

      await request(server)
        .post(LOGIN_API)
        .send({ username: TEST_USER, password: TEST_PASSWORD })
        .expect(200);

      const audits = (
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.targetId, String(row.id)))
      ).filter((a) => a.action === 'user.update');
      expect(audits.length).toBe(before + 1);
      expect(audits.at(-1)!.oldValue).toEqual({ status: 'disabled' });
      expect(audits.at(-1)!.newValue).toEqual({ status: 'active' });
      expect(audits.at(-1)!.actorId).toBe(chiefId);
    });

    it('同值重复 PATCH：200 回执但不更新不写审计（D-T21 M1 精神）', async () => {
      const row = (
        await db.select({ id: users.id }).from(users).where(eq(users.username, TEST_USER)).limit(1)
      )[0]!;
      const before = (
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.targetId, String(row.id)))
      ).filter((a) => a.action === 'user.update').length;

      await patchStatus(row.id, { status: 'active' }).expect(200);

      const after = (
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.targetId, String(row.id)))
      ).filter((a) => a.action === 'user.update').length;
      expect(after).toBe(before);
    });

    it('保护门：chief 目标 403、未知 id 404、非数字 id 404、status 越值 400 点名', async () => {
      const res = await patchStatus(chiefId, { status: 'disabled' }).expect(403);
      expect((res.body as { code: string }).code).toBe('FORBIDDEN');

      await patchStatus(999999, { status: 'disabled' }).expect(404);
      await patchStatus('abc', { status: 'disabled' }).expect(404);

      const bad = await patchStatus(1, { status: 'frozen' }).expect(400);
      expect(
        (bad.body as { missing_fields: { field: string }[] }).missing_fields?.map((f) => f.field),
      ).toEqual(['status']);
    });
  });
});
