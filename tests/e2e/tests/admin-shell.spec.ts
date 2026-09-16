/**
 * TK-23 管理后台框架 E2E（desktop-admin 项目，PC 视口 :5174）—— 覆盖后台框架的**客户端半边**：
 * - C-05 / PRD §6.6：chief 登录 → PC 布局（四页导航 + 顶栏用户区 + 应提交未提交卡片）；
 * - TK-23 判据「师傅访问后台一律 403」的界面半边：master 登录 → 前端转无权限页
 *   （服务端 /admin 路由 403 守卫为最终执法者，已由 apps/api admin.spec.ts supertest 矩阵锁定）。
 *
 * 走**真实后端**（登录/登出为真链路，服务端行为不在本文件 mock——层级说明比照 withdraw.spec）：
 * 种子 fresh 时应提交未提交集合为空（D-10~D-1 记录连续覆盖），断言卡片容器可见即可；
 * 未登录直开后台 → 回登录页（GET /auth/me 401 引导）。
 * 前置：MySQL 已灌种子、shared 已构建。详见 playwright.config.ts。
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Handover@2026';

/** 后台登录（真链路）：填账密 → 提交 → 等登录响应。el-input 把 data-testid 透传到内部原生 input，直接 fill */
async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/auth/login') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
}

test.describe('TK-23 科长后台框架（客户端半边）', () => {
  test('chief 登录 → PC 布局：四页导航 + 用户区 + 应提交未提交卡片；登出回登录页', async ({
    page,
  }) => {
    await login(page, 'chief');

    // 布局骨架：导航四项（PRD §6.6 记录管理/人员与排班/配置中心/审计日志）+ 用户区（种子陈科长）
    await expect(page.getByTestId('app-nav')).toBeVisible();
    for (const key of ['records', 'people', 'config', 'audit']) {
      await expect(page.getByTestId(`nav-${key}`)).toBeVisible();
    }
    await expect(page.getByTestId('app-user')).toContainText('陈科长');

    // 记录管理页：F6-06 后台半边卡片渲染（fresh 种子下无漏交 → 空态；跨灌种日有漏交 → 表格，皆可）
    await expect(page.getByTestId('missing-card')).toBeVisible();

    // 导航切换：占位页给出落点与任务编号（TK-24~29 落地前的骨架态）
    await page.getByTestId('nav-people').click();
    await expect(page.getByTestId('app-header')).toContainText('人员与排班');

    // 顶栏登出 → 回登录页
    await page.getByTestId('logout-btn').click();
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });

  test('master 登录 → 前端拦截展示无权限页（C-05；服务端 403 守卫为最终执法者）', async ({
    page,
  }) => {
    await login(page, 'zhang');
    await expect(page.getByTestId('denied-view')).toBeVisible();
    // 退出后回登录页，可重登他人账号
    await page.getByTestId('denied-logout').click();
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });

  test('未登录直开后台 → GET /auth/me 401 → 回登录页（会话恢复引导）', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });
});
