'use client';

/**
 * 新建任务表单：选视频 → 勾租户 → 填标题，提交后为每个租户各建一条任务。
 *
 * 提交中锁住按钮：后端不做「同视频+同租户+同标题」的唯一约束（重标是合法业务），
 * 连点两下就会产生两批任务，只能靠这里的 disabled 与 ref 兜住。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { withBasePath } from '@/lib/base-path';
import { MAX_TITLE_LENGTH } from '@/lib/task-limits';
import { formatDuration } from '@/lib/time';

export type VideoOption = {
  id: string;
  filename: string;
  durationMs: number;
  sizeBytes: number;
};

export type TenantOption = {
  id: string;
  name: string;
  /** 该租户当前任务数，帮助管理员判断积压 */
  taskCount: number;
};

export type TaskFormProps = {
  videos: VideoOption[];
  tenants: TenantOption[];
  initialVideoId?: string | null;
};

/** 与 VideoManager 的显示口径一致：不足 1 MB 保留两位，避免小文件显示成 0.0 MB。 */
function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb < 1 ? mb.toFixed(2) : mb.toFixed(1)} MB`;
}

/** 只取错误响应的 message；格式异常时退回通用文案，不把 undefined 渲染到页面上。 */
function messageOf(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
    }
  }
  return '创建失败，请重试';
}

type StepProps = {
  index: number;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
};

/** 三段式编号沿用登录页左栏的 `01` 语言：等宽数字 + 弱化色，标题保持正常字重。 */
function Step({ index, title, hint, children }: StepProps) {
  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-baseline gap-3">
        <span className="tnum text-[11px] text-ink-faint">{String(index).padStart(2, '0')}</span>
        <h2 className="text-[13.5px] font-medium text-ink">{title}</h2>
        {hint ? <span className="tnum ml-auto text-[11px] text-ink-faint">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export default function TaskForm({ videos, tenants, initialVideoId = null }: TaskFormProps) {
  const router = useRouter();
  const [videoId, setVideoId] = useState<string | null>(initialVideoId);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 与 submitting 并存：state 更新是异步的，同一帧内的第二次点击读到的仍是旧值
  const submittingRef = useRef(false);

  const canSubmit = videoId !== null && tenantIds.length > 0 && !submitting;

  function toggleTenant(id: string) {
    setTenantIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(withBasePath('/api/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          tenantIds,
          title,
          description: description.trim() === '' ? undefined : description,
        }),
      });
      const payload: unknown = await res.json();

      if (!res.ok) {
        setError(messageOf(payload));
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }

      // 成功后不解除锁定：页面即将切走，留出再次点击的窗口只会建出重复的一批
      router.push('/admin/tasks');
      router.refresh();
    } catch {
      setError('网络异常，请重试');
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (videos.length === 0) {
    return (
      <div className="panel px-4 py-10 text-center">
        <p className="text-[12.5px] text-ink-dim">还没有可用于建任务的视频</p>
        <p className="mt-1 text-[11.5px] text-ink-faint">先上传一个 MP4，再回来选择它。</p>
        <Link href="/admin/videos" className="btn btn-ghost mt-4">
          去上传视频
        </Link>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <Step index={1} title="选择视频" hint={`共 ${videos.length} 个素材`}>
        <div className="grid gap-2 sm:grid-cols-2">
          {videos.map((video) => {
            const active = video.id === videoId;
            return (
              <button
                key={video.id}
                type="button"
                aria-pressed={active}
                onClick={() => setVideoId(video.id)}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-accent-2 bg-accent-soft/40'
                    : 'border-line bg-panel-2/40 hover:border-accent-2/50'
                }`}
              >
                <span className="block truncate text-[12.5px] text-ink" title={video.filename}>
                  {video.filename}
                </span>
                <span className="tnum mt-1 block text-[11px] text-ink-faint">
                  {formatDuration(video.durationMs, false)} · {formatSize(video.sizeBytes)}
                </span>
              </button>
            );
          })}
        </div>
      </Step>

      <Step index={2} title="发布给哪些租户" hint={`已选 ${tenantIds.length}`}>
        {tenants.length === 0 ? (
          <p className="text-[12px] text-ink-faint">还没有租户，先由管理员完成初始化。</p>
        ) : (
          <div className="space-y-1.5">
            {tenants.map((tenant) => {
              const checked = tenantIds.includes(tenant.id);
              return (
                <label
                  key={tenant.id}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                    checked
                      ? 'border-accent-2/60 bg-accent-soft/25'
                      : 'border-line-soft bg-panel-2/30 hover:border-line'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTenant(tenant.id)}
                      className="h-3.5 w-3.5 accent-[var(--color-accent-2)]"
                    />
                    <span className="truncate text-[12.5px] text-ink">{tenant.name}</span>
                  </span>
                  <span className="tnum shrink-0 text-[11px] text-ink-faint">
                    {tenant.taskCount} 条任务
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </Step>

      <Step index={3} title="任务标题" hint={`${title.length}/${MAX_TITLE_LENGTH}`}>
        <label htmlFor="task-title" className="mb-1.5 block text-xs font-medium text-ink-dim">
          标题
        </label>
        <input
          id="task-title"
          className="field"
          value={title}
          maxLength={MAX_TITLE_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：第 3 批 · 装配线上料"
        />
        <label
          htmlFor="task-description"
          className="mb-1.5 mt-3 block text-xs font-medium text-ink-dim"
        >
          描述（可选）
        </label>
        <textarea
          id="task-description"
          className="field resize-y"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="标注时需要注意的细节"
        />
      </Step>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-bad/30 bg-bad-soft/60 px-3 py-2 text-xs text-bad"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Link href="/admin/tasks" className="btn btn-ghost">
          取消
        </Link>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit} aria-busy={submitting}>
          {submitting ? '正在创建…' : `创建 ${tenantIds.length} 条任务`}
        </button>
      </div>
    </form>
  );
}
