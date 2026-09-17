import { Injectable } from '@nestjs/common';
import type { MissingSubmitItemDto, MissingSubmitListDto, RecordStatus } from '@handover/shared';
import type { RecordListFilters } from '../records/records.service';
import { RecordsService } from '../records/records.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * 管理后台服务（TK-23 起架、TK-24 扩记录管理）：契约 §3.6 已落地路由的查询/组装层。
 * 记录域取数复用 RecordsService 单一实现（列表筛选、导出取数、批注写入均在 records 模块，
 * admin 仅做后台侧编排——CSV 形态与文件名是后台展示关注点，落在本服务）。
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly records: RecordsService,
  ) {}

  /**
   * GET /admin/missing-submits（F6-06 后台半边，PRD §6.6「科长打开后台 → 显示应提交未提交
   * 提醒（日期 + 排班人）」）：漏交判定复用 NotificationsService.missingSubmitShifts 单一
   * 实现——契约 §3.6「数据源与 missing_submit 通知一致」由此结构保证，视图与扫描永不漂移。
   * 响应按 duty_date 倒序（最近漏交的班次排最前，处置时最急）。
   */
  async missingSubmits(now: Date = new Date()): Promise<MissingSubmitListDto> {
    const rows = await this.notifications.missingSubmitShifts(now);
    const items: MissingSubmitItemDto[] = rows
      .map((r) => ({ duty_date: r.dutyDate, user_id: r.userId, real_name: r.realName }))
      .sort((a, b) => (a.duty_date > b.duty_date ? -1 : a.duty_date < b.duty_date ? 1 : 0));
    return { items };
  }

  // ── GET /admin/records/export：记录导出（F6-01，TK-24；契约订正 28）─────────────

  /** 状态列中文名（与技术方案 §5.4 状态机同义；Phase 1 本地映射，P2 月报（F5-04）统一） */
  private static readonly STATUS_LABELS: Readonly<Record<RecordStatus, string>> = {
    draft: '草稿',
    submitted: '已提交',
    objection: '有异议',
    completed: '已归档',
  };

  /**
   * Phase 1 导出列集（契约订正 28 钉死）：记录标识与状态 + 四项日用量（F3 主结果）+
   * 标红项数 + 科长批注。明细读数不入 CSV——「查看」走 GET /records/{id} 详情，
   * 全列倾倒会让导出文件不可读，正式月报（每日用量明细 + 异常汇总）随 P2 F5-04 细化。
   */
  private static readonly EXPORT_COLUMNS: readonly {
    header: string;
    value: (row: Awaited<ReturnType<RecordsService['exportRows']>>[number]) => string;
  }[] = [
    { header: '交接单号', value: (r) => r.record_no },
    { header: '班次日期', value: (r) => r.duty_date },
    { header: '状态', value: (r) => AdminService.STATUS_LABELS[r.status] },
    { header: '版本', value: (r) => String(r.version) },
    { header: '交班人', value: (r) => r.submitter.real_name },
    { header: '接班人', value: (r) => r.receiver?.real_name ?? '' },
    { header: '提交时刻', value: (r) => r.submitted_at ?? '' },
    { header: '确认时刻', value: (r) => r.confirmed_at ?? '' },
    { header: '水用量', value: (r) => r.water_use ?? '' },
    { header: '电用量', value: (r) => r.e_use ?? '' },
    { header: '天然气用量', value: (r) => r.gas_use ?? '' },
    { header: '液氧日用量', value: (r) => r.lo_day_use ?? '' },
    { header: '标红项数', value: (r) => String(r.alert_count) },
    { header: '科长批注', value: (r) => r.chief_note ?? '' },
  ];

  /**
   * GET /admin/records/export（F6-01「导出」，TK-24）：按与 GET /records 完全相同的筛选参数
   * （parseRecordListFilters 单一实现）取数，组装 **CSV（UTF-8 带 BOM + CRLF）**——
   * BOM 使 Excel 直接打开不乱码（中文表头/批注），契约「CSV/Excel」的 Phase 1 交付即此
   * （Excel 兼容的 CSV；xlsx 生成挂 P2 与正式月报 F5-04 一并评估）。文件名含筛选区间：
   * 同月区间 `records-YYYY-MM.csv`，跨月/自定义区间 `records-{from}_{to}.csv`，无筛选
   * `records-{导出当日}.csv`。
   */
  async recordsExportCsv(
    filters: RecordListFilters,
    now: Date = new Date(),
  ): Promise<{ filename: string; body: string }> {
    const rows = await this.records.exportRows(filters);
    const escape = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    const lines = [
      AdminService.EXPORT_COLUMNS.map((c) => escape(c.header)).join(','),
      ...rows.map((r) => AdminService.EXPORT_COLUMNS.map((c) => escape(c.value(r))).join(',')),
    ];
    return {
      filename: AdminService.exportFilename(filters, now),
      // \uFEFF BOM 在最前，Excel 按带签名 UTF-8 解码
      body: `\uFEFF${lines.join('\r\n')}\r\n`,
    };
  }

  /** 导出文件名（按筛选区间命名，见 recordsExportCsv 注） */
  private static exportFilename(filters: RecordListFilters, now: Date): string {
    const { from, to } = filters;
    if (from !== null && to !== null) {
      if (from.slice(0, 7) === to.slice(0, 7)) return `records-${from.slice(0, 7)}.csv`;
      return `records-${from}_${to}.csv`;
    }
    const today = now.toISOString().slice(0, 10);
    return `records-${today.replaceAll('-', '')}.csv`;
  }
}
