<script setup lang="ts">
/**
 * 登录页（TK-23，C-05 实名制一人一号）：与师傅端同一套 /auth/login Cookie 通道。
 * 登录成功后由 App.vue 按 role 分流——chief 进入后台，master 转无权限页（后台为科长专用）。
 */
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, ApiRequestError, NetworkError, type AuthUser } from '../api/client';

const emit = defineEmits<{ loggedIn: [user: AuthUser] }>();

const username = ref('');
const password = ref('');
const submitting = ref(false);

async function submit(): Promise<void> {
  if (!username.value.trim() || !password.value) {
    ElMessage.warning('请输入账号与密码');
    return;
  }
  submitting.value = true;
  try {
    const { user } = await api.login(username.value.trim(), password.value);
    emit('loggedIn', user);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      ElMessage.error(err.message || '账号或密码错误');
    } else if (err instanceof NetworkError) {
      ElMessage.error('网络不可用，请检查院内网络连接');
    } else {
      ElMessage.error('登录失败，请重试');
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-100">
    <el-card class="w-96">
      <template #header>
        <div class="text-center">
          <div class="text-lg font-semibold">新院区交接班 · 科长管理后台</div>
          <div class="text-xs text-gray-400 mt-1">实名制登录（一人一号）· 登录设备记审计</div>
        </div>
      </template>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="账号">
          <el-input
            v-model="username"
            data-testid="login-username"
            name="username"
            placeholder="工号账号"
            autocomplete="username"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="password"
            type="password"
            data-testid="login-password"
            name="password"
            show-password
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button
          type="primary"
          data-testid="login-submit"
          class="w-full"
          :loading="submitting"
          native-type="submit"
        >
          登 录
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>
