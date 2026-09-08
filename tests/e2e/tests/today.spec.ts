/**
 * TK-05 今日交接首页 E2E —— 挂钩台账用例 F1-01-T1 / F1-02-T1 / F1-02-T2 / F1-03-T1
 * （《测试用例清单》将四条标为 **E2E 层级**；服务端判据另见 `apps/api/src/records/records.spec.ts`）。
 *
 * 本文件只覆盖 **UI 层判据**：卡片渲染数与顺序、点击进板块页后的字段归属、进度条与角标的
 * 实时汇总、异常角标变色。不重复接口层已断言的口径（duty_date 跨天归属、分母计算等）。
 *
 * **断言策略：UI 与接口响应逐一对照**，而非硬编码期望数字——例如进度条文字取接口 `progress`
 * 的实际值来比对。这样 F1-03-T1 判据「计数与实际一致」是被真正验证的（UI 显示 == 服务端数据），
 * 且 shared 字典调整分母后本文件无需改动。
 *
 * **不 import @handover/shared**：shared 的 dist 为 CJS（供 Nest 消费），而 Playwright 用例跑在
 * ESM 上下文；且 E2E 作为契约的**外部观察者**，用局部最小类型断言可在接口字段漂移时以运行时
 * 失败暴露问题（类型同源已由 api 侧的 records.spec.ts 保证）。
 *
 * 前置：MySQL 已灌种子（D0 刻意留空）、shared 已构建。详见 playwright.config.ts。
 */
import { test, expect, type Page } from '@playwright/test';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';
const TODAY_URL = '**/api/v1/records/today';

/** 接口响应的最小局部类型（只声明本文件断言所需字段） */
interface Badge {
  filled: number;
  total: number;
  pending: number;
  abnormal: number;
}
interface Card {
  key: string;
  spot_name: string;
  sort_no: number;
  title: string;
  slot_label: string | null;
  section: number;
  sections: number[];
  kind: string;
  badge: Badge;
  fields: Array<{
    name: string;
    required: boolean;
    filled: boolean;
    abnormal: boolean;
    value: unknown;
  }>;
}
interface TodayBody {
  duty_date: string;
  shift_start_time: string;
  record: { status: string } | null;
  pending_sync: boolean;
  submitter: { real_name: string };
  progress: Badge;
  sections: Array<{ no: number; badge: Badge }>;
  cards: Card[];
}

/**
 * 12 张卡的期望点位顺序 = `spots.sort_no` 升序，液氧站拆两张到点卡（F1-02）。
 * 出处：《开发种子数据 v0.1》§三 巡检点位表（11 个点位）。
 */
const EXPECTED_SPOTS = [
  '表房',
  '高配房',
  '燃气表房',
  '液氧站',
  '液氧站',
  '瓶库',
  '锅炉房',
  '制冷机房',
  '泵房',
  '新风机房',
  '电梯厅',
  '值班室',
];

/** 登录并进入首页，返回 GET /records/today 的真实响应体（供 UI 与接口对照断言） */
async function loginAndOpenToday(page: Page, username = 'zhang'): Promise<TodayBody> {
  await page.goto('/');
  // van-field 的 data-testid 落在组件根元素，输入框在其内部
  await page.getByTestId('login-username').locator('input').fill(username);
  await page.getByTestId('login-password').locator('input').fill(PASSWORD);

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/records/today') && r.status() === 200),
    page.getByTestId('login-submit').click(),
  ]);
  await expect(page.getByTestId('card-list')).toBeVisible();
  return (await res.json()) as TodayBody;
}

/** 页面上实际渲染出的全部卡片元素 */
function cardElements(page: Page) {
  return page.locator('[data-testid^="task-card-"]');
}

test.describe('F1-01-T1：一天一条记录，首页即"今日交接"', () => {
  test('师傅登录 → 首页即今日交接，全天仅一条记录入口', async ({ page }) => {
    const body = await loginAndOpenToday(page);

    // 判据「首页即今日交接」：导航标题与班次日期直接呈现，无需二次选择日期或记录
    await expect(page.getByTestId('today-navbar')).toContainText('今日交接');
    await expect(page.getByTestId('duty-date')).toHaveText(body.duty_date);
    // C-08：显示的是班次起始日（非自然日），并回显分界时刻便于师傅理解凌晨归属
    expect(body.duty_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(page.getByTestId('duty-date').locator('..')).toContainText(
      `分界 ${body.shift_start_time}`,
    );

    // 判据「无重复入口」：全页只有一个卡片列表，且不存在任何"新建/选择记录"入口
    await expect(page.getByTestId('card-list')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /新建|新增|选择日期/ })).toHaveCount(0);

    // 当日无记录（种子 D0 留空）→ 状态显示"尚未开始"；GET 只读，不因打开首页而产生 draft
    expect(body.record).toBeNull();
    await expect(page.getByTestId('record-status')).toHaveText('尚未开始');

    // 实名制（C-05）：交班人 = 登录账号
    await expect(page.getByTestId('submitter-name')).toHaveText(body.submitter.real_name);
  });

  test('刷新页面不产生第二条入口，仍为同一条记录视图（GET 纯读）', async ({ page }) => {
    const body = await loginAndOpenToday(page);
    await page.reload();
    await expect(page.getByTestId('card-list')).toHaveCount(1);
    await expect(page.getByTestId('duty-date')).toHaveText(body.duty_date);
    // 仍为"尚未开始"：反复打开首页不会把记录推进到 draft（record_no 提交时才生成，契约 §4）
    await expect(page.getByTestId('record-status')).toHaveText('尚未开始');
  });
});

test.describe('F1-02-T1：12 张任务卡按点位组织，液氧拆 8:30/20:30 两张到点卡', () => {
  test('卡片数与组织顺序与 PRD §6.0 一致', async ({ page }) => {
    const body = await loginAndOpenToday(page);

    // 判据「卡片数一致」：接口给 12 张，UI 就渲染 12 张（两侧对照，非各自硬编码）
    expect(body.cards).toHaveLength(12);
    await expect(cardElements(page)).toHaveCount(body.cards.length);

    // 判据「组织顺序一致」：按巡检点位 sort_no 升序，液氧站两张到点卡相邻
    const renderedSpots = await cardElements(page).evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.spot ?? ''),
    );
    expect(renderedSpots).toEqual(EXPECTED_SPOTS);
    // 前端不重排：渲染顺序与接口顺序逐项一致
    expect(renderedSpots).toEqual(body.cards.map((c) => c.spot_name));

    const sortNos = body.cards.map((c) => c.sort_no);
    expect(sortNos).toEqual([...sortNos].sort((a, b) => a - b));
  });

  test('液氧拆 8:30 / 20:30 两张到点卡，左块显示时段、标题区分早晚', async ({ page }) => {
    await loginAndOpenToday(page);

    // 到点卡左块显示时段（提醒师傅"到点去测"），其余卡显示板块序号
    await expect(page.getByTestId('card-lead-lo_am')).toHaveText('8:30');
    await expect(page.getByTestId('card-lead-lo_pm')).toHaveText('20:30');
    await expect(page.getByTestId('card-lead-water')).toHaveText('一');

    // 两张卡标题需可区分（同点位「液氧站」拆两卡）
    await expect(page.getByTestId('card-title-lo_am')).toHaveText('液氧站（早）');
    await expect(page.getByTestId('card-title-lo_pm')).toHaveText('液氧站（晚）');

    // 8:30 卡在 20:30 卡之前（时间顺序即巡检顺序）
    const keys = await cardElements(page).evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.cardKey ?? ''),
    );
    expect(keys.indexOf('lo_am')).toBeLessThan(keys.indexOf('lo_pm'));
  });
});

test.describe('F1-02-T2：点击卡片进入板块填写页，只见本板块字段', () => {
  /** 逐卡验证：页面渲染的字段集合 == 接口给的该卡字段集合，且不含任何其他卡的字段 */
  async function expectNoCrossTalk(page: Page, body: TodayBody, key: string): Promise<void> {
    await page.getByTestId(`task-card-${key}`).click();

    const card = body.cards.find((c) => c.key === key);
    if (!card) throw new Error(`接口未返回卡片 ${key}`);

    const rendered = await page
      .locator('[data-field-name]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.fieldName ?? ''));

    // 判据「只见本板块字段」：渲染集合与接口给的该卡字段逐项相等（无增减）
    expect(rendered, `卡「${key}」渲染的字段应与接口一致`).toEqual(card.fields.map((f) => f.name));

    // 判据「板块间无字段串扰」：渲染出的字段不得出现在任何其他卡
    const others = body.cards
      .filter((c) => c.key !== key)
      .flatMap((c) => c.fields.map((f) => f.name));
    for (const name of rendered) {
      expect(others, `字段 ${name} 不应同时属于卡「${key}」与其他卡`).not.toContain(name);
    }

    await page.getByTestId('back-to-today').click();
    await expect(page.getByTestId('card-list')).toBeVisible();
  }

  test('表房卡只见水板块字段', async ({ page }) => {
    const body = await loginAndOpenToday(page);
    await expectNoCrossTalk(page, body, 'water');
  });

  test('高配房卡只见电板块字段（含条件必填的异常备注）', async ({ page }) => {
    const body = await loginAndOpenToday(page);
    await expectNoCrossTalk(page, body, 'electricity');
    // 该卡字段来自附录 A 板块二：两线读数 + 用电量（自动）+ 高配房状态与备注
    await expect(page.getByTestId('task-card-electricity')).toBeVisible();
  });

  test('值班室卡兼管板块十与板块八（energy_note 有填写入口）', async ({ page }) => {
    const body = await loginAndOpenToday(page);
    const desk = body.cards.find((c) => c.key === 'duty_desk');
    expect(desk?.sections).toEqual([10, 8]);

    await expectNoCrossTalk(page, body, 'duty_desk');

    // 板块八「节能减排」无 spots 点位，但 PRD §6.1 要求十板块完整可填 → 由值班室卡兼管
    await page.getByTestId('task-card-duty_desk').click();
    await expect(page.getByTestId('field-energy_note')).toBeVisible();
    await expect(page.getByTestId('field-handover_note')).toBeVisible();
    await page.getByTestId('back-to-today').click();
  });

  test('电梯卡走逐台核对，无 records 字段（契约 §3.3，TK-17）', async ({ page }) => {
    const body = await loginAndOpenToday(page);
    const lift = body.cards.find((c) => c.key === 'elevator');
    expect(lift?.kind).toBe('elevator');
    expect(lift?.fields).toEqual([]);

    await page.getByTestId('task-card-elevator').click();
    // 无字段清单，给出核对入口的归属说明而非空白页
    await expect(page.locator('[data-field-name]')).toHaveCount(0);
    await expect(page.getByTestId('section-navbar')).toContainText('电梯厅');
    await page.getByTestId('back-to-today').click();
  });
});

test.describe('F1-03-T1：角标与顶部进度条实时汇总已填/待填/异常', () => {
  test('初始态：全部待填，进度条 0%，UI 计数与接口逐项一致', async ({ page }) => {
    const body = await loginAndOpenToday(page);

    // 判据「计数与实际一致」：进度条文字取接口 progress 的实际值比对（非硬编码 38 之类的魔数）
    await expect(page.getByTestId('progress-text')).toContainText(
      `已填 ${body.progress.filled} / ${body.progress.total} 项`,
    );
    await expect(page.getByTestId('progress-text')).toContainText(`待填 ${body.progress.pending}`);
    expect(body.progress.filled).toBe(0);
    expect(body.progress.pending).toBe(body.progress.total);

    // 进度条宽度与百分比一致（初始 0%）
    await expect(page.getByTestId('progress-bar')).toHaveAttribute('style', 'width: 0%;');

    // 顶部进度条 = 12 张卡角标之和（同源汇总，不是两套计数）
    const sumFilled = body.cards.reduce((n, c) => n + c.badge.filled, 0);
    const sumTotal = body.cards.reduce((n, c) => n + c.badge.total, 0);
    expect(body.progress.filled).toBe(sumFilled);
    expect(body.progress.total).toBe(sumTotal);

    // 每张卡的角标文案与接口 badge 一致
    for (const card of body.cards) {
      const badge = page.getByTestId(`card-badge-${card.key}`);
      await expect(badge).toBeVisible();
      if (card.badge.abnormal > 0) {
        await expect(badge).toContainText(`异常 ${card.badge.abnormal}`);
      } else if (card.badge.total > 0) {
        await expect(badge).toContainText(
          card.badge.pending === 0 ? '已填' : `待填 ${card.badge.pending}`,
        );
      }
      // 初始全为待填态（灰色）
      await expect(badge).toHaveAttribute('data-tone', 'todo');
    }
  });

  test('出现异常项 → 该卡角标变红、其余卡不受影响、进度条汇总异常数', async ({ page }) => {
    await loginAndOpenToday(page);

    /**
     * 以 route 拦截**改写真实响应**注入异常态，而非整份 mock：链路仍走真后端与真种子数据。
     * 之所以需要注入——TK-05 的服务端接口是只读的（GET 不建 draft 行），要产生真实异常数据
     * 得等 TK-06（表单校验）与 TK-08（在线草稿 PUT）落地写入能力；本用例验的是**前端变色与汇总逻辑**。
     */
    await page.route(TODAY_URL, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as TodayBody;
      const elec = body.cards.find((c) => c.key === 'electricity');
      const hp = elec?.fields.find((f) => f.name === 'hp_status');
      if (elec && hp) {
        // 高配房状态选"异常"：filled 与 abnormal 同时 +1（两者不是互斥状态）
        hp.value = 'bad';
        hp.filled = true;
        hp.abnormal = true;
        elec.badge.filled += 1;
        elec.badge.pending -= 1;
        elec.badge.abnormal = 1;
        body.progress.filled += 1;
        body.progress.pending -= 1;
        body.progress.abnormal = 1;
        const sec2 = body.sections.find((s) => s.no === 2);
        if (sec2) {
          sec2.badge.filled += 1;
          sec2.badge.pending -= 1;
          sec2.badge.abnormal = 1;
        }
      }
      await route.fulfill({ response: res, body: JSON.stringify(body) });
    });

    await page.reload();
    await expect(page.getByTestId('card-list')).toBeVisible();

    // 判据「异常角标变色」：该卡角标转红（data-tone=bad），文案带异常计数
    const elecBadge = page.getByTestId('card-badge-electricity');
    await expect(elecBadge).toHaveAttribute('data-tone', 'bad');
    await expect(elecBadge).toContainText('异常 1');

    // 其余卡不受影响（异常定位到卡，不污染全局）
    await expect(page.getByTestId('card-badge-water')).toHaveAttribute('data-tone', 'todo');
    await expect(page.getByTestId('card-badge-boiler')).toHaveAttribute('data-tone', 'todo');

    // 顶部进度条把异常汇总上来（F1-03「实时汇总已填/待填/异常」）
    await expect(page.getByTestId('progress-text')).toContainText('异常 1');
    await expect(page.getByTestId('progress-text')).toContainText('已填 1 /');
  });

  test('填齐一张卡 → 该卡角标转"已填"绿色', async ({ page }) => {
    await loginAndOpenToday(page);

    // 同样以改写真实响应的方式模拟"表房卡已填完"（唯一 countable 字段 water_reading 有值）
    await page.route(TODAY_URL, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as TodayBody;
      const water = body.cards.find((c) => c.key === 'water');
      const reading = water?.fields.find((f) => f.name === 'water_reading');
      if (water && reading) {
        reading.value = '49239.0';
        reading.filled = true;
        water.badge.filled = 1;
        water.badge.pending = 0;
        body.progress.filled += 1;
        body.progress.pending -= 1;
      }
      await route.fulfill({ response: res, body: JSON.stringify(body) });
    });

    await page.reload();
    const badge = page.getByTestId('card-badge-water');
    await expect(badge).toHaveAttribute('data-tone', 'done');
    await expect(badge).toHaveText('已填');
  });
});
