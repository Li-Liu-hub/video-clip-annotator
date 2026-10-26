/**
 * 工作台页（/tasks/:id/work）：只有领取该任务的标注员能进，已提交的任务以只读方式进。
 *
 * 归属与状态判定都在 workbench-service；页面只把 NotFoundError 翻成 404，
 * 不在这里再判一遍 —— 页面里的判断不可单测，也会与 service 各写一套。
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import AppShell from '@/components/app-shell';
import PageHeader from '@/components/page-header';
import { parsePageParam } from '@/app/tasks/page-param';
import { NotFoundError } from '@/lib/errors';
import { getDb } from '@/lib/server/db';
import { requireUser } from '@/lib/server/guards';
import { isTenantUser, type TenantUser } from '@/lib/services/auth-service';
import { listSegments, type SegmentRow } from '@/lib/services/segment-service';
import { getWorkTask, type WorkTask } from '@/lib/services/workbench-service';
import Workbench from './Workbench';

export const metadata: Metadata = { title: '标注工作台 · 片段标注' };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnPage?: string | string[] }>;
};

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
 * getWorkTask 已确认「本人领取且 claimed / submitted」，这里不会再有归属失败。
 */
function loadSegments(user: TenantUser, taskId: string): SegmentRow[] {
  return listSegments(getDb(), user, taskId);
}

export default async function WorkPage({ params, searchParams }: Props) {
  const user = await requireUser();
  // 管理员不参与标注，工作台对他没有入口价值：与 /tasks 一致回管理台，而不是伪装成 404
  if (user.role === 'admin') redirect('/admin/tasks');
  // 标注员缺租户属数据异常，按「任务不存在」处理，不新增一种错误页
  if (!isTenantUser(user)) notFound();

  const { id } = await params;
  const returnPage = parsePageParam((await searchParams).returnPage);
  const task = loadWorkTask(user, id);
  const segments = loadSegments(user, id);
  // 状态只在这里判一次：客户端拿到 readOnly 直接用，不再自己查一遍（查法两处必然漂移）
  const readOnly = task.status === 'submitted';

  return (
    <AppShell user={{ displayName: user.displayName, role: user.role }}>
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title={task.title}
          back={{ href: `/tasks?page=${returnPage}`, label: '任务列表' }}
          actions={
            readOnly ? (
              <span className="tag text-good">已提交</span>
            ) : (
              <span className="tag text-accent">已领取</span>
            )
          }
          description={
            <>
              <p className="truncate text-[11.5px] text-ink-faint" title={task.videoFilename}>
                {task.videoFilename}
              </p>
              {readOnly ? <p className="mt-1.5 text-[12px] text-good">已提交，仅供查看</p> : null}
              {/* 重新打开后仍保留退回原因，标注员才知道需要修改什么。 */}
              {task.rejectReason ? (
                <p className="mt-2 rounded-[3px] border-l-2 border-bad bg-panel-2 px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-dim">
                  <span className="text-bad">退回原因：</span>
                  {task.rejectReason}
                </p>
              ) : null}
              {task.description ? <p className="mt-1.5">{task.description}</p> : null}
            </>
          }
        />

        {/* key 绑任务 id：换任务时组件重建，useState 的初值才会重新取服务端片段 */}
        <Workbench key={task.id} task={task} initialSegments={segments} readOnly={readOnly} />
      </div>
    </AppShell>
  );
}
