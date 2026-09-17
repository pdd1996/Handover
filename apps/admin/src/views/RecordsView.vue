<script setup lang="ts">
/**
 * 记录管理页（TK-24，F6-01「查看 / 导出 / 批注」）：
 *
 * - **查看/筛选**：GET /records 按日期区间 / 交班人 / 状态筛选（契约 §3.5，默认近 30 天），
 *   行点击开详情抽屉（GET /records/{id}：标红项、十板块读数按 shared 字段字典分组、
 *   双方确认信息、科长批注）——与接班人浏览共用同一详情形状（F2-03/F5-01 共用视图）。
 * - **导出**：GET /admin/records/export CSV（UTF-8 BOM，Excel 直开），按当前筛选条件导出，
 *   文件名由服务端按区间命名（契约订正 28）。
 * - **批注**：详情抽屉内覆盖式单条备注（POST /admin/records/{id}/annotation，D-T24），
 *   空文本 = 清除；服务端审计 `record.annotate` 留痕，前端只做长度预检（≤500 字）。
 * - **应提交未提交**：TK-23 既有视图（F6-06）保留在本页顶部。
 *
 * 会话失效单一入口：401 统一上抛 sessionLost（与 App 约定）。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  FIELD_BY_NAME,
  FIELD_NAMES,
  SECTION_BY_NO,
  type MissingSubmitItemDto,
  type RecordDetailDto,
  type RecordListItemDto,
  type SectionNo,
} from '@handover/shared';
import { api, ApiRequestError, NetworkError } from '../api/client';

const emit = defineEmits<{ sessionLost: [] }>();

// ── 应提交未提交（F6-06，TK-23 既有）─────────────────────────────────

const missingItems = ref<readonly MissingSubmitItemDto[]>([]);
const missingLoading = ref(false);

async function loadMissing(): Promise<void> {
  missingLoading.value = true;
  try {
    missingItems.value = (await api.missingSubmits()).items;
  } catch (err) {
    handleLoadError(err);
  } finally {
    missingLoading.value = false;
  }
}

// ── 交接记录列表与筛选（F6-01 查看）─────────────────────────────────

/** 状态筛选项（shared RecordStatus 四值；labels 与 CSV 导出同义） */
const STATUS_OPTIONS = [
  { value: 'draft', label: '草稿' },
  { value: 'submitted', label: '已提交' },
  { value: 'objection', label: '有异议' },
  { value: 'completed', label: '已归档' },
] as const;
const STATUS_TAG: Record<string, 'info' | 'primary' | 'warning' | 'success'> = {
  draft: 'info',
  submitted: 'primary',
  objection: 'warning',
  completed: 'success',
};

/** 默认筛选区间 = 近 30 天（按月为常用形态；种子 D-1~D-10 恒在窗内）。value-format 下模型为 'YYYY-MM-DD' 串 */
function defaultRange(): [string, string] {
  const fmt = (d: Date): string => {
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const end = new Date();
  return [fmt(new Date(end.getTime() - 29 * 24 * 3600 * 1000)), fmt(end)];
}

const filterRange = ref<[string, string] | null>(defaultRange());
const filterSubmitter = ref<string>('');
const filterStatus = ref<string>('');
const items = ref<readonly RecordListItemDto[]>([]);
const listLoading = ref(false);

/** 交班人候选：人员全表（TK-25 GET /admin/users；含已停用师傅——历史单的交班人仍需可筛） */
const submitterOptions = ref<{ value: string; label: string }[]>([]);

async function loadSubmitters(): Promise<void> {
  const list = await api.usersList();
  submitterOptions.value = list.items
    .filter((u) => u.role === 'master')
    .map((u) => ({ value: String(u.id), label: u.real_name }));
}

function query(): { from?: string; to?: string; submitter_id?: string; status?: string } {
  const [start, end] = filterRange.value ?? [];
  return {
    from: start || undefined,
    to: end || undefined,
    submitter_id: filterSubmitter.value || undefined,
    status: filterStatus.value || undefined,
  };
}

function handleLoadError(err: unknown): void {
  if (err instanceof ApiRequestError && err.status === 401) emit('sessionLost');
  else if (err instanceof ApiRequestError) ElMessage.error(err.message);
  else if (err instanceof NetworkError) ElMessage.error('网络不可用，请稍后重试');
  else ElMessage.error('加载失败，请重试');
}

async function load(): Promise<void> {
  listLoading.value = true;
  try {
    items.value = (await api.recordsList(query())).items;
  } catch (err) {
    handleLoadError(err);
  } finally {
    listLoading.value = false;
  }
}

function resetFilters(): void {
  filterRange.value = defaultRange();
  filterSubmitter.value = '';
  filterStatus.value = '';
  void load();
}

const exporting = ref(false);

async function exportCsv(): Promise<void> {
  exporting.value = true;
  try {
    await api.exportRecords(query());
  } catch (err) {
    handleLoadError(err);
  } finally {
    exporting.value = false;
  }
}

// ── 详情抽屉（查看）与批注（F6-01 查看/批注）─────────────────────────

const detail = ref<RecordDetailDto | null>(null);
const detailVisible = ref(false);
const detailLoading = ref(false);

async function openDetail(row: RecordListItemDto): Promise<void> {
  detailLoading.value = true;
  detailVisible.value = true;
  detail.value = null;
  try {
    detail.value = await api.recordsDetail(row.id);
  } catch (err) {
    handleLoadError(err);
  } finally {
    detailLoading.value = false;
  }
}

/** 详情读数按板块分组（shared 字段字典单一来源；空值不展示） */
const detailSections = computed(() => {
  const d = detail.value;
  if (!d) return [];
  return [...new Set(FIELD_NAMES.map((n) => FIELD_BY_NAME[n].section))]
    .filter((no) => no >= 1)
    .sort((a, b) => a - b)
    .map((no) => ({
      no: no as SectionNo,
      label: SECTION_BY_NO[no as SectionNo].label,
      fields: FIELD_NAMES.filter((n) => FIELD_BY_NAME[n].section === no)
        .map((n) => ({ def: FIELD_BY_NAME[n], value: d.readings[n] ?? null }))
        .filter((f) => f.value !== null && f.value !== undefined),
    }))
    .filter((g) => g.fields.length > 0);
});

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join('、');
  return String(value);
}

/** 批注对话框（覆盖式单条；空文本 = 清除） */
const annotateVisible = ref(false);
const annotateText = ref('');
const annotateSaving = ref(false);

function openAnnotate(): void {
  annotateText.value = detail.value?.chief_note ?? '';
  annotateVisible.value = true;
}

async function saveAnnotate(): Promise<void> {
  const d = detail.value;
  if (!d) return;
  const note = annotateText.value.trim();
  if (note.length > 500) {
    ElMessage.warning('批注内容不能超过 500 字');
    return;
  }
  annotateSaving.value = true;
  try {
    const result = await api.annotate(d.id, note);
    detail.value = { ...d, chief_note: result.chief_note };
    annotateVisible.value = false;
    ElMessage.success(result.chief_note === null ? '批注已清除' : '批注已保存');
    void load(); // 列表行的批注列同步刷新
  } catch (err) {
    handleLoadError(err);
  } finally {
    annotateSaving.value = false;
  }
}

onMounted(() => {
  void loadMissing();
  void load();
  void loadSubmitters().catch(handleLoadError);
});
</script>

<template>
  <div>
    <el-card shadow="never" class="mb-4" data-testid="missing-card">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-semibold text-orange-500">应提交未提交</span>
          <el-button text :loading="missingLoading" @click="loadMissing">刷新</el-button>
        </div>
      </template>
      <div class="text-xs text-gray-400 mb-3">
        定时任务按排班表扫描：班次日期已过约定时点（默认次日
        9:00，可调）仍无已提交记录即提醒（F6-06，数据源与站内通知同源）。
      </div>
      <el-table
        v-if="missingItems.length > 0"
        :data="missingItems as MissingSubmitItemDto[]"
        border
        data-testid="missing-table"
      >
        <el-table-column prop="duty_date" label="班次日期" width="160" />
        <el-table-column prop="real_name" label="排班人" min-width="120" />
        <el-table-column label="处置提示" min-width="220">
          <template #default>请联系排班师傅核实提交，或按补交流程处理</template>
        </el-table-column>
      </el-table>
      <el-empty
        v-else-if="!missingLoading"
        description="暂无应提交未提交班次"
        :image-size="80"
        data-testid="missing-empty"
      />
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-semibold">交接记录</span>
          <el-button
            type="primary"
            plain
            :loading="exporting"
            data-testid="records-export"
            @click="exportCsv"
            >导出 CSV（当前筛选）</el-button
          >
        </div>
      </template>

      <div
        id="records-filters"
        class="flex flex-wrap items-center gap-3 mb-4"
        data-testid="records-filters"
      >
        <el-date-picker
          v-model="filterRange"
          type="daterange"
          range-separator="至"
          start-placeholder="班次日期起"
          end-placeholder="班次日期止"
          value-format="YYYY-MM-DD"
          clearable
          data-testid="filter-range"
        />
        <el-select
          v-model="filterSubmitter"
          placeholder="交班人（全部）"
          clearable
          style="width: 160px"
          data-testid="filter-submitter"
        >
          <el-option
            v-for="opt in submitterOptions"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </el-select>
        <el-select
          v-model="filterStatus"
          placeholder="状态（全部）"
          clearable
          style="width: 140px"
          data-testid="filter-status"
        >
          <el-option
            v-for="opt in STATUS_OPTIONS"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </el-select>
        <el-button type="primary" :loading="listLoading" data-testid="filter-apply" @click="load"
          >查询</el-button
        >
        <el-button data-testid="filter-reset" @click="resetFilters">重置</el-button>
      </div>

      <el-table
        v-loading="listLoading"
        :data="items as RecordListItemDto[]"
        border
        highlight-current-row
        data-testid="records-table"
        @row-click="openDetail"
      >
        <el-table-column prop="duty_date" label="班次日期" width="120" />
        <el-table-column prop="record_no" label="交接单号" min-width="150" />
        <el-table-column label="交班 → 接班" min-width="140">
          <template #default="{ row }">
            {{ row.submitter.real_name }} → {{ row.receiver?.real_name ?? '—' }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="STATUS_TAG[row.status as string]" size="small">{{
              STATUS_OPTIONS.find((s) => s.value === row.status)?.label ?? row.status
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="64" />
        <el-table-column label="标红" width="72">
          <template #default="{ row }">
            <span :class="row.alert_count > 0 ? 'text-red-500 font-semibold' : 'text-gray-300'">{{
              row.alert_count
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="批注" min-width="180">
          <template #default="{ row }">
            <span v-if="row.chief_note" class="text-gray-600">{{ row.chief_note }}</span>
            <span v-else class="text-gray-300">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click.stop="openDetail(row)"
              >查看</el-button
            >
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-drawer
      v-model="detailVisible"
      :title="detail ? `${detail.record_no}（${detail.duty_date}）` : '交接单详情'"
      size="560px"
      data-testid="detail-drawer"
    >
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="2" border size="small" class="mb-4">
            <el-descriptions-item label="状态">{{
              STATUS_OPTIONS.find((s) => s.value === detail!.status)?.label ?? detail!.status
            }}</el-descriptions-item>
            <el-descriptions-item label="版本">v{{ detail!.version }}</el-descriptions-item>
            <el-descriptions-item label="交班人">{{
              detail!.submitter.real_name
            }}</el-descriptions-item>
            <el-descriptions-item label="接班人">{{
              detail!.receiver?.real_name ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="提交时刻">{{
              detail!.submitted_at ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="确认时刻">{{
              detail!.confirmed_at ?? '—'
            }}</el-descriptions-item>
          </el-descriptions>

          <div class="mb-4" data-testid="chief-note">
            <div class="flex items-center justify-between mb-1">
              <span class="font-semibold text-sm">科长批注</span>
              <el-button
                text
                type="primary"
                size="small"
                data-testid="annotate-btn"
                @click="openAnnotate"
                >{{ detail!.chief_note ? '修改批注' : '写批注' }}</el-button
              >
            </div>
            <div
              v-if="detail!.chief_note"
              class="text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded px-3 py-2"
            >
              {{ detail!.chief_note }}
            </div>
            <div v-else class="text-xs text-gray-400">
              暂无批注（批注以审计留痕，可追溯历次修改）
            </div>
          </div>

          <div v-if="detail!.alerts.length > 0" class="mb-4">
            <div class="font-semibold text-sm mb-1">标红确认项（{{ detail!.alerts.length }}）</div>
            <div
              v-for="a in detail!.alerts"
              :key="a.id"
              class="text-sm border rounded px-3 py-2 mb-1"
              :class="
                a.level === 'high'
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : a.level === 'mid'
                    ? 'border-orange-200 bg-orange-50 text-orange-700'
                    : 'border-gray-200 bg-gray-50 text-gray-600'
              "
            >
              {{ a.message }}
              <span v-if="a.acknowledged_at" class="text-xs text-gray-400">（已知晓）</span>
            </div>
          </div>

          <div v-for="g in detailSections" :key="g.no" class="mb-4">
            <div class="font-semibold text-sm mb-1">{{ g.label }}</div>
            <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div v-for="f in g.fields" :key="f.def.name" class="flex justify-between gap-2">
                <span class="text-gray-400">{{ f.def.label }}</span>
                <span>{{ displayValue(f.value) }}{{ f.def.unit ?? '' }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </el-drawer>

    <el-dialog
      v-model="annotateVisible"
      :title="detail?.chief_note ? '修改批注' : '写批注'"
      width="480px"
      data-testid="annotate-dialog"
    >
      <el-input
        v-model="annotateText"
        type="textarea"
        :rows="4"
        maxlength="500"
        show-word-limit
        placeholder="批注内容（留空提交 = 清除批注；服务端审计留痕）"
        data-testid="annotate-input"
      />
      <template #footer>
        <el-button @click="annotateVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="annotateSaving"
          data-testid="annotate-save"
          @click="saveAnnotate"
          >保存</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>
