<script setup lang="ts">
import { RecordStatus, UserRole } from '@handover/shared';

// TK-01 脚手架占位页：仅验证 Element Plus + Tailwind + @handover/shared 三端同源链路
// 后台框架与权限守卫见 TK-23
const rows = RecordStatus.map((s) => ({ status: s }));
const roles = UserRole;
</script>

<template>
  <div class="p-6">
    <el-page-header title="返回" content="交接班 · 科长管理后台" />
    <el-alert
      class="mt-4"
      type="info"
      :closable="false"
      title="脚手架已就绪"
      description="后台框架与 chief 角色守卫见任务分解 TK-23"
    />
    <el-table class="mt-4" :data="rows" border>
      <el-table-column prop="status" label="共享包自检：记录状态枚举（@handover/shared）" />
    </el-table>
    <el-tag v-for="r in roles" :key="r" class="mt-4 mr-2">{{ r }}</el-tag>
  </div>
</template>
