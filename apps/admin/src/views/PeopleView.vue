<script setup lang="ts">
/**
 * 人员与排班管理页（TK-25 人员管理 + TK-26 排班管理）：
 *
 * - **账号全景**（F6-02）：GET /admin/users（id 升序 = 开通顺序），role/status 列透明展示；
 *   启停按钮只对师傅账号（master）渲染，科长行只读（服务端 chief 目标 403 为最终执法者）。
 * - **开通**：POST /admin/users（角色恒 master，D-T25）——登录名 / 姓名 / 初始密码，
 *   服务端校验（重复名 400 点名等）以前端预检兜一层（长度界与 shared 口径一致）。
 * - **停用/启用**：PATCH /admin/users/{id}，二次确认（demo 口径文案：停用后无法登录、
 *   不出现在排班候选里；操作写审计）。停用即不可登录由服务端保证（删会话存根，D-T13）。
 * - **排班月视图**（F6-03/04，TK-26）：GET /admin/schedules 稀疏行铺满当月日历骨架，
 *   逐日行内下拉改派（demo 口径：select 即改即生效）→ PUT /admin/schedules 单日 upsert，
 *   改派写审计 schedule.update 新旧值；候选只列 active 师傅 + 当日已排者（停用账号历史
 *   排班保留显「已停用」，demo 口径）。落库即驱动接班人带出（F2-01）与漏交检测（F6-06），
 *   登录提交人 ≠ 当日排班时师傅端提交触发安全阀确认（F6-05）。
 * - 审计留痕（user.update / schedule.update 新旧值）在审计日志页可查（F6-08，随 TK-29 落地）。
 *
 * 会话失效单一入口：401 统一上抛 sessionLost（与 App 约定）。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { ScheduleMonthDto, UserListItemDto } from '@handover/shared';
import { api, ApiRequestError, NetworkError } from '../api/client';

const emit = defineEmits<{ sessionLost: [] }>();

const items = ref<UserListItemDto[]>([]);
const listLoading = ref(false);

function handleLoadError(err: unknown): void {
  if (err instanceof ApiRequestError && err.status === 401) emit('sessionLost');
  else if (err instanceof ApiRequestError) ElMessage.error(err.message);
  else if (err instanceof NetworkError) ElMessage.error('网络不可用，请稍后重试');
  else ElMessage.error('操作失败，请重试');
}

async function load(): Promise<void> {
  listLoading.value = true;
  try {
    items.value = [...(await api.usersList()).items];
  } catch (err) {
    handleLoadError(err);
  } finally {
    listLoading.value = false;
  }
}

const ROLE_LABEL: Record<string, string> = { master: '师傅', chief: '科长' };

// ── 开通账号（POST /admin/users）─────────────────────────────────────

const createVisible = ref(false);
const createSaving = ref(false);
const createForm = ref({ username: '', real_name: '', password: '' });

/** 与服务端同一长度界（shared 口径）：预检只兜手感，越界仍以服务端 400 点名为准 */
function precheck(): string | null {
  const { username, real_name, password } = createForm.value;
  if (!/^\w{1,32}$/.test(username.trim())) return '登录名须为 1~32 位字母/数字/下划线';
  if (real_name.trim().length < 1 || real_name.trim().length > 32) return '姓名须为 1~32 字';
  if (password.length < 8 || password.length > 64) return '初始密码须为 8~64 字';
  return null;
}

async function submitCreate(): Promise<void> {
  const problem = precheck();
  if (problem) {
    ElMessage.warning(problem);
    return;
  }
  createSaving.value = true;
  try {
    const created = await api.userCreate({
      username: createForm.value.username.trim(),
      real_name: createForm.value.real_name.trim(),
      password: createForm.value.password,
    });
    createVisible.value = false;
    createForm.value = { username: '', real_name: '', password: '' };
    ElMessage.success(`账号 ${created.username}（${created.real_name}）已开通`);
    void load();
  } catch (err) {
    handleLoadError(err);
  } finally {
    createSaving.value = false;
  }
}

// ── 停用/启用（PATCH /admin/users/{id}，二次确认）────────────────────

async function toggleStatus(row: UserListItemDto): Promise<void> {
  const to = row.status === 'active' ? 'disabled' : 'active';
  const disabling = to === 'disabled';
  const confirmed = await ElMessageBox.confirm(
    disabling
      ? '停用后该账号无法登录，也不出现在排班候选里；操作写审计。'
      : '启用后恢复登录与排班候选；操作写审计。',
    `${disabling ? '停用' : '启用'}账号 ${row.real_name}`,
    {
      confirmButtonText: disabling ? '确认停用' : '确认启用',
      cancelButtonText: '取消',
      type: 'warning',
    },
  ).catch(() => null);
  if (confirmed === null) return;
  try {
    const updated = await api.userPatchStatus(row.id, { status: to });
    ElMessage.success(`账号 ${updated.real_name} 已${disabling ? '停用' : '启用'}，审计已记录`);
    void load();
  } catch (err) {
    handleLoadError(err);
  }
}

// ── 排班月视图维护（GET/PUT /admin/schedules，TK-26）────────────────────

/** 月视图行：当月逐日骨架 + 该日排班（GET 稀疏行合并；无排班 user_id 为 null） */
interface ScheduleRow {
  duty_date: string;
  /** 展示标签：`09-01 周一` */
  label: string;
  user_id: number | null;
  real_name: string | null;
  updated_at: string | null;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 当前墙钟月（YYYY-MM）；上/下月翻页用 UTC 日历算术（纯日期无时区歧义） */
function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(base: string, delta: number): string {
  const d = new Date(`${base}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

const month = ref(monthOf(new Date()));
const scheduleRows = ref<ScheduleRow[]>([]);
const schedLoading = ref(false);
/** 正在改派的行（日期键集合）：行内下拉置 loading，防重复触发 PUT */
const puttingDates = ref(new Set<string>());

const monthLabel = computed(
  () => `${month.value.slice(0, 4)} 年 ${Number(month.value.slice(5, 7))} 月`,
);

/**
 * 候选清单（demo 口径）：active 师傅为主；行内已排的停用账号保留可选（历史排班显
 * 「已停用」标注，避免其行显示为空）。科长账号不进候选（排班人恒为师傅，C-05）。
 */
function candidatesOf(row: ScheduleRow): UserListItemDto[] {
  const list = items.value.filter((u) => u.role === 'master' && u.status === 'active');
  if (row.user_id != null && !list.some((u) => u.id === row.user_id)) {
    const cur = items.value.find((u) => u.id === row.user_id);
    if (cur) list.push(cur);
  }
  return list;
}

/** 已排账号停用标注（demo 口径「已停用」tag）：历史排班保留展示，不无声消失 */
const userById = computed(() => new Map(items.value.map((u) => [u.id, u])));

function changeMonth(delta: number): void {
  month.value = shiftMonth(month.value, delta);
  void loadSchedules();
}

async function loadSchedules(): Promise<void> {
  schedLoading.value = true;
  try {
    const body: ScheduleMonthDto = await api.schedulesMonth(month.value);
    month.value = body.month; // 服务端归一回显（防本地翻页越界漂移）
    const byDate = new Map(body.items.map((i) => [i.duty_date, i]));
    const [y, m] = [Number(body.month.slice(0, 4)), Number(body.month.slice(5, 7))];
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const rows: ScheduleRow[] = [];
    for (let day = 1; day <= days; day++) {
      const dutyDate = `${body.month}-${String(day).padStart(2, '0')}`;
      const item = byDate.get(dutyDate);
      const weekday = WEEKDAYS[new Date(`${dutyDate}T00:00:00Z`).getUTCDay()];
      rows.push({
        duty_date: dutyDate,
        label: `${dutyDate.slice(5)} ${weekday}`,
        user_id: item?.user_id ?? null,
        real_name: item?.real_name ?? null,
        updated_at: item?.updated_at ?? null,
      });
    }
    scheduleRows.value = rows;
  } catch (err) {
    handleLoadError(err);
  } finally {
    schedLoading.value = false;
  }
}

/** 行内改派（demo 口径 select 即改）：PUT 单日 upsert，改派写审计后重取本月视图 */
async function onScheduleChange(row: ScheduleRow, userId: number): Promise<void> {
  if (row.user_id === userId || puttingDates.value.has(row.duty_date)) return;
  puttingDates.value.add(row.duty_date);
  try {
    const result = await api.schedulePut({ duty_date: row.duty_date, user_id: userId });
    ElMessage.success(
      `${row.duty_date} 排班已改为 ${result.real_name}，审计已记录；次日接班人带出随之生效`,
    );
    void loadSchedules();
  } catch (err) {
    handleLoadError(err);
  } finally {
    puttingDates.value.delete(row.duty_date);
  }
}

onMounted(() => {
  void load();
  void loadSchedules();
});
</script>

<template>
  <div>
    <el-card shadow="never" class="mb-4">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-semibold">人员管理</span>
          <el-button type="primary" data-testid="user-create-btn" @click="createVisible = true"
            >开通账号</el-button
          >
        </div>
      </template>
      <div class="text-xs text-gray-400 mb-3">
        师傅账号实名一人一号；开通 / 停用即时生效并写审计；停用即不可登录
        （会话存根即删，已在线设备下一次请求被拒）。登录设备记录在审计日志（防共用账号）。
      </div>
      <el-table v-loading="listLoading" :data="items" border data-testid="users-table">
        <el-table-column prop="username" label="账号" min-width="120" />
        <el-table-column prop="real_name" label="姓名" min-width="110" />
        <el-table-column label="角色" width="90">
          <template #default="{ row }">
            <el-tag :type="row.role === 'chief' ? 'warning' : 'info'" size="small">
              {{ ROLE_LABEL[row.role as string] ?? row.role }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" data-testid="user-status">
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'active' ? 'success' : 'danger'"
              size="small"
              :data-testid="`user-status-${row.username}`"
            >
              {{ row.status === 'active' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="开通时间" min-width="170" />
        <el-table-column label="操作" width="110" align="center">
          <template #default="{ row }">
            <el-button
              v-if="row.role === 'master'"
              link
              :type="row.status === 'active' ? 'danger' : 'primary'"
              :data-testid="`user-toggle-${row.username}`"
              @click="toggleStatus(row)"
            >
              {{ row.status === 'active' ? '停用' : '启用' }}
            </el-button>
            <span v-else class="text-gray-300">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" data-testid="schedule-card">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-semibold">排班管理</span>
          <div class="flex items-center gap-2">
            <el-button size="small" data-testid="schedule-prev" @click="changeMonth(-1)"
              >上月</el-button
            >
            <span class="font-semibold px-1" data-testid="schedule-month-label">{{
              monthLabel
            }}</span>
            <el-button size="small" data-testid="schedule-next" @click="changeMonth(1)"
              >下月</el-button
            >
          </div>
        </div>
      </template>
      <div class="text-xs text-gray-400 mb-3">
        最小排班表「日期→人」，一天一人；行内下拉改派即时生效并写审计（新旧值留痕）。
        排班驱动师傅端接班人自动带出与应提交未提交提醒；登录提交人与当日排班不符时，
        师傅端提交须确认实际当班后方可提交并留痕。
      </div>
      <el-table
        v-loading="schedLoading"
        :data="scheduleRows"
        border
        size="small"
        max-height="600"
        data-testid="schedule-table"
      >
        <el-table-column label="日期" width="150">
          <template #default="{ row }">
            <span :data-testid="`schedule-date-${row.duty_date}`">{{ row.label }}</span>
            <el-tag
              v-if="row.user_id != null && userById.get(row.user_id)?.status === 'disabled'"
              type="info"
              size="small"
              class="ml-1"
              >已停用</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column label="值班师傅" min-width="220">
          <template #default="{ row }">
            <el-select
              :model-value="row.user_id ?? undefined"
              :placeholder="row.user_id == null ? '未排班' : undefined"
              :loading="puttingDates.has(row.duty_date)"
              :disabled="puttingDates.has(row.duty_date)"
              style="width: 100%"
              :data-testid="`schedule-select-${row.duty_date}`"
              @update:model-value="(v: number) => onScheduleChange(row, v)"
            >
              <el-option
                v-for="u in candidatesOf(row)"
                :key="u.id"
                :label="u.real_name + (u.status === 'disabled' ? '（已停用）' : '')"
                :value="u.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="最后修改" min-width="170">
          <template #default="{ row }">{{ row.updated_at ?? '—' }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 开通账号对话框（角色恒 master；初始密码 8~64 字，bcrypt 落库） -->
    <el-dialog
      v-model="createVisible"
      title="开通师傅账号"
      width="440px"
      data-testid="create-dialog"
    >
      <el-form label-width="80px">
        <el-form-item label="登录名" required>
          <el-input
            v-model="createForm.username"
            placeholder="1~32 位字母/数字/下划线"
            maxlength="32"
            data-testid="create-username"
          />
        </el-form-item>
        <el-form-item label="姓名" required>
          <el-input
            v-model="createForm.real_name"
            placeholder="实名（1~32 字）"
            maxlength="32"
            data-testid="create-realname"
          />
        </el-form-item>
        <el-form-item label="初始密码" required>
          <el-input
            v-model="createForm.password"
            type="password"
            show-password
            placeholder="8~64 字"
            data-testid="create-password"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="createSaving"
          data-testid="create-submit"
          @click="submitCreate"
          >开通</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>
