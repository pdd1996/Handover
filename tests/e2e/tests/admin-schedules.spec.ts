/**
 * TK-26 排班管理 E2E（desktop-admin 项目，PC 视口 :5174）—— F6-03「科长维护最小排班表」
 * 的**客户端半边**（接口半边由 apps/api admin-schedules.spec.ts supertest 覆盖，F6-03-T1）：
 * - 人员与排班页排班月视图渲染（当月逐日骨架 + 种子排班行；上/下月翻页）；
 * - 改派真链路：行内下拉改值班师傅 → PUT /admin/schedules → 成功提示（改即审计）→
 *   月视图刷新为新人选；随后还原当日排班（测试不留改派态）。
 *
 * 走真实后端（不 mock 服务端行为，比照 admin-users.spec）。改派对象选**当日**（D0，
 * 恒在当月视图内且种子必有排班），起始人选中即时记录、用例末还原，避免残留影响后续用例。
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Handover@2026';

/** 本地墙钟日（YYYY-MM-DD）：与 api 的 SHIFT_TIMEZONE 同机同区，恒一致 */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 后台登录（真链路）：填账密 → 提交 → 等登录响应（admin-users.spec 同式） */
async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/auth/login') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
}

/** 行内下拉改派：打开下拉 → 点目标人选 → 等 PUT 成功与月视图刷新 */
async function changeSchedule(page: Page, dutyDate: string, targetName: string): Promise<void> {
  const select = page.getByTestId(`schedule-select-${dutyDate}`);
  const putDone = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v1/admin/schedules') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
  );
  await select.click();
  await page
    .locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: targetName })
    .first()
    .click();
  await putDone;
  await page.waitForResponse(
    (r) => r.url().includes('/api/v1/admin/schedules?month=') && r.status() === 200,
  );
}

test.describe('TK-26 排班管理（客户端半边）', () => {
  test.describe.configure({ mode: 'serial' });

  test('chief：排班月视图渲染（当月骨架、种子排班行、上/下月翻页）', async ({ page }) => {
    await login(page, 'chief');
    await page.getByTestId('nav-people').click();

    const card = page.getByTestId('schedule-card');
    await expect(card).toBeVisible();
    const today = localToday();
    const monthLabel = page.getByTestId('schedule-month-label');
    await expect(monthLabel).toHaveText(`${today.slice(0, 4)} 年 ${Number(today.slice(5, 7))} 月`);

    // 当月逐日骨架：当日行存在且有排班（种子 D-14~D+7 覆盖当日；值班人下拉已选中某人，
    // el-select 的选中值渲染在 selected-item span 而非 input value）
    const todaySelect = page.getByTestId(`schedule-select-${today}`);
    await expect(todaySelect).toBeVisible();
    await expect(todaySelect).toContainText('师傅');

    // 翻页：下月 → 标签 +1；远期无排班日（+2 月末，必在种子 D+7 之外）显示「未排班」
    await page.getByTestId('schedule-next').click();
    await expect(monthLabel).not.toHaveText(
      `${today.slice(0, 4)} 年 ${Number(today.slice(5, 7))} 月`,
    );
    await page.getByTestId('schedule-next').click();
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const plus2 = new Date(Date.UTC(y, m + 2, 0)); // m 为 1-based：Date.UTC 月份参数传 m+2 即 +2 月末（UTC 日历算术）
    const farDay = `${plus2.toISOString().slice(0, 7)}-${String(plus2.getUTCDate()).padStart(2, '0')}`;
    await expect(page.getByTestId(`schedule-select-${farDay}`)).toContainText('未排班');
    await page.getByTestId('schedule-prev').click();
    await page.getByTestId('schedule-prev').click();
    await expect(monthLabel).toHaveText(`${today.slice(0, 4)} 年 ${Number(today.slice(5, 7))} 月`);
  });

  test('chief：改派当日排班（真链路 PUT → 提示写审计 → 视图刷新）并还原', async ({ page }) => {
    await login(page, 'chief');
    await page.getByTestId('nav-people').click();
    const today = localToday();
    const todaySelect = page.getByTestId(`schedule-select-${today}`);
    await expect(todaySelect).toBeVisible();

    // 记录起始人选（用例末还原，测试不留改派态）；换给另一位种子师傅
    const original = ((await todaySelect.textContent()) ?? '').trim();
    const target = original.includes('李师傅') ? '张师傅' : '李师傅';

    await changeSchedule(page, today, target);
    // demo 口径成功提示：改即审计 + 次日带出生效
    await expect(page.locator('.el-message')).toContainText('审计已记录');
    await expect(todaySelect).toContainText(target);

    // 还原起始人选（再走一次真链路，等 PUT 200 即可）
    const putDone = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/admin/schedules') &&
        r.request().method() === 'PUT' &&
        r.status() === 200,
    );
    await todaySelect.click();
    await page
      .locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: original })
      .first()
      .click();
    await putDone;
    await expect(todaySelect).toContainText(original);
  });
});
