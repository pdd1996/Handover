import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { ApiError } from '@handover/shared';
import { ApiException } from './api-error';

/**
 * 5xx 用的错误码。契约 §2 错误码表只覆盖 4xx（13 项），5xx 尚未登记，
 * 故此处沿用同一响应结构但 code 不在 shared 的 ErrorCode 集合内。
 * 待补登契约后改为 ErrorCode 成员（见任务分解修订记录）。
 */
const INTERNAL_CODE = 'INTERNAL';

type InternalErrorBody = Omit<ApiError, 'code'> & { code: string };

/**
 * 全局异常过滤器：任何异常都统一为《API 契约》§2 的响应结构（C-09「所有 4xx 统一」）。
 * request_id 形如 `req-xxxx`，与响应一同进日志，便于按契约 §2 追踪。
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = `req-${randomUUID()}`;

    // 一、业务异常：本身即契约结构
    if (exception instanceof ApiException) {
      const body = exception.toBody(requestId);
      this.logger.warn(`${requestId} ${body.code} ${body.message}`);
      res.status(exception.getStatus()).json(body);
      return;
    }

    // 二、Nest 内置 HttpException（如路由不存在的 404）：映射到契约结构
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = this.fromHttpException(status, requestId);
      this.logger.warn(`${requestId} HTTP ${status} ${body.message}`);
      res.status(status).json(body);
      return;
    }

    // 三、未知异常：不向客户端泄露内部细节，仅记日志
    this.logger.error(
      `${requestId} 未处理异常`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    const body: InternalErrorBody = {
      code: INTERNAL_CODE,
      message: '服务器内部错误',
      missing_fields: null,
      need_confirm: null,
      request_id: requestId,
    };
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }

  /** 内置异常映射：404 → NOT_FOUND（契约 §2 有对应码），其余状态码按 5xx 兜底 */
  private fromHttpException(status: number, requestId: string): ApiError | InternalErrorBody {
    if (status === HttpStatus.NOT_FOUND) {
      return {
        code: 'NOT_FOUND',
        message: '资源不存在或无权查看',
        missing_fields: null,
        need_confirm: null,
        request_id: requestId,
      };
    }
    return {
      code: INTERNAL_CODE,
      message: `请求被拒绝（HTTP ${status}）`,
      missing_fields: null,
      need_confirm: null,
      request_id: requestId,
    };
  }
}
