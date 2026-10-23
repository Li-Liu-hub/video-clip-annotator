/**
 * 管理员区外壳：左侧固定导航 + 内容区。
 *
 * 导航按功能点顺序占位，未完成的项标灰但不隐藏：
 * 管理员需要知道后续还有哪些入口，布局也不必等后续功能点再改结构。
 */
import Link from 'next/link';
import { requireAdmin } from '@/lib/server/guards';

/** 视频与任务页已实现；统计、审计仍用 null 表示「不跳转」。 */
const NAV = [
  { href: '/admin/videos', label: '视频' },
  { href: '/admin/tasks', label: '任务' },
  { href: null, label: '统计' },
  { href: null, label: '审计' },
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // 角色判定放在布局：/admin 子树只有一个入口，后续新增页不必各自记得加守卫
  const user = await requireAdmin();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-[212px] shrink-0 flex-col border-r border-line-soft bg-panel/50 px-3 py-5">
        <div className="flex items-center gap-2.5 px-1">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-2/20 ring-1 ring-accent-2/40">
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
          <span className="text-[14px] font-medium tracking-tight text-ink">片段标注</span>
        </div>

        <p className="mt-8 px-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-ink-faint">
          管理台
        </p>
        <nav className="mt-2 space-y-0.5" aria-label="管理台导航">
          {NAV.map((item, index) => {
            const number = (
              <span className={`tnum text-[11px] ${item.href ? 'text-accent' : 'text-ink-faint'}`}>
                {String(index + 1).padStart(2, '0')}
              </span>
            );

            if (!item.href) {
              return (
                // 用 span 而非 disabled button：它不是「点了会触发什么」的控件，只是一项未开放的入口
                <span
                  key={item.label}
                  aria-disabled="true"
                  title="后续版本"
                  className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-2 text-ink-faint opacity-60"
                >
                  {number}
                  <span className="text-[13px]">{item.label}</span>
                </span>
              );
            }

            return (
              <Link
                key={item.label}
                href={item.href}
                aria-current="page"
                className="flex items-center gap-2.5 rounded-md bg-panel-2 px-2.5 py-2 text-ink ring-1 ring-line"
              >
                {number}
                <span className="text-[13px]">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-line-soft px-1 pt-4">
          <p className="text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">当前账号</p>
          <p className="mt-1.5 truncate text-[13px] text-ink">{user.displayName}</p>
          <span className="tag mt-2">管理员</span>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-6 py-7 lg:px-9">{children}</main>
    </div>
  );
}
