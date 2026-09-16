import { Injectable } from '@nestjs/common';
import type { MissingSubmitItemDto, MissingSubmitListDto } from '@handover/shared';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * 管理后台服务（TK-23）：后台框架期仅承载契约 §3.6 已落地路由的查询组装；
 * TK-24~29 的记录/人员/排班/配置/审计管理随任务队列逐个扩入本模块。
 */
@Injectable()
export class AdminService {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * GET /admin/missing-submits（F6-06 后台半边，PRD §6.6「科长打开后台 → 显示应提交未提交
   * 提醒（日期 + 排班人）」）：漏交判定复用 NotificationsService.missingSubmitShifts 单一
   * 实现——契约 §3.6「数据源与 missing_submit 通知一致」由此结构保证，视图与扫描永不漂移。
   * 响应按 duty_date 倒序（最近漏交的班次排最前，处置时最急）。
   */
  async missingSubmits(now: Date = new Date()): Promise<MissingSubmitListDto> {
    const rows = await this.notifications.missingSubmitShifts(now);
    const items: MissingSubmitItemDto[] = rows
      .map((r) => ({ duty_date: r.dutyDate, user_id: r.userId, real_name: r.realName }))
      .sort((a, b) => (a.duty_date > b.duty_date ? -1 : a.duty_date < b.duty_date ? 1 : 0));
    return { items };
  }
}
