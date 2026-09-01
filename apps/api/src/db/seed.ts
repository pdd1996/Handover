import bcrypt from 'bcryptjs';
import { createDb } from './connection';
import {
  alerts,
  attachments,
  auditLogs,
  configs,
  elevatorChecks,
  elevators,
  notifications,
  recordVersions,
  records,
  schedules,
  spots,
  users,
} from './schema';

/**
 * db:seed —— 按《开发种子数据 v0.1》全量装载开发库（TK-02）。
 * 幂等：重跑先清后插（TRUNCATE 全表，AUTO_INCREMENT 归位）。
 * 占位值规则同文档：❓ 项只影响数值不影响结构与流程，确认后改 configs 即生效。
 * 生产边界：种子数据严禁进入生产（初始化走 DEP-09 上线流程）。
 */

const DEV_PASSWORD = 'Handover@2026';

// ── 日期工具：D0 = 今日，偏移量为天 ────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
const d = (offset: number): string => {
  const t = new Date();
  t.setDate(t.getDate() + offset);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
};
const dt = (offset: number, time: string): string => `${d(offset)} ${time}`;
const recordNo = (offset: number): string => `HB-${d(offset).replaceAll('-', '')}-001`;

async function main(): Promise<void> {
  const { db, pool } = createDb();

  // ── 幂等清理（先关外键检查再逐表 TRUNCATE；固定单连接，会话级变量不串连接）──
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of [
      'audit_logs',
      'attachments',
      'notifications',
      'alerts',
      'elevator_checks',
      'record_versions',
      'records',
      'configs',
      'spots',
      'elevators',
      'schedules',
      'users',
    ]) {
      await conn.query(`TRUNCATE TABLE \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
  } finally {
    conn.release();
  }

  // ── 一、人员（密码仅开发环境统一；生产一人一号由科长发号，C-05）──
  const passwordHash = bcrypt.hashSync(DEV_PASSWORD, 10);
  const userRows = [
    { username: 'zhang', realName: '张师傅', role: 'master' as const },
    { username: 'shi', realName: '施师傅', role: 'master' as const },
    { username: 'wang', realName: '王师傅', role: 'master' as const }, // ❓ 轮值名单待总务科，先按 4 人占位
    { username: 'liu', realName: '李师傅', role: 'master' as const },
    { username: 'chief', realName: '陈科长', role: 'chief' as const },
  ];
  await db
    .insert(users)
    .values(userRows.map((u) => ({ ...u, passwordHash, status: 'active' as const })));
  const userRowsDb = await db.select().from(users);
  const uid = Object.fromEntries(userRowsDb.map((u) => [u.username, u.id])) as Record<
    string,
    number
  >;

  // ── 二、排班：D-14 ～ D+7 共 22 天，zhang→shi→wang→liu 轮转 ──
  const rotation = ['zhang', 'shi', 'wang', 'liu'];
  const dutyOf = (offset: number): number =>
    uid[rotation[(((offset + 14) % 4) + 4) % 4] ?? 'zhang'] as number;
  await db.insert(schedules).values(
    Array.from({ length: 22 }, (_, i) => {
      const offset = i - 14;
      return { dutyDate: d(offset), userId: dutyOf(offset) };
    }),
  );

  // ── 三、巡检点位（11 个；板块八随 PRD 附录 A 落位）─────────
  await db.insert(spots).values([
    { name: '表房', sortNo: 10 },
    { name: '高配房', sortNo: 20 },
    { name: '燃气表房', sortNo: 30 },
    { name: '液氧站', sortNo: 40 },
    { name: '瓶库', sortNo: 50 },
    { name: '锅炉房', sortNo: 60 },
    { name: '制冷机房', sortNo: 70 },
    { name: '泵房', sortNo: 80 },
    { name: '新风机房', sortNo: 90 },
    { name: '电梯厅', sortNo: 100 },
    { name: '值班室', sortNo: 110 },
  ]);

  // ── 四、配置中心（全量 17 键；❓ 占位见文档第四节）─────────
  const configRows: Array<{ key: string; value: string; remark: string }> = [
    {
      key: 'lo_threshold',
      value: '2.0',
      remark: '液氧补液线（数值已确认）；❓ 单位随 DATA-12，暂按 L',
    },
    { key: 'lo_switch', value: '2.5', remark: '换罐线（v0.2.5）' },
    { key: 'lo_drop_12h', value: '0.8', remark: '12 小时窗口降幅防泄漏线；❓ 单位随 DATA-12' },
    {
      key: 'lo_press_range',
      value: '[0.8,1.3]',
      remark: '❓ 初始区间待科长定稿（8 月 30 日实测 0.71–0.81 MPa，F4-04）',
    },
    { key: 'cyl_base_b40', value: '40', remark: '40L 气瓶基数（DATA-06）' },
    { key: 'cyl_base_b10', value: '20', remark: '10L 气瓶基数（DATA-06）' },
    { key: 'cyl_base_b6', value: '20', remark: '6L 气瓶基数（DATA-06）' },
    { key: 'cyl_base_co2', value: '20', remark: 'CO2 气瓶基数（DATA-06）' },
    {
      key: 'cyl_base_pulm',
      value: '1',
      remark: '❓ 肺功能气体基数待确认（表单实测 0 瓶，DATA-06/F4-05）',
    },
    { key: 'lo_unit', value: 'L', remark: '❓ DATA-12 液氧计量单位全局待核实，确认后全局联动' },
    { key: 'hot_water_deviation', value: '3', remark: '生活热水偏离 ±3°C' },
    { key: 'confirm_due_hours', value: '2', remark: '接班人确认超时提醒（可调）' },
    { key: 'objection_escalate_hours', value: '24', remark: '异议升级时限' },
    { key: 'withdraw_window_minutes', value: '10', remark: '撤回窗口' },
    {
      key: 'missing_submit_deadline',
      value: '09:00',
      remark: '应提交未提交扫描时点（次日，可调）',
    },
    {
      key: 'hvac_locs',
      value: JSON.stringify(['手术部', 'ICU', '门诊大厅']),
      remark: '❓ 新风使用位置候选清单待总务科',
    },
    { key: 'boiler_list', value: JSON.stringify(['1号', '2号']), remark: '❓ 锅炉清单待总务科' },
  ];
  await db.insert(configs).values(
    configRows.map((c) => ({
      configKey: c.key,
      configValue: c.value,
      remark: c.remark,
      updatedBy: uid['chief'] as number,
    })),
  );

  // ── 五、电梯字典（按《电梯字典初配置》预填；❓ 时段为占位）──
  // 注：定时段电梯窗口占位取 06:00–21:00，使场景矩阵 D-1「21:30 核对、预期停运」成立；正式时段待总务科
  // windows 直接传数组（drizzle json 列会 JSON.stringify 一次；先 stringify 会双重编码成字符串标量）
  const windows0600: Array<[string, string]> = [['06:00', '21:00']];
  await db.insert(elevators).values([
    { name: '1号电梯', planType: 'scheduled' as const, windows: windows0600 },
    { name: '2号电梯', planType: 'scheduled' as const, windows: windows0600 },
    { name: '扶梯', planType: 'scheduled' as const, windows: windows0600 },
    { name: '5号电梯', planType: 'stopped' as const, stopReason: '停用检修（占位）❓' },
    { name: '8号电梯', planType: 'stopped' as const, stopReason: '停用检修（占位）❓' },
    { name: '人防电梯', planType: 'stopped' as const, stopReason: '停用检修（占位）❓' },
    { name: '发热门诊电梯', planType: 'stopped' as const, stopReason: '停用检修（占位）❓' },
    { name: 'test-24h', planType: 'always' as const }, // ELE-02 三选一的 24 小时分支覆盖
  ]);
  const elevRowsDb = await db.select().from(elevators);
  const eid = Object.fromEntries(elevRowsDb.map((e) => [e.name, e.id])) as Record<string, number>;

  // ── 六、历史记录场景矩阵（D-10 ～ D-1；D0 留空待填）───────
  // 标准日模板：水表 +250/日；电 如意+380、工贸+350/日；气卡各 −30/日；液氧在用罐 8:30→20:30 −0.2
  const normalStatus = {
    hpStatus: 'ok' as const,
    negStatus: 'ok' as const,
    airStatus: 'ok' as const,
    boilerStatus: 'ok' as const,
    boilerRun: 'run' as const,
    boilerNo: '1号',
    supplyTemp: '65.0',
    returnTemp: '50.0',
    coolroomStatus: 'ok' as const,
    coolRun: 'stop' as const,
    h1SetTemp: '55.0',
    h1OutTemp: '52.0',
    h3SetTemp: '55.0',
    h3OutTemp: '51.5',
    p1Press: '0.35',
    p3Press: '0.34',
    p1Level: 'ok' as const,
    p1Height: '1.20',
    p3Level: 'ok' as const,
    p3Height: '1.15',
    hvacStatus: 'ok' as const,
    hvacLocs: ['手术部', 'ICU'],
    loStationPress: '1.00',
    hboPress: '0.90',
    b40: 40,
    b10: 20,
    b6: 20,
    bCo2: 20,
    bPulm: 1,
    manifoldPress: '0.85',
    co2OutPress: '0.60',
  };

  const recIds = new Map<number, number>(); // offset → record id

  for (let k = 0; k <= 9; k++) {
    const offset = k - 10; // D-10 … D-1
    const submitter = dutyOf(offset);
    const receiver = dutyOf(offset + 1);
    const firstDay = k === 0;
    const refillDay = offset === -4; // 充气日
    const objectionDay = offset === -2; // 异议单
    const pendingDay = offset === -1; // 待确认单

    // 水/电/气读数按模板递变
    const water = (10000 + 250 * k).toFixed(1);
    const e1 = (50000 + 380 * k).toFixed(1);
    const e2 = (40000 + 350 * k).toFixed(1);
    // 气卡剩余量：D-4 主卡充气 +50（剩余量增大触发充气确认，F1-13）
    const g1 = refillDay
      ? '400.0'
      : k <= 5
        ? (500 - 30 * k).toFixed(1)
        : (400 - 30 * (k - 6)).toFixed(1);
    const g2 = (480 - 30 * k).toFixed(1);

    // 液氧：D-10～D-4 在用罐=1；D-3（换罐日，对齐文档 §六）起在用罐=2；两罐读数全程有效
    const inUse: 1 | 2 = k <= 6 ? 1 : 2;
    const inUseC830 = (50 - 0.2 * k).toFixed(2);
    const inUseC2030 = (50 - 0.2 * (k + 1)).toFixed(2);
    const p830 = '1.20';
    const p2030 = '1.15';
    // 备用罐读数：1 号罐换罐前已随主罐记录；换罐后按每日 −0.2 延续；2 号罐启用前给基准值
    const backup1 = {
      c830: (48.8 - 0.2 * Math.max(0, k - 6)).toFixed(2),
      c2030: (48.6 - 0.2 * Math.max(0, k - 6)).toFixed(2),
    };
    const backup2 = { c830: '48.00', c2030: '47.80' };
    const tanks =
      inUse === 1
        ? {
            t1C830: inUseC830,
            t1P830: p830,
            t1C2030: inUseC2030,
            t1P2030: p2030,
            ...(k >= 5
              ? { t2C830: backup2.c830, t2P830: p830, t2C2030: backup2.c2030, t2P2030: p2030 }
              : {}),
          }
        : {
            t2C830: inUseC830,
            t2P830: p830,
            t2C2030: inUseC2030,
            t2P2030: p2030,
            t1C830: backup1.c830,
            t1P830: p830,
            t1C2030: backup1.c2030,
            t1P2030: p2030,
          };

    const status = objectionDay
      ? ('objection' as const)
      : pendingDay
        ? ('submitted' as const)
        : ('completed' as const);

    const row: typeof records.$inferInsert = {
      recordNo: recordNo(offset),
      dutyDate: d(offset),
      submitterId: submitter,
      receiverId: receiver,
      status,
      submittedAt: dt(offset, '20:40:00'),
      confirmedAt: status === 'completed' ? dt(offset, '21:00:00') : null,
      objectionNote: objectionDay ? '水表读数疑似抄错' : null,
      objectionAt: objectionDay ? dt(offset, '21:05:00') : null,
      version: objectionDay ? 2 : 1,
      waterReading: water,
      waterUse: firstDay ? null : '250.0',
      e1Reading: e1,
      e2Reading: e2,
      eUse: firstDay ? null : '730.0',
      g1Remaining: g1,
      g2Remaining: g2,
      gasUse: firstDay ? null : refillDay ? '30.0' : '60.0', // 充气日：该卡按 0 计，另一卡正常
      tankInUse: inUse,
      ...tanks,
      loMeasuredAm: dt(offset, '08:30:00'),
      loMeasuredPm: dt(offset, '20:30:00'),
      loDayUse: firstDay ? null : '0.20',
      ...normalStatus,
      signaturePath: status === 'completed' ? `/uploads/signatures/${d(offset)}.png` : null,
    };

    // D-1 待确认单：高压配电状态异常 + 交接事项两条（标红齐全）
    if (pendingDay) {
      row.hpStatus = 'bad';
      row.hpNote = '高压配电室温度偏高（占位演示）';
      row.handoverNote =
        '1. 扶梯异常已联系维保处理，明早复核；\n2. 表房 2 号阀门有轻微渗水，需跟进检查。';
    }

    const inserted = await db.insert(records).values(row).$returningId();
    recIds.set(offset, inserted[0]?.id as number);
  }

  // ── 配套一：D-2 异议单的版本留痕（v1 → v2）──────────────
  const recD2 = recIds.get(-2) as number;
  await db.insert(recordVersions).values([
    {
      recordId: recD2,
      version: 1,
      snapshot: { water_reading: '7999.0', note: '初版：水表读数疑似抄错' },
      changed: { water_reading: { old: '7999.0', new: '7750.0' } },
      editorId: dutyOf(-2),
      reason: '异议退回后更正水表读数',
      editedAt: dt(-2, '21:30:00'),
    },
    {
      recordId: recD2,
      version: 2,
      snapshot: { water_reading: '7750.0', note: '重提版本' },
      changed: null,
      editorId: dutyOf(-2),
      reason: null,
      editedAt: dt(-2, '21:35:00'),
    },
  ]);

  // ── 配套二：D-1 电梯核对（21:30 锁定；扶梯不一致，其余一致）──
  const recD1 = recIds.get(-1) as number;
  const checkBase = { recordId: recD1, checkTime: dt(-1, '21:30:00') };
  await db.insert(elevatorChecks).values([
    { ...checkBase, elevatorId: eid['1号电梯'] as number, expected: 'stop', actual: 'match' },
    { ...checkBase, elevatorId: eid['2号电梯'] as number, expected: 'stop', actual: 'match' },
    {
      ...checkBase,
      elevatorId: eid['扶梯'] as number,
      expected: 'stop',
      actual: 'run', // 与预期不符（F2-02/03、ELE-04/06）
      explanation: '21:30 扶梯仍在运行，已通知维保，明早复核',
    },
    { ...checkBase, elevatorId: eid['5号电梯'] as number, expected: 'stop', actual: 'match' },
    { ...checkBase, elevatorId: eid['8号电梯'] as number, expected: 'stop', actual: 'match' },
    { ...checkBase, elevatorId: eid['人防电梯'] as number, expected: 'stop', actual: 'match' },
    { ...checkBase, elevatorId: eid['发热门诊电梯'] as number, expected: 'stop', actual: 'match' },
    { ...checkBase, elevatorId: eid['test-24h'] as number, expected: 'run', actual: 'match' },
  ]);

  // ── 配套三：D-1 的 alerts（状态异常 / 电梯不一致 / 交接事项×2 拆条）──
  await db.insert(alerts).values([
    {
      recordId: recD1,
      ruleKey: 'hp_status_bad',
      target: 'field:hp_status',
      level: 'high',
      message: '高压配电状态异常：高压配电室温度偏高（占位演示）',
    },
    {
      recordId: recD1,
      ruleKey: 'elevator_mismatch',
      target: `elevator:${eid['扶梯']}`,
      level: 'mid',
      message: '扶梯核对不一致：预期停运，实际运行，已填说明',
    },
    {
      recordId: recD1,
      ruleKey: 'handover_note',
      target: 'field:handover_note',
      level: 'low',
      message: '交接事项 1：扶梯异常已联系维保处理，明早复核',
    },
    {
      recordId: recD1,
      ruleKey: 'handover_note',
      target: 'field:handover_note',
      level: 'low',
      message: '交接事项 2：表房 2 号阀门有轻微渗水，需跟进检查',
    },
  ]);

  // ── 配套四：audit_logs（D-4 充气确认 + D-2 异议链路）──────
  const recD4 = recIds.get(-4) as number;
  await db.insert(auditLogs).values([
    {
      actorId: dutyOf(-4),
      action: 'record.guard_confirm',
      targetType: 'record',
      targetId: String(recD4),
      oldValue: { g1_remaining: '350.0' },
      newValue: { g1_remaining: '400.0' },
      reason: '天然气 1 号卡充气（剩余量增大 +50），该卡当日用量按 0 计（F1-13）',
    },
    {
      actorId: dutyOf(-1),
      action: 'record.objection',
      targetType: 'record',
      targetId: String(recD2),
      oldValue: { status: 'submitted' },
      newValue: { status: 'objection' },
      reason: '水表读数疑似抄错（F2-06）',
    },
    {
      actorId: dutyOf(-2),
      action: 'record.update',
      targetType: 'record',
      targetId: String(recD2),
      oldValue: { version: 1, water_reading: '7999.0' },
      newValue: { version: 2, water_reading: '7750.0' },
      reason: '异议退回后修改重提（F2-07）',
    },
  ]);

  // ── 配套五：notifications 预置一条 confirm_due 演示 ─────
  await db.insert(notifications).values([
    {
      userId: dutyOf(0), // D0 当班人（D-1 记录的接班人）
      kind: 'confirm_due',
      title: '交接记录待确认',
      message: '昨日交接记录已超过 2 小时未确认，请尽快处理（F2-11）',
      recordId: recD1,
    },
  ]);

  // attachments：种子阶段不落照片文件，保持空表（F7 属 Phase 2）
  void attachments;

  // ── 收尾自检：按《开发种子数据》计数 ────────────────────
  const counts = await Promise.all(
    [
      users,
      schedules,
      spots,
      configs,
      elevators,
      records,
      recordVersions,
      elevatorChecks,
      alerts,
      auditLogs,
      notifications,
    ].map(async (t) => (await db.select().from(t)).length),
  );
  const [nUsers, nSch, nSpots, nCfg, nElev, nRec, nVer, nChk, nAlt, nAud, nNtf] = counts;
  console.log(
    `[db:seed] users=${nUsers} schedules=${nSch} spots=${nSpots} configs=${nCfg} elevators=${nElev}` +
      ` records=${nRec} record_versions=${nVer} elevator_checks=${nChk} alerts=${nAlt}` +
      ` audit_logs=${nAud} notifications=${nNtf}`,
  );
  const expected = {
    users: nUsers,
    schedules: nSch,
    spots: nSpots,
    configs: nCfg,
    elevators: nElev,
    records: nRec,
    record_versions: nVer,
    elevator_checks: nChk,
    alerts: nAlt,
    audit_logs: nAud,
    notifications: nNtf,
  } as const;
  const docCounts: Record<keyof typeof expected, number> = {
    users: 5,
    schedules: 22,
    spots: 11,
    configs: 17,
    elevators: 8,
    records: 10,
    record_versions: 2,
    elevator_checks: 8,
    alerts: 4,
    audit_logs: 3,
    notifications: 1,
  };
  const mismatches = (Object.keys(docCounts) as Array<keyof typeof expected>).filter(
    (key) => expected[key] !== docCounts[key],
  );
  if (mismatches.length > 0) {
    console.error(
      `[db:seed] 计数与《开发种子数据》不符：${mismatches
        .map((key) => `${key}=${expected[key]}（应为 ${docCounts[key]}）`)
        .join(', ')}`,
    );
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[db:seed] failed:', err);
  process.exit(1);
});
