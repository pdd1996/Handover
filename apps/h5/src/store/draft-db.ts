/**
 * 草稿持久化存储（TK-08，F1-09）—— IndexedDB 薄封装。
 *
 * 定位：技术方案 §5.1 离线三层缓冲的**草稿层**载体（决策记录 D-T10：离线优先，草稿存手机本机，
 * 服务器零感知——F1-07-T2 同款口径，服务端不设在线草稿端点，见决策记录 D-T18）。
 *
 * key 纪律（TK-08 评审 → D-T18 修订 #9）：`draft:{submitter_id}:{duty_date}`，**按用户与班次
 * keying**——换账号不串值（C-05）、跨班次不误恢复（C-08 一天一条记录）；**持久草稿的清除时点
 * = 该班次出现已提交记录**（markSubmitted，TK-12 提交成功后调用），登出/会话失效只清会话内
 * 内存、不动持久层（弱信号点位长时间填写不因掉线丢整班数据，PRD §7 双保险；EVT-06 保留条款）。
 * 本模块不做其他主动淘汰（每次草稿为数千字节级 JSON，3 年留存远低于配额；陈旧键回收随 TK-30）。
 *
 * 容错口径：IndexedDB 不可用（隐私模式/存储被禁）时静默降级——写失败返回 false、读失败返回 null，
 * 不抛出、不弹错，退化为 TK-06 的会话内草稿边界（刷新丢失），**不得阻塞填写**（C-01 填写效率优先）。
 *
 * 挂账：① EVT-06（埋点清单）需草稿携带 `last_edit_ts`，存储体届时补时间戳字段（TK-30）。
 * ② TK-15 已兑现：DB_VERSION 1→2 增 `sync_queue` store（待同步队列），并补 `onblocked`
 * 回调（多标签页持旧连接时升版被阻塞，提示用户关闭其它页面；此前无处理会静默卡死）。
 * 照片暂存区 store 属 Phase 2（F7/TK-36），随其落地再升版，不在本层预留空 store。
 */
import type { PrevBackfillField, RecordFieldName } from '@handover/shared';

const DB_NAME = 'handover-h5';
const DB_VERSION = 2;
/** 开库超时（评审修复轮 L4）：覆盖升版被阻塞的窗口，超限按存储不可用降级 */
const OPEN_TIMEOUT_MS = 8000;
export const STORE_DRAFTS = 'drafts';
/** 待同步队列（TK-15，F1-06/F1-07）：离线提交的交接单在本机排队，恢复网络后按序上传 */
export const STORE_SYNC_QUEUE = 'sync_queue';

/**
 * 草稿值形状：字段名 → 原值（数值为字符串，与 store/draft.ts 暂存口径一致；JSON 可克隆）。
 * 非字段字典键两类（随草稿持久化即离线可用，提交时随 payload 上送、服务端强制校验）：
 * - `usage_override_reason`（TK-13，F3-04/06）：液氧日间用量手工覆盖的原因；
 * - `prev_backfill:{field}`（TK-14，F3-07/D-T19）：上一班缺失态下的补录读数，提交时
 *   组装进 `prev_readings` 上送（服务端仅缺失态消费，有上一班记录时忽略）。
 * 放本层而非另建 store：值与其配套原因/基线同生同灭、同随草稿 tombstone 清除。
 */
export type DraftValues = Partial<Record<RecordFieldName, unknown>> & {
  usage_override_reason?: string;
} & Partial<Record<`prev_backfill:${PrevBackfillField}`, unknown>>;

/** 草稿键（tombstone 语义的 keying 实现）：按提交人 + 班次起始日隔离 */
export function draftKey(userId: number, dutyDate: string): string {
  return `draft:${userId}:${dutyDate}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // 开库超时（评审修复轮 L4）：升版被其它标签页持旧连接阻塞时，request 会无限期
      // pending，若不设超时本 Promise 永不 settle，缓存后草稿层与队列层**全部**操作
      // 永久挂起（提交按钮永久 loading、draft-saved 永不点亮）。超时后 reject，
      // 调用方落到既有的静默降级路径（入队显式提示「存储不可用」）
      const timer = setTimeout(
        () => reject(new Error('IndexedDB 打开超时（可能被其它标签页阻塞）')),
        OPEN_TIMEOUT_MS,
      );
      const settle = <T>(fn: () => T): T => {
        clearTimeout(timer);
        return fn();
      };
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_DRAFTS))
          req.result.createObjectStore(STORE_DRAFTS);
        if (!req.result.objectStoreNames.contains(STORE_SYNC_QUEUE))
          req.result.createObjectStore(STORE_SYNC_QUEUE);
      };
      // 升版被阻塞（另一标签页持旧版本连接）时显式暴露：静默卡死会让待同步队列
      // 看似可用实则写不进，比报错更危险（TK-15 兑现 TK-08 挂账）
      req.onblocked = () => console.warn('IndexedDB 升版被阻塞：请关闭本系统的其它标签页后重试');
      req.onsuccess = () => {
        const db = req.result;
        // 评审修复轮 L4（TK-08 挂账另一半）：其它标签页发起升版时主动放行——
        // 关闭自身连接并重置缓存，下次操作按新版本重开，避免旧连接钉死新版本
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        settle(() => resolve(db));
      };
      req.onerror = () => settle(() => reject(req.error ?? new Error('IndexedDB 打开失败')));
    });
  }
  return dbPromise;
}

/** 通用单 store 事务执行器（草稿层与待同步队列共用同一库连接） */
export function idbWithStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = run(t.objectStore(storeName));
        const fail = (): void => reject(t.error ?? req.error ?? new Error('IndexedDB 操作失败'));
        if (mode === 'readonly') {
          req.onsuccess = () => resolve(req.result);
          req.onerror = fail;
        } else {
          // 写操作以**事务提交**为准：request.onsuccess 时事务尚未 commit，页面随即关闭仍可能丢——
          // 「草稿已自动保存」指示不得早于提交点亮（TK-08 评审 M3）；待同步队列入队同理
          t.oncomplete = () => resolve(req.result);
          t.onerror = fail;
          t.onabort = fail;
        }
      }),
  );
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return idbWithStore(STORE_DRAFTS, mode, run);
}

/** 读草稿；无存档或存储不可用返回 null（调用方按「无草稿」处理，不区分失败） */
export async function loadDraft(key: string): Promise<DraftValues | null> {
  try {
    const v = await withStore<DraftValues | undefined>('readonly', (s) => s.get(key));
    return v ?? null;
  } catch {
    return null;
  }
}

/** 写草稿；返回是否真正提交（存储不可用/事务中止为 false，调用方据实点亮指示） */
export async function saveDraft(key: string, values: DraftValues): Promise<boolean> {
  try {
    await withStore('readwrite', (s) => s.put(values, key));
    return true;
  } catch {
    return false; // 静默降级，见头部容错口径
  }
}

/** 删草稿（提交成功清除路径专用，TK-12 消费）；返回是否真正提交 */
export async function removeDraft(key: string): Promise<boolean> {
  try {
    await withStore('readwrite', (s) => s.delete(key));
    return true;
  } catch {
    return false;
  }
}
