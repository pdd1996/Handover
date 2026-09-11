/**
 * 填写草稿 store（TK-06）—— 卡片页表单值的**会话内**暂存层。
 *
 * 定位与边界：
 * - TK-06 的服务端仍无写入接口（GET /records/today 只读，D-T15），表单值先落此内存 store：
 *   卡片间切换不丢值（模块级单例），返回首页时 TodayView 用「草稿 ?? 服务端值」合并口径
 *   实时重算角标与进度条（F1-03「实时汇总」）。
 * - **持久化不在本层**：在线草稿落服务端（PUT /records/today/draft，TK-08）、离线草稿落
 *   IndexedDB（TK-15 三层缓冲）——刷新页面即丢失是本阶段已知边界，两处注释均已钉住。
 * - 取值口径与 shared `FieldValueGetter` 对齐：未填返回 null（不是 undefined），数值以
 *   字符串暂存（与 decimal 列回显一致），校验引擎统一解析（validation.ts parseNumeric）。
 */
import { reactive } from 'vue';
import type { RecordFieldName } from '@handover/shared';

const values = reactive<Partial<Record<RecordFieldName, unknown>>>({});

export function useDraft() {
  /** 读值：草稿优先，未填返回 null（调用方自行与服务端值合并） */
  function getValue(name: RecordFieldName): unknown {
    return values[name] ?? null;
  }

  /** 写值：v 为 null/undefined/空串/空数组时清除键，避免字典累积脏键
   * （空数组=全部取消勾选，isFilledValue 口径下亦算未填，存脏键只会误导角标合并口径） */
  function setValue(name: RecordFieldName, v: unknown): void {
    const isEmptyArray = Array.isArray(v) && v.length === 0;
    if (
      v === null ||
      v === undefined ||
      isEmptyArray ||
      (typeof v === 'string' && v.trim() === '')
    ) {
      delete values[name];
      return;
    }
    values[name] = v;
  }

  /** 清空（App.vue resetSession 单一入口调用）——草稿属登录会话，换账号不得串值。
   * 边界：本函数只清**会话内内存草稿**；TK-08 起的持久化草稿（IndexedDB）按用户/记录
   * keying，由其自身生命周期管理——登录请求自身的 401（F1-11-T2/T3）不得触发本函数，
   * 否则输错一次密码即丢本机草稿（违反 F1-09-T1 续填）。 */
  function clear(): void {
    for (const key of Object.keys(values)) delete values[key as RecordFieldName];
  }

  return { values, getValue, setValue, clear };
}
