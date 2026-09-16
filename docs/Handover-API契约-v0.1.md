# Handover · API 契约（v0.1）

- **定位**：师傅端 H5、科长后台、测试用例三方共用的**前后端接口边界契约**。数据库设计（技术方案 §4）定义"存什么"，本契约定义"怎么读写"。C-09（报错必须点名）在此落为**可断言的错误响应结构**。
- **上游文档**：《技术方案与数据库设计 v0.2》（表结构与机制）、《规格编号与验收对照表 v1.4》（规格出处）、《测试用例清单 v0.1》（接口层用例以此断言）
- **实现基线**：NestJS（D-T01）；本表是规格层的稳定契约，代码侧可由实现自动生成 OpenAPI 文档，两者不一致时**以本表 + 台账为准并回改代码**
- **生成时间**：2026-09-01
- **状态**：v0.1 覆盖 Phase 1 全部路由；Phase 2 路由（预警中心/报表/照片）以 ⏸ 标注，启动前细化

---

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| 基础路径 | `/api/v1` |
| 认证 | 账号密码登录建立会话；凭证经 **HttpOnly Cookie**（浏览器：师傅端 H5、科长后台）**或 `Authorization: Bearer`**（非浏览器客户端：专有钉钉/企微内网小程序等）传输，两者共用同一会话存根（`sessions` 表）；服务端守卫先查 Header 再回落 Cookie；会话超时自动退出（滑动窗口，时长取 configs `session_timeout_minutes`）——详技术方案 §6「会话机制」、决策记录 D-T13 |
| 角色 | `master`（师傅：填写与确认）、`chief`（科长：全部 + 配置）；接口按角色守卫 |
| 时间 | ISO 8601 带时区；**班次一律以 `duty_date`（班次起始日）为准**（C-08） |
| 分页 | `page` / `page_size`，响应含 `total` |
| 单写入人 | 一天一条记录、单人编辑，无并发冲突合并（技术方案 §5.1） |
| 审计 | 凡变更类路由按 §5 审计联动表写 `audit_logs`，与业务写入同事务 |

## 2. 错误响应结构（C-09 落地，所有 4xx 统一）

```json
{
  "code": "VALIDATION_MISSING_FIELDS",
  "message": "有 3 项必填未填",
  "missing_fields": [
    { "field": "hp_status", "section": 2, "label": "高配房是否正常", "anchor": "#sec-2-hp-status" }
  ],
  "need_confirm": null,
  "reason": null,
  "request_id": "req-xxxx"
}
```

- `code`：机器可读错误码（见 §3 错误码表）
- `missing_fields[]`：**缺失/越界字段逐条点名**——`field` 点名对象（records 列名；**电梯核对行为 `elevator:{id}`**，因明细落 `elevator_checks` 逐台一行、records 无对应列，而 ELE-04/ELE-07 同受 C-09「所有拦截逐条点名 + 点击跳转定位」约束）、`section` 板块序（0=基础信息，1~10=业务板块，电梯为 9）、`label` 中文名、`anchor` 前端跳转锚点（生成式 `#sec-{板块号}-{field 的 kebab 形式}`，`_` 与 `:` 均转 `-`）；无缺失类错误时为 `null`
- `need_confirm`：防呆/安全阀需确认时为确认对象（见 §4 提交协议），否则 `null`
- `reason`：**不可撤回原因**（TK-21 订正 25 升为响应字段）——仅 `WITHDRAW_NOT_ALLOWED` 使用，取 `WINDOW_EXPIRED` / `ALREADY_CONFIRMED` / `IN_OBJECTION` 三值之一（机器可读，供客户端按原因分支提示与 F2-10-T1/T2/T3 用例逐条断言）；其余错误码恒为 `null`
- `request_id`：日志追踪

**用例断言口径**：C-09 相关用例（F1-08-T1、F1-08-T2 等）断言"缺失字段清单完整 + anchor 可达 + 提示逐条点名"。

### 错误码表

| HTTP | code | 场景 | 关联规格 |
| --- | --- | --- | --- |
| 400 | VALIDATION_MISSING_FIELDS | 必填缺失（含液氧 8 项） | F1-08、DATA-01 |
| 400 | VALIDATION_OUT_OF_RANGE | 数值越界 | F1-08 |
| 401 | UNAUTHENTICATED | 未登录/会话过期 | F1-11 |
| 403 | FORBIDDEN | 角色不足（师傅访问后台等） | C-05 |
| 404 | NOT_FOUND | 资源不存在或无权查看 | — |
| 409 | READINGS_DECREASED | 读数小于上一班，需确认 | F1-12 |
| 409 | GAS_REFILL_CONFIRMED | 气卡剩余量增大，需充气确认 | F1-13 |
| 409 | DUTY_MISMATCH | 登录人与当日排班不符，需安全阀确认 | F6-05 |
| 409 | WITHDRAW_NOT_ALLOWED | 不可撤回（响应体 `reason` 字段：WINDOW_EXPIRED / ALREADY_CONFIRMED / IN_OBJECTION，订正 25） | F2-10 |
| 409 | CONFIRM_INCOMPLETE | 仍有未逐条知晓的标红项/交接事项 | F2-04 |
| 409 | OVERRIDE_REASON_REQUIRED | 覆盖自动计算值未填原因 | F3-06 |
| 409 | ELEVATOR_EXPLANATION_REQUIRED | 电梯不一致未填说明（`missing_fields[].field` 以 `elevator:{id}` 点名，section=9） | ELE-04、ELE-07 |
| 409 | RECORD_EXISTS | 当日记录已提交（duty_date 唯一） | F1-01 |

## 3. 路由总表

### 3.1 认证

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| POST `/auth/login` | 公开 | 登录 | F1-11 | body `{username, password, channel?}`，`channel` 取 `cookie`（默认）或 `bearer`。成功建会话（写 `sessions` 存根，记设备与 IP）并写审计；**`cookie` 通道仅 `Set-Cookie`（HttpOnly + SameSite=Lax）、响应体不返回令牌**（防 XSS 从响应体窃取，保住 HttpOnly 的意义）；`bearer` 通道在响应体返回 `token`。失败不泄露账号是否存在（统一「账号或密码错误」，失败也写审计）；已停用账号提示停用而非报错（F1-11-T3） |
| POST `/auth/logout` | 登录用户 | 登出 | F1-11 | **删除 `sessions` 存根行 → 会话立即失效**（不仅清 Cookie，服务端亦不再认可该令牌）；写审计 |
| GET `/auth/me` | 登录用户 | 当前用户与角色 | F1-11 | 返回 id/real_name/role；Cookie 与 Bearer 两通道均可鉴权 |

鉴权失败统一返 401 `UNAUTHENTICATED`（未登录/会话过期/已登出/账号被停用）；角色不足返 403 `FORBIDDEN`。账号停用（F6-02）时服务端删除该用户全部 `sessions` 行，已在线设备下一次请求即 401。

### 3.2 今日交接（师傅端）

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/records/today` | master,chief | 首页卡片汇总 | F1-01、F1-02、F1-03 | 返回各板块填写状态、角标统计、今日记录状态、待同步标记；接班人按**次日排班**自动带出（F2-01/DATA-10，TK-12）；**回传 `withdraw_window_minutes`**（TK-21 订正 25：服务端读 configs `withdraw_window_minutes`、非法/缺失回落 10，供前端据 `record.submitted_at + 本值` 算撤回倒计时，F2-09-T1；与撤回校验同源，权威形状 shared `TodayDto`） |
| GET `/records/today/prev` | master,chief | 上一班读数带出 | F1-05、DATA-02 | 按 duty_date 取**相邻班次**（今日班次日期 − 1 天，D-T17）**已提交**记录；含液氧昨日 20:30 值；相邻日无行（漏交）或为 draft → `prev: null` 且非首班（F3-07 缺失态）；今日之前无任何记录 → `first_day: true`（F1-15）；**不回落更早记录** |
| GET `/records/today/draft` | master | 读取在线草稿 | F1-09 | **暂缓实现（D-T18）**：草稿层为客户端 IndexedDB（技术方案 §5.1），服务端不设在线草稿读写；跨设备续填需求出现时再评估恢复本路由 |
| PUT `/records/today/draft` | master | 保存草稿（局部） | F1-09 | **暂缓实现（D-T18）**：同上；records 行提交时一次性创建，draft 状态仅由撤回（F2-08，TK-21）产生 |
| POST `/records/today/preview` | master | 提交前预览 | F1-10 | 返回未填项清单与异常项清单（结构同 `missing_fields`，C-09 逐条点名+锚点）；权威形状 shared `PreviewDto`（TK-12 落地：接班人修改原因条件预检一并点名；只读不落库） |
| POST `/records/today/submit` | master | 正式提交 | F1-01、F1-07、F2-01、DATA-09、DATA-10 | 详见 §4 提交协议（TK-12 落地：record_no=`HB-YYYYMMDD-001`、submitted_at=服务端收到时刻、接班人=次日排班带出/修改必填原因留痕；防呆 409 已随 TK-14 落地（订正 15）、用量固化已随 TK-13、duty_guard 判定随 TK-26；提交链路角色 master，不适用 chief 只读回写口径） |
| POST `/records/backfill` | master,chief | 跨班次补交（上一班晚到） | F3-08、F1-01 | 决策记录 **D-T21**（TK-16）：payload `duty_date` 显式上送（日历合法、**严格早于当前班次日期**、且**不早于补交窗口**：当前班次 − configs `backfill_window_days` 天，种子 7、❓ 待科长确认），其余请求体与 submit 同形；校验/防呆/覆盖/补录协议与 §4 完全同口径（submitCore 单一实现）；**该班次已有非 draft 记录 → 409 RECORD_EXISTS；draft 行（撤回后未重提）由补交接管为「更新 + version+1」**（否则与「submit 只认当前班次」合起来构成永久死角）；提交人恒为登录人本人（科长代录他人挂 TK-24）；补交成功后同事务触发下游重算（F3-08：**仅紧邻 D+1 且 status='submitted' 的记录**——objection/completed 已进确认或已签名归档，**不静默改数**；water/e/gas 三项 prev 依赖用量；手工覆盖豁免 D-T07；**按数值而非字符串判等**，值无变化不写审计），响应带 `recalc`（权威形状 shared dto `RecalcResultDto`；无变更且无待复核项时为 null；新基线命中防呆判定时**不改数不拦提交**、标 `needs_review`）；审计 `record.late_submit` + 逐变更项 `record.recalc` + 命中时 `record.recalc_review`（§5） |
| POST `/records/today/withdraw` | master | 撤回 | F2-08、F2-09、F2-10 | 交班人提交后窗口内单方撤回本班次交接单（D-P05，TK-21 落地）：服务端按**当前班次日期（C-08）+ submitter=登录人**定位（duty_date UNIQUE → 至多一行；无行 404、非交班人 403）；**行锁下校三不可撤条件**（状态锁定先于窗口判定）——已确认（completed）→ `reason=ALREADY_CONFIRMED`、有异议（objection）→ `reason=IN_OBJECTION`、超窗口（submitted 但 now − submitted_at > `withdraw_window_minutes`）→ `reason=WINDOW_EXPIRED`，均 409 WITHDRAW_NOT_ALLOWED 携 `reason`（§2）提示走异议流程；draft（已撤回/从未提交）→ 409 CONFIRM_INCOMPLETE 同族；**成功转 draft + 清 submitted_at**（回到可编辑，F2-08）、version 不变（重提才 +1，F2-08-T2）、读数列保留；提交时生成的 alerts/elevator_checks **同事务清空**（快照语义，与 submitCore 重提先清后插同源）；接班人端待确认入口随 status 转 draft 同步消失（F2-09-T2，pending 取数口径 status='submitted'）；审计 `record.withdraw`（§5）；权威形状 shared dto `WithdrawResultDto` |
| GET `/records/mine/objections` | master | 我被退回的异议单 | F2-06 | **我为 submitter 且 status='objection'**（重提转回 submitted 即从清单消失），按 duty_date 降序，含 objection_note/at 与接班人回显；供下次到岗处理（F2-13）；权威形状 shared dto `ObjectionListDto`（TK-20 落地） |
| PUT `/records/{id}` | master | 异议单修改（objection 状态） | F2-07 | **部分合并语义（D-T23）**：仅上送字段写入、status 仍 objection、version 不变（PUT 默认 200）；字段级形状校验与 submit 同一 normalizeSections（越值 400 点名），必填完整性在 resubmit 把关；本版本**首次修改**时修改前全字段快照定格入 record_versions（snapshot/changed 旧值/修改人，F2-07-T1 四要素；UNIQUE(record_id, version) 幂等，changed 累计口径）；仅交班人本人（服务层 403）；请求体权威形状 shared dto `RecordUpdatePayloadDto`（TK-20 落地） |
| POST `/records/{id}/resubmit` | master | 异议修改后重提 | F2-07 | **版本+1；重新走提交校验与计算**（D-T23）：表单值以 PUT 已写入行的值为准，请求体仅可选 confirmations/usage_overrides（防呆 409 与覆盖协议同 §4）；submitted_at=服务端时刻（重新提交即更新交接时间，PRD 附录 A）；标红确认行先清后插重建（快照语义）；下游 D+1 已提交单触发重算（trigger=objection_resubmit，响应带 recalc）；objection_note/at 保留在行上；仅交班人本人（服务层 403）；权威形状 shared dto `ResubmitPayloadDto`/`ResubmitResultDto`（TK-20 落地） |

### 3.3 电梯核对（师傅端）

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/elevators/expected` | master, chief | 当前时刻逐台预期状态 | ELE-03 | **只读计算不落库（D-T22）**：按当前时刻逐台返回 expected 与计划回显（check_time 为响应级核对时刻基准）；角色列放宽 chief 同 today/prev 口径 |
| —（原 POST `/records/today/elevator-checks` 已订正为并入 §4 提交协议，见下方电梯核对口径与订正 20） | master | 随提交 payload `elevator_checks[]` 上送核对结果 | ELE-04、ELE-05、ELE-06、ELE-07 | `actual`（match/run/stop/fault）+ 不一致必填 `explanation`（缺则 409 ELEVATOR_EXPLANATION_REQUIRED，逐台 `elevator:{id}` 点名）；服务端按上送 check_time 重算 expected 落库（ELE-05）；不一致写 alerts 标红行（ELE-06，level=mid） |

### 3.4 交接确认（接班人）

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/records/pending` | master | 待确认列表 | F2-02 | 我为 receiver 且 status=submitted（draft/objection/completed 不产生待确认入口）；逐单含 `alert_count`（alerts 行数，与详情同源）；权威形状 shared dto `PendingListDto`（TK-18 落地） |
| GET `/records/{id}` | 登录用户 | 交接单详情 | F2-03、F5-01 | 含全部读数、标红项（alerts，**置顶序** level high→mid→low 由服务端排好，shared `ALERT_LEVEL_RANK`）、电梯核对（联字典回显电梯名）、双方确认信息、历史版本摘要 `versions`（F2-07-T1「历史版本可查」：version/修改人/时刻/变更字段旧值新值，全字段快照留 record_versions 不入响应，TK-20 起）；权威形状 shared dto `RecordDetailDto`（TK-18 落地，接班人浏览与科长巡查共用） |
| POST `/records/{id}/acknowledge` | master | 逐条"已知晓" | F2-04、DATA-08、DEP-08 | body 传 `alert_ids[]`（权威形状 shared dto `AcknowledgePayloadDto`），逐条写 acknowledged_by/at；已知晓行不重复写（首次知晓时刻即留痕，响应 `{acknowledged}` = 本次新写入行数）；跨单/未知 id 容错忽略、非数组 400 合成定位项点名；仅接班人本人（他人 403）；留痕落 alerts 行本身、不另写审计（TK-19 落地） |
| POST `/records/{id}/confirm` | master | 签名归档 | F2-04、F2-05 | body 传签名图 PNG data URL（权威形状 shared dto `ConfirmPayloadDto`）；服务端校验全部确认行已知晓（终校与转 completed **同事务**，409 CONFIRM_INCOMPLETE）；解码校验（前缀+PNG 魔数+≤512KB）后落盘 `/uploads/signatures/{record_no}.png` 记 signature_path；confirmed_at=服务端时刻；仅接班人本人；成功转 completed（响应权威形状 shared dto `ConfirmResultDto`），审计 `record.confirm`；非 submitted 状态归入同一 409 族（错误码 13 项不变，TK-19 落地） |
| POST `/records/{id}/objection` | master | 标注异议 | F2-06 | `note` 必填（空白 400 点名、超 500 字 400 越界）；**仅接班人本人**（服务层 403，D-P06，同 acknowledge/confirm 门）；行锁下转 objection 并记 objection_at=服务端时刻；非 submitted 409 CONFIRM_INCOMPLETE 同族（文案区分）；权威形状 shared dto `ObjectionPayloadDto`/`ObjectionResultDto`（TK-20 落地） |

### 3.5 历史与通知

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/records` | 登录用户 | 历史记录筛选 | F5-01、F6-01 | `from/to/submitter_id/status`；师傅看全部、科长同 |
| GET `/notifications` | 登录用户 | 站内通知（未读角标） | DEP-04、F2-11、F2-12、F6-06 | kind: confirm_due / objection_escalated / missing_submit / alert_push（P2）/ monitor（shared `NOTIFICATION_KINDS`）；权威形状 shared dto `NotificationListDto`——`items[]`（id/kind/title/message/record_id/created_at/read_at，**id 倒序**）+ `unread` 未读总数；**仅回当前登录人未读**（已读经 read 标记后不再出列，角标数据源语义，DEP-04）；仅 SessionGuard 不设 @Roles（登录用户，师傅与科长都收通知）（TK-22 落地） |
| POST `/notifications/{id}/read` | 登录用户 | 标记已读 | DEP-04 | 幂等：已读重复调用回**首次** read_at（shared dto `NotificationReadResultDto` {id, read_at}）；非本人通知与不存在同回 404 NOT_FOUND（不泄露存在性）、非数字 id 同 404 统一结构（同 GET /records/{id} 既有口径）（TK-22 落地） |

### 3.6 管理后台（科长）

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET/POST `/admin/users`，PATCH `/admin/users/{id}` | chief | 账号开通/停用 | F6-02 | 停用即不可登录；写审计 |
| GET/PUT `/admin/schedules` | chief | 排班月视图维护 | F6-03、F6-04 | 一天一人（duty_date 唯一）；写审计；驱动带出与漏交检测 |
| GET/POST/PATCH/DELETE `/admin/elevators` | chief | 电梯字典维护 | ELE-01、ELE-08、ELE-09 | plan_type 三选一；windows 支持 `["22:00","06:00"]` 跨零点；写审计 |
| GET/POST/PATCH `/admin/spots` | chief | 点位字典维护 | F6-07 | 写审计 |
| GET `/admin/configs`、PUT `/admin/configs/{key}` | chief | 配置中心 | F6-07、F4-11 | 新旧值写审计；保存即全员生效（下一班表单即时反映） |
| GET `/admin/audit-logs` | chief | 审计查询 | F6-08 | 按 action/actor/时间筛选；只读 |
| GET `/admin/records/export` | chief | 记录导出 | F6-01 | Phase 1 按月 CSV/Excel；P2 升级正式月报（F5-04 ⏸） |
| GET `/admin/missing-submits` | chief | 应提交未提交视图 | F6-06 | 日期+排班人；数据源与 missing_submit 通知一致 |
| GET `/admin/alerts` | chief | 预警中心 | F4-01（P2 ⏸） | Phase 2 启用时细化 |
| GET `/admin/stats/trends` | chief | 趋势曲线数据 | F5-02（P2 ⏸） | Phase 2 启用时细化 |

### 3.7 配置只读（师傅端表单候选）

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/configs` | master,chief | 表单选项类配置白名单 | DATA-07 | **只读视图**：返回 `{ {配置键}: [候选...] }`（键集见 shared `FORM_OPTION_CONFIG_KEYS`，现 `hvac_locs` / `boiler_list` 两键，新增键须同步 shared 常量与本节），值为 configs.config_value 的 JSON 数组解析结果，非法/键缺失回落空数组；**非白名单运营键不出网**（读取归 §3.6 GET `/admin/configs`）；角色列 `chief` 依据 §1「科长：全部 + 配置」（与订正 4/5 同口径）；**提交侧不校验候选成员性**（h5 离线降级用占位候选，成员性校验会把降级路径变 400，违反 F1-09/C-01；如需引入随 TK-27 配置中心评估）。响应形状权威定义 `@handover/shared` dto `FormOptionsDto`（显式键映射，订正 10） |

## 4. 提交协议（POST `/records/today/submit`）

请求体要点：

```json
{
  "sections": { "water_reading": 49239, "e1_reading": 21400, "...": "十板块全部字段" },
  "receiver_id": 5,
  "receiver_change_reason": "次日张师傅请假，改为王师傅",
  "confirmations": [
    { "type": "reading_decreased", "field": "water_reading", "reason": "水表更换新表底数" },
    { "type": "gas_refill", "card": 1, "reason": "上午充气 50 立方米" }
  ],
  "duty_guard_confirm": { "confirmed": true, "reason": "替班" },
  "usage_overrides": [
    { "field": "lo_day_use", "value": "0.50", "reason": "日间补液，按实际修正" }
  ],
  "elevator_checks": [
    { "elevator_id": 3, "check_time": "2026-08-27 21:05:00", "expected": "stop", "actual": "match", "explanation": null }
  ]
}
```

服务端处理顺序（全部同事务）：

1. 必填/范围校验 → 失败 400（C-09 结构，含用量覆盖与补录读数 `prev_readings` 同口径预检）
2. 防呆判定（TK-14 落地，排班安全阀随 TK-26）：判定范围 = **累计走字表三字段**（`water_reading` / `e1_reading` / `e2_reading`，本次 < 上一班 → F1-12 读数回退）与**两气卡**（`g1_remaining` / `g2_remaining`，本次 > 上一班 → F1-13 充气，按卡逐项，D-P14 单卡判定；液氧含量递减是常态不入判定，D-T19）；上一班取数与 GET `/records/today/prev` 同源（相邻班次已提交记录，D-T17），上一班缺失时以请求体 `prev_readings` 补录值为基线（仅**非首班的缺失态**消费，见下）。任一侧读数缺失不判定（缺失态/首班放行）。有未确认项时 409（回退与充气同时命中时 `READINGS_DECREASED` 优先）并在 `need_confirm` 返回确认清单（可解释文案含上一班/本次值）；客户端弹窗逐条收集原因后组装 `confirmations` 重提。确认消费口径：`reason` 空白的确认项视为未确认（与未上送同待，F1-12-T2 不因重试放行）；`field`/`card` 与命中项对不上号的确认不消费；**仅命中项的确认写审计**（§5）。确认后的取数规则：充气确认成立的卡当日用量按 0 计、另一卡正常计算（D-P14）；读数回退确认不改值（负差原样固化）
3. 用量计算并固化（F3，TK-13 落地）：水/电（两线和、分线展示，D-P09）/气（剩余量减少值合计）/液氧日间（在用罐含量差）四类口径以 shared `calc.ts` 纯函数为单一权威实现，服务端按上一班（相邻班次已提交记录，D-T17，与 GET `/records/today/prev` 同源取数）计算写入，客户端传值仅作展示预览，**不信任**；上一班缺失 → 用量列固化 null（F3-07 缺失态），师傅补录的 `prev_readings`（仅非首班缺失态消费）即为该情况下的上一班基线。**手工覆盖**走请求体 `usage_overrides[]`（`field` ∈ shared `USAGE_FIELDS`，`value` 十进制字面量按列精度取整，`reason` 必填）：原因空白/值非法/越键 → 400 逐条点名（F3-06-T2 服务端强制，非仅前端）；合法覆盖以覆盖值固化并写审计 `record.usage_override`（F3-04-T2），读取侧 GET `/records/today` 被覆盖字段带 `manual: true`（F3-06-T1「自动计算」标识与人工值可区分，权威形状 shared dto `CardFieldStateDto`）。充气确认后该卡按 0 计（D-P14）为 TK-14 已落地的取数层（经 shared `calc.ts gasDayUseOf` 的 `refilled` 参数），未确认时负差原样固化
4. 生成标红确认行（状态异常/电梯不一致/交接事项拆条）写入 alerts（DEP-08；TK-18 补全落地：状态异常 rule_key=`{field}_bad`、level=high、异常备注并入文案；交接事项 rule_key=`handover_note`、level=low，按换行/编号分条 shared `handoverItemsOf` 单一权威；电梯不一致随 TK-17；形态与《开发种子数据》§六 D-1 配套标红行同形，重提同事务先清后插快照语义）
5. 记录转 submitted，`submitted_at` = 服务端收到时刻（DATA-09：离线场景下即同步成功时刻）；生成 record_no
6. 写审计（含覆盖/确认原因）

电梯核对口径（TK-17，**D-T22**）：核对结果随请求体 `elevator_checks[]` 上送（逐台 `{elevator_id, check_time, expected, actual, explanation}`），服务端在第 1 步以 shared `validateElevatorChecks` 同口径预检（电梯不存在/重复上送/时刻非法/actual 越枚举/说明超 300 → 400 逐条以 `elevator:{id}` 点名），在**第 2 步之后**对「不一致而说明空白」整体 409 ELEVATOR_EXPLANATION_REQUIRED（**该 409 必带 `missing_fields[]`，客户端须与 400 同处理逐条点名 + 点击跳转，不得只提示聚合文案**——订正 21）；落库时服务端按上送 `check_time`（核对时刻）**重算 expected**（「预期状态以核对时刻锁定、提交时不重算」ELE-05/D-P16 的实现口径 = 预期恒按核对时刻计算，客户端 expected 仅为展示留痕）。`check_time` 由**客户端在师傅落笔（点选核对结果）的瞬间**以本机时钟生成（D-T22 修订⑤，与 `lo_measured_am/pm` 的 DATA-13 同口径：核对事实发生在本机、本机时间戳即唯一权威），**不得沿用打开板块时拉取到的快照时刻**（陈旧时刻会让预期算错并抑制标红）；客户端上送的 expected 亦按该落笔时刻计算，服务端仍复算为准，与记录行同事务写入 elevator_checks（重提先清后插快照语义）；归一后任一不一致（actual≠match，含 fault）追加 alerts 标红行（第 4 步，rule_key=elevator_mismatch、level=mid）。核对不强制：未上送或空数组 = 本班次未核对，无明细行也无标红。审计无新增 action——elevator_checks 明细行即留痕（explanation 随行），与标红行（alerts）共同承载 ELE-04/ELE-06 的追溯面。

补充口径（TK-09，DATA-13/D-P12）：`lo_measured_am` / `lo_measured_pm` 由**客户端填写液氧读数时自动记录**（本机时刻，随 IndexedDB 草稿持久化即离线本地时间戳），随 payload 上送、服务端**原样落库**——不得以同步/接收时刻覆盖（DATA-13-T2 判据）。与第 3 步的用量列（服务端计算、不信任客户端传值）不同源：测量时刻的事实发生在本机，本机时间戳即唯一权威来源。

补交口径（TK-16，**D-T21**）：POST `/records/backfill` 复用本协议全部六步（服务端 submitCore 单一实现），差异仅三点——① `duty_date` 显式上送且须**严格早于当前班次日期并在补交窗口内**（当日与未来班次走 `/records/today/submit`，D-T20 M1 的对面）；② 该班次已有**非 draft** 记录 → 409 RECORD_EXISTS（draft 行由补交接管为重提，评审修复轮 L5）；③ 第 5 步之后追加：同事务触发下游重算（F3-08，见 §5 `record.recalc` 行）并写 `record.late_submit` 审计。重算**不重跑第 2 步防呆拦截**（无人值守的回写链路不得 409 卡住），但新基线命中 D-T19 判定时随响应 `recalc.needs_review` 与审计 `record.recalc_review` 标出，交人工走异议流程核对（L6）。

## 5. 审计联动表（变更类路由 → audit_logs.action）

| 路由 | action | 备注 |
| --- | --- | --- |
| POST `/auth/login` | `login` | 设备、IP；失败也记 |
| POST `/records/today/submit` | `record.submit` | 各防呆确认原因（TK-14）：**逐命中项一行**，`reason` 列记确认原因，`new_value` 记命中项的上一班/本次值与版本；对未命中字段的确认不写审计 |
| POST `/records/today/submit`（用量覆盖，TK-13） | `record.usage_override` | 逐覆盖项一行；`reason` 列记覆盖原因（F3-04-T2），`old_value` 记覆盖前服务端算出的自动值——亦为 TK-16 重算豁免（师傅手工覆盖过的值不被重算覆盖，D-T07）的判定依据 |
| POST `/records/today/submit`（上一班补录，TK-14） | `record.prev_backfill` | 补录读数不落 records 列（缺失班次不建行，F6-06 漏交检测不受影响），`new_value.readings` 存全量补录值；仅在上一班缺失态被消费时产生（D-T19） |
| POST `/records/backfill`（补交本体，TK-16） | `record.late_submit` | 补交语境留痕：`new_value` 记 duty_date 与版本；F6-06 漏交检测以 records 行存在为准，补交日自此不再计漏交（D-T21） |
| POST `/records/backfill`（下游重算，TK-16） | `record.recalc` | **逐变更项一行**：`old_value` 记下游旧固化值，`new_value` 记新自动值与触发语境（trigger=late_backfill + 补交单号，或 trigger=objection_resubmit + 源单号 `source_record_no`，TK-20 异议重提）；**是否变更按数值判等而非字符串**（'500' 与 DECIMAL 列读回的 '500.0' 同值，评审 M1 探针实证：字符串判等使整数用量恒被误判为变更、假审计成倍产生）；豁免字段（当前版本 `record.usage_override` 行，D-T07）与数值无变化项均不入列也不写审计 |
| POST `/records/backfill`（重算待复核，TK-16） | `record.recalc_review` | 仅当新基线使下游命中 D-T19 防呆判定时产生**一行**：`new_value.items` 存可解释命中清单（与响应 `recalc.needs_review` 同源）、`reason` 记「请走异议流程人工核对」；**不改数、不拦提交、不 409**（L6 拍板），与 `record.recalc` 的区别是本行不代表已授权改数，只留待复核线索。**确认复用口径（订正 19）**：原提交已确认的命中不重复标出——回退按「field+prev+current 三元组」值匹配（基线变化的新命中仍标出，防字段级复用静默解锁）、充气按卡号复用（D-P14 事实语义） |
| POST `/records/today/withdraw` | `record.withdraw` | 谁（actor_id）、何时（created_at）；`old_value` 记 submitted 起点状态/版本/提交时刻，`new_value` 记 draft 归宿与版本（version 不变，TK-21） |
| POST `/records/{id}/objection` | `record.objection` | `old_value` 记 submitted 起点状态与版本，`new_value` 记 objection/版本与异议原因（note 全文，reason 列留空）；重提时 objection_note/at 保留在行上（D-T23），重提本体复用 `record.submit`（newValue 记 resubmitted: true 与新版本，reason=「异议修改后重提」） |
| POST `/records/{id}/confirm` | `record.confirm` | — |
| PUT `/admin/users`… | `user.update` | 新旧值 |
| PUT `/admin/schedules` | `schedule.update` | 新旧值 |
| `/admin/elevators`… | `elevator.update` | 新旧值 |
| `/admin/spots`… | `spot.update` | 新旧值 |
| PUT `/admin/configs/{key}` | `config.update` | 新旧值 |
| 提交时排班安全阀确认 | `record.guard_confirm` | F6-05 |

---

## 修订记录

1. **v0.1（2026-09-01）**：初稿。定义统一错误结构（C-09 落地：`missing_fields[].field/section/label/anchor`）、错误码表 14 项、Phase 1 路由 32 条（认证 3 / 今日交接与异议 10 / 电梯 2 / 确认 5 / 历史通知 3 / 后台 9，另预警中心与趋势 2 条 ⏸）、提交协议六步与服务端固化口径（DATA-09）、审计联动表。
2. **v0.1 订正（2026-09-02）**：TK-03（共享类型与错误契约）代码 review 后补明 §2 `missing_fields[]` 的取值口径：① `field` 除 records 列名外，**电梯核对行以 `elevator:{id}` 点名**——明细落 `elevator_checks` 逐台一行、records 无对应列，而 ELE-04-T2（不一致未填说明→拒绝）与 ELE-07-T1（无说明→「拦截并点名」）同受 C-09 约束，须支持点击跳转定位（原稿未明文，实现侧易误认为电梯不走点名结构）；② `section` 明确含 0（基础信息，如 `receiver_change_reason` 条件必填）与 9（电梯）；③ `anchor` 生成式写明为 `#sec-{板块号}-{field 的 kebab 形式}`（`_` 与 `:` 均转 `-`，如 `#sec-2-hp-status`、`#sec-9-elevator-3`）；④ 错误码表 ELEVATOR_EXPLANATION_REQUIRED 行补注点名形态。**另订正条目 1 的笔误：错误码表实为 13 项（原文写「14 项」）；条目 1 按「修订记录只追加不删除」纪律保留原文不改，以本条为准**。代码侧同步落地：`packages/shared/src/errors.ts` 的 `MissingTarget` / `fieldAnchor` / `toElevatorMissingField`、`sections.ts` 的 `ELEVATOR_SECTION_NO`。
3. **v0.1 修订（2026-09-02）**：TK-04（认证与账号）开工，按决策记录 **D-T13** 更新认证口径——§1「认证」行由「账号密码登录建立会话（Cookie）」扩为**双通道**（浏览器 HttpOnly Cookie / 非浏览器客户端 `Authorization: Bearer`，共用同一 `sessions` 存根；守卫先查 Header 再回落 Cookie；滑动超时取 configs `session_timeout_minutes`）；§3.1 三条路由补契约要点：`login` 请求体增可选 `channel`（默认 `cookie`；**`cookie` 通道响应体不返回令牌**以防 XSS 窃取、`bearer` 通道返回 `token`）、`logout` 明确为删除存根行使会话立即失效（不仅清 Cookie）、`me` 两通道均可鉴权，并补鉴权失败统一 401 / 角色不足 403 / 停用即删全部存根的口径。依据：技术方案 §6「会话机制」段与 §4.2 `sessions` 表（第 13 张）。
4. **v0.1 订正（2026-09-09）**：TK-05 实现评审跟进——§3.2 `GET /records/today` 角色列由 `master` 回写为 `master,chief`：实现已按 §1「chief（科长：全部 + 配置）」口径放行科长只读访问（`records.spec.ts` 固化用例钉死），原格子仅写 master 属文档遗漏，不另立守卫规则；§3.2 其余路由角色列不变（写入/提交链路是否覆盖 chief 待各任务落地时按同一口径回写）。
5. **v0.1 订正（2026-09-10）**：TK-07（上一班读数带出）落地联动——§3.2 `GET /records/today/prev` 角色列由 `master` 回写为 `master,chief`，与订正 4 同一口径（§1「chief：全部 + 配置」覆盖师傅端**只读**接口；`records-prev.spec.ts` 固化用例钉死）。另补明响应语义（实现侧已按此落地，`@handover/shared` dto 模块 `PrevDto` 为权威形状）：① 按班次日期取**紧邻前一条**记录，非 draft（已提交/异议/完成）才带出，**不跳班次回落更早记录**——前一条为 draft 时返回 `prev: null` 且非首班（F3-07 缺失态，前端显"—"并允许补录，复验挂任务分解 TK-14）；② 今日之前无任何记录 → `first_day: true`（F1-15 首班）；③ 液氧 8:30 卡的带出源为上一班记录的 2030 字段（DATA-02「取昨日记录 20:30（非今日）」，映射见 shared `cards.ts prevSourceField`，服务端原样回传 readings、映射由前端消费）。
6. **v0.1 订正（2026-09-11）**：TK-07 评审修复轮——§3.2 `GET /records/today/prev` 契约要点列精确化：原文「无则返回 `first_day: true`」中的「无」实际有**两种语义**（首班 / 上一班缺失），且取数口径按决策记录 **D-T17** 定案为**相邻班次**（duty_date = 今日班次日期 − 1 天）+ 非 draft 资格；相邻日无行（漏交，F6-06 检测的场景）或该行为 draft → `prev: null` 且非首班（缺失态），**不回落更早记录**（订正 5 的「紧邻前一条」按「过滤已提交后取最近一条」直读会在漏交日回落，与台账 F1-05-T2 判据「昨日无已提交记录 → 无带出值」冲突，定案以判据为准）。响应形状不变（权威形状 `@handover/shared` dto `PrevDto`）。
7. **v0.1 订正（2026-09-11）**：TK-08（草稿自动保存与续填）落地联动——§3.2 `GET/PUT /records/today/draft` 两行按决策记录 **D-T18** 标注**暂缓实现**：Phase 1 草稿层为客户端 IndexedDB（技术方案 §5.1 草稿层、D-T10 离线三层缓冲；键按用户与班次，tombstone 语义——清除只随本人登出/本人会话失效、登录 401 不清本机草稿——详见 D-T18），服务端不设在线草稿读写端点；records 行提交时一次性创建（record_no 生成时机不变，§4 第 5 步），draft 状态仅由撤回（F2-08，TK-21）产生。F1-09 判据用例为 E2E 层 `tests/e2e/tests/draft-persist.spec.ts`（F1-09-T1：关闭页面重开草稿恢复可续填）。
8. **v0.1 订正（2026-09-11）**：TK-09（液氧板块专项）落地联动——§4 补充 `lo_measured_am/pm` 的数据来源口径：由客户端填写液氧读数时自动记录（本机时刻，随 IndexedDB 草稿持久化即离线本地时间戳，映射与格式见 shared `cards.ts measuredAtTarget` / `calc.ts localMeasuredAt`），随 payload 上送、服务端原样落库，**不得以同步/接收时刻覆盖**（DATA-13-T2 判据；D-P12「读数自动记录实际测量时刻，名义时段仅用于卡片组织」），并与第 3 步用量列（服务端计算、不信任客户端传值）明确分源。接口层用例 DATA-13-T1/T2 的服务端「不覆盖」复验挂 TK-12 supertest（客户端半边已由 TK-09 落地：E2E `lo-tank.spec.ts` + 单元哨兵 `records-lo.spec.ts`）。
9. **v0.1 订正（2026-09-12）**：TK-11（新风多选）落地联动——§3 新增 **3.7 配置只读**：GET `/configs`（master,chief）为师傅端表单候选渲染提供 configs 表的**表单选项白名单只读视图**（现 `hvac_locs` / `boiler_list` 两键；非白名单运营键不出网，其读取归 §3.6 GET `/admin/configs`），值为 config_value 的 JSON 数组解析结果、非法回落空数组；角色列含 `chief` 依据 §1「科长：全部 + 配置」，与订正 4/5 同口径。响应形状权威定义 `@handover/shared` dto `FormOptionsDto`（api 产出、h5 消费同一份）。Phase 1 路由 32 → 33 条（订正 2 所述错误码表 13 项不变）。接口层用例 DATA-07-T1 的「候选与 configs 同步」半边已在 apps/api `configs.spec.ts` 落地；「多选保存 → 数组落库」依赖提交端点，复验挂 TK-12 supertest（§3.2 POST `/records/today/submit` 契约不变）。
10. **v0.1 订正（2026-09-12）**：TK-11 评审修复轮——① §3.7 契约要点补明：**提交侧不校验 `hvac_locs` / `boiler_list` 的候选成员性**（服务端仅做 JSON 数组解析回传；h5 离线/端点不可达时以《开发种子数据》占位候选降级渲染，若提交校验按候选成员性拦截会把降级路径变成 400，违反 F1-09 续填与 C-01；成员性校验如确需引入，随 TK-27 配置中心一并评估并回改本表）。② 响应形状由开放索引签名收窄为**显式键映射**（键集单一来源 shared `FORM_OPTION_CONFIG_KEYS`，拼错键名编译期即报），权威形状仍 `@handover/shared` dto `FormOptionsDto`。
11. **v0.1 订正（2026-09-12）**：TK-12（在线提交与预览）落地联动——§3.2 三行契约要点回填：GET `/records/today` 补「接班人按次日排班自动带出」（F2-01/DATA-10，`TodayDto.receiver` 由恒 null 转为带出值）；`/records/today/preview` 补响应权威形状 shared `PreviewDto`（未填项/异常项两张清单，结构同 §2 `missing_fields`，接班人修改原因条件预检一并点名）；`/records/today/submit` 补落地口径（record_no 格式 `HB-YYYYMMDD-001`、submitted_at=服务端收到时刻（DATA-09）、接班人带出与修改必填原因留痕（DATA-10）、角色列 master 不适用 chief 只读回写口径）。§4 处理顺序挂账现状：第 1 步校验（shared 引擎，含 `FIELD_PRECISION` 派生上限与 parseNumeric 十进制收紧）、第 5/6 步（record_no、submitted_at、审计含接班人修改 reason）已落地；第 2 步防呆 409 随 TK-14（`confirmations`/`duty_guard_confirm` 字段本阶段仅接收不判定）、第 3 步用量固化随 TK-13（`*_use` 提交置 NULL、客户端传值不信任）、第 4 步 alerts 标红随 TK-17/TK-22。补充口径（台账增补 #16）：boiler_run='stop' → 三项停机列强制写 NULL（落库第二道）。DATA-13-T1/T2 服务端「不覆盖」复验已落地（lo_measured_am/pm 原样落库，与 submitted_at 分源）；DATA-07-T1 数组落库复验已落地（hvac_locs JSON 数组原样、不做候选成员性校验，§3.7 口径不变）。错误码表 13 项与路由总数（33）不变。
12. **v0.1 订正（2026-09-12）**：TK-12 评审修复轮——§4 第 1 步校验口径精确化（错误行为从「可能 500」收敛为「一律 400 点名」）：① 数值字段校验含列精度**位数与小数位**两层（小数位超 DECIMAL(p,s) 的 s 以 VALIDATION_OUT_OF_RANGE 点名，不再被 MySQL 静默改写）；② 文本列长度超 `FIELD_LENGTHS`（varchar 照录 §4.2）以 VALIDATION_OUT_OF_RANGE 点名；③ 测量时刻须为日历有效的 `YYYY-MM-DD HH:mm:ss` 本地时间戳，非法**置 NULL 落库**（不拦提交、不覆盖为服务端时刻，DATA-13/D-P12 分源口径不变）；④ 多选字段元素须为字符串（候选成员性仍不校验，§3.7）；⑤ 接班人：receiver_id 显式上送时一律校验用户存在（不存在 → 400 点名 receiver_id）；无次日排班带出基线时显式指定接班人视为修改、receiver_change_reason 转必填（保守口径，台账增补 #20 留痕，科长复核可放宽）。错误码表 13 项与路由总数（33）不变。
13. **v0.1 订正（2026-09-12）**：TK-13（用量计算引擎）落地联动——§4 第 3 步用量固化落地：水/电/气/液氧日间四类口径以 shared `calc.ts` 纯函数为单一权威实现（`waterDayUseOf`/`eDayUseOf` 分线+合计/`gasDayUseOf`/`loDayUseOf`），服务端提交时计算固化，上一班取数与 GET `/records/today/prev` 共用同一相邻班次取数（D-T17，不回落更早记录）；上一班缺失 → 用量列固化 null（F3-07 补录随 TK-14）。**新增覆盖协议**：请求体增 `usage_overrides[]`（`field` ∈ shared `USAGE_FIELDS` = water_use/e_use/gas_use/lo_day_use、`value` 十进制字面量按列精度取整、`reason` 必填）——原因空白/值非法/越键即 400 逐条点名（F3-06-T2 服务端强制）；合法覆盖以覆盖值固化并写审计 `record.usage_override`（§5 审计表新增行，old_value 记覆盖前自动值），读取侧 GET `/records/today` 字段状态增 `manual` 旗标（F3-06-T1「自动计算」标识与人工值可区分）。响应形状权威定义 `@handover/shared` dto（`UsageOverridePayload` / `CardFieldStateDto.manual`）。充气确认后该卡按 0 计（D-P14）属 TK-14 确认后的取数层，未确认时负差原样固化。Phase 1 路由总数（33）与错误码表（13 项）不变。
14. **v0.1 订正（2026-09-12）**：TK-13 独立评审修复轮——① §4 第 3 步校验口径补齐：preview 与 submit 消费同一 `validateUsageOverrides`，`usage_overrides` 的越键/原因空白/原因超长/值越界/同字段重复上送均在**预览即点名**（消除「预览全就绪、提交却 400」，TK-12 评审 L4 同纪律）；覆盖原因超长（audit_logs.reason varchar(200)）以**字段字典名义**点名（与 receiver_change_reason 超长同口径，不再误用「不支持的用量覆盖字段」）。② `manual` 旗标按**当前版本**判定：record_no 恒为 `HB-YYYYMMDD-001`（duty_date UNIQUE），撤回重提/异议重提跨版本共用 targetId 且审计只增不删（D-T09）——旧版本的覆盖不再标到已回到自动值的当前版本上（F3-06-T1），TK-16 重算豁免（D-T07）的判定依据随之钉死为「当前版本的 record.usage_override 行」。③ 服务端计算值超 DECIMAL 列容量（两线差值各自合法但之和可超 (12,1)）→ 该用量列置 null 不入库并记 error 日志（不 500）。④ **覆盖字段范围定案（宽口径）**：D-P08 字面「水/电/气/液氧……手工覆盖必填原因留痕」为准，`USAGE_FIELDS` 四键均可走 `usage_overrides[]`；fields 字典 `fill='auto'` 的语义钉死为「服务端自动计算固化 + Phase 1 无 h5 覆盖入口」，与覆盖协议分属两层——水/电/气三列的 h5 覆盖入口挂账（随记录详情/科长后台任务评估）。错误码表 13 项与路由总数（33）不变。
15. **v0.1 订正（2026-09-13）**：TK-14（防呆三则）落地联动——① **§3.2 submit 行**回填：防呆 409 已随 TK-14 落地；② **§4 第 2 步**细化（判定范围与确认协议定案见决策记录 **D-T19**）：判定范围 = 累计走字表三字段（water_reading/e1_reading/e2_reading，F1-12 读数回退）与两气卡（g1/g2_remaining，F1-13 充气按卡逐项，D-P14 单卡判定；液氧含量递减是常态不入判定）；上一班缺失时以请求体 `prev_readings` 补录值为比对与计算基线（仅**非首班的缺失态**消费，有上一班记录时忽略）；任一侧读数缺失不判定；409 时回退与充气同时命中则 `READINGS_DECREASED` 优先；确认消费口径：reason 空白视为未确认（F1-12-T2 不因重试放行）、与命中项对不上号的确认不消费、仅命中项的确认写审计；充气确认成立的卡按 0 计（经 shared `calc.ts gasDayUseOf` 的 `refilled` 参数，D-P14）；③ **§4 第 1 步**补 `prev_readings` 同口径预检（白名单 `PREV_BACKFILL_FIELDS` 外键忽略、非十进制字面量 400 越界点名，校验与消费解耦）；④ **§5 审计表**：`record.submit` 行精确化为「各防呆确认原因逐命中项一行」，新增 `record.prev_backfill` 行（补录值不落 records 列、审计存全量补录值）。权威形状：`@handover/shared` dto `SubmitPayloadDto.prev_readings` / `ConfirmItem` / `ConfirmationPayload`（TK-03 预留类型启用）。错误码表 13 项不变；Phase 1 路由总数（33）不变。**另订正：移除修订记录末行一条乱码损坏的重复行**（「13. v0.1 计正…」——历次会话编辑事故产生的条目 13 乱码复本，非真实修订条目；按编号纪律真实条目原文一律保留，仅清除该损坏复本并以此条留痕）。
16. **v0.1 订正（2026-09-13）**：TK-14 独立评审修复轮（错误行为继续从「可能 500」收敛为「一律 400 点名」，订正 12 同纪律）——① **§4 第 1 步校验补齐**：`confirmations[]` 非数组 → 400 合成定位项点名（field='confirmations'，域外回显同订正 2 ① 先例；undefined 未上送仍合法）；确认原因超 `audit_logs.reason` varchar(200) → 400 越界点名、以字段字典名义（reading_decreased 点该 field、gas_refill 点对应气卡字段，与用量覆盖原因超长同口径，订正 14 ①）——原实现直写审计列 → MySQL 严格模式 1406 → 事务回滚 500（评审探针实证）；`usage_overrides` 非数组同口径 400 点名；preview 与 submit 消费同一 `validateConfirmations`（预检即点名，订正 14 ① M3 同纪律）。② **`prev_readings` 补录值**补列容量上限（`numericMaxOf`）与非负下限校验，越界 400 点名——脏基线不再进入 `need_confirm` 可解释文案与 `record.prev_backfill` 审计。错误码表 13 项与路由总数（33）不变。
17. **v0.1 订正（2026-09-13）**：TK-16（下游重算与豁免）落地联动，决策记录 **D-T21** 拍板（闭环订正 12/15 阶段挂账的补交端点悬案，D-T20 修订 12 的待拍板项就此定案）——① **§3.2 新增路由 POST `/records/backfill`**（master,chief；跨班次补交：payload 显式 duty_date 严格早于当前班次、提交人恒为登录人本人、该班次已有任何记录 409 RECORD_EXISTS、其余请求体与 submit 同形且校验/防呆/覆盖/补录协议同口径 submitCore 单一实现），**Phase 1 路由 33 → 34 条**；错误码表 13 项不变（复用 VALIDATION_OUT_OF_RANGE / RECORD_EXISTS / READINGS_DECREASED / GAS_REFILL_CONFIRMED）。② **§4 补交口径**：复用六步协议，差异=显式 duty_date + 补交语境 409 + 第 5 步后同事务下游重算。③ **§5 审计表新增两行**：`record.late_submit`（补交本体）与 `record.recalc`（逐变更项，手工覆盖豁免 D-T07，判定依据=当前版本 record.usage_override 行，订正 14 ② 同源）。④ 响应形状权威定义 shared dto `BackfillPayloadDto` / `SubmitResultDto.recalc`（在线提交响应无 recalc 键）。
18. **v0.1 订正（2026-09-14）**：TK-16 **独立评审修复轮**（评审报告 M1 + L1–L9 + m1–m5；M1 与「值无变化」相关项已修，四项语义由用户拍板）——① **M1 数值判等**：重算的「值是否变化」原按字符串比较，而计算侧产出 `String(roundToScaleOf(..))`（整数→'500'）与 DECIMAL(12,1) 列读回的 '500.0' **恒不相等**→ 整数用量总被误判为变更，产生假 UPDATE + 假 `record.recalc` 审计（探针实证；水/电/气读数多为整数，即绝大多数真实场景），现改按数值判等（null 与非 null 视为不同），§5 `record.recalc` 行同步写明判等口径。② **L1**：三项全无变更时 `recalc` 返回 **null**（原返回 `{fields: []}` 与本表/DTO 注释不符）。③ **L2 状态门控（拍板）**：只重算 `status='submitted'` 的下游单——原实现仅排除 draft，**`objection`/`completed`（已进确认流程或已双方签名归档）可被一次补交静默改掉数字**，与 §5.4/DEP-08 的签名件语义相逆；现跳过并留日志（人工处置走异议流程/科长后台）。④ **L3 补交窗口（拍板）**：`duty_date` 新增下限 = 当前班次 − configs **`backfill_window_days`**（种子 7，❓ 待科长确认，台账待确认清单第 10 项），越界 400 点名 `duty_date`——原无下限，任意久远日期（如 2000-01-01）可被凭空补交并触发重算，污染 F6-06 漏交统计与历史报表。⑤ **L5 draft 接管（拍板）**：补交由「任何已存在行一律 409」改为**仅非 draft 行 409**，draft 行走更新+version+1 分支——原口径与「submit 只认当前班次」合起来使「提交→撤回→离院未重提」的班次永久无法入库。⑥ **L6 待复核清单（拍板）**：新增 `recalc.needs_review`（shared dto `RecalcResultDto`，`fields` 同时收窄为 `readonly UsageFieldName[]`）与§5 新行 **`record.recalc_review`**：重算不重跑防呆拦截，但新基线命中 D-T19 判定时（如补交的 D 日读数高于 D+1 自己→本应强制确认的回退以负差入库）**不改数不拦提交而是标出待人工核对**，堵住 F1-12 在回写链路上的旁路。⑦ **m1 错字订正**：§4 补交口径原文「当日/未来班次走**本路由**」应为走 `/records/today/submit`（契约是验收权威，反向阅读会直接导致误改）。⑧ **挂账显式化**（本轮不实现，防静默缺口）：**无 `/records/backfill/preview`**——现有 preview 的接班人基线取当前班次，补交带 `receiver_id` 时「预览就绪/提交 400」的不对称仍存在（订正 12/14 的「预检即点名」纪律），**随 h5 补交入口（TK-24）一并落地**；chief 在补交写链路的例外授权即 D-T21 拍板（与 §3.2 submit 行「提交链路 master，不适用 chief 只读回写口径」不冲突：该纪律限**当日**提交链路，补交是「晚到自救」的独立写链路）；**补交班次的排班归属校验**（防师傅冒名补交他人班次记在自己名下）随 F6-05 安全阀同一出口，**挂 TK-26**；重算对下游行的快照读写无行锁（丢更新窗口）与并发撞 `duty_date` UNIQUE 的 1062→409 归一，**随 TK-20 复用同一重算方前必须补**。错误码表 13 项与路由总数（34）不变。
19. **v0.1 订正（2026-09-14）**：TK-16 修复轮**红队对抗评审**（无 M 级，任务分解修订 32）——§5 `record.recalc_review` 行补**确认复用口径**：重算的待复核清单对下游原提交已确认的命中不重复标出，但两类确认复用规则不同——**回退按值匹配**（field+prev+current 三元组一致才消音；重算会改变上一班基线，字段级复用会让新基线下更大的回退被旧确认静默解锁，D-T20 M6 同族陷阱）、**充气按卡号复用**（D-P14 事实语义：已确认卡按 0 计取数，不随基线变化）。响应形状不变（`RecalcResultDto`）；权威形状 shared guard `needConfirmItemsExcludingHits` / `decreaseHitKey`（与既有 `unconfirmedNeedConfirmItems` 共用同一清单组装，提交链路行为不变）。错误码表 13 项与路由总数（34）不变。
20. **v0.1 订正（2026-09-14）**：TK-17（电梯核对·表单端）落地联动，**D-T22 拍板**——§3.3 两行改写：① GET `/elevators/expected` 改**只读计算不落库**（原「生成 elevator_checks 明细行」的写副作用与 D-T18「records 行提交时一次性创建」冲突，elevator_checks.record_id NOT NULL 提交前无行可挂），角色列放宽 chief（与 today/prev 同口径）；② POST `/records/today/elevator-checks` **并入 §4 提交协议**（请求体 `elevator_checks[]`，独立端点行标注作废不再实现）。§4 补「电梯核对口径」段：第 1 步预检 + 第 2 步后 409 ELEVATOR_EXPLANATION_REQUIRED + 落库按 check_time 重算 expected（ELE-05 口径）+ 不一致写 alerts（level=mid）；§5 无新增审计行（elevator_checks 明细 + alerts 标红即留痕）。§3.3 表 POST 行的「关联规格」补 ELE-05（check_time 锁定随本载体落库）。原文按「修订记录只追加不删除」保留于修订记录外正文（表格行已原位改写，语义以本条为准）。联动：决策记录 D-T22、台账增补 #30、技术方案修订 25、任务分解修订 33。
21. **v0.1 订正（2026-09-15）**：TK-17 **独立评审修复轮**（探针实证 M1/M2 + L1/L2/L3/L4 全处置）——① **§4 电梯核对口径补 `check_time` 来源**：由客户端在师傅落笔瞬间以本机时钟生成（D-T22 修订⑤，DATA-13 同口径），禁止沿用拉取到的快照时刻；离线/页面挂机下这会把几小时前的拉取时刻记成核对时刻，使服务端按该时刻重算的预期算错并抑制「该停没停」标红（ELE-03/05/06 同时受损）。② **409 ELEVATOR_EXPLANATION_REQUIRED 明确必带 `missing_fields[]` 且客户端须与 400 同处理**（逐条点名 + 点击跳转、不清已收集的防呆确认）——原实现把该 409 当「其余 409」只留 toast，C-09 在电梯场景失效。③ `elevator_id` 收紧为**整型 number**（'3'/'1e2'/[3] 一律形态错 400 点名，禁 Number() 宽松转换导致的串台核对）；脏项点名改带序号的 `elevator_checks[i]` 合成定位项（避免 `elevator:0` 同 key 碰撞，域外回显同订正 2 先例）。④ 不一致标红行与明细行同快照：重提同事务先清后插。⑤ **路由计数订正**：§3.3 经订正 20 后实装为 1 条（GET /elevators/expected），订正 17 记的「路由 33→34」现净为 **33 条**（电梯 2→1）。联动：决策记录 D-T22 修订（增补 17）、技术方案修订 26、台账增补 #31、任务分解修订 34。
22. **v0.1 订正（2026-09-15）**：TK-18（待确认入口与逐项浏览）落地联动——① **§3.4 两行契约要点回填**：GET `/records/pending` 补取数口径细化（draft/objection/completed 不产生待确认入口，与 F2-08「接班人端入口同步消失」的取数半边一致）与逐单 `alert_count`（alerts 行数，与详情同源），权威形状 shared dto `PendingListDto`；GET `/records/{id}` 补 alerts **置顶序**（level high→mid→low 由服务端排好，shared `ALERT_LEVEL_RANK` 单一权威，前端顺序渲染即满足 F2-03-T1）与电梯核对联字典回显，权威形状 shared dto `RecordDetailDto`（F2-03 与 F5-01 共用，`acknowledged_*` 字段先行、逐条知晓随 TK-19）。② **§4 第 4 步补全落地**（原文「生成标红确认行（状态异常/电梯不一致/交接事项拆条）写入 alerts（DEP-08）」此前仅电梯不一致随 TK-17 落地）：状态异常 rule_key=`{field}_bad`、level=high（PRD §6.4「状态=异常→高」的 Phase 1 标红过渡，DEP-07），异常备注并入文案（`*_status`→`*_note` 成对取值）；交接事项 rule_key=`handover_note`、level=low，按换行/编号分条（拆条纯函数 shared `handoverItemsOf` 单一权威实现）；形态与《开发种子数据》§六 D-1 配套标红行同形，重提同事务先清后插快照语义（TK-17 L3 同纪律）。无新增路由与错误码（detail 复用 NOT_FOUND，非数字 id 亦按契约 §2 统一结构 404）；Phase 1 路由总数（33）与错误码表（13 项）不变。联动：台账增补 #32、任务分解修订 35。

23. **v0.1 订正（2026-09-15）**：TK-19（逐条知晓与签名归档）落地联动——**§3.4 acknowledge/confirm 两行契约要点回填**（原文仅一句纲要）：① acknowledge：body `alert_ids[]`（权威形状 shared dto `AcknowledgePayloadDto`）、已知晓行不重复写（首次知晓时刻即留痕，响应 `{acknowledged}` = 本次新写入行数）、跨单/未知 id 容错忽略、非数组 400 合成定位项点名（confirmations 先例同门）、仅接班人本人（他人 403）、留痕落 alerts 行本身不另写审计（§5 审计表无新增行，行级归属即审计）；② confirm：body 传签名图 **PNG data URL**（权威形状 shared dto `ConfirmPayloadDto`），解码校验（`data:image/png;base64` 前缀 + PNG 魔数 + ≤512KB）后落盘 `/uploads/signatures/{record_no}.png` 记 signature_path（与《开发种子数据》completed 单同形态），confirmed_at=服务端时刻（DATA-09 同口径），**完整性终校与转 completed 同事务**（防「知晓与归档并发」中间态入档），成功转 completed（响应权威形状 shared dto `ConfirmResultDto`）并审计 `record.confirm`（§5 该行原文不变）；仅接班人本人可确认（C-05/D-P06）；非 submitted 状态的 acknowledge/confirm 归入 409 CONFIRM_INCOMPLETE 同族（文案区分语义，**错误码表 13 项不变、不增设新码**）。无新增路由（两条均为 §3.4 原有行），Phase 1 路由总数（33）不变。联动：台账增补 #33、任务分解修订 36。

24. **v0.1 订正（2026-09-15）**：TK-20（异议与版本）落地联动，决策记录 **D-T23** 拍板（四项：PUT 直写行+首改快照 / resubmit 载体收窄 / 仅接班人本人 / 重提保留 objection 字段）——① **§3.2 异议三行与 §3.4 objection 行契约要点回填**（权威形状 shared dto `ObjectionListDto`/`ObjectionPayloadDto`/`ObjectionResultDto`/`RecordUpdatePayloadDto`/`ResubmitPayloadDto`/`ResubmitResultDto`）；② **§3.4 detail 行补历史版本摘要 versions**（F2-07-T1「历史版本可查」的查询面：version/editor 联 users 回显/edited_at/changed 字典名 → {旧值,新值}；全字段快照留 record_versions.snapshot 不入响应；无修改历史为空数组）；③ **§5 record.objection 行补 newValue 口径**（note 全文入 newValue，reason 列留空）；§5 record.recalc/recalc_review 触发语境扩展 trigger=objection_resubmit（检索键 source_record_no，late_backfill 的历史键名 backfill_record_no 不变，records-backfill.spec 断言锚点不变）；④ **订正 18 ⑧ 挂账闭环**：重算下游行 SELECT ... FOR UPDATE（并发触发源读-改-写不再互相覆盖），submitCore 事务捕获 ER_DUP_ENTRY（errno 1062）归一 409 RECORD_EXISTS——不再 500；⑤ **重提审计复用 record.submit**（§5 无独立 resubmit 行）：newValue 记 resubmitted: true 与新版本，防呆确认与用量覆盖留痕同 submit 口径随重提写入。错误码表 13 项不变、路由总数 33 不变（四条异议路由均属 §3.2/§3.4 既有行）。测试：records-objection.spec 5 项（F2-06-T1/F2-07-T1 + 闸门/快照累计/重提防呆），jest 全量 205/205（重灌种子）、E2E 53/53。联动：台账增补 #34、技术方案修订 27、决策记录增补 18、任务分解修订 37。

25. **v0.1 订正（2026-09-16）**：TK-21（撤回窗口）落地联动（D-P05 既有拍板，无新决策）——① **§2 错误响应结构新增可选字段 `reason`**：原错误码表把 WITHDRAW_NOT_ALLOWED 的三原因写成括注（`reason`: WINDOW_EXPIRED/ALREADY_CONFIRMED/IN_OBJECTION），但§2 响应体无此字段、F2-10-T1/T2/T3 无可断言载体——升为正式响应字段（仅 WITHDRAW_NOT_ALLOWED 使用，其余错误码恒 null；权威形状 shared `ApiError.reason`，与已有 `WithdrawNotAllowedReason` 枚举呼应）；§2 JSON 示例与错误码表同步回写。② **§3.2 GET /records/today 要点补 `withdraw_window_minutes`**：服务端读 configs（非法/缺失回落 10，与种子同源）、供前端算撤回倒计时（F2-09-T1），与撤回校验同源不漂移（权威形状 shared `TodayDto`）。③ **§3.2 POST /records/today/withdraw 行要点回填**（原文仅一句纲要）：按当前班次（C-08）+submitter 定位、行锁下三不可撤条件（状态锁定先于窗口）、成功转 draft+清 submitted_at+同事务清 alerts/elevator_checks、version 不变（重提才 +1）、待确认入口同步消失、审计 record.withdraw（权威形状 shared `WithdrawResultDto`）。④ **§5 record.withdraw 行补 old_value/new_value 口径**。错误码表 13 项不变（reason 为 WITHDRAW_NOT_ALLOWED 的子原因载体、非新码）、路由总数 33 不变（withdraw 为 §3.2 既有行）。测试：records-withdraw.spec 8 项（F2-08-T1/T2、F2-09-T2、F2-10-T1/T2/T3 + 闸门 403/401/404/draft 重复撤回 409 + today 回传窗口黄金值），E2E withdraw.spec 2 项（F2-09-T1 倒计时客户端半边）。联动：台账增补 #35、任务分解修订 38。

26. **v0.1 订正（2026-09-16）**：TK-22（服务端定时任务四件）落地联动——① **§3.5 两行契约要点回填**（权威形状 shared dto `NotificationDto`/`NotificationListDto`/`NotificationReadResultDto`，kind 枚举 shared `NOTIFICATION_KINDS`；GET 仅回当前登录人**未读**（id 倒序 + unread 总数，角标数据源语义）；POST read 幂等回首次时刻、非本人/不存在/非数字 id 统一 404 结构）；② 定时任务的产生侧口径（不在路由表、随本条留痕）：四扫描 confirm_due / objection_escalated / missing_submit / 会话清理的时间由调用方注入（生产 @nestjs/schedule 喂系统时钟 5/30/30/60 分钟，测试直调），去重口径——F2-11 键 (kind, record, receiver) 带 submitted_at 水位、F2-12 键 = escalated_at 原子闸门、F6-06 键 (chief, title)（title 携带 duty_date）、扫描窗口 = 当前班次 − `backfill_window_days`；提醒目标：F2-11 → 记录接班人，F2-12/F6-06 → 全部 active 科长；通知落 notifications 表不经审计拦截器（非用户变更类路由，§5 审计联动表不含定时任务）。错误码表 13 项不变、路由总数 34 不变（§3.5 两行均系既有行）。测试：notifications.spec 7 项（F2-11-T1/F2-12-T1/F6-06-T1 + 时点可配两轮扫描、窗口外不提醒、会话清理、闸门回归），jest 全量 220/220（重灌种子）、E2E 55/55。联动：台账增补 #36、技术方案修订 28、任务分解修订 39。
