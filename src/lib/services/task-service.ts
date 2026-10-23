/**
 * 任务列表的可见性规则：按角色分派到两条互斥的查询。
 *
 * 不 import next/headers —— 身份与连接都由调用方注入，本层可在内存库上单测。
 */
import type { DB } from '@/lib/db';
import {
  countAll,
  countForAnnotator,
  listAll,
  listForAnnotator,
  type ListOptions,
  type TaskRow,
} from '@/lib/db/repos/task-repo';
import { ForbiddenError } from '@/lib/errors';
import { isTenantUser, type SessionUser } from './auth-service';

export type { TaskRow } from '@/lib/db/repos/task-repo';

export const PAGE_SIZE = 20;

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
