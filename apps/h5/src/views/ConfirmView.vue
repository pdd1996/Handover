<script setup lang="ts">
/**
 * 交接确认页（TK-18）—— PRD §6.0 信息架构的接班人入口页。
 *
 * 落地规格：
 * - F2-02「接班人登录首页显示醒目"有 N 份交接单待确认"入口」：入口横幅在 TodayView
 *   （本页承接点击后的列表）；列表项与 GET /records/pending 响应一一对应，前端不重排。
 * - F2-04「预警/标红项与交接事项须逐条点击"已知晓"后方可签名」（TK-19）：逐条已知晓
 *   按钮随标红项卡片渲染，已知晓项回显时刻（acknowledged_at 服务端回读）；
 * - F2-05「确认完成归档：双方姓名、确认时间、签名图可查」（TK-19）：全部知晓后开放
 *   签名板（canvas 手写，pointer 事件兼容鼠标/触屏），签名前 C-05 姓名二次确认，
 *   确认后交 App 上送 POST /records/{id}/confirm。
 */
import { computed, ref, type ComponentPublicInstance } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import {
  FIELD_BY_NAME,
  FIELD_NAMES,
  SECTION_BY_NO,
  type PendingRecordDto,
  type RecordDetailDto,
  type SectionNo,
} from '@handover/shared';

const props = defineProps<{
  /** GET /records/pending 列表（App 级拉取） */
  items: PendingRecordDto[];
  /** 当前打开的交接单详情；null = 列表态 */
  detail: RecordDetailDto | null;
  /** 详情加载中（点击列表项后） */
  loading: boolean;
  /** 当前登录人姓名（C-05：签名时显示姓名二次确认） */
  userName: string;
}>();

const emit = defineEmits<{
  /** 返回：详情态回列表，列表态回首页（由 App 决定） */
  (e: 'back'): void;
  (e: 'open', id: number): void;
  /** 逐条"已知晓"（F2-04）：单条上送，App 调接口后刷新详情回读 acknowledged_at */
  (e: 'acknowledge', alertId: number): void;
  /** 签名归档（F2-05）：C-05 二次确认在本组件完成后，交 App 上送签名图 */
  (e: 'sign', signature: string): void;
}>();

/** 详情态的板块分组（逐项浏览：板块 1–10 顺序渲染，按字段字典 section 归组） */
const sectionGroups = computed(() => {
  const detail = props.detail;
  if (!detail) return [];
  return [...new Set(FIELD_NAMES.map((n) => FIELD_BY_NAME[n].section))]
    .filter((no) => no >= 1)
    .sort((a, b) => a - b)
    .map((no) => ({
      no: no as SectionNo,
      label: SECTION_BY_NO[no as SectionNo].label,
      fields: FIELD_NAMES.filter((n) => FIELD_BY_NAME[n].section === no).map((n) => ({
        name: n,
        def: FIELD_BY_NAME[n],
        value: detail.readings[n] ?? null,
      })),
    }));
});

/** 值展示格式：数组（多选）顿号连接；空值显 "—" */
function textOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '—';
  return String(value);
}

/** 标红项色阶（level → tailwind class；置顶区内仍按 level 区分轻重） */
function toneOf(level: string): string {
  if (level === 'high') return 'bg-red-50 border-red-300 text-red-700';
  if (level === 'mid') return 'bg-amber-50 border-amber-300 text-amber-700';
  return 'bg-slate-50 border-slate-300 text-slate-600';
}

const LEVEL_LABEL: Record<string, string> = { high: '高', mid: '中', low: '提示' };

/** 电梯核对实际状态文案 */
function actualText(actual: string | null): string {
  if (actual === null) return '—';
  return { match: '与预期一致', run: '运行', stop: '停运', fault: '故障' }[actual] ?? actual;
}

// ── 逐条知晓与签名归档（TK-19，F2-04/F2-05）────────────────────────────────────

/** 未逐条知晓的标红项数（F2-04：全部知晓后方可签名；接口侧同口径终校 409 兜底） */
const unackedCount = computed(() =>
  props.detail ? props.detail.alerts.filter((a) => a.acknowledged_at === null).length : 0,
);

// 签名板（F2-05）：canvas 手写，pointer 事件兼容鼠标/触屏（touch-none 防滚动劫持笔迹）
const sigCanvas = ref<HTMLCanvasElement | null>(null);
const sigDirty = ref(false);
let sigCtx: CanvasRenderingContext2D | null = null;
let drawing = false;

/** canvas 挂载即初始化（v-if 条件渲染，函数式 ref 时机可靠）：按 dpr 放大抗锯齿、白底 */
function setSigCanvas(el: Element | ComponentPublicInstance | null): void {
  const canvas = el instanceof HTMLCanvasElement ? el : null;
  sigCanvas.value = canvas;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  sigCtx = canvas.getContext('2d');
  if (!sigCtx) return;
  sigCtx.scale(dpr, dpr);
  sigCtx.fillStyle = '#ffffff';
  sigCtx.fillRect(0, 0, rect.width, rect.height);
  sigCtx.strokeStyle = '#1e293b';
  sigCtx.lineWidth = 2.5;
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';
}

function sigPos(e: PointerEvent): { x: number; y: number } {
  const rect = sigCanvas.value!.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function sigStart(e: PointerEvent): void {
  if (!sigCtx) return;
  drawing = true;
  sigDirty.value = true;
  const { x, y } = sigPos(e);
  sigCtx.beginPath();
  sigCtx.moveTo(x, y);
  sigCtx.lineTo(x + 0.01, y + 0.01);
  sigCtx.stroke();
}

function sigMove(e: PointerEvent): void {
  if (!drawing || !sigCtx) return;
  const { x, y } = sigPos(e);
  sigCtx.lineTo(x, y);
  sigCtx.stroke();
}

function sigEnd(): void {
  drawing = false;
}

/** 清除重签：重跑初始化即白底，笔迹状态归零 */
function sigClear(): void {
  setSigCanvas(sigCanvas.value);
  sigDirty.value = false;
}

/** 签名并归档（F2-05）：C-05 姓名二次确认 → 导出 PNG data URL 交 App 上送 */
async function signAndConfirm(): Promise<void> {
  if (!sigDirty.value) {
    showToast('请先在签名区手写签名');
    return;
  }
  const el = sigCanvas.value;
  if (!el) return;
  try {
    await showConfirmDialog({
      title: '确认签名',
      message: `签名确认人：${props.userName || '当前用户'}\n签名归档后交接单锁定为已完成`,
      confirmButtonText: '确认签名',
    });
  } catch {
    return; // 用户取消
  }
  emit('sign', el.toDataURL('image/png'));
}
</script>

<template>
  <div class="min-h-screen bg-slate-100 pb-8">
    <!-- 详情态：交接单逐项浏览 -->
    <template v-if="detail">
      <van-nav-bar
        :title="detail.record_no"
        left-arrow
        data-testid="detail-navbar"
        @click-left="emit('back')"
      />

      <!-- 标红项置顶区（F2-03 置顶高亮）：服务端已按 level 排好序，逐条渲染 -->
      <div class="px-3 pt-3" data-testid="alert-top">
        <div class="mb-1.5 text-sm font-bold text-red-600">
          标红项 {{ detail.alerts.length }} 项（已置顶）
        </div>
        <div
          v-for="alert in detail.alerts"
          :key="alert.id"
          class="mb-2 rounded-xl border px-3 py-2.5"
          :class="toneOf(alert.level)"
          :data-testid="`alert-item-${alert.id}`"
          :data-level="alert.level"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold">【{{ LEVEL_LABEL[alert.level] ?? alert.level }}】</span>
            <span class="text-xs opacity-60">{{ alert.rule_key }}</span>
          </div>
          <div class="mt-1 text-sm leading-relaxed">{{ alert.message }}</div>
          <!-- 逐条"已知晓"（F2-04，TK-19）：已知晓项回显服务端时刻，不可重复点击 -->
          <div class="mt-1.5 flex items-center justify-between">
            <span
              v-if="alert.acknowledged_at"
              class="text-xs font-bold text-emerald-700"
              :data-testid="`alert-acked-${alert.id}`"
            >
              已知晓 {{ alert.acknowledged_at }}
            </span>
            <button
              v-else
              type="button"
              class="rounded-full border border-current bg-white/70 px-3 py-1 text-xs font-bold"
              :data-testid="`alert-ack-${alert.id}`"
              @click="emit('acknowledge', alert.id)"
            >
              已知晓
            </button>
          </div>
        </div>
        <div
          v-if="detail.alerts.length === 0"
          class="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700"
        >
          本单无标红项
        </div>
      </div>

      <!-- 基础信息（记录级字段，板块 0 自动带出） -->
      <div class="px-3 pt-3">
        <div class="rounded-xl bg-white px-3 py-2.5 text-sm" data-testid="detail-meta">
          <div class="flex justify-between py-0.5">
            <span class="text-slate-400">班次日期</span>
            <span>{{ detail.duty_date }}</span>
          </div>
          <div class="flex justify-between py-0.5">
            <span class="text-slate-400">交班人</span>
            <span data-testid="detail-submitter">{{ detail.submitter.real_name }}</span>
          </div>
          <div class="flex justify-between py-0.5">
            <span class="text-slate-400">接班人</span>
            <span>{{ detail.receiver?.real_name ?? '—' }}</span>
          </div>
          <div class="flex justify-between py-0.5">
            <span class="text-slate-400">交接时间</span>
            <span>{{ detail.submitted_at ?? '—' }}</span>
          </div>
          <div class="flex justify-between py-0.5">
            <span class="text-slate-400">版本</span>
            <span>v{{ detail.version }}</span>
          </div>
        </div>
      </div>

      <!-- 电梯核对逐台明细（板块九，elevator_checks 落库序） -->
      <div v-if="detail.elevator_checks.length > 0" class="px-3 pt-3" data-testid="elevator-checks">
        <div class="mb-1.5 text-sm font-bold text-slate-700">电梯核对</div>
        <div
          v-for="check in detail.elevator_checks"
          :key="check.elevator_id"
          class="mb-1.5 rounded-xl bg-white px-3 py-2 text-sm"
          :data-testid="`elevator-check-${check.elevator_id}`"
        >
          <div class="flex justify-between">
            <span class="font-bold text-slate-800">{{
              check.elevator_name ?? `电梯#${check.elevator_id}`
            }}</span>
            <span :class="check.actual === 'match' ? 'text-emerald-600' : 'text-amber-600'">
              {{ actualText(check.actual) }}
            </span>
          </div>
          <div class="mt-0.5 text-xs text-slate-400">
            核对时刻 {{ check.check_time }} · 预期{{ check.expected === 'run' ? '运行' : '停运' }}
          </div>
          <div v-if="check.explanation" class="mt-0.5 text-xs text-slate-600">
            说明：{{ check.explanation }}
          </div>
        </div>
      </div>

      <!-- 逐项浏览：十板块全部读数（字段字典驱动，与填写页同源） -->
      <div class="px-3 pt-3">
        <div class="mb-1.5 text-sm font-bold text-slate-700">逐项浏览</div>
        <div
          v-for="group in sectionGroups"
          :key="group.no"
          class="mb-2 rounded-xl bg-white px-3 py-2"
          :data-testid="`detail-section-${group.no}`"
        >
          <div class="border-b border-slate-100 pb-1 text-xs font-bold text-slate-400">
            板块{{ group.no }} · {{ group.label }}
          </div>
          <div
            v-for="field in group.fields"
            :key="field.name"
            class="flex justify-between gap-3 py-1 text-sm"
            :data-field-name="field.name"
          >
            <span class="shrink-0 text-slate-400">
              {{ field.def.label }}<span v-if="field.def.unit">（{{ field.def.unit }}）</span>
            </span>
            <span class="text-right" :class="field.value === 'bad' ? 'font-bold text-red-600' : ''">
              {{ textOf(field.value) }}
            </span>
          </div>
        </div>
      </div>

      <!-- 逐条知晓与签名归档（TK-19，F2-04/F2-05）：仅待确认单显示 -->
      <div v-if="detail.status === 'submitted'" class="px-3 pt-3" data-testid="sign-area">
        <div class="rounded-xl bg-white px-3 py-3">
          <div
            v-if="unackedCount > 0"
            class="text-sm font-bold text-amber-700"
            data-testid="ack-hint"
          >
            尚有 {{ unackedCount }} 项标红/交接事项未逐条知晓，全部知晓后方可签名
          </div>
          <template v-else>
            <div class="mb-1.5 text-sm font-bold text-slate-700">接班人签名</div>
            <canvas
              :ref="setSigCanvas"
              data-testid="sign-canvas"
              class="h-36 w-full touch-none rounded-lg border border-slate-300 bg-white"
              @pointerdown.prevent="sigStart"
              @pointermove.prevent="sigMove"
              @pointerup="sigEnd"
              @pointerleave="sigEnd"
            ></canvas>
            <div class="mt-2 flex gap-2">
              <van-button size="small" plain data-testid="sign-clear" @click="sigClear">
                清除重签
              </van-button>
              <van-button
                size="small"
                type="primary"
                block
                data-testid="sign-submit"
                @click="signAndConfirm"
              >
                签名并归档确认
              </van-button>
            </div>
          </template>
        </div>
      </div>

      <!-- 确认信息（F2-05 口径预置：未确认时留空，TK-19 签名归档后可查） -->
      <div class="px-3 pt-1">
        <div
          class="rounded-xl bg-white px-3 py-2.5 text-sm text-slate-500"
          data-testid="detail-confirm-info"
        >
          <div v-if="detail.confirmed_at">
            确认时间：{{ detail.confirmed_at }}
            <span v-if="detail.signature_path">· 签名图已归档</span>
          </div>
          <div v-else class="text-xs">尚未确认归档</div>
        </div>
      </div>

      <div class="mt-4 px-3">
        <van-button block plain data-testid="detail-back" @click="emit('back')">
          返回待确认列表
        </van-button>
      </div>
    </template>

    <!-- 列表态：待确认交接单清单 -->
    <template v-else>
      <van-nav-bar
        title="交接确认"
        left-arrow
        data-testid="confirm-navbar"
        @click-left="emit('back')"
      />
      <div class="px-3 pt-3" data-testid="pending-list">
        <div class="mb-1.5 text-sm text-slate-500">
          以下交接单等待您确认（{{ items.length }} 份）
        </div>
        <div v-if="items.length === 0" class="pt-6">
          <van-empty description="暂无待确认的交接单" />
        </div>
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          class="mb-2 block w-full rounded-xl bg-white px-3 py-3 text-left shadow-sm"
          :data-testid="`pending-item-${item.record_no}`"
          @click="emit('open', item.id)"
        >
          <div class="flex items-center justify-between">
            <span class="text-base font-bold text-slate-800">{{ item.duty_date }}</span>
            <span
              v-if="item.alert_count > 0"
              class="rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-600"
            >
              标红 {{ item.alert_count }} 项
            </span>
          </div>
          <div class="mt-1 text-xs text-slate-400">
            {{ item.record_no }} · 交班人 {{ item.submitter.real_name }} · 提交于
            {{ item.submitted_at ?? '—' }}
          </div>
        </button>
      </div>
      <div v-if="loading" class="fixed inset-x-0 bottom-6 flex justify-center">
        <van-loading size="20">加载交接单…</van-loading>
      </div>
    </template>
  </div>
</template>
