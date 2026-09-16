<script setup lang="ts">
/**
 * 无权限页（TK-23，C-05）：后台为科长专用（契约 §3.6 全部 /admin 路由 chief 守卫，master
 * 访问一律 403）。师傅账号误登时前端先行拦截展示本页——服务端守卫仍是最终执法者。
 */
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, ApiRequestError, NetworkError } from '../api/client';

const emit = defineEmits<{ loggedOut: [] }>();

const leaving = ref(false);

async function logout(): Promise<void> {
  leaving.value = true;
  try {
    await api.logout();
    emit('loggedOut');
  } catch (err) {
    if (err instanceof NetworkError) ElMessage.error('网络不可用，请稍后重试');
    else if (err instanceof ApiRequestError) ElMessage.error(err.message);
    else ElMessage.error('退出失败，请重试');
  } finally {
    leaving.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-100" data-testid="denied-view">
    <el-result
      icon="warning"
      title="无权限访问"
      sub-title="科长管理后台仅限科长账号使用。如您是值班师傅，请使用师傅端 H5 填写交接单。"
    >
      <template #extra>
        <el-button type="primary" data-testid="denied-logout" :loading="leaving" @click="logout"
          >退出登录</el-button
        >
      </template>
    </el-result>
  </div>
</template>
