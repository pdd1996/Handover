import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type {
  AcknowledgePayloadDto,
  AcknowledgeResultDto,
  BackfillPayloadDto,
  ConfirmPayloadDto,
  ConfirmResultDto,
  ObjectionListDto,
  ObjectionPayloadDto,
  ObjectionResultDto,
  PendingListDto,
  PrevDto,
  PreviewDto,
  RecordDetailDto,
  RecordListDto,
  RecordUpdatePayloadDto,
  RecordUpdateResultDto,
  ResubmitPayloadDto,
  ResubmitResultDto,
  SubmitPayloadDto,
  SubmitResultDto,
  TodayDto,
  WithdrawResultDto,
} from '@handover/shared';
import { CurrentUser, Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/auth.service';
import { RecordsService, parseRecordListFilters } from './records.service';

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
   * GET /api/v1/records —— 历史记录筛选（TK-24，契约 §3.5；F6-01 科长半边 + F5-01 共用）。
   *
   * 筛选参数 `from/to/submitter_id/status` 全部可选（非法取值 400 逐条点名，解析单一实现
   * parseRecordListFilters，与 GET /admin/records/export 共用），duty_date 倒序。
   * 角色列「登录用户」→ master/chief 均可（同 GET /records/{id} 口径）：科长后台记录管理页
   * 本轮落地（F6-01），师傅端历史查询界面属 P2/TK-35，接口先行。
   * 路由序：静态段，必须声明在 GET :id 之前（动态段吞并防范，同 today/pending）。
   */
  @Get()
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master', 'chief')
  list(@Query() query: Record<string, string | undefined>): Promise<RecordListDto> {
    return this.records.list(parseRecordListFilters(query));
  }

  /**
   * GET /api/v1/records/pending —— 待确认列表（TK-18，契约 §3.4；F2-02）。
   *
   * 取数口径：**我为 receiver 且 status=submitted**（draft/objection/completed 不产生
   * 待确认入口，D-T18）；响应含逐单标红行数 alert_count，首页据此展示
   * 「有 N 份交接单待确认」醒目入口（N = items.length）。
   *
   * 角色：契约 §3.4 角色列原样 `master`——待确认入口是**接班人**的待办（receiver 恒为
   * 师傅，排班只覆盖 master），不适用「chief 覆盖师傅端只读接口」的回写口径
   * （科长巡查历史单走 GET /records/{id} 与 GET /records）。
   */
  @Get('pending')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  pending(@CurrentUser() user: SessionUser): Promise<PendingListDto> {
    return this.records.pending(user);
  }

  /**
   * GET /api/v1/records/mine/objections —— 我被退回的异议单（TK-20，契约 §3.2；F2-06、F2-13）。
   *
   * 取数口径：**我为 submitter 且 status='objection'**（重提转回 submitted 即从清单消失）。
   * 交班人下次到岗处理的待办清单（F2-13 轮值制：退回时可能已离院，内网无法即时修改）。
   * 路由序：静态段，必须声明在 GET :id 之前（同 today/pending 的动态段吞并防范）。
   *
   * 角色：契约 §3.2 角色列原样 `master`——异议修改是交班人的责任动作（D-P06 留痕责任链）。
   */
  @Get('mine/objections')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  objections(@CurrentUser() user: SessionUser): Promise<ObjectionListDto> {
    return this.records.objections(user);
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

  /**
   * POST /api/v1/records/today/withdraw —— 撤回（TK-21，契约 §3.2；F2-08/F2-09/F2-10）。
   *
   * 交班人提交后 10 分钟内且接班人未确认，可单方撤回本班次交接单回到可编辑（D-P05）；
   * 服务端按当前班次日期（C-08）+ submitter=登录人定位，行锁下校三不可撤条件（超窗口/
   * 已确认/有异议→ 409 WITHDRAW_NOT_ALLOWED 携 reason）；成功转 draft + 清 submitted_at + 同事务
   * 清 alerts/elevator_checks + 审计 record.withdraw；接班人端待确认入口随 status 转 draft 同步消失。
   * 角色：`master`（撤回是交班人单方纠错动作，同 submit 写链路口径，不适用 chief 只读回写）。
   * 路由序：静态段 `today/withdraw`，声明在全部 `:id/xxx` 动态路由之前（同 today/submit 防吞并）。
   */
  @Post('today/withdraw')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  withdraw(@CurrentUser() user: SessionUser): Promise<WithdrawResultDto> {
    return this.records.withdraw(user);
  }

  /**
   * POST /api/v1/records/backfill —— 跨班次补交（TK-16，F3-08-T1 触发载体；决策记录 D-T21）。
   *
   * 上一班记录晚到（离线滞留单被 D-T20 M1 挡在排空引擎外）的合法归宿：payload 显式
   * `duty_date`（须日历合法且严格早于当前班次日期），其余请求体与 /today/submit 同形，
   * 校验/防呆/覆盖/补录协议同口径（submitCore 单一实现）；补交成功后同事务触发下游
   * D+1 已提交记录的用量重算（F3-08，手工覆盖豁免），审计 record.late_submit + record.recalc。
   *
   * 角色：`master, chief`——提交人恒为登录人本人（师傅补交自己漏交的班次，正是滞留单
   * 的归宿）；科长亦可补交自己的班次，代录他人挂 TK-24 处置面板（与 submit 仅 master
   * 的口径差异即在此：补交是「晚到自救」而非当日写链路，2026-09-13 拍板）。
   */
  @Post('backfill')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master', 'chief')
  backfill(
    @CurrentUser() user: SessionUser,
    @Body() payload: BackfillPayloadDto,
  ): Promise<SubmitResultDto> {
    return this.records.backfill(user, payload);
  }

  /**
   * POST /api/v1/records/{id}/acknowledge —— 逐条"已知晓"（TK-19，契约 §3.4；F2-04/DATA-08/DEP-08）。
   *
   * body 传 `alert_ids[]`（shared dto AcknowledgePayloadDto），逐条写 alerts.acknowledged_by/at
   * （响应 `{acknowledged}` = 本次新写入行数，已知晓行不覆盖首次时刻）；仅接班人本人
   * （服务层 403，C-05 实名/D-P06 责任锚点）；跨单/未知 id 忽略（容错同提交侧确认消费）。
   * 角色：`master`——待确认入口是接班人的待办，同 GET /records/pending 口径。
   */
  @Post(':id/acknowledge')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  acknowledge(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() payload: AcknowledgePayloadDto,
  ): Promise<AcknowledgeResultDto> {
    return this.records.acknowledge(user, Number(id), payload);
  }

  /**
   * POST /api/v1/records/{id}/confirm —— 签名归档（TK-19，契约 §3.4；F2-04/F2-05）。
   *
   * body 传签名图 PNG data URL（shared dto ConfirmPayloadDto）；服务端校验全部确认行
   * 已知晓（完整性终校与转 completed 同事务，未逐条知晓 → 409 CONFIRM_INCOMPLETE，
   * F2-04-T1）；成功转 completed + confirmed_at=服务端时刻 + signature_path 落盘落库
   * + 审计 `record.confirm`（契约 §5）；仅接班人本人。角色：`master`（同 acknowledge）。
   */
  @Post(':id/confirm')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  confirm(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() payload: ConfirmPayloadDto,
  ): Promise<ConfirmResultDto> {
    return this.records.confirm(user, Number(id), payload);
  }

  /**
   * POST /api/v1/records/{id}/objection —— 标注异议（TK-20，契约 §3.4；F2-06/D-P06）。
   *
   * body 传 `note`（必填，空白 400 点名、超 500 字 400 越界，shared dto ObjectionPayloadDto）；
   * 行锁下转 objection + objection_at=服务端时刻 + 审计 `record.objection`（契约 §5）。
   * 仅接班人本人（服务层 403，D-P06 责任锚点，与 acknowledge/confirm 同门）；
   * 非 submitted 状态 409 CONFIRM_INCOMPLETE 同族（文案区分）。
   * 角色：`master`（同 acknowledge）。
   */
  @Post(':id/objection')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  objection(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() payload: ObjectionPayloadDto,
  ): Promise<ObjectionResultDto> {
    return this.records.objection(user, Number(id), payload);
  }

  /**
   * PUT /api/v1/records/{id} —— 异议单修改（TK-20，契约 §3.2；F2-07/D-T23）。
   *
   * body 传 `sections`（部分合并语义，shared dto RecordUpdatePayloadDto）：仅上送字段写入、
   * status 仍 objection、version 不变；本版本首次修改时把修改前全字段快照定格入
   * record_versions（F2-07-T1「快照/变更字段/旧值/修改人」）。仅交班人本人（服务层 403）。
   * 角色：`master`。
   */
  @Put(':id')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  updateObjection(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() payload: RecordUpdatePayloadDto,
  ): Promise<RecordUpdateResultDto> {
    return this.records.updateObjectionRecord(user, Number(id), payload);
  }

  /**
   * POST /api/v1/records/{id}/resubmit —— 异议修改后重提（TK-20，契约 §3.2；F2-07/D-T23）。
   *
   * 表单值以 PUT 已写入行的值为准；body 仅可选 confirmations/usage_overrides（防呆 409 与
   * 覆盖协议同 §4，shared dto ResubmitPayloadDto）。重提重走完整校验/防呆/计算，version+1、
   * submitted_at 更新，下游 D+1 已提交单触发重算（复用 recalcDownstream，响应带 recalc）。
   * 仅交班人本人（服务层 403）。角色：`master`。
   */
  @Post(':id/resubmit')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master')
  resubmit(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() payload: ResubmitPayloadDto,
  ): Promise<ResubmitResultDto> {
    return this.records.resubmit(user, Number(id), payload);
  }

  /**
   * GET /api/v1/records/{id} —— 交接单详情（TK-18，契约 §3.4；F2-03、F5-01）。
   *
   * 含全部读数、标红项（alerts，**置顶序**由服务端排好：level high→mid→low、同级按 id，
   * shared ALERT_LEVEL_RANK 单一权威）、电梯核对明细（联字典回显电梯名）、版本与双方
   * 确认信息；接班人逐项浏览与科长历史巡查共用同一视图。
   *
   * 角色：契约 §3.4 角色列「登录用户」→ master/chief 均可（SessionGuard 已鉴登录态）。
   * 路由序：`:id` 为动态段，**必须声明在本控制器全部静态路由之后**（Nest 按声明序匹配，
   * 否则 /records/today、/records/pending 会被吞进 :id）。
   */
  @Get(':id')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('master', 'chief')
  detail(@Param('id') id: string): Promise<RecordDetailDto> {
    // 手工解析而非 ParseIntPipe：非数字 id 也按契约 §2 统一结构返回 404 NOT_FOUND，
    // 不走框架默认 400（错误形状与错误码表不一致）
    return this.records.detail(Number(id));
  }
}
