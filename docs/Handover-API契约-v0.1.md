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
  "request_id": "req-xxxx"
}
```

- `code`：机器可读错误码（见 §3 错误码表）
- `missing_fields[]`：**缺失/越界字段逐条点名**——`field` 点名对象（records 列名；**电梯核对行为 `elevator:{id}`**，因明细落 `elevator_checks` 逐台一行、records 无对应列，而 ELE-04/ELE-07 同受 C-09「所有拦截逐条点名 + 点击跳转定位」约束）、`section` 板块序（0=基础信息，1~10=业务板块，电梯为 9）、`label` 中文名、`anchor` 前端跳转锚点（生成式 `#sec-{板块号}-{field 的 kebab 形式}`，`_` 与 `:` 均转 `-`）；无缺失类错误时为 `null`
- `need_confirm`：防呆/安全阀需确认时为确认对象（见 §4 提交协议），否则 `null`
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
| 409 | WITHDRAW_NOT_ALLOWED | 不可撤回（`reason`: WINDOW_EXPIRED / ALREADY_CONFIRMED / IN_OBJECTION） | F2-10 |
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
| GET `/records/today` | master,chief | 首页卡片汇总 | F1-01、F1-02、F1-03 | 返回各板块填写状态、角标统计、今日记录状态、待同步标记 |
| GET `/records/today/prev` | master,chief | 上一班读数带出 | F1-05、DATA-02 | 按 duty_date 取**相邻班次**（今日班次日期 − 1 天，D-T17）**已提交**记录；含液氧昨日 20:30 值；相邻日无行（漏交）或为 draft → `prev: null` 且非首班（F3-07 缺失态）；今日之前无任何记录 → `first_day: true`（F1-15）；**不回落更早记录** |
| GET `/records/today/draft` | master | 读取在线草稿 | F1-09 | **暂缓实现（D-T18）**：草稿层为客户端 IndexedDB（技术方案 §5.1），服务端不设在线草稿读写；跨设备续填需求出现时再评估恢复本路由 |
| PUT `/records/today/draft` | master | 保存草稿（局部） | F1-09 | **暂缓实现（D-T18）**：同上；records 行提交时一次性创建，draft 状态仅由撤回（F2-08，TK-21）产生 |
| POST `/records/today/preview` | master | 提交前预览 | F1-10 | 返回未填项清单与异常项清单（结构同 `missing_fields`） |
| POST `/records/today/submit` | master | 正式提交 | F1-01、F1-07、F2-01、DATA-09、DATA-10 | 详见 §4 提交协议 |
| POST `/records/today/withdraw` | master | 撤回 | F2-08、F2-09、F2-10 | 服务端校验三条件；失败 409 WITHDRAW_NOT_ALLOWED；成功回可编辑并留痕 |
| GET `/records/mine/objections` | master | 我被退回的异议单 | F2-06 | 供下次到岗处理（F2-13） |
| PUT `/records/{id}` | master | 异议单修改（objection 状态） | F2-07 | 全字段快照入 record_versions |
| POST `/records/{id}/resubmit` | master | 异议修改后重提 | F2-07 | 版本+1；重新走提交校验与计算 |

### 3.3 电梯核对（师傅端）

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/elevators/expected` | master | 当前时刻逐台预期状态 | ELE-03 | 服务端按**当前时刻**计算并生成 elevator_checks 明细行（check_time 锁定，ELE-05） |
| POST `/records/today/elevator-checks` | master | 提交逐台核对结果 | ELE-04、ELE-06、ELE-07 | `actual`（match/run/stop/fault）+ 不一致必填 `explanation`（缺则 409）；不一致生成标红确认行 |

### 3.4 交接确认（接班人）

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/records/pending` | master | 待确认列表 | F2-02 | 我为 receiver 且 status=submitted |
| GET `/records/{id}` | 登录用户 | 交接单详情 | F2-03、F5-01 | 含全部读数、标红项（alerts）、电梯核对、版本摘要、双方确认信息 |
| POST `/records/{id}/acknowledge` | master | 逐条"已知晓" | F2-04、DATA-08、DEP-08 | body 传 `alert_ids[]`，逐条写 acknowledged_by/at |
| POST `/records/{id}/confirm` | master | 签名归档 | F2-04、F2-05 | body 传签名图；服务端校验全部确认行已知晓（409 CONFIRM_INCOMPLETE）；成功转 completed |
| POST `/records/{id}/objection` | master | 标注异议 | F2-06 | `note` 必填；转 objection 并记 objection_at |

### 3.5 历史与通知

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/records` | 登录用户 | 历史记录筛选 | F5-01、F6-01 | `from/to/submitter_id/status`；师傅看全部、科长同 |
| GET `/notifications` | 登录用户 | 站内通知（未读角标） | DEP-04、F2-11、F2-12、F6-06 | kind: confirm_due / objection_escalated / missing_submit / alert_push（P2）/ monitor |
| POST `/notifications/{id}/read` | 登录用户 | 标记已读 | DEP-04 | — |

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
  "duty_guard_confirm": { "confirmed": true, "reason": "替班" }
}
```

服务端处理顺序（全部同事务）：

1. 必填/范围校验 → 失败 400（C-09 结构）
2. 防呆判定（读数回退/充气/排班安全阀）→ 有未确认项时 409 并在 `need_confirm` 返回确认清单；客户端弹窗收集 `confirmations` 后重提
3. 用量计算并固化（F3）：`*_use` 由服务端计算写入，客户端传值仅作展示预览，**不信任**
4. 生成标红确认行（状态异常/电梯不一致/交接事项拆条）写入 alerts（DEP-08）
5. 记录转 submitted，`submitted_at` = 服务端收到时刻（DATA-09：离线场景下即同步成功时刻）；生成 record_no
6. 写审计（含覆盖/确认原因）

补充口径（TK-09，DATA-13/D-P12）：`lo_measured_am` / `lo_measured_pm` 由**客户端填写液氧读数时自动记录**（本机时刻，随 IndexedDB 草稿持久化即离线本地时间戳），随 payload 上送、服务端**原样落库**——不得以同步/接收时刻覆盖（DATA-13-T2 判据）。与第 3 步的用量列（服务端计算、不信任客户端传值）不同源：测量时刻的事实发生在本机，本机时间戳即唯一权威来源。

## 5. 审计联动表（变更类路由 → audit_logs.action）

| 路由 | action | 备注 |
| --- | --- | --- |
| POST `/auth/login` | `login` | 设备、IP；失败也记 |
| POST `/records/today/submit` | `record.submit` + 各确认原因 | reason 列记防呆/充气/覆盖原因 |
| POST `/records/today/withdraw` | `record.withdraw` | 谁、何时 |
| POST `/records/{id}/objection` | `record.objection` | — |
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
