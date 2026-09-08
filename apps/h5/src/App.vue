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
import { computed, onMounted, ref } from 'vue';
import { showToast } from 'vant';
import type { TodayDto } from '@handover/shared';
import { ApiRequestError, api, type AuthUser } from './api/client';
import TodayView from './views/TodayView.vue';
import SectionView from './views/SectionView.vue';

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

/** 错误提示：业务错误用服务端文案（C-09 禁止模糊提示），网络错误用本地文案 */
function notify(err: unknown): void {
  const message = err instanceof Error ? err.message : '操作失败，请重试';
  if (err instanceof ApiRequestError && err.status === 401) {
    // 会话过期/已登出/账号被停用 → 回登录页（契约 §3.1 鉴权失败统一 401）
    user.value = null;
    today.value = null;
  }
  showToast(message);
}

async function loadToday(): Promise<void> {
  loadingToday.value = true;
  try {
    today.value = await api.today();
  } catch (err) {
    notify(err);
  } finally {
    loadingToday.value = false;
  }
}

async function bootstrap(): Promise<void> {
  try {
    user.value = await api.me(); // Cookie 仍有效则直接进首页
    await loadToday();
  } catch {
    user.value = null; // 未登录或会话过期，静默回登录页（不必弹错）
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
  user.value = null;
  today.value = null;
  activeCardKey.value = null;
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
  <SectionView v-else-if="activeCard" :card="activeCard" @back="backToToday" />

  <!-- 今日交接首页（F1-01 / F1-02 / F1-03） -->
  <template v-else>
    <TodayView v-if="today" :today="today" @open="openCard" />
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
</template>
