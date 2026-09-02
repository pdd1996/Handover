/**
 * 统一错误响应结构 —— 三端同源（TK-03，C-09「报错必须点名」落地为可断言结构）。
 *
 * 出处：《API 契约 v0.1》§2 错误响应结构 + §2 错误码表 + §4 提交协议（need_confirm）。
 * 所有 4xx 响应体统一为 ApiError；missing_fields[] 逐条点名缺失/越界字段并给前端跳转锚点。
 */

import type { ErrorCode } from './enums';
import { FIELD_BY_NAME, type RecordFieldName } from './fields';
import { ELEVATOR_SECTION_NO, type SectionNo } from './sections';

/**
 * 点名对象（《API 契约》§2 `missing_fields[].field` 取值域）：
 * - records 列名：常规表单字段（附录 A 字典）
 * - `elevator:{id}`：电梯核对行。明细落 elevator_checks 逐台一行、records 无对应列，
 *   但 ELE-04-T2（不一致未填说明→拒绝）与 ELE-07-T1（无说明→「拦截并点名」）同受 C-09
 *   「所有拦截逐条点名 + 点击跳转定位」约束，故纳入同一结构（id 为 elevators.id）。
 */
export type MissingTarget = RecordFieldName | `elevator:${number}`;

/** 缺失/越界字段点名项（《API 契约》§2 missing_fields[]） */
export interface MissingField {
  /** 点名对象：records 列名，或电梯核对行 `elevator:{id}` */
  field: MissingTarget;
  /** 板块序号（0=基础信息，1~10 业务板块，电梯为 9；基础信息字段如 receiver_change_reason 也会进点名清单） */
  section: SectionNo;
  /** 中文名（附录 A） */
  label: string;
  /** 前端跳转锚点，如 #sec-2-hp-status、#sec-9-elevator-3 */
  anchor: string;
}

/**
 * 生成锚点：`#sec-{板块号}-{点名对象 kebab}`（`_` 与 `:` 均转 `-`）。
 * 与《API 契约》§2 示例一致：hp_status + section 2 → #sec-2-hp-status；
 * 电梯核对行 elevator:3 + section 9 → #sec-9-elevator-3。
 * 前端 TK-06 渲染表单、TK-12 渲染电梯核对行时用同一函数生成 DOM id，
 * 保证「点击跳转可达」（F1-08-T1、ELE-07-T1）。
 */
export function fieldAnchor(section: SectionNo, field: MissingTarget): string {
  return `#sec-${section}-${field.replaceAll('_', '-').replaceAll(':', '-')}`;
}

/** 由 records 字段名构造点名项（自动带出 section/label/anchor，避免三端各写一份） */
export function toMissingField(field: RecordFieldName): MissingField {
  const def = FIELD_BY_NAME[field];
  return { field, section: def.section, label: def.label, anchor: fieldAnchor(def.section, field) };
}

/**
 * 由电梯核对行构造点名项（ELE-04-T2、ELE-07-T1）。
 * label 由调用方带电梯名（服务端联 elevator_checks + elevators 取），如「3号扶梯 停运说明」。
 */
export function toElevatorMissingField(elevatorId: number, label: string): MissingField {
  const field: MissingTarget = `elevator:${elevatorId}`;
  return {
    field,
    section: ELEVATOR_SECTION_NO,
    label,
    anchor: fieldAnchor(ELEVATOR_SECTION_NO, field),
  };
}

/** 提交协议确认项类型（《API 契约》§4 confirmations[].type + 排班安全阀 duty_guard） */
export const ConfirmType = ['reading_decreased', 'gas_refill', 'duty_guard'] as const;
export type ConfirmType = (typeof ConfirmType)[number];

/**
 * 单条待确认项：服务端 409 时经 need_confirm 下发，客户端据此弹窗收集 reason 后重提（§4 步骤 2）。
 * message 遵循可解释原则（C-03）：说明命中规则 + 阈值/差值。
 */
export interface ConfirmItem {
  type: ConfirmType;
  /** reading_decreased：回退的字段 */
  field?: RecordFieldName;
  /** gas_refill：剩余量增大的卡号（1 主卡 / 2 副卡） */
  card?: 1 | 2;
  /** 上一班值（回退/充气比对） */
  prev?: number;
  /** 本次值 */
  current?: number;
  /** duty_guard：当日排班人姓名（登录人不符时提示，F6-05） */
  scheduled_name?: string;
  /** 可解释文案 */
  message: string;
}

/** need_confirm：待确认清单；无则为 null（《API 契约》§2） */
export type NeedConfirm = ConfirmItem[] | null;

/**
 * 请求侧 confirmations[].type（《API 契约》§4 提交协议）。
 * 比 ConfirmType 少 duty_guard：排班安全阀走独立字段 `duty_guard_confirm`，不进 confirmations[]。
 */
export const PayloadConfirmType = ['reading_decreased', 'gas_refill'] as const;
export type PayloadConfirmType = (typeof PayloadConfirmType)[number];

/** 请求侧 confirmations[] 单项（§4 请求体）：客户端弹窗收集后随重提提交 */
export interface ConfirmationPayload {
  type: PayloadConfirmType;
  /** reading_decreased：回退的字段 */
  field?: RecordFieldName;
  /** gas_refill：充气的卡号（1 主卡 / 2 副卡） */
  card?: 1 | 2;
  /** 确认原因（写 audit_logs 的 reason，§5） */
  reason: string;
}

/** 请求侧排班安全阀确认（§4 请求体 duty_guard_confirm，F6-05）：登录人与当日排班不符时需确认 */
export interface DutyGuardConfirm {
  confirmed: boolean;
  reason: string;
}

/** 统一错误响应体（所有 4xx，C-09 落地） */
export interface ApiError {
  /** 机器可读错误码（§2 错误码表） */
  code: ErrorCode;
  /** 人类可读概要 */
  message: string;
  /** 缺失/越界字段逐条点名；非缺失类错误为 null */
  missing_fields: MissingField[] | null;
  /** 防呆/安全阀待确认清单；否则 null */
  need_confirm: NeedConfirm;
  /** 日志追踪 id */
  request_id: string;
}

/** 错误码 → HTTP 状态（《API 契约》§2 错误码表首列） */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_MISSING_FIELDS: 400,
  VALIDATION_OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  READINGS_DECREASED: 409,
  GAS_REFILL_CONFIRMED: 409,
  DUTY_MISMATCH: 409,
  WITHDRAW_NOT_ALLOWED: 409,
  CONFIRM_INCOMPLETE: 409,
  OVERRIDE_REASON_REQUIRED: 409,
  ELEVATOR_EXPLANATION_REQUIRED: 409,
  RECORD_EXISTS: 409,
};
