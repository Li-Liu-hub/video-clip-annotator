'use client';

/**
 * 撤销 / 重做：历史栈状态 + 把服务端也退回去。
 *
 * 片段不是纯前端状态——每次改动都已落库（E4），只改本地数组刷新就回来，
 * 用户以为撤销了。服务端又没有「整任务重置成快照」的接口，只能按
 * `POST /segments` 与 `DELETE /segments/:id` 逐条调整，于是撤销 = 算差异 → 串行调接口 → 重拉真值。
 */
import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  canRedo,
  canUndo,
  diffIntervals,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  type History,
  type Interval,
} from '@/lib/history';
import { readSegmentList } from '@/lib/segment-payload';
import type { SegmentRow } from '@/lib/services/segment-service';

type Args = {
  taskId: string;
  /** 只读（已提交的任务）：canUndo 恒 false，undo / redo 入口直接 return。 */
  readOnly: boolean;
  /** 读最新的片段快照。diff 必须基于「此刻」的数组，不能是回调捕获的那一份。 */
  getSegments: () => SegmentRow[];
  /** 回填真值：走 Workbench 的 applySegments，ref 与 state 同写。 */
  applySegments: (next: SegmentRow[]) => void;
  /** 失败出口：把响应体（断网时为 null）交给调用方翻译成文案。 */
  onFailure: (payload: unknown) => void;
};

type Result = {
  /** 每次写操作成功、状态已更新后调用，传入操作前的区间集合 */
  record: (before: readonly Interval[]) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 正在回退时禁用输入 */
  busy: boolean;
  /**
   * busy 的同步副本。多出来这一个，是因为拖拽的 onCommit 在 pointerdown 那一刻就被捕获，
   * 闭包里读到的是回退开始前的 busy —— 只读 state 会放过一次「diff 基于的 current 已失效」的提交。
   */
  busyRef: RefObject<boolean>;
};

const SEGMENTS_URL = (taskId: string) => `/api/tasks/${taskId}/segments`;

/** 读错误体。响应不是 JSON 时给 null，由调用方降级成通用文案。 */
async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function useHistory({ taskId, readOnly, getSegments, applySegments, onFailure }: Args): Result {
  const [history, setHistoryState] = useState<History>({ past: [], future: [] });
  const historyRef = useRef<History>(history);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);

  /** 栈的唯一写入口：ref 与 state 同写，事件回调里读 ref 才拿得到最新值。 */
  const writeHistory = useCallback((next: History) => {
    historyRef.current = next;
    setHistoryState(next);
  }, []);

  function setBusy(next: boolean) {
    busyRef.current = next;
    setBusyState(next);
  }

  const record = useCallback(
    (before: readonly Interval[]) => {
      writeHistory(pushHistory(historyRef.current, before));
    },
    [writeHistory],
  );

  /**
   * 把服务端改到 target 的形态，返回是否整步成功。
   *
   * 逐条 await 而非 Promise.all：重做常常要在旧片段占着的区间上重建一段，
   * 先建必撞触发器报重叠 —— 只有「先删完、再建」这个固定顺序是对的。
   * 中途失败就停：半截改动已经落库，此时若还推进栈，下次撤销会退回一个从未存在过的状态。
   */
  async function applyTarget(target: readonly Interval[]): Promise<boolean> {
    const { toDelete, toCreate } = diffIntervals(getSegments(), target);

    for (const id of toDelete) {
      const response = await fetch(`${SEGMENTS_URL(taskId)}/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        onFailure(await readJson(response));
        return false;
      }
    }

    for (const interval of toCreate) {
      const response = await fetch(SEGMENTS_URL(taskId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startMs: interval.startMs, endMs: interval.endMs, replaces: null }),
      });
      if (!response.ok) {
        onFailure(await readJson(response));
        return false;
      }
    }
    return true;
  }

  /**
   * 重新拉一次片段真值。
   *
   * 不按 diff 自己拼本地数组：替换会换 id、label 只有服务端知道，
   * 拼出来的和真值差一点，下一次 diff 就会算错。撤销是低频操作，多一次请求值得。
   * 失败时保持旧数组 —— 本地只是服务端的副本，猜一份只会离真值更远。
   *
   * 返回是否真的拿到了真值：调用方据此决定要不要推进历史栈。
   * 重拉失败却推进栈的话，本地数组还是旧的，下一次撤销基于旧数组算 diff，
   * 会发出一个注定 404 的 DELETE，而栈不推进让用户卡住直到刷新。
   */
  async function reload(): Promise<boolean> {
    try {
      const response = await fetch(SEGMENTS_URL(taskId));
      if (!response.ok) {
        onFailure(await readJson(response));
        return false;
      }
      const rows = readSegmentList(await readJson(response));
      if (!rows) {
        onFailure(null);
        return false;
      }
      applySegments(rows);
      return true;
    } catch {
      onFailure(null);
      return false;
    }
  }

  async function runRestore(direction: 'undo' | 'redo') {
    // 只读的第二道闸：快捷键已经不绑，但将来的按钮与别的调用点仍可能直达这里
    if (readOnly) return;
    // 回退是串行的：一次回退可能产生多个请求，中途再插一次回退会让后者的 diff 基于过期数组
    if (busyRef.current) return;

    const current = getSegments().map(({ startMs, endMs }) => ({ startMs, endMs }));
    const step =
      direction === 'undo' ? undoHistory(historyRef.current, current) : redoHistory(historyRef.current, current);
    // 栈空：不发请求、不提示、不进 busy —— 无事可做不是错误
    if (step.restore === null) return;

    setBusy(true);
    try {
      let succeeded = false;
      try {
        succeeded = await applyTarget(step.restore);
      } catch {
        // 断网：改动到哪一步未知，本地数组必须回到服务端真值
        onFailure(null);
      }
      // 成败都重拉：失败时可能已有半截改动落库
      const reloaded = await reload();
      // 整步成功且本地已与真值对齐，才推进栈。
      // 两者缺一都不推进 —— 推进一个本地没跟上的栈，下一次 diff 会算错
      if (succeeded && reloaded) writeHistory(step.next);
    } finally {
      setBusy(false);
    }
  }

  return {
    record,
    undo: () => void runRestore('undo'),
    redo: () => void runRestore('redo'),
    // 只读时恒 false：不给按钮与快捷键任何「还有一步可退」的错觉
    canUndo: !readOnly && canUndo(history),
    canRedo: !readOnly && canRedo(history),
    busy,
    busyRef,
  };
}
