'use client';

/**
 * 工作台播放器：受控 <video> + 自绘播放控件，下方挂时间轴，右侧片段列表与播放器、时间轴联动。
 *
 * 不用原生 controls：时间轴要与播放头共用「当前时间 / 总时长 / 是否在播」，
 * 原生控件把这些状态关在浏览器内部，取不到就只能整块重写。
 * 不用 blob URL：<video src> 是同源请求，浏览器自动带 session Cookie；
 * 先 fetch 再 createObjectURL 会把整个文件读进内存，并失去 Range，拖动进度条即失效。
 */
import { useEffect, useRef, useState } from 'react';
import type { Segment } from '@/lib/segment-interval';
import { selectionAfterDelete, selectionAfterSave } from '@/lib/segment-selection';
import type { SegmentRow } from '@/lib/services/segment-service';
import { formatDuration } from '@/lib/time';
import type { WorkTask } from '@/lib/services/workbench-service';
import SegmentList from './SegmentList';
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
   * 删除在途。不挡的话连点会发两个 DELETE，第二个返回 404，
   * 用户看到一条「片段不存在」的莫名报错。
   */
  const [deleting, setDeletingState] = useState(false);
  /**
   * 删除在途的同步副本。手势可以先于删除开始（触屏双指、按住鼠标时另一只手按 Enter），
   * 那时拖拽回调捕获的 deleting 还是 false，读 state 会放行一个注定 404 的 POST。
   */
  const deletingRef = useRef(false);
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
  function setDeleting(next: boolean) {
    deletingRef.current = next;
    setDeletingState(next);
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
    // 读 ref 而非 state：删除按钮虽然会被 busy 禁用，但同一次渲染内的连点仍会进到这里
    if (deletingRef.current) return;
    setSaveError(null);
    setDeleting(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}/segments/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        setSaveError(readErrorMessage(payload));
        return;
      }
      setSegments((prev) => prev.filter((row) => row.id !== id));
      // 迁移判定抽在纯函数里：删的不是选中项时必须一动不动，
      // 这个条件写在组件里就没人守得住（见 segment-selection 的注释）
      changeSelection(selectionAfterDelete(selectedIdRef.current, id, segments));
    } catch {
      // 断网或响应不是 JSON：本地数组保持原样，服务端仍是唯一真值
      setSaveError(GENERIC_SAVE_FAILED);
    } finally {
      setDeleting(false);
    }
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
    // 删除在途时不允许提交：DELETE 用的是点下去那一刻的 id，
    // 若这里再发一个「替换 X」，X 可能已经被删掉，必然 404 且提示无法理解。
    // 读 ref 而非 state：拖拽回调在 pointerdown 就被捕获，手势先于删除开始时闭包里是过期 false
    if (deletingRef.current) return;
    // 提交之间互斥：RTT 内连拖同一段，第二次带的还是第一次的旧 id，同样 404
    if (committingRef.current) return;
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
      // 数组更新与选中迁移必须一起做：只更新数组的话，selectedId 指向一个已不存在的 id，
      // 列表与时间轴都不再高亮，用户会以为选中丢了。判定同样抽在纯函数里。
      changeSelection(
        selectionAfterSave(selectedIdRef.current, replaced?.id ?? null, saved.id),
      );
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
            onSelect={selectSegment}
            onDelete={removeSegment}
            busy={deleting || committing}
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
        // 时间轴的点击已经由 E3 的状态机 seek 过，这里只接选中，不再 seek 一次
        onSelect={changeSelection}
      />
    </div>
  );
}
