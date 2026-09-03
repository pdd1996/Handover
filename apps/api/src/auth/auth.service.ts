import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@handover/shared';
import { DB, type Db } from '../db/db.module';
import { auditLogs, configs, sessions, users } from '../db/schema';
import { unauthenticated } from '../common/api-error';

/** 会话令牌的 Cookie 名（HttpOnly + SameSite=Lax，见技术方案 §6「会话机制」） */
export const SESSION_COOKIE = 'handover_sid';

/** 登录通道（契约 §3.1 login 的 channel 参数；D-T13 双通道） */
export const LoginChannel = ['cookie', 'bearer'] as const;
export type LoginChannel = (typeof LoginChannel)[number];

/** 鉴权通过后挂在 request 上的当前用户 */
export interface SessionUser {
  id: number;
  username: string;
  realName: string;
  role: UserRole;
}

/** 客户端上下文：写 sessions 存根与 audit_logs（C-05 登录设备可追溯） */
export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

/**
 * 账号不存在时也比一次哈希：抹平响应时间差，避免时序侧信道泄露"账号是否存在"（F1-11-T2）。
 * 模块加载时算一次，cost 与真实密码哈希一致（10）。
 */
const DUMMY_HASH = bcrypt.hashSync('handover-timing-equalizer', 10);

/** configs.session_timeout_minutes 缺失或非法时的兜底（种子值 720，❓ 待科长确认） */
const DEFAULT_SESSION_TIMEOUT_MINUTES = 720;

type UserRow = typeof users.$inferSelect;

/** 令牌只存 SHA-256 摘要（§4.2 sessions.token_hash）：拖库也不能冒用在线会话 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** datetime 列为 string 模式且连接 timezone='Z'，故按 UTC 写 'YYYY-MM-DD HH:MM:SS' */
function utcDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 读回 UTC 的 DATETIME 字符串 → 毫秒时间戳 */
function parseUtc(value: string): number {
  return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, username: row.username, realName: row.realName, role: row.role };
}

/**
 * 认证与会话服务（TK-04，F1-11 / C-05；口径见技术方案 §6「会话机制」、决策记录 D-T13）。
 *
 * 会话存根落库而非内存/JWT，使「登出即失效」「停用即踢下线」都能即时生效，
 * 且重启不掉线、存根可跨端共享（将来接内网小程序无需重构认证层）。
 */
@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 登录：校验账密 → 建会话存根 → 写审计（成功与失败都写，契约 §5 action=login）。
   *
   * 判定顺序是安全设计的一部分：先比密码再判停用，故"停用"这一信息只在密码正确时暴露；
   * 账号不存在与密码错误返回同一文案（F1-11-T2 不泄露账号是否存在），
   * 已停用账号则提示停用而非报错（F1-11-T3）。
   */
  async login(
    input: { username: string; password: string; channel: LoginChannel },
    ctx: ClientContext,
  ): Promise<{ user: SessionUser; token: string; timeoutMinutes: number }> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);
    const user = rows[0];

    const passwordOk = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !passwordOk) {
      // 审计内部区分原因（供安全排查），但对外统一文案
      await this.writeLoginAudit(user?.id ?? null, user ? '密码错误' : '账号不存在', ctx);
      throw unauthenticated('账号或密码错误');
    }

    if (user.status === 'disabled') {
      await this.writeLoginAudit(user.id, '账号已停用', ctx);
      throw unauthenticated('账号已停用，请联系科长');
    }

    const token = randomBytes(32).toString('base64url');
    const timeoutMinutes = await this.sessionTimeoutMinutes();
    const now = Date.now();
    await this.db.insert(sessions).values({
      tokenHash: hashToken(token),
      userId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      channel: input.channel,
      lastSeenAt: utcDateTime(now),
      expiresAt: utcDateTime(now + timeoutMinutes * 60_000),
    });
    await this.writeLoginAudit(user.id, '登录成功', ctx);

    // 一并返回超时分钟数：controller 下发 Cookie maxAge 直接复用，避免重复查 configs 导致两处口径漂移
    return { user: toSessionUser(user), token, timeoutMinutes };
  }

  /**
   * 解析会话（Cookie 与 Bearer 双通道共用）：查存根 → 校过期 → 校账号状态 → 滑动续期。
   * 返回 null 表示无有效会话，由守卫统一抛 401。
   */
  async resolveSession(token: string): Promise<SessionUser | null> {
    const tokenHash = hashToken(token);
    const rows = await this.db
      .select({ user: users, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const now = Date.now();
    if (parseUtc(row.expiresAt) <= now) {
      await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
      return null;
    }

    // 停用即时生效（D-T13）：停用时已删存根，此处为双保险，兼顾并发与漏删
    if (row.user.status === 'disabled') {
      await this.revokeAllForUser(row.user.id);
      return null;
    }

    // 滑动续期：每次通过鉴权即顺延超时（技术方案 §6）
    const timeoutMinutes = await this.sessionTimeoutMinutes();
    await this.db
      .update(sessions)
      .set({
        lastSeenAt: utcDateTime(now),
        expiresAt: utcDateTime(now + timeoutMinutes * 60_000),
      })
      .where(eq(sessions.tokenHash, tokenHash));

    return toSessionUser(row.user);
  }

  /** 登出：删除存根行 → 服务端亦不再认可该令牌（契约 §3.1），并写审计 */
  async logout(token: string | null, ctx: ClientContext): Promise<void> {
    if (!token) return;
    const tokenHash = hashToken(token);
    const rows = await this.db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    await this.db.insert(auditLogs).values({
      actorId: rows[0]?.userId ?? null,
      action: 'logout',
      targetType: 'user',
      targetId: rows[0] ? String(rows[0].userId) : null,
      reason: '登出',
      ip: ctx.ip,
      device: ctx.userAgent,
    });
  }

  /**
   * 吊销某账号全部会话（F6-02「停用即不可登录」）：
   * 科长停用账号时调用，已在线设备下一次请求即 401。
   */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  /** 会话超时分钟数：读 configs（F4-11 精神——运营口径后台可配，❓ 值待科长确认） */
  async sessionTimeoutMinutes(): Promise<number> {
    const rows = await this.db
      .select({ value: configs.configValue })
      .from(configs)
      .where(eq(configs.configKey, 'session_timeout_minutes'))
      .limit(1);
    const parsed = Number(rows[0]?.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TIMEOUT_MINUTES;
  }

  /** 登录审计（契约 §5：action=login，记设备与 IP，失败也记；C-04 全程留痕） */
  private async writeLoginAudit(
    actorId: number | null,
    reason: string,
    ctx: ClientContext,
  ): Promise<void> {
    await this.db.insert(auditLogs).values({
      actorId,
      action: 'login',
      targetType: 'user',
      targetId: actorId === null ? null : String(actorId),
      reason,
      ip: ctx.ip,
      device: ctx.userAgent,
    });
  }
}
