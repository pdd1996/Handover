<script setup lang="ts">
/**
 * 今日交接首页（TK-05）—— PRD §6.0 信息架构的核心入口。
 *
 * 落地规格：
 * - F1-01「24 小时班一天一条记录，首页即今日交接」：页面唯一入口，班次日期取接口 `duty_date`（C-08）
 * - F1-02「12 张任务卡按巡检点位/时段组织，液氧拆 8:30/20:30 两张到点卡」：卡片与顺序**完全由接口给**
 *   （接口又以 spots 表驱动），前端不自行拼装、不排序，避免两端各说一套
 * - F1-03「卡片角标与顶部进度条实时汇总已填/待填/异常」：进度条与各卡角标同源于接口 `progress` / `badge`
 */
import { computed } from 'vue';
import type { TodayDto } from '@handover/shared';
import TaskCard from '../components/TaskCard.vue';

const props = defineProps<{ today: TodayDto }>();
defineEmits<{ (e: 'open', key: string): void }>();

/** 记录状态中文（技术方案 §5.4 状态机：草稿 → 已提交 →（确认）已完成；（异议）有异议） */
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  objection: '有异议',
  completed: '已完成',
};

/**
 * 顶部进度条（F1-03）。百分比由 `progress` 现算——接口只给计数不给百分比，
 * 免得舍入口径成为第三个待确认项；分母为 0（极端情况）时按 0% 处理，不产生 NaN。
 */
const percent = computed(() => {
  const { filled, total } = props.today.progress;
  return total === 0 ? 0 : Math.round((filled / total) * 1000) / 10;
});

const progressText = computed(() => {
  const { filled, total, pending, abnormal } = props.today.progress;
  const base = `已填 ${filled} / ${total} 项`;
  const rest = [`待填 ${pending}`];
  if (abnormal > 0) rest.push(`异常 ${abnormal}`);
  return `${base} · ${rest.join(' · ')}`;
});

/** 记录状态文案；当日无记录时为「尚未开始」（GET 只读不建 draft 行，见 records.service.ts） */
const recordText = computed(() =>
  props.today.record
    ? (STATUS_LABEL[props.today.record.status] ?? props.today.record.status)
    : '尚未开始',
);

/**
 * 同步状态。**TK-05 阶段恒显示「已同步」**：接口的 `pending_sync` 是占位 false
 * （离线待同步队列存于本机 IndexedDB，服务器零感知——F1-07-T2），真值待 TK-08 草稿层 /
 * TK-15 离线三层缓冲落地后由本地队列 OR 合并。此处保留 UI 位以免后续改布局。
 */
const syncText = computed(() => (props.today.pending_sync ? '待同步' : '已同步'));
</script>

<template>
  <div class="min-h-screen bg-slate-100 pb-6">
    <!-- 顶部：标题 + 交班人（PRD §7 实名制 C-05：谁值班谁登录） -->
    <van-nav-bar title="今日交接" data-testid="today-navbar">
      <template #right>
        <span class="text-sm text-slate-600" data-testid="submitter-name">{{
          today.submitter.real_name
        }}</span>
      </template>
    </van-nav-bar>

    <!-- 班次信息 + 进度条（F1-03 顶部进度条） -->
    <div class="bg-blue-600 px-4 pb-4 pt-3 text-white">
      <div class="flex items-baseline justify-between">
        <div>
          <!-- 班次日期 = C-08 班次起始日，非自然日；凌晨填写时它会是"昨天" -->
          <div class="text-2xl font-bold" data-testid="duty-date">{{ today.duty_date }}</div>
          <div class="mt-0.5 text-xs opacity-90">
            班次起始日 · 分界 {{ today.shift_start_time }}
          </div>
        </div>
        <div class="flex flex-col items-end gap-1.5">
          <span class="rounded-full bg-white/20 px-2.5 py-1 text-xs" data-testid="sync-chip">
            ● {{ syncText }}
          </span>
          <span class="rounded-full bg-white/20 px-2.5 py-1 text-xs" data-testid="record-status">
            {{ recordText }}
          </span>
        </div>
      </div>

      <div class="mt-3 h-2 overflow-hidden rounded-full bg-black/20">
        <div
          class="h-full rounded-full bg-amber-300 transition-[width] duration-300"
          :style="{ width: `${percent}%` }"
          data-testid="progress-bar"
        />
      </div>
      <div class="mt-1.5 text-xs opacity-95" data-testid="progress-text">
        {{ progressText }}（{{ percent }}%）
      </div>
    </div>

    <div class="px-3">
      <!-- 巡检动线提示（对齐 demo v0.3 首页提示语：按巡检路线到点位点开卡片） -->
      <div class="my-3 text-sm leading-relaxed text-slate-600">
        按巡检路线到点位点开卡片填写即可，内容自动暂存、随时退出；
        <b>液氧到点各测一次</b>，晚间建议顺路完成电梯核对。
      </div>

      <!-- 12 张任务卡：顺序与构成由接口给（spots 表驱动），前端不重排 -->
      <div class="flex flex-col gap-2.5" data-testid="card-list">
        <TaskCard
          v-for="(card, i) in today.cards"
          :key="card.key"
          :card="card"
          :data-index="i"
          @open="(key) => $emit('open', key)"
        />
      </div>

      <div class="mt-4 text-center text-xs text-slate-400">
        共 {{ today.cards.length }} 张任务卡 · 覆盖十个板块
      </div>
    </div>
  </div>
</template>
