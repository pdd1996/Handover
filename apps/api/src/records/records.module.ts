import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsController } from './records.controller';
import { RecordsService } from './records.service';

/**
 * 交接记录模块（TK-05 起）：本轮仅落地契约 §3.2 首条路由 GET /records/today（今日交接首页）。
 *
 * 引入 AuthModule 以复用其导出的 SessionGuard 与 RolesGuard（auth.module.ts 注释即为此预留）。
 * 后续按任务队列扩充本模块路由：TK-07 上一班带出（/records/today/prev）、TK-08 在线草稿
 * （/records/today/draft）、TK-12 预览与提交（/records/today/preview、/submit）、
 * TK-20 异议修改重提（/records/{id}/resubmit）、TK-21 撤回（/records/today/withdraw）。
 */
@Module({
  imports: [AuthModule],
  controllers: [RecordsController],
  providers: [RecordsService],
  exports: [RecordsService],
})
export class RecordsModule {}
