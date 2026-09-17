# 技术方案与数据库设计 — Handover · 新院区总务交接班数字化系统（v0.2）

- **关联文档**：《PRD 讨论稿 v0.2.8》（需求依据）、《决策记录 v1.1》（关键决策与理由）
- **读者**：总务科（业务核对）、信息科（部署与运维评估）、开发方
- **生成时间**：2026-08-28（v0.2 为同日数据库设计评审修订）
- **状态**：v0.1 已获总务科确认（2026-08-28）；v0.2 为评审修订（见下方修订记录），待总务科复核；技术栈已确认为 TS 全栈（2026-08-31），剩部署资源等确认项见 §9

---

## v0.2 修订记录（2026-08-28，数据库设计评审）

1. **口径矛盾修正（§4.3）**：原文"差值计算均为查询，无需冗余存储"与 records 的 `*_use` 固化列矛盾——现明确用量在提交时由服务端计算并固化，并新增重算规则（上一班记录晚到或异议修改后自动重算下游用量并写审计）
2. **天然气充气防呆改按单卡判定（§4.3、§5.2）**：原"合计为负才触发"会漏掉单卡小幅充气叠加另一卡正常用量的情况；明确充气卡当日用量按 0 计、另一卡正常计算
3. **records 补列**：`objection_at` / `escalated_at`（异议 24 小时升级的计时起点与去重）、`coolroom_note`（对齐其余状态字段的异常说明列）、水泵水位按 1/3 号楼拆分并补高度数值列（对齐 PRD 附录 A"状态+数值"）
4. **新增表**：`notifications`（站内通知：超时提醒/异议升级/预警推送/监控告警，未读角标数据源）、`spots`（巡检点位字典，承载 PRD §6.0 管理后台"点位字典"）
5. **alerts 泛化为确认项总账（§5.3）**：Phase 1 表单级标红项与交接事项确认同样落库，并补结构化目标列 `target`
6. **审计补强（§5.5）**：排班、电梯字典、点位字典、账号开通/停用纳入审计；audit_logs 增 `reason` 列承载覆盖/充气/防呆确认原因
7. **其他**：全表显式 ENGINE=InnoDB DEFAULT CHARSET=utf8mb4；attachments 补 `created_at`（上传时刻）；record_versions 加 UNIQUE(record_id, version)；删去与 UNIQUE(duty_date) 重复的 idx_duty；configs.config_value 改 TEXT（承载新风位置、锅炉清单等列表值）；elevator_checks.actual 取消默认值、NULL 表示未核对；§1 版本引用更正为 PRD v0.2.2；§11 补三项待定义边界场景（调班、服务端 draft 时机、液氧换罐）
8. **补充修订（2026-08-29）**：§4.3 重算规则补豁免条款（不覆盖师傅手工修正过的用量字段）；§5.3 明确交接事项有内容时按条拆分为多条确认行（对应 PRD 附录 A 第十板块"逐条确认"）；PRD 引用更新至 v0.2.3；正文"--"笔误统一为"——"
9. **排班范围联动（2026-08-31）**：PRD v0.2.4 定案最小排班+安全阀；§11 调班边界场景关闭（交班人恒以登录账号为准，登录≠排班时提示确认并写审计，不建换班审批流）；notifications.kind 增 missing_submit（应提交未提交提醒，定时任务按排班表扫描）
10. **液氧两罐轮换联动（2026-08-31）**：PRD v0.2.5 新增换罐线 2.5（中预警，configs key: lo_switch）与补液线 2.0（高预警）构成双档；在用罐由枚举选择驱动卡片标题动态"在用/备用"，日间用量按所选罐取数
11. **液氧测量时刻联动（2026-08-31）**：PRD v0.2.7 定案液氧两时点读数自动记录实际测量时刻（名义时段 8:30/20:30 仅用于卡片组织，用量与防泄漏窗口口径不变）；records 增 `lo_measured_am` / `lo_measured_pm` 两列（前端填写时自动写入，含离线本地时间戳）；头部与 §1 的 PRD 引用更新至 v0.2.7
12. **液氧夜间用量联动（2026-08-31）**：PRD v0.2.8 定案夜间用量口径——跨记录自动计算"昨日 20:30 → 今日 8:30"差值，换罐日（两条记录 tank_in_use 不同）不计算并标注"当日换罐"；§4.3 口径由"待确认"转确认，夜间防泄漏窗口（降幅 0.8）随之解锁；§10 Phase 2 夜间液氧窗口监控由"若口径确认"转确定上线；§11 换罐边界场景关闭；头部与 §1 的 PRD 引用更新至 v0.2.8
13. **决策记录建立（2026-08-31）**：《决策记录 v1.0》产出（产品/技术/流程三类编号，记"为什么这么定"与当时备选），关联文档指针由"待建"更新为《决策记录 v1.0》
14. **技术栈确认闭环（2026-08-31）**：总务科确认采用 TypeScript 全栈（决策记录 D-T01 转 ✅）；§2 取舍记录与 §9 第 1 项同步关闭，剩服务器资源、数据库实例、账号体系三项待信息科；决策记录指针更新至 v1.1
15. **会话载体定案（2026-09-02）**：TK-04 认证模块开工前定案 **D-T13**（服务端会话落库 + Cookie/Bearer 双通道）——§4.1 表清单与 §4.2 增 `sessions` 表（**第 13 张**：`token_hash` 主键存 SHA-256 摘要、`user_id`、`ip`、`user_agent`、`channel`、`created_at`/`last_seen_at`/`expires_at`），§6 补「会话机制」段（双通道共用同一存根、滑动超时取 `configs.session_timeout_minutes`、登出/停用即时撤销、定时清理过期行）；否决 JWT 无状态与内存 session 的理由见决策记录 D-T13。联动：《API 契约》§1 认证行由「建立会话（Cookie）」扩为双通道、《开发种子数据》增 `session_timeout_minutes` 键（默认 720，❓ 待科长确认）。**表数由 12 张变 13 张**，TK-02 判据「schema 与 §4.2 DDL 逐列核对无异」随之覆盖新表（需新增 drizzle 迁移）
16. **今日交接首页落地（2026-09-03）**：TK-05 实现契约 §3.2 首条路由 `GET /api/v1/records/today`（挂 SessionGuard + `@Roles('master','chief')`，后者依据契约 §1「chief：全部 + 配置」）。**§11 第二项「服务端 draft 行的产生时机」部分明确**：读接口不产生 draft 行（定案理由与否决备选见决策记录 **D-T15**），写入时机仍待 TK-08 闭环。**本任务无表结构变更**（records/spots 均为 §4.2 已有表，duty_date UNIQUE 即 F1-01 的落地保障），故 §4.2 DDL 不变；新增一项配置键 `shift_start_time`（班次分界时刻，作为 C-08 `duty_date` 归属的判定基准，种子值 08:30 ❓ 待科长确认）——属配置层而非表结构（D-T06「自定义灵活性放配置层」），详决策记录 **D-T14**。卡片→字段映射不入表而落 `packages/shared/src/cards.ts`（属 DATA-11 表单结构范畴，需三端同源），spots 表仍只承载点位存在性与顺序（F6-07 后台可维护）。
17. **上一班带出取数口径定案（2026-09-11）**：TK-07 评审发现 §4.3「上一班读数回填是"按 `duty_date` 取前一条已提交记录"的实时查询」存在读法分歧——按「过滤已提交后取最近一条」直读，漏交日（相邻班次无记录，F6-06 检测的场景）会回落更早记录并以旧值冒充上一班，与台账 F1-05-T2 判据「昨日无已提交记录 → 无带出值」冲突，且用量计算（本节与带出同一取数）会把跨天用量当 1 天固化。按决策记录 **D-T17** 定案：「前一条」= **相邻班次**（duty_date 恰为今日班次日期 − 1 天，日历事实复用 `records/duty-date.ts minusOneDay`），「已提交」作**资格条件**（submitted/objection/completed，均为提交后状态）；相邻日无行或为 draft → 缺失态（F3-07），**不回落更早记录**。带出与用量计算（TK-13）共用同一取数实现。本条为口径读法精确化，不改变 §4.3 计算公式本身。
18. **草稿层离线优先定案（2026-09-11）**：TK-08 实现 F1-09——草稿自动保存与续填由客户端 IndexedDB 草稿层承担（§5.1 三层缓冲之一，D-T10；`apps/h5/src/store/draft-db.ts` + `store/draft.ts`：改动约 2 秒防抖自动保存、pagehide 冲盘、建立登录态后按 `draft:{user_id}:{duty_date}` 恢复并提示）。**§11 第二项「服务端 draft 行的产生时机」就此关闭（决策记录 D-T18）**：服务端不设在线草稿端点（契约 §3.2 GET/PUT /records/today/draft 两行暂缓），records 行提交时一次性创建（record_no 生成时机不变）、draft 状态仅由撤回产生；tombstone 语义（持久草稿清除只随本人登出/本人会话失效，登录 401 不清本机草稿）随 TK-08 批注落码——**（2026-09-11 评审后修订：清除时点改定为「该班次出现已提交记录」，登出/会话失效仅清会话内内存，原文保留备查，见决策记录 D-T18 修订 #9）**。联动：API 契约订正 7、台账增补 #12、任务分解修订 #17。本条无表结构变更。
19. **防呆判定范围与补录协议定案（2026-09-13）**：TK-14 实现防呆三则（F1-12/F1-13/F3-07），判定范围与补录载体按决策记录 **D-T19** 落地——§5.2 防呆规则的实现落点：判定层 shared `guard.ts` 纯函数（判定范围 = 累计走字表三字段 water/e1/e2 + 两气卡，液氧含量递减是常态不入回退判定），api submit 按契约 §4 第 2 步返 409 + `need_confirm` 可解释清单；确认消费口径（reason 空白视为未确认、错位确认不消费、仅命中项写审计）与充气确认取数层（确认卡按 0 计，经 `gasDayUseOf` 的 `refilled` 参数）见契约订正 15；上一班缺失时补录读数随 payload `prev_readings` 上送（仅非首班缺失态消费）、不落 records 列，以审计 `record.prev_backfill` 留痕。本条为落点回填，不改变 §5.2/§4.3 规则本身；无表结构变更。
20. **待同步队列落地口径（2026-09-13）**：TK-15 实现离线三层缓冲的**待同步队列**（F1-06/F1-07/F1-14），边界按决策记录 **D-T20** 定案——§5.1 补实现落点段（IndexedDB `sync_queue` store、DB_VERSION 2 并补 `onblocked` 回调兑现 TK-08 挂账；离线提交本地同口径预检 + 防呆确认前置入队；online 事件/登录就绪/手动触发排空，按 `queued_at` 升序排队送达；待同步期间草稿仍为权威数据源、payload 随自动保存刷新；滞留强提醒以 `duty_date` 早于当前班次为准、不可忽略 overlay 门控自动排空）。同时 need_confirm 清单组装自 records.service 下沉 shared `guard.ts`（h5 离线预检与 api 同源，行为不变）。照片暂存区随 TK-36；EVT-04/05 上报挂 TK-30。本条无服务端表结构与接口变更。
21. **待同步队列评审修复轮（2026-09-13）**：TK-15 独立评审（M1–M6 + L1–L6，M3/M4/M6 探针实证）后修订 §5.1 落地口径，边界补充见决策记录 **D-T20 修订**——① **跨班次滞留单禁止上传**（服务端 submit 只认当前班次 C-08，跨班次上传必然落错日期），排空引擎固化「需科长处理」并跳过，强提醒 overlay 处置动作改「联系科长」指引；补交端点属契约变更挂待拍板决策；② 排空成功后的草稿清除改**统一冲账**（登出/401 中途失效也不漏清）；③ 同步在途锁开卡与新提交，在途补改完成后显式提示；④ 离线预检始终执行、确认清单入队即清（确认不跨提交复用）；⑤ 补录读数校验下沉 shared（api 与 h5 同源）；⑥ IndexedDB `onversionchange` 主动放行 + 开库超时；⑦ 登录页提示本机不分账号的未同步单数。同步上传的 201 拦截 mock 须在离线入队之后注册（setOffline 下拦截仍生效，否则离线分支测不到）；F1-14-T1 断言已按 M1 翻转（跨班次项零上传请求）。本条无服务端表结构与接口变更。
22. **下游重算与补交端点落地口径（2026-09-13）**：TK-16 实现 F3-08（决策记录 **D-T21** 拍板）——§4.3 重算规则补实现落点：新增路由 `POST /records/backfill`（跨班次补交：duty_date 显式且严格早于当前班次、提交人恒为登录人本人、其余校验/防呆/覆盖/补录协议与 /today/submit 同口径，服务端 submitCore 单一实现）；补交成功后**同事务**重算紧邻下游 D+1 已提交记录的 water/e/gas 三项 prev 依赖用量（四类口径均只依赖紧邻上一班，故重算范围恰为 D+1；液氧日间用量不依赖上一班不在范围）；豁免 = 当前版本 `record.usage_override` 审计行（D-T07，与 F3-06-T1 manual 旗标同源，TK-13 评审 M1）；值无变化不更新不写审计；下游原提交确认充气的卡延续按 0 计（D-P14，从 record.submit 审计 type=gas_refill 行反查）；审计 `record.late_submit` + 逐变更项 `record.recalc`（契约订正 17）；F6-06 漏交检测以 records 行存在为准，补交日自此不再计漏交。异议修改（TK-20）触发重算时复用同一 recalcDownstream 服务方法。本条新增一条路由，无表结构变更。
23. **TK-16 独立评审修复轮（2026-09-14）**：评审报告 M1 + L1–L9 + m1–m5，M1/L1 与四项语义（L2/L3/L5/L6）已处置，§4.3 实现落点段同步订正——① **M1 数值判等**：修订 22 写的「值无变化不更新不写审计」在实现上**不成立**（字符串比较 '500' vs DECIMAL 列读回的 '500.0'，整数用量恒被误判为变更→假 UPDATE + 假审计，探针实证），现按数值判等；② **L1**：无变更且无待复核项时 `recalc` 为 null（原返回空数组对象）；③ **L2 状态门控（拍板）**：只重算 status='submitted'，**不静默改 objection/completed**（签名归档件与 record_versions 快照不得背离），跳过时留日志；④ **L3 补交窗口（拍板）**：configs 新增 `backfill_window_days`（种子 7，❓ 待科长确认）作为 duty_date 下限，与 `DEFAULT_BACKFILL_WINDOW_DAYS` 常量同源；表数不变、**配置键 19 → 20**（《开发种子数据》修订 6）；⑤ **L5 draft 接管（拍板）**：补交仅对非 draft 行 409，draft 行走更新+version+1（消除「撤回后离院」的永久死角）；⑥ **L6 待复核清单（拍板）**：重算不重跑防呆拦截但命中时标 `recalc.needs_review` + 审计 `record.recalc_review`（不改数、不 409）；⑦ **m4 审计 action 清单补登记**：§4.2 `audit_logs.action` 注释新增 `record.late_submit` / `record.recalc` / `record.recalc_review` 三个取值（列为 VARCHAR(64) 非枚举，无结构变更）。联动：契约订正 18、台账增补 #28、决策记录 D-T21 修订（增补 14）、任务分解修订 31。
24. **TK-16 修复轮红队对抗评审（2026-09-14）**：针对修订 23 的修复本身（六攻击面），结论**无 M 级缺陷、修复轮保持 ✅**，六处文档一致。处置：① needs_review 的确认复用改为**值匹配**（回退按 field+prev+current 三元组，shared guard 新增 `decreaseHitKey`/`needConfirmItemsExcludingHits`、service 新增 `confirmedDecreaseHitsOf`；字段级复用会让新基线下更大的回退被旧确认静默解锁，D-T20 M6 同族陷阱——评审一轮建议的字段级复用不采纳）；② draft 接管的 `record.late_submit` 补记 `prev_submitter_id`；③ `sameUsageValue` 冗余三元简化、补交窗口单次读取。不成立项与详细裁决见任务分解修订 32。联动：契约订正 19、台账增补 #29、决策记录增补 15、任务分解修订 32。
25. **电梯核对落地口径（2026-09-14）**：TK-17 实现 ELE-02~07/09（决策记录 **D-T22** 拍板，载体变更）——§4.2 elevator_checks 表的实现落点：核对结果随提交 payload `elevator_checks[]` 在 records.service submitCore 同事务写入（先清后插快照语义，重提不残留旧版核对）；GET /elevators/expected 为**只读计算端点**（elevators 模块，active 行逐台按服务端当前时刻经 shared elevator.ts expectedStatusAt 计算，**不生成明细行**——原「打开板块时生成明细行」的写副作用与「records 行提交时一次性创建」（D-T18）冲突，同 §11 第二项的否决逻辑）；expected 落库值由服务端按 payload 上送的 check_time（核对时刻）重算，提交/重提时刻不参与计算（ELE-05「核对时刻锁定」的实现口径）；不一致（actual≠match，含 fault）同事务追加 alerts 标红行（rule_key=elevator_mismatch、level=mid），409 ELEVATOR_EXPLANATION_REQUIRED 位于防呆 409 之后；校验纯函数 shared validateElevatorChecks（api 与 h5 离线预检同源）。判定细则：窗口区间 [start,end) 起含止不含、支持跨零点与多窗口；零长度窗口全天停运；scheduled 脏配置回落 run（不放大为满屏「预期停运」）。电梯卡角标维持 0/0（分母口径 D-T16 为字段维度，逐台核对不计入）。
26. **TK-17 独立评审修复轮（2026-09-15）**：探针实证两处 M 级后修订 §4.2/§5.2 的电梯落点——① **`elevator_checks.check_time` 的产生方**：客户端师傅落笔瞬间的本机时钟（D-T22 修订⑤，与 `lo_measured_am/pm` 的 DATA-13 同口径），h5 同时按该时刻用快照自带 `plan_type/windows` 本地重算 expected 后上送（服务端仍复算为准）；原实现沿用「打开板块时拉到的快照时刻」，离线或页面挂机后重开会记入一个没发生过的核对时刻并算错预期（漏报「该停没停」）。② **重提快照扩至 alerts**：submitCore 事务内 `elevator_checks` 与 `alerts` 同先清后插（标红确认行由本提交生成，契约 §4 第 4 步），否则过期标红累积、TK-19 逐条知晓失真。③ 校验面：`elevator_id` 严格整型（禁 Number() 宽松转换，防串台落库）、脏核对项点名带序号（防 C-09 面板 :key 碰撞）。④ 客户端 409 处理与 400 归一（带 `missing_fields` 即逐条点名 + 跳转、不清已收集的防呆确认）。⑤ 测试：接口层补注入固定时刻的黄金值用例（原以 shared 函数复算响应值属同源自证）。联动：决策记录增补 17、契约订正 21、台账增补 #31、任务分解修订 34。
27. **异议与版本落地口径（2026-09-15）**：TK-20 实现 F2-06/F2-07（决策记录 **D-T23** 拍板）——§5.4 异议段状态机补实现落点：`POST /records/{id}/objection`（仅接班人本人、note 必填、行锁下转 objection）+ `PUT /records/{id}`（仅交班人本人、部分合并直写行、首改快照入 record_versions、changed 累计口径）+ `POST /records/{id}/resubmit`（version+1、重走提交校验/防呆/计算、alerts 先清后插重建、objection_note/at 保留、下游 D+1 重算 trigger=objection_resubmit）；历史版本摘要经 GET /records/{id} versions 可查；重提审计复用 record.submit（newValue 记 resubmitted）。**TK-16 挂账闭环**：recalcDownstreamInTx 下游行 SELECT ... FOR UPDATE（并发触发源读-改-写串行化）+ submitCore 事务 ER_DUP_ENTRY（errno 1062）捕获归一 409 RECORD_EXISTS（契约订正 18 ⑧）。无表结构变更；无新增路由（四条异议路由均属契约 §3.2/§3.4 既有行）。联动：契约订正 24、决策记录增补 18、台账增补 #34、任务分解修订 37。

---

## 1. 方案概要

本方案实现 PRD v0.2.8 定义的系统：移动端优先的 H5 交接班系统，部署于医院内网，支持离线填写、用量自动计算、阈值预警、逐项确认与电子签名、全程留痕。

**架构一句话**：师傅手机上的 H5 页面负责采集与展示，院内服务器上的后端服务负责全部规则与流程，MySQL 存数据，服务器磁盘存照片；所有规则集中在服务端，配置修改即时全员生效。

**一个有利的先天条件**：一天一条记录、当班师傅是唯一写入人、接班人只读（修改走异议留痕），因此离线同步无需"冲突合并"，简化为"排队送达"——这是整个方案里最复杂模块得以简化的根本原因（源自 24 小时班制设计）。

---

## 2. 技术选型总表

| 层 | 选型 | 理由摘要 |
| --- | --- | --- |
| 手机端 | Vue 3 + TypeScript + Vant | H5 免安装免更新，内网唯一可行形态（小程序依赖公网已排除）；Vant 移动组件适合大字号大按钮 |
| 科长后台 | Vue 3 + Element Plus（同框架） | 桌面表格/配置/趋势图；一套技术栈便于接手 |
| 样式 | 组件库主题变量 + Tailwind | 主题变量改全局观感，Tailwind 管布局与定制卡片，无样式文件漂移 |
| 后端框架 | NestJS（TypeScript） | 结构化模块、守卫（权限）、拦截器（审计）、官方定时任务；对比 Hono 选它因"结构由框架保证，不依赖个人自律" |
| 数据层 | Drizzle | SQL 式查询直观可读（用户明确要求）、类型自动推断、同时支持 MySQL/PostgreSQL |
| 数据库 | MySQL | 信息科熟悉度优先（本方案兼容 8.0+；若信息科更熟 PostgreSQL 可平替，Drizzle 与表结构均不受影响） |
| 端到端测试 | Playwright + TypeScript | 独立于后端语言；PRD 验收标准（Given/When/Then）逐条转自动用例 |
| 单元测试 | Jest（NestJS 标配） | 用量计算、预警规则等纯逻辑 100% 覆盖 |
| 部署 | Docker + Nginx，院内服务器 | 一键部署、环境一致；手机经院内 WiFi 访问 |
| 照片存储 | 服务器本地磁盘 + 目录规范 | 内网无对象云；手机端压缩至约 500KB 后上传 |

**选型中的关键取舍记录**（为什么是这些）：

- H5 而非 App/小程序：内网部署排除小程序；App 需逐台安装与追更新，H5 服务器端更新一次全员生效
- TS 全栈而非 Django/Java：前端、后端、测试统一语言与类型契约，数据字典定义一次三处生效；**已于 2026-08-31 获确认采用 TypeScript 全栈**（决策记录 D-T01），原"信息科若只维护 Java 则后端平替 Spring Boot"的备选关闭
- NestJS 而非 Hono：审计拦截器、定时任务、权限守卫为框架标准件；Hono 需全部自建且结构依赖自律
- Drizzle 而非 Prisma/Knex：用户要求 SQL 直观、拒绝重 ORM；Drizzle 兼具 SQL 式写法与编译期类型安全

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 师傅手机 / 科长 PC（浏览器 H5，院内 WiFi）                      │
│   Vue3 应用：表单采集 · 离线队列 · 签名 · 后台管理界面           │
└───────────────▲─────────────────────────────────────────────┘
                │ HTTPS（内网证书）
┌───────────────┴─────────────────────────────────────────────┐
│ 院内服务器                                                     │
│  ┌──────────┐   ┌───────────────────────┐   ┌────────────┐ │
│  │  Nginx   │──▶│ NestJS 后端服务        │──▶│   MySQL    │ │
│  │ 反向代理  │   │ 规则引擎/流程/权限/审计 │   │  全部业务数据│ │
│  └──────────┘   └───────────┬───────────┘   └────────────┘ │
│                             │                                │
│                 ┌───────────▼───────────┐   ┌────────────┐ │
│                 │ 定时任务（预警巡检等）   │   │ 照片文件目录 │ │
│                 └───────────────────────┘   └────────────┘ │
│                 每日自动备份 → 异地/异机留存                    │
└─────────────────────────────────────────────────────────────┘
```

后端服务内部模块划分（NestJS Module）：认证与账号、排班、交接记录（含状态机）、用量计算、预警规则、电梯字典与核对、配置中心、附件、审计、报表导出（**管理后台 admin 模块已随 TK-23 落地**：契约 §3.6 科长路由统一类级 chief 守卫（SessionGuard + RolesGuard + `@Roles('chief')`），首条落地 GET /admin/missing-submits；科长后台前端 apps/admin 同步立骨架——登录 / 会话恢复 / 无权限页 / 四页导航（记录管理、人员与排班、配置中心、审计日志），业务内容随 TK-24~29 逐页填充；**TK-24 记录管理已填充**：GET /records 列表（F6-01 科长半边，解析/筛选与导出共用 parseRecordListFilters 单一实现）+ GET /admin/records/export（CSV，AdminService 组装、RecordsService.exportRows 取数）+ POST /admin/records/{id}/annotation（批注写入在 RecordsService.annotate 记录域单一实现，admin 薄委托 + 类级守卫），apps/admin 记录管理页同步落地——筛选 / 列表 / 详情抽屉 / 批注对话框 / CSV 下载；**TK-25 人员管理已填充**：GET/POST /admin/users、PATCH /admin/users/{id}（F6-02，账号域自有实现落 AdminService——开通师傅账号角色恒 master、初始密码 bcrypt 落库；停用与审计同事务、提交后经 AuthService.revokeAllForUser 删该用户全部 sessions 存根（D-T13 停用即不可登录）；审计 `user.update` 新旧值；启停仅对师傅账号开放、chief 目标 403），apps/admin 人员管理页同步落地——账号全景表 / 开通对话框 / 停用启用二次确认（记录管理页交班人候选同步换源 GET /admin/users 全表）；**TK-26 排班管理与安全阀已填充**：GET/PUT /admin/schedules（F6-03/F6-04，排班域实现落 AdminService——GET 月视图稀疏列示、PUT 单日单条 upsert 走 INSERT…ON DUPLICATE KEY UPDATE、同值不写审计、变更与审计 `schedule.update` 同事务；驱动面零改动：接班人带出 scheduledReceiverOf 与漏交扫描 missingSubmitShifts 消费同一张 schedules 表）+ **排班安全阀 409 DUTY_MISMATCH 前置于 submitCore 防呆 409**（F6-05：duty_guard_confirm.confirmed=true 唯一解锁、排班缺失不判定、补交链路同门——D-T21 挂账归属校验闭环、审计 `record.guard_confirm` 仅命中写一行），apps/admin 排班管理卡同步落地（月视图逐日行内下拉改派，demo 口径））。

---

## 4. 数据库设计（MySQL 8.0）

设计原则：**字段结构来自纸质表单，固定列优先**（趋势与计算依赖）；自定义灵活性放在配置层（阈值、基数、电梯、清单）；结构变更走版本升级（Drizzle 迁移脚本），不做运行时自定义字段。所有金额无关，数据体量极小（约一年 365 条记录），性能不是约束，**留痕与可追溯是第一约束**。

### 4.1 表清单

| 表 | 职责 |
| --- | --- |
| users | 账号（师傅/科长），实名一人一号 |
| sessions | 会话存根：登录令牌摘要 + 设备/IP + 超时（Cookie 与 Bearer 双通道共用，D-T13） |
| schedules | 排班表：某天谁值班（驱动接班人自动带出） |
| records | 交接记录主表：状态流转 + 全部读数固定列 |
| record_versions | 记录修改历史版本（异议退回修改留痕） |
| elevators | 电梯字典：名称 + 运行计划 |
| elevator_checks | 每条记录的逐台核对明细（核对时刻锁定） |
| spots | 巡检点位字典：首页任务卡的点位展示 |
| configs | 阈值/基数/区间/清单等配置（键值 + 生效） |
| alerts | 预警/标红确认项总账：命中规则、级别、知晓状态（Phase 1 标红项同写入） |
| notifications | 站内通知：超时提醒、异议升级、预警推送、监控告警（未读角标数据源） |
| attachments | 照片附件：挂在记录+字段上 |
| audit_logs | 审计：谁何时把什么从多少改成多少 |

### 4.2 建表语句

```sql
-- 账号（实名一人一号，防共用；登录设备记入 audit_logs）
CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(32)  NOT NULL UNIQUE COMMENT '系统发号',
  real_name     VARCHAR(32)  NOT NULL COMMENT '实名',
  role          ENUM('master','chief') NOT NULL DEFAULT 'master',
  password_hash VARCHAR(128) NOT NULL,
  status        ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='人员账号';

-- 会话存根（D-T13：服务端会话落库；Cookie 与 Bearer 双通道共用同一存根）
CREATE TABLE sessions (
  token_hash   CHAR(64)     NOT NULL PRIMARY KEY COMMENT 'SHA-256(令牌) 摘要，不存明文；拖库也不能冒用在线会话',
  user_id      INT          NOT NULL,
  ip           VARCHAR(64)  NULL COMMENT '登录来源 IP（C-05）',
  user_agent   VARCHAR(200) NULL COMMENT '设备/客户端标识（C-05 登录设备可追溯）',
  channel      ENUM('cookie','bearer') NOT NULL DEFAULT 'cookie' COMMENT '凭证下发通道：浏览器 cookie / 小程序等 bearer',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最后活跃时刻（滑动超时判定）',
  expires_at   DATETIME NOT NULL COMMENT '过期时刻 = last_seen_at + configs.session_timeout_minutes',
  CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sess_user (user_id),
  INDEX idx_sess_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话存根';

-- 排班（一天一人；接班人自动带出依赖此表）
CREATE TABLE schedules (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  duty_date  DATE NOT NULL UNIQUE COMMENT '值班日期',
  user_id    INT  NOT NULL,
  updated_by INT NULL, updated_at DATETIME NULL,
  CONSTRAINT fk_sch_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='排班表';

-- 交接记录主表（一天一条；读数字段固定列，口径与纸质表单一致）
CREATE TABLE records (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  record_no      VARCHAR(20) NOT NULL UNIQUE COMMENT '如 HB-20260827-001',
  duty_date      DATE NOT NULL UNIQUE COMMENT '班次起始日（非提交日）',
  submitter_id   INT NOT NULL COMMENT '交班人',
  receiver_id    INT NULL COMMENT '接班人（排班带出，可改需留痕）',
  receiver_change_reason VARCHAR(200) NULL,
  status         ENUM('draft','submitted','objection','completed') NOT NULL DEFAULT 'draft',
  submitted_at   DATETIME NULL COMMENT '以同步成功时刻为准；重新提交则更新',
  confirmed_at   DATETIME NULL,
  objection_note VARCHAR(500) NULL,
  objection_at   DATETIME NULL COMMENT '异议发起时刻（24 小时升级计时起点）',
  escalated_at   DATETIME NULL COMMENT '升级提醒科长时刻（防重复提醒）',
  chief_note     VARCHAR(500) NULL COMMENT '科长批注（F6-01，TK-24）：覆盖式单条当前值，变更以审计 record.annotate 留痕（迁移 0002）',
  version        INT NOT NULL DEFAULT 1,

  -- 一、水
  water_reading  DECIMAL(12,1) NULL, water_use DECIMAL(12,1) NULL,
  -- 二、电（两线差值之和）
  e1_reading DECIMAL(12,1) NULL, e2_reading DECIMAL(12,1) NULL, e_use DECIMAL(12,1) NULL,
  hp_status ENUM('ok','bad') NULL, hp_note VARCHAR(200) NULL,
  -- 三、天然气（剩余量递减）
  g1_remaining DECIMAL(12,1) NULL, g2_remaining DECIMAL(12,1) NULL, gas_use DECIMAL(12,1) NULL,
  -- 四、医用气体（液氧两时点同记录；单位待现场核实）
  tank_in_use TINYINT NULL COMMENT '1/2 号',
  t1_c830 DECIMAL(8,2) NULL, t1_p830 DECIMAL(5,2) NULL,
  t1_c2030 DECIMAL(8,2) NULL, t1_p2030 DECIMAL(5,2) NULL,
  t2_c830 DECIMAL(8,2) NULL, t2_p830 DECIMAL(5,2) NULL,
  t2_c2030 DECIMAL(8,2) NULL, t2_p2030 DECIMAL(5,2) NULL,
  lo_measured_am DATETIME NULL COMMENT '早时点实际测量时刻（名义 8:30，填写时自动记录）',
  lo_measured_pm DATETIME NULL COMMENT '晚时点实际测量时刻（名义 20:30，填写时自动记录）',
  lo_day_use DECIMAL(8,2) NULL COMMENT '日间用量=在用罐8:30-20:30',
  lo_station_press DECIMAL(5,2) NULL, hbo_press DECIMAL(5,2) NULL,
  b40 INT NULL, b10 INT NULL, b6 INT NULL, b_co2 INT NULL, b_pulm INT NULL,
  manifold_press DECIMAL(5,2) NULL, co2_out_press DECIMAL(5,2) NULL,
  neg_status ENUM('ok','bad') NULL, neg_note VARCHAR(200) NULL,
  air_status ENUM('ok','bad') NULL, air_note VARCHAR(200) NULL,
  -- 五、供暖冷（停机时相关列留空）
  boiler_status ENUM('ok','bad') NULL, boiler_note VARCHAR(200) NULL,
  boiler_run ENUM('run','stop') NULL, boiler_no VARCHAR(16) NULL,
  supply_temp DECIMAL(5,1) NULL, return_temp DECIMAL(5,1) NULL,
  coolroom_status ENUM('ok','bad') NULL, coolroom_note VARCHAR(200) NULL,
  cool_run ENUM('run','stop') NULL,
  -- 六、水泵
  h1_set_temp DECIMAL(5,1) NULL, h1_out_temp DECIMAL(5,1) NULL,
  h3_set_temp DECIMAL(5,1) NULL, h3_out_temp DECIMAL(5,1) NULL,
  p1_press DECIMAL(5,2) NULL, p3_press DECIMAL(5,2) NULL,
  p1_level ENUM('ok','high','low') NULL, p1_height DECIMAL(6,2) NULL COMMENT '水位高度 m',
  p3_level ENUM('ok','high','low') NULL, p3_height DECIMAL(6,2) NULL COMMENT '水位高度 m',
  -- 七~十
  hvac_status ENUM('ok','bad') NULL, hvac_note VARCHAR(200) NULL,
  hvac_locs JSON NULL COMMENT '使用位置数组',
  energy_note VARCHAR(500) NULL, handover_note VARCHAR(1000) NULL,
  signature_path VARCHAR(200) NULL COMMENT '接班人签名图',

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_status (status),
  CONSTRAINT fk_rec_sub FOREIGN KEY (submitter_id) REFERENCES users(id),
  CONSTRAINT fk_rec_rev FOREIGN KEY (receiver_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='交接记录主表';

-- 修改历史版本（异议退回修改留痕：谁、何时、改了哪些字段、旧值）
CREATE TABLE record_versions (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  record_id  INT NOT NULL,
  version    INT NOT NULL,
  snapshot   JSON NOT NULL COMMENT '该版本全字段快照',
  changed    JSON NULL COMMENT '相对上版变更的字段与旧值',
  editor_id  INT NOT NULL,
  reason     VARCHAR(200) NULL,
  edited_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rec_ver (record_id, version),
  CONSTRAINT fk_ver_rec FOREIGN KEY (record_id) REFERENCES records(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='记录历史版本';

-- 电梯字典（后台配置；时段跨零点用 [起,止] 数组表达）
CREATE TABLE elevators (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(40) NOT NULL COMMENT '1号/扶梯/人防/发热门诊…',
  plan_type  ENUM('always','scheduled','stopped') NOT NULL DEFAULT 'always',
  windows    JSON NULL COMMENT '如 [["06:00","22:00"]]',
  stop_reason VARCHAR(200) NULL COMMENT '长期停运原因',
  status     ENUM('active','retired') NOT NULL DEFAULT 'active',
  updated_by INT NULL, updated_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='电梯字典';

-- 每条记录的逐台核对（预期状态按核对时刻计算并锁定，提交不重算）
CREATE TABLE elevator_checks (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  record_id    INT NOT NULL,
  elevator_id  INT NOT NULL,
  check_time   DATETIME NOT NULL COMMENT '核对时刻（预期状态基准）',
  expected     ENUM('run','stop') NOT NULL,
  actual       ENUM('match','run','stop','fault') NULL COMMENT 'NULL=未核对；match=核对一致；run/stop=与预期相反；fault=故障',
  explanation  VARCHAR(300) NULL COMMENT '不符必填说明',
  UNIQUE KEY uk_rec_lift (record_id, elevator_id),
  CONSTRAINT fk_chk_rec FOREIGN KEY (record_id) REFERENCES records(id),
  CONSTRAINT fk_chk_lift FOREIGN KEY (elevator_id) REFERENCES elevators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='电梯核对明细（打开电梯板块时按台生成明细行）';

-- 巡检点位字典（首页任务卡的点位展示；对应 PRD §6.0 管理后台"点位字典"）
CREATE TABLE spots (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(40) NOT NULL COMMENT '表房/液氧站/泵房/锅炉房/制冷机房…',
  sort_no    INT NOT NULL DEFAULT 0,
  status     ENUM('active','disabled') NOT NULL DEFAULT 'active',
  updated_by INT NULL, updated_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='巡检点位字典';

-- 配置中心（阈值/基数/区间/清单；每次修改写 audit_logs）
CREATE TABLE configs (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  config_key   VARCHAR(64) NOT NULL UNIQUE COMMENT '如 lo_threshold / cyl_base_co2',
  config_value TEXT NOT NULL COMMENT '阈值/基数/区间，及新风位置、锅炉清单等列表值',
  remark       VARCHAR(200) NULL,
  updated_by   INT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='配置中心';

-- 预警与标红确认项总账（Phase 1 表单级标红项——状态异常/电梯不一致/交接事项——同样写入；Phase 2 预警中心基于此表）
CREATE TABLE alerts (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  record_id    INT NOT NULL,
  rule_key     VARCHAR(64) NOT NULL COMMENT '如 lo_below_threshold / elevator_mismatch / handover_note',
  target       VARCHAR(64) NULL COMMENT '结构化目标，如 elevator:3 / field:b_co2',
  level        ENUM('high','mid','low') NOT NULL,
  message      VARCHAR(300) NOT NULL COMMENT '可解释文案：命中规则+阈值',
  acknowledged_by INT NULL, acknowledged_at DATETIME NULL COMMENT '接班人逐条知晓',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rec (record_id),
  CONSTRAINT fk_alt_rec FOREIGN KEY (record_id) REFERENCES records(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='预警/标红确认项';

-- 站内通知（接班人 2 小时未确认提醒、异议 24 小时升级、预警推送科长、监控告警；未读角标数据源）
CREATE TABLE notifications (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL COMMENT '收件人',
  kind        VARCHAR(32) NOT NULL COMMENT 'confirm_due / objection_escalated / alert_push / monitor / missing_submit（应提交未提交，定时任务按排班表扫描）',
  title       VARCHAR(100) NOT NULL,
  message     VARCHAR(300) NULL,
  record_id   INT NULL,
  alert_id    INT NULL,
  read_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user (user_id, read_at),
  CONSTRAINT fk_ntf_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_ntf_rec FOREIGN KEY (record_id) REFERENCES records(id),
  CONSTRAINT fk_ntf_alt FOREIGN KEY (alert_id) REFERENCES alerts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='站内通知';

-- 照片附件（文件存磁盘，库内记路径）
CREATE TABLE attachments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  record_id   INT NOT NULL,
  field_name  VARCHAR(64) NOT NULL COMMENT '挂在哪个字段上',
  file_path   VARCHAR(200) NOT NULL,
  size_kb     INT NULL,
  taken_at    DATETIME NULL COMMENT '拍摄时刻（EXIF）',
  uploaded_by INT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上传时刻',
  CONSTRAINT fk_att_rec FOREIGN KEY (record_id) REFERENCES records(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='照片附件';

-- 审计日志（配置修改、数据覆盖、登录事件全记录）
CREATE TABLE audit_logs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_id    INT NULL,
  action      VARCHAR(64) NOT NULL COMMENT '如 config.update / schedule.update / elevator.update / spot.update / user.update / record.usage_override / record.prev_backfill / record.late_submit / record.recalc / record.recalc_review / record.guard_confirm / login（列非枚举白名单，取值全集以《API 契约》§5 审计联动表为准）',
  target_type VARCHAR(32) NULL, target_id VARCHAR(32) NULL,
  old_value   JSON NULL, new_value JSON NULL,
  reason      VARCHAR(200) NULL COMMENT '覆盖/充气/防呆确认等原因',
  ip          VARCHAR(64) NULL, device VARCHAR(200) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_time (created_at), KEY idx_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计日志';
```

### 4.3 关键口径（以 SQL 表达，与 PRD 一致）

每日用水量 = `water_reading − 上一班 water_reading`；每日用电量 = `(e1−上一班e1) + (e2−上一班e2)`；天然气用量 = `(上一班g1−g1) + (上一班g2−g2)`；液氧日间用量 = 在用罐 `c830 − c2030`；液氧夜间用量（跨记录，v0.2.8 确认）= `今日 c830 − 昨日 c2030`（各取当时在用罐读数；今日与昨日记录的 tank_in_use 不同即换罐日，不计算并标注"当日换罐"）。

上一班读数回填是"按 `duty_date` 取前一条已提交记录"的实时查询；各 `*_use` 用量列则在提交时由服务端计算并固化（§5.2），保留交班人当时确认的数值。固化值的配套重算规则：**上一班记录晚到（离线补同步）或经异议修改读数后，自动重算下游记录的用量列并写 audit_logs**（一年约 365 条，重算无成本）。重算仅作用于自动计算字段；被师傅手工覆盖过的用量值（PRD F3，填原因留痕）不被重算覆盖。

**实现落点（TK-16，D-T21，修订 22/23）**：晚到触发点 = `POST /records/backfill`（跨班次补交，payload 显式 duty_date 严格早于当前班次且在**补交窗口**内（当前班次 − configs `backfill_window_days`，默认 7）、提交人恒为登录人本人、该班次已有非 draft 记录 409 / draft 行由补交接管为重提、其余协议与 /today/submit 同口径 submitCore 单一实现）；重算在补交的**同一事务**内执行，范围 = 紧邻下游 D+1 且 **status='submitted'** 的记录（四类用量均只依赖紧邻上一班；objection/completed 已进确认或已签名归档，**不静默改数**，L2 拍板）、字段 = water/e/gas 三项 prev 依赖用量（液氧日间用量只取本班两时点不在范围）；豁免 = 当前版本 `record.usage_override` 审计行（D-T07）；**是否变更按数值判等而非字符串**（计算侧 '500' 与 DECIMAL 列读回 '500.0' 同值，字符串判等会使整数用量恒被误判为变更，M1 探针实证）；无变更且无待复核项时不更新不写审计；下游原提交确认充气的卡延续按 0 计（D-P14）；新基线命中 D-T19 防呆判定时**不改数不拦提交**，随响应 `recalc.needs_review` 与审计 `record.recalc_review` 标出交人工核对（L6 拍板；确认复用：回退按 field+prev+current 三元组值匹配、充气按卡号，见修订 24）；审计 `record.late_submit` + 逐变更项 `record.recalc`；异议修改（TK-20）触发时复用同一 recalcDownstream 服务方法（trigger=objection_resubmit）；其前置挂账已随 TK-20 闭环（修订 27）：下游行 SELECT ... FOR UPDATE 串行化并发读-改-写，submitCore 事务捕获 MySQL 1062（ER_DUP_ENTRY）归一 409 RECORD_EXISTS。

天然气充气防呆按**单卡**判定（与 PRD F1 及 Demo 一致）：任一卡剩余量大于上一班即触发"充气确认"；确认后**该卡**当日用量按 0 计、原因留痕（audit_logs.reason），另一卡正常计算，合计为两卡之和。

---

## 5. 核心机制设计

### 5.1 离线同步（排队送达模型）

手机端用浏览器本地存储（IndexedDB）做三层缓冲：**草稿层**（每几秒自动保存当前填写内容）、**待同步队列**（离线时点击提交进入队列，附本机时间戳与完整数据）、**照片暂存区**。网络恢复后按顺序上传，服务器确认即"已同步"，此时才算正式提交、才对接班人可见。

**实现落点（TK-15，D-T10/D-T20，技术方案修订 20）**：草稿层见修订 18（TK-08）；待同步队列为 IndexedDB 独立 store `sync_queue`（库 `handover-h5` DB_VERSION 2，键 `{user_id}:{duty_date}`、顺序键 `queued_at` 本机时刻）——h5 `store/sync-queue.ts`；离线「提交」降级为**本地同口径预检**（shared validateFields / need_confirm 组装与 api 同一实现），防呆确认前置到入队前；恢复网络（`online` 事件/登录就绪/手动按钮）触发排空引擎按 `queued_at` 升序逐单上传（排队送达），上传成功才算正式提交并同步清除该班次持久草稿（与 D-T18 修订 #9 同源）；**待同步期间草稿仍是权威数据源**，队列项 payload 随草稿自动保存刷新（入队后补改不丢）；同步状态全程可见（首页同步角标由本机队列与接口 `pending_sync` OR 合并 + 队列横幅；**空态收敛见修订 33**：当日 0 项已填、无待同步且本班次未成功上传时不显角标，在线提交/排空成功以会话级 `syncedDutyDate`（h5 App.vue）记班次，保住成功后到重拉完成间的可见性）；滞留强提醒（F1-14）以队列项 `duty_date` 早于当前班次为准，全屏不可忽略 overlay，有滞留项时自动排空被门控。照片暂存区不预留 store，随 Phase 2（F7/TK-36）落地时再升版。EVT-04/EVT-05 触发点已落码，上报通道挂 TK-30。本条无服务端表结构与接口变更。

语义与 PRD 完全一致：上传成功即正式提交；同步成功前接班人端零感知；长时间未同步在交班人端持续强提醒；培训口径"看到已同步方可下班"。因单写入人模型，队列顺序即提交顺序，无冲突合并需求。

### 5.2 用量计算与防呆

计算在服务端提交时执行并固化（前端实时预览），规则与重算规则见 §4.3。防呆规则：读数小于上一班 -> 强制确认弹窗并留痕；天然气**任一卡**剩余量增大 -> 充气确认，该卡当日用量按 0 计、另一卡正常计算；首班无上一班数据 -> 显示"—"并提示。防呆确认与用量手工覆盖的原因统一写入 audit_logs 的 reason 列。**实现落点（TK-14，D-T19，技术方案修订 19）**：判定层 shared `guard.ts`（判定范围 = 累计走字表三字段 + 两气卡，液氧不入回退判定）；提交时命中即 409 + `need_confirm` 清单，客户端弹窗收集原因后组装 `confirmations` 重提，确认与命中项一一对应方入审计；充气确认成立的卡经 `gasDayUseOf` 的 `refilled` 参数按 0 计；上一班缺失（F3-07）时补录读数随 payload `prev_readings` 上送（仅非首班缺失态消费），不落 records 列、以审计 `record.prev_backfill` 留痕。

### 5.3 预警规则引擎

规则 = 配置表条目（阈值、基数、区间、级别）+ 求值器。触发点两个：交接单提交时逐项求值；定时任务每日复核（为 Phase 2 夜间窗口等跨记录规则预留）。每条预警文案强制包含命中规则与阈值（可解释原则）。**确认项统一落 alerts 表**：Phase 1 的表单级标红项（状态异常、电梯不一致）与交接事项（板块十有内容时，按条拆分为多条确认行——以换行或编号分条，对应 PRD 附录 A 第十板块"逐条确认"）同样生成待确认行，与 Phase 2 规则预警共用"逐条已知晓后方可签名"机制；预警推送科长与各类超时提醒经 notifications 表生成站内通知。

### 5.4 交接状态机

`草稿 → 已提交 →（接班人确认）已完成`；`已提交 →（异议）有异议 →（修改重提，版本+1）已提交`；`已提交 →（10 分钟内撤回）草稿`。重提保留全部历史版本（record_versions）。异议发起时刻记 `objection_at`；24 小时未解决的异议自动升级提醒科长（定时任务扫描，升级后记 `escalated_at` 防重复提醒，通知经 notifications 表落库）。

**实现落点（TK-20，D-T23，修订 27）**：异议段状态机落地为三条链路——标注异议 `POST /records/{id}/objection`（仅接班人本人 403/D-P06；note 必填，空白 400 点名、超 500 字 400 越界；行锁下转 objection + objection_at=服务端时刻 + 审计 `record.objection`）；异议单修改 `PUT /records/{id}`（仅交班人本人；**部分合并语义**直写行，status 仍 objection、version 不变；字段级形状校验与提交同一 normalizeSections；本版本**首次修改**时把修改前全字段快照定格入 record_versions——version=被替换版本、snapshot/changed（字段字典名 → {旧值,新值}，数值判等 M1 同源）/editor_id/edited_at；重复修改 UNIQUE(record_id, version) 幂等，changed 按「快照基线 → 当前行叠加本次上送」重算累计口径）；修改重提 `POST /records/{id}/resubmit`（仅交班人本人；表单值以 PUT 写入行为准重走提交校验/防呆/计算（缺项 400 点名、回退/充气命中 409 同协议），请求体仅可选 confirmations/usage_overrides；version+1、submitted_at 更新（PRD 附录 A）；alerts 先清后插重建（快照语义，TK-17 L3 同纪律）；objection_note/at 保留在行上（D-T23）；下游 D+1 已提交单触发重算）；重提审计复用 record.submit（newValue 记 resubmitted）；上一班仍缺失时重提回落原提交 `record.prev_backfill` 审计基线（D-T19 留痕即真值）；历史版本摘要经 GET /records/{id} versions 可查（F2-07-T1）。

**撤回窗口（总务科 2026-08-28 拍板）**：提交后 10 分钟内、且接班人尚未确认时，交班人可单方撤回，交接单回到可编辑状态，接班人端待确认入口同步消失；撤回动作写 audit_logs，重新提交版本号+1。服务端校验三个不可撤回条件：超过 10 分钟窗口、接班人已完成确认、交接单处于"有异议"状态。实现要点：撤回是服务端操作（记录已在服务器），需在院内网络下执行；接班人确认的 2 小时计时在撤回后随重提重新起算。不影响表结构。

**实现落点（TK-22，修订 28）——服务端定时任务四件**（notifications 模块，扫描的 `now` 一律由调用方**注入**；生产由 @nestjs/schedule（§2 选型「官方定时任务」）按间隔喂系统时钟，测试直调扫描本体；jest 环境调度静默）：① **F2-11 确认超时**（每 5 分钟）：status='submitted' 且 submitted_at + configs `confirm_due_hours`（默认 2，限 1–72）已过 → notifications 落 confirm_due 提醒接班人；去重键 (record, receiver) 带 submitted_at 水位（撤回重提刷新窗口后旧提醒不压制；notifications.createdAt 系库端 CURRENT_TIMESTAMP 的 UTC 串，与 records 列 localMeasuredAt 本地墙钟串比较经 shared `localTimestampToDate` 换算）；② **F2-12 异议升级**（每 30 分钟）：status='objection' 且 objection_at + configs `objection_escalate_hours`（默认 24，限 1–168）已过 → **escalated_at 原子闸门**（UPDATE … WHERE escalated_at IS NULL，命中 1 行才发通知，防重复提醒的并发安全实现）+ 提醒全部 active 科长；③ **F6-06 漏交扫描**（每 30 分钟）：排班日 D 过（D+1）日 configs `missing_submit_deadline`（默认 09:00）仍无 records 行 → 提醒科长（title 含日期、message 含排班人）；漏交判定以 records 行存在为准（台账增补 #27）；**扫描窗口 = 当前班次 − `backfill_window_days`**（窗口外无法补交不再提醒，与 §4.3 补交端点同源取值）；截止判定在**墙钟空间**（duty-date.ts `localWallClock`，(D+1) 日 'HH:MM' 与当地墙钟直接比较，不反推 Date）；④ **会话过期清理**（每 60 分钟，§6）：DELETE sessions WHERE expires_at ≤ now（UTC 串口径）。通知落 notifications 表不经审计拦截器（非用户变更类路由，契约 §5 审计联动表不含定时任务）；读侧 GET /notifications + POST /notifications/{id}/read 见契约 §3.5（TK-22）。

### 5.5 审计与留痕

NestJS 全局拦截器统一记录：配置中心任何修改（新旧值）、排班/电梯字典/点位字典修改、账号开通与停用、记录数据覆盖（谁、何时、哪些字段）、防呆/充气/覆盖确认（原因记 reason 列）、登录事件（设备、IP）。审计日志只增不改不删，是考核与追责的数据基础。

---

## 6. 安全设计

账号实名一人一号、密码加盐哈希存储、会话超时自动退出；接口按角色鉴权（师傅：填写与确认；科长：全部 + 配置）；SQL 注入由 Drizzle 参数化天然防护；内网启用 HTTPS（院内自签证书即可，手机首次访问时信任）；照片与签名图仅科长与当事人可调阅（权限随记录）。账号共用风险的对治：登录设备记录 + 签名时显示姓名二次确认（见 PRD 风险表）。

**会话机制（D-T13，2026-09-02 定案）**：登录成功后服务端生成随机会话令牌（≥ 32 字节），**仅存其 SHA-256 摘要**入 `sessions` 表，令牌本身经两条通道之一下发：

- **浏览器（师傅端 H5、科长后台）**：`HttpOnly` + `SameSite=Lax` Cookie——JS 读不到故防 XSS 窃取；生产由 Nginx 同源反代（§3 架构图），开发期经 Vite `/api` 代理，两者浏览器视角均为同源，无需 CORS credentials
- **非浏览器客户端**（专有钉钉/企微内网小程序等，D-P03 预留对接）：登录响应体返回令牌，客户端存本地并每次请求放 `Authorization: Bearer <令牌>` 头

服务端守卫**先查 Header 再回落 Cookie**，两条路命中同一存根，共用一套校验与撤销逻辑（故将来接小程序无需重构认证层）。超时采**滑动窗口**：每次通过鉴权的请求刷新 `last_seen_at` 并将 `expires_at` 顺延 `configs.session_timeout_minutes`（种子默认 720 分钟 = 12 小时，对齐 24 小时班制使师傅当班期间不被反复踢出；❓ 具体时长待科长确认）；超时后请求返回 401 `UNAUTHENTICATED`。

**撤销即时生效的三处**（这是不选 JWT 的核心原因）：登出删除存根行；账号停用（F6-02「停用即不可登录」）时删除该用户全部存根行，已在线设备下一次请求即 401；过期行由定时任务清理（同 §5 定时任务体系）。令牌不承载业务信息、每次请求回表校验，故不存在 JWT 式「签发后到期前无法撤销」的安全窗口。

---

## 7. 部署与运维

**服务器配置建议**（很低的要求）：4 核 8G 内存、200G 磁盘（系统与数据库）+ 照片另计（按每日 10 张 ×500KB 估算，三年约 5GB，预留 50G 充裕）、Ubuntu Server 或医院信息科惯用发行版。

**部署形态**：Docker Compose 三容器——Nginx、后端服务、MySQL；一条命令整体启停与升级。升级流程：导出备份 → 换镜像 → 自动迁移数据库结构 → 冒烟测试（Playwright 自动跑核心用例）。

**备份策略**：每日凌晨自动导出全库 + 照片目录增量，保留 30 天，另在院内另一台机器/存储上留一份；每季度做一次恢复演练（备份不演练等于没有）。

**监控**：服务存活 + 磁盘水位 + 同步失败率三个基础告警，站内通知科长；不引入重型监控栈。

---

## 8. 质量保障（AI 端到端测试）

三层测试体系：**单元测试**（Jest）覆盖用量计算、预警求值、防呆逻辑等纯函数；**接口测试**覆盖状态机流转与权限；**端到端测试**（Playwright + TypeScript）模拟真实手机浏览器完成"登录→填写→防呆→提交预览→接班人确认→签名→归档"全链路，含离线模拟（断网注入）。

PRD v0.2.5 中全部 Given/When/Then 验收标准（含撤回窗口、排班安全阀、漏交检测、换罐线用例）逐条登记为测试用例，形成"需求即测试"的映射表；每次改动后由 AI 代理自动执行全套并出报告。部署入院后脚本置于院内机器定时运行（开发方无法远程触达内网）。

---

## 9. 待信息科确认事项（技术栈已闭环，剩部署与对接项）

1. **Node.js 运行时的运维接受度**——**已确认（2026-08-31）**：采用 TS 全栈，无需平替 Java（决策记录 D-T01）
2. 服务器资源划拨（§7 配置）与院内 WiFi 覆盖确认（含地下表房等弱信号点位——手机需能连上院内网络才能同步）
3. 数据库实例：使用信息科现有 MySQL 实例还是为本系统新开独立实例（建议独立实例，互不干扰）
4. 院内是否已有统一账号体系需要对接（当前按独立账号体系设计，预留对接位）

---

## 10. 实施阶段（对齐 PRD 发布计划）

**Phase 1（MVP）**：账号与排班、首页卡片填写（含离线）、用量自动计算与防呆、交接确认与签名、电梯字典核对（不一致标红+必填说明）、精简后台（人员/排班/电梯配置/记录管理）。里程碑验收：双轨并行两周逐日比对纸电数据。

**Phase 2**：预警中心与站内推送、历史趋势报表与导出、拍照留证（F7）、完整配置中心、夜间液氧窗口监控（口径已于 PRD v0.2.8 定案，确定上线）。

**质量活动贯穿两期**：验收标准用例库随功能同步建设，每次提交自动全量回归。

---

## 11. 遗留问题（与 PRD 剩余待办联动）

液氧计量单位现场核实后：阈值、时段降幅与用量单位需联动修正（改配置 + 一处文案，不涉及表结构）；液氧夜间用量口径已于 PRD v0.2.8 定案（含换罐日跳过），跨记录计算启用；照片留存时长建议随记录保存 1 年、仅科长可调阅原图（待确认）。交接单撤回窗口已于 2026-08-28 拍板定案，见 §5.4。

另有边界场景两项待定义：其一，**调班**——已关闭（PRD v0.2.4 定案）：交班人恒以登录账号（submitter_id）为准；登录人与当日排班不符时提示确认并写 audit_logs，不建换班审批流；其二，**服务端 draft 行的产生时机**——**已关闭（2026-09-11，TK-08，决策记录 D-T18）**：离线优先模型下草稿存于手机 IndexedDB（§5.1 草稿层，D-T10），服务端不设在线草稿端点（契约 §3.2 GET/PUT /records/today/draft 暂缓）；records 行提交时一次性创建（record_no 生成时机不变），records.status 为 draft 仅由撤回（§5.4，F2-08，TK-21）产生。其前置过程保留备查：**部分明确（2026-09-03，TK-05）**：`GET /records/today` 为只读接口，当日无记录时返回 `record: null` 而**不产生** draft 行（理由见决策记录 D-T15：record_no 为 NOT NULL UNIQUE 而定为提交时生成、种子 D0 刻意留空、GET 带写副作用会引入并发竞争）；其三，**液氧换罐**——已关闭（PRD v0.2.8 定案）：换罐日（今日与昨日记录 tank_in_use 不同）夜间用量不计算、标注"当日换罐"，避免两罐读数相减失真。

---

*本文档 v0.1 已获总务科确认，v0.2 为数据库设计评审修订、待复核。与 PRD 一样：只保留最新版，修订史内嵌本节。*

28. **定时任务四件落地口径（2026-09-16）**：TK-22 实现服务端定时任务（F2-11/F2-12/F6-06 + 会话清理）——§5.4 末新增「实现落点（TK-22）」段（四扫描的时间注入设计、间隔、去重键、F6-06 墙钟空间截止判定与补交窗口对齐的扫描窗口、sessions UTC 串与 records 本地墙钟串两套口径各随其列）；§5.4 异议升级句的「定时任务扫描，升级后记 escalated_at 防重复提醒」自此有实现对应（escalated_at 原子闸门）；§2 选型表的「官方定时任务」落为 @nestjs/schedule（ScheduleModule.forRoot()，notifications.scheduler.ts 按 5/30/30/60 分钟喂系统时钟，jest 环境静默）。无表结构变更（notifications/sessions 两表 §4.2 已有），无新增配置键（confirm_due_hours / objection_escalate_hours / missing_submit_deadline / session_timeout_minutes 种子已有）。联动：契约订正 26、台账增补 #36、任务分解修订 39。

29. **管理后台框架与权限落地口径（2026-09-16）**：TK-23（M4 起步）——① §3 模块划分补管理后台落点（见上文标注）：apps/api 新增 admin 模块（契约 §3.6 科长路由统一入口），守卫**类级**标注 SessionGuard + RolesGuard + `@Roles('chief')`，师傅访问 /admin 一律 403 FORBIDDEN（未登录 401 先于角色判定）；首条落地路由 GET /admin/missing-submits（F6-06 后台视图半边），漏交判定复用 NotificationsService.missingSubmitShifts 单一实现（与 missing_submit 通知同源，契约 §3.6「数据源一致」由此结构保证）；admin.spec 路由完备性哨兵（已注册 /admin 路由逐字对账契约清单）使「一律 403」随 TK-24~29 新增路由自动执法。② 科长后台前端 apps/admin 骨架：不引 vue-router（与 h5 同款组件状态切换）、Element Plus PC 布局（侧边四页导航 + 顶栏用户区）、Cookie 通道登录（C-05 实名制，登录事件记审计随 TK-04 既有口径）、GET /auth/me 会话恢复、role ≠ chief 拦截至无权限页、401 会话失效单一入口 handleSessionLoss；E2E 新增 desktop-admin 项目（Desktop Chrome :5174）。无表结构变更、无新增配置键。测试：jest 全量 228/228（重灌种子，含 admin.spec 8 项）、E2E 全量 58/58（E2E_CHANNEL=chrome，含 admin-shell 3 项）。联动：契约订正 27、台账增补 #37、任务分解修订 40。
30. **记录管理落地口径（2026-09-17）**：TK-24 实现 F6-01「查看/导出/批注」（决策记录 **D-T24**）——① **§4.2 records 表补列 `chief_note` VARCHAR(500) NULL**（科长批注覆盖式单条当前值；迁移 0002_loose_black_bird.sql：`ALTER TABLE records ADD chief_note varchar(500)`，仅一列、无回填需求）；② §3 模块划分补 TK-24 落点（见上文标注）：GET /records 列表（契约 §3.5 既有行，F6-01 科长半边落地、F5-01 师傅端界面仍 P2/TK-35；筛选解析 parseRecordListFilters 单一实现，与导出共用）、GET /admin/records/export（CSV = UTF-8 BOM + CRLF 附件，列集 14 列由 AdminService.EXPORT_COLUMNS 钉死、文件名按筛选区间；xlsx/正式月报挂 P2 F5-04）、POST /admin/records/{id}/annotation（批注覆盖式单条、空串清除、值无变化不写审计、审计 `record.annotate`；写入在 RecordsService.annotate 单一实现，AdminModule 引入 RecordsModule 复用——记录路由与后台批注永不两套口径）；③ 批注留痕形态：audit_logs old_value/new_value 携 `{note}` 前后值，**不进 record_versions**（非交接单数据变更，version 不动，D-T24 ③）。无新增配置键。测试：jest 全量 243/243（重灌种子，含 admin-records.spec 15 项 + admin.spec 哨兵扩至 3 条路由）、E2E desktop-admin 6/6（admin-records 3 项）。联动：契约订正 28、台账增补 #38、决策记录增补 19、任务分解修订 41。
31. **人员管理落地口径（2026-09-17）**：TK-25 实现 F6-02「师傅账号开通/停用（写审计）」（决策记录 **D-T25**）——§3 模块划分补 TK-25 落点（见上文标注）：① **§4.2 表结构零变更**（users.status/sessions/audit_logs 三处既有结构即 F6-02 全部载体，台账 F6-02「技术方案」列既有口径兑现，无迁移）；② **接口**：GET /admin/users（全量账号 id 升序 = 开通顺序，含科长行只读展示；启停仅对师傅账号开放，chief 目标 403）、POST /admin/users（开通师傅账号——角色恒 master，username 1~32 位字母/数字/下划线 UNIQUE 重复 400 点名、real_name 1~32 字、初始密码 8~64 字 bcrypt（cost 10，与登录侧同 cost）加盐哈希落库，明文不落库不回显）、PATCH /admin/users/{id}（状态启停——停用与审计同事务提交后经 AuthService.revokeAllForUser 删该用户全部 sessions 存根（D-T13「停用即不可登录」；resolveSession 对 status=disabled 的双保险兜并发窗口），值无变化不更新不写审计）；③ **审计形态**：开通与启停共用 `user.update` 单一 action（契约 §5 既有行）——开通 oldValue=null、newValue 搭开通值；启停携 status 前后值；操作人/时刻即 actor_id/created_at（F6-02-T1 判据）；④ **前端**：apps/admin 人员管理页（账号全景表 + 开通对话框 + 停用/启用二次确认，demo 口径文案；科长行只读），记录管理页交班人候选同步换源 GET /admin/users 全表（闭合 TK-24 留注）。无新增配置键。测试：jest 全量 253/253（重灌种子，含 admin-users.spec 10 项 + admin.spec 哨兵扩至 6 条路由）、E2E desktop-admin 9/9（admin-users 3 项）。联动：契约订正 29、台账增补 #39、决策记录增补 20、任务分解修订 42。
32. **排班管理与安全阀落地口径（2026-09-17）**：TK-26 实现 F6-03「最小排班表科长维护改即审计」、F6-04「排班驱动带出与漏交检测」、F6-05「排班安全阀」（决策记录 **D-T26**）——① **§4.2 表结构零变更**（schedules.duty_date UNIQUE + updated_by/updated_at 既有列即维护载体，无迁移）；② **接口**：GET /admin/schedules（月视图 `?month=YYYY-MM` 缺省当前墙钟月、稀疏列示、duty_date 升序）、PUT /admin/schedules（单日单条 upsert——duty_date 日历校验（isValidCalendarDate 单一权威）、值班人须师傅账号（chief 目标与未知 id 400 点名 user_id）、同值重复 PUT 值无变化不更新不写审计（D-T21 M1 精神）、INSERT…ON DUPLICATE KEY UPDATE 兜并发）；③ **审计**：`schedule.update` 新旧值携 `{user_id, real_name}`、targetId=duty_date（F6-03-T1「schedules 与 audit_logs 一致」判据）；④ **驱动面零改动**（F6-04）：带出（TK-12 scheduledReceiverOf 读 D+1 行）、漏交扫描与后台视图（TK-22/23）与维护消费同一张 schedules 表，改派次班生效；⑤ **安全阀**（F6-05）：submitCore 新增前置门——登录提交人 ≠ 该班次排班人（schedules D0 行）→ 409 DUTY_MISMATCH（need_confirm 携 duty_guard 项），置于防呆 409 之前（身份对账先于业务防呆，同「未登录 401 先于 403」门序）；`duty_guard_confirm.confirmed === true` 唯一解锁、reason 选填随审计留痕、排班缺失不判定（同防呆缺失态放行精神）、排班一致时确认被忽略（同「未命中确认不入账」口径）、**补交链路同门**（D-T21 挂账「补交班次排班归属校验」闭环）；审计 `record.guard_confirm` 仅命中写一行（oldValue=排班基线、newValue=实际提交人、reason=调班原因）；⑥ **种子轮值相位锚定 D0=zhang**（seed.ts dutyOf 由 +14 相位改为 0 相位；安全阀落地后接口层提交类用例「当班师傅提交」的默认登录人 zhang 不再被 409 拦截；消费方一律从库反查排班人，无断言受相位影响；records-pending.spec（接口与 E2E 两层）的接班人硬编码同步改从库/黑盒反查）。无新增配置键、无新增 ❓ 待确认项。测试：jest 全量 **268/268**（重灌种子，含 admin-schedules.spec 8 项 + records-duty-guard.spec 7 项 + admin.spec 哨兵扩至 8 条路由）、E2E 全量 **66/66**（E2E_CHANNEL=chrome，含 admin-schedules 2 项）。联动：契约订正 30、台账增补 #40、决策记录增补 21（D-T26）、任务分解修订 43、《开发种子数据》修订 7。
33. **同步角标空态收敛（2026-09-17）**：F1-06 UI 歧义修复（台账增补 #41，源于当日演示反馈）——§5.1 首页同步角标增加显隐条件，仅四种有信息量状态显示：排空中 / 待同步（本机队列 OR 接口 `pending_sync`）/ 当日已有填写内容 / 本班次已成功上传。空态（0 项已填、队列空、未上传）的「已同步」是无内容可指代的空洞陈述——无宾语易读作「交接单已上传」，与「尚未开始」并排自相矛盾，不再显示。配套：h5 App.vue 新增会话级 `syncedDutyDate`（在线提交与排空成功记当前 duty_date、登出清零、跨班次分界自然失效）——上传成功到 `loadToday` 重拉完成之间存在「草稿已清（D-T20 清除时点=同步成功）、服务端值未到」的窗口，无此标志角标会闪断，违背本节培训口径「看到已同步方可下班」。无服务端、表结构、接口变更。判据：新增用例 F1-06-T2（E2E：空态 chip 不渲染、填一项后显示「已同步」）。测试：jest 全量 268/268、lint、check-ledger、E2E 全量 67/67（E2E_CHANNEL=chrome）。联动：台账增补 #41、用例清单修订 2。
