/**
 * TK-15 离线三层缓冲（待同步队列）E2E —— 挂钩台账用例 **F1-06-T1 / F1-07-T1 / F1-07-T2 / F1-14-T1**。
 *
 * 层级说明（比照 TK-06/TK-09/TK-12 先例）：F1-07-T2 在《测试用例清单》标「接口」，但其语义是
 * 「服务器对客户端队列零感知」——队列只在浏览器 IndexedDB，服务端无任何端点参与，E2E 以
 * 「断网期间零 submit 成功响应 + 接班人视角当日记录仍为『尚未开始』」锁定该语义（比
 * supertest 更接近真实断网场景）。
 *
 * 断网注入口径：`context.setOffline()`（会触发页面 online/offline 事件——「恢复网络自动上传」
 * 的触发器正是该事件）；同步上传以 route 拦截回 201 验证客户端半边（真实写库会与并行 spec 的
 * today.spec「当日无记录」断言竞争，同 TK-12 submit-preview 先例；服务端提交行为已由
 * records-submit.spec.ts supertest 锁定，全链路 E2E 随 TK-31）。
 *
 * 账号用 **wang**（其余 spec 全部用 zhang）：本组用例的注入草稿/队列落 IndexedDB 不碰服务端，
 * 但预览/带出走真实接口，避开 zhang 的并行 spec 竞争（TK-10 修订 #21 的 flake 族教训）。
 * 注入草稿读数全**高于**种子 D-1 基线（回退判定不命中）、气卡剩余量全**低于**（充气判定
 * 不命中）——离线预检一次通过（TK-14 黄金值教训：成功类用例基准必须避开防呆命中区）。
 *
 * **不 import @handover/shared**（E2E 是契约的外部观察者）。
 * 前置：MySQL 已灌种子（D0 留空）、shared 已构建。详见 playwright.config.ts。
 */
import { test, expect, type Page } from '@playwright/test';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';

/** 断网注入（Playwright setOffline 会向页面派发 online/offline 事件） */
async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true);
}
async function goOnline(page: Page): Promise<void> {
  await page.context().setOffline(false);
}

async function login(page: Page, username = 'wang'): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').locator('input').fill(username);
  await page.getByTestId('login-password').locator('input').fill(PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/records/today') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
  await expect(page.getByTestId('card-list')).toBeVisible();
}

/**
 * 全量合法草稿直写 IndexedDB（同 submit-preview.spec injectFullDraft 手法：绕过 12 卡逐卡
 * UI 填写；键格式 draft:{user}:{duty_date}，user id 从 /auth/me 实取）。读数口径见文件头。
 */
async function injectFullDraft(
  page: Page,
  dutyDate: string,
  /** 水表读数可注入：M6 回归用它制造低于上一班基线的回退命中 */
  water = '90000.0',
): Promise<void> {
  const values: Record<string, unknown> = {
    water_reading: water,
    e1_reading: '90000.0',
    e2_reading: '90000.0',
    hp_status: 'ok',
    g1_remaining: '300.0',
    g2_remaining: '150.0',
    tank_in_use: 1,
    t1_c830: '5000.00',
    t1_p830: '0.80',
    t2_c830: '4800.00',
    t2_p830: '0.75',
    t1_c2030: '4950.00',
    t1_p2030: '0.80',
    t2_c2030: '4750.00',
    t2_p2030: '0.75',
    lo_measured_am: '2026-09-13 08:12:00',
    lo_measured_pm: '2026-09-13 20:15:00',
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
        // 不带版本号开库（TK-15 起 DB_VERSION=2，硬编码会 VersionError；应用已先建表）
        const req = indexedDB.open('handover-h5');
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

/** 模拟「过夜滞留」：直改本机队列项的班次日期为过去（服务端 duty_date 由 C-08 决定，
 * 无法从外部注入历史班次；白盒操作仅模拟时间流逝，不改变被测的滞留判定逻辑） */
async function staleQueueItem(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('handover-h5');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('sync_queue', 'readwrite');
          const store = tx.objectStore('sync_queue');
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            for (const item of getAll.result as Array<{ id: string; duty_date: string }>) {
              item.duty_date = '2000-01-01';
              store.put(item, item.id);
            }
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

/** 同步上传拦截回 201（客户端半边验证；正文为契约 §3.2 SubmitResultDto 形状） */
async function mockSubmitOk(page: Page): Promise<void> {
  await page.route('**/api/v1/records/today/submit', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 1,
        record_no: 'HB-E2E-TK15-01',
        status: 'submitted',
        version: 1,
        submitted_at: '2026-09-13 09:00:00',
        receiver: { id: 4, real_name: '李师傅' },
        receiver_changed: false,
      }),
    }),
  );
}

/**
 * 离线入队公共动线（F1-07 主链路）：登录 → 注入全量草稿 → 刷新恢复 → 断网 →
 * 改水表读数（草稿层离线暂存）→ 离线预检 → 确认 → 入本机待同步队列。
 */
async function offlineEnqueue(page: Page): Promise<void> {
  await login(page);
  const dutyDate = (await page.getByTestId('duty-date').textContent()) ?? '';
  await injectFullDraft(page, dutyDate);
  await page.reload();
  await expect(page.getByTestId('card-list')).toBeVisible();
  await goOffline(page);
  // F1-06「离线填写先暂存本地」：草稿层不依赖网络，断网下照常自动保存
  await page.getByTestId('task-card-water').click();
  await page.getByTestId('input-water_reading').locator('input').fill('90000.5');
  await expect(page.getByTestId('draft-saved')).toBeVisible();
  await page.getByTestId('back-to-today').click();
  await expect(page.getByTestId('card-list')).toBeVisible();
  // 离线「提交」→ 预览降级为本地同口径预检（横幅明示）→ 确认 → 入本机队列
  await page.getByTestId('submit-open').click();
  await expect(page.getByTestId('preview-offline-note')).toBeVisible();
  await expect(page.getByTestId('preview-missing')).toHaveAttribute('data-count', '0');
  await page.getByTestId('preview-submit').click();
  // F1-07-T1 判据文案：上传成功才算正式提交（D-P07）
  await expect(page.locator('.van-toast')).toContainText('尚未完成交接，请回到院内网络完成同步');
}

test.describe('F1-07-T1：离线提交仅入本机待同步队列并提示', () => {
  test('断网提交 → 提示「尚未完成交接」→ 待同步角标与横幅可见；零 submit 成功响应', async ({
    page,
  }) => {
    let submitOk = 0;
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/records/today/submit') && r.ok()) submitOk += 1;
    });

    await offlineEnqueue(page);

    // 同步状态全程可见（F1-06）：待同步角标 + 队列横幅
    await expect(page.getByTestId('sync-chip')).toContainText('待同步');
    await expect(page.getByTestId('sync-banner')).toContainText('有 1 张交接单在本机待同步');
    // 服务器零感知（F1-07-T2 半边）：离线期间无任何 submit 请求成功到达服务端
    expect(submitOk).toBe(0);
  });
});

test.describe('F1-06-T1：断网填写暂存 → 恢复网络自动上传 → 待同步转已同步', () => {
  test('断网填写 → 离线入队 → 恢复网络自动排空 → 已同步；payload 原样带走本地读数', async ({
    page,
  }) => {
    const submitted: Array<{ sections: Record<string, unknown> }> = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/records/today/submit') && r.status() === 201) {
        submitted.push(JSON.parse(r.request().postData() ?? '{}'));
      }
    });

    await offlineEnqueue(page);
    // mock 必须在离线入队**之后**注册：setOffline 下 route 拦截仍生效，若先注册会把
    // 离线提交也拦截成 201，离线入队分支（F1-07 本体）就永远走不到
    await mockSubmitOk(page);
    await expect(page.getByTestId('sync-chip')).toContainText('待同步');

    // 恢复网络 → online 事件触发自动排空（无需手动点击，F1-06「恢复网络自动上传」）
    await goOnline(page);
    await expect(page.locator('.van-toast')).toContainText('同步成功');
    await expect(page.getByTestId('sync-chip')).toContainText('已同步');
    await expect(page.getByTestId('sync-banner')).toHaveCount(0);

    // 本地数据不丢失：上传 payload 原样保留断网期间填写/注入的读数（数组与时刻含）
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.sections['water_reading']).toBe('90000.5');
    expect(submitted[0]!.sections['hvac_locs']).toEqual(['手术部', 'ICU']);
    expect(typeof submitted[0]!.sections['lo_measured_am']).toBe('string');
  });
});

test.describe('F1-07-T2：同步成功前接班人侧查不到该记录（服务器无感知）', () => {
  test('离线入队 → 恢复网络切接班人视角 → 当日记录仍「尚未开始」（无队列/草稿泄露）', async ({
    page,
  }) => {
    let submitOk = 0;
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/records/today/submit') && r.ok()) submitOk += 1;
    });

    await offlineEnqueue(page);

    // **先在离线态登出**（wang 的队列项留在本机，按 user keying）：若先恢复网络，
    // online 事件会立即触发自动排空、真实写库，破坏本用例「同步成功前接班人查不到」
    // 的被测语义；登出后 user 为 null，恢复网络的排空引擎不会触发。
    // 离线下 logout 请求发不出去（服务端会话仍在），必须再清 Cookie——否则下一步
    // goto 时 bootstrap 会用残留 Cookie 自动恢复 wang 登录态，其队列随即被自动排空
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await page.context().clearCookies();
    await goOnline(page);
    await login(page, 'chief');
    await expect(page.getByTestId('record-status')).toContainText('尚未开始');
    expect(submitOk).toBe(0);
  });
});

test.describe('F1-14-T1：滞留待同步过夜 → 次日打开强提醒（首要展示）', () => {
  // 断言口径（评审修复轮 M1 翻转）：跨班次滞留单**不可由师傅同步**（服务端 submit 只认
  // 当前班次 C-08，上传必然落错日期）——强提醒首要展示后给出「需科长处理」指引，
  // 不得对跨班次项发起任何 /today/submit 请求（原断言 expect(submitted)=1 固化的是错误行为）
  test('队列项跨班次滞留 → 重开页面强提醒覆盖首屏 → 确认收起，且零上传请求、队列项保留', async ({
    page,
  }) => {
    await offlineEnqueue(page);
    await staleQueueItem(page);

    // 次日打开（在线重载）：强提醒首要展示
    await goOnline(page);
    let submitRequests = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/records/today/submit')) submitRequests += 1;
    });
    await page.reload();
    await expect(page.getByTestId('sync-remind-overlay')).toBeVisible();
    await expect(page.getByTestId('sync-remind-title')).toContainText('滞留待同步');
    await expect(page.getByTestId('sync-remind-item-2000-01-01')).toContainText('需科长处理');

    // 确认后收起（会话内不重复弹）；跨班次项零上传（自动排空跳过滞留项）
    await page.getByTestId('sync-remind-ack').click();
    await expect(page.getByTestId('sync-remind-overlay')).toHaveCount(0);
    await expect(page.getByTestId('sync-banner')).toBeVisible(); // 队列项保留，同步状态可见
    expect(submitRequests).toBe(0);
    await expect(page.getByTestId('sync-chip')).toContainText('待同步');
  });
});

test.describe('TK-15 评审修复轮回归（M2/M3/M4/M6/L3/L5）', () => {
  const MOCK_DELAY_MS = 2000;

  /** 延时 201 mock：制造「同步在途」窗口；须在离线入队之后注册（setOffline 下拦截仍生效） */
  async function mockSubmitDelayed(
    page: Page,
    sink: Array<Record<string, unknown>>,
  ): Promise<void> {
    await page.route('**/api/v1/records/today/submit', async (route) => {
      await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
      sink.push(JSON.parse(route.request().postData() ?? '{}'));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 1,
          record_no: 'HB-E2E-TK15-01',
          status: 'submitted',
          version: 1,
          submitted_at: '2026-09-13 09:00:00',
          receiver: null,
          receiver_changed: false,
        }),
      });
    });
  }

  test('M3/M5 回归：排空在途登出 → 记录已确认上传且持久草稿被清（重登无恢复提示）', async ({
    page,
  }) => {
    const bodies: Array<Record<string, unknown>> = [];
    await offlineEnqueue(page);
    await mockSubmitDelayed(page, bodies);
    await goOnline(page);
    await page.waitForTimeout(500); // 进入在途窗口
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await page.waitForTimeout(MOCK_DELAY_MS); // 等在途 submit 落地
    expect(bodies).toHaveLength(1); // 服务端已确认收到这张单

    // 修复前：草稿未清，重登弹「已恢复草稿」并以旧草稿压服务端真值（M3 本体）
    await login(page);
    await expect(page.locator('.van-toast').filter({ hasText: '已恢复' })).toHaveCount(0);
  });

  test('M4 回归：同步在途补改不进入上传快照，且完成后显式提示核对', async ({ page }) => {
    const bodies: Array<{ sections: Record<string, unknown> }> = [];
    await offlineEnqueue(page); // 水表 90000.5
    // M4 修复后同步在途锁开卡（openCard 守卫），故先开卡再触发排空，窗口内补改
    await page.getByTestId('task-card-water').click();
    await mockSubmitDelayed(page, bodies as Array<Record<string, unknown>>);
    await goOnline(page); // 排空开始（在途 2s），师傅停留在水卡页
    await page.waitForTimeout(500);
    await page.getByTestId('input-water_reading').locator('input').fill('88888.1');
    await expect(page.getByTestId('draft-saved')).toBeVisible();

    await expect(page.locator('.van-toast')).toContainText('同步期间的新修改未包含在交接单中');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.sections['water_reading']).toBe('90000.5'); // 上传的是确认时快照
  });

  test('M6 回归：确认按项扣除——异字段新命中仍要求确认，已确认字段不重复弹（探针 P3 对应）', async ({
    page,
  }) => {
    // 第一轮：水表 9000.0 低于种子 D-1 基线 12250 → 命中回退防呆，收集确认后离线入队。
    // 防呆基线来自 /records/today/prev（loadPrev 为 fire-and-forget），必须等它落地再断网，
    // 否则离线预检无基线放行（与实现无关的用例时序问题）
    await login(page);
    const dutyDate = (await page.getByTestId('duty-date').textContent()) ?? '';
    await injectFullDraft(page, dutyDate, '9000.0');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/v1/records/today/prev') && r.status() === 200,
      ),
      page.reload(),
    ]);
    await expect(page.getByTestId('card-list')).toBeVisible();
    // 临时诊断（取证后移除）
    page.on('console', (m) => {
      if (m.text().includes('OFFLINE_GUARD_DEBUG') || m.text().includes('SUBMIT_CATCH_DEBUG'))
        console.log('PAGE:', m.text());
    });
    await goOffline(page);
    await page.getByTestId('submit-open').click();
    await page.getByTestId('preview-submit').click();
    await expect(page.getByTestId('confirm-title')).toBeVisible();
    await page
      .getByTestId('confirm-reason-reading_decreased:water_reading')
      .locator('textarea, input')
      .first()
      .fill('换表底数，师傅确认属实');
    await page.getByTestId('confirm-resubmit').click();
    await expect(page.locator('.van-toast')).toContainText('尚未完成交接');

    // 第二轮：电一线改到 40000（低于种子 D-1 基线 53420）→ **异字段**新命中。
    // 修复前：collectedConfirms 非空即整块跳过预检，e1 的命中不入确认直接入队 →
    // 同步时刻被服务端 409 拒绝而永久滞留；修复后预检始终执行，且入队即清确认清单——
    // 本轮两处命中（water 复现 + e1 新增）都重新要求确认（F1-12-T2 严格口径）
    await page.getByTestId('task-card-electricity').click();
    await page.getByTestId('input-e1_reading').locator('input').fill('40000.0');
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('submit-open').click();
    await page.getByTestId('preview-submit').click();
    await expect(page.getByTestId('confirm-title')).toContainText('（2 项）');
    await expect(page.getByTestId('confirm-item-reading_decreased:e1_reading')).toBeVisible();
    await expect(page.getByTestId('confirm-item-reading_decreased:water_reading')).toBeVisible();
  });

  test('L3 回归：仍离线时手动同步给出显式反馈（C-09 不静默）', async ({ page }) => {
    await offlineEnqueue(page);
    await page.getByTestId('sync-now').click();
    await expect(page.locator('.van-toast')).toContainText('仍无法连接院内网络');
  });

  test('L5 回归：登出后登录页提示本机未同步单数（不含内容、不代传）', async ({ page }) => {
    await offlineEnqueue(page);
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('device-queue-hint')).toContainText('本机有 1 张未同步的交接单');
  });
});
