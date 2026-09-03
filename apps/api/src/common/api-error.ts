import { HttpException } from '@nestjs/common';
import {
  ERROR_HTTP_STATUS,
  type ApiError,
  type ErrorCode,
  type MissingField,
  type NeedConfirm,
} from '@handover/shared';

export interface ApiExceptionOptions {
  /** 缺失/越界字段逐条点名（C-09）；非缺失类错误留空即 null */
  missingFields?: MissingField[] | null;
  /** 防呆/安全阀待确认清单（契约 §4）；否则 null */
  needConfirm?: NeedConfirm;
}

/**
 * 业务异常：抛出即按《API 契约》§2 的统一结构响应（C-09 落地）。
 *
 * HTTP 状态取自 shared 的 `ERROR_HTTP_STATUS`（契约 §2 错误码表首列），
 * 杜绝各处硬编码状态码与错误码不一致。
 */
export class ApiException extends HttpException {
  readonly code: ErrorCode;
  readonly missingFields: MissingField[] | null;
  readonly needConfirm: NeedConfirm;

  constructor(code: ErrorCode, message: string, options: ApiExceptionOptions = {}) {
    super(message, ERROR_HTTP_STATUS[code]);
    this.code = code;
    this.missingFields = options.missingFields ?? null;
    this.needConfirm = options.needConfirm ?? null;
  }

  /** 组装契约 §2 响应体（request_id 由 ApiErrorFilter 注入） */
  toBody(requestId: string): ApiError {
    return {
      code: this.code,
      message: this.message,
      missing_fields: this.missingFields,
      need_confirm: this.needConfirm,
      request_id: requestId,
    };
  }
}

/** 401：未登录 / 会话过期 / 已登出 / 账号被停用 */
export const unauthenticated = (message = '未登录或会话已过期'): ApiException =>
  new ApiException('UNAUTHENTICATED', message);

/** 403：角色不足（师傅访问后台等，C-05） */
export const forbidden = (message = '角色不足，无法访问该资源'): ApiException =>
  new ApiException('FORBIDDEN', message);
