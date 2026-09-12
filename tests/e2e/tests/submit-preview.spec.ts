/**
 * TK-12 在线提交与预览 E2E —— 挂钩台账用例 **F1-10-T1 / F2-01-T1（客户端半边）**。
 *
 * 层级说明（比照 records-boiler.spec.ts / TK-11 评审 M2 先例）：服务端判据（record_no 生成、
 * 接班人带出、停机 NULL、数组落库、submitted_at、测量时刻不覆盖）已由接口层
 * `apps/api/src/records/records-submit.spec.ts` supertest 全量锁定（23/23）；
 * 本文件覆盖**客户端半边**：
 * - F1-10-T1 客户端：提交入口 → 预览弹窗（未填项/异常项逐条点名）→ 点击清单项跳转定位
 *   （C-09「点击跳转可达」跨卡路径）→ 未填项未清零前「确认提交」置灰；
 * - F2-01-T1 客户端：提交成功（route 拦截回 201，避免真实写库与并行 spec 的
 *   today.spec「当日无记录」断言竞争——正式链路 E2E 随 TK-31 全量回归统一接）→
 *   成功 toast 含交接单号 → **持久草稿被清除（D-T18 修订 #9 markSubmitted 挂账钩子）**：
 *   重开页面无「已恢复草稿」提示；
 * - C-09 客户端：服务端复验 400 的点名清单回填预览弹窗逐条展示（不静默吞错）。
 *
 * **不 import @handover/shared**（E2E 是契约的外部观察者）。
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

/** 水表卡填一个读数并「完成本卡」（制造"部分填写"的预览场景） */
async function fillWaterReading(page: Page, value: string): Promise<void> {
  await page.getByTestId('task-card-water').click();
  await page.getByTestId('input-water_reading').locator('input').fill(value);
  await page.getByTestId('complete-card').click();
  await expect(page.getByTestId('card-list')).toBeVisible();
}

/** 直接把全量合法草稿写入 IndexedDB（绕过 12 卡逐卡 UI 填写；键格式 draft:{user}:{duty_date}，
 *  user id 从 /auth/me 实时取，不硬编码种子顺序——评审修复轮 L7） */
async function injectFullDraft(page: Page, dutyDate: string): Promise<void> {
  const values: Record<string, unknown> = {
    water_reading: '100.0',
    e1_reading: '200.0',
    e2_reading: '150.0',
    hp_status: 'ok',
    g1_remaining: '300.0',
    g2_remaining: '250.0',
    tank_in_use: 1,
    t1_c830: '5000.00',
    t1_p830: '0.80',
    t2_c830: '4800.00',
    t2_p830: '0.75',
    t1_c2030: '4950.00',
    t1_p2030: '0.80',
    t2_c2030: '4750.00',
    t2_p2030: '0.75',
    lo_measured_am: '2026-09-12 08:12:00',
    lo_measured_pm: '2026-09-12 20:15:00',
    lo_station_press: '0.50',
    hbo_press: '0.45',
    b40: 10,
    b10: 20,
    b6: 30,
    b_co2: 40,
    b_pulm: 50,
    manifold_press: '1.00',
    co2_out_press: '0.90',
    neg_status: 'ok',
    air_status: 'ok',
    boiler_status: 'ok',
    boiler_run: 'stop',
    coolroom_status: 'ok',
    cool_run: 'run',
    h1_set_temp: '45.0',
    h1_out_temp: '40.0',
    h3_set_temp: '46.0',
    h3_out_temp: '41.0',
    p1_press: '0.40',
    p1_level: 'ok',
    p1_height: '2.50',
    p3_press: '0.42',
    p3_level: 'ok',
    p3_height: '2.60',
    hvac_status: 'ok',
    hvac_locs: ['手术部', 'ICU'],
  };
  const me = await page.request.get('/api/v1/auth/me');
  const user = (await me.json()) as { id: number };
  await page.evaluate(
    ({ key, values }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('handover-h5', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('drafts')) {
            req.result.createObjectStore('drafts');
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put(values, key);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    { key: `draft:${user.id}:${dutyDate}`, values },
  );
}

test.describe('F1-10-T1（客户端半边）：提交前预览未填项/异常项点名与跳转', () => {
  test('部分填写 → 预览弹窗点名未填项；点击清单项跨卡跳转定位；未清零前提交置灰', async ({
    page,
  }) => {
    await login(page);
    await fillWaterReading(page, '49239.0');

    // 提交入口 → 预览弹窗（真实调用 POST /preview，服务端校验引擎同源）
    await page.getByTestId('submit-open').click();
    await expect(page.getByTestId('preview-title')).toContainText('提交前预览');
    const missing = page.getByTestId('preview-missing');
    await expect(missing).toHaveAttribute('data-count', /[1-9]\d*/); // 有未填项

    // C-09 点名：液氧压力在未填清单中，带板块号；点击跳转 → 液氧 8:30 卡内定位到该字段
    const item = page.getByTestId('preview-item-t1_p830');
    await expect(item).toContainText('板块4');
    await item.click();
    await expect(page.getByTestId('section-navbar')).toContainText('液氧站');
    await expect(page.locator('#sec-4-t1-p830')).toBeInViewport();

    // 回首页再开预览：确认提交在未填项清零前置灰（文案点名而非可点）
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('submit-open').click();
    await expect(page.getByTestId('preview-submit')).toBeDisabled();
    await expect(page.getByTestId('preview-submit')).toContainText('仍有未填项');
  });
});

test.describe('F2-01-T1（客户端半边）：提交成功流程 + D-T18 markSubmitted 草稿清除', () => {
  test('全量草稿 → 提交成功 toast 含交接单号；重开页面无草稿恢复提示（持久草稿已清）', async ({
    page,
  }) => {
    await login(page);
    const dutyDate = (await page.getByTestId('duty-date').textContent()) ?? '';
    await injectFullDraft(page, dutyDate);

    // 注入草稿后刷新 → 应出现「草稿恢复提示」（证明草稿确实在持久层，为下一段清除断言立基准）
    await page.reload();
    await expect(page.getByTestId('card-list')).toBeVisible();
    await expect(page.locator('.van-toast')).toContainText('已恢复本班次未提交的草稿');

    // 拦截 submit：回 201 正式交接单（服务端行为由 supertest 锁定，见文件头层级说明）；
    // 顺带断言客户端 payload 确实带上了草稿值与测量时刻（客户端半边的可失败证据）
    const submitted: Array<{ sections: Record<string, unknown> }> = [];
    await page.route('**/api/v1/records/today/submit', async (route) => {
      submitted.push(JSON.parse(route.request().postData() ?? '{}'));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 1,
          record_no: 'HB-E2E-TK12-01',
          status: 'submitted',
          version: 1,
          submitted_at: '2026-09-12 20:30:00',
          receiver: { id: 4, real_name: '李师傅' },
          receiver_changed: false,
        }),
      });
    });

    await page.getByTestId('submit-open').click();
    await expect(page.getByTestId('preview-missing')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('preview-receiver')).toContainText('按排班表自动带出');
    await page.getByTestId('preview-submit').click();

    // 成功 toast 含交接单号（F2-01「生成正式交接单」客户端反馈）
    await expect(page.locator('.van-toast')).toContainText('HB-E2E-TK12-01');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.sections['water_reading']).toBe('100.0');
    expect(submitted[0]!.sections['hvac_locs']).toEqual(['手术部', 'ICU']);
    expect(submitted[0]!.sections['lo_measured_am']).toBe('2026-09-12 08:12:00');

    // D-T18 修订 #9：提交成功 → markSubmitted 清持久草稿 → 重开页面不得再弹恢复提示；
    // 功能断言：重开水表卡输入框为空（草稿真被清，而非仅提示缺失）
    const context = page.context();
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto('/');
    await expect(reopened.getByTestId('card-list')).toBeVisible();
    // toast 若会出现，应在首屏装载期内弹出；toHaveCount(0) 自带轮询，不再用固定 waitForTimeout（评审修复轮 L7）
    await expect(reopened.locator('.van-toast')).toHaveCount(0);
    await reopened.getByTestId('task-card-water').click();
    await expect(reopened.getByTestId('input-water_reading').locator('input')).toHaveValue('');
  });

  test('C-09 客户端：服务端复验 400 的点名清单回填预览弹窗逐条展示', async ({ page }) => {
    await login(page);
    const dutyDate = (await page.getByTestId('duty-date').textContent()) ?? '';
    await injectFullDraft(page, dutyDate);
    await page.reload();
    await expect(page.getByTestId('card-list')).toBeVisible();

    // 模拟「预览后、提交前」数据被服务端复验拦下的竞态：submit 回 400 点名（C-09 结构）
    await page.route('**/api/v1/records/today/submit', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'VALIDATION_MISSING_FIELDS',
          message: '有 2 项必填未填，请逐条补齐',
          missing_fields: [
            {
              field: 'g1_remaining',
              section: 3,
              label: '表1（主卡）剩余量',
              anchor: '#sec-3-g1-remaining',
            },
            {
              field: 'hvac_locs',
              section: 7,
              label: '新风使用位置',
              anchor: '#sec-7-hvac-locs',
            },
          ],
          need_confirm: null,
          request_id: 'req-e2e',
        }),
      });
    });

    await page.getByTestId('submit-open').click();
    await expect(page.getByTestId('preview-missing')).toHaveAttribute('data-count', '0');
    await page.getByTestId('preview-submit').click();

    // 弹窗不关：服务端点名清单回填未填项区，可点击跳转（不静默吞错）
    await expect(page.getByTestId('preview-title')).toBeVisible();
    await expect(page.getByTestId('preview-missing')).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('preview-item-g1_remaining')).toContainText('表1（主卡）剩余量');
    await expect(page.getByTestId('preview-item-g1_remaining')).toContainText('板块3');
    await expect(page.getByTestId('preview-submit')).toBeDisabled();
  });
});

test.describe('提交入口状态机与角色门控（评审修复轮 M6/L1）', () => {
  /** 最小 TodayDto（route 拦 GET /records/today 用，不写库——真实链路随 TK-31） */
  function todayBody(record: { status: string } | null): string {
    return JSON.stringify({
      duty_date: '2026-09-12',
      shift_start_time: '08:30',
      record: record
        ? {
            id: 1,
            record_no: 'HB-E2E-TK12-01',
            status: record.status,
            version: 1,
            submitted_at: null,
          }
        : null,
      pending_sync: false,
      submitter: { id: 1, real_name: '张师傅' },
      receiver: null,
      progress: { filled: 0, total: 0, pending: 0, abnormal: 0 },
      sections: [],
      cards: [],
    });
  }

  test('master：当日记录为 draft（撤回后）→ 提交入口重现（M6：撤回重提路径不再卡死）', async ({
    page,
  }) => {
    await page.route('**/api/v1/records/today', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: todayBody({ status: 'draft' }),
      }),
    );
    // 最小 TodayDto 的 cards 为空（容器零高度会被判 hidden），改用 record-status 作渲染锚点
    await page.goto('/');
    await page.getByTestId('login-username').locator('input').fill('zhang');
    await page.getByTestId('login-password').locator('input').fill(PASSWORD);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/records/today') && r.status() === 200),
      page.getByTestId('login-submit').click(),
    ]);
    await expect(page.getByTestId('record-status')).toContainText('草稿');
    await expect(page.getByTestId('submit-open')).toBeVisible();
  });

  test('master：当日记录已提交 → 提交入口隐藏（一天一条，F1-01）', async ({ page }) => {
    await page.route('**/api/v1/records/today', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: todayBody({ status: 'submitted' }),
      }),
    );
    await page.goto('/');
    await page.getByTestId('login-username').locator('input').fill('zhang');
    await page.getByTestId('login-password').locator('input').fill(PASSWORD);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/records/today') && r.status() === 200),
      page.getByTestId('login-submit').click(),
    ]);
    await expect(page.getByTestId('record-status')).toContainText('已提交');
    await expect(page.getByTestId('submit-open')).toHaveCount(0);
  });

  test('chief：提交入口不可见（评审 L1：提交是师傅端写操作，科长巡查不再见 403 死按钮）', async ({
    page,
  }) => {
    await login(page, 'chief'); // 真实接口：当日无记录（种子 D0 留空）
    await expect(page.getByTestId('submit-open')).toHaveCount(0);
  });
});
