'use client';

/**
 * 时间轴：刻度 + 片段色块 + 播放头，点击轨道任意位置跳转。
 *
 * 播放头在 rAF 里直写 style.left，不经 React：timeupdate 只有 4Hz，用它驱动播放头
 * 会一跳一跳；每帧 setState 又会让整个工作台（含 <video>）60fps 重渲染。
 * 坐标换算读的是内层无 padding 的轨道：getBoundingClientRect() 含 padding 与 border，
 * 用带留白的外层算，点击位置会整体偏移。
 */
import { useEffect, useRef, type RefObject } from 'react';
import type { Segment } from '@/lib/segment-interval';
import { formatDuration } from '@/lib/time';
import { buildTicks, ratioToMs } from '@/lib/timeline-scale';

type Props = {
  durationMs: number;
  segments: Segment[];
  videoRef: RefObject<HTMLVideoElement | null>;
  onSeek: (ms: number) => void;
};

export default function Timeline({ durationMs, segments, videoRef, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      const head = headRef.current;
      // 时长未就绪（0 / NaN）时不做除法，否则 style.left 变成 NaN%，播放头消失。
      // 分母用 durationMs 而非 video.duration：色块与播放头必须共用同一把尺子，
      // 且 moov 在文件尾的 mp4 读到的 duration 可能是 Infinity。
      if (video && head && durationMs > 0) {
        head.style.left = `${((video.currentTime * 1000) / durationMs) * 100}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // 漏 cancel：切任务后旧循环继续跑，内存与 CPU 双涨
    return () => cancelAnimationFrame(raf);
  }, [videoRef, durationMs]);

  /** 点击轨道定位。读内层轨道（无内边距）的盒子，否则点最左侧算出的比例不是 0。 */
  function seekAt(clientX: number) {
    const track = trackRef.current;
    if (!track || durationMs <= 0) return;
    const rect = track.getBoundingClientRect();
    // 宽度为 0 说明还没布局（隐藏或初次挂载），此时除法会得到 Infinity
    if (rect.width === 0) return;
    onSeek(ratioToMs((clientX - rect.left) / rect.width, durationMs));
  }

  const ready = durationMs > 0;
  const ticks = buildTicks(durationMs);

  return (
    <div className="panel px-4 py-3">
      {/* 刻度行与轨道同宽同起点，所以刻度位置直接按百分比落在同一条坐标轴上 */}
      <div className="relative h-3.5">
        {ticks.map((ms) => (
          <span
            key={ms}
            className="tnum absolute top-0 text-[10px] leading-none text-ink-faint"
            style={{
              left: `${(ms / durationMs) * 100}%`,
              // 首个刻度贴住左端，不左移半格，否则文字会溢出面板
              transform: ms === 0 ? undefined : 'translateX(-50%)',
            }}
          >
            {formatDuration(ms, false)}
          </span>
        ))}
      </div>

      <div
        ref={trackRef}
        onClick={(event) => seekAt(event.clientX)}
        className="relative mt-1.5 h-12 cursor-pointer rounded-md bg-panel-2"
      >
        {ready
          ? segments.map((segment, index) => (
              <div
                key={`${segment.startMs}-${index}`}
                title={`${formatDuration(segment.startMs, false)} – ${formatDuration(segment.endMs, false)} · ${(
                  (segment.endMs - segment.startMs) /
                  1000
                ).toFixed(1)}s`}
                // 百分比定位：窗口 resize 时由 CSS 自己重算，不必监听 ResizeObserver。
                // minWidth 兜住极短片段：42 分钟视频里 200ms 的色块宽度趋近 0，看不见会被当成没标。
                style={{
                  left: `${(segment.startMs / durationMs) * 100}%`,
                  width: `${((segment.endMs - segment.startMs) / durationMs) * 100}%`,
                  minWidth: 2,
                }}
                className="absolute top-1/2 h-[70%] -translate-y-1/2 rounded-[3px] bg-accent-2 transition-colors hover:bg-accent"
              />
            ))
          : null}

        {/* 播放头：初始位置由 rAF 接管，这里给 0% 只是避免首帧出现在未定位处 */}
        <div
          ref={headRef}
          style={{ left: '0%' }}
          className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-ink"
        >
          <span className="absolute top-0 left-1/2 block h-0 w-0 -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-ink" />
        </div>
      </div>
    </div>
  );
}
