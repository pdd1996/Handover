/**
 * 待同步队列（TK-15，F1-06/F1-07）—— 技术方案 §5.1 离线三层缓冲的第二层（D-T10）。
 *
 * 定位：离线点击「提交」的交接单在本机排队（附本机时间戳与完整 payload），恢复网络后
 * **按入队顺序**上传，服务器确认才算正式提交、才对接班人可见（D-P07 排队送达；单写入人
 * + 一天一条记录，队列顺序即提交顺序，无需冲突合并）。服务器对队列**零感知**（F1-07-T2：
 * 同步成功前接班人侧查不到该记录，服务端无 draft/队列泄露）。
 *
 * keying 与草稿层同口径（C-05/C-08）：`{user_id}:{duty_date}`——同班次重复点击提交覆盖
 * 旧项（payload 取最新合并视图），换账号/跨班次互不串扰；顺序键 `queued_at`（本机时刻，
 * DATA-13 同形格式，`localMeasuredAt` 复用）。
 *
 * 队列项 payload 与草稿的边界（D-T20）：**待同步期间草稿仍是权威数据源**（清除时点
 * = 同步成功，D-T18 修订 #9 同源——提交成功才算「该班次出现已提交记录」），队列项
 * payload 随草稿自动保存刷新（App.vue watch `lastSavedAt`），入队后的补改不丢。
 *
 * 容错口径承草稿层：IndexedDB 不可用时静默降级（enqueue 返回 false，调用方显式提示
 * 「未能暂存」），不抛出、不阻塞。
 */
import { localMeasuredAt } from '@handover/shared';
import type { SubmitPayloadDto } from '@handover/shared';
import { idbWithStore, STORE_SYNC_QUEUE } from './draft-db';

/** 待同步队列项（IndexedDB `sync_queue` store 的值形状，key = `id`） */
export interface SyncQueueItem {
  /** `{user_id}:{duty_date}`：一天一条记录（F1-01），同班次重提覆盖旧项 */
  id: string;
  user_id: number;
  /** 入队时的班次起始日（C-08，取自 GET /records/today；F1-14 滞留判定的比较键） */
  duty_date: string;
  /** 提交时刻的全字典合并视图快照（buildPayload 产出，含 confirmations/overrides/prev_readings） */
  payload: SubmitPayloadDto;
  /** 本机入队时刻（YYYY-MM-DD HH:mm:ss）；排队送达的顺序键（D-T10） */
  queued_at: string;
  /** 上传尝试次数（诊断用；每次业务拒绝后 +1） */
  attempts: number;
  /** 最近一次上传失败摘要（400 点名概要 / 409 防呆文案；同步状态 UI 展示） */
  last_error: string | null;
}

/** 队列项键（与草稿 draftKey 同构：用户 + 班次隔离） */
export function queueItemKey(userId: number, dutyDate: string): string {
  return `${userId}:${dutyDate}`;
}

/** 入队/覆盖同键旧项；返回是否真正提交（存储不可用为 false，调用方须显式提示） */
export async function enqueueQueueItem(item: SyncQueueItem): Promise<boolean> {
  try {
    // 深拷贝为纯 JSON：buildPayload/confirmations 可能携带 Vue 响应式 Proxy（ref/reactive
    // 深层转换），structured clone 拒绝 Proxy（DataCloneError）；草稿层 snapshot 同款手法
    const plain = JSON.parse(JSON.stringify(item)) as SyncQueueItem;
    await idbWithStore(STORE_SYNC_QUEUE, 'readwrite', (s) => s.put(plain, plain.id));
    return true;
  } catch {
    return false;
  }
}

/** 读全队列（可选按用户过滤），按 queued_at 升序——排队送达的顺序即提交顺序（D-T10） */
export async function loadQueueItems(userId?: number): Promise<SyncQueueItem[]> {
  try {
    const all = await idbWithStore<unknown[]>(STORE_SYNC_QUEUE, 'readonly', (s) => s.getAll());
    return (all as SyncQueueItem[])
      .filter((i) => i && (userId === undefined || i.user_id === userId))
      .sort((a, b) => (a.queued_at < b.queued_at ? -1 : a.queued_at > b.queued_at ? 1 : 0));
  } catch {
    return [];
  }
}

/** 读单个队列项（无则 null；存储不可用同「无」，调用方按不存在处理） */
export async function getQueueItem(id: string): Promise<SyncQueueItem | null> {
  try {
    const v = await idbWithStore<unknown>(STORE_SYNC_QUEUE, 'readonly', (s) => s.get(id));
    return (v as SyncQueueItem) ?? null;
  } catch {
    return null;
  }
}

/** 部分更新队列项（payload 随草稿刷新 / 业务拒绝后记 last_error）；返回是否真正提交 */
export async function patchQueueItem(
  id: string,
  patch: Partial<Pick<SyncQueueItem, 'payload' | 'attempts' | 'last_error'>>,
): Promise<boolean> {
  const item = await getQueueItem(id);
  if (item === null) return false;
  try {
    const plain = JSON.parse(JSON.stringify({ ...item, ...patch })) as SyncQueueItem;
    await idbWithStore(STORE_SYNC_QUEUE, 'readwrite', (s) => s.put(plain, id));
    return true;
  } catch {
    return false;
  }
}

/** 移除队列项（同步成功 / RECORD_EXISTS 自愈专用）；返回是否真正提交 */
export async function removeQueueItem(id: string): Promise<boolean> {
  try {
    await idbWithStore(STORE_SYNC_QUEUE, 'readwrite', (s) => s.delete(id));
    return true;
  } catch {
    return false;
  }
}

/** 入队时刻（本机时间戳，DATA-13 同形——离线事实发生在本机，本机时钟即权威来源） */
export function queueTimestamp(): string {
  return localMeasuredAt();
}
