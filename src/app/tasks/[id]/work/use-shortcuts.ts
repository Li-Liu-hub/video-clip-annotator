'use client';

/**
 * 全局键盘快捷键：空格播放 / I·O 打点 / Delete 删除选中 / 方向键微调 / Esc 兜底 / Ctrl+Z 撤销。
 *
 * 绑在 window 而非某个容器：标注时焦点常在视频与时间轴上，要求先点一下容器才生效，
 * 等于快捷键只在特定时刻可用。
 *
 * enabled 的语义是「允许写入」，不是「允许按键」：false 时只让 I / O / Delete / 撤销失效，
 * 空格与方向键照常绑 —— 只读回顾时按空格得能播放，否则体验断裂。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { MS_PER_SECOND, SNAP_STEP_MS, clamp } from '@/lib/interval';
import { isTypingTarget, normalizeMarkRange } from '@/lib/shortcuts';

/** 方向键默认步长（毫秒）。1 秒够粗定位，细调用 Shift + 吸附步长。 */
const ARROW_STEP_MS = MS_PER_SECOND;

type Args = {
  /** 是否允许写入（I / O / Delete）。false 时播放与微调仍然可用。 */
  enabled: boolean;
  /**
   * 单字符快捷键（空格 / I / O）是否启用。WCAG 2.1.4 要求这类快捷键可关闭；
   * 关掉只影响这三个键，Delete / 方向键 / Ctrl+Z 不是字符键，照常可用。
   */
  characterShortcutsEnabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  selectedId: string | null;
  /**
   * 视频时长（整数毫秒），与时间轴同一把尺子。
   *
   * 不用 `video.duration`：moov 在文件尾部的 mp4 在 metadata 就绪前会读到 Infinity，
   * 那时方向键会静默全灭，而时间轴照常可用 —— 两处尺子不同源就会出现这种分裂。
   */
  durationMs: number;
  /** 微调播放头走既有 seek 实现：只改 currentTime 不同步 currentMs 会让时间码停在旧值。 */
  onSeek: (ms: number) => void;
  onDeleteSelected: () => void;
  onCreateFromMarks: (range: { startMs: number; endMs: number }) => void;
  /** O 键的两端太短：不创建，但必须给出口（入点仍在） */
  onTooShort: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** 栈空时按下不该抢默认（无事可做时连 preventDefault 都不做） */
  canUndo: boolean;
  canRedo: boolean;
  onEscape: () => void;
};

/** 当前播放位置（整毫秒）。库里的时间列是整数毫秒，浮点会一路带进区间校验。 */
function playheadMs(video: HTMLVideoElement): number {
  return Math.round(video.currentTime * MS_PER_SECOND);
}

export function useShortcuts({
  enabled,
  characterShortcutsEnabled,
  videoRef,
  selectedId,
  durationMs,
  onSeek,
  onDeleteSelected,
  onCreateFromMarks,
  onTooShort,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onEscape,
}: Args): { markInMs: number | null; clearMark: () => void } {
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  /**
   * 入点的同步副本。
   *
   * onCreateFromMarks 是异步的（要发 POST），回调里读 state 会读到按下前的值；
   * O 键要的是「此刻」的入点，只能读 ref。
   */
  const markRef = useRef<number | null>(null);

  const clearMark = useCallback(() => {
    markRef.current = null;
    setMarkInMs(null);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // 输入框里的空格是空格，不是播放。这一条必须在最前面：
      // 后面每个分支都会 preventDefault，先拦就再也补不回来了
      if (isTypingTarget(event.target)) return;

      // Ctrl/Cmd+Z 是唯一被接管的修饰键组合：标注页里「撤销」指的就是片段，
      // 输入框里的那个已被上一条交还给浏览器（文本撤销）。
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        // 只读 / 回退在途（enabled 为 false）：不拦默认，也不发请求
        if (!enabled) return;
        // 栈空时什么都不做：不 preventDefault，浏览器的默认行为不该被一段空栈吞掉
        if (event.shiftKey ? !canRedo : !canUndo) return;
        event.preventDefault();
        // Shift+Ctrl+Z 才是重做：Windows 的 Ctrl+Y 不接，多一个入口就多一种不一致
        if (event.shiftKey) onRedo();
        else onUndo();
        return;
      }

      // 其余修饰键组合归浏览器 / 系统：抢了 Ctrl+R、Cmd+S，用户会以为页面卡死。
      // 一律放行，不做「只拦这几种」的白名单 —— 白名单永远漏一个
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const video = videoRef.current;

      // 用 code 而非 key 判空格：key 的值是 ' '，写起来易错成 'Space' 而静默失效
      if (event.code === 'Space') {
        // 单字符快捷键被关闭：连 preventDefault 都不做，空格回到浏览器的默认滚动
        if (!characterShortcutsEnabled) return;
        // 按住空格会在播放/暂停之间按重复频率抖动 —— 重复事件不是新指令
        if (event.repeat) return;
        // 不拦默认行为，浏览器会把页面滚一屏：按空格想播放，画面却跑了
        event.preventDefault();
        if (!video) return;
        if (video.paused) {
          // 播放可能被策略拒绝；吞掉 rejection，状态由 play / pause 事件回填
          void video.play().catch(() => {});
        } else {
          video.pause();
        }
        return;
      }

      if (event.key === 'Escape') {
        // 优先级交给调用方：拖拽中先取消拖拽，没有拖拽才清除入点
        onEscape();
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        // 只读：连 preventDefault 都不做，Backspace 保留浏览器默认行为
        if (!enabled) return;
        // 长按 Delete 会「删一段 → 选中迁移 → 接着删」，几秒内清空整个任务。
        // 只认第一次按下：重复事件不是用户的新指令，是按键在自动重复
        if (event.repeat) return;
        // 无选中就一动不动：删除不可逆，不能因为「恰好还有别的片段」就删了它
        if (selectedId === null) return;
        // Backspace 默认是后退一页，在标注页里等于丢掉整个工作台状态
        event.preventDefault();
        onDeleteSelected();
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!video) return;
        // 时长未就绪时钳制会得到坏值，直接放弃这次微调。
        // 放在 preventDefault 之前：坏值时保留方向键的默认滚动，不会「按了没反应也不能滚」
        if (!Number.isFinite(durationMs) || durationMs <= 0) return;
        event.preventDefault();
        const step = event.shiftKey ? SNAP_STEP_MS : ARROW_STEP_MS;
        const delta = event.key === 'ArrowLeft' ? -step : step;
        // 走既有的 seek：只写 video.currentTime 的话 currentMs 不更新，
        // 暂停状态下时间码会停在旧值（timeupdate 在暂停时可能根本不触发）
        onSeek(clamp(playheadMs(video) + delta, 0, durationMs));
        return;
      }

      // 字母用 key 且统一小写：CapsLock 开着时 key 是 'I' / 'O'，不归一化就整组失效
      const key = event.key.toLowerCase();
      if (key === 'i') {
        // 只读 / 快捷键关闭：打点没有落点，也不拦默认行为
        if (!enabled || !characterShortcutsEnabled) return;
        if (!video) return;
        event.preventDefault();
        const at = playheadMs(video);
        markRef.current = at;
        setMarkInMs(at);
        return;
      }

      if (key === 'o') {
        // 只读 / 快捷键关闭：不打点也不创建
        if (!enabled || !characterShortcutsEnabled) return;
        const markIn = markRef.current;
        // 没有入点就没有区间：不拿播放头当起点去猜，误创建比没反应更难收拾
        if (markIn === null || !video) return;
        const range = normalizeMarkRange(markIn, playheadMs(video));
        // 太短：不创建，入点保留 —— 挪一下播放头再按 O 即可，不必重新打点。
        // 必须给提示：静默 return 的表现是「按了 O 什么都没发生」
        if (!range) {
          onTooShort();
          return;
        }
        event.preventDefault();
        // 先清入点再提交：往返期间竖线还挂着，用户会以为按 O 没生效
        clearMark();
        onCreateFromMarks(range);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    }, [
    enabled,
    characterShortcutsEnabled,
    videoRef,
    selectedId,
    // 这两个必须列进来：现在靠「三个内联回调每渲染换身份」让 effect 每次重跑，
    // 才恰好把新的 durationMs 带进来。哪天把那些回调 useCallback 化，effect 不再重跑，
    // durationMs 会冻结在首帧的 0 —— 方向键永久失效，且无任何测试会红。
    durationMs,
    onSeek,
    onDeleteSelected,
    onCreateFromMarks,
    onTooShort,
    onEscape,
    clearMark,
    // 栈空与否直接决定是否拦默认，冻结在首帧就是「第一次撤销之后再也撤不动」
    canUndo,
    canRedo,
    onUndo,
    onRedo,
  ]);

  return { markInMs, clearMark };
}
