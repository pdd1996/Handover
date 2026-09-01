import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// 开发期直接消费 shared 的 TS 源码（dist 产物为 CJS，供 Nest 端消费）
const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@handover/shared': sharedSrc },
  },
  server: {
    host: true, // 院内局域网手机访问
    proxy: {
      // 开发期接口转发到 NestJS 后端
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
