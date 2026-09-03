import 'reflect-metadata';
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  date,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * Drizzle schema —— 严格对照《技术方案与数据库设计 v0.2》§4.2 的十三张表逐列建齐（TK-02；TK-04 增 sessions）。
 * 口径来源：§4.2 建表语句；列命名与类型（精度/可空/默认值/索引/外键）与 §4.2 DDL 一致。
 */

// 账号（实名一人一号，防共用；登录设备记入 audit_logs）
export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  realName: varchar('real_name', { length: 32 }).notNull(),
  role: mysqlEnum('role', ['master', 'chief']).notNull().default('master'),
  passwordHash: varchar('password_hash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['active', 'disabled']).notNull().default('active'),
  createdAt: datetime('created_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  // 更新时间由迁移手工段的 ON UPDATE CURRENT_TIMESTAMP 维护（与 §4.2 一致），勿加 $onUpdateFn：
  // string 模式下钩子须返回 string，且客户端时区与 CURRENT_TIMESTAMP 来源会混写
});

// 会话存根（D-T13：服务端会话落库；Cookie 与 Bearer 双通道共用同一存根）
export const sessions = mysqlTable(
  'sessions',
  {
    // 存 SHA-256(令牌) 摘要而非明文：拖库也不能冒用在线会话
    tokenHash: char('token_hash', { length: 64 }).primaryKey(),
    userId: int('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 200 }),
    // 凭证下发通道：浏览器 cookie / 小程序等非浏览器客户端 bearer
    channel: mysqlEnum('channel', ['cookie', 'bearer']).notNull().default('cookie'),
    createdAt: datetime('created_at', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 最后活跃时刻（滑动超时判定，每次鉴权通过刷新）
    lastSeenAt: datetime('last_seen_at', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 过期时刻 = last_seen_at + configs.session_timeout_minutes（❓ 默认 720 待科长确认）
    expiresAt: datetime('expires_at', { mode: 'string' }).notNull(),
  },
  (table) => [index('idx_sess_user').on(table.userId), index('idx_sess_exp').on(table.expiresAt)],
);

// 排班（一天一人；接班人自动带出依赖此表）
export const schedules = mysqlTable('schedules', {
  id: int('id').primaryKey().autoincrement(),
  dutyDate: date('duty_date', { mode: 'string' }).notNull().unique(), // string 模式：读回 'YYYY-MM-DD' 字符串
  userId: int('user_id')
    .notNull()
    .references(() => users.id),
  updatedBy: int('updated_by'),
  updatedAt: datetime('updated_at', { mode: 'string' }),
});

// 交接记录主表（一天一条；读数字段固定列，口径与纸质表单一致）
export const records = mysqlTable(
  'records',
  {
    id: int('id').primaryKey().autoincrement(),
    recordNo: varchar('record_no', { length: 20 }).notNull().unique(),
    dutyDate: date('duty_date', { mode: 'string' }).notNull().unique(),
    submitterId: int('submitter_id')
      .notNull()
      .references(() => users.id),
    receiverId: int('receiver_id').references(() => users.id),
    receiverChangeReason: varchar('receiver_change_reason', { length: 200 }),
    status: mysqlEnum('status', ['draft', 'submitted', 'objection', 'completed'])
      .notNull()
      .default('draft'),
    submittedAt: datetime('submitted_at', { mode: 'string' }),
    confirmedAt: datetime('confirmed_at', { mode: 'string' }),
    objectionNote: varchar('objection_note', { length: 500 }),
    objectionAt: datetime('objection_at', { mode: 'string' }),
    escalatedAt: datetime('escalated_at', { mode: 'string' }),
    version: int('version').notNull().default(1),

    // 一、水
    waterReading: decimal('water_reading', { precision: 12, scale: 1 }),
    waterUse: decimal('water_use', { precision: 12, scale: 1 }),
    // 二、电（两线差值之和）
    e1Reading: decimal('e1_reading', { precision: 12, scale: 1 }),
    e2Reading: decimal('e2_reading', { precision: 12, scale: 1 }),
    eUse: decimal('e_use', { precision: 12, scale: 1 }),
    hpStatus: mysqlEnum('hp_status', ['ok', 'bad']),
    hpNote: varchar('hp_note', { length: 200 }),
    // 三、天然气（剩余量递减）
    g1Remaining: decimal('g1_remaining', { precision: 12, scale: 1 }),
    g2Remaining: decimal('g2_remaining', { precision: 12, scale: 1 }),
    gasUse: decimal('gas_use', { precision: 12, scale: 1 }),
    // 四、医用气体（液氧两时点同记录；单位待现场核实）
    tankInUse: tinyint('tank_in_use'),
    t1C830: decimal('t1_c830', { precision: 8, scale: 2 }),
    t1P830: decimal('t1_p830', { precision: 5, scale: 2 }),
    t1C2030: decimal('t1_c2030', { precision: 8, scale: 2 }),
    t1P2030: decimal('t1_p2030', { precision: 5, scale: 2 }),
    t2C830: decimal('t2_c830', { precision: 8, scale: 2 }),
    t2P830: decimal('t2_p830', { precision: 5, scale: 2 }),
    t2C2030: decimal('t2_c2030', { precision: 8, scale: 2 }),
    t2P2030: decimal('t2_p2030', { precision: 5, scale: 2 }),
    loMeasuredAm: datetime('lo_measured_am', { mode: 'string' }),
    loMeasuredPm: datetime('lo_measured_pm', { mode: 'string' }),
    loDayUse: decimal('lo_day_use', { precision: 8, scale: 2 }),
    loStationPress: decimal('lo_station_press', { precision: 5, scale: 2 }),
    hboPress: decimal('hbo_press', { precision: 5, scale: 2 }),
    b40: int('b40'),
    b10: int('b10'),
    b6: int('b6'),
    bCo2: int('b_co2'),
    bPulm: int('b_pulm'),
    manifoldPress: decimal('manifold_press', { precision: 5, scale: 2 }),
    co2OutPress: decimal('co2_out_press', { precision: 5, scale: 2 }),
    negStatus: mysqlEnum('neg_status', ['ok', 'bad']),
    negNote: varchar('neg_note', { length: 200 }),
    airStatus: mysqlEnum('air_status', ['ok', 'bad']),
    airNote: varchar('air_note', { length: 200 }),
    // 五、供暖冷（停机时相关列留空）
    boilerStatus: mysqlEnum('boiler_status', ['ok', 'bad']),
    boilerNote: varchar('boiler_note', { length: 200 }),
    boilerRun: mysqlEnum('boiler_run', ['run', 'stop']),
    boilerNo: varchar('boiler_no', { length: 16 }),
    supplyTemp: decimal('supply_temp', { precision: 5, scale: 1 }),
    returnTemp: decimal('return_temp', { precision: 5, scale: 1 }),
    coolroomStatus: mysqlEnum('coolroom_status', ['ok', 'bad']),
    coolroomNote: varchar('coolroom_note', { length: 200 }),
    coolRun: mysqlEnum('cool_run', ['run', 'stop']),
    // 六、水泵
    h1SetTemp: decimal('h1_set_temp', { precision: 5, scale: 1 }),
    h1OutTemp: decimal('h1_out_temp', { precision: 5, scale: 1 }),
    h3SetTemp: decimal('h3_set_temp', { precision: 5, scale: 1 }),
    h3OutTemp: decimal('h3_out_temp', { precision: 5, scale: 1 }),
    p1Press: decimal('p1_press', { precision: 5, scale: 2 }),
    p3Press: decimal('p3_press', { precision: 5, scale: 2 }),
    p1Level: mysqlEnum('p1_level', ['ok', 'high', 'low']),
    p1Height: decimal('p1_height', { precision: 6, scale: 2 }),
    p3Level: mysqlEnum('p3_level', ['ok', 'high', 'low']),
    p3Height: decimal('p3_height', { precision: 6, scale: 2 }),
    // 七~十
    hvacStatus: mysqlEnum('hvac_status', ['ok', 'bad']),
    hvacNote: varchar('hvac_note', { length: 200 }),
    hvacLocs: json('hvac_locs'),
    energyNote: varchar('energy_note', { length: 500 }),
    handoverNote: varchar('handover_note', { length: 1000 }),
    signaturePath: varchar('signature_path', { length: 200 }),

    createdAt: datetime('created_at', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index('idx_status').on(table.status)],
);

// 修改历史版本（异议退回修改留痕）
export const recordVersions = mysqlTable(
  'record_versions',
  {
    id: int('id').primaryKey().autoincrement(),
    recordId: int('record_id')
      .notNull()
      .references(() => records.id),
    version: int('version').notNull(),
    snapshot: json('snapshot').notNull(),
    changed: json('changed'),
    editorId: int('editor_id').notNull(),
    reason: varchar('reason', { length: 200 }),
    editedAt: datetime('edited_at', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex('uk_rec_ver').on(table.recordId, table.version)],
);

// 电梯字典（后台配置；时段跨零点用 [起,止] 数组表达）
export const elevators = mysqlTable('elevators', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 40 }).notNull(),
  planType: mysqlEnum('plan_type', ['always', 'scheduled', 'stopped']).notNull().default('always'),
  windows: json('windows'),
  stopReason: varchar('stop_reason', { length: 200 }),
  status: mysqlEnum('status', ['active', 'retired']).notNull().default('active'),
  updatedBy: int('updated_by'),
  updatedAt: datetime('updated_at', { mode: 'string' }),
});

// 每条记录的逐台核对（预期状态按核对时刻计算并锁定）
export const elevatorChecks = mysqlTable(
  'elevator_checks',
  {
    id: int('id').primaryKey().autoincrement(),
    recordId: int('record_id')
      .notNull()
      .references(() => records.id),
    elevatorId: int('elevator_id')
      .notNull()
      .references(() => elevators.id),
    checkTime: datetime('check_time', { mode: 'string' }).notNull(),
    expected: mysqlEnum('expected', ['run', 'stop']).notNull(),
    actual: mysqlEnum('actual', ['match', 'run', 'stop', 'fault']),
    explanation: varchar('explanation', { length: 300 }),
  },
  (table) => [uniqueIndex('uk_rec_lift').on(table.recordId, table.elevatorId)],
);

// 巡检点位字典（首页任务卡的点位展示）
export const spots = mysqlTable('spots', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 40 }).notNull(),
  sortNo: int('sort_no').notNull().default(0),
  status: mysqlEnum('status', ['active', 'disabled']).notNull().default('active'),
  updatedBy: int('updated_by'),
  updatedAt: datetime('updated_at', { mode: 'string' }),
});

// 配置中心（阈值/基数/区间/清单；每次修改写 audit_logs）
export const configs = mysqlTable('configs', {
  id: int('id').primaryKey().autoincrement(),
  configKey: varchar('config_key', { length: 64 }).notNull().unique(),
  configValue: text('config_value').notNull(),
  remark: varchar('remark', { length: 200 }),
  updatedBy: int('updated_by').notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// 预警与标红确认项总账
export const alerts = mysqlTable(
  'alerts',
  {
    id: int('id').primaryKey().autoincrement(),
    recordId: int('record_id')
      .notNull()
      .references(() => records.id),
    ruleKey: varchar('rule_key', { length: 64 }).notNull(),
    target: varchar('target', { length: 64 }),
    level: mysqlEnum('level', ['high', 'mid', 'low']).notNull(),
    message: varchar('message', { length: 300 }).notNull(),
    acknowledgedBy: int('acknowledged_by'),
    acknowledgedAt: datetime('acknowledged_at', { mode: 'string' }),
    createdAt: datetime('created_at', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index('idx_rec').on(table.recordId)],
);

// 站内通知
export const notifications = mysqlTable(
  'notifications',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    userId: int('user_id')
      .notNull()
      .references(() => users.id),
    kind: varchar('kind', { length: 32 }).notNull(),
    title: varchar('title', { length: 100 }).notNull(),
    message: varchar('message', { length: 300 }),
    recordId: int('record_id').references(() => records.id),
    alertId: int('alert_id').references(() => alerts.id),
    readAt: datetime('read_at', { mode: 'string' }),
    createdAt: datetime('created_at', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index('idx_user').on(table.userId, table.readAt)],
);

// 照片附件（文件存磁盘，库内记路径）
export const attachments = mysqlTable('attachments', {
  id: int('id').primaryKey().autoincrement(),
  recordId: int('record_id')
    .notNull()
    .references(() => records.id),
  fieldName: varchar('field_name', { length: 64 }).notNull(),
  filePath: varchar('file_path', { length: 200 }).notNull(),
  sizeKb: int('size_kb'),
  takenAt: datetime('taken_at', { mode: 'string' }),
  uploadedBy: int('uploaded_by').notNull(),
  createdAt: datetime('created_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// 审计日志（配置修改、数据覆盖、登录事件全记录）
export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    actorId: int('actor_id'),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }),
    targetId: varchar('target_id', { length: 32 }),
    oldValue: json('old_value'),
    newValue: json('new_value'),
    reason: varchar('reason', { length: 200 }),
    ip: varchar('ip', { length: 64 }),
    device: varchar('device', { length: 200 }),
    createdAt: datetime('created_at', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_time').on(table.createdAt),
    index('idx_target').on(table.targetType, table.targetId),
  ],
);
