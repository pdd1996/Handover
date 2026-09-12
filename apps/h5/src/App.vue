<script setup lang="ts">
/**
 * 师傅端 H5 根组件（TK-05）。
 *
 * 职责：登录态管理 + 首页与板块页的两级视图切换。
 *
 * **不引入 vue-router**：TK-05 只需"首页 ↔ 板块页"两级，用组件状态切换即可；PRD §6.0 的其余页面
 * （交接确认、预警中心、历史记录）分属 TK-18/Phase 2/TK-2x，届时页面数上来再统一决定路由方案，
 * 避免此刻为两级视图先定一套路由架构、随后被 TK-06/TK-18 的需求推翻。
 *
 * 认证走 HttpOnly Cookie（契约 §1、D-T13）：令牌由浏览器自动携带，前端不持有；
 * 刷新页面后靠 GET /auth/me 恢复登录态（401 则回登录页）。
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { showToast } from 'vant';
import {
  CARD_BY_FIELD,
  isFilledValue,
  type FormOptionsDto,
  type MissingField,
  type PrevDto,
  type PreviewDto,
  type SubmitPayloadDto,
  type TodayDto,
  type UsageOverridePayload,
} from '@handover/shared';
import { ApiRequestError, api, type AuthUser } from './api/client';
import TodayView from './views/TodayView.vue';
import SectionView from './views/SectionView.vue';
import { useDraft } from './store/draft';

const draft = useDraft();

const user = ref<AuthUser | null>(null);
const today = ref<TodayDto | null>(null);
/** 当前打开的板块页卡片 key；null 表示停留在首页 */
const activeCardKey = ref<string | null>(null);
const booting = ref(true);
const loadingToday = ref(false);

const loginForm = ref({ username: '', password: '' });
const loggingIn = ref(false);

const activeCard = computed(
  () => today.value?.cards.find((c) => c.key === activeCardKey.value) ?? null,
);

/** 开发构建标记（Vite 标准）：生产构建不含种子账号提示，避免泄露开发凭据线索 */
const isDev = import.meta.env.DEV;

/**
 * 上一班带出（TK-07，m1/m2 已随 TK-08 收敛到本组件）：**App 级按 duty_date 缓存**——
 * 同班次内开任意卡复用同一份响应（原实现在 SectionView 每开一卡重复拉取），
 * 跨班次（duty_date 变化）由 loadPrev 自动重取。
 */
const prevInfo = ref<PrevDto | null>(null);
const prevCache = ref<{ dutyDate: string; dto: PrevDto } | null>(null);

/**
 * 表单候选配置（TK-11，DATA-07）：App 级拉取、**会话级缓存**——backToToday 每次返回
 * 首页都会经 loadToday 调到 loadConfigs，已拉到即复用不再重发（评审 M3，与 TK-07 评审
 * m1 对 /prev 的结论同口径，C-01 填写效率优先）；resetSession 清空后（重新登录）才重拉。
 * 拉取失败/离线时置 null：SectionView 回落种子占位候选渲染，不阻塞填写。
 */
const configs = ref<FormOptionsDto | null>(null);

/**
 * 登录态清理**单一入口**（TK-06 评审遗漏一，二次评审订正）：**已建立登录态后的失效**——
 * 被动掉线（handleSessionLoss 的 401 分支：会话过期/账号被停用）与主动登出（onLogout）、
 * 以及启动恢复失败（bootstrap 的静默 catch）都必须走这里；清空项新增/删减只改本函数，
 * 不得在分支里各写一份。边界：**登录请求自身的 401（F1-11-T2/T3 密码错/停用）不走这里**——
 * 此刻本无会话可言，误清会丢用户本机草稿（违反 F1-09 续填，D-T18 修订 #9）。
 * 清空范围：**仅会话内内存草稿**——持久草稿按 D-T18 修订 #9 保留至该班次出现已提交记录
 * （登出/会话失效不删本机草稿：弱信号点位长时间填写不因掉线丢整班数据，PRD §7 双保险；
 * 串值防护由用户+班次 keying 承担，C-05）；带出数据与 duty_date 缓存一并清。
 */
function resetSession(): void {
  user.value = null;
  today.value = null;
  activeCardKey.value = null;
  prevInfo.value = null;
  prevCache.value = null;
  configs.value = null;
  draft.clearMemory();
}

/**
 * 已建立登录态后的 401 → 会话失效（会话过期/已登出/账号被停用，契约 §3.1 鉴权失败统一 401）
 * → resetSession 单一入口。返回是否发生了清理，供调用方决定降级方式。
 * TK-07 评审 m2：/prev 拉取的 401 原先在 SectionView 被静默吞掉，现与本判断汇流（不再各写一份）。
 */
function handleSessionLoss(err: unknown): boolean {
  if (
    err instanceof ApiRequestError &&
    err.status === 401 &&
    user.value !== null // 仅已登录态下的被动掉线；登录请求自身的 401 不得清草稿（见 resetSession 注）
  ) {
    resetSession();
    return true;
  }
  return false;
}

/** 错误提示：业务错误用服务端文案（C-09 禁止模糊提示），网络错误用本地文案 */
function notify(err: unknown): void {
  handleSessionLoss(err);
  const message = err instanceof Error ? err.message : '操作失败，请重试';
  showToast(message);
}

/**
 * 上一班带出拉取（TK-07 评审 m1/m2）：按 duty_date 缓存，同班次只拉一次；401 并入
 * handleSessionLoss 单一入口；其余失败（网络/离线，TK-15 接管）静默降级为「无比对值」——
 * 带出是只读辅助信息，不弹错、不阻塞填写。
 */
async function loadPrev(): Promise<void> {
  const dutyDate = today.value?.duty_date;
  if (!dutyDate) return;
  if (prevCache.value?.dutyDate === dutyDate) {
    prevInfo.value = prevCache.value.dto;
    return;
  }
  try {
    const dto = await api.prev();
    prevCache.value = { dutyDate, dto };
    prevInfo.value = dto;
  } catch (err) {
    if (!handleSessionLoss(err)) prevInfo.value = null;
  }
}

async function loadToday(): Promise<void> {
  loadingToday.value = true;
  try {
    today.value = await api.today();
    void loadPrev();
    void loadConfigs();
    // F1-09 续填入口：登录态 + 班次键就绪后恢复持久草稿；恢复了有内容的草稿则给
    // 「草稿恢复提示」（PRD §6.1 设计触点）。restore 同键幂等（backToToday 重复调用不重灌）
    if (user.value && (await draft.restore(user.value.id, today.value.duty_date))) {
      showToast('已恢复本班次未提交的草稿');
    }
  } catch (err) {
    notify(err);
  } finally {
    loadingToday.value = false;
  }
}

/**
 * 表单候选配置拉取（TK-11）：**会话级缓存（评审 M3）**——已拉到即复用，否则每次
 * 返回首页都会重发；401 并入 handleSessionLoss 单一入口；其余失败（网络/离线，
 * TK-15 接管）静默降级为回落候选——候选是渲染辅助数据，不弹错、不阻塞填写。
 */
async function loadConfigs(): Promise<void> {
  if (configs.value !== null) return;
  try {
    configs.value = await api.configs();
  } catch (err) {
    if (!handleSessionLoss(err)) configs.value = null;
  }
}

async function bootstrap(): Promise<void> {
  try {
    user.value = await api.me(); // Cookie 仍有效则直接进首页
    await loadToday();
  } catch {
    // 未登录或会话过期，静默回登录页（不必弹错）；草稿随登录态一并清内存（resetSession 单一入口）。
    // 持久草稿不动（D-T18 修订 #9）：按用户+班次 keying，只可能被同一人同班次恢复，无串值风险（C-05）
    resetSession();
  } finally {
    booting.value = false;
  }
}

async function onLogin(): Promise<void> {
  const { username, password } = loginForm.value;
  if (!username.trim() || !password) {
    showToast('请输入账号与密码');
    return;
  }
  loggingIn.value = true;
  try {
    const res = await api.login(username.trim(), password);
    user.value = res.user;
    loginForm.value = { username: '', password: '' };
    await loadToday();
  } catch (err) {
    // F1-11-T2/T3：账号密码错误与账号停用均由服务端给出确定文案，前端不自行判断账号是否存在
    notify(err);
  } finally {
    loggingIn.value = false;
  }
}

async function onLogout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // 登出失败也清本地态：会话存根可能已失效，卡在页面反而更糟
  }
  // 本人登出：仅清会话内内存（持久草稿保留至该班次提交成功，D-T18 修订 #9）；
  // 换账号不得串值由 keying 保证（C-05）
  resetSession();
}

/** 打开板块填写页（F1-02-T2） */
function openCard(key: string): void {
  activeCardKey.value = key;
}

/** 返回首页并重取汇总：TK-06 起填写会改动角标与进度条，返回即需刷新（F1-03「实时汇总」） */
async function backToToday(): Promise<void> {
  activeCardKey.value = null;
  await loadToday();
}

/**
 * 提交前汇总预览与提交（TK-12，F1-10/F2-01/DATA-09/10）：
 * 点击「提交交接单」→ 先调 POST /preview 取未填项/异常项两张点名清单 → 弹窗展示，
 * 未填项清零前提交按钮置灰；确认提交后服务端生成正式交接单（F2-01），成功后
 * **必须调 draft.markSubmitted**（D-T18 修订 #9：持久草稿清除时点 = 该班次出现已提交记录，
 * 否则重开页面旧草稿复活并以「草稿 ?? 服务端值」优先于服务端真值）。
 * 修改接班人（DATA-10）的候选人员接口随 TK-26 排班后台落地后接入，本阶段仅展示带出值。
 */
const showPreview = ref(false);
const preview = ref<PreviewDto | null>(null);
const submitting = ref(false);

/**
 * 提交 payload：**全字典合并视图（评审修复轮 M5）**——「草稿 ?? 服务端值」与首页角标同一
 * 取值口径，未填字段显式上送 null。单发草稿会漏掉服务端已有值（撤回重提时本机草稿已被
 * markSubmitted 清空，payload 近乎全空），单发服务端值则清空的字段会回落旧值；两者都不是
 * 快照。服务端另有快照兑底（字典存储列未上送一律写 NULL），两道防线互为补充。
 */
function buildPayload(): SubmitPayloadDto {
  const sections: Record<string, unknown> = {};
  for (const card of today.value?.cards ?? []) {
    for (const field of card.fields) {
      const d = draft.getValue(field.name as never);
      sections[field.name] = d !== null ? d : (field.value ?? null);
    }
  }
  // 用量手工覆盖（TK-13，F3-04/F3-06）：lo_day_use 草稿有值即视为师傅改写了自动推荐值，
  // 随附原因上送（sections 里的 *_use 键服务端不采信，覆盖必须显式走本清单）；原因空白
  // 由服务端 400 点名拦截（F3-06-T2），SectionView 完成本卡时已先行预检同口径
  const usage_overrides: UsageOverridePayload[] = [];
  const loOverride = draft.getValue('lo_day_use');
  if (isFilledValue(loOverride)) {
    usage_overrides.push({
      field: 'lo_day_use',
      value: String(loOverride),
      reason: String(draft.getValue('usage_override_reason') ?? ''),
    });
  }
  return usage_overrides.length > 0 ? { sections, usage_overrides } : { sections };
}

async function onOpenPreview(): Promise<void> {
  try {
    preview.value = await api.preview(buildPayload());
    showPreview.value = true;
  } catch (err) {
    notify(err);
  }
}

/**
 * 点击预览清单项 → 关弹窗跳到对应卡片并滚动定位到字段（C-09「点击跳转可达」，
 * 字段 → 卡片映射用 shared CARD_BY_FIELD 单一来源；电梯核对行 elevator:{id} 随 TK-17 落地）
 */
async function jumpFromPreview(item: MissingField): Promise<void> {
  const cardKey = CARD_BY_FIELD[item.field as keyof typeof CARD_BY_FIELD] ?? null;
  showPreview.value = false;
  if (!cardKey) return;
  activeCardKey.value = cardKey;
  await nextTick();
  window.setTimeout(() => {
    document
      .getElementById(item.anchor.slice(1))
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 200);
}

async function onConfirmSubmit(): Promise<void> {
  if (!today.value || submitting.value) return;
  submitting.value = true;
  try {
    const result = await api.submit(buildPayload());
    // D-T18 修订 #9：提交成功即清本班次持久草稿（TK-12 挂账钩子）；清除失败必须可见
    // （评审修复轮 L2：静默吞掉会让旧草稿在重开页面后压过服务端真值）
    const cleared = await draft.markSubmitted(user.value!.id, today.value.duty_date);
    showPreview.value = false;
    showToast(
      cleared
        ? `提交成功，交接单号 ${result.record_no}`
        : `提交成功（${result.record_no}），本机草稿清除失败，请重开页面核对`,
    );
    await loadToday(); // 重取汇总：首页状态转「已提交」、提交入口随之隐藏
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 400 && err.body.missing_fields) {
      // 服务端复验拦下（C-09）：把点名清单回填预览弹窗逐条展示，不关窗
      preview.value = {
        duty_date: today.value?.duty_date ?? '',
        missing_fields: err.body.missing_fields,
        abnormal_fields: preview.value?.abnormal_fields ?? [],
      };
      showToast(err.body.message);
      return;
    }
    if (err instanceof ApiRequestError && err.status === 409) {
      // 当日已提交/防呆待确认：提示后回首页重取（防呆重提协议随 TK-14 落地）
      showPreview.value = false;
      showToast(err.body.message);
      await loadToday();
      return;
    }
    notify(err);
  } finally {
    submitting.value = false;
  }
}

onMounted(bootstrap);
</script>

<template>
  <!-- 启动中：恢复登录态与首屏数据 -->
  <div v-if="booting" class="flex min-h-screen items-center justify-center bg-slate-100">
    <van-loading size="24" vertical>加载中…</van-loading>
  </div>

  <!-- 登录页（F1-11：账号密码由系统发号，暂不对接企业微信/钉钉） -->
  <div v-else-if="!user" class="min-h-screen bg-slate-100">
    <van-nav-bar title="交接班 · 师傅端" />
    <div class="px-4 pt-8">
      <div class="mb-6 text-center">
        <div class="text-xl font-bold text-slate-800">今日交接</div>
        <div class="mt-1 text-sm text-slate-500">请使用本人账号登录（一人一号，C-05 实名制）</div>
      </div>

      <van-form data-testid="login-form" @submit="onLogin">
        <van-cell-group inset>
          <van-field
            v-model="loginForm.username"
            name="username"
            label="账号"
            placeholder="请输入账号"
            autocomplete="username"
            data-testid="login-username"
          />
          <van-field
            v-model="loginForm.password"
            type="password"
            name="password"
            label="密码"
            placeholder="请输入密码"
            autocomplete="current-password"
            data-testid="login-password"
          />
        </van-cell-group>
        <div class="mt-6 px-4">
          <van-button
            block
            type="primary"
            native-type="submit"
            :loading="loggingIn"
            data-testid="login-submit"
          >
            登录
          </van-button>
        </div>
      </van-form>

      <!-- 开发期便利：种子账号提示（《开发种子数据》§一），生产构建不含 -->
      <div v-if="isDev" class="mt-6 px-4 text-xs leading-relaxed text-slate-400">
        开发种子账号：zhang / shi / wang / liu（师傅）、chief（科长），统一密码见种子文档§一。
      </div>
    </div>
  </div>

  <!-- 板块填写页（F1-02-T2） -->
  <SectionView
    v-else-if="activeCard"
    :card="activeCard"
    :prev-info="prevInfo"
    :configs="configs"
    @back="backToToday"
  />

  <!-- 今日交接首页（F1-01 / F1-02 / F1-03） -->
  <template v-else>
    <TodayView
      v-if="today"
      :today="today"
      :can-submit="user?.role === 'master'"
      @open="openCard"
      @submit="onOpenPreview"
    />
    <div v-else class="flex min-h-screen items-center justify-center bg-slate-100">
      <van-loading v-if="loadingToday" size="24" vertical>加载今日交接…</van-loading>
      <van-empty v-else description="首页数据加载失败">
        <van-button type="primary" size="small" @click="loadToday">重试</van-button>
      </van-empty>
    </div>

    <!-- 退出登录（契约 §3.1：删除会话存根，服务端亦不再认可该令牌） -->
    <div v-if="today" class="px-3 pb-6">
      <van-button block plain type="default" data-testid="logout" @click="onLogout">
        退出登录（{{ user.real_name }}）
      </van-button>
    </div>
  </template>

  <!-- 提交前汇总预览弹窗（TK-12，F1-10）：未填项/异常项逐条点名，点击跳转定位（C-09） -->
  <div
    v-if="showPreview && preview"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
  >
    <div class="max-h-[80vh] w-full overflow-y-auto rounded-t-2xl bg-white px-4 pb-6 pt-4">
      <div class="flex items-baseline justify-between">
        <div class="text-base font-bold text-slate-800" data-testid="preview-title">
          提交前预览（{{ preview.duty_date }}）
        </div>
        <button
          type="button"
          class="text-sm text-slate-400"
          data-testid="preview-close"
          @click="showPreview = false"
        >
          关闭
        </button>
      </div>

      <!-- 接班人（F2-01/DATA-10）：按排班自动带出；修改入口待 TK-26 人员接口 -->
      <div
        class="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600"
        data-testid="preview-receiver"
      >
        接班人：
        <b class="text-slate-800">{{ today?.receiver?.real_name ?? '（无次日排班）' }}</b>
        <span class="ml-1 text-xs text-slate-400">按排班表自动带出</span>
      </div>

      <!-- 未填项（缺失在前、越界在后，同 submit 400 口径） -->
      <div class="mt-3" data-testid="preview-missing" :data-count="preview.missing_fields.length">
        <div
          class="text-sm font-bold"
          :class="preview.missing_fields.length > 0 ? 'text-red-600' : 'text-emerald-600'"
        >
          未填项 {{ preview.missing_fields.length }} 项
          <span v-if="preview.missing_fields.length === 0">· 全部就绪</span>
        </div>
        <button
          v-for="item in preview.missing_fields"
          :key="item.field"
          type="button"
          class="mt-1.5 flex w-full items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-left text-sm text-slate-800"
          :data-testid="`preview-item-${item.field}`"
          @click="jumpFromPreview(item)"
        >
          <span
            >{{ item.label
            }}<span class="ml-1 text-xs text-slate-400">板块{{ item.section }}</span></span
          >
          <van-icon name="arrow" class="text-slate-400" />
        </button>
      </div>

      <!-- 异常项（状态选「异常」的标红项，不拦提交，PRD §6.2） -->
      <div class="mt-3" data-testid="preview-abnormal" :data-count="preview.abnormal_fields.length">
        <div class="text-sm font-bold text-amber-600">
          异常项 {{ preview.abnormal_fields.length }} 项
        </div>
        <button
          v-for="item in preview.abnormal_fields"
          :key="item.field"
          type="button"
          class="mt-1.5 flex w-full items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-left text-sm text-slate-800"
          :data-testid="`preview-item-${item.field}`"
          @click="jumpFromPreview(item)"
        >
          <span
            >{{ item.label
            }}<span class="ml-1 text-xs text-slate-400">板块{{ item.section }}</span></span
          >
          <van-icon name="arrow" class="text-slate-400" />
        </button>
      </div>

      <div class="mt-4">
        <van-button
          block
          type="danger"
          :disabled="preview.missing_fields.length > 0"
          :loading="submitting"
          data-testid="preview-submit"
          @click="onConfirmSubmit"
        >
          {{ preview.missing_fields.length > 0 ? '仍有未填项，无法提交' : '确认提交' }}
        </van-button>
      </div>
    </div>
  </div>
</template>
