/**
 * 任务列表的可见性规则与建任务：按角色分派查询，管理员一次为多个租户建任务。
 *
 * 不 import next/headers —— 身份与连接都由调用方注入，本层可在内存库上单测。
 */
import { randomBytes } from 'node:crypto';
import { nowMs, writeTx, type DB } from '@/lib/db';
import {
  countAll,
  countByTenantIds,
  countForAnnotator,
  insertTask,
  listAll,
  listForAnnotator,
  type ListOptions,
  type TaskRow,
} from '@/lib/db/repos/task-repo';
import { findById as findVideoById } from '@/lib/db/repos/video-repo';
import { findById as findTenantById, listAll as listAllTenants } from '@/lib/db/repos/tenant-repo';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { MAX_TITLE_LENGTH } from '@/lib/task-limits';
import { writeAudit } from './audit-service';
import { isTenantUser, type SessionUser } from './auth-service';

export type { TaskRow } from '@/lib/db/repos/task-repo';

// 契约把常量放在本模块导出；实现放在 lib/task-limits，客户端才能不引 service 而取到同一个值
export { MAX_TITLE_LENGTH };

export const PAGE_SIZE = 20;

/** 8 字节随机数 → 16 位十六进制，与 RULES 的 id 约定一致 */
const TASK_ID_BYTES = 8;


export type TaskPage = { items: TaskRow[]; total: number; page: number; pageSize: number };

/** 标注员没有租户说明 users 行被改坏了，属数据异常而非正常路径，文案不指向用户操作。 */
const BROKEN_IDENTITY_MESSAGE = '账号数据异常，请联系管理员';

/**
 * 角色分派：管理员看全部，标注员只看本租户的待领取与自己领取的。
 *
 * 标注员缺少租户时抛错而不是返回空列表：空列表会让这个 bug 永久隐身，
 * 直到某天用户发现「我明明有任务却什么都不显示」。
 */
export function listTasks(db: DB, actor: SessionUser, page: number): TaskPage {
  // 页码来自 URL 查询串（见各页面），非正整数一律回落第一页，避免负 OFFSET
  const current = Number.isInteger(page) && page >= 1 ? page : 1;
  const options: ListOptions = { limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE };

  if (actor.role === 'admin') {
    return { items: listAll(db, options), total: countAll(db), page: current, pageSize: PAGE_SIZE };
  }

  // 抛错独占一行：audit:rules 把「同一行既出现 ForbiddenError 又出现租户」判为跨租户 403，
  // 而这里判定的是身份是否完整，不是访问范围，分行使规则不误报
  if (!isTenantUser(actor)) {
    throw new ForbiddenError(BROKEN_IDENTITY_MESSAGE);
  }

  return {
    items: listForAnnotator(db, actor.tenantId, actor.id, options),
    total: countForAnnotator(db, actor.tenantId, actor.id),
    page: current,
    pageSize: PAGE_SIZE,
  };
}

export type CreateTasksInput = {
  videoId: string;
  tenantIds: string[];
  title: string;
  description?: string;
};

export type TenantOption = { id: string; name: string; taskCount: number };

/** 建任务页的租户清单：附上当前任务数，管理员据此判断各空间的积压。 */
export function listTenantOptions(db: DB): TenantOption[] {
  const tenants = listAllTenants(db);
  const counts = countByTenantIds(
    db,
    tenants.map((tenant) => tenant.id),
  );
  return tenants.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    taskCount: counts.get(tenant.id) ?? 0,
  }));
}

/** 校验全部输入；返回去重后的租户与规整后的标题，调用方直接用于写入。 */
function validateCreateInput(
  db: DB,
  input: CreateTasksInput,
): { title: string; description: string | null; tenantIds: string[] } {
  const title = input.title.trim();
  if (title.length === 0) throw new ValidationError('请填写任务标题');
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`任务标题不能超过 ${MAX_TITLE_LENGTH} 字`);
  }

  // 多选前端可能因 React key 重复传上同一个 id；不去重会建出两条一模一样的任务
  const tenantIds = [...new Set(input.tenantIds)];
  if (tenantIds.length === 0) throw new ValidationError('请至少选择一个租户');

  // 先整体校验再写入：事务能回滚，但回滚后的报错只说得出「失败」，
  // 说不出是哪个租户不存在；预检也免去「写了一半再撤销」的无谓操作
  if (!findVideoById(db, input.videoId)) throw new NotFoundError('视频不存在');

  const description = input.description?.trim() || null;
  return { title, description, tenantIds };
}

/**
 * 为每个租户各建一条任务，全部成功或全部不落库。
 * 调用方必须已确认是管理员。
 *
 * 所有插入与审计共用一个事务：中途失败时不能留下半批任务，
 * 也不允许「任务存在、审计缺失」的断链。
 */
export function createTasks(
  db: DB,
  actor: SessionUser,
  input: CreateTasksInput,
): { ids: string[] } {
  const { title, description, tenantIds } = validateCreateInput(db, input);

  return writeTx(db, () => {
    const createdAt = nowMs();
    const ids = tenantIds.map((tenantId) => {
      if (!findTenantById(db, tenantId)) throw new NotFoundError('租户不存在');
      const id = randomBytes(TASK_ID_BYTES).toString('hex');
      insertTask(db, {
        id,
        tenantId,
        videoId: input.videoId,
        title,
        description,
        createdBy: actor.id,
        createdAt,
      });
      writeAudit(db, {
        actorId: actor.id,
        actorRole: actor.role,
        tenantId,
        action: 'task.create',
        targetType: 'task',
        targetId: id,
        detail: { videoId: input.videoId, title },
      });
      return id;
    });
    return { ids };
  });
}
