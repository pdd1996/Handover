/**
 * 填写草稿 store（TK-06 会话内层 + TK-08 持久化层，F1-09 草稿自动保存与续填）。
 *
 * 两层结构（技术方案 §5.1 草稿层、决策记录 D-T10/D-T18 修订 #9）：
 * - **会话内内存层**（本文件 `values`）：卡片间切换不丢值，返回首页由 TodayView 用
 *   「草稿 ?? 服务端值」合并口径实时重算角标与进度条（F1-03「实时汇总」）。
 * - **IndexedDB 持久层**（draft-db.ts）：改动后约 1 秒自动保存、离开页面/切后台时冲盘
 *   （best-effort，防抖才是主防线），建立登录态（登录/刷新恢复）后按 `draft:{user_id}:{duty_date}`
 *   恢复——填写中途关闭页面，重开可续填（F1-09-T1）。服务端不设在线草稿端点（D-T18），
 *   离线队列另见 TK-15。
 *
 * **持久草稿清除口径（TK-08 独立评审 M1 → D-T18 修订 #9）**：清除时点 = **该班次出现已提交
 * 记录**（`markSubmitted`，TK-12 提交成功后必须调用，已挂账任务分解 TK-12 行）；登出/会话失效
 * **只清会话内内存、不动持久层**——弱信号点位长时间填写不因掉线丢整班数据（PRD §7 风险表
 * 「本地草稿双保险」、EVT-06 保留条款），串值防护由用户+班次 keying 承担（C-05）。
 * **登录请求自身的 401（F1-11-T2/T3 密码错/停用）与被动掉线的 401 均不清本机草稿**——
 * 否则输错一次密码或会话滑动超时即丢草稿，违反 F1-09 续填。
 *
 * 取值口径与 shared `FieldValueGetter` 对齐：未填返回 null（不是 undefined），数值以
 * 字符串暂存（与 decimal 列回显一致），校验引擎统一解析（validation.ts parseNumeric）。
 */
import { reactive, ref } from 'vue';
import type { RecordFieldName } from '@handover/shared';
import { draftKey, loadDraft, removeDraft, saveDraft, type DraftValues } from './draft-db';

/** 草稿键：字段字典内列名 + 覆盖原因这一非字典键（TK-13，见 draft-db.ts DraftValues 注） */
type DraftKey = RecordFieldName | 'usage_override_reason';

const values = reactive<DraftValues>({});

/** 当前草稿归属键；null = 本页会话尚未建立归属（未登录/未恢复过） */
let currentKey: string | null = null;

/** 恢复过程中抑制自动保存（回灌值不是新改动，避免恢复即回写） */
let restoring = false;

/** 最近一次成功落盘时刻（毫秒，0 = 有未落盘改动/尚未落盘）；供「草稿已自动保存」指示与 E2E 同步 */
const lastSavedAt = ref(0);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 自动保存防抖（毫秒）：§5.1「每几秒自动保存」。取 1 秒——pagehide 冲盘是 best-effort
 * （页面被回收时写事务可能中止，TK-08 评审 M3），更短的防抖窗口才是数据不丢的主防线 */
const AUTOSAVE_DEBOUNCE_MS = 1000;

function snapshot(): DraftValues {
  return JSON.parse(JSON.stringify(values)) as DraftValues;
}

/** 立即落盘当前键（自动保存到点 / 离开页面冲盘共用）；仅在事务真正提交后点亮指示 */
function flushNow(): void {
  if (!currentKey) return;
  void saveDraft(currentKey, snapshot()).then((ok) => {
    if (ok) lastSavedAt.value = Date.now();
  });
}

/** 改动后防抖调度自动保存（§5.1「每几秒自动保存」） */
function scheduleSave(): void {
  if (restoring || !currentKey) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushNow();
  }, AUTOSAVE_DEBOUNCE_MS);
}

// 离开页面（关闭/刷新）或切后台被回收前冲盘：防抖窗口内的最后改动不丢（F1-09 续填的前提）。
// 两者都是 best-effort——页面被回收时写事务不保证提交，主防线是 1 秒防抖（TK-08 评审 M3）
if (typeof window !== 'undefined') {
  const flushPending = (): void => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    flushNow();
  };
  window.addEventListener('pagehide', flushPending);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPending();
  });
}

function deleteAllKeys(): void {
  for (const key of Object.keys(values)) delete values[key as RecordFieldName];
}

export function useDraft() {
  /** 读值：草稿优先，未填返回 null（调用方自行与服务端值合并） */
  function getValue(name: DraftKey): unknown {
    return values[name] ?? null;
  }

  /** 写值：v 为 null/undefined/空串/空数组时清除键，避免字典累积脏键
   * （空数组=全部取消勾选，isFilledValue 口径下亦算未填，存脏键只会误导角标合并口径）。
   * 同时熄灭「已自动保存」指示——新改动未落盘前不得显示已保存（TK-08 评审 m1） */
  function setValue(name: DraftKey, v: unknown): void {
    const isEmptyArray = Array.isArray(v) && v.length === 0;
    if (
      v === null ||
      v === undefined ||
      isEmptyArray ||
      (typeof v === 'string' && v.trim() === '')
    ) {
      delete values[name];
    } else {
      // 字典键值型宽松（unknown），覆盖原因键为 string——统一经索引签名写入（TS 收窄别拗）
      (values as Record<string, unknown>)[name] = v;
    }
    if (!restoring) {
      lastSavedAt.value = 0;
      scheduleSave();
    }
  }

  /**
   * 建立登录态后恢复本班次草稿（App.vue 在 GET /records/today 成功后调用，F1-09 续填入口）。
   * 返回是否恢复了有内容的草稿（供「草稿恢复提示」，PRD §6.1 设计触点）。
   * 同键重复调用直接跳过（backToToday 会再次走到这里）；键变化（班次切换/换账号重登）时
   * 先把旧键未落盘的改动冲盘，再载入新键——旧班次内容不丢（保留在旧键下，待其班次提交时
   * 由 markSubmitted 清除）。
   */
  async function restore(userId: number, dutyDate: string): Promise<boolean> {
    const key = draftKey(userId, dutyDate);
    if (currentKey === key) return false;
    if (currentKey && Object.keys(values).length > 0) {
      await saveDraft(currentKey, snapshot());
    }
    const saved = await loadDraft(key);
    currentKey = key;
    restoring = true;
    deleteAllKeys();
    if (saved) Object.assign(values, saved);
    restoring = false;
    return saved !== null && Object.keys(saved).length > 0;
  }

  /**
   * 清空**会话内内存**（App.vue `resetSession` 单一入口调用：主动登出、已建立登录态后的
   * 被动 401、bootstrap 静默失败）。**不动持久层**（D-T18 修订 #9）：持久草稿保留至该班次
   * 出现已提交记录，串值防护由 keying 承担（换账号的 key 不同，C-05）——弱信号点位长时间
   * 填写不因掉线丢整班数据（PRD §7）。
   */
  function clearMemory(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    currentKey = null;
    deleteAllKeys();
    lastSavedAt.value = 0;
  }

  /**
   * 该班次提交成功后清除持久草稿（**TK-12 提交成功后必须调用**，D-T18 修订 #9）——
   * 否则重开页面旧草稿复活并以「草稿 ?? 服务端值」优先于服务端真值（撤回后同）。
   * 若清除的正是当前归属键，内存一并清。
   * 返回是否真正提交（评审修复轮 L2：调用方须据实处理清除失败——它正是本钩子要防的
   * 「旧草稿复活压过服务端真值」，静默吞掉失败会让防线失效）。
   */
  async function markSubmitted(userId: number, dutyDate: string): Promise<boolean> {
    const key = draftKey(userId, dutyDate);
    const ok = await removeDraft(key);
    if (currentKey === key) clearMemory();
    return ok;
  }

  return { values, getValue, setValue, restore, clearMemory, markSubmitted, lastSavedAt };
}
