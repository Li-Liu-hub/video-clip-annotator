/**
 * 工作台页（/tasks/:id/work）：只有领取该任务的标注员能进。
 *
 * 归属与状态判定都在 workbench-service；页面只把 NotFoundError 翻成 404，
 * 不在这里再判一遍 —— 页面里的判断不可单测，也会与 service 各写一套。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { NotFoundError } from '@/lib/errors';
import { getDb } from '@/lib/server/db';
import { requireUser } from '@/lib/server/guards';
import { isTenantUser, type TenantUser } from '@/lib/services/auth-service';
import { listSegments, type SegmentRow } from '@/lib/services/segment-service';
import { getWorkTask, type WorkTask } from '@/lib/services/workbench-service';
import Workbench from './Workbench';

export const metadata: Metadata = { title: '标注工作台 · 片段标注' };

type Props = { params: Promise<{ id: string }> };

/** 「无权看」与「不存在」同一条出口，页面不提供第三态。 */
function loadWorkTask(user: TenantUser, taskId: string): WorkTask {
  try {
    return getWorkTask(getDb(), user, taskId);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

/**
 * 首屏片段：与任务同一次请求取，避免工作台挂载后再打一次接口。
 * getWorkTask 已确认「本人领取且 claimed」，这里不会再有归属失败。
 */
function loadSegments(user: TenantUser, taskId: string): SegmentRow[] {
  return listSegments(getDb(), user, taskId);
}

export default async function WorkPage({ params }: Props) {
  const user = await requireUser();
  // 管理员不参与标注，工作台对他没有入口价值：与 /tasks 一致回管理台，而不是伪装成 404
  if (user.role === 'admin') redirect('/admin/tasks');
  // 标注员缺租户属数据异常，按「任务不存在」处理，不新增一种错误页
  if (!isTenantUser(user)) notFound();

  const { id } = await params;
  const task = loadWorkTask(user, id);
  const segments = loadSegments(user, id);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7">
      <header className="mb-5">
        <Link
          href="/tasks"
          className="text-[11.5px] text-ink-faint transition-colors hover:text-ink"
        >
          ← 任务列表
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-4">
          <h1 className="text-[20px] font-medium tracking-tight text-ink">{task.title}</h1>
          <span className="tag text-accent">已领取</span>
        </div>
        <p className="mt-1 truncate text-[11.5px] text-ink-faint" title={task.videoFilename}>
          {task.videoFilename}
        </p>
        {task.description ? (
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">{task.description}</p>
        ) : null}
      </header>

      {/* key 绑任务 id：换任务时组件重建，useState 的初值才会重新取服务端片段 */}
      <Workbench key={task.id} task={task} initialSegments={segments} />
    </div>
  );
}
