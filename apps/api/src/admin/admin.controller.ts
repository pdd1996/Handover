import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type {
  AnnotationResultDto,
  MissingSubmitListDto,
  UserCreatePayloadDto,
  UserCreateResultDto,
  UserListDto,
  UserStatusPatchPayloadDto,
  UserStatusPatchResultDto,
} from '@handover/shared';
import { CurrentUser, Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/auth.service';
import { parseRecordListFilters, RecordsService } from '../records/records.service';
import { AdminService } from './admin.service';

/**
 * 管理后台路由（TK-23，契约 §3.6 管理后台（科长））：科长专用 PC 后台的服务端入口。
 *
 * **框架口径（本任务的判据「师傅访问后台接口一律 403」，C-05、契约 §1）**：
 * 守卫标在**类级**——@UseGuards(SessionGuard, RolesGuard) + @Roles('chief') 对本控制器
 * 全部方法生效，后续 TK-24~29 的后台控制器一律沿用同一类级三行（勿只在方法级散标），
 * 权限矩阵与路由完备性哨兵见 admin.spec.ts（新挂 /admin 路由未进矩阵即红）。
 * 未登录 401 UNAUTHENTICATED、登录但角色不足（master 访问）403 FORBIDDEN——
 * 与全站鉴权口径同一族错误结构（契约 §2）。
 */
@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
@Roles('chief')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly records: RecordsService,
  ) {}

  /**
   * GET /api/v1/admin/missing-submits —— 应提交未提交视图（F6-06 后台半边）：
   * 当前仍构成漏交的班次集合（日期 + 排班人），数据源与 missing_submit 站内通知同源
   * （NotificationsService.missingSubmitShifts 单一判定：截止在墙钟空间、records 行存在
   * 即不算漏交、窗口 = 当前班次 − backfill_window_days，D-T21 L3）。
   */
  @Get('missing-submits')
  missingSubmits(): Promise<MissingSubmitListDto> {
    return this.admin.missingSubmits();
  }

  /**
   * GET /api/v1/admin/users —— 账号全景（F6-02 查询半边，TK-25；契约 §3.6）：
   * 全量账号 id 升序（= 开通顺序），role/status 列透明；启停操作仅对师傅账号开放
   * （PATCH 侧 chief 目标 403，D-T25 ②）。
   */
  @Get('users')
  usersList(): Promise<UserListDto> {
    return this.admin.usersList();
  }

  /**
   * POST /api/v1/admin/users —— 开通师傅账号（F6-02「开通」，TK-25；D-T25 ①）：
   * 角色恒 master、初始密码 bcrypt 落库、审计 `user.update` 留痕（契约 §5）。
   * 校验/重复名 400 点名等业务口径在 AdminService.userCreate（同 annotate 薄委托纪律）。
   */
  @Post('users')
  userCreate(
    @CurrentUser() user: SessionUser,
    @Body() payload: UserCreatePayloadDto,
  ): Promise<UserCreateResultDto> {
    return this.admin.userCreate(user, payload);
  }

  /**
   * PATCH /api/v1/admin/users/{id} —— 停用/启用（F6-02「停用即不可登录」，TK-25；D-T25 ②③）：
   * 停用与审计同事务、提交后删除该账号全部 sessions 存根（D-T13，已在线设备下一次请求
   * 即 401）；chief 目标 403；值无变化不写审计。
   */
  @Patch('users/:id')
  userPatchStatus(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() payload: UserStatusPatchPayloadDto,
  ): Promise<UserStatusPatchResultDto> {
    return this.admin.userPatchStatus(user, Number(id), payload);
  }

  /**
   * GET /api/v1/admin/records/export —— 记录导出（TK-24，F6-01「导出」；契约订正 28）。
   *
   * 筛选参数与 GET /records 完全同形（from/to/submitter_id/status，解析单一实现
   * parseRecordListFilters）；响应为 **CSV 附件**（UTF-8 带 BOM + CRLF，Excel 直接打开
   * 不乱码），文件名按筛选区间命名（recordsExportCsv 注）。CSV 走 @Res 直写而非 Nest
   * 拦截器序列化——二进制/文本附件非 JSON 业务体，错误仍经统一异常过滤器（400/403 族）。
   * 「按月」为后台界面的默认区间（记录管理页日期范围默认当月），接口层接受任意日历区间。
   */
  @Get('records/export')
  async recordsExport(
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('submitter_id') submitterId?: string,
    @Query('status') status?: string,
  ): Promise<void> {
    const { filename, body } = await this.admin.recordsExportCsv(
      parseRecordListFilters({ from, to, submitter_id: submitterId, status }),
    );
    res
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      })
      .send(body);
  }

  /**
   * POST /api/v1/admin/records/{id}/annotation —— 科长批注（TK-24，F6-01「批注」；D-T24）。
   *
   * 覆盖式单条备注（records.chief_note）：trim 后空串 = 清除，≤500 字；写入/清除/历次
   * 修改以审计 `record.annotate` 留痕（契约 §5）。写入逻辑在 RecordsService.annotate
   * （记录域单一实现，404/400 口径与既有记录路由同族）；本路由仅薄委托 + 类级 chief 守卫。
   */
  @Post('records/:id/annotation')
  annotate(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() payload: { note: string },
  ): Promise<AnnotationResultDto> {
    return this.records.annotate(user, Number(id), payload);
  }
}
