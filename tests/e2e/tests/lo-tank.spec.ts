/**
 * TK-09 液氧板块专项 E2E —— 挂钩台账用例 **DATA-03-T1 / DATA-13-T1 / DATA-13-T2**。
 *
 * 覆盖：
 * - DATA-03-T1：选择使用罐号 1 号 → 液氧卡片标题动态「在用/备用」——卡内两罐读数行标签
 *   （demo v0.3 验收形态：`lbl_t1_830`/`lbl_t2_830` 随选切换）+ 首页液氧两卡标题后缀
 *   （台账 DATA-03「卡片标题随选择动态显示」字面口径）；8:30 卡选择后 20:30 卡同步跟随
 *   （同一 records 列 tank_in_use）。
 * - DATA-13-T1/T2（**客户端半边**）：填写液氧读数 → 测量时刻自动写入且随草稿持久化；
 *   刷新重开后时间戳幸存（离线本机时间戳，T2 前半句）。**服务端「原样落库、不被同步
 *   时刻覆盖」（T2 后半句）挂 TK-12 supertest 复验**（层级口径见 records-lo.spec.ts 头注）。
 *
 * **不 import @handover/shared**（E2E 是契约的外部观察者；与 section-fill.spec.ts 同理由）。
 * 前置：MySQL 已灌种子（D0 留空）、shared 已构建。详见 playwright.config.ts。
 */
import { test, expect, type Page } from '@playwright/test';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';

/** MySQL DATETIME 字面量同形（shared localMeasuredAt 产出；外部观察者按格式断言） */
const STAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

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

/** 打开液氧 8:30 卡并选择在用罐号（1 号 / 2 号） */
async function selectTank(page: Page, tankNo: 1 | 2): Promise<void> {
  await page
    .locator('[data-testid="input-tank_in_use"] .van-radio')
    .filter({ hasText: `${tankNo} 号罐` })
    .click();
}

test.describe('DATA-03-T1：使用罐号枚举驱动液氧卡片标题「在用/备用」', () => {
  test('选 1 号罐 → 1 号「在用」、2 号「备用」；首页两卡标题同步；未选时无后缀', async ({
    page,
  }) => {
    await login(page);

    // 未选罐号：行标签为字典原值，无「在用/备用」字样（首页标题亦无后缀）
    await expect(page.getByTestId('card-title-lo_am')).toHaveText('液氧站（早）');
    await page.getByTestId('task-card-lo_am').click();
    await expect(page.locator('[data-field-name="t1_c830"]')).toContainText('1号液氧罐8:30含量');
    await expect(page.locator('[data-field-name="t1_c830"]')).not.toContainText('在用');

    // 选择 1 号罐 → 卡内两罐行标签立即切换（demo v0.3 验收形态）
    await selectTank(page, 1);
    await expect(page.locator('[data-field-name="t1_c830"]')).toContainText(
      '1号液氧罐8:30含量（在用）',
    );
    await expect(page.locator('[data-field-name="t2_c830"]')).toContainText(
      '2号液氧罐8:30含量（备用）',
    );
    await expect(page.locator('[data-field-name="t1_c830"]')).not.toContainText('备用');

    // 返回首页 → 两张液氧卡标题均带动态后缀（DATA-03「卡片标题」字面口径）；其他卡不受影响
    await page.getByTestId('back-to-today').click();
    await expect(page.getByTestId('card-title-lo_am')).toHaveText('液氧站（早） · 1号在用');
    await expect(page.getByTestId('card-title-lo_pm')).toHaveText('液氧站（晚） · 1号在用');
    await expect(page.getByTestId('card-title-water')).toHaveText('表房');

    // 20:30 卡同步跟随（同一 records 列 tank_in_use，草稿跨卡可见）；
    // tank_in_use 控件只在 8:30 卡（lo_pm 字典无此字段），切换罐号须回 8:30 卡操作
    await page.getByTestId('task-card-lo_pm').click();
    await expect(page.locator('[data-field-name="t1_c2030"]')).toContainText('（在用）');
    await expect(page.locator('[data-field-name="t2_c2030"]')).toContainText('（备用）');
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('task-card-lo_am').click();
    await selectTank(page, 2);
    await expect(page.locator('[data-field-name="t1_c830"]')).toContainText('（备用）');
    await expect(page.locator('[data-field-name="t2_c830"]')).toContainText('（在用）');
    await page.getByTestId('back-to-today').click();
    await expect(page.getByTestId('card-title-lo_am')).toHaveText('液氧站（早） · 2号在用');
  });
});

test.describe('DATA-13-T1/T2（客户端半边）：填写液氧读数自动记录实际测量时刻', () => {
  test('写 8:30/20:30 读数 → 各自时点时刻自动出现；刷新重开后时间戳幸存（离线本机时间戳）', async ({
    page,
  }) => {
    await login(page);

    // 8:30 卡：写任一 830 读数 → lo_measured_am 自动钉时刻；未填时该派生行只显说明
    // 文字、无时刻（hint 分支无值占位，用“不含时间戳”断言）。
    // 观察点边界：lo_measured_am 行只在 8:30 卡、lo_measured_pm 行只在 20:30 卡（卡片→字段
    // 映射切分），两时点互不覆盖在各自卡上断言
    await page.getByTestId('task-card-lo_am').click();
    await expect(page.getByTestId('value-lo_measured_am')).not.toContainText(STAMP);
    await page.getByTestId('input-t1_c830').locator('input').fill('12.5');
    await expect(page.getByTestId('value-lo_measured_am')).toContainText(STAMP);
    const amStamp = (await page.getByTestId('value-lo_measured_am').innerText()).trim();

    // 20:30 卡：写 2030 读数 → lo_measured_pm 独立钉时刻（与 8:30 时点互不覆盖）
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('task-card-lo_pm').click();
    await expect(page.getByTestId('value-lo_measured_pm')).not.toContainText(STAMP);
    await page.getByTestId('input-t1_c2030').locator('input').fill('8.2');
    await expect(page.getByTestId('value-lo_measured_pm')).toContainText(STAMP);

    // T2 客户端半边：等待落盘 → 刷新重开（IndexedDB 恢复，离线场景同通道）→ 本机时间戳不被重置
    await expect(page.getByTestId('draft-saved')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('card-list')).toBeVisible(); // 恢复完成（F1-09 同步点）
    await page.getByTestId('task-card-lo_pm').click();
    await expect(page.getByTestId('value-lo_measured_pm')).toContainText(STAMP);
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('task-card-lo_am').click();
    await expect(page.getByTestId('value-lo_measured_am')).toHaveText(amStamp);
  });

  test('清空读数不回收已记录时刻（保留已发生的真实测量）；非液氧读数不触发', async ({ page }) => {
    await login(page);

    // 对照组：水卡读数（非液氧）→ 无任何测量时刻联动
    await page.getByTestId('task-card-water').click();
    await page.getByTestId('input-water_reading').locator('input').fill('49239');
    await expect(page.getByTestId('value-lo_measured_am')).toHaveCount(0);

    // 液氧 8:30 卡：先写后清 → 时刻保留（清空只移除读数，不伪造"未测量"）
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('task-card-lo_am').click();
    await page.getByTestId('input-t2_c830').locator('input').fill('15.9');
    await expect(page.getByTestId('value-lo_measured_am')).toContainText(STAMP);
    await page.getByTestId('input-t2_c830').locator('input').fill('');
    await expect(page.getByTestId('value-lo_measured_am')).toContainText(STAMP);
  });
});
