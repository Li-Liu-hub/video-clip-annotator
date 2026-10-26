/**
 * 审计页（/admin/audit）：管理员查「谁在什么时候做了什么」，只读。
 *
 * 本页是全项目唯一的只读页：不提供删除，也不提供编辑 ——
 * 能被人事后擦掉或补注的记录，就不再是记录。
 * 筛选三个条件都进 URL（与 G3 同一套做法）：刷新不丢，链接即视图。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import PageHeader from '@/components/page-header';
import { TaskPager } from '@/app/tasks/TaskList';
import { parsePageParam } from '@/app/tasks/page-param';
import { AUDIT_ACTIONS, AUTH_LOGOUT_ACTION } from '@/lib/audit-actions';
import { auditActionLabel } from '@/lib/audit-labels';
import { getDb } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/guards';
import type { AuditFilter } from '@/lib/services/audit-query-service';
import { listAuditActors, listAuditLogs } from '@/lib/services/audit-query-service';
import { resolveRange } from '@/lib/stats-range';
import { dayEndMs, dayStartMs, todayIn } from '@/lib/time';
import AuditTable from './AuditTable';

export const metadata: Metadata = { title: '审计 · 片段标注' };

/**
 * 一页 50 条：审计只增不减，一年后这张表会很大，
 * 分页而不是「加载全部」—— 后者迟早把一页拖到几秒打不开。
 */
const PAGE_SIZE = 50;

/**
 * 动作下拉的选项来自常量表而不是 `SELECT DISTINCT action`：
 * 后者会让一个刚加上、还没人用过的动作在筛选里不存在，看起来像功能漏了。
 * 登出不在 AUDIT_ACTIONS 里（见 audit-actions），但库里有这类行，故一并列出。
 */
const ACTION_VALUES: readonly string[] = [...Object.values(AUDIT_ACTIONS), AUTH_LOGOUT_ACTION];

type Props = {
  searchParams: Promise<{
    action?: string | string[];
    actor?: string | string[];
    from?: string | string[];
    to?: string | string[];
    page?: string | string[];
  }>;
};

/** 查询串可能重复给同一个键，一律取第一个（与 page-param 取页码同一口径）。 */
function firstOf(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === '' ? undefined : value;
}

/**
 * 动作筛选只认常量表里的值。拼错或手改的 action 一律当作「不筛」而不是报错：
 * 让人因为一个查询串看到错误页，比看到全量列表更糟。
 */
function parseAction(raw: string | string[] | undefined): string | undefined {
  const value = firstOf(raw);
  return value !== undefined && ACTION_VALUES.includes(value) ? value : undefined;
}

export default async function AdminAuditPage({ searchParams }: Props) {
  const actor = await requireAdmin();
  const params = await searchParams;
  const page = parsePageParam(params.page);

  // 区间沿用统计页的兜底：手改坏的日期回落「最近 7 天」，不把页面变成错误页
  const { range } = resolveRange(params.from, params.to, todayIn(actor.timezone));

  const action = parseAction(params.action);
  const actorId = firstOf(params.actor);

  const filter: AuditFilter = {
    action,
    actorId,
    // 日期是自然日，区间落到使用者时区的零点与当日最后一毫秒（闭区间，见 audit-repo）
    fromMs: dayStartMs(range.from, actor.timezone),
    toMs: dayEndMs(range.to, actor.timezone),
  };

  const db = getDb();
  const { rows, total } = listAuditLogs(db, actor, filter, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const actorOptions = listAuditActors(db, actor);

  /** 翻页要带上当前筛选：丢掉 action 会让第 2 页悄悄回到「全部」。 */
  const query: Record<string, string> = { from: range.from, to: range.to };
  if (action !== undefined) query.action = action;
  if (actorId !== undefined) query.actor = actorId;

  return (
    <div className="mx-auto max-w-[1080px]">
      <PageHeader
        title="审计"
        description="只读记录：不提供删除，也不提供编辑。按动作、操作人与时间筛选。"
        actions={<span className="tnum text-[11.5px] text-ink-faint">共 {total} 条</span>}
      />

      <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
        <div className="w-[168px]">
          <label htmlFor="action" className="text-[11.5px] text-ink-dim">
            动作
          </label>
          <select id="action" name="action" defaultValue={action ?? ''} className="field mt-1">
            <option value="">全部动作</option>
            {ACTION_VALUES.map((value) => (
              <option key={value} value={value}>
                {auditActionLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="w-[168px]">
          <label htmlFor="actor" className="text-[11.5px] text-ink-dim">
            人
          </label>
          <select id="actor" name="actor" defaultValue={actorId ?? ''} className="field mt-1">
            <option value="">全部</option>
            {actorOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="w-[152px]">
          <label htmlFor="from" className="text-[11.5px] text-ink-dim">
            从
          </label>
          <input id="from" name="from" type="date" defaultValue={range.from} className="field mt-1" />
        </div>

        <div className="w-[152px]">
          <label htmlFor="to" className="text-[11.5px] text-ink-dim">
            到
          </label>
          <input id="to" name="to" type="date" defaultValue={range.to} className="field mt-1" />
        </div>

        <button type="submit" className="btn btn-primary">
          筛选
        </button>
        <Link href="/admin/audit" className="btn btn-ghost">
          最近 7 天
        </Link>
      </form>

      <AuditTable rows={rows} timezone={actor.timezone} />
      <TaskPager
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        basePath="/admin/audit"
        query={query}
      />
    </div>
  );
}
