'use client';

/**
 * 片段列表：序号、起止时间、时长与删除按钮，点击行选中并联动视频与时间轴。
 *
 * 行按 id 而非下标做 key：E4 的替换是「先删后插」，id 会变；
 * 用下标做 key 时 React 会复用错行的 DOM，表现为「删了第 2 行、内容却错位」。
 * 行高固定 40px（min-h-10）：列表在固定高度的侧栏里滚动，行高随内容浮动会让滚动位置跳动。
 *
 * readOnly（已提交的任务）不渲染删除按钮：不存在的功能不该留一个永远点不了的灰按钮。
 */
import { useEffect, useRef } from 'react';
import type { SegmentRow } from '@/lib/services/segment-service';
import { formatDuration } from '@/lib/time';

type Props = {
  segments: SegmentRow[];
  selectedId: string | null;
  /**
   * 正在删除的片段 id，由 Workbench 持有。
   *
   * 组件内不再自存一份：键盘 Delete 不经过这里的按钮，本地记的「点过哪一行」
   * 与真实待删行会脱节，「删除中…」就落到错误的行（O1b）。
   */
  deletingId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** 有请求在途时禁用删除按钮，避免连点产生两次 DELETE */
  busy: boolean;
  /** 只读回顾：整列删除按钮不渲染。缺省 false，E1–E7 的调用点不用改。 */
  readOnly?: boolean;
  /**
   * 删除成功后的焦点落点。targetId 为 null 表示列表已空，焦点移到空态文本。
   *
   * 不把焦点留在 body：删除后按 Tab 会从页面顶部重新开始，连续整理片段的人
   * 得一路 Tab 回列表（G5）。seq 是触发信号 —— 同一个目标连续请求也要重新聚焦。
   */
  focusRequest?: { targetId: string | null; seq: number } | null;
};

export default function SegmentList({
  segments,
  selectedId,
  deletingId,
  onSelect,
  onDelete,
  busy,
  readOnly = false,
  focusRequest = null,
}: Props) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const emptyRef = useRef<HTMLParagraphElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!focusRequest) return;
    const target = focusRequest.targetId
      ? rowRefs.current.get(focusRequest.targetId)
      : undefined;
    // 目标行找不到（并发删除的竞态）时退回列表容器，不把焦点留在 body
    const fallback = listRef.current ?? emptyRef.current;
    (target ?? fallback)?.focus();
  }, [focusRequest]);

  if (segments.length === 0) {
    return (
      <p
        ref={emptyRef}
        // 可编程聚焦：删除最后一段后焦点落在这里，屏幕阅读器会读出下面这句话
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-3.5 py-8 text-center text-[11.5px] leading-relaxed text-ink-faint"
      >
        {readOnly ? '这个任务没有片段。' : '还没有片段。在下方时间轴上拖动即可标注。'}
      </p>
    );
  }

  // min-h-0：flex 子项默认不小于内容高度，不加这行列表会把侧栏撑破而不是滚动
  return (
    <ul ref={listRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto pb-1">
      {segments.map((segment, index) => {
        const selected = segment.id === selectedId;
        const pending = deletingId === segment.id;
        // 选中行的底色常驻，hover 底色只给未选中行：两者叠加会盖掉选中色
        const rowTone = selected
          ? 'border-accent-2 bg-panel-2'
          : 'border-transparent group-hover:bg-panel-2/50';
        return (
          <li key={segment.id} className="group">
            <div className={`flex min-h-10 items-stretch border-l-[3px] ${rowTone}`}>
              <button
                type="button"
                ref={(element) => {
                  if (element) rowRefs.current.set(segment.id, element);
                  else rowRefs.current.delete(segment.id);
                }}
                onClick={() => onSelect(segment.id)}
                // 选中态不能只靠左侧竖条与底色表达：屏幕阅读器完全读不到颜色
                aria-current={selected ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2.5 py-1 pr-1 pl-2 text-left"
              >
                <span className="tnum w-4 shrink-0 text-[11px] text-ink-faint">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="tnum block truncate text-[12px] leading-5 text-ink">
                    {formatDuration(segment.startMs, false)} – {formatDuration(segment.endMs, false)}
                  </span>
                  {/* 有标签才占第二行；没有时行高正好 40px */}
                  {segment.label ? (
                    <span className="block truncate text-[11px] leading-4 text-ink-dim">
                      {segment.label}
                    </span>
                  ) : null}
                </span>
                <span className="tnum shrink-0 text-[11px] text-ink-faint">
                  {((segment.endMs - segment.startMs) / 1000).toFixed(1)}s
                </span>
              </button>
              {readOnly ? null : (
                <button
                  type="button"
                  // 文案被 aria-label 覆盖，状态必须自己进 label：
                  // 否则屏幕阅读器只听到「删除第 N 段」，不知道正在删
                  aria-label={pending ? `第 ${index + 1} 段删除中` : `删除第 ${index + 1} 段`}
                  aria-busy={pending || undefined}
                  disabled={busy}
                  onClick={() => onDelete(segment.id)}
                  // 平时 opacity-0，行 hover / 行选中 / 本行删除中才可见：
                  // 常显会让每一行都被 ✕ 抢走视线，标注员扫时间是扫列而不是扫按钮
                  className={`m-1 flex h-6 shrink-0 items-center justify-center rounded px-1.5 text-[11px] text-ink-faint transition-opacity hover:text-bad disabled:cursor-not-allowed ${
                    selected || pending
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                  }`}
                >
                  {pending ? '删除中…' : '✕'}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
