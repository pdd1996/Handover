<script setup lang="ts">
/**
 * 今日交接首页（TK-05）—— PRD §6.0 信息架构的核心入口。
 *
 * 落地规格：
 * - F1-01「24 小时班一天一条记录，首页即今日交接」：页面唯一入口，班次日期取接口 `duty_date`（C-08）
 * - F1-02「12 张任务卡按巡检点位/时段组织，液氧拆 8:30/20:30 两张到点卡」：卡片与顺序**完全由接口给**
 *   （接口又以 spots 表驱动），前端不自行拼装、不排序，避免两端各说一套
 * - F1-03「卡片角标与顶部进度条实时汇总已填/待填/异常」：**TK-06 起改为客户端实时计算**——
 *   用 shared `computeCardBadge`（与 api 同一函数）对「本地草稿 ?? 服务端值」合并取值重算，
 *   填写后返回首页角标/进度条立即反映，无需重新拉接口；字段值无草稿时结果与接口响应一致
 */
import { computed } from 'vue';
import {
  CARD_BY_KEY,
  computeCardBadge,
  isFilledValue,
  tankInUseOf,
  type BadgeDto,
  type CardDto,
  type CardKey,
  type FieldValueGetter,
  type TodayDto,
} from '@handover/shared';
import TaskCard from '../components/TaskCard.vue';
import { useDraft } from '../store/draft';

const props = defineProps<{
  today: TodayDto;
  /** 是否可提交（TK-12 评审修复轮 L1/M6）：提交是师傅端写操作（契约 §3.2 master），
   * 科长巡查不显入口；且撤回重提（draft 态）需重现入口 */
  canSubmit?: boolean;
  /** 本机待同步队列非空（TK-15）：与接口 pending_sync OR 合并出同步状态（F1-06 全程可见） */
  pendingSync?: boolean;
  /** 待同步队列深度（横幅文案） */
  queueCount?: number;
  /** 排空中（排空按钮 loading 与同步角标） */
  syncing?: boolean;
}>();
defineEmits<{
  (e: 'open', key: string): void;
  (e: 'submit'): void;
  (e: 'sync'): void;
}>();

const { getValue: getDraft } = useDraft();

/** 服务端已知值（fields[].value；提交前恒 null——草稿在客户端本机，D-T18；提交后 TK-12 起有真值） */
const serverValues = computed(() => {
  const map = new Map<string, unknown>();
  for (const card of props.today.cards) {
    for (const field of card.fields) map.set(field.name, field.value);
  }
  return map;
});

/** 合并取值：本地草稿优先，其次服务端值（FieldValueGetter 口径：未填 → null） */
const mergedGet: FieldValueGetter = (name) => {
  const d = getDraft(name);
  return d !== null ? d : (serverValues.value.get(name) ?? null);
};

/**
 * 各卡实时角标（F1-03）：shared `computeCardBadge` 与 api 端同一函数同一口径。
 * key 取自 shared 字典（服务端卡片即由它驱动），查不到时回退接口给的静态角标。
 */
const liveBadges = computed(() => {
  const map = new Map<string, BadgeDto>();
  for (const card of props.today.cards) {
    const def = CARD_BY_KEY[card.key as CardKey];
    map.set(card.key, def ? computeCardBadge(def, mergedGet) : card.badge);
  }
  return map;
});

/**
 * 液氧两卡的动态标题后缀（DATA-03，TK-09）：使用罐号选中后两张液氧卡同步显「N号在用」
 * （shared tankInUseOf 同一取数口径）；未选时为 null，标题保持静态。
 */
const tankNote = computed<string | null>(() => {
  const n = tankInUseOf(mergedGet);
  return n === null ? null : `${n}号在用`;
});

/** 仅液氧两卡消费动态后缀（其余卡无此联动，传 null 不渲染） */
function noteOf(card: CardDto): string | null {
  return card.key === 'lo_am' || card.key === 'lo_pm' ? tankNote.value : null;
}

/** 顶部进度条 = 12 张卡实时角标之和（同源汇总，不是两套计数） */
const liveProgress = computed<BadgeDto>(() => {
  return [...liveBadges.value.values()].reduce<BadgeDto>(
    (acc, b) => ({
      filled: acc.filled + b.filled,
      total: acc.total + b.total,
      pending: acc.pending + b.pending,
      abnormal: acc.abnormal + b.abnormal,
    }),
    { filled: 0, total: 0, pending: 0, abnormal: 0 },
  );
});

/** 分母为 0 的卡（电梯/值班室）是否有任意已填内容（含本地草稿），供角标显示「已填」。
 * 电梯卡（TK-17）：核对结果不在 fields 字典（明细落 elevator_checks，D-T22）——按草稿
 * elevator_checks 判定；分母不把核对计入（D-T16 口径为字段维度，改动须先修决策），
 * 角标维持「待核对/已填」两态而非计数 */
function anyFilledOf(card: CardDto): boolean {
  if (card.kind === 'elevator') {
    const checks = getDraft('elevator_checks');
    return (
      Array.isArray(checks) &&
      checks.some((c) => c != null && typeof (c as { actual?: unknown }).actual === 'string')
    );
  }
  return card.fields.some((f) => f.filled || isFilledValue(mergedGet(f.name as never)));
}

/** 记录状态中文（技术方案 §5.4 状态机：草稿 → 已提交 →（确认）已完成；（异议）有异议） */
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  objection: '有异议',
  completed: '已完成',
};

/**
 * 顶部进度条（F1-03）。百分比由实时角标现算——接口只给计数不给百分比，
 * 免得舍入口径成为第三个待确认项；分母为 0（极端情况）时按 0% 处理，不产生 NaN。
 */
const percent = computed(() => {
  const { filled, total } = liveProgress.value;
  return total === 0 ? 0 : Math.round((filled / total) * 1000) / 10;
});

const progressText = computed(() => {
  const { filled, total, pending, abnormal } = liveProgress.value;
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
 * 同步状态（F1-06「同步状态全程可见」，TK-15 落地）：接口 `pending_sync`（占位 false，
 * 服务器对客户端队列零感知——F1-07-T2）OR 本机待同步队列；排空中显「同步中…」。
 * 待同步语义只由队列产生（草稿层不产生，决策记录 D-T18/D-T20）。
 */
const syncText = computed(() => {
  if (props.syncing) return '同步中…';
  return props.today.pending_sync || props.pendingSync ? '待同步' : '已同步';
});
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
      <!-- 待同步队列横幅（TK-15，F1-06/F1-07）：同步状态全程可见 + 手动排空入口 -->
      <div
        v-if="pendingSync"
        class="mt-3 flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5"
        data-testid="sync-banner"
      >
        <div class="pr-2 text-sm text-amber-700">
          有 {{ queueCount ?? 0 }} 张交接单在本机待同步，回到院内网络后自动上传
        </div>
        <van-button
          size="small"
          type="warning"
          :loading="syncing"
          data-testid="sync-now"
          @click="$emit('sync')"
        >
          立即同步
        </van-button>
      </div>

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
          :badge="liveBadges.get(card.key)"
          :any-filled="anyFilledOf(card)"
          :note="noteOf(card)"
          :data-index="i"
          @open="(key) => $emit('open', key)"
        />
      </div>

      <div class="mt-4 text-center text-xs text-slate-400">
        共 {{ today.cards.length }} 张任务卡 · 覆盖十个板块
      </div>

      <!-- 提交入口（TK-12，F1-10/F2-01）：当日无记录或有 draft 记录（撤回重提，评审 M6）时可见；
           已提交/异议/完成时隐藏——一天一条（F1-01），重提仅随撤回（TK-21）路径出现；
           仅 master 可见（评审 L1：科长巡查不再看到点了就 403 的死按钮） -->
      <div v-if="canSubmit && (!today.record || today.record.status === 'draft')" class="mt-5">
        <van-button
          block
          type="danger"
          :disabled="syncing"
          data-testid="submit-open"
          @click="$emit('submit')"
        >
          提交交接单
        </van-button>
        <div class="mt-1.5 text-center text-xs text-slate-400">
          {{
            syncing
              ? '正在同步待同步队列，请稍候…'
              : '提交前先预览未填项与异常项，提交后生成本班次正式交接单'
          }}
        </div>
      </div>
    </div>
  </div>
</template>
