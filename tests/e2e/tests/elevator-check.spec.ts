/**
 * TK-17 电梯核对（表单端）E2E —— 客户端半边（接口层判据由 records-elevator.spec.ts 覆盖）：
 * - 打开电梯卡 → 逐台「预期：运行/停运」行（ELE-03）+ 计划说明（ELE-02/09 展示）
 * - 一致一键确认 → 选中态随草稿持久化；刷新重开仍选中，且**核对时刻/预期取锁定值**不随
 *   新快照翻转（ELE-05）
 * - 不一致选实际状态 → 说明必填：缺说明完成本卡 → C-09 点名面板（elevator:{id}）+ 跳转定位；
 *   填说明后放行回首页（ELE-04-T2 客户端半边）
 * - 提交链路：payload 携带 elevator_checks[]（ELE-06 标红由服务端落库，接口层已覆盖）——
 *   提交与预览全程 route 拦截（不写库，避让并行 spec，与 submit-preview.spec 同策略）
 * - **M1 回归（评审修复轮）**：服务端 409 ELEVATOR_EXPLANATION_REQUIRED（带 missing_fields、
 *   无 need_confirm）须与 400 同处理——预览弹窗内逐条点名可见（C-09），不得只剩一句 toast
 * - **M2 回归（评审修复轮）**：核对时刻 = **落笔瞬间的本机时刻**，不沿用旧快照时刻；预期按该
 *   时刻重算（离线/陈旧快照下把几小时前的拉取时刻当核对时刻，会让「该停没停」静默漏报）
 *
 * **不 import @handover/shared**（E2E 是契约的外部观察者；与 boiler-stop.spec.ts 同理由）。
 * 前置：MySQL 已灌种子（本文件全部拦截不触库）、shared 已构建。
 *
 * 确定性说明：核对结果断言只用**与时钟无关的两分支**（24 小时恒运行、长期停运恒停运）；
 * 按时段那一台（扶梯）只在 M2 用例里配合 `page.clock.setFixedTime` 钉时刻后断言。
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Handover@2026';

/** 逐台预期 mock（id/name 自造，不依赖种子电梯行；快照生成时刻 21:00） */
const MOCK_EXPECTED = {
  check_time: '2026-09-14 21:00:00',
  elevators: [
    {
      id: 901,
      name: '扶梯',
      plan_type: 'scheduled',
      windows: [['06:00', '21:00']],
      stop_reason: null,
      expected: 'stop',
    },
    {
      id: 902,
      name: '1号电梯',
      plan_type: 'always',
      windows: null,
      stop_reason: null,
      expected: 'run',
    },
    {
      id: 903,
      name: '5号电梯',
      plan_type: 'stopped',
      windows: null,
      stop_reason: '停用检修',
      expected: 'stop',
    },
  ],
};

const MOCK_SUBMIT_RESULT = {
  id: 1,
  record_no: 'HB-20260914-001',
  status: 'submitted',
  version: 1,
  submitted_at: '2026-09-14 23:30:00',
  receiver: null,
  receiver_changed: false,
};

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

/** 注册电梯预期拦截（每次打开电梯卡都会重拉，统一回同一份快照） */
async function mockExpected(page: Page, body = MOCK_EXPECTED): Promise<void> {
  await page.route('**/api/v1/elevators/expected', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

/** 预览/提交全拦截：捕获 submit 请求体（不写库，避让并行 spec 的 today 断言） */
async function mockSubmit(
  page: Page,
  submitResponse?: { status: number; body: unknown },
): Promise<{ body: () => { elevator_checks?: Array<Record<string, unknown>> } | null }> {
  let captured: { elevator_checks?: Array<Record<string, unknown>> } | null = null;
  await page.route('**/api/v1/records/today/preview', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ duty_date: '2026-09-14', missing_fields: [], abnormal_fields: [] }),
    });
  });
  await page.route('**/api/v1/records/today/submit', async (route) => {
    captured = route.request().postDataJSON() as typeof captured;
    const res = submitResponse ?? { status: 201, body: MOCK_SUBMIT_RESULT };
    await route.fulfill({
      status: res.status,
      contentType: 'application/json',
      body: JSON.stringify(res.body),
    });
  });
  return { body: () => captured };
}

/** 行内已选中的 radio 图标（vant 选中态 class；aria snapshot 的 [checked] 非 DOM 属性，
 *  [aria-checked] 恒不存在，故与 boiler-stop 的禁用断言不同，选中态走 icon class） */
function checkedIcon(page: Page, id: number) {
  return page.locator(`[data-testid="elevator-actual-${id}"] .van-radio__icon--checked`);
}

async function openElevatorCard(page: Page): Promise<void> {
  await page.getByTestId('task-card-elevator').click();
  await expect(page.getByTestId('elevator-checktime')).toContainText('2026-09-14 21:00:00');
}

/** 行内点选核对结果（label：与预期一致 / 不一致（实际：…） / 故障） */
async function selectActual(page: Page, id: number, label: string): Promise<void> {
  await page
    .locator(`[data-testid="elevator-actual-${id}"] .van-radio`)
    .filter({ hasText: label })
    .click();
}

test.describe('TK-17 电梯核对（表单端）：逐台预期锁定、一键确认、不一致必填说明', () => {
  test('打开即出逐台预期（ELE-03/02/09 展示）；一致一键确认随草稿持久化、刷新后锁定值不翻转（ELE-05）', async ({
    page,
  }) => {
    await mockExpected(page);
    await login(page);
    await openElevatorCard(page);

    // 逐台行与预期标签（ELE-03：师傅看到的不是空白清单，而是逐台预期）
    await expect(page.getByTestId('elevator-row-901')).toContainText('扶梯');
    await expect(page.getByTestId('elevator-expected-901')).toHaveText('预期：停运');
    await expect(page.getByTestId('elevator-row-901')).toContainText('按时段运行 06:00–21:00');
    await expect(page.getByTestId('elevator-expected-902')).toHaveText('预期：运行');
    await expect(page.getByTestId('elevator-row-903')).toContainText('长期停运（停用检修）');

    // 一致一键确认（ELE-04-T1 客户端半边）：24 小时运行那一台，结果与时钟无关
    await selectActual(page, 902, '与预期一致');
    await expect(checkedIcon(page, 902)).toHaveCount(1);
    // 核对时刻显在行上（ELE-03「系统自动记录」；M2 后为落笔瞬间而非快照时刻）
    await expect(page.getByTestId('elevator-checked-at-902')).toContainText('核对于 2026-');
    const stamped = await page.getByTestId('elevator-checked-at-902').innerText();
    // 等持久层落盘（1s 防抖；pagehide 冲盘仅 best-effort，不等即刷新有丢写窗口）
    await expect(page.getByTestId('draft-saved')).toBeVisible();

    // 刷新重开：草稿恢复（F1-09）+ 已核对行的时刻/预期取锁定值（ELE-05，不随新快照改写）
    await page.reload();
    await expect(page.getByTestId('card-list')).toBeVisible();
    await openElevatorCard(page);
    await expect(checkedIcon(page, 902)).toHaveCount(1);
    await expect(page.getByTestId('elevator-checked-at-902')).toHaveText(stamped);
    await expect(page.getByTestId('elevator-checktime')).toContainText(
      '预期快照：2026-09-14 21:00:00',
    );
  });

  test('不一致选实际状态 → 说明必填：缺说明完成被点名拦截并跳转定位，填说明后放行（ELE-04-T2 客户端半边）', async ({
    page,
  }) => {
    await mockExpected(page);
    await login(page);
    await openElevatorCard(page);

    // 长期停运那一台选「不一致（实际：运行）」→ 说明输入框出现（恒为不一致，与时钟无关）
    await selectActual(page, 903, '不一致（实际：运行）');
    await expect(page.getByTestId('elevator-explanation-903')).toBeVisible();

    // 缺说明完成本卡 → C-09 点名面板：elevator:{id} 逐条点名（section 9）
    await page.getByTestId('complete-card').click();
    await expect(page.getByTestId('section-error-panel')).toBeVisible();
    await expect(page.getByTestId('error-item-elevator:903')).toBeVisible();
    // 点击点名项跳转定位（锚点行 #sec-9-elevator-903 由 shared fieldAnchor 同源生成）
    await page.getByTestId('error-item-elevator:903').click();
    await expect(page.locator('#sec-9-elevator-903')).toHaveClass(/field-row-focus/);

    // 填说明 → 完成放行回首页
    await page
      .getByTestId('elevator-explanation-903')
      .locator('textarea')
      .fill('停用检修期间被临时启用送检设备');
    await page.getByTestId('complete-card').click();
    await expect(page.getByTestId('section-error-panel')).toHaveCount(0);
    await expect(page.getByTestId('card-list')).toBeVisible();
  });

  test('提交链路：payload 携带 elevator_checks[]（actual/expected/说明齐备，锁定值随提交上送）', async ({
    page,
  }) => {
    await mockExpected(page);
    const captured = await mockSubmit(page);
    await login(page);
    await openElevatorCard(page);
    await selectActual(page, 903, '不一致（实际：运行）');
    await page
      .getByTestId('elevator-explanation-903')
      .locator('textarea')
      .fill('停用检修期间被临时启用送检设备');
    await selectActual(page, 902, '与预期一致');

    // 返回首页 → 提交预览（mock 空清单）→ 确认提交 → 捕获 payload
    await page.getByTestId('back-to-today').click();
    await expect(page.getByTestId('submit-open')).toBeVisible();
    await page.getByTestId('submit-open').click();
    await expect(page.getByTestId('preview-title')).toBeVisible();
    await page.getByTestId('preview-submit').click();
    await expect(page.getByTestId('card-list')).toBeVisible(); // 成功后 loadToday 回首页

    const checks = captured.body()?.elevator_checks ?? [];
    expect(checks).toHaveLength(2);
    const stopped = checks.find((c) => c.elevator_id === 903);
    expect(stopped).toMatchObject({
      elevator_id: 903,
      expected: 'stop',
      actual: 'run',
      explanation: '停用检修期间被临时启用送检设备',
    });
    expect(String(stopped?.check_time)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(checks.find((c) => c.elevator_id === 902)).toMatchObject({
      expected: 'run',
      actual: 'match',
      explanation: null,
    });
  });

  test('M1 回归：409 ELEVATOR_EXPLANATION_REQUIRED 的点名清单在预览弹窗内逐条可见（C-09），弹窗不关', async ({
    page,
  }) => {
    await mockExpected(page);
    await mockSubmit(page, {
      status: 409,
      body: {
        code: 'ELEVATOR_EXPLANATION_REQUIRED',
        message: '电梯核对与预期不一致，请逐台填写说明后重新提交',
        missing_fields: [
          {
            field: 'elevator:903',
            section: 9,
            label: '5号电梯 状态说明',
            anchor: '#sec-9-elevator-903',
          },
        ],
        need_confirm: null,
        request_id: 'req-elevator-409',
      },
    });
    await login(page);
    await page.getByTestId('submit-open').click();
    await expect(page.getByTestId('preview-title')).toBeVisible();
    await page.getByTestId('preview-submit').click();

    // 原实现落进「其余 409」：只 toast、弹窗关闭、点名清单丢弃 → 此断言先红后绿
    await expect(page.getByTestId('preview-item-elevator:903')).toBeVisible();
    await expect(page.getByTestId('preview-title')).toBeVisible();
    // 点击可跳转定位（elevator:{id} 特判路由到电梯卡）
    await page.getByTestId('preview-item-elevator:903').click();
    await expect(page.getByTestId('elevator-row-903')).toBeVisible();
  });

  test('M2 回归：核对时刻取落笔瞬间并按该时刻重算预期（陈旧快照不把几小时前当核对时刻）', async ({
    page,
  }) => {
    // 钉住本机时钟：23:30 落笔（扶梯窗口 06:00–21:00 → 此刻应为停运）
    await page.clock.setFixedTime(new Date('2026-09-14T23:30:00'));
    // 陈旧快照：08:00 拉取、当时预期「运行」——原实现会把这时刻当核对时刻直接写 match
    await mockExpected(page, {
      check_time: '2026-01-05 08:00:00',
      elevators: [
        {
          id: 901,
          name: '扶梯',
          plan_type: 'scheduled',
          windows: [['06:00', '21:00']],
          stop_reason: null,
          expected: 'run',
        },
      ],
    });
    const captured = await mockSubmit(page);
    await login(page);
    await page.getByTestId('task-card-elevator').click();
    await expect(page.getByTestId('elevator-row-901')).toBeVisible();
    await expect(page.getByTestId('elevator-checktime')).toContainText(
      '预期快照：2026-01-05 08:00:00',
    );

    // 师傅点的仍是「与预期一致」（他看到的屏幕预期是运行）
    await selectActual(page, 901, '与预期一致');
    await page.getByTestId('back-to-today').click();
    await page.getByTestId('submit-open').click();
    await page.getByTestId('preview-submit').click();

    const escalator = (captured.body()?.elevator_checks ?? []).find((c) => c.elevator_id === 901);
    // ① 核对时刻 = 落笔瞬间（钉住的 23:30），不是快照时刻 08:00
    expect(escalator?.check_time).toBe('2026-09-14 23:30:00');
    // ② 预期按落笔时刻重算 = 停运（黄金值：窗口 06:00–21:00，23:30 在窗口外）
    expect(escalator?.expected).toBe('stop');
    // ③ 观察到的实际状态（运行）与当时预期相反 → 记为不一致（原实现记 match → 漏报）
    expect(escalator?.actual).toBe('run');
  });
});
