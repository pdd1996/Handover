<script setup lang="ts">
/**
 * 科长管理后台外壳（TK-23 后台框架与权限）：
 *
 * **PC Web 布局**（PRD §6.6、demo 科长后台 v0.1 的四页导航）：左侧导航（记录管理 /
 * 人员与排班 / 配置中心 / 审计日志）+ 顶部用户区 + 主内容区；四个页面的业务内容随
 * TK-24~29 逐个落地（占位页先给出落点与任务编号）。与师傅端 h5 同款模式：不引入
 * vue-router，组件状态切换视图（仓库既有口径，避免为骨架页新增依赖）。
 *
 * **进入控制（C-05）**：刷新后经 GET /auth/me 恢复登录态；role ≠ chief 转无权限页——
 * 服务端 /admin 路由的 chief 守卫（403）是最终执法者，前端拦截只为不把师傅领进无权限界面。
 *
 * **会话失效单一入口** `handleSessionLoss`：任何子视图收到 401（会话过期/登出/停用）
 * 统一回登录页——与 h5 的 resetSession 单一入口同一纪律，不得另开清态路径。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, ApiRequestError, type AuthUser } from './api/client';
import LoginView from './views/LoginView.vue';
import DeniedView from './views/DeniedView.vue';
import RecordsView from './views/RecordsView.vue';
import PeopleView from './views/PeopleView.vue';
import ConfigView from './views/ConfigView.vue';
import AuditView from './views/AuditView.vue';

type Screen = 'booting' | 'login' | 'denied' | 'ready';

const NAV = [
  { key: 'records', title: '记录管理', sub: '查看 / 追溯全部交接记录（含应提交未提交提醒）' },
  { key: 'people', title: '人员与排班', sub: '师傅账号开通停用 · 最小排班表「日期→人」维护' },
  { key: 'config', title: '配置中心', sub: '阈值 / 清单 / 电梯字典统一维护，保存即全员生效' },
  { key: 'audit', title: '审计日志', sub: '谁在何时把什么配置从多少改成多少' },
] as const;

type NavKey = (typeof NAV)[number]['key'];

const screen = ref<Screen>('booting');
const user = ref<AuthUser | null>(null);
const view = ref<NavKey>('records');
const loggingOut = ref(false);

const currentView = computed(
  () =>
    ({ records: RecordsView, people: PeopleView, config: ConfigView, audit: AuditView })[
      view.value
    ],
);
const currentNav = computed(() => NAV.find((n) => n.key === view.value)!);

function enterAs(loggedIn: AuthUser): void {
  user.value = loggedIn;
  screen.value = loggedIn.role === 'chief' ? 'ready' : 'denied';
}

function handleSessionLoss(): void {
  user.value = null;
  screen.value = 'login';
}

onMounted(async () => {
  try {
    enterAs(await api.me());
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) {
      screen.value = 'login';
    } else {
      // 启动即不可达/初始化失败：不是未登录——不得伪装成登录态丢失，给出显式重试入口
      ElMessage.error('服务暂不可达，请确认网络后重试');
      screen.value = 'booting';
    }
  }
});

async function retryBootstrap(): Promise<void> {
  screen.value = 'booting';
  try {
    enterAs(await api.me());
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) screen.value = 'login';
    else {
      ElMessage.error('服务暂不可达，请确认网络后重试');
      screen.value = 'booting';
    }
  }
}

async function logout(): Promise<void> {
  loggingOut.value = true;
  try {
    await api.logout();
    handleSessionLoss();
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) handleSessionLoss();
    else ElMessage.error('退出失败，请重试');
  } finally {
    loggingOut.value = false;
  }
}
</script>

<template>
  <!-- 启动中 / 不可达：显式状态，不闪登录页 -->
  <div
    v-if="screen === 'booting'"
    class="min-h-screen flex items-center justify-center bg-gray-100"
  >
    <div class="text-center">
      <div class="text-lg text-gray-500 mb-3">正在连接交接班服务…</div>
      <el-button type="primary" @click="retryBootstrap">重试</el-button>
    </div>
  </div>

  <LoginView v-else-if="screen === 'login'" @logged-in="enterAs" />
  <DeniedView v-else-if="screen === 'denied'" @logged-out="handleSessionLoss" />

  <!-- 主布局：侧边导航 + 顶栏 + 内容区（PRD §6.6 四页导航，业务随 TK-24~29 落地） -->
  <el-container v-else class="h-screen">
    <el-aside width="224px" class="border-r border-gray-200 bg-white flex flex-col">
      <div class="px-5 py-4 border-b border-gray-100">
        <div class="font-semibold">新院区交接班</div>
        <div class="text-xs text-gray-400 mt-0.5">科长管理后台</div>
      </div>
      <el-menu
        :default-active="view"
        class="flex-1 border-r-0"
        data-testid="app-nav"
        @select="(k: string) => (view = k as NavKey)"
      >
        <el-menu-item v-for="n in NAV" :key="n.key" :index="n.key" :data-testid="`nav-${n.key}`">
          {{ n.title }}
        </el-menu-item>
      </el-menu>
      <div class="px-5 py-4 border-t border-gray-100 text-xs text-gray-500" data-testid="app-user">
        登录：<span class="font-semibold text-gray-700">{{ user?.real_name }}</span
        >（科长）
      </div>
    </el-aside>

    <el-container>
      <el-header
        class="bg-white border-b border-gray-200 flex items-center justify-between"
        data-testid="app-header"
      >
        <div>
          <div class="text-base font-semibold">{{ currentNav.title }}</div>
          <div class="text-xs text-gray-400">{{ currentNav.sub }}</div>
        </div>
        <el-button :loading="loggingOut" data-testid="logout-btn" @click="logout"
          >退出登录</el-button
        >
      </el-header>
      <el-main class="bg-gray-100">
        <component :is="currentView" @session-lost="handleSessionLoss" />
      </el-main>
    </el-container>
  </el-container>
</template>
