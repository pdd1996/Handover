<script setup lang="ts">
/**
 * 配置中心页（TK-23 骨架占位）：阈值/基数/区间/新风位置清单/锅炉清单统一维护随 TK-27
 * 落地（F6-07，保存即全员生效、新旧值写审计）；电梯字典与运行计划随 TK-28 落地（ELE-01/08/09）。
 */
</script>

<template>
  <div>
    <el-card shadow="never" class="mb-4">
      <template #header><span class="font-semibold">配置中心</span></template>
      <el-empty
        description="预警阈值 / 气瓶基数 / 新风位置清单 / 锅炉清单统一维护（新旧值写审计、保存即全员生效）随任务 TK-27 落地"
        :image-size="80"
      />
    </el-card>
    <el-card shadow="never">
      <template #header><span class="font-semibold">电梯字典</span></template>
      <el-empty
        description="电梯运行计划三选一（支持跨零点时段）、停运原因维护（增删改写审计）随任务 TK-28 落地"
        :image-size="80"
      />
    </el-card>
  </div>
</template>
