# 技术方案与数据库设计 — Handover · 新院区总务交接班数字化系统（v0.2）

- **关联文档**：《PRD 讨论稿 v0.2.5》（需求依据）、《决策记录》（待建）
- **读者**：总务科（业务核对）、信息科（部署与运维评估）、开发方
- **生成时间**：2026-08-28（v0.2 为同日数据库设计评审修订）
- **状态**：v0.1 已获总务科确认（2026-08-28）；v0.2 为评审修订（见下方修订记录），待总务科复核；剩 1 项外部依赖（信息科对 Node 运行时的运维确认，见 §9）

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

---

## 1. 方案概要

本方案实现 PRD v0.2.5 定义的系统：移动端优先的 H5 交接班系统，部署于医院内网，支持离线填写、用量自动计算、阈值预警、逐项确认与电子签名、全程留痕。

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
- TS 全栈而非 Django/Java：前端、后端、测试统一语言与类型契约，数据字典定义一次三处生效；代价是院内运维对 Node 陌生（见 §9 待确认项）；若信息科坚持 Java，后端平替 Spring Boot，其余不变
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

后端服务内部模块划分（NestJS Module）：认证与账号、排班、交接记录（含状态机）、用量计算、预警规则、电梯字典与核对、配置中心、附件、审计、报表导出。

---

## 4. 数据库设计（MySQL 8.0）

设计原则：**字段结构来自纸质表单，固定列优先**（趋势与计算依赖）；自定义灵活性放在配置层（阈值、基数、电梯、清单）；结构变更走版本升级（Drizzle 迁移脚本），不做运行时自定义字段。所有金额无关，数据体量极小（约一年 365 条记录），性能不是约束，**留痕与可追溯是第一约束**。

### 4.1 表清单

| 表 | 职责 |
| --- | --- |
| users | 账号（师傅/科长），实名一人一号 |
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
  action      VARCHAR(64) NOT NULL COMMENT '如 config.update / schedule.update / elevator.update / spot.update / user.update / record.override / record.guard_confirm / login',
  target_type VARCHAR(32) NULL, target_id VARCHAR(32) NULL,
  old_value   JSON NULL, new_value JSON NULL,
  reason      VARCHAR(200) NULL COMMENT '覆盖/充气/防呆确认等原因',
  ip          VARCHAR(64) NULL, device VARCHAR(200) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_time (created_at), KEY idx_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计日志';
```

### 4.3 关键口径（以 SQL 表达，与 PRD 一致）

每日用水量 = `water_reading − 上一班 water_reading`；每日用电量 = `(e1−上一班e1) + (e2−上一班e2)`；天然气用量 = `(上一班g1−g1) + (上一班g2−g2)`；液氧日间用量 = 在用罐 `c830 − c2030`；液氧夜间用量（跨记录，待总务科确认）= `今日 c830 − 昨日 c2030`。

上一班读数回填是"按 `duty_date` 取前一条已提交记录"的实时查询；各 `*_use` 用量列则在提交时由服务端计算并固化（§5.2），保留交班人当时确认的数值。固化值的配套重算规则：**上一班记录晚到（离线补同步）或经异议修改读数后，自动重算下游记录的用量列并写 audit_logs**（一年约 365 条，重算无成本）。重算仅作用于自动计算字段；被师傅手工覆盖过的用量值（PRD F3，填原因留痕）不被重算覆盖。

天然气充气防呆按**单卡**判定（与 PRD F1 及 Demo 一致）：任一卡剩余量大于上一班即触发"充气确认"；确认后**该卡**当日用量按 0 计、原因留痕（audit_logs.reason），另一卡正常计算，合计为两卡之和。

---

## 5. 核心机制设计

### 5.1 离线同步（排队送达模型）

手机端用浏览器本地存储（IndexedDB）做三层缓冲：**草稿层**（每几秒自动保存当前填写内容）、**待同步队列**（离线时点击提交进入队列，附本机时间戳与完整数据）、**照片暂存区**。网络恢复后按顺序上传，服务器确认即"已同步"，此时才算正式提交、才对接班人可见。

语义与 PRD 完全一致：上传成功即正式提交；同步成功前接班人端零感知；长时间未同步在交班人端持续强提醒；培训口径"看到已同步方可下班"。因单写入人模型，队列顺序即提交顺序，无冲突合并需求。

### 5.2 用量计算与防呆

计算在服务端提交时执行并固化（前端实时预览），规则与重算规则见 §4.3。防呆规则：读数小于上一班 -> 强制确认弹窗并留痕；天然气**任一卡**剩余量增大 -> 充气确认，该卡当日用量按 0 计、另一卡正常计算；首班无上一班数据 -> 显示"—"并提示。防呆确认与用量手工覆盖的原因统一写入 audit_logs 的 reason 列。

### 5.3 预警规则引擎

规则 = 配置表条目（阈值、基数、区间、级别）+ 求值器。触发点两个：交接单提交时逐项求值；定时任务每日复核（为 Phase 2 夜间窗口等跨记录规则预留）。每条预警文案强制包含命中规则与阈值（可解释原则）。**确认项统一落 alerts 表**：Phase 1 的表单级标红项（状态异常、电梯不一致）与交接事项（板块十有内容时，按条拆分为多条确认行——以换行或编号分条，对应 PRD 附录 A 第十板块"逐条确认"）同样生成待确认行，与 Phase 2 规则预警共用"逐条已知晓后方可签名"机制；预警推送科长与各类超时提醒经 notifications 表生成站内通知。

### 5.4 交接状态机

`草稿 → 已提交 →（接班人确认）已完成`；`已提交 →（异议）有异议 →（修改重提，版本+1）已提交`；`已提交 →（10 分钟内撤回）草稿`。重提保留全部历史版本（record_versions）。异议发起时刻记 `objection_at`；24 小时未解决的异议自动升级提醒科长（定时任务扫描，升级后记 `escalated_at` 防重复提醒，通知经 notifications 表落库）。

**撤回窗口（总务科 2026-08-28 拍板）**：提交后 10 分钟内、且接班人尚未确认时，交班人可单方撤回，交接单回到可编辑状态，接班人端待确认入口同步消失；撤回动作写 audit_logs，重新提交版本号+1。服务端校验三个不可撤回条件：超过 10 分钟窗口、接班人已完成确认、交接单处于"有异议"状态。实现要点：撤回是服务端操作（记录已在服务器），需在院内网络下执行；接班人确认的 2 小时计时在撤回后随重提重新起算。不影响表结构。

### 5.5 审计与留痕

NestJS 全局拦截器统一记录：配置中心任何修改（新旧值）、排班/电梯字典/点位字典修改、账号开通与停用、记录数据覆盖（谁、何时、哪些字段）、防呆/充气/覆盖确认（原因记 reason 列）、登录事件（设备、IP）。审计日志只增不改不删，是考核与追责的数据基础。

---

## 6. 安全设计

账号实名一人一号、密码加盐哈希存储、会话超时自动退出；接口按角色鉴权（师傅：填写与确认；科长：全部 + 配置）；SQL 注入由 Drizzle 参数化天然防护；内网启用 HTTPS（院内自签证书即可，手机首次访问时信任）；照片与签名图仅科长与当事人可调阅（权限随记录）。账号共用风险的对治：登录设备记录 + 签名时显示姓名二次确认（见 PRD 风险表）。

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

## 9. 待信息科确认事项（本方案唯一的外部依赖）

1. **Node.js 运行时的运维接受度**：方案基于 TS 全栈；若信息科明确只维护 Java 体系，后端平替 Spring Boot + MyBatis（同样写 SQL），其余（前端、测试、数据库、部署形态）全部不变
2. 服务器资源划拨（§7 配置）与院内 WiFi 覆盖确认（含地下表房等弱信号点位——手机需能连上院内网络才能同步）
3. 数据库实例：使用信息科现有 MySQL 实例还是为本系统新开独立实例（建议独立实例，互不干扰）
4. 院内是否已有统一账号体系需要对接（当前按独立账号体系设计，预留对接位）

---

## 10. 实施阶段（对齐 PRD 发布计划）

**Phase 1（MVP）**：账号与排班、首页卡片填写（含离线）、用量自动计算与防呆、交接确认与签名、电梯字典核对（不一致标红+必填说明）、精简后台（人员/排班/电梯配置/记录管理）。里程碑验收：双轨并行两周逐日比对纸电数据。

**Phase 2**：预警中心与站内推送、历史趋势报表与导出、拍照留证（F7）、完整配置中心、夜间液氧窗口监控（若口径确认）。

**质量活动贯穿两期**：验收标准用例库随功能同步建设，每次提交自动全量回归。

---

## 11. 遗留问题（与 PRD 剩余待办联动）

液氧计量单位现场核实后：阈值、时段降幅与用量单位需联动修正（改配置 + 一处文案，不涉及表结构）；液氧夜间用量口径确认后启用跨记录计算；照片留存时长建议随记录保存 1 年、仅科长可调阅原图（待确认）。交接单撤回窗口已于 2026-08-28 拍板定案，见 §5.4。

另有边界场景两项待定义：其一，**调班**——已关闭（PRD v0.2.4 定案）：交班人恒以登录账号（submitter_id）为准；登录人与当日排班不符时提示确认并写 audit_logs，不建换班审批流；其二，**服务端 draft 行的产生时机**——离线优先模型下草稿存于手机 IndexedDB，records.status 为 draft 仅用于在线编辑暂存，需在详细设计中明确；其三，**液氧换罐**——夜间用量的跨记录差值在换罐日失真（今日在用罐与昨日在用罐不是同一台），口径确认时需一并定义换罐处理。

---

*本文档 v0.1 已获总务科确认，v0.2 为数据库设计评审修订、待复核。与 PRD 一样：只保留最新版，修订史内嵌本节。*
