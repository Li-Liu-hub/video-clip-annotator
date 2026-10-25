// @vitest-environment jsdom
/**
 * 工作台的组件级接线（风险最高的几处）。
 *
 * 这些行为都发生在「事件回调 → 状态 → 请求」之间，纯函数测不到：
 *   - 撤销记的是操作前还是操作后（H1）
 *   - 撤销回放是否把 label 带回去（P1）
 *   - 删除在途时拖拽/打点是否被挡（O1c）
 *   - 单字符快捷键开关是否真的断了空格（P4）
 *   - O 键太短是否给提示（P7）
 *
 * 用 jsdom 真渲染，fetch 用内存实现替代。断言落在「发出了什么请求」与
 * 「状态行写了什么」，不依赖具体 DOM 结构。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import Workbench from '@/app/tasks/[id]/work/Workbench';
import type { SegmentRow } from '@/lib/services/segment-service';
import type { WorkTask } from '@/lib/services/workbench-service';

const TASK: WorkTask = {
  id: 'a000000000000001',
  title: '测试任务',
  description: null,
  status: 'claimed',
  durationMs: 30_000,
  videoFilename: 'a.mp4',
  streamUrl: '/api/videos/v000000000000001/stream',
  rejectReason: null,
};

const LABELED: SegmentRow = {
  id: 'c000000000000001',
  startMs: 0,
  endMs: 1_000,
  label: '有效操作',
};
const SECOND: SegmentRow = { id: 'c000000000000002', startMs: 2_000, endMs: 3_000, label: null };

type Call = { method: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let store: SegmentRow[] = [];
let releaseDelete: (() => void) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 内存版片段接口：按方法分流，记录每次调用的请求体。 */
function installFetch(initial: SegmentRow[], hangDelete = false): void {
  store = [...initial];
  calls = [];
  releaseDelete = null;
  const gate = hangDelete
    ? new Promise<void>((resolve) => {
        releaseDelete = resolve;
      })
    : null;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, body });

    if (method === 'GET') return json({ ok: true, segments: store });
    if (method === 'DELETE') {
      if (gate) await gate;
      const id = url.split('/').pop();
      store = store.filter((row) => row.id !== id);
      return json({ ok: true });
    }
    if (method === 'POST' && body) {
      const created: SegmentRow = {
        id: `n00000000000000${calls.length}`,
        startMs: body.startMs as number,
        endMs: body.endMs as number,
        label: (body.label as string | null | undefined) ?? null,
      };
      store = [...store.filter((row) => row.id !== body.replaces), created];
      return json({ ok: true, segment: created });
    }
    return json({ ok: false }, 404);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  // 偏好写 localStorage；不清会让上一个用例的开关状态漏到下一个
  window.localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

  let currentTime = 0;
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('撤销方向与标签回放（H1 / P1）', () => {
  it('删除后 Ctrl+Z：POST 的是被删区间，并且带着原 label', async () => {
    installFetch([LABELED]);
    const user = userEvent.setup();
    render(<Workbench task={TASK} initialSegments={[LABELED]} />);

    await user.click(screen.getByRole('button', { name: '删除第 1 段' }));
    await waitFor(() => expect(screen.queryByText('有效操作')).toBeNull());

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const post = calls.find((call) => call.method === 'POST');
    // 若 Workbench 记的是操作后（删除后的空数组），这里根本不会有 POST
    expect(post?.body).toEqual({
      startMs: 0,
      endMs: 1_000,
      replaces: null,
      label: '有效操作',
    });
  });
});

describe('删除在途的写入口守卫（O1c）', () => {
  it('DELETE 未返回时按 I / O 不发 POST，并给出提示', async () => {
    installFetch([LABELED, SECOND], true);
    render(<Workbench task={TASK} initialSegments={[LABELED, SECOND]} />);

    fireEvent.click(screen.getByRole('button', { name: '删除第 1 段' }));
    await waitFor(() => expect(screen.getByText('正在删除片段…')).toBeTruthy());

    const video = document.querySelector('video') as HTMLVideoElement;
    fireEvent.keyDown(window, { key: 'i' });
    video.currentTime = 2;
    fireEvent.keyDown(window, { key: 'o' });

    await waitFor(() =>
      expect(screen.getByText('正在删除片段，请稍候再试')).toBeTruthy(),
    );
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    releaseDelete?.();
  });
});

describe('单字符快捷键开关（P4）', () => {
  it('关闭后空格不播放，重新开启后能播放', async () => {
    installFetch([LABELED]);
    const user = userEvent.setup();
    render(<Workbench task={TASK} initialSegments={[LABELED]} />);

    const toggle = screen.getByRole('checkbox');
    await user.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.keyDown(window, { code: 'Space' });
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

    await user.click(toggle);
    fireEvent.keyDown(window, { code: 'Space' });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});

describe('O 键太短的提示（P7）', () => {
  it('50ms 不创建并提示入点还在；挪远后创建成功', async () => {
    installFetch([]);
    render(<Workbench task={TASK} initialSegments={[]} />);
    const video = document.querySelector('video') as HTMLVideoElement;

    fireEvent.keyDown(window, { key: 'i' });
    video.currentTime = 0.05;
    fireEvent.keyDown(window, { key: 'o' });

    await waitFor(() => expect(screen.getByText(/这一段太短/)).toBeTruthy());
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    video.currentTime = 3;
    fireEvent.keyDown(window, { key: 'o' });
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    });
    await waitFor(() => expect(screen.queryByText(/这一段太短/)).toBeNull());
  });
});
