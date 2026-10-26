'use client';

/** 审核播放器：每次只播放一个冻结片段，版本切换暂停，退回绑定已看的提交。 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import VideoPlayer, { VideoSegmentsPanel } from '@/components/video-player';
import SegmentList from '@/app/tasks/[id]/work/SegmentList';
import Timeline from '@/app/tasks/[id]/work/Timeline';
import { withBasePath } from '@/lib/base-path';
import { MAX_REASON_LENGTH } from '@/lib/review-limits';
import { formatDateTime, formatDuration } from '@/lib/time';
import type { TaskReview } from '@/lib/services/review-query-service';

const MS_PER_SECOND = 1_000;

export default function ReviewPlayer({ review, timezone, initialDate }: {
  review: TaskReview; timezone: string; initialDate?: string;
}) {
  const router = useRouter();
  const [version, setVersion] = useState(() => Math.max(0, review.submissions.findIndex((s) => s.date === initialDate)));
  const [active, setActive] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(review.durationMs);
  const [loadFailed, setLoadFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const playRequest = useRef(0);
  const busyRef = useRef(false);
  const submission = review.submissions[version];
  const segments = submission?.segments.map((segment, index) => ({ ...segment, id: `${submission.id}_${index}` })) ?? [];
  const timelineSegments = segments.filter((segment) => segment.startMs < durationMs)
    .map((segment) => ({ ...segment, endMs: Math.min(segment.endMs, durationMs) }));
  const selectedId = active === null ? null : segments[active]?.id ?? null;

  // timeupdate 在某些浏览器间隔较大，逐帧检查边界，避免明显播放到片段外。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let frame = 0;
    const check = () => {
      if (stopAt.current !== null && video.currentTime >= stopAt.current) {
        video.pause();
        video.currentTime = stopAt.current;
        setCurrentMs(stopAt.current * MS_PER_SECOND);
        stopAt.current = null;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => { cancelAnimationFrame(frame); playRequest.current += 1; video.pause(); };
  }, []);

  /** 设置起止点后播放；快速切段产生的旧播放错误不覆盖当前提示。 */
  async function playSegment(index: number) {
    const video = videoRef.current;
    const segment = submission?.segments[index];
    if (!video || !segment || segment.startMs >= durationMs) return;
    const request = ++playRequest.current;
    video.pause();
    // 旧数据可能有越界片段：保留原快照供核对，播放止于素材末尾并在列表提示。
    stopAt.current = Math.min(segment.endMs, durationMs) / MS_PER_SECOND;
    video.currentTime = segment.startMs / MS_PER_SECOND;
    setCurrentMs(segment.startMs);
    setActive(index);
    setNotice('');
    try { await video.play(); } catch {
      if (request === playRequest.current) setNotice('播放未能开始，请点击播放器的播放按钮重试');
    }
  }

  /** 版本变化时取消片段范围，不让旧片段的终点影响新快照。 */
  function changeVersion(index: number) {
    playRequest.current += 1;
    videoRef.current?.pause();
    stopAt.current = null;
    setVersion(index); setActive(null); setNotice('');
  }

  /** 共用播放按钮仅控制播放；定位到时间轴时解除单段范围以便核对上下文。 */
  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setNotice('播放未能开始，请点击播放器的播放按钮重试'));
    } else video.pause();
  }

  function seekTo(ms: number) {
    const video = videoRef.current;
    if (!video) return;
    stopAt.current = null;
    video.currentTime = ms / MS_PER_SECOND;
    setCurrentMs(ms);
  }

  function readDuration() {
    const duration = videoRef.current?.duration;
    if (duration !== undefined && Number.isFinite(duration) && duration > 0) setDurationMs(Math.round(duration * MS_PER_SECOND));
  }

  async function reject() {
    if (busyRef.current || !submission || !reason.trim()) return;
    busyRef.current = true; setBusy(true); setNotice('');
    try {
      const res = await fetch(withBasePath(`/api/tasks/${review.taskId}/reject`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), submissionId: submission.id }),
      });
      if (!res.ok) {
        setNotice(res.status === 409 ? '任务或提交版本已变化，请刷新后重新审核' : '退回失败，请稍后重试');
        return;
      }
      setRejected(true); setNotice('已退回，原提交日的工作量已冲正'); router.refresh();
    } catch { setNotice('网络异常，请重试'); } finally { busyRef.current = false; setBusy(false); }
  }

  if (!submission) return <div className="panel p-6 text-ink-dim">这条任务还没有提交记录。</div>;

  return (
    <div className="space-y-4">
      <div className="panel flex flex-wrap items-center gap-3 p-4">
        <label className="text-xs text-ink-dim">提交版本
          <select className="field mt-1" value={version} disabled={busy} onChange={(e) => changeVersion(Number(e.target.value))}>
            {review.submissions.map((s, index) => <option key={s.id} value={index}>
              {index === 0 ? '最近一次' : '历史提交'} · {formatDateTime(s.submittedAt, timezone)} · {s.displayName}
            </option>)}
          </select>
        </label>
        <p className="text-xs text-ink-dim">{submission.segments.length} 个片段 · 标注时长 {formatDuration(submission.totalMs)}</p>
        <p className="w-full text-[11.5px] text-ink-faint">展示提交时的冻结内容。点击片段从起点播放，到终点自动暂停；下方时间轴可定位核对画面。</p>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 lg:flex-row">
          <VideoPlayer videoRef={videoRef} videoKey={review.taskId} src={review.streamUrl}
            playing={playing} currentMs={currentMs} durationMs={durationMs} loadFailed={loadFailed}
            onTogglePlay={togglePlay} events={{
              onTimeUpdate: () => setCurrentMs((videoRef.current?.currentTime ?? 0) * MS_PER_SECOND),
              onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false),
              onLoadedMetadata: readDuration, onDurationChange: readDuration, onError: () => setLoadFailed(true),
            }} />
          <VideoSegmentsPanel count={segments.length}>
            <SegmentList segments={segments} selectedId={selectedId} deletingId={null}
              onSelect={(id) => void playSegment(segments.findIndex((segment) => segment.id === id))}
              onDelete={() => {}} busy={false} readOnly playOnSelect playbackDurationMs={durationMs} />
          </VideoSegmentsPanel>
        </div>
        <div className="h-4" />
        <Timeline durationMs={durationMs} segments={timelineSegments} videoRef={videoRef}
          onSeek={seekTo} onCommit={() => {}} selectedId={selectedId}
          onSelect={(id) => setActive(segments.findIndex((segment) => segment.id === id))} readOnly />
      </div>
      {review.rejectReason ? <p className="text-xs text-warn">最近退回原因：{review.rejectReason}</p> : null}
      {version === 0 && review.status === 'submitted' && !rejected ? (
        <section className="panel p-4">
          <label htmlFor="review-reason" className="text-xs text-ink-dim">退回原因（必填）</label>
          <textarea id="review-reason" className="field mt-2" rows={3} value={reason} disabled={busy}
            maxLength={MAX_REASON_LENGTH} onChange={(e) => setReason(e.target.value)} placeholder="写清片段编号、时间和需要修改的地方" />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11.5px] text-ink-faint">提交即计入工作量；发现问题时退回并冲正。</p>
            <button type="button" className="btn btn-ghost" disabled={busy || !reason.trim()} onClick={() => void reject()}>{busy ? '退回中…' : '退回修改'}</button>
          </div>
        </section>
      ) : <p className="text-xs text-ink-faint">{version > 0 ? '正在查看历史提交，仅供回顾。' : rejected ? '任务已退回。' : '当前任务不处于待审核状态，仅供回顾。'}</p>}
      {notice ? <p role="status" className="text-xs text-warn">{notice}</p> : null}
    </div>
  );
}
