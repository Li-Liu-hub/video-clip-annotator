/**
 * 标注员任务列表（/tasks）：本租户的待领取池 + 自己领取的任务。
 *
 * 管理员在此没有租户，留在本页只会看到一张与自己无关的表，故直接跳管理台。
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AppShell from '@/components/app-shell';
import PageHeader from '@/components/page-header';
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
    <AppShell user={{ displayName: user.displayName, role: user.role }}>
      <div className="mx-auto max-w-[1080px]">
        <PageHeader
          title="我的任务"
          description="待领取的任务向本空间开放；领取后只有你自己看得到。"
          actions={<span className="tnum text-[11.5px] text-ink-faint">共 {result.total} 条</span>}
        />
        <TaskList
          items={result.items}
          showTenant={false}
          timezone={user.timezone}
          currentUser={{ id: user.id, displayName: user.displayName }}
          returnPage={result.page}
        />
        <TaskPager
          total={result.total}
          page={result.page}
          pageSize={PAGE_SIZE}
          basePath="/tasks"
        />
      </div>
    </AppShell>
  );
}
