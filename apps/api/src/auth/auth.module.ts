import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RolesGuard } from './roles.guard';
import { SessionGuard } from './session.guard';

/**
 * 认证模块（TK-04）：契约 §3.1 三条路由 + 会话守卫 + 角色守卫。
 *
 * 守卫对外导出，供 TK-05 起的业务模块复用——凡需登录的接口挂 SessionGuard，
 * 需科长权限的再叠 @Roles('chief') + RolesGuard。
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionGuard, RolesGuard],
  exports: [AuthService, SessionGuard, RolesGuard],
})
export class AuthModule {}
