/**
 * 审计列表的展示回落：谁、对象、详情摘要。
 *
 * 为什么住在 lib 而不是 AuditTable 里：
 * 「谁」这一列是本页最容易做错的地方 —— 登录失败的行 actorId 是 NULL，
 * 直接显示「未知」就把唯一的线索（detail.username）丢了。
 * 这条判断留在客户端组件里，node 环境测不到，等于无人验证。
 */
/** 审计行的展示子集：repo 的 AuditRow 有更多字段，这里只关心展示用到的。 */
export type AuditDisplayRow = {
  actorName: string | null;
  attemptedUsername: string | null;
  targetTitle: string | null;
  targetId: string | null;
};

export const UNKNOWN_ACTOR = '未知用户';
const EMPTY_TEXT = '—';
const TARGET_ID_PREVIEW_CHARS = 8;
export const DETAIL_PREVIEW_CHARS = 60;

/**
 * 「谁」这一列最容易被做错的地方：登录失败的行没有 actor_id（用户不存在时也不可能有），
 * 直接显示「未知」就把唯一的线索丢了。要回落到 detail 里的 username ——
 * 被爆破时，那串用户名正是唯一能追的东西。
 */
export function actorLabelOf(row: AuditDisplayRow): string {
  return row.actorName ?? row.attemptedUsername ?? UNKNOWN_ACTOR;
}

/** 对象：join 得到任务标题就显示标题，否则退回 id 前 8 位（任务已删或本就不是任务）。 */
export function targetLabelOf(row: AuditDisplayRow): string {
  if (row.targetTitle) return row.targetTitle;
  if (row.targetId) return row.targetId.slice(0, TARGET_ID_PREVIEW_CHARS);
  return EMPTY_TEXT;
}

export type DetailEntry = { key: string; value: string };

export function detailPreviewOf(detail: string, entries: DetailEntry[] | null): string {
  const text = entries ? entries.map((entry) => `${entry.key}: ${entry.value}`).join(' · ') : detail;
  return text.length > DETAIL_PREVIEW_CHARS ? `${text.slice(0, DETAIL_PREVIEW_CHARS)}…` : text;
}
