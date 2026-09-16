<script setup lang="ts">
/**
 * 记录管理页（TK-23 骨架）：当前落地「应提交未提交」视图（F6-06 后台半边，契约 §3.6
 * GET /admin/missing-submits，数据源与 missing_submit 站内通知同源）；
 * 交接单查看 / 筛选 / 导出 / 批注随 TK-24 落地（下方占位区）。
 */
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { MissingSubmitItemDto } from '@handover/shared';
import { api, ApiRequestError, NetworkError } from '../api/client';

const emit = defineEmits<{ sessionLost: [] }>();

const items = ref<readonly MissingSubmitItemDto[]>([]);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const body = await api.missingSubmits();
    items.value = body.items;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) emit('sessionLost');
    else if (err instanceof ApiRequestError) ElMessage.error(err.message);
    else if (err instanceof NetworkError) ElMessage.error('网络不可用，请稍后重试');
    else ElMessage.error('加载失败，请重试');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <el-card shadow="never" class="mb-4" data-testid="missing-card">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-semibold text-orange-500">应提交未提交</span>
          <el-button text :loading="loading" @click="load">刷新</el-button>
        </div>
      </template>
      <div class="text-xs text-gray-400 mb-3">
        定时任务按排班表扫描：班次日期已过约定时点（默认次日
        9:00，可调）仍无已提交记录即提醒（F6-06，数据源与站内通知同源）。
      </div>
      <el-table
        v-if="items.length > 0"
        :data="items as MissingSubmitItemDto[]"
        border
        data-testid="missing-table"
      >
        <el-table-column prop="duty_date" label="班次日期" width="160" />
        <el-table-column prop="real_name" label="排班人" min-width="120" />
        <el-table-column label="处置提示" min-width="220">
          <template #default>请联系排班师傅核实提交，或按补交流程处理</template>
        </el-table-column>
      </el-table>
      <el-empty
        v-else-if="!loading"
        description="暂无应提交未提交班次"
        :image-size="80"
        data-testid="missing-empty"
      />
    </el-card>

    <el-card shadow="never">
      <template #header><span class="font-semibold">交接记录</span></template>
      <el-empty
        description="交接单查看 / 按日期与交班人筛选 / 导出 / 批注随任务 TK-24 落地"
        :image-size="80"
      />
    </el-card>
  </div>
</template>
