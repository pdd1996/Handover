import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import type { UserRole } from '@handover/shared';
import { ApiException } from '../common/api-error';
import {
  AuthService,
  SESSION_COOKIE,
  type ClientContext,
  type LoginChannel,
  type SessionUser,
} from './auth.service';
import { CurrentUser } from './decorators';
import { SessionGuard, type AuthedRequest } from './session.guard';

/** 契约 §3.1 GET /auth/me 的返回形状（蛇形命名与契约一致） */
export interface AuthUserDto {
  id: number;
  real_name: string;
  role: UserRole;
}

export interface LoginResponseDto {
  user: AuthUserDto;
  /** 仅 `channel=bearer` 返回；cookie 通道响应体不含令牌（契约 §3.1：防 XSS 从响应体窃取） */
  token?: string;
}

/** 登录请求体（契约 §3.1）：channel 缺省为 cookie */
interface LoginBody {
  username?: unknown;
  password?: unknown;
  channel?: unknown;
}

function toDto(user: SessionUser): AuthUserDto {
  return { id: user.id, real_name: user.realName, role: user.role };
}

/**
 * 客户端上下文（C-05 登录设备记审计）：IP 取 req.ip——`TRUST_PROXY=true` 时 Express 已按
 * X-Forwarded-For 解析出真实客户端地址（见 configureApp），直连/开发环境则取 socket 地址，
 * 避免无条件信任可伪造的请求头污染审计。
 */
function clientContext(req: Request): ClientContext {
  return { ip: req.ip ?? req.socket.remoteAddress ?? null, userAgent: req.headers['user-agent'] ?? null };
}

/** Cookie 下发选项（技术方案 §6：HttpOnly + SameSite=Lax；内网生产启用 HTTPS） */
function cookieOptions(maxAgeMinutes: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeMinutes * 60_000,
  };
}

/** 清除 Cookie 须与下发时的 path/sameSite/secure 一致，否则浏览器不认 */
function clearCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

/**
 * 认证接口（TK-04）：契约 §3.1 三条路由，基础路径 /api/v1（§1，由 main.ts 设全局前缀）。
 * 判据：F1-11-T1（正确账密建会话）、F1-11-T2（错误密码拒绝且不泄露账号存在性）、
 * F1-11-T3（停用账号提示停用而非报错）。
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** POST /api/v1/auth/login —— 公开；成功建会话并写审计（设备、IP），失败也记（契约 §5） */
  @Post('login')
  // NestJS 的 POST 默认 201；登录不是创建资源，统一用 200
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      // 账号/密码不属 records 字段字典，无法用 missing_fields 点名，故仅给文案（C-09 的点名机制针对表单字段）
      throw new ApiException('VALIDATION_MISSING_FIELDS', '请输入账号与密码');
    }

    const channel: LoginChannel = body?.channel === 'bearer' ? 'bearer' : 'cookie';
    // timeoutMinutes 由 login 返回，避免本处再查一次 configs（两处取值可能因配置变更而漂移）
    const { user, token, timeoutMinutes } = await this.auth.login(
      { username, password, channel },
      clientContext(req),
    );

    if (channel === 'cookie') {
      res.cookie(SESSION_COOKIE, token, cookieOptions(timeoutMinutes));
      return { user: toDto(user) };
    }
    return { user: toDto(user), token };
  }

  /** POST /api/v1/auth/logout —— 删除存根行，服务端不再认可该令牌；写审计 */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.auth.logout(req.sessionToken ?? null, clientContext(req));
    res.clearCookie(SESSION_COOKIE, clearCookieOptions());
    return { ok: true };
  }

  /** GET /api/v1/auth/me —— 返回当前用户与角色（Cookie 与 Bearer 两通道均可） */
  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: SessionUser): AuthUserDto {
    return toDto(user);
  }
}
