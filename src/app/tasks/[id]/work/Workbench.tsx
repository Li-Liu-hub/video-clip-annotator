'use client';

/**
 * 工作台播放器：受控 <video> + 自绘播放控件，下方挂时间轴，右侧片段栏留占位。
 *
 * 不用原生 controls：时间轴要与播放头共用「当前时间 / 总时长 / 是否在播」，
 * 原生控件把这些状态关在浏览器内部，取不到就只能整块重写。
 * 不用 blob URL：<video src> 是同源请求，浏览器自动带 session Cookie；
 * 先 fetch 再 createObjectURL 会把整个文件读进内存，并失去 Range，拖动进度条即失效。
 */
import { useEffect, useRef, useState } from 'react';
import type { Segment } from '@/lib/segment-interval';
import type { WorkTask } from '@/lib/services/workbench-service';
import Timeline from './Timeline';

/** 毫秒 → mm:ss。分钟不折进位（超过一小时显示 65:03），与播放器时间轴同一口径。 */
function formatClock(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

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

type Props = { task: WorkTask };

// E4 接入真实片段后删除
/** 演示片段：工作台还没有片段来源（E4 才做 CRUD），?demo=1 时用它验证时间轴渲染。 */
const DEMO_SEGMENTS: Segment[] = [
  { startMs: 1200, endMs: 4600 },
  { startMs: 7200, endMs: 12800 },
  { startMs: 15400, endMs: 17200 },
];

export default function Workbench({ task }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  /** 只接纳有限值；null 表示还没读到 metadata，或读到的是 Infinity */
  const [mediaDurationSec, setMediaDurationSec] = useState<number | null>(null);

  /**
   * moov 在文件尾部的 mp4（fixtures/pusht-pushblock.mp4 就是），loadedmetadata 时
   * duration 可能是 Infinity，直接显示即 Infinity/NaN；退回建任务时写入的时长。
   */
  const durationSec = mediaDurationSec ?? task.durationMs / 1000;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // 换任务时 <video> 由 key 重建，组件状态也得跟着归零，否则进度停在上一段
    setPlaying(false);
    setCurrentMs(0);
    setMediaDurationSec(null);

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

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('loadedmetadata', onDuration);
    video.addEventListener('durationchange', onDuration);

    return () => {
      // 漏 removeEventListener：旧元素继续 setState，切换任务后状态错乱；
      // 漏 pause：离开页面后这个 video 仍在缓冲，白占带宽
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('loadedmetadata', onDuration);
      video.removeEventListener('durationchange', onDuration);
      video.pause();
    };
  }, [task.id]);

  useEffect(() => {
    // E4 接入真实片段后删除
    // 读 location 而非 useSearchParams：这个 demo 开关只临时存在一个功能点，
    // 不值得为它在客户端组件里引入 Suspense 边界
    if (new URLSearchParams(window.location.search).get('demo') === '1') {
      setSegments(DEMO_SEGMENTS);
    }
  }, []);

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row">
        <section
          className="panel min-w-0 flex-1 overflow-hidden"
          aria-label="视频"
        >
          {/* 固定 16:9 舞台 + object-contain：非 16:9 素材左右留 void 底色，不拉伸变形 */}
          <div className="flex aspect-video items-center justify-center bg-void">
            <video
              key={task.id}
              ref={videoRef}
              src={task.streamUrl}
              preload="metadata"
              playsInline
              className="h-full w-full object-contain"
            />
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
              {formatClock(currentMs)} / {formatClock(durationSec * 1000)}
            </span>
          </div>
        </section>

        <aside className="panel flex w-full shrink-0 flex-col lg:w-[280px]" aria-label="片段">
          <div className="border-b border-line-soft px-3.5 py-2.5">
            <h2 className="text-[12.5px] font-medium text-ink">片段</h2>
          </div>
          <div className="flex flex-1 items-center justify-center px-3.5 py-8">
            <p className="text-[11.5px] text-ink-faint">还没有片段</p>
          </div>
        </aside>
      </div>

      <Timeline
        durationMs={durationSec * 1000}
        segments={segments}
        videoRef={videoRef}
        onSeek={seekTo}
      />
    </div>
  );
}
