/**
 * 统计页（/stats）：三个视图共用同一份 URL 区间，数据在服务端算。
 *
 * 管理员与标注员都能进，可见范围不由本页判断 —— listStats 按角色收窄（标注员只有自己）。
 * 因此这里不 redirect，管理员与标注员看到的是同一个页面、不同的行。
 *
 * 视图与区间只从 searchParams 读：刷新不丢，链接即视图。手改坏的区间回落默认值而不是
 * 让 service 抛错（页面级抛错会整页变 500），回落时由 StatsView 提示一句。
 */
import type { Metadata } from 'next';
import AppShell from '@/components/app-shell';
import PageHeader from '@/components/page-header';
import { getDb } from '@/lib/server/db';
import { requireUser } from '@/lib/server/guards';
import { listStats } from '@/lib/services/stats-service';
import { normalizeDimension, resolveRange } from '@/lib/stats-range';
import { todayIn } from '@/lib/time';
import StatsView from './StatsView';

export const metadata: Metadata = { title: '统计 · 片段标注' };

type Props = {
  searchParams: Promise<{
    dim?: string | string[];
    from?: string | string[];
    to?: string | string[];
  }>;
};

export default async function StatsPage({ searchParams }: Props) {
  const user = await requireUser();
  const params = await searchParams;

  // 「今天」按租户时区算：同一天里，东八区与西五区的用户不该共享同一个 last7
  const today = todayIn(user.timezone);
  const { range, adjusted } = resolveRange(params.from, params.to, today);
  const result = listStats(getDb(), user, {
    dimension: normalizeDimension(params.dim, user.role === 'admin'),
    from: range.from,
    to: range.to,
  });

  return (
    <AppShell user={{ displayName: user.displayName, role: user.role }}>
      <div className="mx-auto max-w-[1080px]">
        <PageHeader
          title="统计"
          description="时长都是账本净额：退回会在原提交日冲正，所以过去的某一天数字可能变小。"
          back={{
            href: user.role === 'admin' ? '/admin/tasks' : '/tasks',
            label: user.role === 'admin' ? '任务管理' : '我的任务',
          }}
        />
        <StatsView
          result={result}
          range={range}
          today={today}
          isAdmin={user.role === 'admin'}
          rangeAdjusted={adjusted}
        />
      </div>
    </AppShell>
  );
}
