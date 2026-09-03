import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { ApiErrorFilter } from './common/api-error.filter';
import { DbModule } from './db/db.module';

/**
 * 根模块。TK-01 脚手架期仅挂载健康检查；TK-04 起接入数据库（DbModule 全局单例）与认证。
 * 后续按技术方案 §3 模块划分逐个接入（排班、交接记录、用量计算、预警、电梯、配置、附件、审计）。
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [AppController],
  // 全局异常过滤器：任何异常都统一为《API 契约》§2 的 ApiError 结构（C-09）
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}
