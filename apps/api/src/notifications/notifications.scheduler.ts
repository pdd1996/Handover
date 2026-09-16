import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';

/**
 * 定时任务调度器（TK-22）：@nestjs/schedule（技术方案 §2 选型理由「官方定时任务」）
 * 按固定间隔轮询 NotificationsService 的四个扫描；四个扫描全部**时间可注入**且自带去重，
 * 轮询只负责「以系统时钟喂 now」，间隔 granular 度不影响正确性：
 *
 * - confirm_due 每 5 分钟（F2-11 阈值默认 2 小时，5 分钟粒度足够；去重防重发）
 * - objection_escalated 每 30 分钟（F2-12 防重复 = escalated_at 原子闸门）
 * - missing_submit 每 30 分钟（F6-06 过点即扫，同班次去重防重发）
 * - sessions 清理每 60 分钟（技术方案 §6 运维卫生）
 *
 * **测试静默**：接口测试以构造时刻直调扫描（「定时」层判据），不依赖也不容忍真实轮询——
 * jest 环境下各 tick 直接空转（NODE_ENV/JEST_WORKER_ID 双闸，防手工设 NODE_ENV 漏网）。
 * 间隔全部 ≥ 1 分钟，正常用例时长内本就不会触发，双保险防跨用例污染。
 */
@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);

  constructor(private readonly jobs: NotificationsService) {}

  private inTest(): boolean {
    return process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
  }

  private async safe(label: string, run: () => Promise<number>): Promise<void> {
    try {
      const n = await run();
      if (n > 0) this.logger.log(`${label}: 新建/清理 ${n} 条`);
    } catch (err) {
      // 定时任务失败不得击穿进程：记日志等下一轮（扫描幂等，下轮自动补齐）
      this.logger.error(`${label} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  @Interval('confirm-due-scan', 5 * 60_000)
  tickConfirmDue(): void {
    if (this.inTest()) return;
    void this.safe('F2-11 确认超时扫描', () => this.jobs.runConfirmDueScan(new Date()));
  }

  @Interval('objection-escalation-scan', 30 * 60_000)
  tickObjectionEscalation(): void {
    if (this.inTest()) return;
    void this.safe('F2-12 异议升级扫描', () => this.jobs.runObjectionEscalationScan(new Date()));
  }

  @Interval('missing-submit-scan', 30 * 60_000)
  tickMissingSubmit(): void {
    if (this.inTest()) return;
    void this.safe('F6-06 漏交扫描', () => this.jobs.runMissingSubmitScan(new Date()));
  }

  @Interval('sessions-cleanup', 60 * 60_000)
  tickSessionsCleanup(): void {
    if (this.inTest()) return;
    void this.safe('会话过期清理', () => this.jobs.runSessionsCleanup(new Date()));
  }
}
