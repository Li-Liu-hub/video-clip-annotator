/**
 * audit_logs 表读写：插入、按条件分页查询。
 *
 * 审计只追加：没有 update，也没有 delete —— 不提供能力比提供后靠自觉更可靠。
 */
import { nowMs, type DB } from '@/lib/db';
import { newId } from '@/lib/db/id';

export type AuditLogInsert = {
  actorId: string | null;
  actorRole: string | null;
  tenantId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** 已序列化的 JSON；调用方负责把 undefined 折成 null */
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
};

export function insertAudit(db: DB, entry: AuditLogInsert): void {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, tenant_id, action, target_type, target_id, detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    entry.actorId,
    entry.actorRole,
    entry.tenantId,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.detail,
    entry.ip,
    entry.userAgent,
    nowMs(),
  );
}

export type AuditRow = {
  id: string;
  createdAt: number;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  /** 由 detail 解析出的用户名，登录失败时才有值 */
  attemptedUsername: string | null;
  /**
   * 展示用的操作人姓名（join users）。
   * 契约字段之外的一列：没有它，「谁」这一列只能显示一串 id。
   */
  actorName: string | null;
  /** 展示用的对象标题（join tasks），任务已被删或非任务对象时为 null */
  targetTitle: string | null;
};

export type AuditFilter = {
  action?: string;
  actorId?: string;
  fromMs: number;
  toMs: number;
};

type AuditDbRow = {
  id: string;
  created_at: number;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  actor_name: string | null;
  target_title: string | null;
};

/**
 * 列表用的展示列。
 *
 * audit-ignore: 管理员全局视图，刻意不含 tenant_id 谓词 ——
 * 管理员自己产生的行 tenant_id 就是 NULL，加了租户条件反而查不到。
 *
 * 两个 LEFT JOIN 都不参与筛选，只补展示字段：
 * 审计行必须比被审计对象活得久，join 不到时照样要能列出来。
 */
const AUDIT_SELECT = `
  SELECT a.id, a.created_at, a.actor_id, a.actor_role, a.action,
         a.target_type, a.target_id, a.detail,
         u.display_name AS actor_name,
         t.title AS target_title
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN tasks t ON t.id = a.target_id AND a.target_type = 'task'`;

/**
 * 只按 created_at 排序时，同一毫秒的两条记录在两次查询里顺序可能不同，
 * 翻页就会出现「上页末尾那条又出现在下页开头」。补 id 作次序键，排序才是全序。
 */
const AUDIT_ORDER = 'ORDER BY a.created_at DESC, a.id DESC';

/**
 * 从 detail 里取尝试登录的用户名。
 *
 * 不在 SQL 里用 json_extract：老数据的 detail 可能不是合法 JSON，
 * 一条坏记录就会让整条查询抛错、整页 500。解析失败降级为 null，
 * 其余记录照常显示 —— 审计页最不该因为一条脏数据而整页打不开。
 */
function attemptedUsernameOf(detail: string | null): string | null {
  if (detail === null) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { username } = parsed as { username?: unknown };
    return typeof username === 'string' && username.length > 0 ? username : null;
  } catch {
    return null;
  }
}

function toAuditRow(row: AuditDbRow): AuditRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: row.detail,
    attemptedUsername: attemptedUsernameOf(row.detail),
    actorName: row.actor_name,
    targetTitle: row.target_title,
  };
}

type WhereClause = { sql: string; params: (string | number)[] };

/** 列表与计数共用同一段 WHERE，两处条件不会各自漂移。 */
function whereOf(filter: AuditFilter): WhereClause {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.action !== undefined) {
    clauses.push('a.action = ?');
    params.push(filter.action);
  }
  if (filter.actorId !== undefined) {
    clauses.push('a.actor_id = ?');
    params.push(filter.actorId);
  }

  // 闭区间：审计问的是「这几天里发生过什么」，边界那一毫秒也算发生过。
  // 与业务区间的半开 [start, end) 不同，故两端都用 >= / <=。
  clauses.push('a.created_at >= ? AND a.created_at <= ?');
  params.push(filter.fromMs, filter.toMs);

  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

/**
 * 分页查询。
 *
 * 范围由「只有管理员能调用」保证（audit-query-service），不由 SQL 条件保证 ——
 * 这里没有租户谓词，见 AUDIT_SELECT 上的说明。
 */
export function listAudit(
  db: DB,
  filter: AuditFilter,
  page: { limit: number; offset: number },
): AuditRow[] {
  const where = whereOf(filter);
  const rows = db
    .prepare(`${AUDIT_SELECT} ${where.sql} ${AUDIT_ORDER} LIMIT ? OFFSET ?`)
    .all(...where.params, page.limit, page.offset) as AuditDbRow[];
  return rows.map(toAuditRow);
}

/** 筛选后的总数，与 listAudit 同一套条件。 */
export function countAudit(db: DB, filter: AuditFilter): number {
  const where = whereOf(filter);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs a ${where.sql}`)
    .get(...where.params) as { n: number };
  return row.n;
}
