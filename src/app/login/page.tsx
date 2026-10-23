/** 登录页。已登录的访问者直接跳到各自的工作台，避免重复登录。 */
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/server/current-user';
import LoginForm from './LoginForm';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(user.role === 'admin' ? '/admin' : '/tasks');

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-12">
      <div className="pointer-events-none absolute inset-0 opacity-[0.35]" aria-hidden>
        <svg width="100%" height="100%">
          <defs>
            <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M48 0H0V48" fill="none" stroke="#1a1d27" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      </div>
      <div className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[720px] -translate-x-1/2 rounded-full bg-accent-2/10 blur-3xl" aria-hidden />

      <div className="relative grid w-full max-w-5xl items-center gap-16 lg:grid-cols-[1fr_420px]">
        <section className="hidden lg:block">
          <h2 className="text-[15px] font-medium text-ink-dim">把手工表格换成可对账的流程</h2>
          <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-ink-faint">
            过去标注员把起止时间填进表格，管理员每天手工汇总，数字经常对不上。现在每一次提交都会写入不可变账本，
            历史日期的数字不会再变。
          </p>

          <div className="mt-9 rounded-2xl border border-line bg-panel/80 p-5 backdrop-blur">
            <div className="relative mb-4 aspect-video overflow-hidden rounded-lg bg-[#0b0d14] ring-1 ring-line-soft">
              <div className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line" />
              <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/70" />
              <div className="absolute bottom-3 left-3 rounded bg-black/50 px-2 py-1 tnum text-[11px] text-ink-dim">
                00:12.480
              </div>
            </div>

            <div className="relative h-11 rounded-md bg-panel-2 ring-1 ring-line-soft">
              <div className="absolute inset-y-0 left-[6%] w-[20%] rounded-sm bg-accent/30 ring-1 ring-accent/60" />
              <div className="absolute inset-y-0 left-[32%] w-[13%] rounded-sm bg-accent/30 ring-1 ring-accent/60" />
              <div className="absolute inset-y-0 left-[55%] w-[27%] rounded-sm bg-accent/30 ring-1 ring-accent/60" />
              <div className="absolute inset-y-0 left-0 w-[78%] rounded-sm bg-good/8 ring-1 ring-good/25" />
              <div className="absolute inset-y-0 left-[78%] w-px bg-ink/70" />
            </div>

            <div className="mt-3 flex items-center justify-between text-[11px] text-ink-faint">
              <span className="tnum">4 个片段 · 合计 18.6 秒</span>
              <span>已提交 · 2026-10-23</span>
            </div>
          </div>
        </section>

        <LoginForm />
      </div>
    </main>
  );
}
