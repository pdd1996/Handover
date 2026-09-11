<script setup lang="ts">
/**
 * 首页任务卡（TK-05，F1-02 / F1-03）。
 *
 * 视觉与交互对齐 demo v0.3 的 `.homecard` + `.hc-badge`（台账 F1-02/F1-03 的 Demo 状态 ✅ 载体），
 * 并按 PRD §7 设计约束「适配中年师傅：大字号、大按钮」放大点击区。
 *
 * **卡片组织维度是巡检点位**（PRD §6.0「按巡检点位/时段组织」），故主标题为点位名；
 * 到点卡（液氧 8:30 / 20:30）在左块显示时段、标题加「（早）/（晚）」后缀。
 */
import { computed } from 'vue';
import type { BadgeDto, CardDto } from '@handover/shared';

/**
 * badge / anyFilled（可选，TK-06）：首页传入的**实时角标**（含本地草稿的合并口径，
 * shared computeCardBadge 计算）与「有无任意字段已填」；不传则回退接口给的静态值。
 */
const props = defineProps<{
  card: CardDto;
  badge?: BadgeDto;
  anyFilled?: boolean;
}>();
defineEmits<{ (e: 'open', key: string): void }>();

/** 中文序号（板块号 → 一~十）；到点卡改显时段，故不会用到板块四之外的重复字 */
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'] as const;

/** 到点卡标题后缀（对齐 demo「四 · 液氧读数（早）/（晚）」） */
const SLOT_SUFFIX: Record<string, string> = { am: '（早）', pm: '（晚）' };

/** 左块：到点卡显示时段（提醒师傅"到点去测"），其余显示板块序号 */
const lead = computed(
  () => props.card.slot_label ?? CN_NUM[props.card.section] ?? String(props.card.section),
);

const title = computed(() => {
  const suffix = props.card.slot ? (SLOT_SUFFIX[props.card.slot] ?? '') : '';
  return `${props.card.title}${suffix}`;
});

/**
 * 角标三态（F1-03「卡片角标实时汇总已填/待填/异常」；判据「异常角标变色」）。
 * 优先级：**异常 > 完成 > 待填** —— 异常必须最显眼（PRD §7「预警要准不要多」的同源意图）。
 * 「已填」与「异常」不互斥：状态字段选"异常"时 filled 与 abnormal 同时 +1，此处以异常覆盖显示。
 */
const badge = computed<{ text: string; tone: 'bad' | 'done' | 'todo' }>(() => {
  const b = props.badge ?? props.card.badge;
  if (b.abnormal > 0) return { text: `异常 ${b.abnormal}`, tone: 'bad' };
  if (b.total > 0)
    return b.pending === 0
      ? { text: '已填', tone: 'done' }
      : { text: `待填 ${b.pending}`, tone: 'todo' };
  // total=0：该卡无"应填"项——电梯卡走逐台核对（TK-17）、值班室卡两项均为选填
  const anyFilled = props.anyFilled ?? props.card.fields.some((f) => f.filled);
  if (anyFilled) return { text: '已填', tone: 'done' };
  return { text: props.card.kind === 'elevator' ? '待核对' : '选填', tone: 'todo' };
});

const subtitle = computed(() => {
  const parts: string[] = [props.card.section_label];
  if (props.card.slot_label) parts.push('到点任务');
  if (props.card.kind === 'elevator') parts.push('逐台核对');
  else if ((props.badge ?? props.card.badge).total > 0)
    parts.push(`${(props.badge ?? props.card.badge).total} 项`);
  else parts.push('可留空');
  return parts.join(' · ');
});

/** 角标配色（Tailwind 静态类名，避免动态拼接导致 v4 扫描不到） */
const BADGE_CLASS = {
  bad: 'bg-red-50 text-red-600',
  done: 'bg-green-50 text-green-600',
  todo: 'bg-slate-100 text-slate-500',
} as const;
</script>

<template>
  <button
    type="button"
    class="flex w-full items-center gap-3 rounded-xl bg-white px-4 py-3.5 text-left shadow-sm active:bg-slate-50"
    :data-testid="`task-card-${card.key}`"
    :data-card-key="card.key"
    :data-section="card.section"
    :data-spot="card.spot_name"
    :data-badge-tone="badge.tone"
    @click="$emit('open', card.key)"
  >
    <!-- 左块：到点卡显示时段，其余显示板块序号 -->
    <div
      class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-lg font-bold text-blue-700"
      :class="{ 'bg-amber-50 text-amber-700': card.slot_label }"
      :data-testid="`card-lead-${card.key}`"
    >
      {{ lead }}
    </div>

    <div class="min-w-0 flex-1">
      <div
        class="truncate text-base font-semibold text-slate-800"
        :data-testid="`card-title-${card.key}`"
      >
        {{ title }}
      </div>
      <div class="mt-0.5 truncate text-sm text-slate-500">{{ subtitle }}</div>
    </div>

    <!-- 角标：异常红 / 已填绿 / 待填灰（F1-03「异常角标变色」）。
         data-tone 供 E2E 断言变色（比匹配 Tailwind 类名稳：类名属样式实现细节） -->
    <span
      class="shrink-0 rounded-full px-2.5 py-1 text-sm font-bold"
      :class="BADGE_CLASS[badge.tone]"
      :data-testid="`card-badge-${card.key}`"
      :data-tone="badge.tone"
    >
      {{ badge.text }}
    </span>
  </button>
</template>
