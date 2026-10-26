// @vitest-environment jsdom
/** R1 共享外壳与退出的 DOM 契约：当前导航、请求防重与失败反馈。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  pathname: '/tasks',
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace, refresh: navigation.refresh }),
}));

import AppShell from '@/components/app-shell';
import LogoutButton from '@/components/logout-button';

beforeEach(() => {
  navigation.pathname = '/tasks';
  navigation.replace.mockReset();
  navigation.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('共享外壳', () => {
  it('新建任务页仍把管理员任务导航标为当前页', () => {
    navigation.pathname = '/admin/tasks/new';
    render(
      <AppShell user={{ displayName: '管理员', role: 'admin' }}>
        <div>内容</div>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: /任务$/ }).getAttribute('aria-current')).toBe('page');
  });

  it('标注员统计页保留我的工作量导航与当前状态', () => {
    navigation.pathname = '/stats';
    render(
      <AppShell user={{ displayName: '林小雨', role: 'annotator' }}>
        <div>内容</div>
      </AppShell>,
    );

    expect(
      screen.getByRole('link', { name: /我的工作量/ }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('管理员只看到管理导航，前缀相似路径不误判当前页', () => {
    navigation.pathname = '/admin/tasks-old';
    render(
      <AppShell user={{ displayName: '管理员', role: 'admin' }}>
        <div>内容</div>
      </AppShell>,
    );

    expect({
      adminLinks: screen.getByRole('navigation', { name: '管理台导航' }).querySelectorAll('a')
        .length,
      annotatorLink: screen.queryByRole('link', { name: /我的任务/ }),
      current: screen.getByRole('navigation', { name: '管理台导航' }).querySelector('[aria-current]'),
    }).toEqual({ adminLinks: 4, annotatorLink: null, current: null });
  });
});

describe('退出', () => {
  it('请求未返回时显示忙态且双击只发一次 DELETE', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<LogoutButton />);
    const button = screen.getByRole('button', { name: '退出' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect({
      calls: fetchMock.mock.calls,
      text: button.textContent,
      busy: button.getAttribute('aria-busy'),
      disabled: (button as HTMLButtonElement).disabled,
    }).toEqual({
      calls: [[ '/api/auth/login', { method: 'DELETE' } ]],
      text: '退出中…',
      busy: 'true',
      disabled: true,
    });
  });

  it('成功后替换到登录页并刷新服务端状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    render(<LogoutButton />);

    fireEvent.click(screen.getByRole('button', { name: '退出' }));

    await waitFor(() => {
      expect({
        replace: navigation.replace.mock.calls,
        refreshCount: navigation.refresh.mock.calls.length,
      }).toEqual({ replace: [['/login']], refreshCount: 1 });
    });
  });

  it('失败后显示中文提示并恢复可重试按钮', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    render(<LogoutButton />);

    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    const alert = await screen.findByRole('alert');

    expect({
      message: alert.textContent,
      button: screen.getByRole('button', { name: '退出' }).textContent,
      disabled: (screen.getByRole('button', { name: '退出' }) as HTMLButtonElement).disabled,
    }).toEqual({ message: '退出失败，请重试', button: '退出', disabled: false });
  });

  it('网络异常后保留当前页并允许再次退出', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LogoutButton />);

    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '退出' }));

    await waitFor(() => {
      expect({
        calls: fetchMock.mock.calls.length,
        replace: navigation.replace.mock.calls,
      }).toEqual({ calls: 2, replace: [['/login']] });
    });
  });
});
