import { Module } from '@nestjs/common';
import { AppController } from './app.controller';

/**
 * 根模块。TK-01 脚手架期仅挂载健康检查；
 * 后续按技术方案 §3 模块划分逐个接入（认证、排班、交接记录、用量计算、预警、电梯、配置、附件、审计）。
 */
@Module({
  controllers: [AppController],
})
export class AppModule {}
