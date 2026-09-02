/**
 * @handover/shared —— 三端（apps/api、apps/h5、apps/admin）共享类型与契约（TK-03）。
 *
 * 分层：
 * - enums：状态/角色/电梯/错误码枚举（技术方案 §4.2、《API 契约》§2）
 * - sections：十板块定义（PRD 附录 A）
 * - fields：records 字段字典（附录 A + §4.2，DATA-11）
 * - errors：统一错误响应结构 + 锚点生成（《API 契约》§2/§4，C-09）
 *
 * 消费方式：h5/admin 经 Vite alias 直用本 TS 源码；api 经 dist（先 `pnpm --filter @handover/shared build`）。
 */

export * from './enums';
export * from './sections';
export * from './fields';
export * from './errors';

import type { ApiError, MissingField } from './errors';
import { toMissingField } from './errors';

/**
 * 编译期契约一致性 fixture —— 逐字复刻《API 契约 v0.1》§2 示例响应体。
 * `satisfies ApiError` 保证：若本包错误结构与契约不一致（缺字段/类型错），此处编译即失败。
 * 这是 TK-03 完成判据「错误结构类型与 API 契约一致」的落地证明。
 */
export const API_CONTRACT_ERROR_EXAMPLE = {
  code: 'VALIDATION_MISSING_FIELDS',
  message: '有 3 项必填未填',
  missing_fields: [
    { field: 'hp_status', section: 2, label: '高配房是否正常', anchor: '#sec-2-hp-status' },
  ],
  need_confirm: null,
  request_id: 'req-xxxx',
} satisfies ApiError;

/**
 * 契约示例中的点名项，与 `toMissingField('hp_status')` 的运行期输出逐字段相等。
 * 运行期断言由 C-09 用例（F1-08-T1/T2，TK-06/TK-12 落地表单与提交后）覆盖。
 */
export const CONTRACT_EXAMPLE_MISSING_FIELD = {
  field: 'hp_status',
  section: 2,
  label: '高配房是否正常',
  anchor: '#sec-2-hp-status',
} satisfies MissingField;

/** 便捷别名：由字段字典生成契约示例点名项（三端复用同一逻辑，杜绝锚点各写各的） */
export const hpStatusMissingField: MissingField = toMissingField('hp_status');
