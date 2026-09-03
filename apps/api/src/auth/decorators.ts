import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { UserRole } from '@handover/shared';
import { unauthenticated } from '../common/api-error';
import type { AuthedRequest } from './session.guard';
import type { SessionUser } from './auth.service';

/** @Roles 元数据键 */
export const ROLES_KEY = 'handover:roles';

/**
 * 标注接口所需角色（契约 §1「接口按角色守卫」）。
 * 例：科长后台接口 `@Roles('chief')`；师傅端接口 `@Roles('master','chief')`。
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * 取当前登录用户（由 SessionGuard 挂载）。
 * 用法：`me(@CurrentUser() user: SessionUser)` 或 `@CurrentUser('id') id: number`。
 */
export const CurrentUser = createParamDecorator(
  (data: keyof SessionUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = req.sessionUser;
    if (!user) throw unauthenticated();
    return data ? user[data] : user;
  },
);
