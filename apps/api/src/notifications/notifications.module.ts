import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsModule } from '../records/records.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsScheduler } from './notifications.scheduler';
import { NotificationsService } from './notifications.service';

/**
 * 站内通知模块（TK-22）：
 * - 读侧契约 §3.5 两行路由（GET /notifications、POST /notifications/{id}/read，DEP-04）；
 * - 写侧服务端定时任务四件（F2-11 确认超时 / F2-12 异议升级 / F6-06 漏交扫描 /
 *   会话过期清理），扫描本体时间可注入、调度器只喂系统时钟。
 *
 * 引入 RecordsModule 复用 resolveDutyDate/backfillWindowDays（C-08 班次分界与补交窗口的
 * 单一实现——F6-06 扫描窗口下界必须与补交窗口同源，勿另写日历推算）；引入 AuthModule
 * 复用 SessionGuard（同 records.module 既有口径）。
 */
@Module({
  imports: [AuthModule, RecordsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsScheduler],
  exports: [NotificationsService],
})
export class NotificationsModule {}
