/**
 * TK-24 记录管理 E2E（desktop-admin 项目，PC 视口 :5174）—— F6-01「查看 / 导出 / 批注」的
 * **客户端半边**（接口半边由 apps/api admin-records.spec.ts supertest 覆盖，F6-01-T1）：
 * - chief 登录 → 记录管理页列表渲染（真实种子 D-1~D-10）、状态筛选生效、行点击开详情抽屉
 *   （基本信息 + 标红项 + 十板块读数）；
 * - 批注链路真链路：写批注 → 保存 → 详情与列表回读 chief_note → 清除（空文本提交）；
 *   留痕半边（audit record.annotate）由接口层用例断言，本文件不重复；
 * - 导出：点击导出按钮等待下载事件（真链路 CSV 附件），校验下载文件名形如 records-*.csv。
 *
 * 走真实后端（不 mock 服务端行为，比照 admin-shell.spec）。前置：MySQL 已灌种子、shared 已构建。
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

test.describe('TK-24 记录管理（客户端半边）', () => {
  test('chief：列表渲染 + 状态筛选 + 详情抽屉（标红项/读数）', async ({ page }) => {
    await login(page, 'chief');

    const table = page.getByTestId('records-table');
    await expect(table).toBeVisible();
    // 种子 D-1~D-10 共 10 行；首行（倒序）为最近班次 D-1
    await expect(table.locator('tbody tr')).toHaveCount(10);

    // 状态筛选：objection → 种子仅 D-2 一行（异议单）
    await page.getByTestId('filter-status').click();
    await page.getByRole('option', { name: '有异议' }).click();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/records?') && r.status() === 200),
      page.getByTestId('filter-apply').click(),
    ]);
    await expect(table.locator('tbody tr')).toHaveCount(1);

    // 重置回默认（近 30 天）→ 详情抽屉：首行打开
    await page.getByTestId('filter-reset').click();
    await expect(table.locator('tbody tr')).toHaveCount(10);
    await table.locator('tbody tr').first().click();
    const drawer = page.getByTestId('detail-drawer');
    await expect(drawer).toBeVisible();
    // 交班人列形如「X → Y」，抽屉标题含交接单号（HB- 前缀，技术方案 §4.2 格式）
    await expect(drawer).toContainText(/HB-\d{8}-001/);
    // 种子 D-1 待确认单标红齐全（高压配电异常 + 交接事项两条）→ 标红区可见
    await expect(drawer.getByText(/标红确认项/)).toBeVisible();
    await drawer.locator('.el-drawer__close-btn').click();
    await expect(drawer).toBeHidden();
  });

  test('chief：批注写入 → 详情/列表回读 → 空文本清除（真链路 annotate）', async ({ page }) => {
    await login(page, 'chief');
    const table = page.getByTestId('records-table');
    await expect(table.locator('tbody tr')).toHaveCount(10);

    // 打开首行（D-1）写批注
    await table.locator('tbody tr').first().click();
    const drawer = page.getByTestId('detail-drawer');
    await expect(drawer).toBeVisible();
    await drawer.getByTestId('annotate-btn').click();

    const dialog = page.getByTestId('annotate-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('annotate-input').fill('E2E 批注：请核实水表底数');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/annotation') && (r.status() === 200 || r.status() === 201),
      ),
      dialog.getByTestId('annotate-save').click(),
    ]);
    // 详情回读
    await expect(drawer.getByTestId('chief-note')).toContainText('E2E 批注：请核实水表底数');

    // 列表批注列回读（保存后列表已刷新）
    await expect(table.locator('tbody tr').first()).toContainText('E2E 批注：请核实水表底数');

    // 清除：批注输入框置空提交 → chief_note 回 null
    await drawer.getByTestId('annotate-btn').click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('annotate-input').fill('');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/annotation') && (r.status() === 200 || r.status() === 201),
      ),
      dialog.getByTestId('annotate-save').click(),
    ]);
    await expect(drawer.getByTestId('chief-note')).toContainText('暂无批注');
  });

  test('chief：导出按钮触发 CSV 下载（真链路附件）', async ({ page }) => {
    await login(page, 'chief');
    await expect(page.getByTestId('records-table')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('records-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^records-.*\.csv$/);
  });
});
