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
 *
 * readOnly（只读回顾）不进拖拽状态机：按下不产生草案，点色块只做 seek。
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { Segment } from '@/lib/segment-interval';
import { MIN_SEGMENT_MS, overlaps } from '@/lib/interval';
import { EDGE_HIT_PX } from '@/lib/segment-drag';
import type { DraftVerdict } from '@/lib/segment-drag';
import type { SegmentRow } from '@/lib/services/segment-service';
import { formatDuration } from '@/lib/time';
import { buildTicks, ratioToMs } from '@/lib/timeline-scale';
import { useSegmentDrag } from './use-segment-drag';

type Props = {
  durationMs: number;
  segments: SegmentRow[];
  videoRef: RefObject<HTMLVideoElement | null>;
  onSeek: (ms: number) => void;
  onCommit: (draft: Segment, replacedId: string | null) => void;
  selectedId?: string | null;
  /** 入点（毫秒），null 表示未打点。画成竖线，与播放头区分。 */
  markInMs?: number | null;
  /** 点中色块即选中；是否 seek 由 E3 的阈值状态机决定，这里不重复 seek */
  onSelect?: (id: string) => void;
  /**
   * 拖拽起止通知。Escape 的优先级要用到它：拖拽中只取消拖拽，不清入点。
   * 拖拽状态机自己持有 drag 状态，父组件拿不到，只能由这里上报。
   */
  onDragActiveChange?: (active: boolean) => void;
  /** 只读回顾：不进入拖拽，点色块只 seek。缺省 false，E1–E7 的调用点不用改。 */
  readOnly?: boolean;
};

/**
 * 草案提示文案：合格写区间与时长，不合格写原因。
 *
 * 三态文案一律读 verdict，不在组件里另判一次长短或重叠 —— 判定只有 assessDraft 一份，
 * 否则「提示说合格、松手却提交不了」这类不一致迟早出现。
 * 太短时写明确的下限而不是只说「太短」：用户得知道调到多长才合格。
 */
function draftHint(draft: Segment, verdict: DraftVerdict): string {
  if (verdict.kind === 'too-short') return `太短（至少 ${MIN_SEGMENT_MS / 1000}s）`;
  if (verdict.kind === 'overlap') {
    const { with: hit } = verdict;
    return `与 ${formatDuration(hit.startMs, false)} – ${formatDuration(hit.endMs, false)} 重叠`;
  }
  return `${formatDuration(draft.startMs, false)} – ${formatDuration(draft.endMs, false)} · ${(
    (draft.endMs - draft.startMs) /
    1000
  ).toFixed(1)}s`;
}

export default function Timeline({
  durationMs,
  segments,
  videoRef,
  onSeek,
  onCommit,
  selectedId,
  markInMs,
  onSelect,
  onDragActiveChange,
  readOnly = false,
}: Props) {
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
   * 上报拖拽起止。
   *
   * 'pending' 也算在途：按下后尚未过阈值时，Escape 仍该由状态机取消这次手势，
   * 而不是顺手把入点清掉。
   */
  useEffect(() => {
    onDragActiveChange?.(drag.kind !== 'idle');
  }, [drag.kind, onDragActiveChange]);

  /**
   * 指针横坐标 → 时间并定位。只读时点色块用它：色块可点，但不该起拖拽。
   * 与状态机共用 ratioToMs，点击落点与拖拽落点因此不会差一个钳制规则。
   */
  function seekAt(clientX: number) {
    const track = trackRef.current;
    // 用 !(x > 0) 而非 x <= 0：NaN 会让换算一路变成 NaN
    if (!track || !(durationMs > 0)) return;
    const rect = track.getBoundingClientRect();
    // 尚未布局（隐藏或首次挂载）时宽度为 0，除法会得到 Infinity
    if (rect.width === 0) return;
    onSeek(ratioToMs((clientX - rect.left) / rect.width, durationMs));
  }

  /**
   * 一切 pointerdown 都是拖拽的起点，因此在这里暂停：拖动中播放头继续走，
   * 标注员会一边拖一边看到画面在动，松手时 currentTime 已跑到别处。
   * 松手后不自动恢复 —— 标注员接下来要检查刚标的片段，自动播放反而干扰。
   *
   * 点击定位也由此处发出（状态机里位移不足阈值时走 onSeek），不再挂 onClick：
   * 两套入口会让一次点击 seek 两次，落点还差一个阈值像素。
   */
  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, hit: SegmentRow | null) {
    // 右键菜单不该暂停视频；状态机内部也拦了 button，这里先拦是为了连 pause 都不发生
    if (event.button !== 0) return;
    if (readOnly) {
      // 只读：不进拖拽状态机，连草案都不出现。色块仍要能 seek —— 回顾时最常做的动作
      // 就是「跳到这一段」。也不暂停：暂停是拖拽的需要，只点时打断播放反而碍事。
      if (hit) seekAt(event.clientX);
      return;
    }
    videoRef.current?.pause();
    onPointerDown(event, hit);
  }

  const ready = durationMs > 0;
  const ticks = buildTicks(durationMs);
  const draft = drag.kind === 'dragging' ? drag.draft : null;
  const dragging = drag.kind === 'dragging';
  const verdict = overlay?.verdict ?? null;
  // 不合格（太短 / 重叠）：边框转红，让用户松手前就知道不会落库。
  // 项目没有 --color-danger，danger 语义由既有的 --color-bad 承担
  const draftBorder = verdict && verdict.kind !== 'ok' ? 'border-bad' : 'border-accent';
  /**
   * 冲突段高亮取「全部」冲突，不是 findConflict 的第一个。
   * 文案只说第一段（人一次只能修一处），但视觉上只标一段，用户会以为旁边那段没问题。
   * 高亮用 ring（box-shadow）而非额外节点：不占布局、也不改变命中区域，
   * 草案本身 pointer-events-none，拖到冲突段上方时事件仍落在轨道上。
   */
  /**
   * 冲突段：所有与草案重叠的片段。
   *
   * 用 filter 而非 verdict.with：with 只是数组里第一个，只标它会让用户
   * 以为旁边那段没问题。同时跳过正在被拖的那一段 —— 平移与调整端点时
   * 草案必然压着自己原位，不排除就会看到「拖自己，自己变红」。
   */
  const conflictedIds = new Set(
    verdict?.kind === 'overlap' && draft
      ? segments
          .filter((segment) => segment.id !== overlay?.movingId && overlaps(segment, draft))
          .map((segment) => segment.id)
      : [],
  );

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
        onPointerDown={(event) => handlePointerDown(event, null)}
        // touch-none：触屏上让轨道自己吃掉手势，否则系统滚动会打断拖拽
        // 拖拽中整条轨道统一 grabbing：指针已被轨道捕获，逐块判断光标只会闪烁
        // 只读时 cursor-default：crosshair 会让人以为能拖，拖了没反应比没有光标更糟
        className={`relative mt-1.5 h-12 touch-none rounded-md bg-panel-2 ${
          readOnly
            ? 'cursor-default'
            : dragging
              ? 'cursor-grabbing [&_*]:cursor-grabbing'
              : 'cursor-crosshair'
        }`}
      >
        {ready
          ? segments.map((segment) => {
              const widthPx =
                durationMs > 0 ? ((segment.endMs - segment.startMs) / durationMs) * trackWidthPx : 0;
              // 与 resolveMode 的判据完全一致：窄块只认平移，于是也不显示边缘光标。
              // 光标显示 col-resize 而实际走 move，比完全不提示更糟 —— 用户会以为拖边无效。
              // 只读时整块不拖，边缘热区连同 col-resize 光标一起不渲染
              const showEdges = !readOnly && widthPx >= 2 * EDGE_HIT_PX;
              return (
                <div
                  key={segment.id}
                  title={`${formatDuration(segment.startMs, false)} – ${formatDuration(segment.endMs, false)} · ${(
                    (segment.endMs - segment.startMs) /
                    1000
                  ).toFixed(1)}s`}
                  onPointerDown={(event) => {
                    // 色块上的按下不再冒泡成「空白处创建」，否则一按就多出一段
                    event.stopPropagation();
                    // 按下即选中，与列表同一套 id；拖拽时也顺带把焦点落到正在拖的这段
                    onSelect?.(segment.id);
                    handlePointerDown(event, segment);
                  }}
                  // 百分比定位：窗口 resize 时由 CSS 自己重算。
                  // minWidth 兜住极短片段：42 分钟视频里 200ms 的色块宽度趋近 0，看不见会被当成没标。
                  style={{
                    left: `${(segment.startMs / durationMs) * 100}%`,
                    width: `${((segment.endMs - segment.startMs) / durationMs) * 100}%`,
                    minWidth: 2,
                  }}
                  // 冲突期间 ring-bad 顶掉选中环 ring-ink：两者写同一个 ring 属性，
                  // 并存只会显示其中一个，而冲突是瞬时的、更紧急的反馈。
                  // z-10：相邻色块是兄弟节点，后绘制的会把前一段的 ring 盖掉半圈 ——
                  // 描边本身没问题，被盖住是绘制顺序问题。
                  className={`absolute top-1/2 h-[70%] -translate-y-1/2 rounded-[3px] bg-accent-2 transition-colors hover:bg-accent ${
                    readOnly ? 'cursor-default' : 'cursor-grab'
                  } ${
                    conflictedIds.has(segment.id)
                      ? 'z-10 ring-2 ring-bad'
                      : segment.id === selectedId
                        ? 'z-10 ring-2 ring-ink'
                        : ''
                  }`}
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
            // z-20：草案必须压在选中块（z-10）之上，否则拖到已选中片段附近时预览被盖住
            className={`pointer-events-none absolute top-1/2 z-20 h-[70%] -translate-y-1/2 rounded-[3px] border border-dashed bg-accent-2/40 opacity-70 ${draftBorder}`}
          />
        ) : null}

        {/* 时间提示：跟着鼠标水平位置，出界时由 overlay.ratio 贴边。
            不合格时叠一条 bad 左边框：文案已说明原因，颜色只是冗余编码，不靠它单独传达状态 */}
        {draft && overlay ? (
          <div
            style={{ left: `${overlay.ratio * 100}%` }}
            className={`tnum pointer-events-none absolute -top-6 -translate-x-1/2 rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[10.5px] whitespace-nowrap ${
              overlay.verdict.kind === 'ok' ? 'text-ink' : 'border-l-2 border-l-bad text-bad'
            }`}
          >
            {draftHint(draft, overlay.verdict)}
          </div>
        ) : null}

        {/* 入点：只存状态不画，用户按了 I 没有任何反馈，会怀疑没生效。
            warn 色与播放头的 ink 色区分开，两者重叠时仍能看出是两条线。
            画在播放头之前：播放头常在最上层，竖线不该盖住它 */}
        {ready && typeof markInMs === 'number' ? (
          <div
            style={{ left: `${(markInMs / durationMs) * 100}%` }}
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-warn"
          />
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
