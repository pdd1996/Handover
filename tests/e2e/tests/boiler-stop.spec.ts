/**
 * TK-10 锅炉停机联动 E2E —— 挂钩台账用例 **DATA-05-T1（客户端半边）**。
 *
 * 覆盖（PRD 附录 A 五「停机时置灰不填」+ 判据「停机列留空且提交通过」）：
 * - 置灰：boiler_run ≠ 'run'（未选/停机）→ 锅炉号/出水/回水温度三行禁填
 *   （data-field-disabled + 控件 disabled）+「选运行后填」标记；含**真禁用断言**（m4）：
 *   vant Checker 根节点 `.van-radio--disabled` 计数 + 强点禁用项无选中态
 *   （[aria-checked="true"] 计数为 0）——摘掉 radio-group 的 :disabled 此断言即红，
 *   不再只信自维护的 data-field-disabled；
 * - 停机列留空：先填出水温度再改「停机」→ 残留值被清空（草稿清键，非仅禁用）；
 * - 提交放行：停机 + 状态正常 → 「完成本卡」无报错点名、回到首页（校验引擎停机不把
 *   三项计入必填；服务端同口径复验挂 TK-12 supertest，层级说明见 records-boiler.spec.ts）；
 * - 反向联动：改选「运行」→ 三行恢复可填且转必填，缺项完成 → 点名面板出现出水温度；
 *   再改「停机」→ 清列后报错面板按清列后状态**整体重算收起**（m3：C-09 清单与实际
 *   一致，无需二次点击）。
 *
 * **不 import @handover/shared**（E2E 是契约的外部观察者；与 lo-tank.spec.ts 同理由）。
 * 前置：MySQL 已灌种子（D0 留空）、shared 已构建。详见 playwright.config.ts。
 */
import { test, expect, type Page } from '@playwright/test';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';

async function login(page: Page, username = 'zhang'): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').locator('input').fill(username);
  await page.getByTestId('login-password').locator('input').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/records/today') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
  await expect(page.getByTestId('card-list')).toBeVisible();
}

/** 锅炉卡内点选「锅炉是否运行」单选（运行 / 停机） */
async function selectBoilerRun(page: Page, label: '运行' | '停机'): Promise<void> {
  await page
    .locator('[data-testid="input-boiler_run"] .van-radio')
    .filter({ hasText: label })
    .click();
}

/** 三行置灰态断言：data-field-disabled + 出水温度控件 disabled/enabled + radio 真禁用（m4） */
async function expectGatedDisabled(page: Page, disabled: boolean): Promise<void> {
  const want = disabled ? 'true' : 'false';
  for (const name of ['boiler_no', 'supply_temp', 'return_temp']) {
    await expect(page.locator(`[data-testid="field-${name}"]`)).toHaveAttribute(
      'data-field-disabled',
      want,
    );
  }
  const input = page.getByTestId('input-supply_temp').locator('input');
  const group = page.getByTestId('input-boiler_no');
  if (disabled) {
    await expect(input).toBeDisabled();
    // 真禁用断言（vant Checker：根节点 class `van-radio--disabled` + aria-checked 属性）：
    // 强点禁用项不产生选中态——若有人摘掉 radio-group 的 :disabled，此断言即红
    await expect(group.locator('.van-radio--disabled')).toHaveCount(2);
    await group.locator('.van-radio').first().click({ force: true });
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(0);
  } else {
    await expect(input).toBeEnabled();
    await expect(group.locator('.van-radio--disabled')).toHaveCount(0);
  }
}

test.describe('DATA-05-T1（客户端半边）：锅炉停机 → 三项置灰不填、停机列留空、提交放行', () => {
  test('未选/停机 → 置灰 +「选运行后填」标记；先填后改停机 → 残留清空；完成放行回首页', async ({
    page,
  }) => {
    await login(page);
    await page.getByTestId('task-card-boiler').click();

    // 未选运行/停机：三行即置灰（与必填口径同门——仅 'run' 时才可能填）
    await expectGatedDisabled(page, true);
    await expect(page.locator('[data-testid="field-boiler_no"]')).toContainText('选运行后填');

    // 运行时置灰解除（对照组），先填出水温度制造残留
    await selectBoilerRun(page, '运行');
    await expectGatedDisabled(page, false);
    await expect(page.locator('[data-testid="field-boiler_no"]')).not.toContainText('停机不填');
    await page.getByTestId('input-supply_temp').locator('input').fill('65.5');

    // 改选停机 → 残留清空（置灰且值为空，判据「停机列留空」），三项回到禁填
    await selectBoilerRun(page, '停机');
    await expectGatedDisabled(page, true);
    await expect(page.getByTestId('input-supply_temp').locator('input')).toHaveValue('');
    await expect(page.locator('[data-testid="field-supply_temp"]')).toContainText('选运行后填');

    // 停机 + 状态正常 → 完成本卡放行：无报错点名面板，回到首页
    await page
      .locator('[data-testid="input-boiler_status"] .van-radio')
      .filter({ hasText: '正常' })
      .click();
    await page.getByTestId('complete-card').click();
    await expect(page.getByTestId('section-error-panel')).toHaveCount(0);
    await expect(page.getByTestId('card-list')).toBeVisible();
  });

  test('反向联动：改选运行 → 三项恢复可填且转必填，缺项完成 → 点名面板出现出水温度', async ({
    page,
  }) => {
    await login(page);
    await page.getByTestId('task-card-boiler').click();

    await selectBoilerRun(page, '运行');
    await expectGatedDisabled(page, false);
    await page
      .locator('[data-testid="input-boiler_status"] .van-radio')
      .filter({ hasText: '正常' })
      .click();

    // 运行 + 三项未填 → 完成 → 拦截并点名（必填校验随联动恢复）
    await page.getByTestId('complete-card').click();
    await expect(page.getByTestId('section-error-panel')).toBeVisible();
    await expect(page.getByTestId('error-item-supply_temp')).toBeVisible();

    // 改选停机 → 清列后报错面板按清列后状态重算收起（m3：C-09 清单与实际一致，无需二次点击）
    await selectBoilerRun(page, '停机');
    await expect(page.getByTestId('section-error-panel')).toHaveCount(0);
    await page.getByTestId('complete-card').click();
    await expect(page.getByTestId('card-list')).toBeVisible();
  });
});
