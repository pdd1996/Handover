<script setup lang="ts">
import { RecordStatus } from '@handover/shared';

// TK-01 脚手架占位页：仅验证 Vant + Tailwind + @handover/shared 三端同源链路
const statuses = RecordStatus;
</script>

<template>
  <div class="p-4">
    <van-nav-bar title="交接班 · 师傅端" />
    <van-empty description="脚手架已就绪，今日交接首页见 TK-05" />
    <van-cell-group title="共享包自检：记录状态枚举（@handover/shared）">
      <van-cell v-for="s in statuses" :key="s" :title="s" />
    </van-cell-group>
  </div>
</template>
