/**
 * TK-04 认证接口测试 —— 挂钩台账 F1-11（AGENTS.md「需求即测试」：用例名以 -T 编号挂钩台账）。
 *
 * 覆盖台账用例：
 * - F1-11-T1 正确账密 → 登录 → 成功建立会话（判据：返回用户与角色）
 * - F1-11-T2 错误密码 → 登录 → 拒绝（判据：不泄露账号是否存在；失败也写审计）
 * - F1-11-T3 已停用账号 → 登录 → 拒绝（判据：提示停用而非报错）
 * 另附 D-T13 选型定案的验收（非台账用例）：Bearer 通道、登出即失效、未登录 401、停用即吊销存根。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * CI 由 workflow 的 mysql service 提供（见 .github/workflows/ci.yml）。
 * 测试对库的改动在 afterAll 全部还原，不破坏《开发种子数据》的计数口径。
 */
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, gt } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, sessions, users } from '../db/schema';
import { SESSION_COOKIE } from './auth.service';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';
/** 契约 §1 基础路径 + §3.1 认证路由 */
const API = '/api/v1/auth';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 契约 §2 统一错误结构断言（C-09：所有 4xx 同一形状，非缺失类错误两键为 null） */
function expectApiErrorShape(body: Record<string, unknown>, code: string): void {
  expect(body.code).toBe(code);
  expect(typeof body.message).toBe('string');
  expect(String(body.message).length).toBeGreaterThan(0);
  expect(body.missing_fields).toBeNull();
  expect(body.need_confirm).toBeNull();
  expect(body.request_id).toMatch(/^req-/);
}

describe('F1-11 账号密码登录（TK-04）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  /** 测试前的审计行 id 上界：结束时只清理本测试新增的行，不动种子数据 */
  let auditHighWater = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app); // 与 main.ts 共用同一份配置，避免前缀/Cookie 解析漂移
    await app.init();
    db = app.get<Db>(DB);
    server = app.getHttpServer() as Server;

    // 种子不含会话数据（《开发种子数据》无 sessions 节），清空以保证 T1 的存根计数断言成立
    await db.delete(sessions);
    const rows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = rows.reduce((max, r) => Math.max(max, r.id), 0);
  });

  afterAll(async () => {
    // 还原测试对库的改动：新增审计行、全部会话存根、被临时停用的账号（种子 5 个账号全为 active）
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await db.update(users).set({ status: 'active' });
    // 关闭应用触发 DbModule.onApplicationShutdown 结束连接池，否则 Jest 进程不退出
    await app.close();
  });

  it('F1-11-T1：正确账密 → 登录 → 成功建立会话，返回用户与角色', async () => {
    // supertest 默认不发 User-Agent，显式带上以验证 C-05「登录设备记审计」
    const userAgent = 'HandoverTest/1.0 (F1-11-T1)';
    const res = await request(server)
      .post(`${API}/login`)
      .set('User-Agent', userAgent)
      .send({ username: 'zhang', password: PASSWORD })
      .expect(200);

    // 判据：返回用户与角色（契约 §3.1 GET /auth/me 同款形状 id/real_name/role）
    expect(res.body.user).toEqual({
      id: expect.any(Number),
      real_name: '张师傅',
      role: 'master',
    });

    // 契约 §3.1：cookie 通道响应体**不**返回令牌（防 XSS 从响应体窃取，保住 HttpOnly 的意义）
    expect(res.body.token).toBeUndefined();

    // 技术方案 §6：HttpOnly + SameSite=Lax
    const setCookie = String(res.headers['set-cookie']?.[0] ?? '');
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    // D-T13：存根落库，且只存 SHA-256 摘要（明文令牌不入库）
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    const stubHash = rows[0]?.tokenHash ?? '';
    expect(stubHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.channel).toBe('cookie');
    expect(rows[0]?.userId).toBe(res.body.user.id);
    // C-05：登录设备也进存根（与审计互为印证）
    expect(rows[0]?.userAgent).toBe(userAgent);
    // Cookie 里下发的是令牌原文，存根里只有其摘要，两者不得相等
    expect(setCookie).not.toContain(stubHash);

    // 会话可用：带 Cookie 访问 /auth/me 取回同一用户
    const me = await request(server).get(`${API}/me`).set('Cookie', setCookie).expect(200);
    expect(me.body).toEqual(res.body.user);

    // 契约 §5：登录写审计（action=login，含设备与 IP；C-04 全程留痕）
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'login'));
    const mine = audits.find((a) => a.reason === '登录成功' && a.actorId === rows[0]?.userId);
    expect(mine).toBeDefined();
    expect(mine?.device).toBe(userAgent); // User-Agent 记入 device 列（C-05）
    expect(mine?.ip).toBeTruthy(); // 来源 IP 记入 ip 列
  });

  it('F1-11-T2：错误密码 → 拒绝；不泄露账号是否存在；失败也写审计', async () => {
    const wrongPassword = await request(server)
      .post(`${API}/login`)
      .send({ username: 'zhang', password: 'definitely-wrong' })
      .expect(401);
    const unknownAccount = await request(server)
      .post(`${API}/login`)
      .send({ username: 'no_such_account', password: 'definitely-wrong' })
      .expect(401);

    // 判据：不泄露账号是否存在 —— 「账号不存在」与「密码错误」对外文案与错误码完全一致
    expect(wrongPassword.body.code).toBe(unknownAccount.body.code);
    expect(wrongPassword.body.message).toBe(unknownAccount.body.message);
    expect(wrongPassword.body.message).toBe('账号或密码错误');
    expectApiErrorShape(wrongPassword.body, 'UNAUTHENTICATED');
    expectApiErrorShape(unknownAccount.body, 'UNAUTHENTICATED');

    // 失败不得下发会话
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();

    // 判据：失败也写审计（契约 §5），且审计内部区分原因（不对外泄露）
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'login'));
    const reasons = audits.map((a) => a.reason);
    expect(reasons).toContain('密码错误');
    expect(reasons).toContain('账号不存在');
    // 账号不存在时无从归属，actor_id 为 NULL
    expect(audits.some((a) => a.reason === '账号不存在' && a.actorId === null)).toBe(true);
  });

  it('F1-11-T3：已停用账号 → 登录 → 拒绝，提示停用而非报错', async () => {
    // 种子 5 个账号全为 active（《开发种子数据》§一），故测试内临时停用 liu，afterAll 统一还原
    await db.update(users).set({ status: 'disabled' }).where(eq(users.username, 'liu'));

    const res = await request(server)
      .post(`${API}/login`)
      .send({ username: 'liu', password: PASSWORD })
      .expect(401);

    // 判据：提示停用而非报错（与「账号或密码错误」区分开）
    expect(res.body.message).toContain('停用');
    expect(res.body.message).not.toBe('账号或密码错误');
    expectApiErrorShape(res.body, 'UNAUTHENTICATED');

    // 未建立会话存根（联表按用户名查，免去取 id 的空值处理）
    const rows = await db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(users.username, 'liu'));
    expect(rows).toHaveLength(0);
  });

  describe('D-T13 双通道与即时撤销（选型定案验收，非台账用例）', () => {
    it('bearer 通道：响应体返回令牌、不下发 Cookie，经 Authorization 头可鉴权', async () => {
      const res = await request(server)
        .post(`${API}/login`)
        .send({ username: 'shi', password: PASSWORD, channel: 'bearer' })
        .expect(200);

      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.length).toBeGreaterThan(20);
      expect(res.headers['set-cookie']).toBeUndefined();

      const me = await request(server)
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${res.body.token}`)
        .expect(200);
      expect(me.body.real_name).toBe('施师傅');

      // 存根记录通道，便于排查（§4.2 sessions.channel）
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, sha256(String(res.body.token))));
      expect(rows[0]?.channel).toBe('bearer');
    });

    it('登出后同一令牌立即失效（删存根，而非仅清 Cookie）', async () => {
      const login = await request(server)
        .post(`${API}/login`)
        .send({ username: 'wang', password: PASSWORD, channel: 'bearer' })
        .expect(200);
      const auth = { Authorization: `Bearer ${login.body.token}` };
      await request(server).get(`${API}/me`).set(auth).expect(200);

      const out = await request(server).post(`${API}/logout`).set(auth).expect(200);
      expect(out.body).toEqual({ ok: true });

      // 关键：同一令牌再请求即 401 —— 服务端已不认可（契约 §3.1）
      const after = await request(server).get(`${API}/me`).set(auth).expect(401);
      expectApiErrorShape(after.body, 'UNAUTHENTICATED');
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, sha256(login.body.token)));
      expect(rows).toHaveLength(0);
    });

    it('未登录访问受保护接口 → 401 UNAUTHENTICATED（契约 §2 结构）', async () => {
      const res = await request(server).get(`${API}/me`).expect(401);
      expectApiErrorShape(res.body, 'UNAUTHENTICATED');
    });

    it('停用已在线账号 → 吊销其全部存根，下一次请求即 401（F6-02 停用即不可登录）', async () => {
      const login = await request(server)
        .post(`${API}/login`)
        .send({ username: 'chief', password: PASSWORD, channel: 'bearer' })
        .expect(200);
      const auth = { Authorization: `Bearer ${login.body.token}` };
      await request(server).get(`${API}/me`).set(auth).expect(200);

      // 科长停用该账号（F6-02 的正式接口在 TK-2x，此处直接改库模拟该动作的结果）
      await db.update(users).set({ status: 'disabled' }).where(eq(users.username, 'chief'));

      const res = await request(server).get(`${API}/me`).set(auth).expect(401);
      expectApiErrorShape(res.body, 'UNAUTHENTICATED');

      // 存根已被吊销（D-T13「撤销即时生效」，JWT 无状态方案做不到这一点）
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, sha256(login.body.token)));
      expect(rows).toHaveLength(0);
    });
  });
});
