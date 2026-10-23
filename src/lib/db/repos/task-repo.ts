/**
 * tasks 表读写：管理员全量视图、标注员收窄视图，以及可原子判定输赢的领取与归还。
 *
 * 两条视图各自写死 WHERE，不用 `(? IS NULL OR tenant_id = ?)` 在一条 SQL 里切换角色：
 * 那样标注员的 tenant_id 一旦为 NULL，视图会静默升级为全量，而 SQL 不会报错。
 * 角色判定在 task-service，本层只执行已经决定了范围的查询。
 */
import type { DB } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

export type TaskStatus = 'pending' | 'claimed' | 'submitted' | 'rejected';

export type TaskRow = {
  id: string;
  tenant_id: string;
  video_id: string;
  /** 管理员建任务时填的标题。列表以它为主信息，视频只是附件。 */
  title: string;
  /** 工作台要展开给标注员看；与列表共用一条 SELECT，不为单个字段再开一条查询。 */
  description: string | null;
  status: TaskStatus;
  claimed_by: string | null;
  estimated_ms: number;
  /** 退回原因。只在 rejected 行有值，两个视图都要展示，标注员才知道要改什么。 */
  reject_reason: string | null;
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
  SELECT t.id, t.tenant_id, t.video_id, t.title, t.description, t.status, t.claimed_by,
         v.duration_ms AS estimated_ms, t.reject_reason, t.created_at,
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

/**
 * 管理员视图的状态筛选谓词。null = 不筛，走不含 WHERE 的那条 SQL。
 *
 * 不用 `(? IS NULL OR t.status = ?)` 把两种情形塞进一条 SQL：
 * 那样管理员列表的常用路径也带上一个恒真条件，索引选择变差且读 SQL 时要多绕一层。
 */
const ADMIN_STATUS_FILTER = 't.status = ?';

/** 管理员视图：无租户谓词，可见全部。status 非空时只列该状态。 */
export function listAll(
  db: DB,
  options: ListOptions,
  status: TaskStatus | null = null,
): TaskRow[] {
  const sql =
    status === null
      ? `${TASK_SELECT} ${TASK_ORDER} LIMIT ? OFFSET ?`
      : `${TASK_SELECT} WHERE ${ADMIN_STATUS_FILTER} ${TASK_ORDER} LIMIT ? OFFSET ?`;
  const params =
    status === null ? [options.limit, options.offset] : [status, options.limit, options.offset];
  return db.prepare(sql).all(...params) as TaskRow[];
}

export function countAll(db: DB, status: TaskStatus | null = null): number {
  // audit-ignore: 管理员全量视图，刻意不含租户谓词，与 listAll 同范围
  const sql =
    status === null
      ? 'SELECT COUNT(*) AS n FROM tasks t'
      : `SELECT COUNT(*) AS n FROM tasks t WHERE ${ADMIN_STATUS_FILTER}`;
  const row = (status === null ? db.prepare(sql).get() : db.prepare(sql).get(status)) as {
    n: number;
  };
  return row.n;
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

/** 建任务页的展示字段：各租户当前积压多少任务。 */
export function countByTenantIds(db: DB, tenantIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  // IN () 是语法错误，空入参必须提前返回，而不是拼一个空括号交给 SQLite
  if (tenantIds.length === 0) return counts;

  const placeholders = tenantIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT tenant_id, COUNT(*) AS n FROM tasks
        WHERE tenant_id IN (${placeholders})
        GROUP BY tenant_id`,
    )
    .all(...tenantIds) as { tenant_id: string; n: number }[];

  for (const row of rows) counts.set(row.tenant_id, row.n);
  return counts;
}

/**
 * 带租户条件的单条查询。
 *
 * 租户条件写进 WHERE 而非「查出来再判」：后者会让「存在于别的租户」与「根本不存在」
 * 在调用方走同一条分支，一旦两个分支的状态码不同就泄漏了存在性。
 */
export function findByIdForTenant(db: DB, taskId: string, tenantId: string): TaskRow | null {
  const row = db
    .prepare(`${TASK_SELECT} WHERE t.id = ? AND t.tenant_id = ?`)
    .get(taskId, tenantId) as TaskRow | undefined;
  return row ?? null;
}

/**
 * 按 id 全局查一条：管理员视图，无租户谓词。
 *
 * 与 findByIdForTenant 分开而不是加一个可空租户参数：
 * 租户参数一旦可空，标注员身份残缺时查询会静默升级为全量。
 */
export function findById(db: DB, taskId: string): TaskRow | null {
  // audit-ignore: 管理员全量视图，与 listAll 同范围
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId) as TaskRow | undefined;
  return row ?? null;
}

/**
 * 仅当任务仍为 pending 且属于该租户时改为 claimed。返回是否命中。
 *
 * 命中与否只能靠 changes 判定：先查状态再无条件 UPDATE，两人同时领取时都会通过检查，
 * 后写的覆盖先写的。单条 UPDATE 自带原子性，无需外层事务。
 */
export function claimIfPending(
  db: DB,
  args: { taskId: string; tenantId: string; userId: string; nowMs: number },
): boolean {
  const result = db
    .prepare(
      `UPDATE tasks
          SET status = 'claimed', claimed_by = ?, claimed_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
    )
    .run(args.userId, args.nowMs, args.taskId, args.tenantId);
  return result.changes > 0;
}

/**
 * 仅当任务由该用户领取且状态为 claimed 时归还。返回是否命中。
 *
 * claimed_by 与 status 两个谓词都不能省：
 * 少 claimed_by，同租户任何人都能把别人正在做的任务打回池子；
 * 少 status，已提交的任务会被退回 pending，账本与状态脱节。
 *
 * nowMs 在契约里保留但此处不用：归还只把 claimed_at 清空，不记归还时间。
 */
export function releaseIfOwned(
  db: DB,
  args: { taskId: string; tenantId: string; userId: string; nowMs: number },
): boolean {
  const result = db
    .prepare(
      `UPDATE tasks
          SET status = 'pending', claimed_by = NULL, claimed_at = NULL
        WHERE id = ? AND tenant_id = ? AND claimed_by = ? AND status = 'claimed'`,
    )
    .run(args.taskId, args.tenantId, args.userId);
  return result.changes > 0;
}

/**
 * 仅当任务仍为 submitted 时改为 rejected 并记下原因。返回是否命中。
 *
 * 命中与否只靠 changes：先查状态再无条件 UPDATE，两人同时退回、
 * 或标注员恰在此刻重新提交时，后写者会覆盖先写者，冲正条目还会写两条。
 *
 * 不带租户谓词是因为只被管理员全局视图调用；任务存在性由 service 先判。
 * 不接收时间戳：schema 没有 rejected_at 列，传进来也无处可写。
 */
export function rejectIfSubmitted(db: DB, args: { taskId: string; reason: string }): boolean {
  // audit-ignore: 管理员退回，任务 id 已由管理员全局视图定位
  const result = db
    .prepare(
      `UPDATE tasks
          SET status = 'rejected', reject_reason = ?
        WHERE id = ? AND status = 'submitted'`,
    )
    .run(args.reason, args.taskId);
  return result.changes > 0;
}

export type TaskInsert = {
  id: string;
  tenantId: string;
  videoId: string;
  title: string;
  description: string | null;
  createdBy: string;
  createdAt: number;
};

/** better-sqlite3 把约束失败挂在 err.code 上。RULES 要求在 repo 层译成领域错误。 */
function isConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 插入一条待领取任务。status 与 claimed_by 交给 schema 默认值（pending / NULL），
 * 避免调用方在参数里各写一份状态。
 */
export function insertTask(db: DB, row: TaskInsert): void {
  try {
    db.prepare(
      `INSERT INTO tasks (id, tenant_id, video_id, title, description, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.tenantId,
      row.videoId,
      row.title,
      row.description,
      row.createdBy,
      row.createdAt,
    );
  } catch (err) {
    // 正常路径已先校验过视频与租户，撞上外键说明校验与写入之间被并发删除
    if (isConstraintViolation(err)) throw new NotFoundError('租户或视频不存在');
    throw err;
  }
}
