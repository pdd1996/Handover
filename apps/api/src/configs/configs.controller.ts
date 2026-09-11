import { Controller, Get, UseGuards } from '@nestjs/common';
import { FormOptionsDto } from '@handover/shared';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { ConfigsService } from './configs.service';

/**
 * 配置只读端点（TK-11）：契约 §3.7 GET /configs。
 *
 * 判据：DATA-07-T1（新风候选来自后台配置 → 多选保存 → 数组落库；本轮接口层先行为
 * 「候选与 configs 同步」半边，「数组落库」依赖提交端点 POST /records/today/submit，
 * 复验挂 TK-12 supertest，与 TK-10 的 DATA-05-T1 同模式）。
 *
 * 只读、无写路由：configs 的维护走科长后台（契约 §3.6 GET/PUT /admin/configs，TK-27
 * 配置中心），本端点只服务师傅端表单候选渲染（hvac_locs 多选、boiler_list 枚举）。
 *
 * 守卫顺序与 records.controller.ts 同一口径：先 SessionGuard（未登录 → 401）再
 * RolesGuard（角色不足 → 403）。
 */
@Controller('configs')
export class ConfigsController {
  constructor(private readonly configs: ConfigsService) {}

  /**
   * GET /api/v1/configs —— 表单选项类配置白名单（DATA-07、F1-02 渲染数据源）。
   *
   * 角色：标 `master`（业务使用者为师傅），放宽到 `chief` 的依据与
   * records.controller.ts 相同——契约 §1「chief（科长：全部 + 配置）」天然覆盖。
   */
  @Get()
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master', 'chief')
  formOptions(): Promise<FormOptionsDto> {
    return this.configs.formOptions();
  }
}
