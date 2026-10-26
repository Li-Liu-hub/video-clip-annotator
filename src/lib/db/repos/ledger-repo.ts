/**
 * ledger_entries 表：只追加的账本写入、单任务净额，以及三种统计聚合。
 *
 * 没有 update / delete —— 账本一旦写入就是统计的唯一依据，
 * 修正只能靠再记一条反向条目，历史日期因此永远不会被改写。
 */
import type { DB } from '@/lib/db';
import type { DateRange } from '@/lib/stats-range';

export type LedgerEntryInsert = {
  id: string;
  tenantId: string;
  taskId: string;
  submissionId: string;
  annotatorId: string;
  /** 正=计入，负=冲正。符号必须与 kind 一致，schema 的 CHECK 会拒。 */
  deltaMs: number;
  /** 计入哪一天（YYYY-MM-DD）。冲正取原提交日，不是退回当天。 */
  entryDate: string;
  kind: 'submit' | 'revoke';
  createdAt: number;
};

export type DayTotal = { date: string; totalMs: number; entryCount: number };
export type AnnotatorTotal = {
  annotatorId: string;
  displayName: string;
  date: string;
  taskId: string;
  title: string;
  segmentCount: number;
  submitCount: number;
  revokeCount: number;
  totalMs: number;
  entryCount: number;
};
export type TaskTotal = {
  taskId: string;
  title: string;
  totalMs: number;
  submitCount: number;
  revokeCount: number;
};

/** 写账本条目。 */
export function insertEntry(db: DB, entry: LedgerEntryInsert): void {
  db.prepare(
    `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id,
                                 delta_ms, entry_date, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.tenantId,
    entry.taskId,
    entry.submissionId,
    entry.annotatorId,
    entry.deltaMs,
    entry.entryDate,
    entry.kind,
    entry.createdAt,
  );
}

/** 某任务的账本净额（毫秒）。退回成功后应为 0，是与提交快照对账的最小口径。 */
export function sumByTask(db: DB, taskId: string): number {
  // audit-ignore: 按 task_id 求净额，只用于核对单条任务，不产生跨租户统计
  const row = db
    .prepare('SELECT COALESCE(SUM(delta_ms), 0) AS total FROM ledger_entries WHERE task_id = ?')
    .get(taskId) as { total: number };
  return row.total;
}

/**
 * 区间与可见范围谓词。
 *
 * 日期直接按字符串比较：entry_date 落库就是 YYYY-MM-DD，包 date() / strftime()
 * 会让 idx_ledger_daily 失效，还等于在查询期把「哪天」再算一遍（F1 已定：落库即定型）。
 *
 * tenantId 为 null 表示管理员的全量视图（RULES：管理员路径传 null 且显式），
 * 不用 `(? IS NULL OR tenant_id = ?)` 把两种范围塞进一条 SQL —— 那样标注员的
 * tenant_id 一旦为 NULL，查询会静默升级成跨租户全量。
 *
 * annotatorId 非 null 时再收窄到某个人：这是租户隔离之外的第二道。
 * 写在 SQL 谓词里而不是查完再过滤 —— 后者先把同事的工作量读进内存再丢掉。
 */
function scopeWhere(
  tenantId: string | null,
  annotatorId: string | null,
  range: DateRange,
): { sql: string; params: string[] } {
  const params = [range.from, range.to];
  let sql = 'l.entry_date >= ? AND l.entry_date <= ?';
  if (tenantId !== null) {
    sql += ' AND l.tenant_id = ?';
    params.push(tenantId);
  }
  if (annotatorId !== null) {
    sql += ' AND l.annotator_id = ?';
    params.push(annotatorId);
  }
  return { sql, params };
}

/**
 * 按日聚合。from / to 都是 YYYY-MM-DD，闭区间。
 *
 * 只 SUM(delta_ms)，不加 `WHERE kind = 'submit'`：退回是冲正条目，算进去才是净工作量。
 * 没有账目的日期不出现（不补零）：补零是展示层的事，混进这一层后 CSV 里会全是 0 行。
 */
export function dailyTotals(
  db: DB,
  tenantId: string | null,
  range: DateRange,
  annotatorId: string | null = null,
): DayTotal[] {
  const scope = scopeWhere(tenantId, annotatorId, range);
  // audit-ignore: 租户谓词由 scopeWhere 拼入；管理员显式传 null 走全量视图
  return db
    .prepare(
      `SELECT l.entry_date          AS date,
              SUM(l.delta_ms)       AS totalMs,
              COUNT(*)              AS entryCount
         FROM ledger_entries l
        WHERE ${scope.sql}
        GROUP BY l.entry_date
        ORDER BY l.entry_date ASC`,
    )
    .all(...scope.params) as DayTotal[];
}

/**
 * 按人、提交日与任务拆分；人数排名仍按区间净时长，人员内部按日期与任务排序。
 * 片段数随对应账本条目加减，不能把一次提交或一次冲正误算为一个视频片段。
 */
export function annotatorTotals(
  db: DB,
  tenantId: string | null,
  range: DateRange,
  annotatorId: string | null = null,
): AnnotatorTotal[] {
  const scope = scopeWhere(tenantId, annotatorId, range);
  // audit-ignore: 租户谓词由 scopeWhere 拼入；管理员显式传 null 走全量视图
  return db
    .prepare(
      `SELECT l.annotator_id        AS annotatorId,
              u.display_name        AS displayName,
              l.entry_date          AS date,
              l.task_id             AS taskId,
              t.title               AS title,
              SUM(CASE WHEN l.kind = 'submit' THEN s.segment_count ELSE -s.segment_count END) AS segmentCount,
              SUM(CASE WHEN l.kind = 'submit' THEN 1 ELSE 0 END) AS submitCount,
              SUM(CASE WHEN l.kind = 'revoke' THEN 1 ELSE 0 END) AS revokeCount,
              SUM(l.delta_ms)       AS totalMs,
              COUNT(*)              AS entryCount
         FROM ledger_entries l
         JOIN users u ON u.id = l.annotator_id
         JOIN tasks t ON t.id = l.task_id
         JOIN submissions s ON s.id = l.submission_id
        WHERE ${scope.sql}
        GROUP BY l.annotator_id, u.display_name, l.entry_date, l.task_id, t.title
        ORDER BY SUM(SUM(l.delta_ms)) OVER (PARTITION BY l.annotator_id) DESC,
                 l.annotator_id DESC, l.entry_date DESC, l.task_id ASC`,
    )
    .all(...scope.params) as AnnotatorTotal[];
}

/**
 * 按任务聚合。提交与退回次数分开数，让「改了几轮」可见。
 *
 * kind 只用于数次数；totalMs 仍是全部条目的 SUM，冲正不计入 totalMs 就等于没扣。
 */
export function taskTotals(
  db: DB,
  tenantId: string | null,
  range: DateRange,
  annotatorId: string | null = null,
): TaskTotal[] {
  const scope = scopeWhere(tenantId, annotatorId, range);
  // audit-ignore: 租户谓词由 scopeWhere 拼入；管理员显式传 null 走全量视图
  return db
    .prepare(
      `SELECT l.task_id             AS taskId,
              t.title               AS title,
              SUM(l.delta_ms)       AS totalMs,
              SUM(CASE WHEN l.kind = 'submit' THEN 1 ELSE 0 END) AS submitCount,
              SUM(CASE WHEN l.kind = 'revoke' THEN 1 ELSE 0 END) AS revokeCount
         FROM ledger_entries l
         JOIN tasks t ON t.id = l.task_id
        WHERE ${scope.sql}
        GROUP BY l.task_id, t.title
        ORDER BY totalMs DESC, l.task_id DESC`,
    )
    .all(...scope.params) as TaskTotal[];
}
