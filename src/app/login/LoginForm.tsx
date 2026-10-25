'use client';

/** 登录表单与演示账号快捷入口。点账号即填充并提交，省去评分人输密码。 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { withBasePath } from '@/lib/base-path';
import { DEMO_ACCOUNTS } from '@/lib/demo-accounts';
import { homePathOf } from '@/lib/routes';

/**
 * 演示账号只在构建期显式开启时存在：`NEXT_PUBLIC_DEMO_LOGIN=1 npm run build`。
 *
 * NEXT_PUBLIC_* 在构建期被内联成字面量，所以默认构建里这整个数组（含四个明文口令）
 * 必须被判成死代码摇掉。这是实测项，不是推断项：默认构建后
 * `grep -rl "admin123" .next/static` 必须无输出。
 *
 * 账号数据在 `lib/demo-accounts`：seed 与登录页共用同一份，避免只改一端。
 */
const SHOW_DEMO = process.env.NEXT_PUBLIC_DEMO_LOGIN === '1';

/** 登录接口的响应体。用判别联合而非全可选字段，成功分支里 role 就不必再兜 undefined。 */
type LoginReply =
  | { ok: true; role: 'admin' | 'annotator' }
  | { ok: false; error?: { code?: string; message?: string } };

/** 文案只取 error.message；响应体格式异常时退回通用文案，不把 undefined 渲染到页面上。 */
function messageOf(reply: LoginReply): string {
  return reply.ok ? '登录失败' : (reply.error?.message ?? '登录失败');
}

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const blocked = busy || pending;

  async function signIn(u: string, p: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(withBasePath('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p }),
      });
      const data = (await res.json()) as LoginReply;
      // 失败分支统一落 error；成功分支下 data 已收窄为 { ok: true, role }
      if (!res.ok || !data.ok) {
        setError(messageOf(data));
        return;
      }
      // 跳转目标只认 homePathOf：客户端再写一遍三元，迟早与服务端那份漂移
      startTransition(() => {
        router.replace(homePathOf(data));
        router.refresh();
      });
    } catch {
      setError('网络异常，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-[400px]">
      {/* 左栏在 lg 以下隐藏，品牌标识在这里补一份，否则窄屏看不到产品名 */}
      <div className="mb-8 flex items-center gap-2.5 lg:hidden">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-2/20 ring-1 ring-accent-2/40">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="1.5" y="3" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" className="text-accent" />
            <path d="M6.5 6.4v3.2l2.8-1.6-2.8-1.6Z" fill="currentColor" className="text-accent" />
          </svg>
        </span>
        <span className="text-[15px] font-medium tracking-tight text-ink">片段标注</span>
      </div>

      <h1 className="text-[24px] font-medium leading-tight tracking-tight text-ink">登录工作台</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
        输入账号进入任务台。工作量按提交日期归集，无需手工汇总。
      </p>

      <form
        className="mt-7 space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(username, password);
        }}
      >
        <div>
          <label htmlFor="username" className="mb-1.5 block text-xs font-medium text-ink-dim">
            用户名
          </label>
          <input
            id="username"
            className="field"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alice"
            aria-invalid={error !== null}
            aria-describedby={error ? 'login-error' : undefined}
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-ink-dim">
            密码
          </label>
          <input
            id="password"
            type="password"
            className="field"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            aria-invalid={error !== null}
            aria-describedby={error ? 'login-error' : undefined}
          />
        </div>

        {error ? (
          <p
            id="login-error"
            role="alert"
            className="rounded-lg border border-bad/30 bg-bad-soft/60 px-3 py-2 text-xs text-bad"
          >
            {error}
          </p>
        ) : null}

        <button type="submit" className="btn btn-primary w-full !py-2.5" disabled={blocked} aria-busy={blocked}>
          {blocked ? '正在进入…' : '登录'}
        </button>
      </form>

      {SHOW_DEMO ? (
        <div className="mt-8">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">演示账号</span>
            <span className="h-px flex-1 bg-line-soft" />
          </div>
          <p className="mb-2.5 text-[11.5px] leading-relaxed text-ink-faint">点击即可直接进入，无需输入密码</p>
          <div className="grid grid-cols-2 gap-2">
            {DEMO_ACCOUNTS.map((acc) => (
              <button
                key={acc.username}
                // type 不能省：默认 submit，光标停在演示按钮上按回车会提交空表单
                type="button"
                disabled={blocked}
                onClick={() => {
                  setUsername(acc.username);
                  setPassword(acc.password);
                  void signIn(acc.username, acc.password);
                }}
                className="rounded-lg border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-accent-2/60 hover:bg-panel-2 disabled:opacity-50"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] font-medium text-ink">{acc.name}</span>
                  <span className="tnum shrink-0 text-[10.5px] text-ink-faint">{acc.username}</span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-ink-faint">{acc.note}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
