<script setup lang="ts">
/**
 * 板块填写页（TK-06）—— F1-08「必填校验、数值范围校验、单位标注」+ C-09「报错必须点名」。
 *
 * 相对 TK-05 最小版（只读字段归属核对视图）的升级：
 * - **可编辑表单**：控件类型由 shared 字段字典驱动（kind × fill）——数值字段数字键盘（F1-04，
 *   van-field type=number）、状态/枚举单选、新风多选、文本备注；auto/auto_editable 派生列只读展示
 *   （提交时服务端计算固化，契约 §4 第 3 步）。
 * - **C-09 报错点名 + 点击跳转定位**：「完成本卡」先跑 shared `validateForError`（与 TK-12 提交
 *   校验同一引擎）→ 有违规则展示逐条点名清单（label + 板块），点击清单项滚动到目标字段——
 *   DOM id 用 shared `fieldAnchor` 同一函数生成（`sec-{板块号}-{字段 kebab}`），锚点两端同源。
 * - **数值暂存**：值写入本地草稿 store（store/draft.ts），返回首页由 TodayView 合并重算角标；
 *   TK-08 起约 2 秒自动保存到 IndexedDB（按用户+班次 keying），关闭页面重开可续填（F1-09）；
 *   离线待同步队列留 TK-15。
 *
 * - **上一班读数带出**（TK-07）：上一班比对值由 App 级拉取并按 duty_date 缓存后经 prop 下发
 *   （TK-07 评审 m1/m2 随 TK-08 收敛：不再每开一卡重复拉取，401 由 App 级 handleSessionLoss
 *   并入 resetSession 单一入口），师傅亲手填/选的读数字段逐项显示上一班比对值（液氧 8:30 卡
 *   取上一班记录的 20:30 字段，映射用 shared `prevSourceField`，DATA-02）；首班显「首班记录」
 *   提示（F1-15）、上一班缺失显缺失提示（F3-07）。
 *
 * - **锅炉停机联动**（TK-10，DATA-05）：boiler_run ≠ 'run' 时锅炉号/出水/回水温度三行置灰
 *   禁填（shared `isDisabledField`，与必填口径共用同一集合；未选按未运行处理的保守口径
 *   见 cards.ts 注释）+「选运行后填」标记；选「停机」即清空三项停机列，已展开的 C-09
 *   报错面板随清列后状态整体重算（清单与实际一致，评审 m3）。
 *
 * 选项来源（TK-11，DATA-07）：`hvac_locs` / `boiler_no` 的候选清单读 GET /configs
 * （表单选项白名单只读端点，后台改 configs 即生效，F4-11 精神）；端点未拉到
 * （离线/加载中/服务不可达）时回落《开发种子数据》占位值渲染并在常量处标注 ❓，
 * 不阻塞填写。多选控件模型绑定用 multiModelOf 的显式数组兜底（TK-06 评审 M1）。
 */
import { computed, ref } from 'vue';
import { showToast } from 'vant';
import {
  ELEVATOR_SECTION_NO,
  FIELD_BY_NAME,
  FIELD_LENGTHS,
  fieldAnchor,
  validateForError,
  isRequiredField,
  isDisabledField,
  REQUIRED_WHEN_BOILER_RUN,
  isFilledValue,
  isMismatchOf,
  normalizeActualOf,
  parseWindowsOf,
  clockMinutesOf,
  expectedStatusAt,
  elevatorExpectedLabel,
  prevSourceField,
  measuredAtTarget,
  localMeasuredAt,
  tankRoleOf,
  toMissingField,
  validateElevatorChecks,
  PREV_BACKFILL_FIELDS,
  waterDayUseOf,
  eDayUseOf,
  gasDayUseOf,
  loDayUseOf,
  type CardDto,
  type ElevatorActual,
  type ElevatorCheckPayload,
  type ElevatorExpectedDto,
  type ElevatorExpectedItemDto,
  type ElevatorPlanType,
  type FieldValueGetter,
  type FormOptionsDto,
  type MissingField,
  type PrevBackfillField,
  type PrevDto,
  type RecordFieldName,
} from '@handover/shared';
import { useDraft } from '../store/draft';

const props = defineProps<{
  card: CardDto;
  prevInfo: PrevDto | null;
  configs: FormOptionsDto | null;
  /** 逐台预期状态（TK-17，App 级拉取；null 时回落草稿快照） */
  elevatorExpected: ElevatorExpectedDto | null;
}>();
const emit = defineEmits<{ (e: 'back'): void }>();

const draft = useDraft();

/** 「草稿已自动保存」指示（F1-09）：本次页面会话内已有至少一次成功落盘，兼作 E2E 同步点 */
const draftSaved = computed(() => draft.lastSavedAt.value > 0);

/** 服务端已知值（GET /records/today 的 fields[].value；提交前恒 null——草稿在客户端本机，D-T18） */
function serverValue(name: RecordFieldName): unknown {
  return props.card.fields.find((f) => f.name === name)?.value ?? null;
}

/** 合并取值：草稿优先，其次服务端值（FieldValueGetter 口径：未填 → null） */
const get: FieldValueGetter = (name) => {
  const d = draft.getValue(name);
  return d !== null ? d : serverValue(name);
};

/** 控件模型值（字符串化供输入框；radio/multi 用原值） */
function modelOf(name: RecordFieldName): unknown {
  const v = get(name);
  return v === null ? '' : v;
}

/** 多选控件模型值：Vant CheckboxGroup 的 modelValue **必须为数组**——未填时取值是 null
 * （FieldValueGetter 口径），draft 占位回落也可能是非数组；用显式 Array.isArray 兜底为 []。
 * 禁用 `as string[] ?? []` 写法（'' 经 as 后 ?? 不生效，运行时 value.push is not a function，
 * 控件整体点不动——TK-06 评审 M1 实证）。 */
function multiModelOf(name: RecordFieldName): string[] {
  const v = get(name);
  return Array.isArray(v) ? (v as string[]) : [];
}

/** 枚举选项（与 schema.ts mysqlEnum 逐项一致；enums.ts 为类型来源） */
const ENUM_OPTIONS: Partial<
  Record<RecordFieldName, Array<{ value: string | number; label: string }>>
> = {
  tank_in_use: [
    { value: 1, label: '1 号罐' },
    { value: 2, label: '2 号罐' },
  ],
  boiler_run: [
    { value: 'run', label: '运行' },
    { value: 'stop', label: '停机' },
  ],
  cool_run: [
    { value: 'run', label: '运行' },
    { value: 'stop', label: '停机' },
  ],
  p1_level: [
    { value: 'ok', label: '正常' },
    { value: 'high', label: '偏高' },
    { value: 'low', label: '偏低' },
  ],
  p3_level: [
    { value: 'ok', label: '正常' },
    { value: 'high', label: '偏高' },
    { value: 'low', label: '偏低' },
  ],
};

// ❓ 候选值均为《开发种子数据》占位（待总务科）：正常数据源为 GET /configs（TK-11），
// 端点未拉到（离线/加载中/服务不可达）时降级用占位值渲染，不阻塞填写
const FALLBACK_HVAC_LOCS = ['手术部', 'ICU', '门诊大厅'];
const FALLBACK_BOILER_LIST = ['1号', '2号'];

/** 多选候选（TK-11）：configs.hvac_locs 优先，未拉到时回落占位 */
const MULTI_OPTIONS = computed<Partial<Record<RecordFieldName, readonly string[]>>>(() => ({
  hvac_locs: props.configs?.hvac_locs ?? FALLBACK_HVAC_LOCS,
}));

/**
 * 枚举候选：静态枚举与 schema mysqlEnum 逐项一致；`boiler_no` 为配置驱动
 * （configs.boiler_list）。label = configs 清单原文（评审 M4 定案：配置驱动清单的
 * 展示文本即清单原文，不硬编码包装规则——对任意后台配置文本都成立；与 TK-11 前
 * 占位 label「1 号锅炉」的差异已在台账增补 #18 留痕）。
 */
function enumOptionsOf(
  name: RecordFieldName,
): ReadonlyArray<{ value: string | number; label: string }> {
  if (name === 'boiler_no') {
    return (props.configs?.boiler_list ?? FALLBACK_BOILER_LIST).map((v) => ({
      value: v,
      label: v,
    }));
  }
  return ENUM_OPTIONS[name] ?? [];
}

// ── 上一班读数带出（TK-07，F1-05 / F1-15 / F3-07 / DATA-02）────────────────────

// 数据源为 App 级按 duty_date 缓存的拉取结果（prop 下发，见 App.vue loadPrev 与头部说明）；
// null = 尚未取到（加载中/失败，不阻塞填写）

/** 上一班比对读数（无上一班记录或未取到时为 null） */
const prevReadings = computed<Readonly<Record<string, unknown>> | null>(
  () => props.prevInfo?.prev?.readings ?? null,
);

/** 首班/缺失提示（F1-15 / F3-07）；null = 有上一班记录或尚未取到 */
const prevBanner = computed<{ tone: 'warn' | 'info'; text: string } | null>(() => {
  const info = props.prevInfo;
  if (!info) return null;
  if (info.first_day) {
    // F1-15-T1 判据文案「首班记录，无上一班数据可比对」
    return { tone: 'warn', text: '首班记录，无上一班数据可比对' };
  }
  if (!info.prev) {
    // F3-07：上一班数据缺失 → 显示“—”并允许补录（TK-14 落地，见下方补录入口）
    return {
      tone: 'info',
      text: '上一班数据缺失，可比对值显示为“—”；可补录上一班读数用于用量计算',
    };
  }
  return null;
});

/**
 * F3-07 缺失态（TK-14）：今日之前有记录但相邻班次缺失（非首班、无 prev，D-T17）——
 * 此时可比对值显“—”、师傅可补录上一班读数（见下方补录入口），服务端仅在缺失态消费
 * 补录值（D-T19），本页用量预览同步回落补录值。
 */
const prevMissing = computed(
  () => !!props.prevInfo && !props.prevInfo.first_day && !props.prevInfo.prev,
);

/** 是否显示上一班比对行：师傅亲手填/选的读数与状态（备注文本与派生列无比对意义） */
function isComparable(name: RecordFieldName): boolean {
  const def = FIELD_BY_NAME[name];
  return (
    (def.fill === 'manual' || def.fill === 'select') &&
    (def.kind === 'number' || def.kind === 'enum' || def.kind === 'status')
  );
}

const STATUS_LABEL: Record<string, string> = { ok: '正常', bad: '异常' };

/** 上一班比对值展示文本；null = 本字段不显示比对行（无比对源或无上一班记录） */
function prevOf(name: RecordFieldName): string | null {
  const readings = prevReadings.value;
  if (!readings || !isComparable(name)) return null;
  // DATA-02：液氧 8:30 卡的源字段是上一班记录的 2030 字段（shared 同一映射，三端同源）
  const v = readings[prevSourceField(name)];
  if (v === null || v === undefined || v === '') return '—';
  const def = FIELD_BY_NAME[name];
  if (def.kind === 'status') return STATUS_LABEL[String(v)] ?? String(v);
  if (def.kind === 'enum') {
    const opt = enumOptionsOf(name).find((o) => o.value === v);
    return opt ? opt.label : String(v);
  }
  return String(v);
}

// ── 用量实时预览（TK-13，技术方案 §5.2「前端实时预览」）──────────────────────────
// 预览非权威：提交时由服务端以同一批 shared calc.ts 纯函数计算固化（契约 §4 第 3 步），
// 上一班取数与服务端 adjacentPrevRow 同口径（相邻班次已提交记录，D-T17）

/** 服务端计算固化的用量字段（shared USAGE_FIELDS 客户端半边；键集变动由 shared 哨兵暴露） */
const SERVER_CALCULATED: ReadonlySet<RecordFieldName> = new Set<RecordFieldName>([
  'water_use',
  'e_use',
  'gas_use',
  'lo_day_use',
]);

/**
 * 上一班读数 getter（用量计算直接取上一班同名字段；液氧日间用量不依赖上一班）：
 * F3-07 缺失态回落师傅补录值（草稿键 `prev_backfill:*`，与 buildPayload 的 prev_readings
 * 组装同一数据源），使预览与提交计算同口径（服务端同样仅在缺失态消费补录，D-T19）。
 */
const prevGet: FieldValueGetter = (name) => {
  const fromRecord = prevReadings.value?.[name];
  if (fromRecord !== null && fromRecord !== undefined) return fromRecord;
  return prevMissing.value ? draft.getValue(`prev_backfill:${name as PrevBackfillField}`) : null;
};

/** 补录入口显示条件（TK-14，F3-07）：缺失态下白名单内（shared `PREV_BACKFILL_FIELDS` 同源）的字段 */
function isBackfillable(name: RecordFieldName): boolean {
  return prevMissing.value && PREV_BACKFILL_FIELDS.includes(name as PrevBackfillField);
}

/** 补录值读写（草稿键 `prev_backfill:{field}`，随草稿持久化即离线可用，D-T18） */
function backfillModelOf(name: RecordFieldName): unknown {
  return draft.getValue(`prev_backfill:${name as PrevBackfillField}`);
}

function writeBackfill(name: RecordFieldName, v: string): void {
  draft.setValue(`prev_backfill:${name as PrevBackfillField}`, v);
}

/** 差值的带符号展示（PRD §6.3 示例口径「如意线 +400」；负差如充气原样显负数） */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/** 用量预览文本；null = 无法计算（上一班缺失/读数未齐），显“—”口径交由只读分支处理 */
function usagePreviewOf(name: RecordFieldName): string | null {
  if (name === 'water_use') {
    const v = waterDayUseOf(get, prevGet);
    return v === null ? null : `${v} 吨`;
  }
  if (name === 'e_use') {
    // F3-02 分线同屏展示（D-P09）：分线差值与合计同显
    const r = eDayUseOf(get, prevGet);
    return r === null
      ? null
      : `如意线 ${signed(r.line1)} · 工贸线 ${signed(r.line2)}，合计 ${r.total} 度`;
  }
  if (name === 'gas_use') {
    const r = gasDayUseOf(get, prevGet);
    return r === null
      ? null
      : `主卡 ${signed(r.line1)} · 副卡 ${signed(r.line2)}，合计 ${r.total} 立方米`;
  }
  if (name === 'lo_day_use') {
    const v = loDayUseOf(get);
    return v === null ? null : `${v} L`;
  }
  return null;
}

/** 派生列的只读说明（为何不可编辑：服务端提交时计算固化，契约 §4 第 3 步） */
const READONLY_HINT: Partial<Record<RecordFieldName, string>> = {
  water_use: '提交时自动计算并固化',
  e_use: '提交时自动计算并固化',
  gas_use: '提交时自动计算并固化',
  lo_night_use: '跨记录派生值：昨日 20:30 → 今日 8:30 差值',
  lo_day_use: '自动计算；如需覆盖须填原因留痕',
  lo_measured_am: '填写读数时自动记录实际测量时刻',
  lo_measured_pm: '填写读数时自动记录实际测量时刻',
};

interface FieldRow {
  name: RecordFieldName;
  label: string;
  unit?: string;
  kind: string;
  fill: string;
  required: boolean;
  disabled: boolean;
  filled: boolean;
  abnormal: boolean;
  anchor: string;
  hint?: string;
  /** 用量实时预览（仅 SERVER_CALCULATED 字段；null/undefined = 暂无法计算不展示） */
  usagePreview?: string;
  /** 师傅是否在本机草稿填了覆盖值（**draft-only**，评审修复轮 M2：不得用合并视图
   * 误判——服务端已有值（提交后重开卡/撤回重提）不等于本次手工覆盖） */
  overridden?: boolean;
}

/** 本卡字段行 = shared 字典静态元数据 + 动态必填/已填/异常判定（与接口同一口径） */
const rows = computed<FieldRow[]>(() =>
  props.card.fields.map((f) => {
    const name = f.name as RecordFieldName;
    const def = FIELD_BY_NAME[name];
    const value = get(name);
    // 两罐读数行标签随使用罐号动态加「（在用）/（备用）」（DATA-03，TK-09；对齐 demo v0.3 验收形态）；
    // 仅展示层后缀——C-09 点名清单的 label 仍取字典原值（shared toMissingField），两边不受影响
    const role = tankRoleOf(name, get);
    const label = def
      ? role === null
        ? def.label
        : `${def.label}（${role === 'in_use' ? '在用' : '备用'}）`
      : f.name;
    return {
      name,
      label,
      unit: def?.unit,
      kind: def?.kind ?? '',
      fill: def?.fill ?? '',
      required: def ? isRequiredField(name, get) : f.required,
      disabled: def ? isDisabledField(name, get) : false,
      filled: isFilledValue(value),
      abnormal: def?.kind === 'status' && value === 'bad',
      // 锚点与 C-09 点名结构同一函数生成（errors.ts fieldAnchor），跳转才能两端对上
      anchor: def ? fieldAnchor(def.section, name).slice(1) : `field-${f.name}`,
      hint: READONLY_HINT[name],
      usagePreview: SERVER_CALCULATED.has(name) ? (usagePreviewOf(name) ?? undefined) : undefined,
      // 覆盖判定只用本机草稿（评审修复轮 M2）：与 App.vue buildPayload 的 usage_overrides
      // 组装同一数据源，服务端已有值不构成「本次覆盖」
      overridden: SERVER_CALCULATED.has(name) ? isFilledValue(draft.getValue(name)) : undefined,
    };
  }),
);

/** 值展示（派生列只读区）：数值 0 是有效读数不可当空；空数组/空串显示占位 */
function displayValue(row: FieldRow): string {
  const v = get(row.name);
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.join('、');
  return String(v);
}

/** 覆盖原因（非字典键，存草稿随持久化；离线可用，D-T18） */
const overrideReasonModel = computed(() => {
  const v = draft.getValue('usage_override_reason');
  return v === null ? '' : String(v);
});

/** 写覆盖原因并顺手熄灭报错高亮（与 writeValue 同口径） */
function writeOverrideReason(v: string): void {
  draft.setValue('usage_override_reason', v);
  errorFields.value.delete('lo_day_use');
}

/** 清覆盖值时连带清原因（评审修复轮 L6：覆盖值与覆盖原因同生同灭，
 *  避免旧原因残留草稿被下次覆盖悄悄复用） */
function clearOrphanOverrideReason(name: RecordFieldName, v: unknown): void {
  if (name === 'lo_day_use' && !isFilledValue(v)) {
    draft.setValue('usage_override_reason', null);
  }
}

/** 写值并顺手清除该字段的报错高亮（C-09：改了就不该继续红着） */
function writeValue(name: RecordFieldName, v: unknown): void {
  draft.setValue(name, v);
  errorFields.value.delete(name);

  // 锅炉停机联动（DATA-05，TK-10）：选「停机」即清空停机三项——判据「停机列留空且提交通过」。
  // 先填后改停机的残留读数若不清，会以草稿值随提交上送，违反「置灰不填」；清键（null）
  // 即从草稿移除，与 FieldValueGetter「未填 → null」口径一致。名单取 shared 同一集合
  // （与 isDisabledField/isRequiredField 同源，不另维护清单）。落库侧另有第二道防线：
  // TK-12 submit 时 boiler_run='stop' → 三项强制写 NULL（服务端旧值不因本机草稿为空而复活）
  if (name === 'boiler_run' && v === 'stop') {
    for (const gated of REQUIRED_WHEN_BOILER_RUN) {
      draft.setValue(gated, null);
      errorFields.value.delete(gated);
    }
    // C-09 清单与实际一致（评审 m3）：已禁填字段清列后必不再被点名——已展开的报错面板
    // 按清列后状态整体重算（与 onComplete 同一校验引擎），不让师傅对着已消失的字段找错；
    // 全部解除时面板收起、高亮同步清除
    if (missingFields.value) {
      const names = props.card.fields.map((f) => f.name as RecordFieldName);
      const body = validateForError(names, get);
      missingFields.value = body ? body.missing_fields : null;
      errorMessage.value = body ? body.message : '';
      if (!body) errorFields.value.clear();
    }
  }

  // 实际测量时刻自动记录（DATA-13/D-P12，TK-09）：写液氧读数时随读数把本机时刻写入草稿——
  // 离线时即为本地时间戳幸存于 IndexedDB（T2 判据客户端半边），提交时随 payload 上送（TK-12），
  // 服务端原样落库不覆盖。仅读数有值时钉时刻；清空读数不回收（保留已发生的真实测量时刻）。每次写入都刷新：
  // 实际测量时刻 = 该时点最后一次落笔的时刻，名义时段仅用于卡片组织（技术方案修订 11）
  const measured = measuredAtTarget(name);
  if (measured && isFilledValue(v)) draft.setValue(measured, localMeasuredAt());
}

// ── C-09 报错点名与跳转定位 ─────────────────────────────────────────────────

/** 最近一次卡内校验的点名清单（契约 §2 missing_fields 结构）；null = 无报错 */
const missingFields = ref<readonly MissingField[] | null>(null);
const errorMessage = ref('');
/** 报错字段集合（行高亮红框）；点击清单项跳转后临时聚焦的字段单独再高亮 */
const errorFields = ref(new Set<string>());
const focusedField = ref<string | null>(null);

/** 「完成本卡」（F1-08-T1 的拦截点）：先本地校验，有违规 → 点名面板，禁止直接返回 */
function onComplete(): void {
  // 电梯卡预检（TK-17，ELE-04-T2/ELE-07-T1）：与 api 提交侧同一 validateElevatorChecks
  //（expected 以草稿锁定值兑底，labelOf 带电梯名）——不一致未填说明逐台以 `elevator:{id}`
  // 点名（C-09 电梯点名形态），点击清单项经锚点跳转定位到对应行
  if (isElevator.value) {
    const checks = draftChecksOf();
    const result = validateElevatorChecks(
      checks,
      (id) => checks.find((c) => c.elevator_id === id)?.expected ?? null,
      (id) => elevatorRows.value.find((r) => r.id === id)?.name ?? null,
    );
    const items = [...result.explanationMissing, ...result.outOfRange];
    if (items.length > 0) {
      missingFields.value = items;
      errorMessage.value = '电梯核对未完成：与预期不一致须逐台填写说明';
      errorFields.value = new Set(items.map((m) => m.field));
      showToast(errorMessage.value);
      return;
    }
    missingFields.value = null;
    errorFields.value.clear();
    showToast('本卡已完成');
    emit('back');
    return;
  }
  const names = props.card.fields.map((f) => f.name as RecordFieldName);
  const body = validateForError(names, get);
  // 用量覆盖原因预检（TK-13，F3-06）：本卡含 lo_day_use 且**本机草稿填了覆盖值**时原因必填——
  // 与服务端 F3-06-T2 同口径的本地拦截，数据源与 buildPayload 的 usage_overrides 组装一致
  // （评审修复轮 M2：draft-only，不得用合并视图——服务端已有值不是本次覆盖，否则撤回重提
  // 与提交后重开卡会被凭空要求填原因）
  if (
    names.includes('lo_day_use') &&
    isFilledValue(draft.getValue('lo_day_use')) &&
    !isFilledValue(draft.getValue('usage_override_reason'))
  ) {
    const item = toMissingField('lo_day_use');
    missingFields.value = [item];
    errorMessage.value = '覆盖自动计算值须填写原因（留痕）';
    errorFields.value = new Set([item.field]);
    showToast(errorMessage.value);
    return;
  }
  if (body) {
    missingFields.value = body.missing_fields;
    errorMessage.value = body.message;
    errorFields.value = new Set(body.missing_fields.map((m) => m.field));
    showToast(body.message);
    return;
  }
  missingFields.value = null;
  errorFields.value.clear();
  showToast('本卡已完成');
  emit('back');
}

/** 点击点名项 → 滚动定位到字段（F1-08-T1「点击跳转可达」） */
function jumpTo(item: MissingField): void {
  const el = document.getElementById(item.anchor.slice(1));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  focusedField.value = item.field;
  window.setTimeout(() => (focusedField.value = null), 1600);
}

// ── 电梯逐台核对（TK-17，ELE-02/03/04/05；D-T22）──────────────────────────────

/** 电梯卡无 records 字段：核对明细走 elevator_checks（契约 §3.3/D-T22） */
const isElevator = computed(() => props.card.kind === 'elevator');

/** 草稿核对项（`elevator_checks` 数组，随草稿持久化即离线可用，D-T18） */
function draftChecksOf(): ElevatorCheckPayload[] {
  const v = draft.getValue('elevator_checks');
  return Array.isArray(v) ? (v as ElevatorCheckPayload[]) : [];
}

/**
 * 展示数据源：实时拉取（props，App 级按打开电梯卡时机刷新）优先，回落草稿快照
 * `elevator_expected`（随草稿持久化即离线可用，D-T18）；两者皆无 → 空列表提示需联网。
 */
const elevatorSnapshot = computed<{
  check_time: string;
  elevators: readonly ElevatorExpectedItemDto[];
} | null>(() => {
  if (props.elevatorExpected) return props.elevatorExpected;
  const v = draft.getValue('elevator_expected') as {
    check_time?: unknown;
    elevators?: unknown;
  } | null;
  if (
    v &&
    typeof v.check_time === 'string' &&
    Array.isArray(v.elevators) &&
    v.elevators.length > 0
  ) {
    return v as { check_time: string; elevators: readonly ElevatorExpectedItemDto[] };
  }
  return null;
});

interface ElevatorRow {
  id: number;
  name: string;
  planText: string;
  /** 展示用预期：已核对行 = 落笔时锁定的值；未核对行 = 快照生成时刻的值 */
  expected: 'run' | 'stop';
  /** 已核对行 = 实际核对（落笔）时刻；未核对行 = 快照生成时刻 */
  checkTime: string;
  /** 本地重算预期的依据（快照自带 plan_type/windows；脏数据/旧快照缺字段时 null） */
  plan: { plan_type: ElevatorPlanType; windows: unknown } | null;
  /** 草稿已锁定的核对项（actual 已选）；null = 未核对 */
  check: ElevatorCheckPayload | null;
  anchor: string;
}

/** 分钟数 → 'HH:mm'（windows 解析后的展示逆向） */
function hhmmOf(minutes: number): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(minutes / 60))}:${p(minutes % 60)}`;
}

/** 运行计划说明（ELE-02 三选一 + 跨零点窗口原样展示，ELE-09） */
function planTextOf(e: ElevatorExpectedItemDto): string {
  if (e.plan_type === 'always') return '24 小时运行';
  if (e.plan_type === 'stopped') {
    return `长期停运${e.stop_reason ? `（${e.stop_reason}）` : ''}`;
  }
  const wins = parseWindowsOf(e.windows);
  if (!wins || wins.length === 0) return '按时段运行（时段未配置，预期按 24 小时处理）';
  return `按时段运行 ${wins.map(([s, t]) => `${hhmmOf(s)}–${hhmmOf(t)}`).join('、')}`;
}

/**
 * 逐台行视图：已核对行的 expected/checkTime 取**草稿锁定值**（ELE-05——核对时刻锁定的预期
 * 不随重开后的新快照翻转）；未核对行随最新快照（新加电梯当日即出现，ELE-08）。
 * `plan` 随快照项带下（plan_type/windows），供落笔瞬间本地重算预期（M2）。
 * 行 DOM id 与 C-09 点名锚点同用 fieldAnchor（errors.ts），跳转两端必然对齐。
 */
const elevatorRows = computed<ElevatorRow[]>(() => {
  const snap = elevatorSnapshot.value;
  if (!snap) return [];
  const checks = draftChecksOf();
  return snap.elevators.map((e) => {
    const locked = checks.find((c) => c.elevator_id === e.id) ?? null;
    const checked = locked != null && typeof locked.actual === 'string' ? locked : null;
    const plan =
      e.plan_type === 'always' || e.plan_type === 'scheduled' || e.plan_type === 'stopped'
        ? { plan_type: e.plan_type, windows: e.windows }
        : null;
    return {
      id: e.id,
      name: e.name,
      planText: planTextOf(e),
      expected: checked?.expected ?? e.expected,
      checkTime: checked?.check_time ?? snap.check_time,
      plan,
      check: checked,
      anchor: fieldAnchor(ELEVATOR_SECTION_NO, `elevator:${e.id}`).slice(1),
    };
  });
});

/**
 * 写核对结果（M2 评审修复轮：**核对时刻 = 点选瞬间的本机时刻，不沿用快照时刻**）。
 *
 * 原实现把 `check_time` 取自行上的快照时刻（`snap.check_time`）——离线或页面挂机后重开时，
 * 那一时刻可能是几小时前，等于**在库里记了一个没发生过的核对时刻**；而服务端又按该时刻
 * 重算 expected（D-T22 ②），于是深夜核对被算成白天的预期，“该停没停”（ELE-06）静默漏报。
 * 现按 DATA-13（测量时刻以本机落笔为准）同口径钉时刻，并配套两条：
 *  ① 预期用**快照自带的运行计划**按新时刻本地重算（shared expectedStatusAt，与服务端同源）——
 *     因此「与预期一致」不是直接写 match，而是**记录观察到的实际状态**再与当时预期比对；
 *     快照到落笔之间时段翻转时自然转为不一致并强制说明，不会跟着旧展示悄悄放行；
 *  ② 无法本地重算预期时（快照缺运行计划的脏数据）**拒记录**——actual='match' 与 expected
 *     无交叉校验，服务端事后无从察觉，强行记录只会制造漏报。
 */
function writeCheck(row: ElevatorRow, chosen: ElevatorActual): void {
  const stamp = localMeasuredAt();
  const minutes = clockMinutesOf(stamp.slice(11, 16));
  const fresh = row.plan && minutes !== null ? expectedStatusAt(row.plan, minutes) : null;
  if (fresh === null) {
    showToast(`${row.name}：无法确认运行计划，请联网重开本卡后再核对`);
    return;
  }
  // 「与预期一致」的语义 = 「我看到的与屏幕所示预期相同」→ 观察到的实际状态即展示预期
  const observed: ElevatorActual = chosen === 'match' ? row.expected : chosen;
  const actualNorm = normalizeActualOf(observed, fresh);
  // 时段在「拉取快照 → 落笔」之间翻转（仅对新核对行判：改选已核对行时师傅看的即锁定值）
  const flipped = !row.check && fresh !== row.expected;
  const checks = draftChecksOf().filter((c) => c.elevator_id !== row.id);
  checks.push({
    elevator_id: row.id,
    check_time: stamp,
    expected: fresh,
    actual: actualNorm,
    explanation: isMismatchOf(actualNorm) ? String(row.check?.explanation ?? '') : null,
  });
  draft.setValue('elevator_checks', checks);
  errorFields.value.delete(`elevator:${row.id}`);
  if (flipped) {
    // C-09 同源不静默：预期翻转必须告知（否则师傅以为刚点的“一致”仍成立）
    showToast(
      `${row.name}：预期已随时段变为“${elevatorExpectedLabel(fresh)}”，已按核对时刻重算；` +
        '若与实际不符请改选并填写说明',
    );
  }
}

function onActualChange(row: ElevatorRow, v: unknown): void {
  if (v === 'match' || v === 'run' || v === 'stop' || v === 'fault') writeCheck(row, v);
}

/** 写不一致说明（仅在已选实际状态后出现；清空即回到未填态，预检会重新点名） */
function writeExplanation(row: ElevatorRow, v: string): void {
  const checks = draftChecksOf();
  const entry = checks.find((c) => c.elevator_id === row.id);
  if (!entry) return;
  entry.explanation = v;
  draft.setValue('elevator_checks', [...checks]);
  errorFields.value.delete(`elevator:${row.id}`);
}

const headerTitle = computed(() =>
  props.card.slot_label ? `${props.card.title} · ${props.card.slot_label}` : props.card.title,
);
</script>

<template>
  <div class="min-h-screen bg-slate-100 pb-6">
    <van-nav-bar
      :title="headerTitle"
      left-arrow
      data-testid="section-navbar"
      @click-left="$emit('back')"
    >
      <template #right>
        <span class="text-sm text-slate-600">{{ card.section_label }}</span>
      </template>
    </van-nav-bar>

    <!-- 卡片归属信息：点位 + 覆盖板块（值班室卡兼管板块八，故可能多板块） -->
    <div class="bg-white px-4 py-3 text-sm text-slate-600">
      <div>
        点位：<b class="text-slate-800">{{ card.spot_name }}</b>
      </div>
      <div class="mt-1">
        覆盖板块：
        <b class="text-slate-800">{{ card.sections.join('、') }}</b>
      </div>
    </div>

    <!-- C-09 报错点名面板（两卡型共用）：逐条列出缺失/越界字段与电梯核对行，点击跳转定位
         （F1-08-T1 断言对象；电梯分支由 onComplete 预检以 elevator:{id} 点名，TK-17） -->
    <div
      v-if="missingFields && missingFields.length > 0"
      class="mx-3 mt-3 rounded-xl bg-red-50 p-3"
      data-testid="section-error-panel"
      :data-error-count="missingFields.length"
    >
      <div class="text-sm font-bold text-red-700" data-testid="error-message">
        {{ errorMessage }}
      </div>
      <div class="mt-0.5 text-xs text-red-500">点击任一项可跳转定位到对应字段</div>
      <button
        v-for="item in missingFields"
        :key="item.field"
        type="button"
        class="mt-2 flex w-full items-center justify-between rounded-lg bg-white px-3 py-2 text-left text-sm text-slate-800 active:bg-slate-50"
        :data-testid="`error-item-${item.field}`"
        @click="jumpTo(item)"
      >
        <span>
          {{ item.label }}
          <span class="ml-1 text-xs text-slate-400">板块{{ item.section }}</span>
        </span>
        <van-icon name="arrow" class="text-slate-400" />
      </button>
    </div>

    <!-- 电梯卡：逐台核对（TK-17，ELE-02/03/04/05；D-T22）——明细落 elevator_checks 逐台一行，
         锚点行 id 与 C-09 点名同用 fieldAnchor（#sec-9-elevator-{id}） -->
    <template v-if="isElevator">
      <div
        v-if="elevatorRows.length === 0"
        class="mx-3 mt-3 rounded-xl bg-white p-4 text-sm text-slate-500"
        data-testid="elevator-unavailable"
      >
        暂未获取到电梯清单：请检查网络后重开本卡。
      </div>
      <template v-else>
        <div
          class="mx-3 mt-3 rounded-xl bg-white px-4 py-2 text-xs text-slate-500"
          data-testid="elevator-checktime"
        >
          预期快照：{{ elevatorRows[0]?.checkTime }} ·
          核对时刻在你点选的瞬间自动记录，预期按该时刻重算
        </div>
        <div class="mx-3 mt-2 divide-y divide-slate-100 overflow-hidden rounded-xl bg-white">
          <div
            v-for="row in elevatorRows"
            :id="row.anchor"
            :key="row.id"
            :data-testid="`elevator-row-${row.id}`"
            :data-elevator-expected="row.expected"
            class="px-4 py-3"
            :class="{
              'field-row-error': errorFields.has(`elevator:${row.id}`),
              'field-row-focus': focusedField === `elevator:${row.id}`,
            }"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-base font-semibold text-slate-800">{{ row.name }}</span>
              <van-tag
                :type="row.expected === 'run' ? 'primary' : 'warning'"
                size="medium"
                :data-testid="`elevator-expected-${row.id}`"
              >
                预期：{{ row.expected === 'run' ? '运行' : '停运' }}
              </van-tag>
            </div>
            <div class="mt-0.5 text-xs text-slate-400">{{ row.planText }}</div>
            <!-- 已核对行显实际核对（落笔）时刻（ELE-03「系统自动记录」、M2） -->
            <div
              v-if="row.check"
              class="mt-0.5 text-xs text-slate-500"
              :data-testid="`elevator-checked-at-${row.id}`"
            >
              核对于 {{ row.checkTime }}
            </div>
            <van-radio-group
              :model-value="row.check?.actual ?? ''"
              direction="horizontal"
              class="mt-2"
              :data-testid="`elevator-actual-${row.id}`"
              @update:model-value="(v: unknown) => onActualChange(row, v)"
            >
              <van-radio name="match">与预期一致</van-radio>
              <van-radio :name="row.expected === 'run' ? 'stop' : 'run'">
                不一致（实际：{{ row.expected === 'run' ? '停运' : '运行' }}）
              </van-radio>
              <van-radio name="fault">故障</van-radio>
            </van-radio-group>
            <van-field
              v-if="row.check && isMismatchOf(row.check.actual)"
              :model-value="String(row.check.explanation ?? '')"
              type="textarea"
              autosize
              rows="1"
              :maxlength="300"
              placeholder="与预期不一致须填写说明（随交接单留痕）"
              class="mt-1 rounded-lg bg-amber-50 px-3"
              :data-testid="`elevator-explanation-${row.id}`"
              @update:model-value="(v: string) => writeExplanation(row, v)"
            />
          </div>
        </div>
        <div class="mx-3 mt-4">
          <van-button block type="primary" data-testid="complete-card" @click="onComplete">
            完成本卡
          </van-button>
        </div>
        <div class="mx-4 mt-3 text-xs leading-relaxed text-slate-400">
          核对结果自动暂存本机，稍候即自动保存；不一致项提交时将生成标红确认行。
          <!-- 「已自动保存」指示（F1-09，与表单卡同口径）：落盘点亮，兼 E2E 同步点 -->
          <span
            v-if="draftSaved"
            data-testid="draft-saved"
            class="block font-bold text-emerald-600"
          >
            草稿已自动保存
          </span>
        </div>
      </template>
    </template>

    <template v-else>
      <!-- 上一班带出提示（TK-07）：首班（F1-15）/缺失（F3-07）两态；有上一班记录时无提示、逐字段显比对值 -->
      <div
        v-if="prevBanner"
        class="mx-3 mt-3 rounded-xl p-3 text-sm"
        :class="
          prevBanner.tone === 'warn' ? 'bg-amber-50 text-amber-700' : 'bg-slate-50 text-slate-600'
        "
        data-testid="prev-banner"
      >
        {{ prevBanner.text }}
      </div>

      <!-- 上一班来源日期（TK-07 评审 m5）：显式标出带出源班次，双轨比对与漏交排查可核对 -->
      <div v-if="prevInfo?.prev" class="mx-3 mt-3 text-xs text-slate-400" data-testid="prev-source">
        上一班（{{ prevInfo.prev.duty_date }}）读数供比对
      </div>

      <!-- 本卡字段表单：行 id = fieldAnchor 锚点，C-09 跳转目标 -->
      <div class="mx-3 mt-3 divide-y divide-slate-100 overflow-hidden rounded-xl bg-white">
        <div
          v-for="row in rows"
          :id="row.anchor"
          :key="row.name"
          :data-testid="`field-${row.name}`"
          :data-field-name="row.name"
          :data-field-kind="row.kind"
          :data-field-unit="row.unit ?? ''"
          :data-field-disabled="row.disabled ? 'true' : 'false'"
          class="field-row px-4 py-3"
          :class="{
            'field-row-error': errorFields.has(row.name),
            'field-row-focus': focusedField === row.name,
          }"
        >
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-base text-slate-800">{{ row.label }}</span>
            <!-- 单位全程标注（F1-08-T3）：data-field-unit 供 E2E 断言 -->
            <span v-if="row.unit" class="text-xs font-bold text-slate-500">({{ row.unit }})</span>
            <van-tag v-if="row.disabled" plain type="warning" size="medium">选运行后填</van-tag>
            <van-tag v-else-if="row.abnormal" type="danger" size="medium">异常</van-tag>
            <van-tag v-else-if="!row.required" plain type="primary" size="medium">选填</van-tag>
          </div>

          <div class="mt-2">
            <!-- 数值：数字键盘（F1-04）；draft 存字符串，校验引擎统一解析；
                 停机置灰（DATA-05）：禁用控件 + vant 灰化样式 -->
            <van-field
              v-if="row.kind === 'number' && row.fill === 'manual'"
              :model-value="String(modelOf(row.name))"
              type="number"
              inputmode="decimal"
              :name="row.name"
              :disabled="row.disabled"
              :placeholder="`请输入读数（${row.unit ?? ''}）`"
              class="rounded-lg bg-slate-50 px-3"
              :data-testid="`input-${row.name}`"
              @update:model-value="(v: string) => writeValue(row.name, v)"
            />

            <!-- 状态（正常/异常）：异常时备注转必填（cards.ts isRequiredField） -->
            <van-radio-group
              v-else-if="row.kind === 'status'"
              :model-value="modelOf(row.name)"
              direction="horizontal"
              :data-testid="`input-${row.name}`"
              @update:model-value="(v: unknown) => writeValue(row.name, v)"
            >
              <van-radio name="ok">正常</van-radio>
              <van-radio name="bad">异常</van-radio>
            </van-radio-group>

            <!-- 枚举单选：静态枚举与 schema mysqlEnum 逐项一致，boiler_no 读 configs（TK-11）；
                 停机置灰（DATA-05）整组禁用 -->
            <van-radio-group
              v-else-if="row.kind === 'enum' && enumOptionsOf(row.name).length > 0"
              :model-value="modelOf(row.name)"
              direction="horizontal"
              :disabled="row.disabled"
              :data-testid="`input-${row.name}`"
              @update:model-value="(v: unknown) => writeValue(row.name, v)"
            >
              <van-radio v-for="opt in enumOptionsOf(row.name)" :key="opt.value" :name="opt.value">
                {{ opt.label }}
              </van-radio>
            </van-radio-group>

            <!-- 多选：新风使用位置，候选读 configs.hvac_locs（TK-11，DATA-07） -->
            <van-checkbox-group
              v-else-if="row.kind === 'multi' && (MULTI_OPTIONS[row.name]?.length ?? 0) > 0"
              :model-value="multiModelOf(row.name)"
              direction="horizontal"
              :data-testid="`input-${row.name}`"
              @update:model-value="(v: unknown) => writeValue(row.name, v)"
            >
              <van-checkbox
                v-for="opt in MULTI_OPTIONS[row.name]"
                :key="opt"
                :name="opt"
                shape="square"
              >
                {{ opt }}
              </van-checkbox>
            </van-checkbox-group>

            <!-- 配置候选为空（TK-11 评审 M1 定案的配置错误态）：显式提示而非静默退化为只读“—”——
                 必填推定口径不变（提交仍被点名拦截，cards.ts 规则 0「消费端不得自行放宽」），
                 科长在后台补配置即恢复；空清单是否允许提交并入台账待确认清单第 9 项复核 -->
            <div
              v-else-if="row.kind === 'enum' || row.kind === 'multi'"
              class="py-1 text-sm text-amber-600"
              :data-testid="`options-empty-${row.name}`"
            >
              候选清单为空，请联系科长在后台配置
            </div>

            <!-- 文本备注：异常说明 / 交接事项 / 节能减排；maxlength 同源绑定 shared
                 FIELD_LENGTHS（评审修复轮 M2：varchar 列超限会被 MySQL 拒绝 → 500） -->
            <van-field
              v-else-if="row.kind === 'text'"
              :model-value="String(modelOf(row.name))"
              type="textarea"
              autosize
              rows="1"
              :maxlength="FIELD_LENGTHS[row.name]"
              :placeholder="row.required ? '异常时必填原因' : '可留空'"
              class="rounded-lg bg-slate-50 px-3"
              :data-testid="`input-${row.name}`"
              @update:model-value="(v: string) => writeValue(row.name, v)"
            />

            <!-- 用量覆盖入口（TK-13，F3-04/F3-06）：auto_editable 的 lo_day_use 可改自动
                 推荐值，改值必填原因（本地预检 + 服务端 F3-06-T2 双道；原因随草稿持久化） -->
            <template v-else-if="row.kind === 'number' && row.fill === 'auto_editable'">
              <van-field
                :model-value="String(modelOf(row.name))"
                type="number"
                inputmode="decimal"
                :name="row.name"
                :placeholder="`留空则按自动计算值固化（${row.unit ?? ''}）`"
                class="rounded-lg bg-slate-50 px-3"
                :data-testid="`input-${row.name}`"
                @update:model-value="
                  (v: string) => {
                    writeValue(row.name, v);
                    clearOrphanOverrideReason(row.name, v);
                  }
                "
              />
              <div
                v-if="!row.overridden && row.usagePreview"
                class="mt-0.5 text-xs text-emerald-700"
                :data-testid="`usage-preview-${row.name}`"
              >
                自动计算（推荐值）：{{ row.usagePreview }}
              </div>
              <van-field
                v-if="row.overridden"
                :model-value="overrideReasonModel"
                type="textarea"
                autosize
                rows="1"
                :maxlength="200"
                placeholder="覆盖原因必填（留痕）"
                class="mt-1 rounded-lg bg-amber-50 px-3"
                data-testid="input-usage_override_reason"
                @update:model-value="writeOverrideReason"
              />
            </template>

            <!-- 派生列只读展示：提交时服务端计算固化，客户端传值不被信任 -->
            <div v-else class="py-1 text-sm" :data-testid="`value-${row.name}`">
              <template v-if="row.hint">
                <span class="text-slate-500">{{ row.hint }}</span>
                <span v-if="row.filled" class="ml-2 text-slate-800">{{ displayValue(row) }}</span>
              </template>
              <span v-else :class="row.filled ? 'text-slate-800' : 'text-slate-300'">
                {{ displayValue(row) }}
              </span>
              <!-- 用量实时预览（TK-13）：非权威，提交时以服务端计算固化为准；
                   水显差值、电/气分线（卡）同屏（F3-02/F3-03），上一班缺失时不展示 -->
              <div
                v-if="row.usagePreview"
                class="mt-0.5 text-xs text-emerald-700"
                :data-testid="`usage-preview-${row.name}`"
              >
                自动计算（预览）：{{ row.usagePreview }}
              </div>
            </div>
          </div>

          <!-- 上一班比对值（TK-07，F1-05/DATA-02）：液氧 8:30 卡取上一班记录的 20:30 字段；
               无值显“—”（F3-07），首班/缺失态由页顶提示接管、逐行不重复展示 -->
          <div
            v-if="prevOf(row.name) !== null"
            class="mt-1.5 text-xs text-slate-500"
            :data-testid="`prev-${row.name}`"
          >
            上一班：{{ prevOf(row.name) }}
          </div>

          <!-- 补录上一班读数（TK-14，F3-07）：缺失态下上一班参与计算的字段可补录；
               提交时组装进 prev_readings 上送，服务端仅缺失态消费并以审计留痕（D-T19） -->
          <div v-if="isBackfillable(row.name)" class="mt-1.5">
            <van-field
              :model-value="String(backfillModelOf(row.name) ?? '')"
              type="number"
              inputmode="decimal"
              :name="`backfill_${row.name}`"
              placeholder="补录上一班读数（用于用量计算）"
              class="rounded-lg bg-slate-50 px-3"
              :data-testid="`backfill-${row.name}`"
              @update:model-value="(v: string) => writeBackfill(row.name, v)"
            />
          </div>
        </div>
      </div>

      <div class="mx-3 mt-4">
        <van-button block type="primary" data-testid="complete-card" @click="onComplete">
          完成本卡
        </van-button>
      </div>

      <div class="mx-4 mt-3 text-xs leading-relaxed text-slate-400">
        填写内容自动暂存本机，稍候即自动保存，关闭页面重开可续填。
        <!-- 「已自动保存」指示（F1-09）：本次页面会话内至少一次成功落盘，兼作 E2E 同步点 -->
        <span v-if="draftSaved" data-testid="draft-saved" class="block font-bold text-emerald-600">
          草稿已自动保存
        </span>
      </div>
    </template>

    <div class="mx-3 mt-4">
      <van-button block plain type="default" data-testid="back-to-today" @click="$emit('back')">
        返回首页
      </van-button>
    </div>
  </div>
</template>

<style scoped>
/* C-09 报错字段红框（E2E 断言 class，而非 Tailwind 动态拼接） */
.field-row-error {
  background-color: #fef2f2;
  box-shadow: inset 0 0 0 2px #ef4444;
}
/* 点击点名项跳转后的临时聚焦高亮 */
.field-row-focus {
  background-color: #fffbeb;
  box-shadow: inset 0 0 0 2px #f59e0b;
}
</style>
