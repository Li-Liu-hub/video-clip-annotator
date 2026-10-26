// @vitest-environment jsdom
/** R1 任务入口与四种写操作的 DOM 契约：页码、本人只读入口、忙态与防重。 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TaskList from '@/app/tasks/TaskList';

const USER = { id: 'u000000000000001', displayName: '林小雨' };
type Status = 'pending' | 'claimed' | 'submitted' | 'rejected';

type Item = {
  id: string;
  title: string;
  status: Status;
  claimed_by: string | null;
  estimated_ms: number;
  video_filename: string;
  tenant_name: string;
  claimed_by_name: string | null;
  reject_reason: string | null;
  created_at: number;
};

function task(status: Status, mine = true): Item {
  return {
    id: 'a000000000000001',
    title: '测试任务',
    status,
    claimed_by: status === 'pending' ? null : mine ? USER.id : 'u000000000000002',
    estimated_ms: 10_000,
    video_filename: 'robot.mp4',
    tenant_name: '空间一',
    claimed_by_name: status === 'pending' ? null : mine ? USER.displayName : '其他人',
    reject_reason: null,
    created_at: 0,
  };
}

function renderList(item: Item, admin = false) {
  return render(
    <TaskList
      items={[item]}
      showTenant={false}
      timezone="UTC"
      currentUser={admin ? null : USER}
      canReject={admin}
      returnPage={3}
    />,
  );
}

function pendingFetch() {
  let finish!: () => void;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = () => resolve(new Response(null, { status: 200 }));
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, finish: () => finish() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('工作台入口', () => {
  it('本人已提交任务显示只读入口并保留列表页码', () => {
    renderList(task('submitted'));

    expect(screen.getByRole('link', { name: '查看标注' }).getAttribute('href')).toBe(
      '/tasks/a000000000000001/work?returnPage=3',
    );
  });

  it('继续标注入口保留列表页码', () => {
    renderList(task('claimed'));

    expect(screen.getByRole('link', { name: '继续标注' }).getAttribute('href')).toBe(
      '/tasks/a000000000000001/work?returnPage=3',
    );
  });

  it('非本人已提交任务不显示只读入口', () => {
    renderList(task('submitted', false));

    expect(screen.queryByRole('link', { name: '查看标注' })).toBeNull();
  });
});

describe('任务操作忙态', () => {
  it('领取中显示进行中文案、aria-busy 且重复点击不增发请求', () => {
    const { fetchMock, finish } = pendingFetch();
    renderList(task('pending'));
    fireEvent.click(screen.getByRole('button', { name: '领取' }));
    fireEvent.click(screen.getByRole('button', { name: '领取中…' }));
    const button = screen.getByRole('button', { name: '领取中…' });

    expect({ calls: fetchMock.mock.calls.length, busy: button.getAttribute('aria-busy') }).toEqual({
      calls: 1,
      busy: 'true',
    });
    finish();
  });

  it('归还中显示进行中文案与 aria-busy', () => {
    const { finish } = pendingFetch();
    renderList(task('claimed'));
    fireEvent.click(screen.getByRole('button', { name: '归还' }));
    const button = screen.getByRole('button', { name: '归还中…' });

    expect(button.getAttribute('aria-busy')).toBe('true');
    finish();
  });

  it('重新打开中显示进行中文案与 aria-busy', () => {
    const { finish } = pendingFetch();
    renderList(task('rejected'));
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    const button = screen.getByRole('button', { name: '重新打开中…' });

    expect(button.getAttribute('aria-busy')).toBe('true');
    finish();
  });

  it('确认退回中显示进行中文案与 aria-busy', () => {
    const { finish } = pendingFetch();
    renderList(task('submitted'), true);
    fireEvent.click(screen.getByRole('button', { name: '退回' }));
    fireEvent.change(screen.getByLabelText(/退回原因/), { target: { value: '需要修改' } });
    fireEvent.click(screen.getByRole('button', { name: '确认退回' }));
    const button = screen.getByRole('button', { name: '退回中…' });

    expect(button.getAttribute('aria-busy')).toBe('true');
    finish();
  });
});
