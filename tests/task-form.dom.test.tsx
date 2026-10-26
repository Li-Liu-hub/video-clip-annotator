// @vitest-environment jsdom
/** R1 视频到新建任务的 DOM 契约：可用链接、合法预选与默认不选。 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import TaskForm from '@/app/admin/tasks/new/TaskForm';
import VideoManager from '@/app/admin/videos/VideoManager';

const VIDEOS = [
  { id: 'v000000000000001', filename: 'a.mp4', durationMs: 10_000, sizeBytes: 1024 },
  { id: 'v000000000000002', filename: 'b.mp4', durationMs: 20_000, sizeBytes: 2048 },
];

afterEach(cleanup);

describe('视频建任务', () => {
  it('素材列表的去建任务链接携带该视频 id', () => {
    render(
      <VideoManager
        initialVideos={[{ ...VIDEOS[0], createdAt: 0 }]}
        timezone="UTC"
      />,
    );

    expect(screen.getByRole('link', { name: '去建任务' }).getAttribute('href')).toBe(
      '/admin/tasks/new?videoId=v000000000000001',
    );
  });

  it('合法 initialVideoId 预选对应素材', () => {
    render(<TaskForm videos={VIDEOS} tenants={[]} initialVideoId={VIDEOS[1].id} />);

    expect(screen.getByRole('button', { name: /b\.mp4/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('没有合法预选值时不错误选中素材', () => {
    render(<TaskForm videos={VIDEOS} tenants={[]} initialVideoId={null} />);

    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(0);
  });
});
