import { test, expect } from '@playwright/test';

/**
 * TK-01 脚手架冒烟：不依赖服务与浏览器产物，仅保证用例管线可跑。
 * 浏览器内核安装（pnpm --filter @handover/e2e exec playwright install）
 * 与真实链路用例见 TK-31。
 */
test('scaffold-smoke：用例管线可运行', () => {
  expect(1 + 1).toBe(2);
});
