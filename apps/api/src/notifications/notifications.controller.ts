import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { NotificationListDto, NotificationReadResultDto } from '@handover/shared';
import { CurrentUser } from '../auth/decorators';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/auth.service';
import { ApiException } from '../common/api-error';
import { NotificationsService } from './notifications.service';

/**
 * 站内通知接口（TK-22）：契约 §3.5 两行路由，基础路径 /api/v1。
 * 判据：F2-11-T1 / F2-12-T1 / F6-06-T1 的通知经本端点可查（未读角标数据源，DEP-04）。
 *
 * 角色：契约 §3.5 角色列为「登录用户」（师傅与科长都收通知），仅 SessionGuard 鉴权、
 * 不设 @Roles（RolesGuard 对无标注路由本就放行，与 auth/decorators 既有口径一致）。
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** GET /api/v1/notifications —— 当前登录人未读通知 + 未读总数（权威形状 shared `NotificationListDto`） */
  @Get()
  @UseGuards(SessionGuard)
  list(@CurrentUser() user: SessionUser): Promise<NotificationListDto> {
    return this.notifications.list(user.id);
  }

  /**
   * POST /api/v1/notifications/{id}/read —— 标记已读（幂等：已读回首次时刻）。
   * id 手工解析而非 ParseIntPipe：非数字 id 也按契约 §2 统一结构返回 404 NOT_FOUND
   * （同 GET /records/{id} 既有口径）；非本人通知 404，不泄露存在性。
   */
  @Post(':id/read')
  @UseGuards(SessionGuard)
  async markRead(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
  ): Promise<NotificationReadResultDto> {
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0)
      throw new ApiException('NOT_FOUND', '通知不存在或无权操作');
    return this.notifications.markRead(user.id, nid);
  }
}
