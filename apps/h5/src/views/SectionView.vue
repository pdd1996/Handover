<script setup lang="ts">
/**
 * 板块填写页（TK-05 **最小版**）—— 落地 F1-02-T2「点击任一卡片 → 进入该板块填写页 →
 * 只见本板块字段」的判据「板块间无字段串扰」。
 *
 * **本阶段范围边界**（避免与 TK-06 重叠）：
 * - TK-05 只做"字段清单正确归属"这一层：页面**只渲染本卡的字段**，字段元数据（label/unit/输入类型）
 *   取自 shared 的 `FIELD_BY_NAME`，填写状态取自接口 `card.fields`——静态与动态两个来源分工明确。
 * - TK-06 才落地：可编辑表单控件、必填/数值范围校验、**C-09 报错点名 + 点击跳转定位**、
 *   单位全程标注（F1-08）、数字键盘（F1-04）、上一班读数带出（TK-07）。
 * - 故此处字段值以只读方式展示，不做本地编辑：TK-05 的服务端无写入接口（GET 只读），
 *   在线草稿暂存属 TK-08（PUT /records/today/draft），提前做本地编辑会造成"本地态 vs 服务端态"双源。
 */
import { computed } from 'vue';
import { FIELD_BY_NAME, type CardDto, type RecordFieldName } from '@handover/shared';

const props = defineProps<{ card: CardDto }>();
defineEmits<{ (e: 'back'): void }>();

/** 填写方式的中文说明（附录 A「填写方式」列） */
const FILL_LABEL: Record<string, string> = {
  manual: '手工填写',
  auto: '系统自动',
  select: '选择',
  auto_editable: '自动可改',
};

interface FieldRow {
  name: string;
  label: string;
  unit?: string;
  kind: string;
  fill: string;
  fillLabel: string;
  required: boolean;
  filled: boolean;
  abnormal: boolean;
  value: unknown;
}

/** 本卡字段行 = 接口给的动态状态 + shared 字典给的静态元数据 */
const rows = computed<FieldRow[]>(() =>
  props.card.fields.map((f) => {
    const def = FIELD_BY_NAME[f.name as RecordFieldName];
    return {
      name: f.name,
      label: def?.label ?? f.name,
      unit: def?.unit,
      kind: def?.kind ?? '',
      fill: def?.fill ?? '',
      fillLabel: FILL_LABEL[def?.fill ?? ''] ?? def?.fill ?? '',
      required: f.required,
      filled: f.filled,
      abnormal: f.abnormal,
      value: f.value,
    };
  }),
);

/** 值展示：数值 0 是有效读数不可当空；空数组/空串显示占位 */
function displayValue(row: FieldRow): string {
  const v = row.value;
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.join('、');
  return String(v);
}

/** 电梯卡无 records 字段：核对明细走 elevator_checks（契约 §3.3，TK-17） */
const isElevator = computed(() => props.card.kind === 'elevator');

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
        <span class="ml-2 text-xs text-slate-400">sort_no {{ card.sort_no }}</span>
      </div>
      <div class="mt-1">
        覆盖板块：
        <b class="text-slate-800">{{ card.sections.join('、') }}</b>
        <span class="ml-2 text-xs text-slate-400">共 {{ card.fields.length }} 个字段</span>
      </div>
      <div class="mt-1 text-xs" data-testid="section-badge">
        已填 {{ card.badge.filled }} / 应填 {{ card.badge.total }} · 待填 {{ card.badge.pending }} ·
        异常
        {{ card.badge.abnormal }}
      </div>
    </div>

    <!-- 电梯卡：核对明细不在 records 字段字典内 -->
    <div v-if="isElevator" class="mx-3 mt-3">
      <van-empty description="电梯逐台核对见 TK-17（按核对时刻生成预期状态并锁定，ELE-03/05）" />
    </div>

    <!-- 本板块字段清单：F1-02-T2 判据「板块间无字段串扰」即断言此处只出现本卡字段 -->
    <van-cell-group v-else inset class="mt-3" data-testid="section-fields">
      <van-cell
        v-for="row in rows"
        :key="row.name"
        :data-testid="`field-${row.name}`"
        :data-field-name="row.name"
        :data-required="row.required"
        :data-filled="row.filled"
        :data-abnormal="row.abnormal"
      >
        <template #title>
          <div class="flex items-center gap-1.5">
            <span class="text-base text-slate-800">{{ row.label }}</span>
            <!-- 单位全程标注（F1-08 的展示部分；完整校验与数字键盘见 TK-06） -->
            <span v-if="row.unit" class="text-xs text-slate-400">({{ row.unit }})</span>
            <van-tag v-if="row.abnormal" type="danger" size="medium">异常</van-tag>
            <van-tag v-else-if="!row.required" plain type="primary" size="medium">选填</van-tag>
          </div>
          <div class="mt-0.5 text-xs text-slate-400">{{ row.fillLabel }} · {{ row.name }}</div>
        </template>
        <template #value>
          <span
            :class="row.filled ? 'text-slate-800' : 'text-slate-300'"
            :data-testid="`value-${row.name}`"
          >
            {{ displayValue(row) }}
          </span>
        </template>
      </van-cell>
    </van-cell-group>

    <div class="mx-4 mt-4 text-xs leading-relaxed text-slate-400">
      TK-05
      阶段为字段归属核对视图（只读）。可编辑表单、必填与数值范围校验、报错点名与跳转定位（C-09） 由
      TK-06 落地；上一班读数带出见 TK-07；在线草稿暂存见 TK-08。
    </div>

    <div class="mx-3 mt-4">
      <van-button block type="primary" data-testid="back-to-today" @click="$emit('back')">
        返回首页
      </van-button>
    </div>
  </div>
</template>
