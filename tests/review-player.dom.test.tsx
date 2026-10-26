// @vitest-environment jsdom
/** 审核播放器契约：点击定位播放、到终点暂停、切版本暂停和退回版本绑定。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewPlayer from '@/app/admin/tasks/[id]/review/ReviewPlayer';
import type { TaskReview } from '@/lib/services/review-query-service';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const REVIEW: TaskReview = {
  taskId: 'task', title: '测试任务', tenantName: 'A', status: 'submitted', rejectReason: null,
  videoFilename: 'a.mp4', durationMs: 30_000, streamUrl: '/api/videos/video/stream', submissions: [
    { id: 'current', displayName: '甲', submittedAt: 100, date: '2026-10-26', totalMs: 2000,
      segments: [{ startMs: 1000, endMs: 3000, label: '拿杯子' }] },
    { id: 'old', displayName: '甲', submittedAt: 0, date: '2026-10-25', totalMs: 1000,
      segments: [{ startMs: 5000, endMs: 6000, label: '旧片段' }] },
  ],
};
let frame: FrameRequestCallback;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('审核片段播放', () => {
  it('历史越界片段保留原时间，起点超出视频时不能播放', () => {
    const review: TaskReview = { ...REVIEW, durationMs: 500 };
    render(<ReviewPlayer review={review} timezone="UTC" />);
    expect({ disabled: (screen.getByRole('button', { name: /播放片段 1/ }) as HTMLButtonElement).disabled,
      warning: screen.getByText('片段起点已超出素材范围，无法播放，请退回核对。') !== null }).toEqual({ disabled: true, warning: true });
  });
  it('点击片段定位到起点并调用播放', async () => {
    const { container } = render(<ReviewPlayer review={REVIEW} timezone="UTC" />);
    fireEvent.click(screen.getByRole('button', { name: /播放片段 1/ }));
    await waitFor(() => expect({ start: container.querySelector('video')?.currentTime, plays: vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length }).toEqual({ start: 1, plays: 1 }));
  });
  it('播放到终点时暂停并停留在片段终点', () => {
    const { container } = render(<ReviewPlayer review={REVIEW} timezone="UTC" />);
    fireEvent.click(screen.getByRole('button', { name: /播放片段 1/ }));
    const video = container.querySelector('video')!;
    video.currentTime = 3.1;
    act(() => frame(0));
    expect({ time: video.currentTime, pauses: vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length }).toEqual({ time: 3, pauses: 2 });
  });
  it('切到历史版本隐藏退回按钮且暂停旧视频', () => {
    render(<ReviewPlayer review={REVIEW} timezone="UTC" />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    expect({ reject: screen.queryByRole('button', { name: '退回修改' }), pauses: vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length }).toEqual({ reject: null, pauses: 1 });
  });
  it('退回请求携带已审核提交的版本', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<ReviewPlayer review={REVIEW} timezone="UTC" />);
    fireEvent.change(screen.getByLabelText('退回原因（必填）'), { target: { value: '第一段边界需要修改' } });
    fireEvent.click(screen.getByRole('button', { name: '退回修改' }));
    await waitFor(() => expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ reason: '第一段边界需要修改', submissionId: 'current' }));
  });
});
