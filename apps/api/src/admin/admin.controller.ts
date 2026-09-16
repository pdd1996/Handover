import { Controller, Get, UseGuards } from '@nestjs/common';
import type { MissingSubmitListDto } from '@handover/shared';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { AdminService } from './admin.service';

/**
 * 管理后台路由（TK-23，契约 §3.6 管理后台（科长））：科长专用 PC 后台的服务端入口。
 *
 * **框架口径（本任务的判据「师傅访问后台接口一律 403」，C-05、契约 §1）**：
 * 守卫标在**类级**——@UseGuards(SessionGuard, RolesGuard) + @Roles('chief') 对本控制器
 * 全部方法生效，后续 TK-24~29 的后台控制器一律沿用同一类级三行（勿只在方法级散标），
 * 权限矩阵与路由完备性哨兵见 admin.spec.ts（新挂 /admin 路由未进矩阵即红）。
 * 未登录 401 UNAUTHENTICATED、登录但角色不足（master 访问）403 FORBIDDEN——
 * 与全站鉴权口径同一族错误结构（契约 §2）。
 */
@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
@Roles('chief')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /**
   * GET /api/v1/admin/missing-submits —— 应提交未提交视图（F6-06 后台半边）：
   * 当前仍构成漏交的班次集合（日期 + 排班人），数据源与 missing_submit 站内通知同源
   * （NotificationsService.missingSubmitShifts 单一判定：截止在墙钟空间、records 行存在
   * 即不算漏交、窗口 = 当前班次 − backfill_window_days，D-T21 L3）。
   */
  @Get('missing-submits')
  missingSubmits(): Promise<MissingSubmitListDto> {
    return this.admin.missingSubmits();
  }
}
