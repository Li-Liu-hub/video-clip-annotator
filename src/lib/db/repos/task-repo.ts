/**
 * tasks 表查询：管理员全量视图与标注员收窄视图。
 *
 * 两条视图各自写死 WHERE，不用 `(? IS NULL OR tenant_id = ?)` 在一条 SQL 里切换角色：
 * 那样标注员的 tenant_id 一旦为 NULL，视图会静默升级为全量，而 SQL 不会报错。
 * 角色判定在 task-service，本层只执行已经决定了范围的查询。
 */
import type { DB } from '@/lib/db';

export type TaskRow = {
  id: string;
  tenant_id: string;
  video_id: string;
  status: 'pending' | 'claimed' | 'submitted' | 'rejected';
  claimed_by: string | null;
  estimated_ms: number;
  created_at: number;
  // 以下为 join 出来的展示字段
  video_filename: string;
  tenant_name: string;
  claimed_by_name: string | null;
};

export type ListOptions = { limit: number; offset: number };

/**
 * 列表用的展示列。
 *
 * estimated_ms 取自素材时长：tasks 表不存预估时长，契约字段名保留，
 * 语义是「这条任务涉及多长的视频」，建任务时也按该时长估工。
 */
const TASK_SELECT = `
  SELECT t.id, t.tenant_id, t.video_id, t.status, t.claimed_by,
         v.duration_ms AS estimated_ms, t.created_at,
         v.filename AS video_filename,
         tn.name AS tenant_name,
         cu.display_name AS claimed_by_name
    FROM tasks t
    JOIN videos v ON v.id = t.video_id
    JOIN tenants tn ON tn.id = t.tenant_id
    LEFT JOIN users cu ON cu.id = t.claimed_by`;

/** 只按 created_at 排序时同毫秒多行顺序不定，翻页会重复或遗漏，故补 id 作次序键。 */
const TASK_ORDER = 'ORDER BY t.created_at DESC, t.id DESC';

/**
 * 标注员可见范围：本租户 且（待领取 或 自己领取）。
 *
 * 括号不可省 —— AND 优先级高于 OR，去掉后变成
 * `(tenant_id = ? AND status = 'pending') OR (claimed_by = ?)`，后半段没有租户限制。
 * 列表与计数共用此常量，两处条件不会各自漂移。
 */
const ANNOTATOR_SCOPE = `t.tenant_id = ? AND (t.status = 'pending' OR t.claimed_by = ?)`;

/** 管理员视图：无租户谓词，可见全部。 */
export function listAll(db: DB, options: ListOptions): TaskRow[] {
  return db
    .prepare(`${TASK_SELECT} ${TASK_ORDER} LIMIT ? OFFSET ?`)
    .all(options.limit, options.offset) as TaskRow[];
}

export function countAll(db: DB): number {
  // audit-ignore: 管理员全量视图，刻意不含租户谓词，与 listAll 同范围
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tasks t`).get();
  return (row as { n: number }).n;
}

/** 标注员视图：本租户 且（待领取 或 自己领取）。 */
export function listForAnnotator(
  db: DB,
  tenantId: string,
  userId: string,
  options: ListOptions,
): TaskRow[] {
  return db
    .prepare(`${TASK_SELECT} WHERE ${ANNOTATOR_SCOPE} ${TASK_ORDER} LIMIT ? OFFSET ?`)
    .all(tenantId, userId, options.limit, options.offset) as TaskRow[];
}

export function countForAnnotator(db: DB, tenantId: string, userId: string): number {
  // audit-ignore: 本字面量只含表名，租户谓词由 ANNOTATOR_SCOPE 拼入，与 listForAnnotator 同范围
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${ANNOTATOR_SCOPE}`).get(
    tenantId,
    userId,
  );
  return (row as { n: number }).n;
}
