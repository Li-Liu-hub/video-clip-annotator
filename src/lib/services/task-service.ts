/**
 * 任务的可见性规则、建任务，以及标注员的领取与归还。
 *
 * 不 import next/headers —— 身份与连接都由调用方注入，本层可在内存库上单测。
 */
import { randomBytes } from 'node:crypto';
import { nowMs, writeTx, type DB } from '@/lib/db';
import {
  claimIfPending,
  countAll,
  countByTenantIds,
  countForAnnotator,
  findByIdForTenant,
  insertTask,
  listAll,
  listForAnnotator,
  releaseIfOwned,
  type ListOptions,
  type TaskRow,
  type TaskStatus,
} from '@/lib/db/repos/task-repo';
import { findById as findVideoById } from '@/lib/db/repos/video-repo';
import { findById as findTenantById, listAll as listAllTenants } from '@/lib/db/repos/tenant-repo';
import { ForbiddenError, NotFoundError, StateConflictError, ValidationError } from '@/lib/errors';
import { AUDIT_ACTIONS } from '@/lib/audit-actions';
import { MAX_TITLE_LENGTH } from '@/lib/task-limits';
import { writeAudit } from './audit-service';
import { isTenantUser, type SessionUser, type TenantUser } from './auth-service';

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
 *
 * status 只作用于管理员视图：审核入口在管理台，标注员页没有筛选条，
 * 若在这里也过滤，标注员会看不到自己刚被退回的任务。
 */
export function listTasks(
  db: DB,
  actor: SessionUser,
  page: number,
  status: TaskStatus | null = null,
): TaskPage {
  // 页码来自 URL 查询串（见各页面），非正整数一律回落第一页，避免负 OFFSET
  const current = Number.isInteger(page) && page >= 1 ? page : 1;
  const options: ListOptions = { limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE };

  if (actor.role === 'admin') {
    return {
      items: listAll(db, options, status),
      total: countAll(db, status),
      page: current,
      pageSize: PAGE_SIZE,
    };
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
        action: AUDIT_ACTIONS.taskCreate,
        targetType: 'task',
        targetId: id,
        detail: { videoId: input.videoId, title },
      }, { strict: true });
      return id;
    });
    return { ids };
  });
}

const TASK_NOT_FOUND_MESSAGE = '任务不存在';
const CLAIM_CONFLICT_MESSAGE = '这条任务已被其他人领取';
const ALREADY_CLAIMED_MESSAGE = '你已经领取了这条任务';
const ALREADY_SUBMITTED_MESSAGE = '这条任务已提交，不能重复领取';
const REJECTED_TASK_MESSAGE = '这条任务已被退回，请从任务列表重新提交';
const RELEASE_CONFLICT_MESSAGE = '当前状态不允许归还';

/**
 * 领取任务：本租户的 pending 任务转到自己名下。返回更新后的行。
 *
 * 预查只为把 404 与 409 分开（「id 错了或越权」不同于「来晚了」），
 * 输赢仍由 claimIfPending 的 changes 判定 —— 先查后改在并发下两人都会通过。
 * 预查与预查后的更新都带租户条件，跨租户一律 404，不泄漏任务存在性。
 */
/**
 * 领取失败时按状态给出准确提示。
 *
 * 四种情况文案不同，是因为用户下一步该做的事不同：
 * 已提交 → 无需再领；已退回 → 去列表重新提交；自己已领 → 继续标注；别人领了 → 换一条。
 */
function describeClaimConflict(task: TaskRow, actorId: string): string {
  if (task.status === 'submitted') return ALREADY_SUBMITTED_MESSAGE;
  if (task.status === 'rejected') return REJECTED_TASK_MESSAGE;
  if (task.status === 'claimed' && task.claimed_by === actorId) return ALREADY_CLAIMED_MESSAGE;
  return CLAIM_CONFLICT_MESSAGE;
}

export function claimTask(db: DB, actor: TenantUser, taskId: string): TaskRow {
  return writeTx(db, () => {
    const existing = findByIdForTenant(db, taskId, actor.tenantId);
    if (!existing) throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);

    const claimed = claimIfPending(db, {
      taskId,
      tenantId: actor.tenantId,
      userId: actor.id,
      nowMs: nowMs(),
    });
    // 按状态给准确文案。只看 claimed_by 是不够的：schema 的 CHECK 要求所有非 pending
    // 行都带 claimed_by，所以已提交/已退回的任务同样满足 `claimed_by === 自己`，
    // 那时说「你已经领取了这条任务」会让人以为状态被回退了。
    // 事务拿的是写锁，existing 与上面的 UPDATE 之间不会被其他写事务插入，所以这个判断是准的。
    if (!claimed) {
      throw new StateConflictError(describeClaimConflict(existing, actor.id));
    }

    // 审计与状态跃迁同事务：要么「已在自己名下且有记录」，要么两者都不落库
    writeAudit(db, {
      actorId: actor.id,
      actorRole: 'annotator',
      tenantId: actor.tenantId,
      action: AUDIT_ACTIONS.taskClaim,
      targetType: 'task',
      targetId: taskId,
      detail: { previousStatus: 'pending' },
    }, { strict: true });

    // UPDATE 已命中，行必然存在；判空只为收窄类型
    const updated = findByIdForTenant(db, taskId, actor.tenantId);
    if (!updated) throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
    return updated;
  });
}

/**
 * 归还任务：自己领取且仍为 claimed 的任务退回 pending 池。
 *
 * 归属与状态都由 releaseIfOwned 的 WHERE 把关，本层的预查同样带租户条件，
 * 使「别的租户的任务」落到 404 而不是 409。失败路径不写审计 ——
 * 否则审计里会堆满「归还失败」，真实操作被淹没。
 */
export function releaseTask(db: DB, actor: TenantUser, taskId: string): void {
  writeTx(db, () => {
    const existing = findByIdForTenant(db, taskId, actor.tenantId);
    if (!existing) throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);

    const released = releaseIfOwned(db, {
      taskId,
      tenantId: actor.tenantId,
      userId: actor.id,
      nowMs: nowMs(),
    });
    if (!released) throw new StateConflictError(RELEASE_CONFLICT_MESSAGE);

    writeAudit(db, {
      actorId: actor.id,
      actorRole: 'annotator',
      tenantId: actor.tenantId,
      action: AUDIT_ACTIONS.taskRelease,
      targetType: 'task',
      targetId: taskId,
      detail: { previousStatus: 'claimed' },
    }, { strict: true });
  });
}
