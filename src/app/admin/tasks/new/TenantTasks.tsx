'use client';

/** 发布时按需展开现有任务，加载与翻页不改变已填写的表单。 */
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { withBasePath } from '@/lib/base-path';
import type { TaskPage } from '@/lib/services/task-service';

const LABELS = { pending: '待领取', claimed: '进行中', submitted: '已提交', rejected: '已退回' } as const;

export default function TenantTasks({ tenantId, tenantName, videoId }: {
  tenantId: string; tenantName: string; videoId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<TaskPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const contentId = useId();

  /** 只在展开或翻页时读取，失败保留表单和上一页内容供重试。 */
  async function load(page: number) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const res = await fetch(withBasePath(`/api/tenants/${tenantId}/tasks?page=${page}`), { cache: 'no-store' });
      if (!res.ok) { setError('任务加载失败，请重试'); return; }
      const payload = await res.json() as TaskPage;
      setResult(payload);
    } catch { setError('网络异常，请重试'); } finally { busyRef.current = false; setBusy(false); }
  }

  return (
    <div className="px-3 pb-2.5">
      <button type="button" className="btn btn-quiet" aria-expanded={open} aria-controls={contentId}
        onClick={() => { setOpen(!open); if (!open) void load(result?.page ?? 1); }}>
        {open ? '收起现有任务' : '查看现有任务'}<span className="sr-only"> · {tenantName}</span>
      </button>
      {open ? <div id={contentId} className="mt-2" aria-busy={busy}>
        {busy ? <p className="text-xs text-ink-faint">加载中…</p> : null}
        {error ? <div role="alert" className="text-xs text-warn">{error} <button type="button" className="btn btn-quiet" onClick={() => void load(result?.page ?? 1)}>重试</button></div> : null}
        {result ? <>
          <p className="mb-2 text-[11px] text-ink-faint">共 {result.total} 条 · 第 {result.page} 页 · 待领取任务属于该空间，领取后才归个人。</p>
          {result.items.length === 0 ? <p className="text-xs text-ink-dim">该空间还没有任务</p> : (
            <ul className="divide-y divide-line-soft">{result.items.map((task) => <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
              <div className="min-w-0">
                <p className="text-ink">{task.title}</p>
                <p className="mt-1 text-ink-faint">{task.video_filename} · {task.claimed_by_name ?? '尚未领取'}{task.video_id === videoId ? ' · 与当前所选视频相同' : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="tag">{LABELS[task.status]}</span>
                {task.status === 'submitted' || task.status === 'rejected' ? (
                  <Link href={`/admin/tasks/${task.id}/review`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">查看提交<span className="sr-only">（新标签页）</span></Link>
                ) : null}
              </div>
            </li>)}</ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className="btn btn-quiet" disabled={busy || result.page <= 1} onClick={() => void load(result.page - 1)}>上一页</button>
            <button type="button" className="btn btn-quiet" disabled={busy || result.page * result.pageSize >= result.total} onClick={() => void load(result.page + 1)}>下一页</button>
          </div>
        </> : null}
      </div> : null}
    </div>
  );
}
