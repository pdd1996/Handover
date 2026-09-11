/**
 * C-08 班次日期口径的唯一实现（TK-05 抽取自 records.service.ts，供 seed.ts 复用）。
 *
 * 「记录日期 = 班次起始日，非提交日」：24 小时班跨两个自然日，当地时刻早于 `shift_start_time`
 * 时仍在前一班次内（如 09-03 02:00 在地下表房抄表，属 09-02 那一班），duty_date 取昨日。
 * 台账 C-08 的验收方式即「跨天用例（23:59 当班、次日提交）」。
 *
 * 独立为纯模块的原因：seed.ts（tsx 直跑脚本）与 service 必须用**同一份**分界逻辑——
 * 否则凌晨窗口灌种子时 D0（自然日"今日"）与 service 算出的 duty_date（昨日）错位，
 * 测试"当日无记录"用例会撞上种子 D-1 的记录（TK-05 核对时实际发生，见《开发种子数据》修订 #5）。
 */

/**
 * 班次时刻所在的时区。**显式指定而不依赖服务器 TZ**：数据库连接为 `timezone: 'Z'`（UTC），
 * 若按 UTC 判分界，北京时间 10:00（= UTC 02:00）会被误判为"早于 08:30"而归到昨日班次。
 * 内网服务器时区未必为东八区（技术方案 §9 服务器资源待信息科确认），故此处钉死并可用 env 覆盖。
 */
export const SHIFT_TIMEZONE = process.env.SHIFT_TIMEZONE ?? 'Asia/Shanghai';

/** configs.shift_start_time 缺失或非法时的兜底（种子值 08:30，❓ 待科长确认，台账待确认清单第 8 项） */
export const DEFAULT_SHIFT_START = '08:30';

/**
 * 当地日历日减一天（按 UTC 算，避开夏令时导致的 23/25 小时日）。
 * 导出供带出取数（TK-07/D-T17：上一班 = 今日班次日期 − 1 天）与测试哨兵复用，
 * 勿在消费方另写日历推算（同班次分界口径的防漂移纪律）。
 */
export function minusOneDay(date: string): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCHours(t.getUTCHours() - 24);
  return t.toISOString().slice(0, 10);
}

/**
 * 取指定时区的当地日历日与当日分钟数。
 * 用 `hourCycle: 'h23'` 而非 `hour12: false`——后者在部分 ICU 下把午夜给成 `24:00`，会使分界判定错位。
 */
function localParts(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** 'HH:MM' → 当日分钟数；非法则回落兜底值 */
function parseClock(value: string, fallback: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return parseClock(fallback, '00:00');
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 解析 now 所在班次的起始日（C-08）。shiftStart 为班次分界时刻 'HH:MM'
 * （service 侧来自 configs，seed 侧用 DEFAULT_SHIFT_START 与 configs 种子值同源）。
 */
export function shiftDutyDate(now: Date, shiftStart: string): string {
  const { date, minutes } = localParts(now, SHIFT_TIMEZONE);
  return minutes < parseClock(shiftStart, DEFAULT_SHIFT_START) ? minusOneDay(date) : date;
}
