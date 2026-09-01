import { defineConfig, devices } from '@playwright/test';

/**
 * TK-01 脚手架基线配置。
 * 全量用例库（登录→填写→防呆→提交→确认→签名→归档 + 断网注入）随 TK-31 建设，
 * 用例名挂台账 -T 编号（《测试用例清单》）。
 */
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
      name: 'mobile-h5',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
