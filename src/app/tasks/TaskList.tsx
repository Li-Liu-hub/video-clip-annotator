/**
 * 任务列表的展示层：一张表格 + 分页控件，标注员页与管理员页共用。
 *
 * 共用而非各写一份的原因：两页只差「租户列」这一列，
 * 拆成两份后状态配色与空态文案必然各自漂移。
 */
import Link from 'next/link';
import type { TaskRow } from '@/lib/services/task-service';
import { formatDuration, localDateOf } from '@/lib/time';

type TaskListProps = { items: TaskRow[]; showTenant: boolean; timezone: string };

type TaskPagerProps = { total: number; page: number; pageSize: number; basePath: string };

/**
 * 状态标签的文案与配色。
 * 四色只在设计 token 里定义过，组件不得写死色值；pending 取中性灰，表示「还没有归属」。
 */
const STATUS: Record<TaskRow['status'], { label: string; className: string }> = {
  pending: { label: '待领取', className: 'text-ink-dim' },
  claimed: { label: '进行中', className: 'text-accent' },
  submitted: { label: '已提交', className: 'text-good' },
  rejected: { label: '已退回', className: 'text-bad' },
};

export default function TaskList({ items, showTenant, timezone }: TaskListProps) {
  if (items.length === 0) {
    return (
      <div className="panel px-4 py-10 text-center">
        <p className="text-[12.5px] text-ink-dim">暂时没有任务</p>
      </div>
    );
  }

  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="border-b border-line-soft text-[11px] text-ink-faint">
              <th className="px-4 py-2.5 font-normal">视频</th>
              {showTenant ? <th className="px-3 py-2.5 font-normal">租户</th> : null}
              <th className="px-3 py-2.5 font-normal">时长</th>
              <th className="px-3 py-2.5 font-normal">状态</th>
              <th className="px-3 py-2.5 font-normal">领取人</th>
              <th className="px-4 py-2.5 font-normal">创建日期</th>
            </tr>
          </thead>
          <tbody>
            {items.map((task) => {
              const status = STATUS[task.status];
              return (
                <tr
                  key={task.id}
                  className="border-b border-line-soft transition-colors last:border-0 hover:bg-panel-2/40"
                >
                  <td className="px-4 py-2.5">
                    <div
                      className="max-w-[320px] truncate text-[12.5px] text-ink"
                      title={task.video_filename}
                    >
                      {task.video_filename}
                    </div>
                  </td>
                  {showTenant ? (
                    <td className="px-3 py-2.5 text-[12px] text-ink-dim">{task.tenant_name}</td>
                  ) : null}
                  <td className="tnum px-3 py-2.5 text-[12px] text-ink-dim">
                    {formatDuration(task.estimated_ms, false)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`tag ${status.className}`}>{status.label}</span>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-ink-dim">
                    {task.claimed_by_name ?? '—'}
                  </td>
                  <td className="tnum px-4 py-2.5 text-[12px] text-ink-faint">
                    {localDateOf(task.created_at, timezone)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 单页时整块不渲染：一个永远点不动的翻页条只是噪音。 */
export function TaskPager({ total, page, pageSize, basePath }: TaskPagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  return (
    <nav className="mt-3 flex items-center justify-end gap-2.5 text-[11.5px] text-ink-faint" aria-label="分页">
      <span className="tnum">
        第 {page} / {totalPages} 页
      </span>
      {page > 1 ? (
        <Link className="btn btn-ghost" href={`${basePath}?page=${page - 1}`}>
          上一页
        </Link>
      ) : null}
      {page < totalPages ? (
        <Link className="btn btn-ghost" href={`${basePath}?page=${page + 1}`}>
          下一页
        </Link>
      ) : null}
    </nav>
  );
}

/**
 * 从查询串取页码。两个列表页共用，避免一处接受 0 / NaN、另一处拒绝。
 * 非法值一律回落 1：负 OFFSET 在 SQLite 里是合法值，会静默返回奇怪的结果。
 */
export function parsePageParam(raw: string | string[] | undefined): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}
