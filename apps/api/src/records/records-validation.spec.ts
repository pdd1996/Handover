/**
 * F1-08 表单校验引擎用例（TK-06）—— 挂钩台账用例 **F1-08-T2 / DATA-01-T1 / C-09**。
 *
 * 层级说明（回写口径，见任务分解 TK-06 修订 #12）：《测试用例清单》将 F1-08-T2、DATA-01-T1
 * 标为**接口层**（场景为「提交 → 拦截并点名」），但提交端点 `POST /records/today/submit`
 * 属 **TK-12**（任务队列在 TK-06 之后）。本文件以**契约结构级断言**先行锁死校验行为：
 * 校验引擎（shared validation.ts，TK-12 submit 第 1 步将原样复用）产出的错误体必须与
 * 《API 契约》§2 逐字段一致（code / message / missing_fields[].field/section/label/anchor）。
 * TK-12 端点落地时以 supertest 对同组场景做端到端复验（400 响应体 == 本文件断言的结构），
 * 届时两条用例的层级即与清单一致。
 */
import {
  CARD_BY_KEY,
  CONTRACT_EXAMPLE_MISSING_FIELD,
  FIELD_PRECISION,
  NUMERIC_FIELDS_MISSING_PRECISION,
  buildValidationError,
  toMissingField,
  validateFields,
  type RecordFieldName,
} from '@handover/shared';

/** 空表单取值：全字段未填 */
const emptyGet = () => null;

describe('F1-08-T2：数值超范围 → 拦截并点名（VALIDATION_OUT_OF_RANGE + 字段定位）', () => {
  test('水表读数为负 → 拦截，错误码与点名结构符合契约 §2', () => {
    const result = validateFields(['water_reading'], () => '-5');
    const body = buildValidationError(result);

    expect(body).not.toBeNull();
    expect(body!.code).toBe('VALIDATION_OUT_OF_RANGE');
    expect(body!.missing_fields).toHaveLength(1);
    expect(body!.missing_fields[0]).toEqual({
      field: 'water_reading',
      section: 1,
      label: '水表读数',
      anchor: '#sec-1-water-reading',
    });
  });

  test('非法数值（非数字文本）同样拦截并点名', () => {
    const body = buildValidationError(validateFields(['e1_reading'], () => 'abc'));
    expect(body!.code).toBe('VALIDATION_OUT_OF_RANGE');
    expect(body!.missing_fields[0]!.field).toBe('e1_reading');
  });

  test('合法读数（含 0）不拦截——0 是有效读数，不可当空值', () => {
    expect(buildValidationError(validateFields(['water_reading'], () => '0'))).toBeNull();
    expect(buildValidationError(validateFields(['water_reading'], () => 49239.0))).toBeNull();
  });

  // 精度哨兵（TK-06 评审 M4，比照 records.spec.ts 分母黄金值哨兵先例挂入 -T 用例）：
  // FIELD_PRECISION 抄录自技术方案 §4.2 DDL（与 schema.ts drizzle 定义逐项一致），
  // TK-12 提交校验将据此派生录入上限；DDL 变更须三处联动（§4.2 / schema.ts / 抄录表），
  // 漏改时以下断言以可读失败强制人工对照规格。
  it('精度哨兵：全部 kind=number 字段均已登记精度（NUMERIC_FIELDS_MISSING_PRECISION 恒为空）', () => {
    expect(NUMERIC_FIELDS_MISSING_PRECISION).toEqual([]);
  });

  it('精度哨兵：黄金值抽查钉死（t1_p830 (5,2) / supply_temp (5,1) / t1_c830 (8,2) / water_reading (12,1) / p1_height (6,2) / b40 INT）', () => {
    expect(FIELD_PRECISION.t1_p830).toEqual([5, 2]);
    expect(FIELD_PRECISION.supply_temp).toEqual([5, 1]);
    expect(FIELD_PRECISION.t1_c830).toEqual([8, 2]);
    expect(FIELD_PRECISION.water_reading).toEqual([12, 1]);
    expect(FIELD_PRECISION.p1_height).toEqual([6, 2]);
    expect(FIELD_PRECISION.b40).toEqual([10, 0]); // INT 整数列按位数惯例记，非 DDL 抄录
  });
});

describe('DATA-01-T1：液氧 8 项读数（两罐两时点含量/压力）缺任一 → 拦截并点名', () => {
  /** 液氧 8 项（DATA-01：含 1 号罐压力——demo 曾漏，v0.2.5 修订 3 补齐） */
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

  test('8 项缺任一（只漏 1 号罐压力）→ 拦截并逐条点名', () => {
    const get = (name: RecordFieldName): unknown =>
      name === 't1_p830' ? null : name.startsWith('t1_') || name.startsWith('t2_') ? '1.0' : null;
    const body = buildValidationError(
      validateFields(CARD_BY_KEY.lo_am.fields.concat(CARD_BY_KEY.lo_pm.fields), get),
    );

    expect(body!.code).toBe('VALIDATION_MISSING_FIELDS');
    // 同卡其余必填项（tank_in_use 等）也在点名清单；液氧 8 项中应恰只缺 t1_p830 一项
    const loPointed = body!.missing_fields
      .map((m) => m.field)
      .filter((f) => (LO_EIGHT as readonly string[]).includes(f));
    expect(loPointed).toEqual(['t1_p830']);
  });

  test('8 项全部缺失 → 点名清单完整覆盖 8 项，anchor 均指向板块四', () => {
    const body = buildValidationError(
      validateFields(CARD_BY_KEY.lo_am.fields.concat(CARD_BY_KEY.lo_pm.fields), emptyGet),
    );
    const pointed = body!.missing_fields.filter((m) =>
      (LO_EIGHT as readonly string[]).includes(m.field),
    );
    expect(pointed).toHaveLength(8);
    for (const item of pointed) {
      expect(item.section).toBe(4);
      expect(item.anchor).toMatch(/^#sec-4-/);
    }
  });

  test('8 项齐全 → 不拦截（两张液氧卡其余必填项补齐后为空违规）', () => {
    const get = (name: RecordFieldName): unknown => (LO_EIGHT.includes(name) ? '1.0' : null);
    const result = validateFields(CARD_BY_KEY.lo_am.fields.concat(CARD_BY_KEY.lo_pm.fields), get);
    // 其余字段（tank_in_use 等）仍缺 → 只点名它们，8 项读数不再出现
    const pointed = result.missing.map((m) => m.field);
    for (const name of LO_EIGHT) expect(pointed).not.toContain(name);
  });
});

describe('C-09：报错点名结构与《API 契约》§2 示例逐字段一致', () => {
  test('缺「高配房是否正常」→ 点名项与契约示例（hp_status/section 2/anchor）完全相等', () => {
    const body = buildValidationError(validateFields(['hp_status'], emptyGet));
    expect(body!.code).toBe('VALIDATION_MISSING_FIELDS');
    expect(body!.missing_fields[0]).toEqual(CONTRACT_EXAMPLE_MISSING_FIELD);
    // 运行期输出与编译期 fixture 同源（toMissingField），此处为运行期证明
    expect(body!.missing_fields[0]).toEqual(toMissingField('hp_status'));
  });

  test('点名清单逐条给出中文 label（禁止只报数量不报字段）', () => {
    const body = buildValidationError(validateFields(['hp_status', 'e1_reading'], emptyGet));
    const labels = body!.missing_fields.map((m) => m.label);
    expect(labels).toContain('高配房是否正常');
    expect(labels).toContain('电表1（如意线）读数');
  });
});
