import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import {
  clockMinutesOf,
  expectedStatusAt,
  localMeasuredAt,
  type ElevatorExpectedDto,
} from '@handover/shared';
import { DB, type Db } from '../db/db.module';
import { elevators } from '../db/schema';

/**
 * 电梯预期状态服务（TK-17，ELE-02/03/09；D-T22 只读计算不落库）。
 *
 * 预期计算消费 shared `expectedStatusAt`（三端同源纯函数，ELE-03-T1/ELE-09-T1 的单元
 * 权威实现）：always → run、stopped → stop、scheduled → windows 覆盖判定（[start,end)，
 * 支持跨零点）；核对时刻 = 服务端当前时刻（`localMeasuredAt` 同形本地时间戳）。
 * 后台字典维护（ELE-01/ELE-08/ELE-09 写半边）属 TK-28，本服务只读。
 */
@Injectable()
export class ElevatorsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** GET /elevators/expected：在用电梯逐台预期状态（status='active'，id 升序） */
  async expected(now: Date = new Date()): Promise<ElevatorExpectedDto> {
    const rows = await this.db
      .select()
      .from(elevators)
      .where(eq(elevators.status, 'active'))
      .orderBy(asc(elevators.id));
    const checkTime = localMeasuredAt(now);
    const minutes = clockMinutesOf(checkTime.slice(11, 16)) ?? 0;
    return {
      check_time: checkTime,
      elevators: rows.map((r) => ({
        id: r.id,
        name: r.name,
        plan_type: r.planType,
        windows: r.windows ?? null,
        stop_reason: r.stopReason,
        expected: expectedStatusAt({ plan_type: r.planType, windows: r.windows }, minutes),
      })),
    };
  }
}
