/**
 * 枚举与错误码 —— 三端同源（TK-03）。
 *
 * 出处：
 * - 状态/角色/电梯枚举：技术方案 §4.2 建表语句（与 Drizzle schema 逐列一致）
 * - 错误码 ErrorCode：《API 契约 v0.1》§2 错误码表（C-09 落地的机器可读码）
 * 编号纪律：错误码字符串即契约，只增不改；新增须先在《API 契约》§2 表登记。
 */

/** 交接记录状态机（技术方案 §5.4） */
export const RecordStatus = ['draft', 'submitted', 'objection', 'completed'] as const;
export type RecordStatus = (typeof RecordStatus)[number];

/** 账号角色：师傅（填写与确认）/ 科长（全部 + 配置）（技术方案 §6） */
export const UserRole = ['master', 'chief'] as const;
export type UserRole = (typeof UserRole)[number];

/** 电梯运行计划类型（技术方案 §4.2 elevators.plan_type） */
export const ElevatorPlanType = ['always', 'scheduled', 'stopped'] as const;
export type ElevatorPlanType = (typeof ElevatorPlanType)[number];

/** 电梯核对结果（技术方案 §4.2 elevator_checks.actual） */
export const ElevatorCheckActual = ['match', 'run', 'stop', 'fault'] as const;
export type ElevatorCheckActual = (typeof ElevatorCheckActual)[number];

/** 通用「正常/异常」状态（§4.2 hp/neg/air/boiler/coolroom/hvac_status 共用） */
export const OkBadStatus = ['ok', 'bad'] as const;
export type OkBadStatus = (typeof OkBadStatus)[number];

/** 设备「运行/停机」（§4.2 boiler_run、cool_run） */
export const RunStop = ['run', 'stop'] as const;
export type RunStop = (typeof RunStop)[number];

/** 水泵水位「正常/偏高/偏低」（§4.2 p1_level、p3_level） */
export const WaterLevel = ['ok', 'high', 'low'] as const;
export type WaterLevel = (typeof WaterLevel)[number];

/** 使用罐号 / 锅炉号等「在用设备」枚举值以字符串承载（附录 A 四、五） */
export const TankInUse = [1, 2] as const;
export type TankInUse = (typeof TankInUse)[number];

/**
 * 统一错误码（《API 契约》§2 错误码表，13 项）。
 * 所有 4xx 响应体的 code 字段取此集合；HTTP 状态见 errors.ts 的 ERROR_HTTP_STATUS。
 */
export const ErrorCode = [
  'VALIDATION_MISSING_FIELDS', // 400 必填缺失（含液氧 8 项）— F1-08、DATA-01
  'VALIDATION_OUT_OF_RANGE', // 400 数值越界 — F1-08
  'UNAUTHENTICATED', // 401 未登录/会话过期 — F1-11
  'FORBIDDEN', // 403 角色不足（师傅访问后台等）— C-05
  'NOT_FOUND', // 404 资源不存在或无权查看
  'READINGS_DECREASED', // 409 读数小于上一班，需确认 — F1-12
  'GAS_REFILL_CONFIRMED', // 409 气卡剩余量增大，需充气确认 — F1-13
  'DUTY_MISMATCH', // 409 登录人与当日排班不符，需安全阀确认 — F6-05
  'WITHDRAW_NOT_ALLOWED', // 409 不可撤回 — F2-10
  'CONFIRM_INCOMPLETE', // 409 仍有未逐条知晓的标红项/交接事项 — F2-04
  'OVERRIDE_REASON_REQUIRED', // 409 覆盖自动计算值未填原因 — F3-06
  'ELEVATOR_EXPLANATION_REQUIRED', // 409 电梯不一致未填说明 — ELE-04、ELE-07
  'RECORD_EXISTS', // 409 当日记录已提交（duty_date 唯一）— F1-01
] as const;
export type ErrorCode = (typeof ErrorCode)[number];

/** WITHDRAW_NOT_ALLOWED 的三种不可撤回原因（《API 契约》§2 错误码表括注，F2-10） */
export const WithdrawNotAllowedReason = [
  'WINDOW_EXPIRED', // 超出 10 分钟撤回窗口
  'ALREADY_CONFIRMED', // 接班人已确认
  'IN_OBJECTION', // 处于异议流程
] as const;
export type WithdrawNotAllowedReason = (typeof WithdrawNotAllowedReason)[number];
