import { defineConfig, devices } from '@playwright/test';

/**
 * E2E 配置。TK-01 建基线，TK-05 起接入真实前后端链路（webServer 自动拉起 api + h5）。
 *
 * 全量用例库（登录→填写→防呆→提交→确认→签名→归档 + 断网注入）随 **TK-31** 建设，
 * 用例名挂台账 -T 编号（《测试用例清单》）。故 e2e 包脚本名为 `test:e2e`、**暂不入 CI**
 * （CI 只跑 `pnpm test`，即 api 的 Jest 接口层）；TK-31 落地时再接"每次提交自动回归"。
 *
 * 前置条件：
 * - MySQL 已建库灌种子（`pnpm --filter @handover/api db:setup`），凭据见 apps/api/.env
 * - shared 已构建（`pnpm --filter @handover/shared build`）——api 经 dist 消费 shared，
 *   h5 经 vite alias 直用 TS 源码故不受影响
 * - 浏览器可用：默认用 Playwright 自带 chromium（`pnpm --filter @handover/e2e exec playwright install chromium`）；
 *   若本机未下载内核（或只装了完整 chromium 而无 headless shell 变体），可设环境变量
 *   `E2E_CHANNEL=chrome|msedge|chromium` 复用已装的系统浏览器——CI 不设此变量，保证跑的是自带内核。
 *
 * `reuseExistingServer: true`：本地已用 `pnpm dev` 起着服务时直接复用，不重复拉起。
 */
const REPO_ROOT = '../..';

/**
 * 浏览器通道（可选）。不设则用 Playwright 自带 chromium——这是 CI 的跑法，保证环境一致；
 * 本地开发机若缺对应内核（如仅有 chromium-1234 而无 chromium_headless_shell-1234），
 * 设 `E2E_CHANNEL=chrome` 即可直接驱动系统 Chrome，免去上百 MB 下载。
 */
const CHANNEL = process.env.E2E_CHANNEL as 'chrome' | 'msedge' | 'chromium' | undefined;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // PRD §7 技术约束「移动端优先」：以真机尺寸跑，而非桌面视口
      name: 'mobile-h5',
      use: { ...devices['Pixel 7'], ...(CHANNEL ? { channel: CHANNEL } : {}) },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @handover/api dev',
      cwd: REPO_ROOT,
      // 健康检查排除在 /api/v1 前缀之外（见 apps/api/src/app.setup.ts）
      url: 'http://localhost:3000/health',
      reuseExistingServer: true,
      // nest 首次编译较慢，给足超时
      timeout: 180_000,
    },
    {
      command: 'pnpm --filter @handover/h5 dev',
      cwd: REPO_ROOT,
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
