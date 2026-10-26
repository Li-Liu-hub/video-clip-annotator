'use client';

/**
 * 管理员视频工作区：选择/拖拽 → 预检 → 读时长 → XHR 上传，成功后本地插入列表。
 *
 * 状态用一个判别联合表示，避免出现「有文件没时长」「上传中又显示错误」这类组合；
 * 上传成功后不调 router.refresh()，否则整页重渲染会让进度条闪一下才消失。
 */

import Link from 'next/link';
import { useRef, useState } from 'react';
import { formatDuration } from '@/lib/time';
import {
  checkFile,
  readDurationMs,
  uploadVideo,
  type UploadHandle,
  type VideoSummary,
} from '@/lib/video-upload';
import { MAX_VIDEO_BYTES } from '@/lib/video-limits';

const MAX_UPLOAD_MB = MAX_VIDEO_BYTES / 1024 / 1024;

/** 三种预检原因的文案只在 UI 这一处映射，service 与组件不会各写一套。 */
const CHECK_MESSAGE: Record<'too-large' | 'bad-type' | 'empty', string> = {
  empty: '文件是空的，请重新选择',
  'too-large': `文件超过 ${MAX_UPLOAD_MB} MB 上限，请先裁剪或压缩`,
  'bad-type': '只支持 MP4 视频（video/mp4）',
};

type Selected = { file: File; durationMs: number };

type Selection =
  | { kind: 'idle' }
  | { kind: 'checking'; filename: string }
  | { kind: 'invalid'; message: string }
  | ({ kind: 'ready' } & Selected)
  | ({ kind: 'uploading'; progress: number } & Selected)
  | ({ kind: 'failed'; message: string } & Selected);

type Props = { initialVideos: VideoSummary[]; timezone: string };

function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb < 1 ? mb.toFixed(2) : mb.toFixed(1)} MB`;
}

/**
 * 上传时间按显式时区拼装，不用 toLocaleString：
 * 服务端渲染与浏览器 hydration 的 ICU 数据可能不同，拼装数字才能保证两边文本一致。
 */
function formatUploadedAt(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
}

function percentOf(ratio: number): number {
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

export default function VideoManager({ initialVideos, timezone }: Props) {
  const [videos, setVideos] = useState<VideoSummary[]>(initialVideos);
  const [selection, setSelection] = useState<Selection>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<UploadHandle | null>(null);
  // 连续选文件时，早先那次读时长可能后返回；用序号丢弃过期结果
  const readSeq = useRef(0);

  const busy = selection.kind === 'checking' || selection.kind === 'uploading';
  const checking = selection.kind === 'checking' ? selection : null;
  const invalid = selection.kind === 'invalid' ? selection : null;
  const selected =
    selection.kind === 'ready' || selection.kind === 'uploading' || selection.kind === 'failed'
      ? selection
      : null;
  const totalDurationMs = videos.reduce((sum, video) => sum + video.durationMs, 0);

  function openPicker() {
    fileInputRef.current?.click();
  }

  async function choose(file: File) {
    const seq = ++readSeq.current;
    setNotice(null);

    const check = checkFile(file);
    if (!check.ok) {
      setSelection({ kind: 'invalid', message: CHECK_MESSAGE[check.reason] });
      return;
    }

    setSelection({ kind: 'checking', filename: file.name });
    try {
      const durationMs = await readDurationMs(file);
      if (seq !== readSeq.current) return;
      setSelection({ kind: 'ready', file, durationMs });
    } catch (err) {
      if (seq !== readSeq.current) return;
      setSelection({ kind: 'invalid', message: messageOf(err, '无法读取视频时长') });
    }
  }

  function startUpload(target: Selected) {
    // 按钮已禁用，这里再兜一层：重复点击绝不能发出第二个请求
    if (uploadRef.current) return;

    const { file, durationMs } = target;
    setNotice(null);
    setSelection({ kind: 'uploading', file, durationMs, progress: 0 });

    const handle = uploadVideo(file, durationMs, (ratio) => {
      setSelection((prev) =>
        prev.kind === 'uploading' ? { ...prev, progress: ratio } : prev,
      );
    });
    uploadRef.current = handle;

    handle.promise
      .then((video) => {
        setVideos((prev) => [video, ...prev]);
        setSelection({ kind: 'idle' });
        setNotice(`已上传「${video.filename}」`);
      })
      .catch((err: unknown) => {
        setSelection({
          kind: 'failed',
          file,
          durationMs,
          message: messageOf(err, '上传失败，请重试'),
        });
      })
      .finally(() => {
        uploadRef.current = null;
      });
  }

  function reset() {
    setSelection({ kind: 'idle' });
    setNotice(null);
  }

  return (
    <div className="space-y-7">
      <section className="panel p-4" aria-labelledby="upload-heading">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="upload-heading" className="text-[13.5px] font-medium text-ink">
            上传视频
          </h2>
          <span className="tnum text-[11px] text-ink-faint">MP4 · ≤ {MAX_UPLOAD_MB} MB</span>
        </div>

        <div
          onDragOver={(event) => {
            // 不 preventDefault 浏览器不会把 drop 事件交给我们，而是直接打开文件
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (!busy && file) void choose(file);
          }}
          className={`flex flex-col items-center justify-center rounded-lg border border-dashed px-4 py-7 text-center transition-colors ${
            dragging ? 'border-accent-2 bg-accent-soft/40' : 'border-line bg-panel-2/40'
          }`}
        >
          <p className="text-[12.5px] text-ink-dim">把 MP4 拖到这里</p>
          <p className="mt-1 text-[11px] text-ink-faint">上传成功后即可用于创建任务</p>
          <button type="button" className="btn btn-ghost mt-3" disabled={busy} onClick={openPicker}>
            选择文件
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,.mp4"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // 清空 value：同一个文件失败后再次选择也必须触发 change
              event.target.value = '';
              if (file) void choose(file);
            }}
          />
        </div>

        {checking ? (
          <p className="mt-3 text-[12px] text-ink-dim" aria-live="polite">
            正在读取「{checking.filename}」的时长…
          </p>
        ) : null}

        {invalid ? (
          <div
            role="alert"
            className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-bad/30 bg-bad-soft/50 px-3 py-2.5"
          >
            <p className="text-[12px] text-bad">{invalid.message}</p>
            <button type="button" className="btn btn-quiet" onClick={openPicker}>
              重新选择
            </button>
          </div>
        ) : null}

        {selected ? (
          <div className="mt-3 rounded-lg border border-line-soft bg-panel-2/40 px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[12.5px] text-ink" title={selected.file.name}>
                  {selected.file.name}
                </p>
                <p className="tnum mt-0.5 text-[11px] text-ink-faint">
                  {formatSize(selected.file.size)} · {formatDuration(selected.durationMs, false)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {selected.kind === 'ready' ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => startUpload(selected)}
                    >
                      开始上传
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={reset}>
                      移除
                    </button>
                  </>
                ) : null}

                {selected.kind === 'uploading' ? (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => uploadRef.current?.abort()}
                  >
                    取消上传
                  </button>
                ) : null}

                {selected.kind === 'failed' ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => startUpload(selected)}
                    >
                      重试
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={openPicker}>
                      重新选择
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            {selected.kind === 'uploading' ? (
              <div className="mt-2.5">
                <div
                  className="h-1 overflow-hidden rounded-full bg-panel-3"
                  role="progressbar"
                  aria-label="上传进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percentOf(selected.progress)}
                >
                  <div
                    className="h-full rounded-full bg-accent-2 transition-[width] duration-150"
                    style={{ width: `${percentOf(selected.progress)}%` }}
                  />
                </div>
                <div className="tnum mt-1 flex justify-between text-[11px] text-ink-faint">
                  <span>上传中</span>
                  <span>{percentOf(selected.progress)}%</span>
                </div>
              </div>
            ) : null}

            {selected.kind === 'failed' ? (
              <p
                role="alert"
                className="mt-2.5 rounded-md border border-bad/30 bg-bad-soft/50 px-2.5 py-1.5 text-[11.5px] text-bad"
              >
                {selected.message}
              </p>
            ) : null}
          </div>
        ) : null}

        {notice ? (
          <p
            role="status"
            className="mt-3 rounded-lg border border-good/25 bg-good-soft/40 px-3 py-2 text-[12px] text-good"
          >
            {notice}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="video-list-heading">
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <h2 id="video-list-heading" className="text-[13.5px] font-medium text-ink">
            素材库
          </h2>
          <span className="tnum text-[11px] text-ink-faint">
            合计 {formatDuration(totalDurationMs, false)}
          </span>
        </div>

        {videos.length === 0 ? (
          <div className="panel px-4 py-10 text-center">
            <p className="text-[12.5px] text-ink-dim">还没有视频</p>
            <p className="mt-1 text-[11.5px] text-ink-faint">从上方上传第一个 MP4，列表会立刻出现。</p>
          </div>
        ) : (
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left">
                <thead>
                  <tr className="border-b border-line-soft text-[11px] text-ink-faint">
                    <th className="px-4 py-2.5 font-normal">文件名</th>
                    <th className="px-3 py-2.5 font-normal">时长</th>
                    <th className="px-3 py-2.5 font-normal">大小</th>
                    <th className="px-3 py-2.5 font-normal">上传时间</th>
                    <th className="px-4 py-2.5 text-right font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((video) => (
                    <tr
                      key={video.id}
                      className="border-b border-line-soft transition-colors last:border-0 hover:bg-panel-2/40"
                    >
                      <td className="px-4 py-2.5">
                        <div className="max-w-[320px] truncate text-[12.5px] text-ink" title={video.filename}>
                          {video.filename}
                        </div>
                      </td>
                      <td className="tnum px-3 py-2.5 text-[12px] text-ink-dim">
                        {formatDuration(video.durationMs, false)}
                      </td>
                      <td className="tnum px-3 py-2.5 text-[12px] text-ink-dim">
                        {formatSize(video.sizeBytes)}
                      </td>
                      <td className="tnum px-3 py-2.5 text-[12px] text-ink-faint">
                        {formatUploadedAt(video.createdAt, timezone)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          className="btn btn-quiet"
                          href={`/admin/tasks/new?videoId=${encodeURIComponent(video.id)}`}
                        >
                          去建任务
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
