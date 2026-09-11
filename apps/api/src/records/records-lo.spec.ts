/**
 * TK-09 液氧板块专项 —— 挂钩台账用例 **DATA-04-T1 / DATA-13-T1 / DATA-13-T2**。
 *
 * 层级说明（回写口径，比照 TK-06 `records-validation.spec.ts` 先例）：
 * - DATA-04-T1《测试用例清单》层级为**单元**——`loDayUseOf` 即取数口径的单一权威实现
 *   （shared calc.ts），本文件以黄金值钉死「在用罐取数、备用罐不参与」；TK-13 计算引擎
 *   在提交端复用同一函数（契约 §4 第 3 步服务端计算固化）。
 * - DATA-13-T1/T2 清单层级为**接口**，但提交端点 `POST /records/today/submit` 属 **TK-12**。
 *   本文件先行锁死**客户端半边口径**：读数 → 测量时刻字段的映射哨兵（shared cards.ts
 *   `MEASURED_AT_TARGET`）与本地时间戳格式（shared calc.ts `localMeasuredAt`）；客户端
 *   联动行为见 E2E `lo-tank.spec.ts`（写值钉时刻、离线时间戳幸存）。**服务端「原样落库、
 *   不以同步/接收时刻覆盖」（T2 判据后半句）挂 TK-12 提交端点落地时以 supertest 复验**，
 *   届时两条用例的层级即与清单一致。
 *
 * 前置决策核对（AGENTS.md 铁律：改需求前先查决策记录）：D-P10（双档阈值）、D-P12（测量
 * 时刻自动记录）、技术方案 §4.3 / 修订 10/11 均已定案，本任务无新决策。
 */
import {
  FIELDS,
  MEASURED_AT_TARGET,
  localMeasuredAt,
  loDayUseOf,
  measuredAtTarget,
  tankInUseOf,
  tankRoleOf,
  type FieldValueGetter,
  type RecordFieldName,
} from '@handover/shared';

/** 液氧 8 项读数（DATA-01；与 records-validation.spec.ts LO_EIGHT 同清单） */
const LO_EIGHT: readonly RecordFieldName[] = [
  't1_c830',
  't1_p830',
  't2_c830',
  't2_p830',
  't1_c2030',
  't1_p2030',
  't2_c2030',
  't2_p2030',
];

describe('DATA-04-T1：液氧日间用量按在用罐取数（备用罐读数不参与）', () => {
  /** 两罐读数齐备、数值刻意错开：1 号差 4.3、2 号差 6.0——混淆即红 */
  const bothTanks: FieldValueGetter = (name) => {
    const values: Partial<Record<RecordFieldName, string>> = {
      t1_c830: '12.5',
      t1_c2030: '8.2',
      t2_c830: '15.9',
      t2_c2030: '9.9',
    };
    return values[name] ?? null;
  };

  test('1 号罐在用、两罐均有读数 → 按 1 号罐取数（4.3），2 号罐读数不影响结果', () => {
    const get: FieldValueGetter = (name) => (name === 'tank_in_use' ? 1 : bothTanks(name));
    expect(loDayUseOf(get)).toBe(4.3);
  });

  test('2 号罐在用 → 按 2 号罐取数（6.0），同一组读数结果随在用罐切换', () => {
    const get: FieldValueGetter = (name) => (name === 'tank_in_use' ? 2 : bothTanks(name));
    expect(loDayUseOf(get)).toBe(6.0);
  });

  test('tank_in_use 未选 → null（不默认罐号）', () => {
    expect(loDayUseOf(bothTanks)).toBeNull();
    expect(tankInUseOf(bothTanks)).toBeNull();
  });

  test('在用罐读数缺失 → null，不回落备用罐（备用罐读数与用量无关）', () => {
    const get: FieldValueGetter = (name) => {
      if (name === 'tank_in_use') return 1;
      if (name === 't1_c2030') return null; // 在用罐 20:30 缺
      return bothTanks(name); // 备用罐两项齐全
    };
    expect(loDayUseOf(get)).toBeNull();
  });

  test('日间补液（20:30 > 8:30）→ 负值原样返回，不夹逼（补液/覆盖走 F3-06 留痕）', () => {
    const get: FieldValueGetter = (name) =>
      name === 'tank_in_use' ? 1 : name === 't1_c830' ? '5.0' : name === 't1_c2030' ? '6.5' : null;
    expect(loDayUseOf(get)).toBe(-1.5);
  });

  test('浮点尾差按 (8,2) 列口径四舍五入（12.5 − 8.2 不得产出 4.299999…）', () => {
    const get: FieldValueGetter = (name) => (name === 'tank_in_use' ? 1 : bothTanks(name));
    const result = loDayUseOf(get)!;
    expect(result).toBeCloseTo(4.3, 10);
    expect(String(result)).not.toContain('2999');
  });

  test('哨兵：tankRoleOf 与 tankInUseOf 同一取数口径（标题联动与用量取数不分叉）', () => {
    const one: FieldValueGetter = (name) => (name === 'tank_in_use' ? 1 : null);
    expect(tankRoleOf('t1_c830', one)).toBe('in_use');
    expect(tankRoleOf('t2_c830', one)).toBe('backup');
    expect(tankRoleOf('water_reading', one)).toBeNull(); // 非两罐读数无角色
    expect(tankRoleOf('t1_c830', bothTanks)).toBeNull(); // 罐号未选无角色
  });
});

describe('DATA-13-T1/T2（先行锁定客户端口径；服务端不覆盖复验挂 TK-12）', () => {
  test('映射哨兵：MEASURED_AT_TARGET 键集合恰为液氧 8 项读数（漏项/多项显式红）', () => {
    const keys = Object.keys(MEASURED_AT_TARGET) as RecordFieldName[];
    expect([...keys].sort()).toEqual([...LO_EIGHT].sort());
  });

  test('映射哨兵：830 后缀 → lo_measured_am、2030 后缀 → lo_measured_pm，与卡片时点切分同源', () => {
    for (const name of LO_EIGHT) {
      expect(measuredAtTarget(name)).toBe(
        name.endsWith('830') ? 'lo_measured_am' : 'lo_measured_pm',
      );
    }
    expect(measuredAtTarget('water_reading')).toBeNull();
    expect(measuredAtTarget('lo_station_press')).toBeNull(); // 液氧站压力不属两时点读数
  });

  test('本地时间戳格式哨兵：YYYY-MM-DD HH:mm:ss（与 MySQL DATETIME 字面量同形）', () => {
    // 本地时区构造，避免 UTC 偏移影响断言（T2：本机时钟即离线唯一权威来源）
    expect(localMeasuredAt(new Date(2026, 8, 11, 8, 20, 5))).toBe('2026-09-11 08:20:05');
    expect(localMeasuredAt(new Date(2026, 0, 2, 23, 5, 0))).toBe('2026-01-02 23:05:00');
    expect(localMeasuredAt()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('字段字典联动哨兵：lo_measured_am/pm 仍为 fill=auto（不进应填分母，D-T16 口径不变）', () => {
    // 时刻由客户端自动钉入，师傅不手工填——若有人把它改成 manual/select 会虚增分母并破坏
    // F1-03-T1「计数与实际一致」，此处钉死防漂移
    for (const f of FIELDS) {
      if (f.name === 'lo_measured_am' || f.name === 'lo_measured_pm') {
        expect(f.fill).toBe('auto');
      }
    }
  });
});
