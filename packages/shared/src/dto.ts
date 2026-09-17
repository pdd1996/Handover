/**
 * API 契约的响应类型 —— 三端同源（TK-05 起）。
 *
 * 定位：《API 契约 v0.1》各路由的响应形状在此定义一次，api 端产出、h5/admin 端消费同一份类型，
 * 杜绝前后端各写一份 interface 而随迭代漂移（与 fields/cards 字典同源的同一理由）。
 * 命名沿用蛇形（`duty_date`、`spot_name`）——与契约 §2/§3 的 JSON 字段名逐字对应。
 *
 * 组织方式：按契约 §3 的路由分节。本轮仅落 §3.2 首条路由 GET /records/today（TK-05）。
 *
 * 注：认证类 DTO（AuthUserDto / LoginResponseDto）目前仍在 `apps/api/src/auth/auth.controller.ts`
 * ——TK-04 已评审验收，不为迁移而动它；后续接口扩充时一并归入本文件。
 */

import type { ElevatorCheckActual, RecordStatus, UserRole, UserStatus } from './enums';
import type { AlertLevel } from './alerts';
import type { UsageFieldName } from './calc';
import type { RecordFieldName } from './fields';
import type { SectionNo } from './sections';
import type { PrevBackfillField } from './guard';
import type { ConfirmationPayload, DutyGuardConfirm, MissingField, ConfirmItem } from './errors';
import type { ElevatorCheckPayload, ElevatorExpected } from './elevator';
import type { ElevatorPlanType } from './enums';

// ── 契约 §3.2 GET /records/today（今日交接首页；F1-01、F1-02、F1-03）─────────

/**
 * 角标统计（F1-03「卡片角标与顶部进度条实时汇总已填/待填/异常」）。
 *
 * `total` 只计**师傅需亲手填或选**的字段（服务端派生列与条件必填/选填不计入），
 * 口径与依据见 `cards.ts` 的 `isCountableField`。
 * 注意"已填"与"异常"**不是互斥状态**：状态字段选"异常"时 filled 与 abnormal 同时 +1，
 * 前端据此分别画进度与变色角标。
 */
export interface BadgeDto {
  /** 已填项数 */
  filled: number;
  /** 应填项数（分母） */
  total: number;
  /** 待填项数 = total - filled */
  pending: number;
  /** 异常项数（Phase 1 即表单级标红项，PRD §6.2） */
  abnormal: number;
}

/**
 * 单字段填写状态。
 * **只给动态状态**——静态元数据（label / unit / kind / fill）由前端从 shared 的 `FIELD_BY_NAME`
 * 取，接口不重复传输，也避免两处元数据各说一套。
 */
export interface CardFieldStateDto {
  /** records 列名（= 字段字典的 name） */
  name: string;
  /** 是否计入"应填"分母（TK-06 起动态判定：条件必填按同卡已填值触发，见 cards.ts isRequiredField） */
  required: boolean;
  filled: boolean;
  abnormal: boolean;
  /** 原值（decimal 列为字符串，与 Drizzle 一致）；无记录或未填为 null */
  value: unknown;
  /**
   * 该值是否为师傅手工覆盖（TK-13，F3-06-T1「标识与人工值可区分」）：true = 人工覆盖
   * （audit_logs 有 `record.usage_override` 留痕可追溯）；缺省/undefined = 服务端自动计算。
   * 仅服务端计算固化的用量字段（shared `USAGE_FIELDS`）可能出现 true。
   */
  manual?: boolean;
}

/** 一张任务卡（F1-02） */
export interface CardDto {
  /** 卡片稳定标识（shared `CardKey`；前端锚点与板块页路由参数） */
  key: string;
  /** spots 表行 id（点位字典后台可维护，F6-07） */
  spot_id: number;
  spot_name: string;
  sort_no: number;
  /** 卡片标题（点位名） */
  title: string;
  /** 到点卡时段槽（液氧 'am'/'pm'）；非到点卡为 null */
  slot: string | null;
  /** 时段展示文案（'8:30' / '20:30'）；非到点卡为 null */
  slot_label: string | null;
  /** 主板块号（= sections 首位），用于卡片标题归类 */
  section: SectionNo;
  section_label: string;
  /**
   * 本卡覆盖的全部板块。多数卡为单板块；值班室卡兼管板块八「节能减排」→ `[10, 8]`
   * （该板块无 spots 点位但 PRD §6.1 要求十板块完整可填，见 `cards.ts` 头部说明）。
   */
  sections: SectionNo[];
  /** form = 走 records 字段填写；elevator = 走 elevator_checks 逐台核对（契约 §3.3，TK-17） */
  kind: string;
  badge: BadgeDto;
  fields: CardFieldStateDto[];
}

/**
 * 板块填写状态汇总（契约 §3.2「各板块填写状态」）。
 * 按**字段真实板块号**聚合（非卡片归属），故覆盖板块 1–10；板块 0（基础信息）自动带出、不属巡检卡。
 * 板块九（电梯）无 records 字段但仍出现（total=0），因其有卡且核对状态走 elevator_checks。
 */
export interface SectionStateDto {
  no: SectionNo;
  key: string;
  label: string;
  badge: BadgeDto;
}

/**
 * 今日记录状态。当日无记录为 **null**——GET /records/today 是只读接口，不创建 draft 行
 * （理由见 `records.service.ts` 头部：record_no 提交时才生成、D-T15）。draft 行的产生时机已随
 * TK-08 闭环（决策记录 **D-T18**）：离线优先下草稿存于客户端 IndexedDB，服务端不设在线草稿
 * 端点，records 行提交时一次性创建；draft 状态仅由撤回（F2-08，TK-21）产生。
 */
export interface TodayRecordDto {
  id: number;
  record_no: string;
  /** draft / submitted / objection / completed（技术方案 §5.4 状态机） */
  status: RecordStatus;
  version: number;
  submitted_at: string | null;
}

/** GET /records/today 响应体 */
export interface TodayDto {
  /** 班次起始日（C-08「记录日期=班次起始日，非提交日」）；一切查询与展示以此为准 */
  duty_date: string;
  /** 班次分界时刻（回显便于排查跨天归属；❓ 待科长确认，台账待确认清单第 8 项） */
  shift_start_time: string;
  /**
   * 撤回窗口时长（分钟，TK-21/F2-09）：服务端读 configs `withdraw_window_minutes`（非法/缺失
   * 回落 10，与种子同源）。前端据 `record.submitted_at + 本值` 算撤回倒计时（F2-09-T1「倒计时
   * 与窗口一致」）；**服务端撤回校验用同一配置值**，两端同源不漂移（F4-11 运营口径后台可配）。
   */
  withdraw_window_minutes: number;
  record: TodayRecordDto | null;
  /**
   * 待同步标记。**TK-05 阶段恒为 false 的占位**：离线待同步队列存于客户端 IndexedDB，
   * 服务器对其零感知（F1-07-T2 判据「服务器无感知（无 draft 泄露）」），故服务端无从返回真值。
   * 真值由前端待同步队列决定并与本字段做 OR 合并（TK-15 离线三层缓冲接管；草稿层不产生
   * 待同步语义，见决策记录 D-T18）。
   */
  pending_sync: boolean;
  /** 交班人 = 登录账号（技术方案修订 9：submitter_id 恒以登录人为准） */
  submitter: { id: number; real_name: string };
  /** 接班人：TK-12 按排班表自动带出（DATA-10），本阶段恒为 null */
  receiver: { id: number; real_name: string } | null;
  /** 顶部进度条（F1-03）：12 张卡角标之和 */
  progress: BadgeDto;
  sections: SectionStateDto[];
  cards: CardDto[];
}

/**
 * 表单选项类配置键白名单（TK-11，DATA-07）：**三端同源的单一来源**——api configs.service
 * 据此查询/构造响应，h5 SectionView 据此取候选，configs.spec 据此断言。新增表单清单键
 * 只改这里，契约 §3.7 与台账同步回写（拼错键名/漏加键在此处编译期即报，TK-11 评审 M5）。
 */
export const FORM_OPTION_CONFIG_KEYS = ['hvac_locs', 'boiler_list'] as const;
export type FormOptionConfigKey = (typeof FORM_OPTION_CONFIG_KEYS)[number];

/**
 * GET /configs 响应体（TK-11，DATA-07「新风使用位置多选，候选清单后台配置」）：
 * **表单选项类配置的白名单只读视图**——configs 表另有阈值/会话时长等运营键，
 * 师傅端表单只消费清单类（键集见 `FORM_OPTION_CONFIG_KEYS`），非白名单键不经此端点出网
 * （运营口径的读取归科长后台 GET /admin/configs，契约 §3.6）。值统一为
 * configs.config_value 的 JSON 数组解析结果，h5 据此渲染多选/枚举候选。
 *
 * 类型为**显式键映射**而非开放 index signature：键名拼错编译期即失败，且
 * `noUncheckedIndexedAccess` 下开放签名会吞掉键名错误的编译期报错（评审 M5）。
 *
 * 候选值 ❓ 均为《开发种子数据》占位（待总务科）：科长后台改 configs 即生效，
 * 下一班表单即时反映（F4-11 精神，技术方案修订 4「自定义灵活性放在配置层」）。
 * **提交侧不校验候选成员性**（h5 离线降级用占位候选，成员性校验会把降级路径变 400，
 * 违反 F1-09/C-01；如需引入随 TK-27 配置中心评估，契约 §3.7）。
 */
export type FormOptionsDto = {
  readonly [K in FormOptionConfigKey]: readonly string[];
};

// ── 契约 §3.2 / §4 提交协议（TK-12；F1-10、F2-01、DATA-09/10/13）─────────────────

/**
 * POST /records/today/preview 与 /records/today/submit 的请求体（契约 §4）。
 *
 * `sections` 为字段名字典值对（snake_case 列名 → 原值；decimal 传字符串、多选传数组、
 * 测量时刻传 `YYYY-MM-DD HH:mm:ss` 本地时间戳）。**用量列（*_use）客户端传值不被信任**
 * （契约 §4 第 3 步：服务端计算固化，TK-13 落地前提交时置 NULL）；
 * `lo_measured_am/pm` 相反——本机测量时刻即唯一权威（D-P12/契约 §4 补充口径），
 * 服务端原样落库、不得以同步时刻覆盖（DATA-13-T2）。
 *
 * `confirmations[]`（TK-14 防呆）与 `duty_guard_confirm`（TK-26 排班安全阀）为两类 409 的
 * 确认载体：409 need_confirm 弹窗逐条收集后随重提上送，消费口径见各字段注。
 */
export interface SubmitPayloadDto {
  /** 十板块表单值（字段字典内的 records 列名 → 原值；字典外键忽略） */
  sections: Readonly<Partial<Record<RecordFieldName, unknown>>>;
  /**
   * 接班人（DATA-10）：省略 = 按排班自动带出（次日排班人）；与带出值不同即视为修改，
   * `receiver_change_reason` 转必填（400 点名 section 0）。
   */
  receiver_id?: number | null;
  /** 接班人修改原因（DATA-10：修改必填原因并留痕） */
  receiver_change_reason?: string | null;
  /**
   * 用量手工覆盖（TK-13，F3-04/F3-06）：`*_use` 由服务端计算固化、sections 里的同名键
   * 恒不被信任（契约 §4 第 3 步），师傅改值必须显式走本清单——`reason` 缺失/空白由服务端
   * 400 点名（F3-06-T2，非仅前端），合法覆盖以覆盖值固化并写 `record.usage_override`
   * 审计留痕（F3-04-T2）。合法键集 shared `USAGE_FIELDS`。
   */
  usage_overrides?: readonly UsageOverridePayload[];
  /** 防呆确认（TK-14 消费） */
  confirmations?: readonly ConfirmationPayload[];
  /**
   * 排班安全阀确认（TK-26 消费，F6-05）：登录提交人 ≠ 该班次排班人时 submit/backfill 返
   * 409 DUTY_MISMATCH（need_confirm 携排班人），客户端确认后随重提上送本字段放行——
   * `confirmed !== true` 不放行（拒绝确认/未确认均拦，F6-05-T2）；`reason` 选填
   * （demo 口径确认即放行留痕，非空随审计 record.guard_confirm 的 reason 列留痕）。
   * 排班与本登录人一致时本字段被忽略（不写审计，同「未命中确认不入账」口径）。
   */
  duty_guard_confirm?: DutyGuardConfirm;
  /**
   * 补录上一班读数（TK-14，F3-07）：上一班缺失（GET /records/today/prev 返回 prev=null
   * 且非首班，D-T17 缺失态）时师傅补录的相邻班次读数。合法键集 shared `PREV_BACKFILL_FIELDS`
   * （防呆比对基线 + 用量计算的五个比对字段）。服务端**仅在缺失态消费**：有相邻班次已提交
   * 记录时忽略（防客户端缓存串台）、首班（first_day）无缺失态同样忽略；补录值不落 records
   * 列（缺失班次不建行，不伪造当日记录），以审计 `record.prev_backfill` 留痕（D-T19）。
   */
  prev_readings?: Readonly<Partial<Record<PrevBackfillField, unknown>>>;
  /**
   * 逐台电梯核对结果（TK-17，ELE-04/06/07；契约 §3.3 的 POST /records/today/elevator-checks
   * 经决策记录 **D-T22** 订正为并入本提交协议——elevator_checks.record_id NOT NULL，
   * 提交前无 records 行可挂，独立端点的写副作用与 D-T15/D-T18 同族冲突；随 payload 走
   * 离线队列免费可用）。服务端按上送 check_time（核对时刻）重算 expected 落库（ELE-05
   * 「提交时不重算」= 不按提交时刻重算，D-P16 字面），不一致必填说明（缺则 409
   * ELEVATOR_EXPLANATION_REQUIRED），任一不一致写 alerts 标红行（ELE-06，D-T22 ③）。
   * 校验纯函数 shared validateElevatorChecks（api 与 h5 离线预检同源）。
   */
  elevator_checks?: readonly ElevatorCheckPayload[];
}

/**
 * 用量手工覆盖项（TK-13，F3-04/F3-06）：对服务端自动计算值的人工改写载体。
 * `reason` 必填——F3-06-T2 判据「覆盖自动值但不填原因 → 提交 → 阻止」由服务端校验，
 * 原因随 `audit_logs.reason` 留痕（技术方案 §5.5，台账 F3-06「技术方案」列）。
 */
export interface UsageOverridePayload {
  /** 覆盖的用量字段（shared `USAGE_FIELDS` 键集，拼错编译期即报） */
  field: UsageFieldName;
  /** 覆盖值（十进制字面量，与表单数值同形态；服务端按列精度取整后固化） */
  value: string | number;
  /** 覆盖原因（必填，空白即 400 点名该用量字段） */
  reason: string;
}

/**
 * POST /records/today/preview 响应体（F1-10「提交前汇总预览：未填项、异常项一目了然」）。
 * 两张清单与契约 §2 `missing_fields[]` 同构（C-09：逐条点名 + 锚点跳转），
 * 供客户端弹窗展示与点击定位。
 */
export interface PreviewDto {
  /** 班次起始日（C-08，回显供前端互核） */
  duty_date: string;
  /** 必填未填（含越界项合并展示，缺失在前；同 submit 400 的口径，契约 §4 第 1 步） */
  missing_fields: readonly MissingField[];
  /** 异常项：状态字段选「异常」（'bad'）的清单——预警级标红，不拦提交（PRD §6.2） */
  abnormal_fields: readonly MissingField[];
}

/**
 * POST /records/backfill 请求体（TK-16/D-T21，F3-08「上一班记录晚到→重算下游」的触发载体）。
 *
 * 除 `duty_date` 外与 /today/submit 请求体完全同形：校验/防呆/覆盖/补录协议同一套
 * （服务端把补交当作「指定班次的提交」处理，复用 submitCore 单一实现，防两套口径漂移）。
 */
export interface BackfillPayloadDto extends SubmitPayloadDto {
  /**
   * 补交班次的班次起始日（C-08 形态 `YYYY-MM-DD`）。服务端约束：
   * ① 日历合法；② **严格早于当前班次日期**（当日/未来班次走 /today/submit，D-T20 M1）；
   * ③ **不早于补交窗口**（当前班次 − configs `backfill_window_days` 天，默认 7，评审修复轮 L3）；
   * ④ 该班次已有**非 draft** 记录 → 409 RECORD_EXISTS（draft 行由补交接管为重提，L5）。
   * 提交人恒为登录人本人（不代录他人；科长代录他人挂 TK-24 处置面板）。
   */
  duty_date: string;
}

/**
 * 补交后的下游重算结果（TK-16，F3-08；仅 `POST /records/backfill` 响应携带）。
 */
export interface RecalcResultDto {
  /** 被重算的下游单（紧邻 D+1）的 record_no */
  record_no: string;
  /** 实际变更的用量字段（重算三项的子集；豁免项与数值无变化项不入列） */
  fields: readonly UsageFieldName[];
  /**
   * **待人工复核清单**（TK-16 评审修复轮 L6，2026-09-14 拍板）：重算**不重跑防呆拦截**
   * （F3-08 只要求重算与审计，不得在无人值守的回写链路上 409 卡住），但新基线使下游出现
   * D-T19 命中项（读数回退；未被原提交确认的充气）时，**不改数、不拦提交**，在此与审计
   * `record.recalc_review` 一并标出，交人工走异议流程（TK-20）核对。
   * 空数组 = 无命中（原提交已确认充气的卡不重复计入）。
   */
  needs_review: readonly ConfirmItem[];
}

/** POST /records/today/submit 响应体（F2-01：生成正式交接单） */
export interface SubmitResultDto {
  id: number;
  /** `HB-YYYYMMDD-001`（技术方案 §4.2 示例格式；duty_date 唯一 → 每班次恒 -001） */
  record_no: string;
  /** 提交后恒 'submitted'（技术方案 §5.4 状态机；draft 仅由撤回产生，D-T18） */
  status: RecordStatus;
  version: number;
  /** 服务端收到时刻（DATA-09：离线场景下即同步成功时刻） */
  submitted_at: string;
  /** 接班人（带出或修改后；无次日排班为 null） */
  receiver: { id: number; real_name: string } | null;
  /** 本次提交是否修改了接班人（true 时 receiver_change_reason 已留痕，DATA-10） */
  receiver_changed: boolean;
  /**
   * 下游重算结果（TK-16，F3-08；**仅补交触发**，在线提交恒缺省/undefined）：
   * 补交 D 日后，重算紧邻下游 D+1 **已提交（status='submitted'）**记录的 prev 依赖用量
   * （water_use/e_use/gas_use）。返回 null 的四种情形：下游无记录；为 draft（待重提，
   * 提交链路自会全量重算）；**处于 objection/completed（已进确认流程或已签名归档，
   * 不静默改数——评审修复轮 L2，2026-09-14 拍板）**；或**无实际变更且无待复核项**（L1）。
   * 逐变更项审计 `record.recalc`（契约 §5），手工覆盖项豁免（D-T07）。
   */
  recalc?: RecalcResultDto | null;
}

/**
 * POST /records/today/withdraw 响应体（TK-21，F2-08「撤回回到可编辑状态」的回执）。
 * 撤回后状态转 draft、submitted_at 清空、version 不变（重提才 +1，F2-08-T2）；
 * 读数列保留（师傅继续改），提交时生成的 alerts/elevator_checks 同事务清空（快照语义，
 * 与 submitCore 重提先清后插同源）。接班人端待确认入口随 status 转 draft 同步消失（F2-09-T2）。
 */
export interface WithdrawResultDto {
  id: number;
  record_no: string;
  /** 撤回后恒 'draft'（技术方案 §5.4 状态机：已提交 →（10 分钟内撤回）草稿） */
  status: RecordStatus;
  /** 版本不变（重提时 submitCore 走 draft 分支 version+1，F2-08-T2） */
  version: number;
}

// ── 契约 §3.4 交接确认（接班人；F2-02、F2-03；TK-18）─────────────────────────────

/**
 * GET /records/pending 的单行（F2-02 待确认入口与逐项浏览列表）。
 * 取数口径（契约 §3.4）：**我为 receiver 且 status=submitted**——draft（撤回未重提，
 * D-T18）与 objection/completed（已退回/已归档）均不产生待确认入口（F2-08「接班人端
 * 待确认入口同步消失」的取数半边）。
 */
export interface PendingRecordDto {
  id: number;
  record_no: string;
  /** 班次起始日（C-08）；待确认单通常是昨日班次（接班人 = 次日排班人，F2-01） */
  duty_date: string;
  /** 恒 'submitted'（见上方取数口径） */
  status: RecordStatus;
  version: number;
  submitted_at: string | null;
  /** 交班人（回显姓名，接班人核对「谁交给我」） */
  submitter: { id: number; real_name: string };
  /** 标红确认项数（alerts 行数，含状态异常/电梯不一致/交接事项拆条；TK-19 起逐条知晓） */
  alert_count: number;
}

/** GET /records/pending 响应体（按 duty_date 降序） */
export interface PendingListDto {
  items: readonly PendingRecordDto[];
}

/**
 * 标红确认项（alerts 行，技术方案 §5.3）：F2-03 置顶高亮与 TK-19 逐条"已知晓"的共同
 * 数据源。`acknowledged_*` 本阶段恒 null（逐条知晓随 TK-19 落地），字段先行以稳定形状。
 */
export interface AlertDto {
  id: number;
  rule_key: string;
  /** 定位目标：状态异常/交接事项为 `field:{列名}`、电梯不一致为 `elevator:{id}`（生成形态见 shared alerts.ts） */
  target: string | null;
  level: AlertLevel;
  message: string;
  acknowledged_by: number | null;
  acknowledged_at: string | null;
}

/** 单台电梯核对明细（GET /records/{id} 的 elevator_checks 逐台一行 + 电梯名回显） */
export interface ElevatorCheckRecordDto {
  elevator_id: number;
  /** 电梯名（联 elevators 字典回显；字典行已被删时为 null，显示原始 id） */
  elevator_name: string | null;
  check_time: string;
  expected: ElevatorExpected;
  /**
   * 核对结果。schema 未加 NOT NULL（§4.2 原样），落库路径（提交 payload 校验）恒有值；
   * 极端历史脏行允许 null，前端显示 "—"。
   */
  actual: ElevatorCheckActual | null;
  explanation: string | null;
}

/**
 * GET /records/{id} 响应体（F2-03 逐项浏览、F5-01 历史详情共用，契约 §3.4「含全部
 * 读数、标红项（alerts）、电梯核对、版本摘要、双方确认信息」）。
 * `alerts` 由服务端排好**置顶序**（level high→mid→low，同级按 id 升序，shared
 * ALERT_LEVEL_RANK），前端直接顺序渲染即满足 F2-03-T1。
 */
export interface RecordDetailDto {
  id: number;
  record_no: string;
  duty_date: string;
  status: RecordStatus;
  version: number;
  submitted_at: string | null;
  /** 交班人（C-05 实名） */
  submitter: { id: number; real_name: string };
  /** 接班人（带出或修改后；无排班为 null） */
  receiver: { id: number; real_name: string } | null;
  /** 接班人修改原因（DATA-10 留痕；未修改为 null） */
  receiver_change_reason: string | null;
  /**
   * 全部读数：字段字典内 records 存储列（板块 ≥1，蛇形列名 → 原值，decimal 为字符串
   * 与 Drizzle 一致）；与 GET /records/today/prev 的 readings 同一取数范围。
   */
  readings: Readonly<Partial<Record<RecordFieldName, unknown>>>;
  /** 标红确认项（**置顶序**已排好，见接口注） */
  alerts: readonly AlertDto[];
  /** 逐台电梯核对明细（按落库序） */
  elevator_checks: readonly ElevatorCheckRecordDto[];
  /** 确认归档时刻（F2-05「确认时间可查」；未确认为 null，TK-19 起） */
  confirmed_at: string | null;
  /** 签名图路径（F2-05；未签名为 null） */
  signature_path: string | null;
  /**
   * 科长批注（F6-01「批注」，TK-24）：records.chief_note 当前值——覆盖式单条，
   * 清除后为 null；写入/清除/历次修改均以审计 `record.annotate` 留痕（契约 §5）。
   */
  chief_note: string | null;
  /**
   * 历史版本摘要（F2-07-T1「历史版本可查」，TK-20 起）：按版本号降序；
   * 全字段快照留库（record_versions.snapshot），摘要见 RecordVersionSummaryDto。
   * 无修改历史（version=1 且未经历异议/撤回）为空数组。
   */
  versions: readonly RecordVersionSummaryDto[];
}

/** POST /records/{id}/acknowledge 请求体（F2-04/DATA-08/DEP-08：逐条"已知晓"，TK-19） */
export interface AcknowledgePayloadDto {
  /** 待知晓的标红确认行 id 集合（alerts.id；跨单/不存在的 id 被忽略，容错口径同提交侧 confirmations） */
  alert_ids: readonly number[];
}

/** POST /records/{id}/acknowledge 响应体：本次**新写入**知晓标记的行数（已知晓行不重复计数） */
export interface AcknowledgeResultDto {
  acknowledged: number;
}

/** POST /records/{id}/confirm 请求体（F2-05：签名归档，TK-19） */
export interface ConfirmPayloadDto {
  /**
   * 接班人签名图：PNG data URL（h5 签名板 canvas toDataURL 产物）。服务端解码校验
   * （data:image/png;base64 前缀 + PNG 魔数，≤ 512KB）后落盘，路径记 signature_path。
   */
  signature: string;
}

/** POST /records/{id}/confirm 响应体（F2-05 归档回执；双方姓名/确认时间/签名图经 GET /records/{id} 可查） */
export interface ConfirmResultDto {
  id: number;
  record_no: string;
  /** 归档后恒 'completed'（技术方案 §5.4 状态机） */
  status: RecordStatus;
  version: number;
  /** 确认归档时刻（服务端收到时刻，DATA-09 同口径） */
  confirmed_at: string;
  /** 接班人（=确认签名者；无排班为 null） */
  receiver: { id: number; real_name: string } | null;
  /** 签名图路径（静态可查） */
  signature_path: string;
}

// ── 契约 §3.2/§3.4 异议与版本（TK-20；F2-06、F2-07；决策记录 D-T23）─────────────────

/** POST /records/{id}/objection 请求体（F2-06：接班人标注异议退回交班人） */
export interface ObjectionPayloadDto {
  /** 异议原因（必填，空白 400 点名；落 records.objection_note，列容量 varchar(500) 超长 400 越界） */
  note: string;
}

/** GET /records/mine/objections 的单行（F2-06-T1「退回交班人」：交班人的待处理清单） */
export interface ObjectionRecordDto {
  id: number;
  record_no: string;
  duty_date: string;
  /** 恒 'objection'（技术方案 §5.4 状态机：已提交 →（异议）有异议） */
  status: RecordStatus;
  version: number;
  submitted_at: string | null;
  /** 异议原因（接班人标注时填写，objection_note 原文） */
  objection_note: string;
  /** 异议发起时刻（objection_at；24 小时升级计时起点，升级随 TK-22） */
  objection_at: string;
  /** 标注异议的接班人（回显姓名，交班人核对「谁退回的」） */
  receiver: { id: number; real_name: string } | null;
}

/** GET /records/mine/objections 响应体（按 duty_date 降序） */
export interface ObjectionListDto {
  items: readonly ObjectionRecordDto[];
}

/** POST /records/{id}/objection 响应体（标注回执；交班人侧经 mine/objections 与详情可查） */
export interface ObjectionResultDto {
  id: number;
  record_no: string;
  /** 标注后恒 'objection'（技术方案 §5.4 状态机） */
  status: RecordStatus;
  version: number;
  objection_note: string;
  objection_at: string;
}

/**
 * PUT /records/{id} 请求体（F2-07：异议单修改，决策记录 D-T23 拍板）。
 *
 * `sections` 为**部分合并语义**：仅上送的字段被写入（异议修改场景是「改值」，
 * 未上送的字段保持原值——与提交协议的「全量快照」语义不同，故不复用 SubmitPayloadDto）。
 * 字段级形状校验（枚举/数值/长度/停机清列）与 submit 同一 normalizeSections；
 * **必填完整性不在此校验**（允许分次修改，完整性在 resubmit 把关——契约「重新走提交校验与计算」）。
 * 用量列（*_use）不接受修改：重提时服务端重算固化（契约 §4 第 3 步同源）。
 */
export interface RecordUpdatePayloadDto {
  sections: Readonly<Partial<Record<RecordFieldName, unknown>>>;
}

/** PUT /records/{id} 响应体（修改回执；快照/变更明细经 GET /records/{id} 的 versions 可查） */
export interface RecordUpdateResultDto {
  id: number;
  record_no: string;
  /** 修改不改变状态：仍 'objection'，重提才转回 submitted（D-T23） */
  status: RecordStatus;
  /** 修改不改版本号：version+1 只发生在 resubmit（契约 §3.2「版本+1」挂 resubmit 行） */
  version: number;
  /** 本次落库的变更字段（字段字典名，相对本版本首改前基线；快照行首改定格） */
  changed: readonly string[];
}

/**
 * POST /records/{id}/resubmit 请求体（F2-07：异议修改后重提，D-T23 拍板）。
 *
 * 表单值**不上送**——以 PUT 已写入行的值为准（重提从行上读数重走校验/防呆/计算，
 * 与 submit 消费同一套函数，防两套口径）；本请求体只携带需交互补收的两类协议项，
 * 均可选（防呆 409 确认重提与用量覆盖协议，消费口径与 §4 完全相同）。
 * 不收 `prev_readings`：补录属原始提交语境，重提以上一班行或原提交补录审计为基线。
 */
export interface ResubmitPayloadDto {
  /** 防呆确认（TK-14 消费口径同 submit：409 need_confirm 弹窗收集后随重提上送） */
  confirmations?: readonly ConfirmationPayload[];
  /** 用量手工覆盖（TK-13 消费口径同 submit：reason 必填，覆盖值固化并写审计） */
  usage_overrides?: readonly UsageOverridePayload[];
}

/** POST /records/{id}/resubmit 响应体（重提回执；PRD 附录 A：重新提交即更新交接时间） */
export interface ResubmitResultDto {
  id: number;
  record_no: string;
  /** 重提后恒 'submitted'（技术方案 §5.4 状态机：有异议 →（修改重提，版本+1）已提交） */
  status: RecordStatus;
  /** 原版本 + 1（历史版本经 record_versions 保留，GET /records/{id} versions 可查） */
  version: number;
  /** 重提时刻 = 服务端收到时刻（DATA-09 同口径；覆盖原 submitted_at） */
  submitted_at: string;
  /**
   * 下游重算结果（TK-16 挂账闭环：异议修改触发重算复用 recalcDownstream，D-T21）：
   * 仅紧邻 D+1 且 status='submitted' 的下游单、water/e/gas 三项、手工覆盖豁免（D-T07）、
   * 数值判等无变化不写审计（M1）。无变更且无待复核项时为 null。
   */
  recalc?: RecalcResultDto | null;
}

/**
 * 单条历史版本摘要（GET /records/{id} 的 versions，F2-07-T1「历史版本可查」）：
 * record_versions 行的查询面——全字段快照留在库内（snapshot 列）不入响应，
 * 摘要携带版本号/修改人/时刻与变更字段旧值新值（F2-07-T1 判据四要素的后三者）。
 */
export interface RecordVersionSummaryDto {
  /** 被替换的版本号（UNIQUE(record_id, version)；当前 version 恒大于全部摘要行） */
  version: number;
  /** 修改人（editor_id 联 users 回显；账号被删为 null） */
  editor: { id: number; real_name: string } | null;
  /** 修改时刻（record_versions.edited_at） */
  edited_at: string;
  /** 变更字段：字段字典名 → { 旧值, 新值 }（快照基线 vs 修改后） */
  changed: Record<string, { old: unknown; new: unknown }>;
}

// ── 契约 §3.3 GET /elevators/expected（电梯逐台预期状态；ELE-03；TK-17/D-T22）─────────

/** 单台电梯的预期状态（打开电梯板块时逐台展示「预期：运行/停运」，ELE-03） */
export interface ElevatorExpectedItemDto {
  id: number;
  name: string;
  /** 运行计划三选一（ELE-02；回显供前端展示计划说明，不重查字典） */
  plan_type: ElevatorPlanType;
  /** 运行时段（§4.2 windows JSON 原样回显；前端渲染「06:00–21:00」类说明） */
  windows: unknown;
  /** 长期停运原因（plan_type='stopped' 时展示） */
  stop_reason: string | null;
  /** 按本响应 check_time 计算的预期状态（脏配置回落 run，shared expectedStatusAt） */
  expected: ElevatorExpected;
}

/**
 * GET /elevators/expected 响应体（TK-17，D-T22：**只读计算不落库**——原契约「生成
 * elevator_checks 明细行」的写副作用被否决；核对结果随提交 payload 落库并锁定）。
 */
export interface ElevatorExpectedDto {
  /** 本次响应的核对时刻基准（服务端本地时间戳 `YYYY-MM-DD HH:mm:ss`）；前端锁定入草稿 */
  check_time: string;
  /** 在用（status='active'）电梯逐台预期，按 id 升序 */
  elevators: readonly ElevatorExpectedItemDto[];
}

// ── 契约 §3.2 GET /records/today/prev（上一班读数带出；F1-05、F1-15、DATA-02、F3-07；TK-07）─────────

/** 上一班已提交记录（带出数据源；只回传比对所需的最小记录级字段） */
export interface PrevRecordDto {
  /** 上一班班次起始日（C-08；恒为今日班次日期 − 1 天，见 `PrevDto.prev` 注） */
  duty_date: string;
  record_no: string;
  /** submitted / objection / completed（draft 不会出现在这里，见 `PrevDto.prev` 注） */
  status: RecordStatus;
  submitted_at: string | null;
  version: number;
  /**
   * 上一班各字段读数：snake_case 字段名 → 原值（decimal 为字符串，与 Drizzle 一致）。
   * 仅回传**字段字典内的 records 存储列**（板块 ≥1）：基础信息列在记录级字段已回显，
   * `lo_night_use` 等跨记录派生列非存储列不回传。液氧 8:30 卡的带出取值映射见 `cards.ts prevSourceField`。
   */
  readings: Readonly<Partial<Record<RecordFieldName, unknown>>>;
}

/** GET /records/today/prev 响应体 */
export interface PrevDto {
  /** 当前班次起始日（C-08）；回显供前端与 GET /records/today 的 duty_date 互核 */
  duty_date: string;
  /**
   * 首班标记（F1-15）：今日之前**无任何记录**（首次启用）→ true，
   * 前端提示「首班记录，无上一班数据可比对」。
   */
  first_day: boolean;
  /**
   * 上一班已提交记录。null 的两种语义由 `first_day` 区分（前端提示不同）：
   * - **上一班数据缺失**（F3-07，first_day=false）：今日之前有记录但**相邻班次**
   *   （duty_date = 今日班次日期 − 1 天）无行（漏交，F6-06 检测的场景）或该行为 draft
   *   （上一班未提交）→ 比对值显示"—"并允许补录上一班读数（补录入口与提交侧校验随
   *   TK-12/TK-14 落地）；
   * - **首班**（F1-15，first_day=true）：今日之前无任何记录。
   *
   * **不回落更早的历史记录**（D-T17）：F1-05 的「前一条」按班次相邻取数，跳过缺失班次取
   * 更早记录会以旧值冒充上一班（F1-05-T2 判据「不显示脏数据」），且用量计算（TK-13 复用
   * 同一取数）会把跨天用量当 1 天固化，与 F3-07「缺失 → 补录」相悖。
   */
  prev: PrevRecordDto | null;
}

// ── 契约 §3.5 GET /notifications、POST /notifications/{id}/read（站内通知；DEP-04、F2-11、F2-12、F6-06；TK-22）─────────

/** 站内通知 kind（契约 §3.5；alert_push 属 P2 预警、monitor 属监控，TK-22 仅产生前三类） */
export const NOTIFICATION_KINDS = [
  'confirm_due',
  'objection_escalated',
  'missing_submit',
  'alert_push',
  'monitor',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 站内通知单行（notifications 表行；read_at 非空即已读） */
export interface NotificationDto {
  id: number;
  kind: NotificationKind;
  title: string;
  message: string | null;
  /** 关联交接单（confirm_due / objection_escalated 携带；missing_submit 无单为 null，日期在 title 内） */
  record_id: number | null;
  created_at: string;
  read_at: string | null;
}

/** GET /notifications 响应体：当前登录人的未读通知（id 倒序）+ 未读总数（未读角标数据源，DEP-04） */
export interface NotificationListDto {
  items: readonly NotificationDto[];
  unread: number;
}

/** POST /notifications/{id}/read 响应体（幂等：已读重复调用回首次时刻） */
export interface NotificationReadResultDto {
  id: number;
  read_at: string;
}

// ── 契约 §3.5 GET /records（历史记录筛选；F5-01、F6-01；TK-24）─────────────────

/**
 * GET /records 的单行（历史记录列表）。取数口径（契约 §3.5）：`from/to/submitter_id/status`
 * 四个可选筛选参数的交集，`duty_date` 倒序；师傅看全部、科长同（登录用户）。
 * 本路由的 F6-01 半边（科长后台记录管理页）随 TK-24 落地；F5-01 半边（师傅端历史查询
 * 界面）属 P2、随 TK-35——接口先行归 TK-24（科长筛选/导出与详情查看共用同一取数）。
 */
export interface RecordListItemDto {
  id: number;
  record_no: string;
  duty_date: string;
  status: RecordStatus;
  version: number;
  submitted_at: string | null;
  /** 确认归档时刻（F2-05；未归档为 null） */
  confirmed_at: string | null;
  /** 交班人（C-05 实名） */
  submitter: { id: number; real_name: string };
  /** 接班人（带出或修改后；无排班为 null） */
  receiver: { id: number; real_name: string } | null;
  /** 标红确认项数（alerts 行数，与详情同源；无标红为 0） */
  alert_count: number;
  /**
   * 科长批注（F6-01「批注」，TK-24）：records.chief_note 当前值——覆盖式单条，
   * 历史经审计 `record.annotate`（旧值→新值）留痕；未批注为 null。
   */
  chief_note: string | null;
}

/** GET /records 响应体（按 duty_date 降序；不分页——班次一天一条，量级为日增 1 行） */
export interface RecordListDto {
  items: readonly RecordListItemDto[];
}

// ── 契约 §3.6 POST /admin/records/{id}/annotation（科长批注；F6-01；TK-24）─────────

/** POST /admin/records/{id}/annotation 请求体（F6-01「批注」：科长对交接单的管理备注） */
export interface AnnotationPayloadDto {
  /**
   * 批注内容：trim 后**空串 = 清除批注**（chief_note 置 NULL），非空 = 覆盖式写入
   * （单条当前值，历史经审计 `record.annotate` 留痕）；上限 500 字（越界 400 点名）。
   */
  note: string;
}

/** POST /admin/records/{id}/annotation 响应体（批注回执；当前值经 GET /records 与详情可查） */
export interface AnnotationResultDto {
  id: number;
  record_no: string;
  /** 批注后的当前值（清除后为 null） */
  chief_note: string | null;
}

// ── 契约 §3.6 GET /admin/missing-submits（应提交未提交视图；F6-06；TK-23）─────────

/** 应提交未提交视图行：漏交班次的日期与排班人（与 missing_submit 通知同源判定，TK-22） */
export interface MissingSubmitItemDto {
  /** 排班日（班次起始日，C-08）；同 missing_submit 通知 title 的日期部分 */
  duty_date: string;
  /** 排班师傅用户 id */
  user_id: number;
  /** 排班师傅姓名（通知 message 的排班人同源） */
  real_name: string;
}

/** GET /admin/missing-submits 响应体：当前仍构成漏交的班次集合（duty_date 倒序，最近在前） */
export interface MissingSubmitListDto {
  items: readonly MissingSubmitItemDto[];
}

// ── 契约 §3.6 人员管理（GET/POST /admin/users、PATCH /admin/users/{id}；F6-02；TK-25）─────────

/** GET /admin/users 单行（users 表查询面；passwordHash 凭证不出网） */
export interface UserListItemDto {
  id: number;
  /** 登录名（C-05 实名一人一号，唯一） */
  username: string;
  real_name: string;
  role: UserRole;
  /** active 在用 / disabled 停用（停用即不可登录，契约 §1：服务端删除该用户全部 sessions 存根） */
  status: UserStatus;
  /** 开通时刻（users.created_at） */
  created_at: string;
}

/** GET /admin/users 响应体（全量账号，id 升序 = 开通顺序；科长对师傅账号启停，科长行只读展示） */
export interface UserListDto {
  items: readonly UserListItemDto[];
}

/** POST /admin/users 请求体（F6-02「开通师傅账号」；角色恒 master，科长账号不走本接口开通，D-T25） */
export interface UserCreatePayloadDto {
  /** 登录名：1~32 位字母/数字/下划线（users.username varchar(32)，UNIQUE，重复 400 点名） */
  username: string;
  /** 姓名（实名制 C-05）：1~32 字 */
  real_name: string;
  /** 初始密码：8~64 字（bcrypt 加盐哈希落库，明文不回显不出网） */
  password: string;
}

/** POST /admin/users 响应体（开通回执 = 创建后的账号行） */
export type UserCreateResultDto = UserListItemDto;

/** PATCH /admin/users/{id} 请求体（F6-02「停用/启用」：Phase 1 的账号管理动作仅状态启停一项，D-T25） */
export interface UserStatusPatchPayloadDto {
  status: UserStatus;
}

/** PATCH /admin/users/{id} 响应体（启停回执 = 更新后的账号行） */
export type UserStatusPatchResultDto = UserListItemDto;

// ── 契约 §3.6 排班管理（GET/PUT /admin/schedules；F6-03/F6-04；TK-26）─────────

/**
 * GET /admin/schedules 单行（schedules 行查询面）。月视图为**稀疏列示**——仅列该月内
 * 有排班的日期（无排班日不出行，前端渲染空位）；一天一人（duty_date UNIQUE，契约 §3.6）。
 */
export interface ScheduleItemDto {
  /** 值班日期（C-08 班次起始日同语义；接班人带出取其 +1 天行，F2-01） */
  duty_date: string;
  /** 值班师傅用户 id */
  user_id: number;
  /** 值班师傅姓名（联 users 回显；停用账号的历史排班仍回显原名） */
  real_name: string;
  /** 排班最后修改时刻（schedules.updated_at；从未改动为 null） */
  updated_at: string | null;
}

/** GET /admin/schedules 响应体（`?month=YYYY-MM` 缺省当前墙钟月；duty_date 升序） */
export interface ScheduleMonthDto {
  /** 查询月份回显（YYYY-MM，服务端归一后返回——前端据此核对与上/下月翻页） */
  month: string;
  items: readonly ScheduleItemDto[];
}

/**
 * PUT /admin/schedules 请求体（F6-03「科长维护，改即审计」）：**单日单条**维护——
 * 一次 PUT 改一天（月视图逐日行内下拉直改，demo 口径），同日已有排班即为改派
 * （upsert，非追加）；同值重复 PUT 值无变化不写审计（D-T21 M1 同一精神）。
 */
export interface SchedulePutPayloadDto {
  /** 值班日期（YYYY-MM-DD 日历有效；非日历日 400 点名 duty_date） */
  duty_date: string;
  /** 值班师傅（须为存在的师傅账号；chief 目标与未知 id 400 点名 user_id） */
  user_id: number;
}

/** PUT /admin/schedules 响应体（维护回执；changed=false 即值无变化、未写审计） */
export interface SchedulePutResultDto {
  duty_date: string;
  user_id: number;
  real_name: string;
  /** 本次是否实际变更（同值重复 PUT 为 false 且不写审计） */
  changed: boolean;
  /** 排班最后修改时刻（本次变更即当前时刻；从未改动的旧行为 null） */
  updated_at: string | null;
}
