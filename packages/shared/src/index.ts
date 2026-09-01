/**
 * @handover/shared — 三端（apps/api、apps/h5、apps/admin）共享类型。
 *
 * 当前为 TK-01 脚手架占位：仅放技术方案 §4.2 已定案的枚举。
 * 板块/字段枚举与统一错误响应结构（含 missing_fields[].anchor，见《API 契约》§3）
 * 由 TK-03 在本包补齐，三端同源引用。
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
