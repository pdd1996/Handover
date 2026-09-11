/**
 * 接口客户端 —— 契约 §1 基础路径 `/api/v1`；开发期由 vite proxy 转发到 NestJS（:3000），
 * 生产由 Nginx 同源反代（技术方案 §2 部署）。
 *
 * 认证走 **HttpOnly Cookie 通道**（契约 §1、决策记录 D-T13）：`credentials: 'include'` 让浏览器
 * 带上 `handover_sid`，前端代码**接触不到令牌**——这正是 cookie 通道的意义（防 XSS 从响应体窃取）。
 * 非浏览器客户端才用 Bearer 通道，与本文件无关。
 *
 * 响应类型全部取自 `@handover/shared` 的 dto 模块：与 api 端产出的是同一份契约类型，
 * 前端不另写 interface（否则两处随迭代漂移）。
 */
import type { ApiError, FormOptionsDto, PrevDto, TodayDto, UserRole } from '@handover/shared';

const BASE = '/api/v1';

/** 当前登录用户（契约 §3.1 GET /auth/me 的返回形状） */
export interface AuthUser {
  id: number;
  real_name: string;
  role: UserRole;
}

/**
 * 服务端按契约 §2 返回的业务错误（C-09：所有 4xx 同一形状）。
 * `missing_fields` 用于报错点名与点击跳转定位——TK-06 落地表单校验时消费。
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body?.message ?? `请求失败（HTTP ${status}）`);
    this.name = 'ApiRequestError';
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // 网络层失败（离线/服务不可达）：不伪造成业务错误，交由上层按离线场景处理（TK-15）
    throw new Error('网络不可用，请检查院内网络连接');
  }

  const text = await res.text();
  const body = text === '' ? null : (JSON.parse(text) as unknown);
  if (!res.ok) throw new ApiRequestError(res.status, body as ApiError);
  return body as T;
}

export const api = {
  /** POST /auth/login —— cookie 通道，响应体不含令牌（契约 §3.1） */
  login(username: string, password: string): Promise<{ user: AuthUser }> {
    return http('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  /** POST /auth/logout —— 删除会话存根，服务端亦不再认可该令牌 */
  logout(): Promise<{ ok: true }> {
    return http('/auth/logout', { method: 'POST' });
  },

  /** GET /auth/me —— 用于刷新页面后恢复登录态 */
  me(): Promise<AuthUser> {
    return http('/auth/me');
  },

  /** GET /records/today —— 今日交接首页汇总（F1-01、F1-02、F1-03） */
  today(): Promise<TodayDto> {
    return http('/records/today');
  },

  /** GET /records/today/prev —— 上一班读数带出（F1-05、F1-15、DATA-02、F3-07；TK-07） */
  prev(): Promise<PrevDto> {
    return http('/records/today/prev');
  },

  /** GET /configs —— 表单选项类配置白名单（DATA-07：hvac_locs 多选 / boiler_list 枚举候选，TK-11） */
  configs(): Promise<FormOptionsDto> {
    return http('/configs');
  },
};
