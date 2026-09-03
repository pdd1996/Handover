import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@handover/shared';
import { forbidden } from '../common/api-error';
import { ROLES_KEY } from './decorators';
import type { AuthedRequest } from './session.guard';

/**
 * 角色守卫（C-05 实名制、契约 §1「接口按角色守卫」）：与 SessionGuard 串联——
 * 先鉴权（未登录 → 401 UNAUTHENTICATED）再鉴角色（角色不足 → 403 FORBIDDEN）。
 * 未标注 @Roles 的接口不做角色限制。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const role = req.sessionUser?.role;
    if (!role || !required.includes(role)) throw forbidden();
    return true;
  }
}
