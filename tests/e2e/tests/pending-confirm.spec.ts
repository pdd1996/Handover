/**
 * TK-18 待确认入口与逐项浏览 E2E —— 挂钩台账用例 F2-02-T1
 * （《测试用例清单》将 F2-02-T1 标为 **E2E 层级**；接口半边见
 * `apps/api/src/records/records-pending.spec.ts`，F2-03-T1 判据在该文件以接口层断言，
 * 本文件补 UI 半边：入口醒目性、置顶高亮与逐项浏览的可交互性）。
 *
 * **断言策略：UI 与接口响应逐一对照**（同 today.spec.ts）——入口计数取
 * GET /records/pending 的真实响应比对，非硬编码期望值；本文件全部为只读浏览链路，
 * 不涉及提交类状态竞争，直接走真后端与真种子（D-1 待确认单，接收人=王师傅）。
 *
 * **不 import @handover/shared**：同 today.spec.ts 的外部观察者定位。
 *
 * 前置：MySQL 已灌种子（D-1 待确认单）、shared 已构建。详见 playwright.config.ts。
 */
import { test, expect, type Page } from '@playwright/test';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';

/** GET /records/pending 响应的最小局部类型（只声明本文件断言所需字段） */
interface PendingItem {
  id: number;
  record_no: string;
  duty_date: string;
  status: string;
  submitter: { real_name: string };
  alert_count: number;
}

/** 登录并进入首页（登录响应本身即建立会话，Cookie 由浏览器上下文持有） */
async function loginAs(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').locator('input').fill(username);
  await page.getByTestId('login-password').locator('input').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/records/today') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
  await expect(page.getByTestId('card-list')).toBeVisible();
}

test.describe('F2-02-T1：接班人登录 → 首页醒目"有 N 份交接单待确认"入口', () => {
  test('入口可见、文案计数与接口实际一致（UI == 服务端数据）', async ({ page }) => {
    await loginAs(page, 'wang'); // 种子 D-1 待确认单的接班人

    // 接口实际值（登录后 Cookie 共享，page.request 同上下文）
    const res = await page.request.get('/api/v1/records/pending');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: PendingItem[] };
    expect(body.items.length).toBeGreaterThan(0); // 种子 D-1 待确认单
    expect(body.items.every((i) => i.status === 'submitted')).toBe(true);

    // 判据「醒目入口 + N 与实际一致」：入口可见且文案计数取接口真实值
    const entry = page.getByTestId('pending-entry');
    await expect(entry).toBeVisible();
    await expect(entry).toContainText(`有 ${body.items.length} 份交接单待确认`);
  });

  test('无待确认单的师傅登录 → 不出现入口（不误导）', async ({ page }) => {
    await loginAs(page, 'zhang'); // 种子中无以其为 receiver 的 submitted 记录
    await expect(page.getByTestId('pending-entry')).toHaveCount(0);
  });

  test('入口 → 列表 → 详情逐项浏览 → 返回，全链路可交互', async ({ page }) => {
    await loginAs(page, 'wang');
    await page.getByTestId('pending-entry').click();
    await expect(page.getByTestId('pending-list')).toBeVisible();

    // 列表项与接口一一对应（有标红的单显示标红数角标）
    const pendingRes = await page.request.get('/api/v1/records/pending');
    const pendingBody = (await pendingRes.json()) as { items: PendingItem[] };
    const first = pendingBody.items[0]!;
    const item = page.getByTestId(`pending-item-${first.record_no}`);
    await expect(item).toBeVisible();
    await expect(item).toContainText(first.submitter.real_name);
    if (first.alert_count > 0) {
      await expect(item).toContainText(`标红 ${first.alert_count} 项`);
    }

    // 打开详情：标红项置顶区（F2-03-T1 UI 半边），首位为高等级且数量与接口一致
    await item.click();
    await expect(page.getByTestId('detail-navbar')).toBeVisible();
    const alertItems = page.locator('[data-testid^="alert-item-"]');
    await expect(alertItems).toHaveCount(first.alert_count);
    if (first.alert_count > 0) {
      await expect(alertItems.first()).toHaveAttribute('data-level', /high|mid/);
      await expect(page.getByTestId('alert-top')).toBeVisible();
    }

    // 逐项浏览：板块读数与电梯核对明细可见
    await expect(page.getByTestId('detail-section-1')).toBeVisible();
    await expect(page.getByTestId('elevator-checks')).toBeVisible();

    // 返回链路：详情 → 列表 → 首页
    await page.getByTestId('detail-back').click();
    await expect(page.getByTestId('pending-list')).toBeVisible();
    await page.getByTestId('confirm-navbar').locator('.van-nav-bar__left').click();
    await expect(page.getByTestId('card-list')).toBeVisible();
  });
});
