# Handover · 埋点与度量清单（v0.1）

- **定位**：PRD §4 成功度量与 §8"上线后头两周监测"的**采集方案**，补上 PRD 薄弱章节提示中的"埋点清单未定义"。原则：**能从现有表推导的指标不埋点**（电子交接率、确认完成率、可追溯率），只有客户端行为指标（填写耗时、草稿放弃、同步成功）需要埋点。
- **上游文档**：《PRD v0.2.8》§4 度量表、§8 监测项；《规格台账 v1.3》DEP-11、C-01、C-07；《开发种子数据 v0.1》（口径验证环境）
- **生成时间**：2026-09-01
- **状态**：v0.1 **待采纳**——含一处表结构增补建议（telemetry_events），采纳时按 §5 修订联动回写上游文档

---

## 一、指标口径表（每项 PRD 指标都有可计算的公式）

| 指标 | 目标值 / 时间窗 | 口径公式 | 数据来源 | 采集方式 |
| --- | --- | --- | --- | --- |
| 电子交接率 | 100% / 上线后 30 天 | 已提交记录数 ÷ 应提交班次天数（schedules 中有排班的 duty_date 数） | records + schedules | **推导，无需埋点** |
| 单次填写耗时 | ≤ 10 分钟 / 30 天 | 当日 `fill_session_start` 至该记录 `submitted_at` 的时长；报中位数与 P90 | EVT-01 + records | 埋点 |
| 异常自动标记率 | 100% / Phase 2 上线即达成 | 命中规则并生成 alerts 的项 ÷ 实际达到阈值的项 | alerts + configs | 用例回归保障 + 推导（P2） |
| 交接确认完成率 | ≥ 95% / 60 天 | confirmed_at 非空的已提交单 ÷ 全部已提交单 | records | **推导，无需埋点** |
| 数据可追溯率 | 100% / 上线即达成 | 可查到完整记录的历史班次 ÷ 全部历史班次 | records | 推导（用例 F5-01 保障） |
| 草稿放弃率（监测项） | 上线头两周监测 | `draft_abandoned` 事件数 ÷ `fill_session_start` 次数 | EVT-06 + EVT-01 | 埋点 |
| 离线同步成功率（监测项） | 上线头两周监测 | `sync_result(succeeded)` ÷ 全部 `sync_result` | EVT-05 | 埋点 |
| 预警准确率（反指标，C-07） | 月度复盘 | 复盘确认的真实异常 ÷ 全部预警 | alerts + 复盘标记 | 推导，**依赖 P2 复盘标记功能（TK-38）** |

> C-01"每条验收用例记录操作耗时"由**测试侧**满足：E2E 运行器把每条用例耗时写进测试报告，验收人工走查另行计时——不占用生产埋点。

## 二、事件清单（EVT 编号，只增不复用）

| 编号 | event_key | 触发时机 | 载荷（payload） | 说明 |
| --- | --- | --- | --- | --- |
| EVT-01 | `fill_session_start` | 当日首次进入板块填写页或聚焦首个字段（每日每人一次） | `{ first_section }` | 填写耗时的起点 |
| EVT-02 | `section_complete` | 板块点"完成"返回首页 | `{ section, elapsed_since_start }` | 定位最耗时的板块，C-01 优化依据 |
| EVT-03 | `record_submitted` | 提交请求返回成功 | `{ client_ts, from_offline }` | 与 records.submitted_at 交叉核对 |
| EVT-04 | `sync_queued` | 离线状态下点击提交、单据入本地队列 | `{ client_ts, queue_depth }` | F1-07 离线口径 |
| EVT-05 | `sync_result` | 待同步队列每单上传结束 | `{ result: succeeded/failed, latency, queue_depth }` | 同步成功率分子分母 |
| EVT-06 | `draft_abandoned` | 客户端检测到**昨日**存在未提交草稿且当日未再编辑 | `{ duty_date, last_edit_ts }` | 上报仅用于度量；本地草稿保留至该班次有已提交记录 |

**上报机制**：事件本地缓存、批量上报（页面心跳与网络恢复时），失败重试，不阻塞业务操作；离线期间事件的 `client_ts` 保留发生时刻（与 DATA-13 同口径）。

## 三、落库建议：telemetry_events 表（新增，建议）

```sql
CREATE TABLE telemetry_events (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NULL,
  duty_date  DATE NULL COMMENT '归属班次（便于按班统计）',
  event_key  VARCHAR(32) NOT NULL COMMENT 'fill_session_start / section_complete / record_submitted / sync_queued / sync_result / draft_abandoned',
  payload    JSON NULL,
  client_ts  DATETIME NULL COMMENT '客户端发生时刻（离线事件为真实发生时刻）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '服务端收到时刻',
  KEY idx_key_time (event_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='度量埋点（只增不改）';
```

**为什么独立建表而不入 audit_logs**：审计是追责依据（谁改了什么，须严格权限与留存），埋点是度量数据（可聚合、可清理）；混写会污染审计的严肃性，也限制度量的灵活性。两张表职责分离（对齐技术方案 §4"留痕与可追溯是第一约束"的边界）。

## 四、指标产出方式

- 上线后由 TK-30 交付一个只读 SQL 集或后台简页：输入日期区间，直接输出指标表八行的当前值——**不在本期做可视化看板**（C-07：先保证数据对，再谈好看）
- 验证：指标口径表的每条 SQL 在《开发种子数据 v0.1》库上跑通（TK-30 完成判据）

## 五、修订联动（采纳本清单时执行）

1. **技术方案 v0.3**：修订记录追加一行——§4 表清单增 telemetry_events（十三张表），附本表 DDL
2. **台账 v1.4**：新增规格 **DEP-13（埋点采集）**，出处指向本清单与 PRD §4；DEP-11"上线后监测"备注指向本清单口径
3. **任务分解**：TK-30 已预留（完成判据引用本清单），无需改动

---

## 修订记录

1. **v0.1（2026-09-01）**：初稿。定义 8 项指标的可计算口径（3 项纯推导、3 项埋点、2 项 P2 推导）、6 个埋点事件（EVT-01～06）、telemetry_events 表结构建议与上报机制；明确与 audit_logs 的职责分离；列出采纳时的三处上游回写。
