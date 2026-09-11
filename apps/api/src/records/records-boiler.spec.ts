/**
 * DATA-05 锅炉停机联动用例（TK-10）—— 挂钩台账用例 **DATA-05-T1**。
 *
 * 层级说明（回写口径，比照 records-validation.spec.ts / records-lo.spec.ts 先例）：
 * 《测试用例清单》将 DATA-05-T1 标为**接口层**（判据「停机列留空且提交通过」），但提交
 * 端点 `POST /records/today/submit` 属 **TK-12**。本文件以**契约结构级断言**先行锁死：
 * 停机（boiler_run='stop'）时锅炉号/出水/回水温度不在必填分母——validateFields（TK-12
 * submit 第 1 步将原样复用）对锅炉卡整卡校验放行；运行时三项转必填逐条点名。TK-12 端点
 * 落地时以 supertest 对同组场景复验（400 只在运行缺项时出现），届时用例层级与清单一致。
 * 置灰交互与停机清列的客户端行为见 E2E `tests/e2e/tests/boiler-stop.spec.ts`。
 *
 * 无需真实 MySQL（纯校验引擎断言，同 records-validation.spec.ts）。
 */
import {
  CARD_BY_KEY,
  computeCardBadge,
  isDisabledField,
  isRequiredField,
  validateForError,
  type FieldValueGetter,
  type RecordFieldName,
} from '@handover/shared';

/** 锅炉卡整卡字段（板块五：状态/备注/运行 + 停机三项，cards.ts 卡片→字段映射） */
const BOILER_FIELDS = CARD_BY_KEY.boiler.fields;

/** 停机三项（DATA-05 联动对象；与 shared REQUIRED_WHEN_BOILER_RUN 同清单，此处按台账字面抄录作哨兵） */
const GATED: readonly RecordFieldName[] = ['boiler_no', 'supply_temp', 'return_temp'];

function boilerGet(over: Partial<Record<RecordFieldName, unknown>>): FieldValueGetter {
  return (name) => over[name] ?? null;
}

describe('DATA-05-T1：锅炉停机 → 锅炉号/出水/回水温度置灰不填、不参与必填校验', () => {
  test('停机 + 状态正常 → 整卡校验放行（提交通过；必填仅锅炉状态/运行两项）', () => {
    const get = boilerGet({ boiler_status: 'ok', boiler_run: 'stop' });
    expect(validateForError(BOILER_FIELDS, get)).toBeNull();
    for (const name of GATED) expect(isRequiredField(name, get)).toBe(false);
  });

  test('停机但停机列残留值 → 仍放行（不参与必填校验；合法值不越界即不点名）', () => {
    // 口径分层（TK-10 评审 M1）：「置灰不填、不参与必填」是**校验层**口径——残留合法值不拦提交；
    // 「停机列留空」是**落库层**口径——submit 时 boiler_run='stop' → 三项强制写 NULL（台账
    // DATA-05 原列字面，挂 TK-12 落库与 supertest 复验）。客户端选停机清列为第一道防线，
    // 服务端落库为第二道——撤回重提/异议重提/离线重放时服务端旧值不因本机草稿为空而复活
    const get = boilerGet({ boiler_status: 'ok', boiler_run: 'stop', supply_temp: '65.5' });
    expect(validateForError(BOILER_FIELDS, get)).toBeNull();
  });

  test('锅炉运行 → 三项转必填，缺任一逐条点名（VALIDATION_MISSING_FIELDS）', () => {
    const get = boilerGet({ boiler_status: 'ok', boiler_run: 'run' });
    const body = validateForError(BOILER_FIELDS, get);

    expect(body).not.toBeNull();
    expect(body!.code).toBe('VALIDATION_MISSING_FIELDS');
    const pointed = body!.missing_fields.map((m) => m.field);
    for (const name of GATED) {
      expect(pointed).toContain(name);
      expect(isRequiredField(name, get)).toBe(true);
    }
    // 已填项与备注类（状态正常 → 备注不必填）不在点名清单
    expect(pointed).not.toContain('boiler_status');
    expect(pointed).not.toContain('boiler_run');
    expect(pointed).not.toContain('boiler_note');
  });

  test('运行 + 三项齐全 → 整卡放行（联动双向各态唯一放行条件）', () => {
    const get = boilerGet({
      boiler_status: 'ok',
      boiler_run: 'run',
      boiler_no: '1号',
      supply_temp: '65.5',
      return_temp: '50.0',
    });
    expect(validateForError(BOILER_FIELDS, get)).toBeNull();
  });

  test('置灰判定与必填口径同门：boiler_run ≠ run 一律禁填（含未选），= run 恒可填', () => {
    const unselected = boilerGet({});
    const stopped = boilerGet({ boiler_run: 'stop' });
    const running = boilerGet({ boiler_run: 'run' });
    for (const name of GATED) {
      expect(isDisabledField(name, unselected)).toBe(true);
      expect(isDisabledField(name, stopped)).toBe(true);
      expect(isDisabledField(name, running)).toBe(false);
    }
    // 联动边界：非锅炉三项字段不受 boiler_run 影响（如锅炉状态、制冷卡 cool_run 不联动）
    expect(isDisabledField('boiler_status', stopped)).toBe(false);
    expect(isDisabledField('cool_run', stopped)).toBe(false);
  });

  test('动态分母哨兵（F1-03 同源）：停机应填 2 项、运行 5 项——三项联动进出必填分母', () => {
    // 锅炉卡 6 字段：状态/备注/运行 + 停机三项；备注随状态（正常→不必填）不进分母
    const stopped = computeCardBadge(
      CARD_BY_KEY.boiler,
      boilerGet({ boiler_status: 'ok', boiler_run: 'stop' }),
    );
    expect(stopped.total).toBe(2);
    const running = computeCardBadge(
      CARD_BY_KEY.boiler,
      boilerGet({ boiler_status: 'ok', boiler_run: 'run' }),
    );
    expect(running.total).toBe(5);
  });
});
