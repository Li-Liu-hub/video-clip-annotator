'use client';

/**
 * 时间轴：刻度 + 片段色块 + 播放头，点击轨道定位，拖拽创建 / 平移 / 调整片段。
 *
 * 播放头在 rAF 里直写 style.left，不经 React：timeupdate 只有 4Hz，用它驱动播放头
 * 会一跳一跳；每帧 setState 又会让整个工作台（含 <video>）60fps 重渲染。
 * 坐标换算读的是内层无 padding 的轨道：getBoundingClientRect() 含 padding 与 border，
 * 用带留白的外层算，点击位置会整体偏移。
 *
 * 拖拽的事件与数学都在 use-segment-drag 与 lib/segment-drag，本组件只做三件事：
 * 转发 pointerdown、按草案画预览、按状态给光标。
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { Segment } from '@/lib/segment-interval';
import { EDGE_HIT_PX } from '@/lib/segment-drag';
import { formatDuration } from '@/lib/time';
import { buildTicks } from '@/lib/timeline-scale';
import { useSegmentDrag } from './use-segment-drag';

type Props = {
  durationMs: number;
  segments: Segment[];
  videoRef: RefObject<HTMLVideoElement | null>;
  onSeek: (ms: number) => void;
  onCommit: (draft: Segment, replacedIndex: number | null) => void;
};

export default function Timeline({ durationMs, segments, videoRef, onSeek, onCommit }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  /**
   * 轨道当前像素宽度。
   *
   * 边缘热区是否显示必须按**像素**判断，与 `resolveMode` 用同一把尺子：
   * 只有色块宽于 2×EDGE_HIT_PX 时，左右各 6px 的热区才不重叠，
   * 才可能真的进入 resize。若按百分比渲染，窄块的边缘光标会显示
   * 「能拖边」而实际按下是平移 —— 光标骗人比没有光标更糟。
   */
  const [trackWidthPx, setTrackWidthPx] = useState(0);
  const { drag, onPointerDown, overlay } = useSegmentDrag({
    trackRef,
    durationMs,
    segments,
    onCommit,
    onSeek,
  });

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

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setTrackWidthPx(track.getBoundingClientRect().width);
    measure();
    // 监听尺寸而不是只在挂载时量一次：面板折叠、窗口缩放、侧栏收起都会改变轨道宽度
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  /**
   * 一切 pointerdown 都是拖拽的起点，因此在这里暂停：拖动中播放头继续走，
   * 标注员会一边拖一边看到画面在动，松手时 currentTime 已跑到别处。
   * 松手后不自动恢复 —— 标注员接下来要检查刚标的片段，自动播放反而干扰。
   *
   * 点击定位也由此处发出（状态机里位移不足阈值时走 onSeek），不再挂 onClick：
   * 两套入口会让一次点击 seek 两次，落点还差一个阈值像素。
   */
  function handlePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    hit: Segment | null,
    hitIndex: number,
  ) {
    // 右键菜单不该暂停视频；状态机内部也拦了 button，这里先拦是为了连 pause 都不发生
    if (event.button !== 0) return;
    videoRef.current?.pause();
    onPointerDown(event, hit, hitIndex);
  }

  const ready = durationMs > 0;
  const ticks = buildTicks(durationMs);
  const draft = drag.kind === 'dragging' ? drag.draft : null;
  const dragging = drag.kind === 'dragging';
  // 草案不合格（重叠 / 太短）：边框转红，提示松手也不会落库。
  // 项目没有 --color-danger，danger 语义由既有的 --color-bad 承担
  const draftBorder = overlay?.acceptable ? 'border-accent' : 'border-bad';

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
        onPointerDown={(event) => handlePointerDown(event, null, -1)}
        // touch-none：触屏上让轨道自己吃掉手势，否则系统滚动会打断拖拽
        // 拖拽中整条轨道统一 grabbing：指针已被轨道捕获，逐块判断光标只会闪烁
        className={`relative mt-1.5 h-12 touch-none rounded-md bg-panel-2 ${
          dragging ? 'cursor-grabbing [&_*]:cursor-grabbing' : 'cursor-crosshair'
        }`}
      >
        {ready
          ? segments.map((segment, index) => {
              const widthPx =
                durationMs > 0 ? ((segment.endMs - segment.startMs) / durationMs) * trackWidthPx : 0;
              // 与 resolveMode 的判据完全一致：窄块只认平移，于是也不显示边缘光标。
              // 光标显示 col-resize 而实际走 move，比完全不提示更糟 —— 用户会以为拖边无效。
              const showEdges = widthPx >= 2 * EDGE_HIT_PX;
              return (
                <div
                  key={`${segment.startMs}-${index}`}
                  title={`${formatDuration(segment.startMs, false)} – ${formatDuration(segment.endMs, false)} · ${(
                    (segment.endMs - segment.startMs) /
                    1000
                  ).toFixed(1)}s`}
                  onPointerDown={(event) => {
                    // 色块上的按下不再冒泡成「空白处创建」，否则一按就多出一段
                    event.stopPropagation();
                    handlePointerDown(event, segment, index);
                  }}
                  // 百分比定位：窗口 resize 时由 CSS 自己重算。
                  // minWidth 兜住极短片段：42 分钟视频里 200ms 的色块宽度趋近 0，看不见会被当成没标。
                  style={{
                    left: `${(segment.startMs / durationMs) * 100}%`,
                    width: `${((segment.endMs - segment.startMs) / durationMs) * 100}%`,
                    minWidth: 2,
                  }}
                  className="absolute top-1/2 h-[70%] -translate-y-1/2 cursor-grab rounded-[3px] bg-accent-2 transition-colors hover:bg-accent"
                >
                  {/* 只有宽块才渲染热区：此时左右各 EDGE_HIT_PX 互不重叠，
                      与 resolveMode 的 resize 判定区间逐像素对齐 */}
                  {showEdges ? (
                    <>
                      <span
                        className="absolute inset-y-0 left-0 cursor-col-resize"
                        style={{ width: EDGE_HIT_PX }}
                      />
                      <span
                        className="absolute inset-y-0 right-0 cursor-col-resize"
                        style={{ width: EDGE_HIT_PX }}
                      />
                    </>
                  ) : null}
                </div>
              );
            })
          : null}

        {/* 草案：半透明 + 虚线，与已确认的实心色块区分；pointer-events-none 让下方原片段继续可交互 */}
        {draft ? (
          <div
            style={{
              left: `${(draft.startMs / durationMs) * 100}%`,
              width: `${((draft.endMs - draft.startMs) / durationMs) * 100}%`,
              minWidth: 2,
            }}
            className={`pointer-events-none absolute top-1/2 h-[70%] -translate-y-1/2 rounded-[3px] border border-dashed bg-accent-2/40 opacity-70 ${draftBorder}`}
          />
        ) : null}

        {/* 时间提示：跟着鼠标水平位置，出界时由 overlay.ratio 贴边 */}
        {draft && overlay ? (
          <div
            style={{ left: `${overlay.ratio * 100}%` }}
            className="tnum pointer-events-none absolute -top-6 -translate-x-1/2 rounded border border-line bg-panel-3 px-1.5 py-0.5 text-[10.5px] whitespace-nowrap text-ink"
          >
            {formatDuration(draft.startMs)} – {formatDuration(draft.endMs)} ·{' '}
            {((draft.endMs - draft.startMs) / 1000).toFixed(1)}s
          </div>
        ) : null}

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
