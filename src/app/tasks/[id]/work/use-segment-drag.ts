'use client';

/**
 * 片段拖拽状态机：把 pointer 事件换算成草案区间，负责捕获、阈值、取消与提交判定。
 *
 * 用 Pointer Events 而非 Mouse Events：一套代码同时覆盖鼠标、触控板与触屏，
 * 鼠标事件在触屏上根本不触发。
 * pointerdown 必须 setPointerCapture（捕获在轨道上，而非色块）：色块在拖拽中会被重渲染，
 * 捕获挂在它身上会随节点重建丢失；捕获在轨道上，指针拖出轨道甚至拖出窗口也照常收到 move。
 *
 * 契约里的 DragState 不含「被拖的是第几段」与指针位置，但渲染需要：
 * 草案是否合格必须排除原片段（否则平移时草案与自己重叠，永远显红），
 * 时间提示要跟着鼠标走。故额外返回 overlay，不改动契约声明的字段。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { clamp } from '@/lib/interval';
import type { Segment } from '@/lib/segment-interval';
import {
  DRAG_THRESHOLD_PX,
  EDGE_HIT_PX,
  draftFromDrag,
  draftFromMove,
  draftFromResize,
  isAcceptableDraft,
} from '@/lib/segment-drag';
import { ratioToMs } from '@/lib/timeline-scale';

export type DragMode = 'create' | 'move' | 'resize-start' | 'resize-end';

export type DragState =
  | { kind: 'idle' }
  | { kind: 'pending'; mode: DragMode; originMs: number; startX: number; origin: Segment | null }
  | { kind: 'dragging'; mode: DragMode; draft: Segment };

/** 草案的渲染旁路信息：时间提示的相对位置（0~1）与是否可提交。 */
export type DragOverlay = { ratio: number; acceptable: boolean };

type Args = {
  trackRef: RefObject<HTMLDivElement | null>;
  durationMs: number;
  segments: readonly Segment[];
  onCommit: (draft: Segment, replacedIndex: number | null) => void;
  onSeek: (ms: number) => void;
};

type Internal = { drag: DragState; overlay: DragOverlay | null };

/** 命中色块时判定模式：落点贴近哪条边就调哪条边。 */
function resolveMode(
  hit: Segment,
  clientX: number,
  rect: DOMRect,
  durationMs: number,
): DragMode {
  const pxPerMs = rect.width / durationMs;
  const widthPx = (hit.endMs - hit.startMs) * pxPerMs;
  // 极短片段的左右热区会互相覆盖，此时只认平移：否则一按就变成调边缘，片段再也拖不动
  if (widthPx < 2 * EDGE_HIT_PX) return 'move';
  const offsetPx = clientX - rect.left - hit.startMs * pxPerMs;
  if (offsetPx <= EDGE_HIT_PX) return 'resize-start';
  if (widthPx - offsetPx <= EDGE_HIT_PX) return 'resize-end';
  return 'move';
}

export function useSegmentDrag({
  trackRef,
  durationMs,
  segments,
  onCommit,
  onSeek,
}: Args): { drag: DragState; onPointerDown: OnPointerDown; overlay: DragOverlay | null } {
  const [state, setState] = useState<Internal>({ drag: { kind: 'idle' }, overlay: null });
  // 手势进行中的清理函数。卸载时若还在拖（切任务），必须摘掉 window 监听器，
  // 否则旧组件继续响应 move 并 setState
  const cleanupRef = useRef<(() => void) | null>(null);
  /** 是否有手势在途。用 ref 是因为它要在事件回调里同步读写，不能等渲染。 */
  const activeRef = useRef(false);

  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = useCallback<OnPointerDown>(
    (event, hit, hitIndex) => {
      // 只响应主键：右键菜单与中键滚动不该起拖拽。触摸的 button 同样是 0
      if (event.button !== 0) return;
      // 已有手势在途时忽略新的 pointerdown。
      // 触屏上第二根手指按下会覆盖 state、覆盖 cleanupRef，第一轮的 window 监听
      // 再无人摘除，且第一根手指抬起时还会提交一次 —— 既是监听泄漏也是双重提交。
      // 用 ref 而非 state：pointerdown 与 finish 之间可能跨多次渲染，state 读到的会是旧值。
      if (activeRef.current) return;

      const track = trackRef.current;
      // 用 !(x > 0) 而非 x <= 0：NaN <= 0 为 false，会让 NaN 穿透，
      // 之后所有坐标换算都变成 NaN
      if (!track || !(durationMs > 0)) return;
      const rect = track.getBoundingClientRect();
      // 尚未布局（隐藏或首次挂载）时宽度为 0，除法会得到 Infinity
      if (rect.width === 0) return;

      // 阻止文本选中与原生拖拽：否则拖出轨道会顺手拉出一片高亮选区
      event.preventDefault();
      const pointerId = event.pointerId;
      track.setPointerCapture(pointerId);
      // 所有早退都过了、捕获也成功了，才登记「手势在途」。
      // 若在早退之前就置 true，任一条早退都会让它永久为 true，
      // 此后这个 hook 实例再也接不到 pointerdown —— 拖拽与点击定位一起失效且无报错。
      activeRef.current = true;

      const startX = event.clientX;
      const mode: DragMode = hit ? resolveMode(hit, startX, rect, durationMs) : 'create';
      const anchorMs = ratioToMs((startX - rect.left) / rect.width, durationMs);
      const origin = hit ? { startMs: hit.startMs, endMs: hit.endMs } : null;
      // 快照「其余片段」：拖拽期间不写 segments，排除原片段才谈得上重叠判定
      const others = hitIndex >= 0 ? segments.filter((_, i) => i !== hitIndex) : segments;

      let started = false;
      let lastDraft: Segment | null = null;

      setState({
        drag: { kind: 'pending', mode, originMs: anchorMs, startX, origin },
        overlay: null,
      });

      /** 像素 → 草案。rect 取 pointerdown 那一刻：拖拽期间轨道不动，逐帧重排才是浪费。 */
      function draftAt(clientX: number): Segment {
        const currentMs = ratioToMs((clientX - rect.left) / rect.width, durationMs);
        if (mode === 'create' || origin === null) {
          return draftFromDrag(anchorMs, currentMs, durationMs);
        }
        // delta 保持原始像素换算值，吸附由 draftFrom* 作用在绝对结果上
        const deltaMs = currentMs - anchorMs;
        if (mode === 'move') return draftFromMove(origin, deltaMs, durationMs);
        return draftFromResize(origin, mode === 'resize-start' ? 'start' : 'end', deltaMs, durationMs);
      }

      function onMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== pointerId) return;
        // 阈值判定只看水平位移：轨道是一维的，纵向抖动不该触发创建
        if (!started) {
          if (Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD_PX) return;
          started = true;
        }
        const draft = draftAt(moveEvent.clientX);
        lastDraft = draft;
        setState({
          drag: { kind: 'dragging', mode, draft },
          overlay: {
            // 提示条跟鼠标走，出界时贴边而不是飞出面板
            ratio: clamp((moveEvent.clientX - rect.left) / rect.width, 0, 1),
            acceptable: isAcceptableDraft(draft, others),
          },
        });
      }

      function onUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) return;
        const draft = lastDraft;
        finish();
        if (!started) {
          // 位移未过阈值：是点击，走定位，不留下任何片段
          onSeek(anchorMs);
          return;
        }
        if (draft && isAcceptableDraft(draft, others)) {
          onCommit(draft, hitIndex >= 0 ? hitIndex : null);
        }
      }

      function onCancel(cancelEvent: PointerEvent) {
        if (cancelEvent.pointerId !== pointerId) return;
        // 系统手势中断只发 pointercancel，不发 up，必须同样清理并丢弃草案
        finish();
      }

      function onKeyDown(keyEvent: KeyboardEvent) {
        if (keyEvent.key !== 'Escape') return;
        finish();
      }

      function finish() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKeyDown);
        cleanupRef.current = null;
        // 手势结束才允许下一次 pointerdown 起新手势
        activeRef.current = false;
        // 先判再释放：浏览器在指针消失时会隐式释放，直接 release 抛 InvalidPointerId，
        // 会把后面的 setState 一起吞掉，界面停在拖拽态
        if (track?.hasPointerCapture(pointerId)) track.releasePointerCapture(pointerId);
        setState({ drag: { kind: 'idle' }, overlay: null });
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKeyDown);
      cleanupRef.current = finish;
    },
    [trackRef, durationMs, segments, onCommit, onSeek],
  );

  return { drag: state.drag, onPointerDown, overlay: state.overlay };
}

/** 命中色块时传该片段与其下标；空白处传 null 与 -1。 */
type OnPointerDown = (
  event: ReactPointerEvent<HTMLDivElement>,
  hit: Segment | null,
  hitIndex: number,
) => void;
