import { Controller, Get, UseGuards } from '@nestjs/common';
import type { TodayDto } from '@handover/shared';
import { CurrentUser, Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/auth.service';
import { RecordsService } from './records.service';

/**
 * 今日交接接口（TK-05）：契约 §3.2 首条路由，基础路径 /api/v1（§1，由 main.ts 设全局前缀）。
 * 判据：F1-01-T1（一天一条记录）、F1-02-T1/T2（12 张卡按点位组织、板块间无字段串扰）、
 * F1-03-T1（角标与顶部进度条实时汇总已填/待填/异常）。
 *
 * 守卫顺序：先 SessionGuard 鉴权（未登录 → 401 UNAUTHENTICATED）再 RolesGuard 鉴角色
 * （角色不足 → 403 FORBIDDEN），与契约 §3.1 末尾的统一口径一致。
 */
@Controller('records')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  /**
   * GET /api/v1/records/today —— 首页卡片汇总（F1-01、F1-02、F1-03）。
   *
   * 角色：契约 §3.2 角色列标 `master`（业务使用者为师傅），此处放宽到 `chief` 的依据是
   * 契约 §1「`chief`（科长：全部 + 配置）」——科长权限天然覆盖师傅端接口，便于巡查当日填写进度；
   * 与 `auth/decorators.ts` 既有口径（"师傅端接口 @Roles('master','chief')"）一致。
   *
   * **只读**：当日无记录时返回 `record: null` 与 12 张全待填的卡片，不创建 draft 行
   * （理由见 RecordsService 头部说明：record_no 提交时才生成、技术方案 §11 draft 时机未关闭、种子 D0 刻意留空）。
   */
  @Get('today')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master', 'chief')
  today(@CurrentUser() user: SessionUser): Promise<TodayDto> {
    return this.records.today(user);
  }
}
