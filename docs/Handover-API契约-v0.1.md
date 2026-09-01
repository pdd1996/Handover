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
| 认证 | 账号密码登录建立会话（Cookie）；会话超时自动退出（技术方案 §6） |
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
- `missing_fields[]`：**缺失/越界字段逐条点名**——`field` 列名、`section` 板块序、`label` 中文名、`anchor` 前端跳转锚点；无缺失类错误时为 `null`
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
| 409 | ELEVATOR_EXPLANATION_REQUIRED | 电梯不一致未填说明 | ELE-04、ELE-07 |
| 409 | RECORD_EXISTS | 当日记录已提交（duty_date 唯一） | F1-01 |

## 3. 路由总表

### 3.1 认证

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| POST `/auth/login` | 公开 | 登录 | F1-11 | 成功建会话并写审计（设备、IP）；失败不泄露账号是否存在 |
| POST `/auth/logout` | 登录用户 | 登出 | F1-11 | 会话失效 |
| GET `/auth/me` | 登录用户 | 当前用户与角色 | F1-11 | 返回 id/real_name/role |

### 3.2 今日交接（师傅端）

| 方法与路径 | 角色 | 用途 | 关联规格 | 契约要点 |
| --- | --- | --- | --- | --- |
| GET `/records/today` | master | 首页卡片汇总 | F1-01、F1-02、F1-03 | 返回各板块填写状态、角标统计、今日记录状态、待同步标记 |
| GET `/records/today/prev` | master | 上一班读数带出 | F1-05、DATA-02 | 按 duty_date 取前一条**已提交**记录；含液氧昨日 20:30 值；无则返回 `first_day: true`（F1-15） |
| GET `/records/today/draft` | master | 读取在线草稿 | F1-09 | 服务端 draft 暂存（离线草稿在客户端，不经此接口） |
| PUT `/records/today/draft` | master | 保存草稿（局部） | F1-09 | 不做业务校验，仅结构与范围检查 |
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
