<script setup lang="ts">
/**
 * 审计日志页（TK-23 骨架占位）：按动作/操作人/时间筛选、展示谁何时把什么从多少改成多少
 * 随 TK-29 落地（F6-08，audit_logs 只增不改）。
 */
</script>

<template>
  <el-card shadow="never">
    <template #header><span class="font-semibold">审计日志</span></template>
    <el-empty
      description="按动作 / 操作人 / 时间筛选，展示谁在何时把什么配置从多少改成多少——随任务 TK-29 落地"
      :image-size="80"
    />
  </el-card>
</template>
