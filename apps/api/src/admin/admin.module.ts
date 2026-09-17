import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecordsModule } from '../records/records.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * 管理后台模块（TK-23 起架、TK-24 扩记录管理）：M4 科长后台的服务端框架——契约 §3.6 各
 * 路由随 TK-24~29 逐个落入本模块（记录管理 / 人员 / 排班 / 配置中心 / 电梯字典 / 审计查询），
 * 守卫口径见 admin.controller.ts 类级标注（SessionGuard + RolesGuard + @Roles('chief')）。
 *
 * 引入 AuthModule 复用 SessionGuard/RolesGuard（同 records.module 既有口径）；
 * 引入 NotificationsModule 复用漏交判定 missingSubmitShifts（F6-06 视图与扫描单一实现，
 * 契约 §3.6「数据源与 missing_submit 通知一致」）；引入 RecordsModule 复用记录域
 * 单一实现（TK-24 批注写入与导出取数，记录路由与后台导出永不两套口径）。
 */
@Module({
  imports: [AuthModule, NotificationsModule, RecordsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
