/**
 * 管理员任务列表（/admin/tasks）：跨租户全量，带租户列与审核入口。
 *
 * 表格复用标注员页的 TaskList：两份表格分开写，状态配色与空态迟早不一致。
 * 没有「通过」按钮 —— 提交即计入工作量，审核只做「看」或「退回」。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import PageHeader from '@/components/page-header';
import TaskList, { TaskPager } from '@/app/tasks/TaskList';
import { parsePageParam } from '@/app/tasks/page-param';
import { getDb } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/guards';
import { PAGE_SIZE, listTasks } from '@/lib/services/task-service';

export const metadata: Metadata = { title: '任务管理 · 片段标注' };

/** 审核入口只关心这两类状态；其余状态没有「待办」，筛了也没意义。 */
type StatusFilter = 'submitted' | 'rejected' | null;

type Props = { searchParams: Promise<{ page?: string | string[]; status?: string | string[] }> };

/**
 * 只认两个筛选值。URL 是外部输入，拼错的 status 一律回落「全部」而不是报错：
 * 让人因为一个手改的查询串看到错误页，比看到全量列表更糟。
 */
function parseStatusFilter(raw: string | string[] | undefined): StatusFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'submitted' || value === 'rejected' ? value : null;
}

const FILTERS: { value: StatusFilter; label: string; href: string }[] = [
  { value: null, label: '全部', href: '/admin/tasks' },
  { value: 'submitted', label: '待审核', href: '/admin/tasks?status=submitted' },
  { value: 'rejected', label: '已退回', href: '/admin/tasks?status=rejected' },
];

export default async function AdminTasksPage({ searchParams }: Props) {
  const actor = await requireAdmin();
  const params = await searchParams;
  const page = parsePageParam(params.page);
  const status = parseStatusFilter(params.status);
  const result = listTasks(getDb(), actor, page, status);

  return (
    <div className="mx-auto max-w-[1080px]">
      <PageHeader
        title="任务"
        description="全部租户的任务。标注员只看得到本空间的待领取与自己领取的任务。"
        actions={
          <>
            <span className="tnum text-[11.5px] text-ink-faint">共 {result.total} 条</span>
            <Link href="/admin/tasks/new" className="btn btn-primary">
              新建任务
            </Link>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            href={filter.href}
            className={`btn ${filter.value === status ? 'btn-primary' : 'btn-ghost'}`}
          >
            {filter.label}
          </Link>
        ))}
        {/* 这句话解释「为什么没有通过按钮」，否则使用者会把它当成漏掉的按钮 */}
        <p className="ml-1 text-[11.5px] text-ink-faint">
          提交即计入工作量，发现问题时退回并冲正
        </p>
      </div>

      {/* 管理员不参与标注：currentUser 传 null，领取/归还按钮不渲染 */}
      <TaskList
        items={result.items}
        showTenant
        timezone={actor.timezone}
        currentUser={null}
        canReject
      />
      <TaskPager
        total={result.total}
        page={result.page}
        pageSize={PAGE_SIZE}
        basePath="/admin/tasks"
        query={status ? { status } : undefined}
      />
    </div>
  );
}
