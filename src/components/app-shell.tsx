'use client';

/** 已登录页面共享外壳：按角色提供导航、账号与退出，桌面侧栏在窄屏转为顶部区。 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import LogoutButton from './logout-button';

export type ShellUser = { displayName: string; role: 'admin' | 'annotator' };

type NavItem = { href: string; label: string };

const ADMIN_NAV: readonly NavItem[] = [
  { href: '/admin/videos', label: '视频' },
  { href: '/admin/tasks', label: '任务' },
  { href: '/stats', label: '统计' },
  { href: '/admin/audit', label: '审计' },
];

const ANNOTATOR_NAV: readonly NavItem[] = [
  { href: '/tasks', label: '我的任务' },
  { href: '/stats', label: '我的工作量' },
];

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppShell({
  user,
  children,
}: {
  user: ShellUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const navigation = user.role === 'admin' ? ADMIN_NAV : ANNOTATOR_NAV;
  const navigationLabel = user.role === 'admin' ? '管理台导航' : '标注员导航';

  return (
    <div className="min-h-screen min-w-0 md:flex">
      <aside className="flex w-full min-w-0 shrink-0 flex-col border-b border-line-soft bg-panel/55 px-4 py-4 md:sticky md:top-0 md:h-screen md:w-[224px] md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-2/20 ring-1 ring-accent-2/40">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect
                  x="1.5"
                  y="3"
                  width="13"
                  height="10"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  className="text-accent"
                />
                <path d="M6.5 6.4v3.2l2.8-1.6-2.8-1.6Z" fill="currentColor" className="text-accent" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium tracking-tight text-ink">片段标注</p>
              <p className="mt-0.5 truncate text-[11px] text-ink-faint" title={user.displayName}>
                {user.displayName} · {user.role === 'admin' ? '管理员' : '标注员'}
              </p>
            </div>
          </div>
          <LogoutButton />
        </div>

        <nav className="mt-4 min-w-0 overflow-x-auto md:mt-8" aria-label={navigationLabel}>
          <ul className="flex min-w-max gap-1 md:min-w-0 md:flex-col">
            {navigation.map((item, index) => {
              const current = isCurrent(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    className={`flex min-h-9 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-[13px] transition-colors ${
                      current
                        ? 'bg-accent-soft/45 text-ink ring-1 ring-accent-2/35'
                        : 'text-ink-dim hover:bg-panel-2/60 hover:text-ink'
                    }`}
                  >
                    <span className={`tnum text-[11px] ${current ? 'text-accent' : 'text-ink-faint'}`}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6 md:w-auto md:py-7 lg:px-9">
        {children}
      </main>
    </div>
  );
}
