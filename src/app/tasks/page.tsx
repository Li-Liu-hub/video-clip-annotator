/**
 * 标注员任务列表（/tasks）：本租户的待领取池 + 自己领取的任务。
 *
 * 管理员在此没有租户，留在本页只会看到一张与自己无关的表，故直接跳管理台。
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/server/db';
import { requireUser } from '@/lib/server/guards';
import { PAGE_SIZE, listTasks } from '@/lib/services/task-service';
import TaskList, { TaskPager } from './TaskList';
import { parsePageParam } from './page-param';

export const metadata: Metadata = { title: '我的任务 · 片段标注' };

type Props = { searchParams: Promise<{ page?: string | string[] }> };

export default async function TasksPage({ searchParams }: Props) {
  const user = await requireUser();
  if (user.role === 'admin') redirect('/admin/tasks');

  const page = parsePageParam((await searchParams).page);
  const result = listTasks(getDb(), user, page);

  return (
    <div className="mx-auto max-w-[1080px] px-6 py-7">
      <header className="mb-6">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-[20px] font-medium tracking-tight text-ink">我的任务</h1>
          <span className="tnum text-[11.5px] text-ink-faint">共 {result.total} 条</span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">
          待领取的任务向本空间开放；领取后只有你自己看得到。
        </p>
      </header>

      <TaskList
        items={result.items}
        showTenant={false}
        timezone={user.timezone}
        currentUser={{ id: user.id, displayName: user.displayName }}
      />
      <TaskPager
        total={result.total}
        page={result.page}
        pageSize={PAGE_SIZE}
        basePath="/tasks"
      />
    </div>
  );
}
