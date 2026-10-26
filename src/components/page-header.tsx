/** 主要页面统一页头：可选返回、标题、说明、右侧操作与补充内容。 */
import Link from 'next/link';
import type { ReactNode } from 'react';

type Props = {
  title: string;
  description?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
  children?: ReactNode;
};

export default function PageHeader({ title, description, back, actions, children }: Props) {
  return (
    <header className="mb-6">
      {back ? (
        <Link
          href={back.href}
          className="inline-flex min-h-8 items-center text-[11.5px] text-ink-faint transition-colors hover:text-ink"
        >
          ← {back.label}
        </Link>
      ) : null}
      <div
        className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-3 ${back ? 'mt-1' : ''}`}
      >
        <h1 className="min-w-0 break-words text-[24px] font-semibold leading-tight tracking-[-0.02em] text-ink">
          {title}
        </h1>
        {actions ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">{actions}</div>
        ) : null}
      </div>
      {description ? (
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-ink-dim">{description}</div>
      ) : null}
      {children}
    </header>
  );
}
