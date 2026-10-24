'use client';

/**
 * 工作台播放器：受控 <video> + 自绘播放控件，下方挂时间轴，右侧片段列表与播放器、时间轴联动。
 *
 * 不用原生 controls：时间轴要与播放头共用「当前时间 / 总时长 / 是否在播」，
 * 原生控件把这些状态关在浏览器内部，取不到就只能整块重写。
 * 不用 blob URL：<video src> 是同源请求，浏览器自动带 session Cookie；
 * 先 fetch 再 createObjectURL 会把整个文件读进内存，并失去 Range，拖动进度条即失效。
 *
 * readOnly（已提交的任务）只断写入：播放、seek、方向键微调照旧。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Segment } from '@/lib/segment-interval';
import { selectionAfterDelete, selectionAfterSave } from '@/lib/segment-selection';
import type { SegmentRow } from '@/lib/services/segment-service';
import { SHORTCUT_HINTS, formatShortcutHint } from '@/lib/shortcuts';
import { formatDuration } from '@/lib/time';
import type { WorkTask } from '@/lib/services/workbench-service';
import SegmentList from './SegmentList';
import Timeline from './Timeline';
import { useShortcuts } from './use-shortcuts';

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

type Props = { task: WorkTask; initialSegments: SegmentRow[]; readOnly?: boolean };

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

export default function Workbench({ task, initialSegments, readOnly = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  /** 首屏来自服务端，之后以接口返回为准 —— 本地只是服务器状态的副本。 */
  const [segments, setSegments] = useState<SegmentRow[]>(initialSegments);
  /** 提交中只挡一小条提示，不做全屏遮罩：遮罩会打断正在进行的标注。 */
  const [committing, setCommittingState] = useState(false);
  /**
   * 提交在途的同步副本。state 触发渲染（保存中…、按钮禁用），ref 供事件回调同步判断。
   *
   * 防的是「RTT 内连拖两次」：第二次带着第一次刚替换掉的片段 id，
   * 服务端必然 404。原先这里完全没有互斥，加上 ref 后同一次挂载内只可能有一个在途提交。
   *
   * 防御性代码，无自动化覆盖：项目没有组件测试设施，靠 ref 的对象身份
   * 跨渲染稳定这一点从结构上保证（见 00-INDEX 的未修项表 O1/O2）。
   */
  const committingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 只接纳有限值；null 表示还没读到 metadata，或读到的是 Infinity */
  const [mediaDurationSec, setMediaDurationSec] = useState<number | null>(null);
  /** 视频流加载失败。没有这个开关，黑屏页面无法区分「没加载完」与「文件坏了」。 */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * 选中项存 id 而非下标：E4 的替换是「先删后插」，片段 id 会变；
   * 存下标的话拖动第 0 段之后，下标 0 仍然存在却指向了另一个片段。
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * 删除在途的片段 id（null 表示没有删除在途）。
   *
   * 行身份由这里持有，而不是 SegmentList 自己记：键盘 Delete 不经过列表按钮，
   * 列表若另存一份「点过哪行」，两处会在「删除中…」落在哪行上打架（O1b）。
   * 顺便也挡住连点：有 id 在途时不再发第二个 DELETE。
   */
  const [deletingId, setDeletingIdState] = useState<string | null>(null);
  /**
   * 删除在途的同步副本。手势可以先于删除开始（触屏双指、按住鼠标时另一只手按 Delete），
   * 那时拖拽回调捕获的 deletingId 还是 null，读 state 会放行一个注定 404 的 POST。
   */
  const deletingIdRef = useRef<string | null>(null);
  /**
   * 片段数组的同步副本。
   *
   * 拖拽的 onCommit 在 pointerdown 那一刻就被捕获，闭包里的 segments 是按下时的快照；
   * 拖拽中删除完成后，用它判「被替换的那段还在不在」等于没判 —— 必须先看最新值（O5）。
   */
  const segmentsRef = useRef<SegmentRow[]>(segments);
  /** 拖拽是否在途。Escape 的优先级要用到它：拖拽中只取消拖拽，不清入点。 */
  const draggingRef = useRef(false);
  /**
   * 选中 id 的最新值。
   *
   * 拖拽回调是在 pointerdown 那一刻注册进 window 监听器的，闭包里捕获的 selectedId
   * 是按下时的旧值；拖拽中若刚点过这段，state 已是新值而闭包不是，
   * 「被替换的是不是选中项」就会判错，替换后高亮凭空消失。ref 读的永远是最新值。
   */
  const selectedIdRef = useRef<string | null>(null);

  /** 选中态的唯一写入口：state 供渲染，ref 供事件闭包读。 */
  function changeSelection(id: string | null) {
    selectedIdRef.current = id;
    setSelectedId(id);
  }

  /**
   * 删除态 / 提交态的唯一写入口：ref 先写，state 后写。
   *
   * 只用 ref，按钮永远不禁用、也没有「保存中…」；只用 state，事件回调里读到的是过期值。
   * 两处必须同进同退，所以不给外部留单独的 setter。
   */
  function setDeletingId(next: string | null) {
    deletingIdRef.current = next;
    setDeletingIdState(next);
  }

  function setCommitting(next: boolean) {
    committingRef.current = next;
    setCommittingState(next);
  }

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

  /**
   * segments 的唯一写入口：ref 与 state 同写。
   *
   * 不用 useEffect 镜像 —— 那样「删除成功」到「effect 跑完」之间有窗口，
   * 期间拖拽松手会读到旧数组，判出「被删的那段还在」，发一个注定 404 的替换请求（O5）。
   * 写透式把窗口从「一次渲染」缩到零。
   */
  const applySegments = useCallback((next: SegmentRow[]) => {
    segmentsRef.current = next;
    setSegments(next);
  }, []);

  /** 拖拽起止写进 ref。useCallback 保持身份稳定，免得 Timeline 的 effect 每次渲染都重跑。 */
  const handleDragActiveChange = useCallback((active: boolean) => {
    draggingRef.current = active;
  }, []);

  const { markInMs, clearMark } = useShortcuts({
    /**
     * 语义是「允许写入」，不是「允许按键」：只读时仍要能空格播放、方向键微调，
     * 只禁 I / O / Delete。整组不绑会让回顾时按空格没反应，体验断裂。
     */
    enabled: !readOnly,
    videoRef,
    selectedId,
    // 与时间轴同一把尺子：不用 video.duration，moov 在尾部的 mp4 会读到 Infinity
    durationMs: Math.round(durationSec * 1000),
    onSeek: seekTo,
    // 选中在 hook 里已判过非空；这里再取一次只是为了让类型收窄
    onDeleteSelected: () => {
      if (selectedId !== null) void removeSegment(selectedId);
    },
    // 打字机打出来的区间没有「替换谁」，一律走新建
    onCreateFromMarks: (range) => void commitSegment(range, null),
    onEscape: () => {
      // 拖拽中由拖拽状态机自己收尾，这里不清入点 —— Esc 一次只做一件事。
      //
      // 成立的依据是：draggingRef 只在拖拽状态变化的 effect 里翻转，
      // 而同一次 keydown 派发期间不会跑 effect，所以本回调读到的值
      // 与「此刻是否在拖」一致，与两个监听的注册顺序无关。
      if (draggingRef.current) return;
      clearMark();
    },
  });

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
   * 点列表项：选中并把视频跳到片段开头。
   *
   * 用 startMs 而不是中点 —— 标注员点这一行是为了看这段从哪一帧开始，
   * 跳到中间会让他先倒退着找边界。
   */
  function selectSegment(id: string) {
    changeSelection(id);
    const target = segments.find((row) => row.id === id);
    if (target) seekTo(target.startMs);
  }

  /**
   * 删除片段。成功后从数组移除，并把选中迁移到相邻项。
   *
   * 迁移只在「删的正是选中项」时做：删别的行也改选中，等于把用户的焦点悄悄拽走。
   */
  async function removeSegment(id: string) {
    // 只读的第二道闸：列表不渲染删除按钮，但键盘 Delete 与将来的新调用点仍可能直达这里。
    // 只有 UI 一层的话，请求会打到服务端拿 409，用户看到的是与「只读」无关的错误。
    if (readOnly) return;
    // 读 ref 而非 state：删除按钮虽会被 busy 禁用，但键盘 Delete 与同帧连点仍会进到这里
    if (deletingIdRef.current !== null) return;
    // 提交在途时同样不删：按钮此时是 disabled，键盘得跟按钮一个口径，
    // 否则 DELETE 与「替换 X」的 POST 赛跑，后到的那个必然 404
    if (committingRef.current) return;
    setSaveError(null);
    setDeletingId(id);
    try {
      const response = await fetch(`/api/tasks/${task.id}/segments/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        setSaveError(readErrorMessage(payload));
        return;
      }
      applySegments(segmentsRef.current.filter((row) => row.id !== id));
      // 迁移判定抽在纯函数里：删的不是选中项时必须一动不动，
      // 这个条件写在组件里就没人守得住（见 segment-selection 的注释）
      changeSelection(selectionAfterDelete(selectedIdRef.current, id, segments));
    } catch {
      // 断网或响应不是 JSON：本地数组保持原样，服务端仍是唯一真值
      setSaveError(GENERIC_SAVE_FAILED);
    } finally {
      setDeletingId(null);
    }
  }

  /**
   * 提交拖拽草案：replacedId 为 null 是新建，否则替换那一段。
   *
   * 只有服务端返回成功才改本地数组：失败时若先乐观更新，界面会显示一个刷新后消失的片段。
   * 替换会换 id（服务端先删后插），所以按被替换项的 id 移除，再按 startMs 重排 ——
   * 从右往左框选、或把片段拖到别的片段之前都会打乱顺序，
   * 而时间轴与 normalizeSegments 的下标都以「起点升序」为前提。
   */
  async function commitSegment(draft: Segment, replacedId: string | null) {
    // 只读的第二道闸：时间轴不进拖拽状态机，但快捷键与将来的新调用点仍可能直达这里。
    // 静默 return 是对的：只读下「不能保存」不是错误，没有任何提示才不至于误导。
    if (readOnly) return;
    // 删除在途时不允许提交：DELETE 用的是点下去那一刻的 id，
    // 若这里再发一个「替换 X」，X 可能已经被删掉，必然 404 且提示无法理解。
    // 读 ref 而非 state：拖拽回调在 pointerdown 就被捕获，手势先于删除开始时闭包里还是旧值
    if (deletingIdRef.current !== null) {
      // 静默 return 会让用户「按了 O / 松了手，什么都没有」。
      // 这类拦截不是错误，但必须给出口，否则看起来像功能坏了
      setSaveError('正在删除片段，请稍候再试');
      return;
    }
    // 提交之间互斥：RTT 内连拖同一段，第二次带的还是第一次的旧 id，同样 404
    if (committingRef.current) {
      setSaveError('上一个片段正在保存，请稍候');
      return;
    }
    /**
     * 被替换的那段是否还在。
     *
     * 读 ref 而非闭包里的 segments：拖拽的 onCommit 在 pointerdown 那一刻就被捕获，
     * 闭包数组里可能还留着刚删掉的那一段，用它判存在性等于没判（O5）。
     * 不在就放弃 —— 发出去只会拿到一个 404，用户看到「片段不存在」却查不到来源。
     */
    if (replacedId !== null && !segmentsRef.current.some((row) => row.id === replacedId)) {
      // 拖拽期间这一段被删掉了（另一只手按了 Delete）。
      // 降级为新建是错的：用户以为在挪一段，实际会多出一段。
      setSaveError('这一段已被删除，请重新标注');
      return;
    }

    setSaveError(null);
    setCommitting(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startMs: draft.startMs,
          endMs: draft.endMs,
          replaces: replacedId,
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
      const prev = segmentsRef.current;
      const kept = replacedId === null ? prev : prev.filter((row) => row.id !== replacedId);
      applySegments([...kept, saved].sort((a, b) => a.startMs - b.startMs));
      // 数组更新与选中迁移必须一起做：只更新数组的话，selectedId 指向一个已不存在的 id，
      // 列表与时间轴都不再高亮，用户会以为选中丢了。判定同样抽在纯函数里。
      changeSelection(selectionAfterSave(selectedIdRef.current, replacedId, saved.id));
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

        <aside
          className="panel flex w-full shrink-0 flex-col overflow-hidden lg:w-[280px]"
          aria-label="片段"
        >
          {/* 标题栏不参与滚动，只有下方列表滚 */}
          <div className="flex items-center justify-between border-b border-line-soft px-3.5 py-2.5">
            <h2 className="text-[12.5px] font-medium text-ink">片段</h2>
            <span className="tnum text-[11.5px] text-ink-faint">{segments.length}</span>
          </div>
          <SegmentList
            segments={segments}
            selectedId={selectedId}
            // 行身份只有这一份：键盘与鼠标删除都写它，「删除中…」不会再落错行
            deletingId={deletingId}
            onSelect={selectSegment}
            onDelete={removeSegment}
            busy={deletingId !== null || committing}
            readOnly={readOnly}
          />
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
        selectedId={selectedId}
        markInMs={markInMs}
        onDragActiveChange={handleDragActiveChange}
        // 时间轴的点击已经由 E3 的状态机 seek 过，这里只接选中，不再 seek 一次
        onSelect={changeSelection}
        readOnly={readOnly}
      />

      {/* 键位提示常驻页脚：快捷键不写在界面上，用户永远不知道有 I / O。
          文案来自 SHORTCUT_HINTS，单测锁住它不漂移 */}
      <p className="px-1 text-[11px] leading-relaxed text-ink-faint">
        {SHORTCUT_HINTS.filter((hint) => !readOnly || !hint.writableOnly)
          .map(formatShortcutHint)
          .join(' · ')}
      </p>
    </div>
  );
}
