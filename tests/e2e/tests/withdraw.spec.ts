/**
 * TK-21 撤回窗口 E2E —— 挂钩台账用例 **F2-09-T1（客户端半边）**。
 *
 * 层级说明（比照 submit-preview.spec.ts「提交入口状态机」先例）：服务端判据（撤回转 draft、
 * 清 submitted_at、审计留痕、三不可撤 409 + reason、待确认入口消失、重提 version+1）已由接口层
 * `apps/api/src/records/records-withdraw.spec.ts` supertest 全量锁定（8/8）；本文件覆盖**客户端半边**：
 * - F2-09-T1：提交后首页显示撤回入口 + **剩余倒计时**，倒计时与 10 分钟窗口一致（mm:ss）；
 * - F2-08 客户端：点击撤回 → 成功 toast → 状态回 draft、提交入口重现（撤回回到可编辑）。
 *
 * 用 route 拦 GET /records/today 构造「刚提交」态（submitted_at=当下、withdraw_window_minutes=10），
 * 避免真实写库与并行 spec 的「当日无记录」断言竞争（正式链路 E2E 随 TK-31 全量回归统一接）；
 * 撤回后翻转 mock 为 draft，演示客户端状态环路。最小 TodayDto 的 cards 为空（容器零高度会被判
 * hidden），改用 record-status 作渲染锚点（同 submit-preview 先例）。
 *
 * **不 import @handover/shared**（E2E 是契约的外部观察者）。
 * 前置：MySQL 已灌种子、shared 已构建。详见 playwright.config.ts。
 */
import { test, expect, type Page } from '@playwright/test';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';

/**
 * 本地时间戳 'YYYY-MM-DD HH:mm:ss'（E2E 不 import shared，内联与 localMeasuredAt 同式）。
 * 浏览器与 Node 同机同时钟，submitted_at 取当下即令倒计时从满窗口起算。
 */
function localTs(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 最小 TodayDto（route 拦 GET /records/today 用，不写库）；含 withdraw_window_minutes（TK-21） */
function todayBody(opts: {
  status: string;
  submittedAt: string | null;
  windowMinutes: number;
}): string {
  return JSON.stringify({
    duty_date: '2026-09-12',
    shift_start_time: '08:30',
    withdraw_window_minutes: opts.windowMinutes,
    record: {
      id: 1,
      record_no: 'HB-E2E-TK21-01',
      status: opts.status,
      version: 1,
      submitted_at: opts.submittedAt,
    },
    pending_sync: false,
    submitter: { id: 1, real_name: '张师傅' },
    receiver: { id: 4, real_name: '李师傅' },
    progress: { filled: 0, total: 0, pending: 0, abnormal: 0 },
    sections: [],
    cards: [],
  });
}

/** 登录（route 已拦 GET /today；用 record-status 作锚点，最小 TodayDto 的 card-list 零高度） */
async function loginWithMock(page: Page, username = 'zhang'): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').locator('input').fill(username);
  await page.getByTestId('login-password').locator('input').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/records/today') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
  await expect(page.getByTestId('record-status')).toBeVisible();
}

test.describe('F2-09-T1（客户端半边）：撤回入口倒计时与窗口一致', () => {
  test('刚提交 → 撤回入口显示剩余倒计时（≈10 分钟窗口）；点击撤回 → 回 draft、提交入口重现', async ({
    page,
  }) => {
    // 撤回后翻转 mock：submitted → draft（演示客户端状态环路，F2-08「回到可编辑」）
    let withdrawn = false;
    await page.route('**/api/v1/records/today', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: withdrawn
          ? todayBody({ status: 'draft', submittedAt: null, windowMinutes: 10 })
          : todayBody({ status: 'submitted', submittedAt: localTs(new Date()), windowMinutes: 10 }),
      }),
    );
    // 撤回端点：回 201 draft（服务端行为由 supertest 锁定，见文件头层级说明）；置 withdrawn
    // 令后续 GET /today 翻为 draft，演示客户端状态环路（撤回 → loadToday → 提交入口重现）
    let withdrawCalled = 0;
    await page.route('**/api/v1/records/today/withdraw', (route) => {
      withdrawCalled += 1;
      withdrawn = true;
      void route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 1,
          record_no: 'HB-E2E-TK21-01',
          status: 'draft',
          version: 1,
        }),
      });
    });

    await loginWithMock(page);
    await expect(page.getByTestId('record-status')).toContainText('已提交');

    // F2-09-T1 核心：撤回入口可见 + 剩余倒计时（mm:ss），与 10 分钟窗口一致
    await expect(page.getByTestId('withdraw-open')).toBeVisible();
    const countdown = page.getByTestId('withdraw-countdown');
    await expect(countdown).toBeVisible();
    // 刚提交 → 剩余应贴近满窗口：10:00 或 09:5x（截断到秒 + 首次 tick 的至多 1 秒误差）
    await expect(countdown).toHaveText(/^(10:00|09:5\d)$/);
    // 提示文案含窗口值（服务端回传 withdraw_window_minutes，两端同源）
    await expect(page.getByTestId('withdraw-hint')).toContainText('10 分钟');

    // 点击撤回 → 成功 toast → 重取首页（mock 翻 draft）→ 提交入口重现、撤回入口消失（F2-08）
    await page.getByTestId('withdraw-open').click();
    await expect(page.locator('.van-toast')).toContainText('已撤回');
    expect(withdrawCalled).toBe(1);
    await expect(page.getByTestId('record-status')).toContainText('草稿');
    await expect(page.getByTestId('submit-open')).toBeVisible();
    await expect(page.getByTestId('withdraw-open')).toHaveCount(0);
  });

  test('窗口已过（submitted_at 早于窗口）→ 撤回入口不显示（前端倒计时到期自动隐藏）', async ({
    page,
  }) => {
    // submitted_at = 30 分钟前，窗口 10 分钟 → 截止时刻已过 → canWithdraw=false（服务端仍权威复校）
    const stale = localTs(new Date(Date.now() - 30 * 60000));
    await page.route('**/api/v1/records/today', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: todayBody({ status: 'submitted', submittedAt: stale, windowMinutes: 10 }),
      }),
    );
    await loginWithMock(page);
    await expect(page.getByTestId('record-status')).toContainText('已提交');
    // 提交入口隐藏（已提交），撤回入口亦隐藏（窗口已过）——走异议流程，无前端撤回入口
    await expect(page.getByTestId('submit-open')).toHaveCount(0);
    await expect(page.getByTestId('withdraw-open')).toHaveCount(0);
  });
});
