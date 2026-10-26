'use client';

/** 标注与审核共用的视频舞台、自绘播放控件及片段侧栏。 */
import type { ComponentProps, ReactNode, RefObject } from 'react';
import { formatDuration } from '@/lib/time';

type VideoEvents = Pick<ComponentProps<'video'>,
  'onTimeUpdate' | 'onPlay' | 'onPause' | 'onEnded' | 'onLoadedMetadata' | 'onDurationChange' | 'onError' | 'onSeeking'>;

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoKey: string;
  src: string;
  playing: boolean;
  currentMs: number;
  durationMs: number;
  loadFailed: boolean;
  onTogglePlay: () => void;
  events?: VideoEvents;
};

export default function VideoPlayer({ videoRef, videoKey, src, playing, currentMs, durationMs, loadFailed, onTogglePlay, events }: Props) {
  return (
    <section className="panel min-w-0 flex-1 overflow-hidden" aria-label="视频">
      <div className="relative flex aspect-video items-center justify-center bg-void">
        <video key={videoKey} ref={videoRef} src={src} preload="metadata" playsInline
          className="h-full w-full object-contain" {...events} />
        {loadFailed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-void/90 px-6 text-center">
            <p className="text-[12.5px] text-ink">视频加载失败</p>
            <p className="text-[11px] text-ink-faint">文件可能已被删除或没有访问权限，请刷新重试；仍不行请联系管理员</p>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3 border-t border-line-soft px-3 py-2.5">
        <button type="button"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-dim transition-colors hover:border-accent-2 hover:text-ink"
          aria-label={playing ? '暂停' : '播放'} onClick={onTogglePlay}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            {playing ? <>
              <rect x="3" y="2.2" width="2.2" height="7.6" rx="0.6" fill="currentColor" />
              <rect x="6.8" y="2.2" width="2.2" height="7.6" rx="0.6" fill="currentColor" />
            </> : <path d="M3.5 2.2v7.6l6.2-3.8-6.2-3.8Z" fill="currentColor" />}
          </svg>
        </button>
        <span className="tnum ml-auto text-[12px] text-ink-dim">{formatDuration(currentMs, false)} / {formatDuration(durationMs, false)}</span>
      </div>
    </section>
  );
}

export function VideoSegmentsPanel({ count, children }: { count: number; children: ReactNode }) {
  return (
    <aside className="panel flex w-full shrink-0 flex-col overflow-hidden lg:w-[280px]" aria-label="片段">
      <div className="flex items-center justify-between border-b border-line-soft px-3.5 py-2.5">
        <h2 className="text-[12.5px] font-medium text-ink">片段</h2>
        <span className="tnum text-[11.5px] text-ink-faint">{count}</span>
      </div>
      {children}
    </aside>
  );
}
