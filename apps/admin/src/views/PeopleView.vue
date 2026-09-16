<script setup lang="ts">
/**
 * 人员与排班页（TK-23 骨架占位）：师傅账号开通/停用随 TK-25 落地（F6-02），
 * 最小排班表「日期→人」月视图维护与安全阀随 TK-26 落地（F6-03/04/05）。
 */
</script>

<template>
  <div>
    <el-card shadow="never" class="mb-4">
      <template #header><span class="font-semibold">人员管理</span></template>
      <el-empty
        description="师傅账号开通 / 停用（写审计，停用即不可登录）随任务 TK-25 落地"
        :image-size="80"
      />
    </el-card>
    <el-card shadow="never">
      <template #header><span class="font-semibold">排班管理</span></template>
      <el-empty
        description="最小排班表「日期→人」月视图维护（改即审计，驱动接班人带出与漏交检测）随任务 TK-26 落地"
        :image-size="80"
      />
    </el-card>
  </div>
</template>
