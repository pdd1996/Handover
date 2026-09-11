/**
 * TK-06 板块填写页与校验 E2E —— 挂钩台账用例 **F1-08-T1 / F1-08-T3**
 * （《测试用例清单》层级 E2E；接口层语义的 F1-08-T2 / DATA-01-T1 见
 * `apps/api/src/records/records-validation.spec.ts`，TK-12 submit 端点落地后以 supertest 复验）。
 *
 * 覆盖：
 * - F1-08-T1：缺必填点「完成本卡」→ 阻止 + 缺失字段清单逐条点名（C-09）+ 点击跳转可达
 * - F1-08-T3：遍历各板块，数值字段旁单位全程标注，且与附录 A 一致
 * - 多选控件交互回归（TK-06 评审 M1）：勾选/取消写入草稿、全不勾回退未填——
 *   此前 E2E 仅对 radio/input/完成按钮有交互，多选（checkbox）零覆盖，
 *   导致 `as string[]` 类型断言的运行时崩溃（value.push is not a function）未被发现
 * - 附带验证 TK-06 的实时角标链路：卡内填齐 → 完成返回首页 → 角标转「已填」（F1-03 同源口径）
 *
 * **不 import @handover/shared**（与 today.spec.ts 同理由）：E2E 是契约的外部观察者；
 * 单位期望值取自 PRD 附录 A / shared 字段字典的快照，字典改动时本文件以可读失败暴露。
 *
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

test.describe('F1-08-T1：缺必填 → 阻止并定位到该必填项（C-09 点名 + 跳转可达）', () => {
  test('高配房卡不填直接完成 → 拦截并逐条点名，点击清单项跳转定位', async ({ page }) => {
    await login(page);
    await page.getByTestId('task-card-electricity').click();
    await expect(page.getByTestId('section-navbar')).toContainText('高配房');

    // 不填任何值，直接点「完成本卡」→ 本地校验拦截
    await page.getByTestId('complete-card').click();
    const panel = page.getByTestId('section-error-panel');
    await expect(panel).toBeVisible();

    // 判据「缺失字段清单逐条点名」：三个必填（e1/e2 读数 + 高配房状态）逐条列出，含中文 label
    // （分母与接口 required 口径一致：e_use 为 auto 派生列、hp_note 未触发，均不进点名清单）
    expect(Number(await panel.getAttribute('data-error-count'))).toBe(3);
    for (const name of ['e1_reading', 'e2_reading', 'hp_status']) {
      await expect(panel.getByTestId(`error-item-${name}`)).toBeVisible();
    }
    await expect(panel).toContainText('高配房是否正常');
    await expect(page.getByTestId('error-message')).toContainText('3 项必填未填');

    // 判据「点击跳转可达（C-09）」：点击点名项 → 目标字段进入视口并临时高亮
    await page.getByTestId('error-item-hp_status').click();
    await expect(page.locator('#sec-2-hp-status')).toBeInViewport();
    await expect(page.locator('#sec-2-hp-status')).toHaveClass(/field-row-focus/);
  });

  test('逐条补齐后完成 → 拦截解除，返回首页且该卡角标转「已填」', async ({ page }) => {
    await login(page);
    await page.getByTestId('task-card-electricity').click();

    await page.getByTestId('input-e1_reading').locator('input').fill('19950');
    await page.getByTestId('input-e2_reading').locator('input').fill('15900');
    await page
      .locator('[data-testid="input-hp_status"] .van-radio')
      .filter({ hasText: '正常' })
      .click();

    // 报错面板消失（此前未触发校验，先点一次完成确认通过并返回首页）
    await page.getByTestId('complete-card').click();
    await expect(page.getByTestId('section-error-panel')).toHaveCount(0);
    await expect(page.getByTestId('card-list')).toBeVisible();

    // 实时角标（F1-03 同源口径 shared computeCardBadge）：电卡三项填齐 → 绿色「已填」
    const badge = page.getByTestId('card-badge-electricity');
    await expect(badge).toHaveAttribute('data-tone', 'done');
    await expect(badge).toHaveText('已填');
  });

  test('液氧 8:30 卡漏填部分读数 → 点名清单含 2 号罐读数（DATA-01：8 项均必填）', async ({
    page,
  }) => {
    await login(page);
    await page.getByTestId('task-card-lo_am').click();

    // 只填 tank_in_use 与 1 号罐两项读数，2 号罐两项不填
    await page
      .locator('[data-testid="input-tank_in_use"] .van-radio')
      .filter({ hasText: '1 号罐' })
      .click();
    await page.getByTestId('input-t1_c830').locator('input').fill('12.5');
    await page.getByTestId('input-t1_p830').locator('input').fill('0.78');
    await page.getByTestId('complete-card').click();

    const panel = page.getByTestId('section-error-panel');
    await expect(panel).toBeVisible();
    // t2_* 按 DATA-01 归位为恒必填（TK-06 修正 TK-05 的条件必填口径），缺失必须被点名
    await expect(panel.getByTestId('error-item-t2_c830')).toBeVisible();
    await expect(panel.getByTestId('error-item-t2_p830')).toBeVisible();
  });
});

test.describe('F1-08-T1（多选控件交互路径，TK-06 评审 M1 回归）：勾选写入草稿、全不勾回退未填', () => {
  test('新风机房卡：勾选新风使用位置 → 选中生效并过卡内校验；全部取消后重新被点名', async ({
    page,
  }) => {
    await login(page);
    await page.getByTestId('task-card-hvac').click();
    await expect(page.getByTestId('section-navbar')).toContainText('新风机房');
    const group = page.getByTestId('input-hvac_locs');

    // 什么都不填直接完成 → hvac_status 与 hvac_locs 均被点名；
    // hvac_locs 必填是推定口径（❓ 依赖台账待确认清单第 9 项：新风停用季节是否允许全不勾），
    // 定案为可全不勾时，本用例的必填点名断言需同步回改（勾选/取消交互断言不受影响）
    await page.getByTestId('complete-card').click();
    const panel = page.getByTestId('section-error-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('error-item-hvac_locs')).toBeVisible();

    // 勾选两项 → 选中状态生效（M1 修复断言：控件可交互、勾选计数不为 0；
    // Vant 选中类挂在图标元素 van-checkbox__icon--checked），
    // 且该字段报错红框即时清除（writeValue 联动）
    await group.locator('.van-checkbox').filter({ hasText: '手术部' }).click();
    await group.locator('.van-checkbox').filter({ hasText: 'ICU' }).click();
    await expect(group.locator('.van-checkbox__icon--checked')).toHaveCount(2);
    await expect(page.locator('[data-field-name="hvac_locs"]')).not.toHaveClass(/field-row-error/);

    // 状态选「正常」+ 位置已勾 → 补齐后过校验，返回首页角标转「已填」
    await page
      .locator('[data-testid="input-hvac_status"] .van-radio')
      .filter({ hasText: '正常' })
      .click();
    await page.getByTestId('complete-card').click();
    await expect(page.getByTestId('section-error-panel')).toHaveCount(0);
    await expect(page.getByTestId('card-list')).toBeVisible();
    const badge = page.getByTestId('card-badge-hvac');
    await expect(badge).toHaveAttribute('data-tone', 'done');

    // 重开卡片（草稿在会话内保留）→ 全部取消勾选 → 空数组回退为未填，重新被点名
    await page.getByTestId('task-card-hvac').click();
    const groupAgain = page.getByTestId('input-hvac_locs');
    await expect(groupAgain.locator('.van-checkbox__icon--checked')).toHaveCount(2); // 续填不丢值（F1-09 口径）
    await groupAgain.locator('.van-checkbox__icon--checked').first().click();
    await groupAgain.locator('.van-checkbox__icon--checked').first().click();
    await expect(groupAgain.locator('.van-checkbox__icon--checked')).toHaveCount(0);
    await page.getByTestId('complete-card').click();
    await expect(
      page.getByTestId('section-error-panel').getByTestId('error-item-hvac_locs'),
    ).toBeVisible();
  });
});

test.describe('F1-08-T3：数值字段旁单位全程标注，与附录 A 一致', () => {
  /**
   * 数值字段 → 单位（PRD 附录 A / shared fields.ts 快照；E2E 为外部观察者，不 import 字典）。
   * 液氧含量单位 ❓ 随 DATA-12 待核实，现按种子 lo_unit='L' 口径断言。
   */
  const EXPECTED_UNITS: Record<string, string> = {
    water_reading: '吨',
    water_use: '吨',
    e1_reading: '度',
    e2_reading: '度',
    e_use: '度',
    g1_remaining: '立方米',
    g2_remaining: '立方米',
    gas_use: '立方米',
    t1_c830: 'L',
    t1_p830: 'MPa',
    t1_c2030: 'L',
    t1_p2030: 'MPa',
    t2_c830: 'L',
    t2_p830: 'MPa',
    t2_c2030: 'L',
    t2_p2030: 'MPa',
    lo_day_use: 'L',
    lo_night_use: 'L',
    lo_station_press: 'MPa',
    hbo_press: 'MPa',
    b40: '瓶',
    b10: '瓶',
    b6: '瓶',
    b_co2: '瓶',
    b_pulm: '瓶',
    manifold_press: 'MPa',
    co2_out_press: 'MPa',
    supply_temp: '°C',
    return_temp: '°C',
    h1_set_temp: '°C',
    h1_out_temp: '°C',
    h3_set_temp: '°C',
    h3_out_temp: '°C',
    p1_press: 'MPa',
    p1_height: 'm',
    p3_press: 'MPa',
    p3_height: 'm',
  };

  test('遍历各板块：每个数值字段旁单位可见且与附录 A 一致', async ({ page }) => {
    await login(page);
    const cardKeys = await page
      .locator('[data-testid^="task-card-"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.cardKey ?? ''));

    for (const key of cardKeys) {
      await page.getByTestId(`task-card-${key}`).click();
      await expect(page.getByTestId('section-navbar')).toBeVisible();

      const numericNames = await page
        .locator('[data-field-kind="number"]')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.fieldName ?? ''));

      for (const name of numericNames) {
        const row = page.locator(`[data-field-name="${name}"]`);
        // 判据「数值字段旁单位全程显式标注」：单位非空且逐字段与附录 A 一致
        const unit = await row.getAttribute('data-field-unit');
        expect(unit, `字段 ${name}（卡 ${key}）应标注单位`).not.toBe('');
        expect(unit, `字段 ${name}（卡 ${key}）单位应与附录 A 一致`).toBe(EXPECTED_UNITS[name]);
        await expect(row).toContainText(`(${unit})`);
      }

      await page.getByTestId('back-to-today').click();
      await expect(page.getByTestId('card-list')).toBeVisible();
    }
  });

  test('数值输入框启用数字键盘（inputmode=decimal，F1-04 真机走查的自动旁证）', async ({
    page,
  }) => {
    await login(page);
    await page.getByTestId('task-card-water').click();
    await expect(page.getByTestId('input-water_reading').locator('input')).toHaveAttribute(
      'inputmode',
      'decimal',
    );
  });
});
