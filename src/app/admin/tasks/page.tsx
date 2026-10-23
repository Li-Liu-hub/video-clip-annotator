/**
 * 管理员任务列表（/admin/tasks）：跨租户全量，带租户列。
 *
 * 表格复用标注员页的 TaskList：两份表格分开写，状态配色与空态迟早不一致。
 */
import type { Metadata } from 'next';
import TaskList, { TaskPager, parsePageParam } from '@/app/tasks/TaskList';
import { getDb } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/guards';
import { PAGE_SIZE, listTasks } from '@/lib/services/task-service';

export const metadata: Metadata = { title: '任务管理 · 片段标注' };

type Props = { searchParams: Promise<{ page?: string | string[] }> };

export default async function AdminTasksPage({ searchParams }: Props) {
  const actor = await requireAdmin();
  const page = parsePageParam((await searchParams).page);
  const result = listTasks(getDb(), actor, page);

  return (
    <div className="mx-auto max-w-[1080px]">
      <header className="mb-6">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-[20px] font-medium tracking-tight text-ink">任务</h1>
          <span className="tnum text-[11.5px] text-ink-faint">共 {result.total} 条</span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">
          全部租户的任务。标注员只看得到本空间的待领取与自己领取的任务。
        </p>
      </header>

      <TaskList items={result.items} showTenant timezone={actor.timezone} />
      <TaskPager
        total={result.total}
        page={result.page}
        pageSize={PAGE_SIZE}
        basePath="/admin/tasks"
      />
    </div>
  );
}
