import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ElevatorExpectedDto } from '@handover/shared';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { ElevatorsService } from './elevators.service';

/**
 * 电梯字典与核对接口（TK-17）：契约 §3.3 首条路由 GET /api/v1/elevators/expected。
 *
 * **D-T22（2026-09-14 拍板）**：本端点为**只读计算**——按服务端当前时刻逐台计算预期状态
 * 返回（ELE-03），**不生成 elevator_checks 明细行**：原契约「服务端按当前时刻计算并生成
 * 明细行」的写副作用与 D-T15/D-T18 同族冲突（elevator_checks.record_id NOT NULL，而 records
 * 行按 D-T18 提交时才创建，提交前无行可挂）。核对结果的落库载体 = 提交 payload
 * `elevator_checks[]`（submitCore 同事务写入并按上送 check_time 锁定，ELE-05）。
 *
 * 守卫顺序：先 SessionGuard 鉴权再 RolesGuard 鉴角色（与 records.controller 同一口径）。
 */
@Controller('elevators')
export class ElevatorsController {
  constructor(private readonly elevators: ElevatorsService) {}

  /**
   * GET /api/v1/elevators/expected —— 当前时刻逐台预期状态（ELE-03；TK-17）。
   *
   * 角色：契约 §3.3 角色列标 `master`，与 GET /records/today、/records/today/prev 同口径
   * 放宽到 `chief`（契约 §1「chief：全部 + 配置」覆盖师傅端只读接口，科长巡查可预览；
   * 角色列回写见契约订正 20）。
   */
  @Get('expected')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master', 'chief')
  expected(): Promise<ElevatorExpectedDto> {
    return this.elevators.expected();
  }
}
