/**
 * TK-25 人员管理 E2E（desktop-admin 项目，PC 视口 :5174）—— F6-02「师傅账号开通/停用」的
 * **客户端半边**（接口半边由 apps/api admin-users.spec.ts supertest 覆盖，F6-02-T1）：
 * - chief 登录 → 人员与排班页账号全景渲染（种子账号按行定位断言、角色/状态列；科长行只读）；
 * - 开通真链路：填登录名/姓名/初始密码 → POST /admin/users → 列表新增行；
 * - 停用/启用真链路：二次确认弹窗 → 状态 tag 翻转（停用即不可登录的服务端半边由
 *   接口用例断言，本文件不重复）。
 *
 * 走真实后端（不 mock 服务端行为，比照 admin-records.spec）。开通的测试账号带 tk25e2e
 * 前缀随机后缀（避开历史运行的重复名 400），用例结束时恢复「启用」状态；账号行本身
 * 留库（无删除端点，属管理动作的自然残留，db:setup 重灌即清）。
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Handover@2026';
/** 随机后缀：同库多次跑 E2E 不撞 UNIQUE(username) */
const TEST_USER = `tk25e2e${Math.floor(1000 + Math.random() * 9000)}`;

/**
 * 本文件三个用例共享一条开通链路（② 开通的账号供 ③ 启停），且 ① 断言种子行数——
 * 文件内改串行（声明序执行），避免 fullyParallel 下自造行撞黄金值。
 */
test.describe.configure({ mode: 'serial' });

/** 后台登录（真链路）：填账密 → 提交 → 等登录响应。el-input 把 data-testid 透传到内部原生 input */
async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/auth/login') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
}

test.describe('TK-25 人员管理（客户端半边）', () => {
  test('chief：账号全景渲染（种子账号角色/状态列、科长行只读）', async ({ page }) => {
    await login(page, 'chief');
    await page.getByTestId('nav-people').click();

    const table = page.getByTestId('users-table');
    await expect(table).toBeVisible();
    // 种子账号逐行定位断言（**不断言行数**——历史运行残留的 tk25e2e 账号无删除端点、
    // 留库不影响；种子黄金值全量对账归接口层 admin-users.spec 从库反查）
    const chiefRow = table.locator('tbody tr', { hasText: 'chief' });
    await expect(chiefRow).toHaveCount(1);
    await expect(chiefRow).toContainText('陈科长');
    await expect(chiefRow).toContainText('科长');
    // 科长行只读（无启停按钮），师傅行有启停入口与状态列
    await expect(chiefRow.getByRole('button')).toHaveCount(0);
    const zhangRow = table.locator('tbody tr', { hasText: 'zhang' });
    await expect(zhangRow).toHaveCount(1);
    await expect(zhangRow).toContainText('张师傅');
    await expect(zhangRow).toContainText('师傅');
    await expect(page.getByTestId('user-status-zhang')).toContainText('启用');
    await expect(page.getByTestId('user-toggle-zhang')).toContainText('停用');
  });

  test('chief：开通师傅账号（真链路 POST → 列表新增行）', async ({ page }) => {
    await login(page, 'chief');
    await page.getByTestId('nav-people').click();
    await expect(page.getByTestId('users-table')).toBeVisible();

    await page.getByTestId('user-create-btn').click();
    const dialog = page.getByTestId('create-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('create-username').fill(TEST_USER);
    await dialog.getByTestId('create-realname').fill('E2E测试师傅');
    await dialog.getByTestId('create-password').fill('E2ePassw0rd');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/admin/users') && r.status() === 201),
      dialog.getByTestId('create-submit').click(),
    ]);
    await expect(dialog).toBeHidden();

    const table = page.getByTestId('users-table');
    await expect(table).toContainText(TEST_USER);
    await expect(table).toContainText('E2E测试师傅');
  });

  test('chief：停用 → 启用真链路（二次确认，状态 tag 翻转）', async ({ page }) => {
    await login(page, 'chief');
    await page.getByTestId('nav-people').click();
    await expect(page.getByTestId('users-table')).toBeVisible();

    // 停用（demo 口径：确认弹窗提示停用后无法登录、操作写审计）
    await page.getByTestId(`user-toggle-${TEST_USER}`).click();
    await page.getByRole('button', { name: '确认停用' }).click();
    await expect(page.getByTestId(`user-status-${TEST_USER}`)).toContainText('停用');

    // 启用恢复（测试账号不留停用态，避免影响后续用例库）
    await page.getByTestId(`user-toggle-${TEST_USER}`).click();
    await page.getByRole('button', { name: '确认启用' }).click();
    await expect(page.getByTestId(`user-status-${TEST_USER}`)).toContainText('启用');
  });
});
