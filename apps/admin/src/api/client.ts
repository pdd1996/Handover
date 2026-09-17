/**
 * 科长后台接口客户端（TK-23）—— 契约 §1 基础路径 `/api/v1`；开发期由 vite proxy 转发到
 * NestJS（:3000），生产由 Nginx 同源反代（技术方案 §2 部署）。
 *
 * 认证走 **HttpOnly Cookie 通道**（契约 §1、决策记录 D-T13，与师傅端 h5 同一口径）：
 * `credentials: 'include'` 让浏览器带上 `handover_sid`，前端代码接触不到令牌。
 * 响应类型取自 `@handover/shared`（与 api 端同一份契约类型，不另写 interface）。
 */
import type {
  AnnotationResultDto,
  ApiError,
  MissingSubmitListDto,
  RecordDetailDto,
  RecordListDto,
  ScheduleMonthDto,
  SchedulePutPayloadDto,
  SchedulePutResultDto,
  UserCreatePayloadDto,
  UserCreateResultDto,
  UserListDto,
  UserStatusPatchPayloadDto,
  UserStatusPatchResultDto,
  UserRole,
} from '@handover/shared';

const BASE = '/api/v1';

/** 当前登录用户（契约 §3.1 GET /auth/me 的返回形状） */
export interface AuthUser {
  id: number;
  real_name: string;
  role: UserRole;
}

/**
 * 服务端按契约 §2 返回的业务错误（C-09：所有 4xx 同一形状）。
 * 科长后台典型场景：master 误登后台时数据接口 403 FORBIDDEN（TK-23 chief 守卫）。
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

/** 网络层失败（服务不可达）——与业务错误严格区分，调用方据此分流（同 h5 评审 M5 口径） */
export class NetworkError extends Error {
  constructor(readonly cause?: unknown) {
    super('网络不可用，请检查院内网络连接');
    this.name = 'NetworkError';
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
  } catch (cause) {
    throw new NetworkError(cause);
  }

  const text = await res.text();
  const body = text === '' ? null : (JSON.parse(text) as unknown);
  if (!res.ok) throw new ApiRequestError(res.status, body as ApiError);
  return body as T;
}

export const api = {
  /** POST /auth/login —— cookie 通道，响应体不含令牌（契约 §3.1）；登录事件服务端记审计（C-05） */
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

  /** GET /auth/me —— 刷新页面后恢复登录态；role ≠ chief 由调用方拒绝进入后台（C-05） */
  me(): Promise<AuthUser> {
    return http('/auth/me');
  },

  /**
   * GET /admin/users —— 账号全景（F6-02 查询半边，契约 §3.6，TK-25）：
   * 全量账号 id 升序（= 开通顺序）；启停仅对师傅账号开放（服务端 chief 目标 403）。
   */
  usersList(): Promise<UserListDto> {
    return http('/admin/users');
  },

  /** POST /admin/users —— 开通师傅账号（F6-02「开通」，TK-25；角色恒 master，D-T25） */
  userCreate(payload: UserCreatePayloadDto): Promise<UserCreateResultDto> {
    return http('/admin/users', { method: 'POST', body: JSON.stringify(payload) });
  },

  /**
   * PATCH /admin/users/{id} —— 停用/启用（F6-02「停用即不可登录」，TK-25）：
   * 服务端停用即删该账号全部会话存根（D-T13）并审计 user.update 新旧值。
   */
  userPatchStatus(
    id: number,
    payload: UserStatusPatchPayloadDto,
  ): Promise<UserStatusPatchResultDto> {
    return http(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },

  /**
   * GET /admin/schedules —— 排班月视图（F6-03，契约 §3.6，TK-26）：
   * ?month=YYYY-MM 缺省当前月，稀疏列示该月排班行（duty_date 升序）。
   */
  schedulesMonth(month?: string): Promise<ScheduleMonthDto> {
    return http(`/admin/schedules${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  },

  /**
   * PUT /admin/schedules —— 单日排班维护（F6-03「改即审计」，契约 §3.6，TK-26）：
   * 单日单条 upsert；同值不写审计；变更审计 schedule.update 新旧值。
   */
  schedulePut(payload: SchedulePutPayloadDto): Promise<SchedulePutResultDto> {
    return http('/admin/schedules', { method: 'PUT', body: JSON.stringify(payload) });
  },

  /**
   * GET /admin/missing-submits —— 应提交未提交视图（F6-06 后台半边，契约 §3.6，TK-23）：
   * 日期 + 排班人，数据源与 missing_submit 站内通知同源；duty_date 倒序。
   */
  missingSubmits(): Promise<MissingSubmitListDto> {
    return http('/admin/missing-submits');
  },

  /**
   * GET /records —— 历史记录筛选（F6-01 科长半边 + F5-01 共用，契约 §3.5，TK-24）。
   * 筛选参数 from/to/submitter_id/status 全部可选（服务端解析，非法 400 点名）；duty_date 倒序。
   */
  recordsList(
    params: { from?: string; to?: string; submitter_id?: string; status?: string } = {},
  ): Promise<RecordListDto> {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
    ).toString();
    return http(`/records${qs ? `?${qs}` : ''}`);
  },

  /** GET /records/{id} —— 交接单详情（F2-03/F5-01 共用视图，契约 §3.4） */
  recordsDetail(id: number): Promise<RecordDetailDto> {
    return http(`/records/${id}`);
  },

  /**
   * POST /admin/records/{id}/annotation —— 科长批注（F6-01「批注」，契约 §3.6，TK-24/D-T24）：
   * 覆盖式单条；空串 = 清除；留痕 audit `record.annotate`。
   */
  annotate(id: number, note: string): Promise<AnnotationResultDto> {
    return http(`/admin/records/${id}/annotation`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  },

  /**
   * GET /admin/records/export —— 记录导出 CSV（F6-01「导出」，契约 §3.6，TK-24）。
   * 响应为 CSV 附件（非 JSON），走独立通道：失败按契约 §2 解析业务错误，成功转 Blob
   * 触发浏览器下载（文件名取 Content-Disposition，由服务端按筛选区间命名）。
   */
  async exportRecords(
    params: { from?: string; to?: string; submitter_id?: string; status?: string } = {},
  ): Promise<void> {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
    ).toString();
    let res: Response;
    try {
      res = await fetch(`${BASE}/admin/records/export${qs ? `?${qs}` : ''}`, {
        credentials: 'include',
      });
    } catch (cause) {
      throw new NetworkError(cause);
    }
    if (!res.ok) {
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = null; // 非 JSON 错误体：保底走状态码分支
      }
      throw new ApiRequestError(res.status, body as ApiError);
    }
    const blob = await res.blob();
    const filename =
      /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'records.csv';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
