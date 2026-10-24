'use client';

/**
 * 工作台播放器：受控 <video> + 自绘播放控件，下方挂时间轴，右侧片段栏显示数量。
 *
 * 不用原生 controls：时间轴要与播放头共用「当前时间 / 总时长 / 是否在播」，
 * 原生控件把这些状态关在浏览器内部，取不到就只能整块重写。
 * 不用 blob URL：<video src> 是同源请求，浏览器自动带 session Cookie；
 * 先 fetch 再 createObjectURL 会把整个文件读进内存，并失去 Range，拖动进度条即失效。
 */
import { useEffect, useRef, useState } from 'react';
import type { Segment } from '@/lib/segment-interval';
import type { SegmentRow } from '@/lib/services/segment-service';
import { formatDuration } from '@/lib/time';
import type { WorkTask } from '@/lib/services/workbench-service';
import Timeline from './Timeline';

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3.5 2.2v7.6l6.2-3.8-6.2-3.8Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <rect x="3" y="2.2" width="2.2" height="7.6" rx="0.6" fill="currentColor" />
      <rect x="6.8" y="2.2" width="2.2" height="7.6" rx="0.6" fill="currentColor" />
    </svg>
  );
}

type Props = { task: WorkTask; initialSegments: SegmentRow[] };

/** 失败提示的存活时间：够看清一句话，又不会在连续标注时一直挡着时间轴。 */
const ERROR_VISIBLE_MS = 3000;

const GENERIC_SAVE_FAILED = '保存失败，请检查网络后重试';

/** 只认契约里的四个字段；服务端多给的字段一律不带进本地状态。 */
function readSegment(payload: unknown): SegmentRow | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { segment } = payload as Record<string, unknown>;
  if (typeof segment !== 'object' || segment === null) return null;

  const row = segment as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.startMs !== 'number' || typeof row.endMs !== 'number') {
    return null;
  }
  return {
    id: row.id,
    startMs: row.startMs,
    endMs: row.endMs,
    label: typeof row.label === 'string' ? row.label : null,
  };
}

/** 错误体是 { error: { message } }；解不出来就用通用文案，绝不把整段 JSON 显示给用户。 */
function readErrorMessage(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return GENERIC_SAVE_FAILED;
  const { error } = payload as Record<string, unknown>;
  if (typeof error !== 'object' || error === null) return GENERIC_SAVE_FAILED;
  const { message } = error as Record<string, unknown>;
  return typeof message === 'string' && message.length > 0 ? message : GENERIC_SAVE_FAILED;
}

export default function Workbench({ task, initialSegments }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  /** 首屏来自服务端，之后以接口返回为准 —— 本地只是服务器状态的副本。 */
  const [segments, setSegments] = useState<SegmentRow[]>(initialSegments);
  /** 提交中只挡一小条提示，不做全屏遮罩：遮罩会打断正在进行的标注。 */
  const [committing, setCommitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 只接纳有限值；null 表示还没读到 metadata，或读到的是 Infinity */
  const [mediaDurationSec, setMediaDurationSec] = useState<number | null>(null);
  /** 视频流加载失败。没有这个开关，黑屏页面无法区分「没加载完」与「文件坏了」。 */
  const [loadFailed, setLoadFailed] = useState(false);

  /**
   * moov 在文件尾部的 mp4（fixtures/pusht-pushblock.mp4 就是），loadedmetadata 时
   * duration 可能是 Infinity，直接显示即 Infinity/NaN；退回建任务时写入的时长。
   */
  // 只用 > 0 的媒体时长。`??` 会把 0 当成有效值接住（Number.isFinite(0) 为 true），
  // 而 0 会让整条时间轴静默禁用：刻度为空、色块不画、点击不 seek，比播放头消失更难察觉。
  // 服务端 durationMs 有 CHECK (> 0) 保证，作为兜底更可靠。
  const durationSec = mediaDurationSec !== null && mediaDurationSec > 0 ? mediaDurationSec : task.durationMs / 1000;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // 换任务时 <video> 由 key 重建，组件状态也得跟着归零，否则进度停在上一段
    setPlaying(false);
    setCurrentMs(0);
    setMediaDurationSec(null);
    setLoadFailed(false);

    const onTime = () => setCurrentMs(video.currentTime * 1000);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrentMs(video.currentTime * 1000);
    };
    const onDuration = () => {
      // Infinity 不进展示层：媒体信息还没就绪时，由服务端时长兜底
      setMediaDurationSec(Number.isFinite(video.duration) ? video.duration : null);
    };
    // 流接口失败时返回的是 JSON，video 元素解不出来只会静默黑屏。
    // 不给出口的话，用户无法区分「还没加载完」和「视频坏了」
    const onError = () => setLoadFailed(true);

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('loadedmetadata', onDuration);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('error', onError);

    return () => {
      // 漏 removeEventListener：旧元素继续 setState，切换任务后状态错乱；
      // 漏 pause：离开页面后这个 video 仍在缓冲，白占带宽
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('loadedmetadata', onDuration);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('error', onError);
      video.pause();
    };
  }, [task.id]);

  useEffect(() => {
    if (!saveError) return;
    // 3 秒后自动消失。下一次提交会先把 saveError 置空，定时器被清理，提示不会堆叠。
    const timer = setTimeout(() => setSaveError(null), ERROR_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [saveError]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // 播放可能被浏览器拒绝（解码失败、策略限制）；保持暂停态，别留下没人处理的 rejection
      void video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  }

  /** 时间轴点击定位。先同步文本，不等 4Hz 的 timeupdate 回填，否则数字滞后于画面。 */
  function seekTo(ms: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = ms / 1000;
    setCurrentMs(ms);
  }

  /**
   * 提交拖拽草案：replacedIndex 为 null 是新建，否则替换那一段。
   *
   * 只有服务端返回成功才改本地数组：失败时若先乐观更新，界面会显示一个刷新后消失的片段。
   * 替换会换 id（服务端先删后插），所以按被替换项的 id 移除，再按 startMs 重排 ——
   * 从右往左框选、或把片段拖到别的片段之前都会打乱顺序，
   * 而时间轴与 normalizeSegments 的下标都以「起点升序」为前提。
   */
  async function commitSegment(draft: Segment, replacedIndex: number | null) {
    const replaced = replacedIndex === null ? null : segments[replacedIndex] ?? null;

    setSaveError(null);
    setCommitting(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startMs: draft.startMs,
          endMs: draft.endMs,
          replaces: replaced?.id ?? null,
        }),
      });
      // 先解析再判 ok：错误体的 message 是唯一能给用户的线索（重叠、越界、任务已被提交）
      const payload: unknown = await response.json();
      if (!response.ok) {
        setSaveError(readErrorMessage(payload));
        return;
      }

      const saved = readSegment(payload);
      if (!saved) {
        setSaveError(GENERIC_SAVE_FAILED);
        return;
      }
      setSegments((prev) => {
        const kept = replaced ? prev.filter((row) => row.id !== replaced.id) : prev;
        return [...kept, saved].sort((a, b) => a.startMs - b.startMs);
      });
    } catch {
      // 断网、响应不是 JSON：本地数组保持原样，用户只看得到提示
      setSaveError(GENERIC_SAVE_FAILED);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row">
        <section
          className="panel min-w-0 flex-1 overflow-hidden"
          aria-label="视频"
        >
          {/* 固定 16:9 舞台 + object-contain：非 16:9 素材左右留 void 底色，不拉伸变形 */}
          <div className="relative flex aspect-video items-center justify-center bg-void">
            <video
              key={task.id}
              ref={videoRef}
              src={task.streamUrl}
              preload="metadata"
              playsInline
              className="h-full w-full object-contain"
            />
            {loadFailed ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-void/90 px-6 text-center">
                <p className="text-[12.5px] text-ink">视频加载失败</p>
                <p className="text-[11px] text-ink-faint">
                  文件可能已被删除或没有访问权限，请刷新重试；仍不行请联系管理员
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-3 border-t border-line-soft px-3 py-2.5">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-dim transition-colors hover:border-accent-2 hover:text-ink"
              aria-label={playing ? '暂停' : '播放'}
              onClick={togglePlay}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <span className="tnum ml-auto text-[12px] text-ink-dim">
              {formatDuration(currentMs, false)} / {formatDuration(durationSec * 1000, false)}
            </span>
          </div>
        </section>

        <aside className="panel flex w-full shrink-0 flex-col lg:w-[280px]" aria-label="片段">
          <div className="border-b border-line-soft px-3.5 py-2.5">
            <h2 className="text-[12.5px] font-medium text-ink">片段</h2>
          </div>
          <div className="flex flex-1 items-center justify-center px-3.5 py-8">
            {segments.length === 0 ? (
              <p className="text-[11.5px] text-ink-faint">还没有片段</p>
            ) : (
              <p className="text-[11.5px] text-ink-dim">{segments.length} 个片段</p>
            )}
          </div>
        </aside>
      </div>

      {/* 固定高度：提示出现与消失都不推挤时间轴，标注时轨道位置不跳 */}
      <div className="flex h-4 items-center px-1" aria-live="polite">
        {saveError ? (
          <p className="text-[11.5px] text-bad">{saveError}</p>
        ) : committing ? (
          <p className="text-[11.5px] text-ink-faint">保存中…</p>
        ) : null}
      </div>

      {/*
        必须取整：video.duration 是浮点秒（实际常为 30.030000686645508），
        乘 1000 后带小数传下去，拖到片尾的草案边界会是非整数毫秒，
        E4 的 normalizeSegments 会以 not-integer 拒收 —— 表现为「拖到片尾的片段存不了」。
      */}
      <Timeline
        durationMs={Math.round(durationSec * 1000)}
        segments={segments}
        videoRef={videoRef}
        onSeek={seekTo}
        onCommit={commitSegment}
      />
    </div>
  );
}
