/**
 * 电梯核对 —— 三端同源纯函数与校验（TK-17）。
 *
 * 出处：PRD §6.7 电梯时段核对设计；台账 ELE-02（运行计划三选一）/ ELE-03（按核对时刻
 * 计算预期状态）/ ELE-04（一致一键确认、不一致必填说明）/ ELE-05（预期以核对时刻锁定，
 * 提交时不重算）/ ELE-06（预期停运实际运行 → 标红）/ ELE-07（预期运行实际停运无说明 →
 * 拦截点名）/ ELE-09（跨零点时段）；决策记录 D-P15 / D-P16 与 **D-T22**（2026-09-14 拍板：
 * ① 核对结果随提交 payload `elevator_checks[]` 在 submitCore 同事务落库——GET /elevators/expected
 * 改只读计算不落库（elevator_checks.record_id NOT NULL，提交前无 records 行可挂，写副作用
 * 已被 D-T15/D-T18 同族否决）；② 服务端按 payload 上送的 **check_time（核对时刻）重算
 * expected** 落库——「提交时不重算」= 不按提交时刻重算（D-P16 字面），客户端 expected 仅为
 * 展示留痕；③ 任一不一致（actual ≠ match）写 alerts 标红行，level=mid（ELE-06 P1 标红）。
 *
 * 判定函数无 IO、无框架依赖：h5 打开电梯卡的展示判定、api 提交校验与落库、离线预检
 * （sync-queue 同口径，TK-15 M6 纪律）消费同一实现，杜绝两端各算一套。
 */

import type { MissingField } from './errors';
import { toElevatorMissingField } from './errors';
import { isValidLocalTimestamp } from './calc';
import { ElevatorCheckActual, type ElevatorPlanType } from './enums';

/**
 * 预期状态（elevator_checks.expected mysqlEnum）。
 * 运行计划类型与核对结果枚举不在此重立：`ElevatorPlanType` / `ElevatorCheckActual`
 * 以 enums.ts（TK-03）为单一来源（本模块 `ElevatorActual` 为其同义别名）。
 */
export type ElevatorExpected = 'run' | 'stop';

/** 核对结果（elevator_checks.actual；run/stop = 与预期相反，fault = 故障） */
export type ElevatorActual = ElevatorCheckActual;

/** 运行计划的判定形态（elevators 行子集；windows 为 DB JSON 原始值，合法性由 parseWindowsOf 判定） */
export interface ElevatorPlanLike {
  readonly plan_type: ElevatorPlanType;
  readonly windows: unknown;
}

/**
 * 解析 windows JSON（§4.2 形态如 `[["06:00","22:00"]]`，支持多窗口与跨零点 `["22:00","06:00"]`，
 * ELE-09）为分钟区间数组。非法形态（非数组 / 元素非二元数组 / 时刻非法）→ null（脏配置，
 * 由调用方决定回落口径——expectedStatusAt 回落 run，不阻塞核对）。
 */
export function parseWindowsOf(windows: unknown): Array<readonly [number, number]> | null {
  if (!Array.isArray(windows)) return null;
  const parsed: Array<readonly [number, number]> = [];
  for (const w of windows) {
    if (!Array.isArray(w) || w.length !== 2) return null;
    const start = clockMinutesOf(String(w[0]));
    const end = clockMinutesOf(String(w[1]));
    if (start === null || end === null) return null;
    parsed.push([start, end]);
  }
  return parsed;
}

/** 'HH:mm' → 当日分钟数（0–1439）；非法 → null */
export function clockMinutesOf(time: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 预期状态计算（**ELE-03-T1 / ELE-09-T1 的单元权威实现**）：
 * - `always` → run；`stopped` → stop（24 小时 / 长期停运两分支，ELE-02）；
 * - `scheduled` → windows 覆盖判定：区间 **[start, end)**（起含止不含：06:00–22:00 在 22:00
 *   整即停运——PRD §6.7 示例「23:00 打开 → 预期停运」的反向边界取保守口径）；支持多窗口；
 *   **跨零点**（start > end，如 22:00–06:00）按 `t ≥ start 或 t < end` 判定（ELE-09-T1：
 *   23:00 → 运行、07:00 → 停运）；start === end 为零长度窗口 → 全天停运（[start,end)
 *   语义的自然结果）；
 * - 脏配置（windows 缺失/空/非法）→ 回落 'run'：配置缺失不放大为满屏「预期停运」
 *   （与 TK-11 脏配置回落占位同精神，不阻塞核对；后台修复配置即生效），注释留痕不另立规格。
 */
export function expectedStatusAt(plan: ElevatorPlanLike, minutes: number): ElevatorExpected {
  if (plan.plan_type === 'always') return 'run';
  if (plan.plan_type === 'stopped') return 'stop';
  const windows = parseWindowsOf(plan.windows);
  if (windows === null || windows.length === 0) return 'run';
  for (const [start, end] of windows) {
    const inWindow =
      start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    if (inWindow) return 'run';
  }
  return 'stop';
}

/**
 * 核对时刻（`YYYY-MM-DD HH:mm:ss` 本地时间戳，D-P12 同口径：核对事实发生在本机，本机
 * 时间戳即唯一权威）→ 时钟部分的当日分钟数。日历有效性由 `isValidLocalTimestamp` 校验，
 * 本函数仅取时钟分量（调用方须先过格式校验）。
 */
export function checkTimeMinutesOf(checkTime: string): number | null {
  return clockMinutesOf(checkTime.slice(11, 16));
}

/** 逐台核对结果 payload（契约 §4 提交协议 `elevator_checks[]`；D-T22） */
export interface ElevatorCheckPayload {
  /** elevators.id */
  elevator_id: number;
  /** 核对时刻（本机本地时间戳；服务端据此重算 expected 落库，ELE-05/D-T22） */
  check_time: string;
  /** 客户端在核对时刻看到的预期（仅展示留痕；落库值以服务端按 check_time 重算为准） */
  expected: ElevatorExpected;
  actual: ElevatorActual;
  /** 不一致必填说明（ELE-04/ELE-07；落 elevator_checks.explanation 即留痕，§4.2 varchar(300)） */
  explanation?: string | null;
}

/** actual 合法枚举（与 schema mysqlEnum 逐项同源；越值走 outOfRange 点名防 MySQL 500） */
export const ELEVATOR_ACTUALS: readonly ElevatorActual[] = ElevatorCheckActual;

/**
 * 核对结果归一：actual 为 run/stop 且与 expected 一致 → 视为 match（UI 允许师傅直选
 * 「实际：运行/停运」，选了与预期相同的实际状态即是一致，不构成不一致）。
 */
export function normalizeActualOf(
  actual: ElevatorActual,
  expected: ElevatorExpected,
): ElevatorActual {
  if ((actual === 'run' || actual === 'stop') && actual === expected) return 'match';
  return actual;
}

/** 不一致判定（ELE-06 标红范围，D-T22 拍板：任一 actual ≠ match 均写 alerts 标红） */
export function isMismatchOf(actual: ElevatorActual): boolean {
  return actual !== 'match';
}

/** 预期状态中文（文案单一来源：h5 行展示与 api alerts.message 同用） */
export function elevatorExpectedLabel(expected: ElevatorExpected): string {
  return expected === 'run' ? '运行' : '停运';
}

/** 核对结果中文（alerts.message 用；match 不会进入标红文案） */
export function elevatorActualLabel(actual: ElevatorActual): string {
  return actual === 'run' ? '运行' : actual === 'stop' ? '停运' : '故障';
}

/** 非数组清单的合成定位项（评审修复轮 M2 同族：for..of 迭代器异常 500 的预防，域外回显） */
export const ELEVATOR_CHECKS_BAD_PAYLOAD = (): MissingField => ({
  field: 'elevator_checks' as MissingField['field'],
  section: 9,
  label: '电梯核对项格式非法（须为数组）',
  anchor: '#sec-9-elevator-checks',
});

/**
 * 单项格式非法（非对象元素 / elevator_id 非法）的**带序号**合成定位项（TK-17 评审修复轮 L2）：
 * 不可复用 `elevator:0` 兑底——多条脏项会产出同一 `field`，而 C-09 面板与预览弹窗都以
 * `item.field` 作 `:key`（重复 key → Vue 渲染告警且 E2E 多元素命中），且锚点无处可跳。
 * 序号项使每条脏数据各自可定位、互不碰撞（域外回显同订正 2 先例）。
 */
export const ELEVATOR_CHECK_BAD_ITEM = (index: number): MissingField => ({
  field: `elevator_checks[${index}]` as MissingField['field'],
  section: 9,
  label: `电梯核对项格式非法（第 ${index + 1} 项）`,
  anchor: `#sec-9-elevator-checks-${index}`,
});

/**
 * elevator_id 严格合法性（TK-17 评审修复轮 L1）：**只接受整型 number**，不走 `Number()` 宽松转换——
 * 与 TK-12 将 parseNumeric 收紧为十进制字面量同一纪律：实证 `Number('3')`/`Number('1e2')`/`Number([3])`
 * 均得整数，宽松口径下 `'1e2'` 会被当 100 号梯——**把核对写进另一台真实电梯（串台）**。
 */
function elevatorIdOf(raw: unknown): number | null {
  const id = (raw as { elevator_id?: unknown } | null | undefined)?.elevator_id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/** 说明超长/格式类点名的默认 label（调用方可经 labelOf 带电梯名覆盖） */
const DEFAULT_CHECK_LABEL = '电梯核对状态说明';

/**
 * 核对结果**纯校验**（api submit/preview 与 h5 离线预检同源，TK-12 评审 M3/L4「预检即点名」
 * 纪律；确认与命中一一对应的多行失真防重纪律同用量覆盖 L4）：
 *
 * - 非数组上送 → outOfRange 合成定位项（undefined/null = 未核对，合法——核对不强制；
 *   ELE-03/04 未要求逐台必核，漏核的追责载体是交接确认页的逐条知晓，随 TK-18/19）；
 * - `elevator_id` **必须是整型 number**（L1：不走 Number() 宽松转换，'3'/'1e2'/[3] 一律形态错，
 *   否则 `'1e2'` 会被当 100 号梯把核对写进另一台真实电梯）；`resolveExpected(id)` 返回 null
 *   （电梯不存在）→ outOfRange 以 `elevator:{id}` 点名（C-09：明细落 elevator_checks 逐台一行、
 *   records 无对应列）；非对象元素 / id 形态错 → 带序号的 `elevator_checks[i]` 合成项（L2）；
 * - 同一电梯重复上送 → outOfRange（uk_rec_lift 唯一，多行落库失真）；
 * - `check_time` 非法（isValidLocalTimestamp：分域正则 + 日历有效性）→ outOfRange——
 *   核对时刻缺失即无法锁定预期（ELE-05 的前提），不放行也不代填服务端时刻；
 * - `actual` 越枚举 → outOfRange；
 * - 归一后**不一致而说明空白** → explanationMissing（api 侧 409 ELEVATOR_EXPLANATION_REQUIRED，
 *   h5 离线预检同步拦截——ELE-04-T2 / ELE-07-T1「拦截并点名」的同一权威实现）；
 * - 说明超 varchar(300) → outOfRange（同 confirmations 超长 400 口径）。
 *
 * `resolveExpected(elevatorId, checkTime)`：服务端按 plans + check_time 时钟分量调
 * expectedStatusAt 重算（D-T22 ②）；h5 离线预检以草稿锁定的 expected 兑底（配置在离线期间
 * 被改的极端情形由同步时刻服务端复验兜住，滞留单走既有 last_error/L2 链路）。
 */
export function validateElevatorChecks(
  input: unknown,
  resolveExpected: (elevatorId: number, checkTime: string) => ElevatorExpected | null,
  labelOf?: (elevatorId: number) => string | null,
): {
  outOfRange: MissingField[];
  explanationMissing: MissingField[];
  valid: Array<{
    elevator_id: number;
    check_time: string;
    expected: ElevatorExpected;
    actual: ElevatorActual;
    explanation: string | null;
  }>;
} {
  const outOfRange: MissingField[] = [];
  const explanationMissing: MissingField[] = [];
  const valid: Array<{
    elevator_id: number;
    check_time: string;
    expected: ElevatorExpected;
    actual: ElevatorActual;
    explanation: string | null;
  }> = [];
  // 未上送（undefined/null）= 本班次未做核对，合法；上送了但非数组才点名（M2 同族）
  if (input != null && !Array.isArray(input)) {
    outOfRange.push(ELEVATOR_CHECKS_BAD_PAYLOAD());
    return { outOfRange, explanationMissing, valid };
  }
  const seen = new Set<number>();
  const items = Array.isArray(input) ? input : [];
  for (let index = 0; index < items.length; index++) {
    const raw = items[index] as Partial<ElevatorCheckPayload> | null | undefined;
    // L1：id 严格取整型 number（不走 Number() 宽松转换）；L2：脏项走**带序号**合成定位项
    //（不复用 elevator:0——多条脏项会撞同一 field/key，且锚点无处可跳）
    const id = elevatorIdOf(raw);
    if (id === null) {
      outOfRange.push(ELEVATOR_CHECK_BAD_ITEM(index));
      continue;
    }
    const label = labelOf?.(id) ?? DEFAULT_CHECK_LABEL;
    // 去重在「首个形态合法的该项」处认领：同一电梯只会有一个条目进入 valid / explanationMissing，
    // 避免两张清单里出现同一 `field`（重复 :key）；后续重复项作为形态错点名（uk_rec_lift 唯一）
    if (seen.has(id)) {
      outOfRange.push(toElevatorMissingField(id, label));
      continue;
    }
    seen.add(id);
    const checkTime = typeof raw?.check_time === 'string' ? raw.check_time.trim() : '';
    if (!isValidLocalTimestamp(checkTime)) {
      outOfRange.push(toElevatorMissingField(id, label));
      continue;
    }
    const expected = resolveExpected(id, checkTime);
    if (expected === null) {
      outOfRange.push(toElevatorMissingField(id, label));
      continue;
    }
    const actualChosen = raw?.actual;
    if (!ELEVATOR_ACTUALS.includes(actualChosen as ElevatorActual)) {
      outOfRange.push(toElevatorMissingField(id, label));
      continue;
    }
    const actual = normalizeActualOf(actualChosen as ElevatorActual, expected);
    const explanation = typeof raw?.explanation === 'string' ? raw.explanation.trim() : '';
    if (isMismatchOf(actual)) {
      // 一致/未选实际状态时说明忽略（trim 后空即 null，残留草稿脏值不落库）
      if (explanation === '') {
        explanationMissing.push(toElevatorMissingField(id, label));
        continue;
      }
      if (explanation.length > 300) {
        outOfRange.push(toElevatorMissingField(id, label));
        continue;
      }
    }
    valid.push({
      elevator_id: id,
      check_time: checkTime,
      expected,
      actual,
      explanation: isMismatchOf(actual) ? explanation : null,
    });
  }
  return { outOfRange, explanationMissing, valid };
}
