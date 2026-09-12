import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import type {
  PrevDto,
  PreviewDto,
  SubmitPayloadDto,
  SubmitResultDto,
  TodayDto,
} from '@handover/shared';
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

  /**
   * GET /api/v1/records/today/prev —— 上一班读数带出（TK-07；F1-05、F1-15、DATA-02、F3-07）。
   *
   * 取数口径（服务端，D-T17）：按 C-08 班次日期取**相邻班次**（今日班次日期 − 1 天）的记录，
   * 非 draft（已提交）才带出；相邻日无行（漏交）或为 draft → `prev: null` 且非首班
   * （F3-07 缺失态，前端显 "—" 并允许补录），**不回落更早记录**；首班（今日之前无任何记录）
   * → `first_day: true`（F1-15）。响应形状见 shared `dto.ts PrevDto`。
   *
   * 角色：契约 §3.2 角色列标 `master`，与 GET /records/today 同口径放宽到 `chief`
   * （契约 §1「chief：全部 + 配置」覆盖师傅端只读接口；角色列回写见契约修订记录 5）。
   */
  @Get('today/prev')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master', 'chief')
  prev(): Promise<PrevDto> {
    return this.records.prev();
  }

  /**
   * POST /api/v1/records/today/preview —— 提交前汇总预览（TK-12，F1-10「未填项、异常项一目了然」）。
   *
   * 请求体同 submit（契约 §4），返回未填项与异常项两张清单（结构同契约 §2 missing_fields，
   * C-09 逐条点名 + 锚点跳转）；**只读不落库**，客户端据此弹窗展示、点击定位。
   *
   * 角色：写链路辅助端点，与 submit 同取 `master`（契约订正 4「chief：全部 + 配置」的
   * 回写仅限只读接口；提交链路是否覆盖 chief 待后台权限任务落地时按同一口径回写）。
   */
  @Post('today/preview')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  preview(@Body() payload: SubmitPayloadDto): Promise<PreviewDto> {
    return this.records.preview(payload);
  }

  /**
   * POST /api/v1/records/today/submit —— 正式提交（TK-12，契约 §4 提交协议；F2-01/DATA-09/10/13）。
   *
   * 处理顺序与挂账对照见 RecordsService.submit 注：校验 →（防呆 TK-14）→（用量固化 TK-13）
   * → 转 submitted + record_no + submitted_at 服务端时刻 → 审计留痕（含接班人修改原因）。
   * 角色：`master`（提交是师傅端写操作，契约 §3.2 角色列原样，不适用 chief 只读回写口径）。
   */
  @Post('today/submit')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  submit(
    @CurrentUser() user: SessionUser,
    @Body() payload: SubmitPayloadDto,
  ): Promise<SubmitResultDto> {
    return this.records.submit(user, payload);
  }
}
