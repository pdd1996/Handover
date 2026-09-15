<script setup lang="ts">
/**
 * 师傅端 H5 根组件（TK-05）。
 *
 * 职责：登录态管理 + 首页与板块页的两级视图切换。
 *
 * **不引入 vue-router**：TK-05 只需"首页 ↔ 板块页"两级，用组件状态切换即可；PRD §6.0 的其余页面
 * （交接确认、预警中心、历史记录）分属 TK-18/Phase 2/TK-2x，届时页面数上来再统一决定路由方案，
 * 避免此刻为两级视图先定一套路由架构、随后被 TK-06/TK-18 的需求推翻。
 *
 * 认证走 HttpOnly Cookie（契约 §1、D-T13）：令牌由浏览器自动携带，前端不持有；
 * 刷新页面后靠 GET /auth/me 恢复登录态（401 则回登录页）。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { showToast } from 'vant';
import {
  CARD_BY_FIELD,
  CARD_BY_KEY,
  FIELD_BY_NAME,
  FIELD_NAMES,
  buildValidationError,
  isFilledValue,
  DECREASED_GUARD_FIELDS,
  PREV_BACKFILL_FIELDS,
  toMissingField,
  unconfirmedNeedConfirmItems,
  validateElevatorChecks,
  validateFields,
  validatePrevBackfillReadings,
  type ConfirmItem,
  type ConfirmationPayload,
  type DecreasedGuardField,
  type ElevatorCheckPayload,
  type ElevatorExpectedDto,
  type FieldValueGetter,
  type FormOptionsDto,
  type MissingField,
  type PendingRecordDto,
  type PrevBackfillField,
  type PrevDto,
  type PreviewDto,
  type RecordDetailDto,
  type SubmitPayloadDto,
  type TodayDto,
  type UsageOverridePayload,
} from '@handover/shared';
import { ApiRequestError, NetworkError, api, type AuthUser } from './api/client';
import TodayView from './views/TodayView.vue';
import SectionView from './views/SectionView.vue';
import ConfirmView from './views/ConfirmView.vue';
import { useDraft } from './store/draft';
import {
  enqueueQueueItem,
  getQueueItem,
  loadQueueItems,
  patchQueueItem,
  queueItemKey,
  queueTimestamp,
  removeQueueItem,
  type SyncQueueItem,
} from './store/sync-queue';

/** L2（评审修复轮）：业务拒绝达此次数后停止自动重试，留存待科长处置（防无限循环） */
const MAX_DRAIN_ATTEMPTS = 5;

const draft = useDraft();

const user = ref<AuthUser | null>(null);
const today = ref<TodayDto | null>(null);
/** 当前打开的板块页卡片 key；null 表示停留在首页 */
const activeCardKey = ref<string | null>(null);
const booting = ref(true);
const loadingToday = ref(false);

const loginForm = ref({ username: '', password: '' });
const loggingIn = ref(false);

const activeCard = computed(
  () => today.value?.cards.find((c) => c.key === activeCardKey.value) ?? null,
);

/** 开发构建标记（Vite 标准）：生产构建不含种子账号提示，避免泄露开发凭据线索 */
const isDev = import.meta.env.DEV;

/**
 * 上一班带出（TK-07，m1/m2 已随 TK-08 收敛到本组件）：**App 级按 duty_date 缓存**——
 * 同班次内开任意卡复用同一份响应（原实现在 SectionView 每开一卡重复拉取），
 * 跨班次（duty_date 变化）由 loadPrev 自动重取。
 */
const prevInfo = ref<PrevDto | null>(null);
const prevCache = ref<{ dutyDate: string; dto: PrevDto } | null>(null);

/**
 * 表单候选配置（TK-11，DATA-07）：App 级拉取、**会话级缓存**——backToToday 每次返回
 * 首页都会经 loadToday 调到 loadConfigs，已拉到即复用不再重发（评审 M3，与 TK-07 评审
 * m1 对 /prev 的结论同口径，C-01 填写效率优先）；resetSession 清空后（重新登录）才重拉。
 * 拉取失败/离线时置 null：SectionView 回落种子占位候选渲染，不阻塞填写。
 */
const configs = ref<FormOptionsDto | null>(null);

/**
 * 电梯逐台预期状态（TK-17，ELE-03；D-T22 只读计算）：打开电梯板块时拉取（核对时刻 =
 * 服务端响应 check_time，锁定入草稿）。与 configs 同为渲染辅助数据：拉取失败静默降级——
 * SectionView 回落草稿快照（`elevator_expected`，随草稿持久化即离线可用），再不行提示
 * 需联网获取，不阻塞其它卡填写。
 */
const elevatorExpected = ref<ElevatorExpectedDto | null>(null);

/**
 * 待确认列表与交接确认页状态（TK-18，F2-02/F2-03）：登录后按角色拉取（仅 master——
 * 待确认入口是接班人的待办，契约 §3.4 角色列 master）；confirming 打开列表页，
 * confirmDetail 打开单份详情（逐项浏览，标红置顶）。拉取失败静默降级为无入口
 * （只读待办，不阻塞填写主链路），401 并入 handleSessionLoss 单一入口。
 */
const pendingItems = ref<PendingRecordDto[]>([]);
const confirming = ref(false);
const confirmDetail = ref<RecordDetailDto | null>(null);
const detailLoading = ref(false);

async function loadPending(): Promise<void> {
  if (user.value?.role !== 'master') {
    pendingItems.value = [];
    return;
  }
  try {
    pendingItems.value = [...(await api.pending()).items];
  } catch (err) {
    if (!handleSessionLoss(err)) pendingItems.value = [];
  }
}

/** 打开待确认列表（TodayView 醒目入口） */
function openConfirm(): void {
  confirming.value = true;
}

/** 打开单份交接单详情（F2-03 逐项浏览） */
async function openPendingItem(id: number): Promise<void> {
  detailLoading.value = true;
  try {
    confirmDetail.value = await api.recordDetail(id);
  } catch (err) {
    if (!handleSessionLoss(err)) notify(err);
  } finally {
    detailLoading.value = false;
  }
}

/** 确认页返回：详情态回列表，列表态回首页 */
function onConfirmBack(): void {
  if (confirmDetail.value) {
    confirmDetail.value = null;
    // 回列表前刷新：确认状态可能已变（TK-19 归档后单据消失），计数与实际保持一致（F2-02-T1）
    void loadPending();
    return;
  }
  confirming.value = false;
}

/** 电梯卡 key（shared cards 字典中 kind='elevator' 的唯一卡；跳转定位与打开监听共用） */
const ELEVATOR_CARD_KEY =
  Object.values(CARD_BY_KEY).find((c) => c.kind === 'elevator')?.key ?? 'elevator';

async function loadElevatorExpected(): Promise<void> {
  try {
    const dto = await api.elevatorsExpected();
    elevatorExpected.value = dto;
    // 预期快照随草稿持久化（D-T18）：离线重开卡仍可展示已拉到的逐台预期；已核对行的
    // expected/check_time 在草稿核对项内锁定（ELE-05），不受快照刷新影响
    draft.setValue('elevator_expected', JSON.parse(JSON.stringify(dto)));
  } catch (err) {
    // 401 并入单一入口；其余失败保留旧值（若有）——快照仅是展示辅助，不弹错不阻塞
    handleSessionLoss(err);
  }
}

/**
 * 待同步队列（TK-15，F1-06/F1-07）：离线提交的交接单在本机 IndexedDB 排队（服务器零感知，
 * F1-07-T2），恢复网络后自动上传（D-P07 排队送达，顺序即提交顺序）。本 ref 是 UI 展示与
 * 排空引擎的内存镜像，任何队列变动后经 refreshQueue 重读。EVT-04/EVT-05 埋点挂 TK-30。
 */
const queueItems = ref<SyncQueueItem[]>([]);
const syncing = ref(false);
/**
 * 会话代次（评审修复轮 M5）：resetSession 自增；排空循环内比对，登出/被动 401 后
 * 立即放弃本轮，不得再触达已清空的 user/today。
 */
let sessionEpoch = 0;
/** M4（评审修复轮）：排空在途期间发生过草稿补改（不可能进入已上传/在传的快照） */
let patchedDuringSync = false;
/** L5（评审修复轮）：本机全部待同步单数（不分账号、不含内容）——登录页提示用 */
const deviceQueueCount = ref(0);
/** F1-14 强提醒的会话内已知晓标记（M1 修复轮：跨班次单不可由师傅同步，提醒可确认后收起） */
const syncRemindAck = ref(false);

async function refreshQueue(): Promise<void> {
  queueItems.value = user.value ? await loadQueueItems(user.value.id) : [];
}

/** L5：本机（不分账号）待同步单计数；登录页据此提示「请用原账号登录完成同步」 */
async function refreshDeviceQueueCount(): Promise<void> {
  deviceQueueCount.value = (await loadQueueItems()).length;
}

/**
 * F1-14 强提醒口径：队列项的班次日期早于当前班次（滞留过夜/跨班次未同步）。以 duty_date
 * 而非入队自然日比较——班次分界（C-08，08:30）之后的同日滞留同样意味着该单已不属于当前
 * 班次，是强提醒的正确触发点；打开页面首要展示。**处置口径（评审修复轮 M1，D-T20 修订）**：
 * 跨班次滞留单**不可由师傅同步**（服务端 submit 只认当前班次，上传必然落错日期），overlay
 * 给出「需科长处理」指引，师傅确认后收起（会话内不再重复弹出，队列项保留、数据不丢）。
 */
const staleQueueItems = computed(() => {
  const duty = today.value?.duty_date;
  if (!duty) return [];
  return queueItems.value.filter((i) => i.duty_date < duty);
});
const showSyncRemind = computed(() => staleQueueItems.value.length > 0 && !syncRemindAck.value);
/** L2：是否有多次同步失败的单（overlay 内提示联系科长，不新增交互面） */
const hasHardFailedItems = computed(() =>
  queueItems.value.some((i) => i.attempts >= 3 || i.last_error !== null),
);

/**
 * 登录态清理**单一入口**（TK-06 评审遗漏一，二次评审订正）：**已建立登录态后的失效**——
 * 被动掉线（handleSessionLoss 的 401 分支：会话过期/账号被停用）与主动登出（onLogout）、
 * 以及启动恢复失败（bootstrap 的静默 catch）都必须走这里；清空项新增/删减只改本函数，
 * 不得在分支里各写一份。边界：**登录请求自身的 401（F1-11-T2/T3 密码错/停用）不走这里**——
 * 此刻本无会话可言，误清会丢用户本机草稿（违反 F1-09 续填，D-T18 修订 #9）。
 * 清空范围：**仅会话内内存草稿**——持久草稿按 D-T18 修订 #9 保留至该班次出现已提交记录
 * （登出/会话失效不删本机草稿：弱信号点位长时间填写不因掉线丢整班数据，PRD §7 双保险；
 * 串值防护由用户+班次 keying 承担，C-05）；带出数据与 duty_date 缓存一并清。
 */
function resetSession(): void {
  user.value = null;
  today.value = null;
  activeCardKey.value = null;
  prevInfo.value = null;
  prevCache.value = null;
  configs.value = null;
  elevatorExpected.value = null;
  pendingItems.value = [];
  confirming.value = false;
  confirmDetail.value = null;
  detailLoading.value = false;
  queueItems.value = [];
  syncing.value = false; // M5（评审修复轮）：登出/会话失效打断在途排空，不得残留锁
  sessionEpoch += 1;
  syncRemindAck.value = false;
  draft.clearMemory();
  void refreshDeviceQueueCount(); // L5：回登录页时统计本机未同步单（不含内容）
}

/**
 * 已建立登录态后的 401 → 会话失效（会话过期/已登出/账号被停用，契约 §3.1 鉴权失败统一 401）
 * → resetSession 单一入口。返回是否发生了清理，供调用方决定降级方式。
 * TK-07 评审 m2：/prev 拉取的 401 原先在 SectionView 被静默吞掉，现与本判断汇流（不再各写一份）。
 */
function handleSessionLoss(err: unknown): boolean {
  if (
    err instanceof ApiRequestError &&
    err.status === 401 &&
    user.value !== null // 仅已登录态下的被动掉线；登录请求自身的 401 不得清草稿（见 resetSession 注）
  ) {
    resetSession();
    return true;
  }
  return false;
}

/** 错误提示：业务错误用服务端文案（C-09 禁止模糊提示），网络错误用本地文案 */
function notify(err: unknown): void {
  handleSessionLoss(err);
  const message = err instanceof Error ? err.message : '操作失败，请重试';
  showToast(message);
}

/**
 * 上一班带出拉取（TK-07 评审 m1/m2）：按 duty_date 缓存，同班次只拉一次；401 并入
 * handleSessionLoss 单一入口；其余失败（网络/离线，TK-15 接管）静默降级为「无比对值」——
 * 带出是只读辅助信息，不弹错、不阻塞填写。
 */
async function loadPrev(): Promise<void> {
  const dutyDate = today.value?.duty_date;
  if (!dutyDate) return;
  if (prevCache.value?.dutyDate === dutyDate) {
    prevInfo.value = prevCache.value.dto;
    return;
  }
  try {
    const dto = await api.prev();
    prevCache.value = { dutyDate, dto };
    prevInfo.value = dto;
  } catch (err) {
    if (!handleSessionLoss(err)) prevInfo.value = null;
  }
}

async function loadToday(): Promise<void> {
  loadingToday.value = true;
  try {
    today.value = await api.today();
    void loadPrev();
    void loadConfigs();
    void loadPending(); // TK-18：接班人待确认入口（F2-02），仅 master 角色实际拉取
    // F1-09 续填入口：登录态 + 班次键就绪后恢复持久草稿；恢复了有内容的草稿则给
    // 「草稿恢复提示」（PRD §6.1 设计触点）。restore 同键幂等（backToToday 重复调用不重灌）
    if (user.value && (await draft.restore(user.value.id, today.value.duty_date))) {
      showToast('已恢复本班次未提交的草稿');
    }
    // TK-15：登录态/班次就绪后重读待同步队列并顺势自动排空（到院内网打开页面的常态路径）。
    // M1（评审修复轮）：跨班次滞留单在排空内被跳过（不可上传），强提醒 overlay 与自动排空
    // 不再互斥——滞留项永远不会被自动传走，提醒首要展示的语义由 overlay 自身保证
    await refreshQueue();
    if (queueItems.value.length > 0) void drainQueue(true);
  } catch (err) {
    notify(err);
  } finally {
    loadingToday.value = false;
  }
}

/**
 * 表单候选配置拉取（TK-11）：**会话级缓存（评审 M3）**——已拉到即复用，否则每次
 * 返回首页都会重发；401 并入 handleSessionLoss 单一入口；其余失败（网络/离线，
 * TK-15 接管）静默降级为回落候选——候选是渲染辅助数据，不弹错、不阻塞填写。
 */
async function loadConfigs(): Promise<void> {
  if (configs.value !== null) return;
  try {
    configs.value = await api.configs();
  } catch (err) {
    if (!handleSessionLoss(err)) configs.value = null;
  }
}

async function bootstrap(): Promise<void> {
  try {
    user.value = await api.me(); // Cookie 仍有效则直接进首页
    await loadToday();
  } catch {
    // 未登录或会话过期，静默回登录页（不必弹错）；草稿随登录态一并清内存（resetSession 单一入口）。
    // 持久草稿不动（D-T18 修订 #9）：按用户+班次 keying，只可能被同一人同班次恢复，无串值风险（C-05）
    resetSession();
  } finally {
    booting.value = false;
    void refreshDeviceQueueCount(); // L5：登录页可能需要展示「本机有未同步单」
  }
}

async function onLogin(): Promise<void> {
  const { username, password } = loginForm.value;
  if (!username.trim() || !password) {
    showToast('请输入账号与密码');
    return;
  }
  loggingIn.value = true;
  try {
    const res = await api.login(username.trim(), password);
    user.value = res.user;
    loginForm.value = { username: '', password: '' };
    await loadToday();
  } catch (err) {
    // F1-11-T2/T3：账号密码错误与账号停用均由服务端给出确定文案，前端不自行判断账号是否存在
    notify(err);
  } finally {
    loggingIn.value = false;
  }
}

async function onLogout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // 登出失败也清本地态：会话存根可能已失效，卡在页面反而更糟
  }
  // 本人登出：仅清会话内内存（持久草稿保留至该班次提交成功，D-T18 修订 #9）；
  // 换账号不得串值由 keying 保证（C-05）
  resetSession();
}

/** 打开板块填写页（F1-02-T2）；M4（评审修复轮）：同步在途不开新卡，压缩在途补改窗口 */
function openCard(key: string): void {
  if (syncing.value) {
    showToast('正在同步，请稍候');
    return;
  }
  activeCardKey.value = key;
}

// 电梯核对（TK-17）：进入电梯卡即拉取逐台预期（核对时刻=响应 check_time，锁定入草稿）。
// 用 watch 而非在 openCard 内判断：bootstrap 恢复到卡内、返回重开等路径同样触发
watch(activeCard, (card) => {
  if (card?.kind === 'elevator') void loadElevatorExpected();
});

/** 返回首页并重取汇总：TK-06 起填写会改动角标与进度条，返回即需刷新（F1-03「实时汇总」） */
async function backToToday(): Promise<void> {
  activeCardKey.value = null;
  await loadToday();
}

/**
 * 提交前汇总预览与提交（TK-12，F1-10/F2-01/DATA-09/10）：
 * 点击「提交交接单」→ 先调 POST /preview 取未填项/异常项两张点名清单 → 弹窗展示，
 * 未填项清零前提交按钮置灰；确认提交后服务端生成正式交接单（F2-01），成功后
 * **必须调 draft.markSubmitted**（D-T18 修订 #9：持久草稿清除时点 = 该班次出现已提交记录，
 * 否则重开页面旧草稿复活并以「草稿 ?? 服务端值」优先于服务端真值）。
 * 修改接班人（DATA-10）的候选人员接口随 TK-26 排班后台落地后接入，本阶段仅展示带出值。
 */
const showPreview = ref(false);
const preview = ref<PreviewDto | null>(null);
const submitting = ref(false);
/** 离线预检模式（TK-15）：预览来自本地 shared 校验引擎而非服务端，提交走向本机待同步队列 */
const offlinePreviewMode = ref(false);

/**
 * 防呆确认（TK-14，F1-12/F1-13）：submit 返 409 时服务端在 `need_confirm` 下发命中清单
 * （契约 §4 第 2 步），弹窗逐条收集原因后组装 `confirmations` 随重提上送——原因随
 * audit_logs.reason 留痕；不带确认直接重提仍被拒（F1-12-T2，服务端不因重试而放行）。
 */
const pendingConfirms = ref<ConfirmItem[] | null>(null);
const confirmReasons = ref<Record<string, string>>({});
const collectedConfirms = ref<ConfirmationPayload[]>([]);

/**
 * 提交 payload：**全字典合并视图（评审修复轮 M5）**——「草稿 ?? 服务端值」与首页角标同一
 * 取值口径，未填字段显式上送 null。单发草稿会漏掉服务端已有值（撤回重提时本机草稿已被
 * markSubmitted 清空，payload 近乎全空），单发服务端值则清空的字段会回落旧值；两者都不是
 * 快照。服务端另有快照兑底（字典存储列未上送一律写 NULL），两道防线互为补充。
 */
function buildPayload(): SubmitPayloadDto {
  const sections: Record<string, unknown> = {};
  for (const card of today.value?.cards ?? []) {
    for (const field of card.fields) {
      const d = draft.getValue(field.name as never);
      sections[field.name] = d !== null ? d : (field.value ?? null);
    }
  }
  // 用量手工覆盖（TK-13，F3-04/F3-06）：lo_day_use 草稿有值即视为师傅改写了自动推荐值，
  // 随附原因上送（sections 里的 *_use 键服务端不采信，覆盖必须显式走本清单）；原因空白
  // 由服务端 400 点名拦截（F3-06-T2），SectionView 完成本卡时已先行预检同口径
  const usage_overrides: UsageOverridePayload[] = [];
  const loOverride = draft.getValue('lo_day_use');
  if (isFilledValue(loOverride)) {
    usage_overrides.push({
      field: 'lo_day_use',
      value: String(loOverride),
      reason: String(draft.getValue('usage_override_reason') ?? ''),
    });
  }
  // 补录上一班读数（TK-14，F3-07/D-T19）：上一班缺失态下师傅补录的相邻班次读数
  // （SectionView 补录入口写入草稿 `prev_backfill:*`），随 payload 上送——服务端仅在
  // 缺失态消费（有上一班记录时忽略），白名单键集 shared PREV_BACKFILL_FIELDS
  const prev_readings: Partial<Record<PrevBackfillField, unknown>> = {};
  for (const f of PREV_BACKFILL_FIELDS) {
    const v = draft.getValue(`prev_backfill:${f}`);
    if (isFilledValue(v)) prev_readings[f] = v;
  }
  // 逐台电梯核对（TK-17，D-T22）：草稿核对项随 payload 上送（含锁定的 check_time/expected；
  // 服务端按 check_time 重算 expected 落库，客户端值仅为展示留痕）。仅上送已核对的行
  const draftChecks = draft.getValue('elevator_checks');
  const elevator_checks = Array.isArray(draftChecks)
    ? (draftChecks as ElevatorCheckPayload[]).filter(
        (c) =>
          c != null &&
          typeof c === 'object' &&
          typeof (c as ElevatorCheckPayload).actual === 'string',
      )
    : [];
  const payload: SubmitPayloadDto = { sections };
  if (usage_overrides.length > 0) payload.usage_overrides = usage_overrides;
  if (Object.keys(prev_readings).length > 0) payload.prev_readings = prev_readings;
  if (elevator_checks.length > 0) payload.elevator_checks = elevator_checks;
  if (collectedConfirms.value.length > 0) payload.confirmations = collectedConfirms.value;
  return payload;
}

/**
 * 离线预检（TK-15，F1-07）：网络不可用时的本地降级预览——与服务端 preview 同口径：
 * shared validateFields 同一引擎（F1-08）、用量覆盖原因空白同 F3-06-T2 点名、异常项同
 * abnormalFieldsOf 口径（状态选「坏」，enums OkBadStatus）。接班人修改原因的条件必填
 * 不参与（h5 无人员候选接口不显式上送 receiver_id，挂 TK-26）。
 */
function offlinePreviewOf(): PreviewDto {
  const payload = buildPayload();
  const sections = payload.sections as Record<string, unknown>;
  const get: FieldValueGetter = (name) => sections[name] ?? null;
  const result = validateFields(
    FIELD_NAMES.filter((name) => name !== 'receiver_change_reason'),
    get,
  );
  const missing = [...result.missing];
  if (payload.usage_overrides?.some((o) => o.field === 'lo_day_use' && !String(o.reason).trim())) {
    missing.push(toMissingField('lo_day_use'));
  }
  // L1（评审修复轮）：补录读数合法性纳入离线预检（shared validatePrevBackfillReadings
  // 与 api 同一实现）——脏基线不再拖到同步时刻被 400 拒而滞留。枚举越值与 confirmations
  // 超长两段不参与：前者控件候选取自 shared 常量无漂移源，后者受 maxlength=200 约束
  const outOfRange = [...result.outOfRange];
  outOfRange.push(...validatePrevBackfillReadings(payload.prev_readings).outOfRange);
  // 电梯核对（TK-17，D-T22）：不一致未填说明纳入离线预检（shared validateElevatorChecks
  // 与 api 同一实现；expected 以草稿锁定值兑底——配置离线期被改的极端情形由同步时刻
  // 服务端复验兜住，滞留单走既有 last_error 链路）。说明缺失即拦入队（ELE-04-T2 同口径，
  // 否则队列项在同步时刻被 409 拒而滞留，D-T20 M6 同理）
  const elevatorCheck = validateElevatorChecks(
    payload.elevator_checks,
    (id) => payload.elevator_checks?.find((c) => c.elevator_id === id)?.expected ?? null,
  );
  missing.push(...elevatorCheck.explanationMissing);
  outOfRange.push(...elevatorCheck.outOfRange);
  const body = buildValidationError({ missing, outOfRange });
  return {
    duty_date: today.value?.duty_date ?? '',
    missing_fields: body ? body.missing_fields : [],
    abnormal_fields: FIELD_NAMES.filter(
      (name) => FIELD_BY_NAME[name].kind === 'status' && sections[name] === 'bad',
    ).map(toMissingField),
  };
}

/**
 * 离线防呆预检（TK-15）：shared guard 同源判定 + need_confirm 组装（与 api 提交侧同一
 * unconfirmedNeedConfirmItems），基线取本机缓存的上一班带出（prevInfo，App 级缓存），
 * 缺失态以本机补录值兑底（与服务端 prev_readings 消费同向）。离线无服务端 409 补救
 * 路径，确认收集必须前置到入队前——否则队列项会在同步时刻被 409 拒绝而滞留。
 */
function offlineNeedConfirm(): ConfirmItem[] {
  const payload = buildPayload();
  const sections = payload.sections as Record<string, unknown>;
  const cur: FieldValueGetter = (name) => sections[name] ?? null;
  const prevGet: FieldValueGetter = (name) => {
    const fromPrev = prevInfo.value?.prev?.readings?.[name];
    return fromPrev != null
      ? fromPrev
      : (payload.prev_readings?.[name as PrevBackfillField] ?? null);
  };
  // M6（评审修复轮）：会话内已收集的确认**按项扣除**，只报本轮新增未确认项——
  // 原实现「collectedConfirms 非空即整块跳过预检」，改后的新回退读数会带着旧确认
  // 入队，服务端按 field 消费即绕过防呆（探针 P3 实证）
  const confirmedDecreased = new Set<DecreasedGuardField>();
  const confirmedRefills = new Set<1 | 2>();
  for (const c of collectedConfirms.value) {
    if (
      c.type === 'reading_decreased' &&
      c.field &&
      (DECREASED_GUARD_FIELDS as readonly string[]).includes(c.field)
    ) {
      confirmedDecreased.add(c.field as DecreasedGuardField);
    } else if (c.type === 'gas_refill' && c.card) {
      confirmedRefills.add(c.card);
    }
  }
  return unconfirmedNeedConfirmItems(cur, prevGet, confirmedDecreased, confirmedRefills);
}

/**
 * 离线入队（F1-07-T1）：离线「提交」仅进本机待同步队列并提示——**尚未完成交接**
 * （D-P07：上传成功那一刻才算正式提交）。持久草稿不清（清除时点=同步成功，D-T18
 * 修订 #9 同源）；队列项 payload 随草稿自动保存刷新（D-T20）。EVT-04 sync_queued 挂 TK-30。
 */
async function enqueueOffline(): Promise<void> {
  if (!user.value || !today.value) return;
  const item: SyncQueueItem = {
    id: queueItemKey(user.value.id, today.value.duty_date),
    user_id: user.value.id,
    duty_date: today.value.duty_date,
    payload: buildPayload(),
    queued_at: queueTimestamp(),
    attempts: 0,
    last_error: null,
  };
  // m2（评审修复轮）：同班次重提保留既有诊断（attempts/last_error）——否则反复入队
  // 会抹掉「上次同步失败原因」，滞留单在强提醒里失去可解释性；归零只随一次同步成功
  const existing = await getQueueItem(item.id);
  item.attempts = existing?.attempts ?? 0;
  item.last_error = existing?.last_error ?? null;
  const ok = await enqueueQueueItem(item);
  await refreshQueue();
  showPreview.value = false;
  offlinePreviewMode.value = false;
  pendingConfirms.value = null;
  if (ok) {
    // M6（评审修复轮）：入队快照已携带本轮确认，会话内必须归零——否则它们会附着到
    // 后续提交（含在线重提），被服务端按 field 消费而绕过防呆（探针 P3 实证路径）
    collectedConfirms.value = [];
    showToast('尚未完成交接，请回到院内网络完成同步');
  } else {
    showToast('当前离线且本机存储不可用，交接单未能暂存，请勿关闭页面');
  }
  void refreshDeviceQueueCount(); // L5：本机未同步单数变化
}

/**
 * 排空待同步队列（TK-15，F1-06「恢复网络自动上传」）：按 queued_at 升序逐单上传
 * （排队送达，D-T10），上传成功才算正式提交（D-P07）。失败分类（评审修复轮 M1/M2/M5）：
 * - 跨班次滞留单 → **禁止上传**（服务端 submit 只认当前班次 C-08，上传必然落错日期），
 *   固化为「需科长处理」并跳过（D-T20 修订；补交能力待决策定案）；
 * - 网络仍不可用 → 停止本轮（队列原状，恢复后重试）；手动触发时显式提示（L3）；
 * - 401 会话失效 → 并入 handleSessionLoss 单一入口后停止；
 * - RECORD_EXISTS 409 → 仅同班次语义下自愈移除（M2：跨班次项根本不会被上传）；
 * - 其余 400/409（校验/防呆）→ 原因固化在队列项并继续后续单；达重试上限（L2）后
 *   停止自动重试，留存待科长处置。EVT-05 sync_result 埋点挂 TK-30。
 */
async function drainQueue(silent = false): Promise<void> {
  if (syncing.value || !user.value || !today.value) return; // M3：today 未就绪不排空
  const uid = user.value.id; // M5：循环内不再触达 user.value（跨 await 后可空）
  const epoch = sessionEpoch;
  syncing.value = true;
  patchedDuringSync = false;
  let draftClearFailed = false;
  let synced = 0;
  let skippedStale = 0;
  let blockedByNetwork = false;
  /** 已确认上传成功的班次集合：无论本轮是否中途失效（登出/401），退出前统一冲账清草稿 */
  const submittedDuties = new Set<string>();
  try {
    for (const item of await loadQueueItems(uid)) {
      if (epoch !== sessionEpoch || !user.value || !today.value) break; // M5：会话已失效
      if (item.duty_date !== today.value.duty_date) {
        // M1（评审修复轮）：跨班次滞留单不可上传，固化为「需科长处理」
        skippedStale += 1;
        await patchQueueItem(item.id, {
          last_error: `该单属班次 ${item.duty_date}，已过班次分界，需科长处理`,
        });
        continue;
      }
      if (item.attempts >= MAX_DRAIN_ATTEMPTS) continue; // L2：停止自动重试，留存待处置
      try {
        await api.submit(item.payload);
        await removeQueueItem(item.id);
        synced += 1;
        submittedDuties.add(item.duty_date);
      } catch (err) {
        if (err instanceof NetworkError) {
          blockedByNetwork = true; // 网络仍不可用：正常中止本轮，队列原状
          break;
        }
        if (!(err instanceof ApiRequestError)) {
          // M5（评审修复轮）：编程错误不得伪装成网络失败静默吞掉
          console.error('drainQueue 内部错误', err);
          await patchQueueItem(item.id, {
            attempts: item.attempts + 1,
            last_error: '同步发生内部错误，请重试或联系管理员',
          });
          break;
        }
        if (err.status === 401) {
          handleSessionLoss(err);
          break;
        }
        if (err.status === 409 && err.body.code === 'RECORD_EXISTS') {
          // M2（评审修复轮）：自愈仅在同班次语义下成立（跨班次项已在上方被拦截），
          // 此时 409 才真正等价于「该班次已有已提交记录」（换设备已同步等）
          await removeQueueItem(item.id);
          synced += 1;
          continue;
        }
        if (
          !(await patchQueueItem(item.id, {
            attempts: item.attempts + 1,
            last_error: err.body.message,
          }))
        ) {
          showToast('同步失败原因记录失败（本机存储不可用）'); // L6
        }
      }
    }
    // D-T18 修订 #9 / D-T20：清除时点 = 该班次出现已提交记录——**统一冲账**（M3 修复轮）
    // 放在循环外：即便本轮中途会话失效（登出/401），已确认上传成功的班次草稿也必须清除，
    // 否则旧草稿复活压服务端真值；markSubmitted 按用户+班次 keying，不依赖存活会话。
    // 清除失败必须可见，与在线提交路径同口径
    for (const d of submittedDuties) {
      if (!(await draft.markSubmitted(uid, d))) draftClearFailed = true;
    }
    await refreshQueue();
    if (draftClearFailed) showToast('本机草稿清除失败，请重开页面核对');
    if (user.value && synced > 0) {
      // M4（评审修复轮）：同步在途期间的补改不可能包含在已上传快照中，显式可见（C-09）
      const note = patchedDuringSync ? '；注意：同步期间的新修改未包含在交接单中，请核对' : '';
      showToast(`同步成功，交接单已正式提交${synced > 1 ? ` ${synced} 张` : ''}${note}`);
      collectedConfirms.value = []; // M6：已消费的确认不得附着到后续提交
      await loadToday();
    } else if (user.value && !silent && blockedByNetwork) {
      // L3（评审修复轮）：手动同步但网络仍不可达，必须给出反馈
      showToast(`仍无法连接院内网络，本机待同步 ${queueItems.value.length} 张`);
    } else if (user.value && !silent && skippedStale > 0) {
      showToast(`有 ${skippedStale} 张交接单已过班次分界，需科长处理`);
    }
  } finally {
    syncing.value = false;
  }
}

async function onOpenPreview(): Promise<void> {
  if (syncing.value) {
    showToast('正在同步，请稍候'); // M4（评审修复轮）：同步在途不接受新提交
    return;
  }
  try {
    preview.value = await api.preview(buildPayload());
    offlinePreviewMode.value = false;
    showPreview.value = true;
  } catch (err) {
    if (err instanceof ApiRequestError) {
      notify(err);
      return;
    }
    // 网络不可用（TK-15）：预览降级为本地同口径预检（shared 校验引擎），提交走向本机队列
    preview.value = offlinePreviewOf();
    offlinePreviewMode.value = true;
    showPreview.value = true;
  }
}

/**
 * 点击预览清单项 → 关弹窗跳到对应卡片并滚动定位到字段（C-09「点击跳转可达」，
 * 字段 → 卡片映射用 shared CARD_BY_FIELD 单一来源；电梯核对行 `elevator:{id}` 的
 * 明细不在 CARD_BY_FIELD（records 无对应列）——特判路由到电梯卡，锚点行由 SectionView
 * 以同一 fieldAnchor 生成，两端必然对齐（TK-17）
 */
async function jumpFromPreview(item: MissingField): Promise<void> {
  const cardKey =
    typeof item.field === 'string' && item.field.startsWith('elevator:')
      ? ELEVATOR_CARD_KEY
      : (CARD_BY_FIELD[item.field as keyof typeof CARD_BY_FIELD] ?? null);
  showPreview.value = false;
  if (!cardKey) return;
  activeCardKey.value = cardKey;
  await nextTick();
  window.setTimeout(() => {
    document
      .getElementById(item.anchor.slice(1))
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 200);
}

async function onConfirmSubmit(): Promise<void> {
  if (!today.value || submitting.value) return;
  submitting.value = true;
  try {
    const result = await api.submit(buildPayload());
    // D-T18 修订 #9：提交成功即清本班次持久草稿（TK-12 挂账钩子）；清除失败必须可见
    // （评审修复轮 L2：静默吞掉会让旧草稿在重开页面后压过服务端真值）
    const cleared = await draft.markSubmitted(user.value!.id, today.value.duty_date);
    showPreview.value = false;
    offlinePreviewMode.value = false;
    collectedConfirms.value = [];
    pendingConfirms.value = null;
    showToast(
      cleared
        ? `提交成功，交接单号 ${result.record_no}`
        : `提交成功（${result.record_no}），本机草稿清除失败，请重开页面核对`,
    );
    await loadToday(); // 重取汇总：首页状态转「已提交」、提交入口随之隐藏
  } catch (err) {
    if (err instanceof NetworkError) {
      // 网络不可用（TK-15，F1-07）：离线提交仅入本机待同步队列（D-P07 上传成功才算正式提交）。
      // M6（评审修复轮）：预检**始终执行**，已确认项按项扣除（confirmed 集传入），只对
      // 本轮新增未确认项要求确认——原「收过一次确认就整块跳过」会让新回退读数带着旧
      // 确认入队，服务端按 field 消费即绕过防呆（探针 P3 实证）
      const items = offlineNeedConfirm();
      if (items.length > 0) {
        showPreview.value = false;
        offlinePreviewMode.value = false;
        pendingConfirms.value = items;
        confirmReasons.value = {};
        return;
      }
      await enqueueOffline();
      return;
    }
    if (err instanceof ApiRequestError && err.status === 400 && err.body.missing_fields) {
      // 服务端复验拦下（C-09）：把点名清单回填预览弹窗逐条展示，不关窗
      showServerMissingFields(err);
      return;
    }
    if (err instanceof ApiRequestError && err.status === 409) {
      const items = err.body.need_confirm;
      if (items && items.length > 0) {
        // 防呆待确认（TK-14，F1-12/F1-13）：弹窗逐条收原因后重提（契约 §4 第 2 步），
        // 不关预览数据、不清草稿——取消后可稍后重提
        showPreview.value = false;
        pendingConfirms.value = items;
        confirmReasons.value = {};
        return;
      }
      // M1（评审修复轮）：电梯说明缺失等 **带 missing_fields 的 409**（契约 §2 同构点名载体）
      // 与 400 同处理——原实现落进「其余 409」分支，只留一句 toast：逐条点名 + 点击跳转（C-09）
      // 在电梯场景失效，且 `collectedConfirms` 被清会让本轮已收的防呆确认作废（重提再 409 往返）
      if (err.body.missing_fields && err.body.missing_fields.length > 0) {
        showServerMissingFields(err);
        return;
      }
      // 其余 409（当日已提交等）：提示后回首页重取
      collectedConfirms.value = [];
      showPreview.value = false;
      showToast(err.body.message);
      await loadToday();
      return;
    }
    notify(err);
  } finally {
    submitting.value = false;
  }
}

/**
 * 服务端点名清单回填预览弹窗（C-09「逐条点名 + 点击跳转定位」的客户端兑现，TK-12 400 与
 * TK-17 评审修复轮 M1 的 409 共用）：**不关弹窗、不清 collectedConfirms、不重取首页**——
 * 三者任一都会让用户已完成的确认/已看到的定位线索静默丢失。
 */
function showServerMissingFields(err: ApiRequestError): void {
  preview.value = {
    duty_date: today.value?.duty_date ?? '',
    missing_fields: err.body.missing_fields ?? [],
    abnormal_fields: preview.value?.abnormal_fields ?? [],
  };
  showPreview.value = true;
  showToast(err.body.message);
}

/** 防呆确认项的稳定键（原因收集与重提组装按项对应；gas_refill 无 field，按卡号区分） */
function confirmKeyOf(item: ConfirmItem): string {
  return item.type === 'gas_refill' ? `gas_refill:${item.card}` : `reading_decreased:${item.field}`;
}

/**
 * 确认弹窗提交（F1-12-T1）：逐项收齐原因后组装 confirmations 并重提——原因随
 * audit_logs.reason 留痕；若服务端仍报 409（如另有命中项），确认弹窗会再次打开。
 */
async function onConfirmResubmit(): Promise<void> {
  if (submitting.value) return;
  const list: ConfirmationPayload[] = [];
  for (const item of pendingConfirms.value ?? []) {
    const reason = (confirmReasons.value[confirmKeyOf(item)] ?? '').trim();
    if (reason === '') {
      showToast('请逐条填写确认原因');
      return;
    }
    list.push(
      item.type === 'gas_refill'
        ? { type: 'gas_refill', card: item.card, reason }
        : { type: 'reading_decreased', field: item.field, reason },
    );
  }
  // M6（评审修复轮）：新确认与既有确认**按项合并**（同键覆盖），不得整表替换——否则
  // 多轮确认互相覆盖，先行确认的命中项在重提时丢失，服务端 409 再次拦截（死循环）
  const merged = [...collectedConfirms.value];
  for (const c of list) {
    const key = c.type === 'gas_refill' ? `gas_refill:${c.card}` : `reading_decreased:${c.field}`;
    const idx = merged.findIndex((m) =>
      m.type === 'gas_refill'
        ? `gas_refill:${m.card}` === key
        : `reading_decreased:${m.field}` === key,
    );
    if (idx >= 0) merged[idx] = c;
    else merged.push(c);
  }
  collectedConfirms.value = merged;
  pendingConfirms.value = null;
  await onConfirmSubmit();
}

/** 取消确认：清未发送的确认清单（草稿不丢），回首页刷新——稍后可重新提交 */
async function onConfirmCancel(): Promise<void> {
  pendingConfirms.value = null;
  collectedConfirms.value = [];
  await loadToday();
}

onMounted(bootstrap);

// F1-06「恢复网络自动上传」：系统联网事件触发排空（静默模式——自动触发不弹
// 「仍无法连接」类反馈，避免每次返回首页都弹）。M1（评审修复轮）：跨班次滞留单在排空内
// 被跳过，强提醒与自动排空不再互斥。门控前先重读队列：内存镜像可能与持久层滞后
//（如页面后台期间另一 tab 排空/入队），滞留判定必须基于最新数据
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void (async () => {
      await refreshQueue();
      if (queueItems.value.length > 0) await drainQueue(true);
    })();
  });
}

// D-T20：待同步期间草稿仍是权威数据源（清除时点=同步成功，D-T18 修订 #9 同源）——
// 队列项 payload 随自动保存刷新，入队后的补改不丢（提交快照始终取最新合并视图）。
// M4（评审修复轮）：排空在途期间的补改不可能进入已上传/在传的快照，打标后由排空
// 结束时的可见提示兑现（C-09 不静默）；补丁本身失败也必须可见（L6）
watch(
  () => draft.lastSavedAt.value,
  async (ts) => {
    if (ts === 0 || !user.value || !today.value) return;
    const id = queueItemKey(user.value.id, today.value.duty_date);
    if (!queueItems.value.some((i) => i.id === id)) return;
    if (syncing.value) patchedDuringSync = true;
    if (!(await patchQueueItem(id, { payload: buildPayload() }))) {
      showToast('本机待同步单刷新失败（存储不可用），同步内容以最近一次成功保存为准');
    }
  },
);
</script>

<template>
  <!-- 启动中：恢复登录态与首屏数据 -->
  <div v-if="booting" class="flex min-h-screen items-center justify-center bg-slate-100">
    <van-loading size="24" vertical>加载中…</van-loading>
  </div>

  <!-- 登录页（F1-11：账号密码由系统发号，暂不对接企业微信/钉钉） -->
  <div v-else-if="!user" class="min-h-screen bg-slate-100">
    <van-nav-bar title="交接班 · 师傅端" />
    <div class="px-4 pt-8">
      <div class="mb-6 text-center">
        <div class="text-xl font-bold text-slate-800">今日交接</div>
        <div class="mt-1 text-sm text-slate-500">请使用本人账号登录（一人一号，C-05 实名制）</div>
      </div>

      <!-- L5（评审修复轮）：本机（不分账号）存在待同步单时登录页提示——共用设备的
           换账号/掉线场景下，滞留单不再静默烂在本机（不展示内容、不代传，串值防护 C-05） -->
      <div
        v-if="deviceQueueCount > 0"
        class="mx-4 mt-4 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-700"
        data-testid="device-queue-hint"
      >
        本机有 {{ deviceQueueCount }} 张未同步的交接单，请用原账号登录后完成同步
      </div>

      <van-form data-testid="login-form" @submit="onLogin">
        <van-cell-group inset>
          <van-field
            v-model="loginForm.username"
            name="username"
            label="账号"
            placeholder="请输入账号"
            autocomplete="username"
            data-testid="login-username"
          />
          <van-field
            v-model="loginForm.password"
            type="password"
            name="password"
            label="密码"
            placeholder="请输入密码"
            autocomplete="current-password"
            data-testid="login-password"
          />
        </van-cell-group>
        <div class="mt-6 px-4">
          <van-button
            block
            type="primary"
            native-type="submit"
            :loading="loggingIn"
            data-testid="login-submit"
          >
            登录
          </van-button>
        </div>
      </van-form>

      <!-- 开发期便利：种子账号提示（《开发种子数据》§一），生产构建不含 -->
      <div v-if="isDev" class="mt-6 px-4 text-xs leading-relaxed text-slate-400">
        开发种子账号：zhang / shi / wang / liu（师傅）、chief（科长），统一密码见种子文档§一。
      </div>
    </div>
  </div>

  <!-- 板块填写页（F1-02-T2） -->
  <SectionView
    v-else-if="activeCard"
    :card="activeCard"
    :prev-info="prevInfo"
    :configs="configs"
    :elevator-expected="elevatorExpected"
    @back="backToToday"
  />

  <!-- 交接确认页（TK-18，F2-02/F2-03）：列表与详情两级，组件内切换 -->
  <ConfirmView
    v-else-if="confirming"
    :items="pendingItems"
    :detail="confirmDetail"
    :loading="detailLoading"
    @back="onConfirmBack"
    @open="openPendingItem"
  />

  <!-- 今日交接首页（F1-01 / F1-02 / F1-03） -->
  <template v-else>
    <TodayView
      v-if="today"
      :today="today"
      :can-submit="user?.role === 'master'"
      :pending-sync="queueItems.length > 0"
      :queue-count="queueItems.length"
      :syncing="syncing"
      :pending-count="pendingItems.length"
      @open="openCard"
      @submit="onOpenPreview"
      @sync="drainQueue"
      @confirm="openConfirm"
    />
    <div v-else class="flex min-h-screen items-center justify-center bg-slate-100">
      <van-loading v-if="loadingToday" size="24" vertical>加载今日交接…</van-loading>
      <van-empty v-else description="首页数据加载失败">
        <van-button type="primary" size="small" @click="loadToday">重试</van-button>
      </van-empty>
    </div>

    <!-- 退出登录（契约 §3.1：删除会话存根，服务端亦不再认可该令牌） -->
    <div v-if="today" class="px-3 pb-6">
      <van-button block plain type="default" data-testid="logout" @click="onLogout">
        退出登录（{{ user.real_name }}）
      </van-button>
    </div>
  </template>

  <!-- 提交前汇总预览弹窗（TK-12，F1-10）：未填项/异常项逐条点名，点击跳转定位（C-09） -->
  <div
    v-if="showPreview && preview"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
  >
    <div class="max-h-[80vh] w-full overflow-y-auto rounded-t-2xl bg-white px-4 pb-6 pt-4">
      <div class="flex items-baseline justify-between">
        <div class="text-base font-bold text-slate-800" data-testid="preview-title">
          提交前预览（{{ preview.duty_date }}）
        </div>
        <button
          type="button"
          class="text-sm text-slate-400"
          data-testid="preview-close"
          @click="showPreview = false"
        >
          关闭
        </button>
      </div>

      <!-- 离线预检模式（TK-15）：预览来自本地 shared 校验引擎，提交走向本机待同步队列 -->
      <div
        v-if="offlinePreviewMode"
        class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700"
        data-testid="preview-offline-note"
      >
        当前离线：以上为本地预检结果，确认后交接单将存入本机待同步队列，回到院内网络自动上传
      </div>

      <!-- 接班人（F2-01/DATA-10）：按排班自动带出；修改入口待 TK-26 人员接口 -->
      <div
        class="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600"
        data-testid="preview-receiver"
      >
        接班人：
        <b class="text-slate-800">{{ today?.receiver?.real_name ?? '（无次日排班）' }}</b>
        <span class="ml-1 text-xs text-slate-400">按排班表自动带出</span>
      </div>

      <!-- 未填项（缺失在前、越界在后，同 submit 400 口径） -->
      <div class="mt-3" data-testid="preview-missing" :data-count="preview.missing_fields.length">
        <div
          class="text-sm font-bold"
          :class="preview.missing_fields.length > 0 ? 'text-red-600' : 'text-emerald-600'"
        >
          未填项 {{ preview.missing_fields.length }} 项
          <span v-if="preview.missing_fields.length === 0">· 全部就绪</span>
        </div>
        <button
          v-for="item in preview.missing_fields"
          :key="item.field"
          type="button"
          class="mt-1.5 flex w-full items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-left text-sm text-slate-800"
          :data-testid="`preview-item-${item.field}`"
          @click="jumpFromPreview(item)"
        >
          <span
            >{{ item.label
            }}<span class="ml-1 text-xs text-slate-400">板块{{ item.section }}</span></span
          >
          <van-icon name="arrow" class="text-slate-400" />
        </button>
      </div>

      <!-- 异常项（状态选「异常」的标红项，不拦提交，PRD §6.2） -->
      <div class="mt-3" data-testid="preview-abnormal" :data-count="preview.abnormal_fields.length">
        <div class="text-sm font-bold text-amber-600">
          异常项 {{ preview.abnormal_fields.length }} 项
        </div>
        <button
          v-for="item in preview.abnormal_fields"
          :key="item.field"
          type="button"
          class="mt-1.5 flex w-full items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-left text-sm text-slate-800"
          :data-testid="`preview-item-${item.field}`"
          @click="jumpFromPreview(item)"
        >
          <span
            >{{ item.label
            }}<span class="ml-1 text-xs text-slate-400">板块{{ item.section }}</span></span
          >
          <van-icon name="arrow" class="text-slate-400" />
        </button>
      </div>

      <div class="mt-4">
        <van-button
          block
          type="danger"
          :disabled="preview.missing_fields.length > 0"
          :loading="submitting"
          data-testid="preview-submit"
          @click="onConfirmSubmit"
        >
          {{
            preview.missing_fields.length > 0
              ? '仍有未填项，无法提交'
              : offlinePreviewMode
                ? '确认并暂存到本机'
                : '确认提交'
          }}
        </van-button>
      </div>
    </div>
  </div>

  <!-- 防呆确认弹窗（TK-14，F1-12/F1-13）：409 need_confirm 逐条确认 + 原因必填，收集后重提 -->
  <div
    v-if="pendingConfirms && pendingConfirms.length > 0"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
  >
    <div class="max-h-[80vh] w-full overflow-y-auto rounded-t-2xl bg-white px-4 pb-6 pt-4">
      <div class="flex items-baseline justify-between">
        <div class="text-base font-bold text-slate-800" data-testid="confirm-title">
          异常读数确认（{{ pendingConfirms.length }} 项）
        </div>
        <button
          type="button"
          class="text-sm text-slate-400"
          data-testid="confirm-cancel"
          @click="onConfirmCancel"
        >
          取消
        </button>
      </div>
      <div class="mt-1 text-xs text-slate-400">确认原因将写入审计日志（技术方案 §5.5）</div>
      <div
        v-for="item in pendingConfirms"
        :key="confirmKeyOf(item)"
        class="mt-3 rounded-xl bg-amber-50 p-3"
        :data-testid="`confirm-item-${confirmKeyOf(item)}`"
      >
        <div class="text-sm font-bold text-amber-700">{{ item.message }}</div>
        <van-field
          :model-value="confirmReasons[confirmKeyOf(item)] ?? ''"
          type="textarea"
          autosize
          rows="1"
          :maxlength="200"
          placeholder="确认原因必填（如：上午充气 50 立方米）"
          class="mt-2 rounded-lg bg-white px-3"
          :data-testid="`confirm-reason-${confirmKeyOf(item)}`"
          @update:model-value="(v: string) => (confirmReasons[confirmKeyOf(item)] = v)"
        />
      </div>
      <div class="mt-4">
        <van-button
          block
          type="danger"
          :loading="submitting"
          data-testid="confirm-resubmit"
          @click="onConfirmResubmit"
        >
          确认并重新提交
        </van-button>
      </div>
    </div>
  </div>

  <!-- F1-14 强提醒（TK-15）：交接单滞留待同步跨班次，打开即首要展示。
       M1（评审修复轮，D-T20 修订）：跨班次滞留单不可由师傅同步（服务端只认当前班次），
       处置动作改为「联系科长」指引；师傅确认后收起（会话内不重复弹，队列项保留、数据不丢）；
       当班次滞留（如有）仍可在首页横幅手动同步 -->
  <div
    v-if="showSyncRemind"
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-6"
    data-testid="sync-remind-overlay"
  >
    <div class="w-full max-w-sm rounded-2xl bg-white p-5">
      <div class="text-lg font-bold text-red-600" data-testid="sync-remind-title">
        有 {{ staleQueueItems.length }} 张交接单滞留待同步
      </div>
      <div class="mt-1 text-sm text-slate-600">以下交接单尚未正式提交，已滞留超过一个班次：</div>
      <div
        v-for="item in staleQueueItems"
        :key="item.id"
        class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-slate-700"
        :data-testid="`sync-remind-item-${item.duty_date}`"
      >
        <div>
          班次 {{ item.duty_date }} · 入队于 {{ item.queued_at }}
          <span class="ml-1 font-bold text-red-600">已过班次分界，需科长处理</span>
        </div>
        <div v-if="item.last_error" class="mt-0.5 text-xs text-red-500">
          上次同步失败：{{ item.last_error }}
        </div>
      </div>
      <div
        v-if="hasHardFailedItems"
        class="mt-2 text-xs text-amber-700"
        data-testid="sync-remind-hardfailed"
      >
        有交接单多次同步失败，请联系科长协助核对（本机数据不会丢失）。
      </div>
      <van-button
        block
        type="danger"
        class="mt-4"
        data-testid="sync-remind-ack"
        @click="syncRemindAck = true"
      >
        已知晓，联系科长处理
      </van-button>
      <div class="mt-2 text-center text-xs text-slate-400">
        当班次交接单同步成功后方可下班（本班数据请照常提交）
      </div>
    </div>
  </div>
</template>
