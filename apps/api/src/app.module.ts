import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { ApiErrorFilter } from './common/api-error.filter';
import { ConfigsModule } from './configs/configs.module';
import { DbModule } from './db/db.module';
import { RecordsModule } from './records/records.module';

/**
 * 根模块。TK-01 脚手架期仅挂载健康检查；TK-04 接入数据库（DbModule 全局单例）与认证；
 * TK-05 接入交接记录（今日交接首页）；TK-11 接入配置只读（表单选项白名单，DATA-07）。
 * 后续按技术方案 §3 模块划分逐个接入（排班、用量计算、预警、电梯、配置中心全量、附件、审计）。
 */
@Module({
  imports: [DbModule, AuthModule, RecordsModule, ConfigsModule],
  controllers: [AppController],
  // 全局异常过滤器：任何异常都统一为《API 契约》§2 的 ApiError 结构（C-09）
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}
