import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ElevatorsController } from './elevators.controller';
import { ElevatorsService } from './elevators.service';

/**
 * 电梯模块（TK-17）：本轮仅落地契约 §3.3 首条路由 GET /elevators/expected（只读计算，
 * D-T22）。核对结果的落库载体在 records 模块 submitCore（payload `elevator_checks[]`，
 * 同事务写 elevator_checks + alerts 标红），本模块不感知提交链路。
 * 后台字典维护（ELE-01/ELE-08，/admin/elevators）随 TK-28 接入本模块。
 */
@Module({
  imports: [AuthModule],
  controllers: [ElevatorsController],
  providers: [ElevatorsService],
})
export class ElevatorsModule {}
