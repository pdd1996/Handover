import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { unauthenticated } from '../common/api-error';
import { AuthService, SESSION_COOKIE, type SessionUser } from './auth.service';

/** 鉴权通过后挂到 request 上的字段（logout 需要原令牌来删存根） */
export interface AuthedRequest extends Request {
  sessionUser?: SessionUser;
  sessionToken?: string;
}

/** 从 `Authorization: Bearer <token>` 取令牌（D-T13 非浏览器客户端通道） */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}

/**
 * 会话守卫（D-T13 双通道）：**先查 Authorization 头，再回落 Cookie**，两条路命中同一存根
 * （契约 §1、技术方案 §6）。滑动续期与过期/停用判定都在 resolveSession 内完成。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req.headers.authorization) ?? req.cookies?.[SESSION_COOKIE] ?? null;

    if (!token) throw unauthenticated();

    const user = await this.auth.resolveSession(token);
    if (!user) throw unauthenticated();

    req.sessionUser = user;
    req.sessionToken = token;
    return true;
  }
}
