<script setup lang="ts">
/**
 * 人员管理页（TK-25，F6-02「师傅账号开通/停用」）：
 *
 * - **账号全景**：GET /admin/users（id 升序 = 开通顺序），role/status 列透明展示；
 *   启停按钮只对师傅账号（master）渲染，科长行只读（服务端 chief 目标 403 为最终执法者）。
 * - **开通**：POST /admin/users（角色恒 master，D-T25）——登录名 / 姓名 / 初始密码，
 *   服务端校验（重复名 400 点名等）以前端预检兜一层（长度界与 shared 口径一致）。
 * - **停用/启用**：PATCH /admin/users/{id}，二次确认（demo 口径文案：停用后无法登录、
 *   不出现在排班候选里；操作写审计）。停用即不可登录由服务端保证（删会话存根，D-T13）。
 * - 审计留痕（user.update 新旧值）在审计日志页可查（F6-08，随 TK-29 落地）。
 *
 * 会话失效单一入口：401 统一上抛 sessionLost（与 App 约定）。
 * 排班管理（F6-03/04/05）随 TK-26 落地，本页先占位。
 */
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { UserListItemDto } from '@handover/shared';
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

onMounted(() => {
  void load();
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
        师傅账号实名一人一号（C-05）；开通 / 停用即时生效并写审计；停用即不可登录
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

    <el-card shadow="never">
      <template #header><span class="font-semibold">排班管理</span></template>
      <el-empty
        description="最小排班表「日期→人」月视图维护（改即审计，驱动接班人带出与漏交检测）随任务 TK-26 落地"
        :image-size="80"
      />
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
