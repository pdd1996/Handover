/**
 * TK-08 草稿自动保存与续填 E2E —— 挂钩台账用例 **F1-09-T1**
 * （《测试用例清单》层级 E2E：填写中途关闭页面 → 重开 → 草稿恢复可续填，草稿内容与关闭前一致）。
 *
 * 覆盖（清除口径按决策记录 **D-T18 修订 #9**：持久草稿保留至该班次出现已提交记录）：
 * - F1-09-T1 主判据：关闭页面重开恢复 + 恢复提示（PRD §6.1 设计触点）+ **填写期间零服务端写入**
 *   （F1-07-T2「无 draft 泄露」旁证：全程无 /records/today/draft 请求）
 * - F1-09-T1 扩展（TK-08 评审 M4）：**刷新路径**恢复跨卡内容，含 hvac 多选数组与 tank_in_use
 *   number 枚举经 IndexedDB 往返后的选中态（类型保真）
 * - 清除口径回归（TK-08 评审 M1 探针转正，原「登出/会话失效即删」断言已反转）：
 *   ① 登录失败 401（密码错，F1-11-T2）不清本机草稿；② **被动会话失效 401 后草稿幸存**
 *   （地下表房长时间填写 + 滑动超时的真实场景）；③ **登出后草稿幸存**——
 *   串值防护由用户+班次 keying 承担（C-05），清除只随提交成功（TK-12 markSubmitted）
 * - TK-07 评审 m1 旁证（挂 F1-05-T1 层级先例同「数字键盘旁证挂 F1-08-T3」）：prev 拉取
 *   App 级按 duty_date 缓存后，同班次连开多卡只发一次 /records/today/prev
 *
 * **不 import @handover/shared**（与 today.spec.ts 同理由）：E2E 是契约的外部观察者。
 *
 * 前置：MySQL 已灌种子（D0 留空）、shared 已构建。详见 playwright.config.ts。
 */
import { test, expect, type Page } from '@playwright/test';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';
/** 水表读数（任意有效读数；非黄金值——本文件验的是暂存与恢复，不是用量口径） */
const WATER_READING = '49239';

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

/** 打开水表卡填一个读数，等到「草稿已自动保存」指示（事务提交后点亮的确定性同步点） */
async function fillWaterReading(page: Page): Promise<void> {
  await page.getByTestId('task-card-water').click();
  await page.getByTestId('input-water_reading').locator('input').fill(WATER_READING);
  await expect(page.getByTestId('draft-saved')).toBeVisible();
  await page.getByTestId('back-to-today').click();
  await expect(page.getByTestId('card-list')).toBeVisible();
}

/** 重新登录（登录页可见的前提下）并等到首页就绪 */
async function relogin(page: Page, username = 'zhang'): Promise<void> {
  await page.getByTestId('login-username').locator('input').fill(username);
  await page.getByTestId('login-password').locator('input').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/records/today') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
  await expect(page.getByTestId('card-list')).toBeVisible();
}

test.describe('F1-09-T1：填写中途关闭页面 → 重开 → 草稿恢复可续填', () => {
  test('填水表读数 → 关闭页面 → 重开自动登录 → 内容与关闭前一致（含恢复提示；零服务端写入）', async ({
    page,
  }) => {
    // F1-07-T2 旁证：草稿层全程不产生任何 /records/today/draft 请求（服务器无感知）
    let draftEndpointRequests = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/records/today/draft')) draftEndpointRequests += 1;
    });

    await login(page);
    await fillWaterReading(page);

    // 「关闭页面」：整页关闭（非刷新），模拟师傅中途收工；Cookie 与 IndexedDB 均随 context 存活
    const context = page.context();
    await page.close();
    const reopened = await context.newPage();

    // 「重开」：Cookie 仍有效 → bootstrap 自动恢复登录态；恢复后应给出草稿恢复提示
    await reopened.goto('/');
    await expect(reopened.getByTestId('card-list')).toBeVisible();
    await expect(reopened.locator('.van-toast')).toContainText('已恢复本班次未提交的草稿');

    // 判据「草稿内容与关闭前一致」：重开水表卡，读数原样回来（可续填）
    await reopened.getByTestId('task-card-water').click();
    await expect(reopened.getByTestId('input-water_reading').locator('input')).toHaveValue(
      WATER_READING,
    );
    expect(draftEndpointRequests).toBe(0);
  });

  test('刷新路径：跨卡内容与多选数组/枚举类型经 IndexedDB 往返后原样恢复（TK-08 评审 M4）', async ({
    page,
  }) => {
    await login(page);
    await fillWaterReading(page);

    // 第二张卡：新风机房卡勾两个位置（string 数组，验证数组保真与运行时可用）
    await page.getByTestId('task-card-hvac').click();
    const group = page.getByTestId('input-hvac_locs');
    await group.locator('.van-checkbox').filter({ hasText: '手术部' }).click();
    await group.locator('.van-checkbox').filter({ hasText: 'ICU' }).click();
    await expect(group.locator('.van-checkbox__icon--checked')).toHaveCount(2);
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('task-card-hvac').click();
    await expect(page.getByTestId('draft-saved')).toBeVisible();

    // 刷新（师傅中途刷新页面的常态动作，与"关闭重开"同属持久层恢复路径）
    await page.reload();
    await expect(page.getByTestId('card-list')).toBeVisible();

    // hvac 数组原样恢复（两个勾选态 + 控件可继续交互——数组不是退化值）
    await page.getByTestId('task-card-hvac').click();
    const groupAfter = page.getByTestId('input-hvac_locs');
    await expect(groupAfter.locator('.van-checkbox__icon--checked')).toHaveCount(2);
    await groupAfter.locator('.van-checkbox').filter({ hasText: '门诊大厅' }).click();
    await expect(groupAfter.locator('.van-checkbox__icon--checked')).toHaveCount(3);

    // 水表读数同样恢复（跨卡草稿互不干扰）
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('task-card-water').click();
    await expect(page.getByTestId('input-water_reading').locator('input')).toHaveValue(
      WATER_READING,
    );
  });

  test('登录失败 401（密码错）不清本机草稿：登录成功后仍可续填（tombstone 边界 × F1-11-T2）', async ({
    page,
  }) => {
    await login(page);
    await fillWaterReading(page);

    // 会话 cookie 失效（模拟服务端会话过期，客户端未感知）；IndexedDB 不受影响
    await page.context().clearCookies();
    await page.close();

    const reopened = await page.context().newPage();
    await reopened.goto('/');
    await expect(reopened.getByTestId('login-form')).toBeVisible();

    // 输错一次密码（F1-11-T2：登录请求自身的 401）——不清任何草稿
    await reopened.getByTestId('login-username').locator('input').fill('zhang');
    await reopened.getByTestId('login-password').locator('input').fill('wrong-password');
    await reopened.getByTestId('login-submit').click();
    await expect(reopened.locator('.van-toast')).toBeVisible(); // 服务端确定文案，前端不自行判断

    // 再输对 → 登录成功，草稿原样恢复（输错密码没有丢草稿）
    await reopened.getByTestId('login-password').locator('input').fill(PASSWORD);
    await relogin(reopened);
    await reopened.getByTestId('task-card-water').click();
    await expect(reopened.getByTestId('input-water_reading').locator('input')).toHaveValue(
      WATER_READING,
    );
  });

  test('被动会话失效 401 后草稿幸存（地下表房长填写 + 滑动超时场景，TK-08 评审 M1 探针转正）', async ({
    page,
  }) => {
    await login(page);
    await fillWaterReading(page);

    // 模拟滑动超时：下一次 GET /records/today 返回 401（已登录态 → resetSession）
    await page.route(
      '**/api/v1/records/today',
      (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'UNAUTHENTICATED',
            message: '登录状态已失效，请重新登录',
            missing_fields: null,
            need_confirm: null,
            request_id: 'req-e2e',
          }),
        }),
      { times: 1 },
    );
    await page.getByTestId('task-card-electricity').click();
    await page.getByTestId('back-to-today').click();
    await expect(page.getByTestId('login-form')).toBeVisible();

    // 重新登录同账号同班次：持久草稿幸存（登出/失效只清内存，D-T18 修订 #9）
    await relogin(page);
    await page.getByTestId('task-card-water').click();
    await expect(page.getByTestId('input-water_reading').locator('input')).toHaveValue(
      WATER_READING,
    );
  });

  test('登出后重新登录草稿幸存（清除只随提交成功，串值防护由 keying 承担；D-T18 修订 #9）', async ({
    page,
  }) => {
    await login(page);
    await fillWaterReading(page);

    // 主动登出 → resetSession 只清内存；持久草稿保留
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-form')).toBeVisible();

    // 同一账号重新登录：草稿原样恢复（换账号串值由 keying 防护，C-05）
    await relogin(page);
    await page.getByTestId('task-card-water').click();
    await expect(page.getByTestId('input-water_reading').locator('input')).toHaveValue(
      WATER_READING,
    );
  });
});

test.describe('F1-05-T1（TK-07 评审 m1 旁证）：prev 拉取 App 级按 duty_date 缓存', () => {
  test('同班次连开两张卡，/records/today/prev 只拉取一次（不再每开一卡重复拉取）', async ({
    page,
  }) => {
    let prevRequests = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/records/today/prev')) prevRequests += 1;
    });

    await login(page); // 登录成功 → App 级 loadPrev 拉取一次并按 duty_date 缓存

    // 连开两张卡再返回：SectionView 只消费 App 下发的缓存，不再各自拉取
    await page.getByTestId('task-card-water').click();
    await expect(page.getByTestId('section-navbar')).toBeVisible();
    await page.getByTestId('back-to-today').click();
    await expect(page.getByTestId('card-list')).toBeVisible();
    await page.getByTestId('task-card-electricity').click();
    await expect(page.getByTestId('section-navbar')).toBeVisible();

    expect(prevRequests).toBe(1);
  });
});
