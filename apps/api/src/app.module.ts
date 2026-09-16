import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { ApiErrorFilter } from './common/api-error.filter';
import { ConfigsModule } from './configs/configs.module';
import { DbModule } from './db/db.module';
import { ElevatorsModule } from './elevators/elevators.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RecordsModule } from './records/records.module';

/**
 * 根模块。TK-01 脚手架期仅挂载健康检查；TK-04 接入数据库（DbModule 全局单例）与认证；
 * TK-05 接入交接记录（今日交接首页）；TK-11 接入配置只读（表单选项白名单，DATA-07）；
 * TK-17 接入电梯预期状态只读端点（GET /elevators/expected，D-T22）；
 * TK-22 接入站内通知（契约 §3.5）与服务端定时任务四件（ScheduleModule 官方调度，
 * 扫描本体时间可注入、测试静默，见 notifications.scheduler.ts）。
 * 后续按技术方案 §3 模块划分逐个接入（排班、预警、配置中心全量、附件、审计）。
 */
@Module({
  imports: [
    DbModule,
    AuthModule,
    RecordsModule,
    ConfigsModule,
    ElevatorsModule,
    NotificationsModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  // 全局异常过滤器：任何异常都统一为《API 契约》§2 的 ApiError 结构（C-09）
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}
