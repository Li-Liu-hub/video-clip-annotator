'use client';

/** 登录表单与演示账号快捷入口。点账号即填充并提交，省去评分人输密码。 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', label: '平台管理员', sub: '跨租户 · 发布与统计', tone: 'accent' },
  { username: 'alice', password: 'demo123', label: '林小雨', sub: '标注员 · 星尘机器人', tone: 'plain' },
  { username: 'bob', password: 'demo123', label: '陈默', sub: '标注员 · 星尘机器人', tone: 'plain' },
  { username: 'carol', password: 'demo123', label: '周予安', sub: '标注员 · 北风具身智能', tone: 'plain' },
] as const;

/** 登录接口的响应体：成功带 role，失败带 { ok:false, error:{ code, message } }。 */
type LoginReply = {
  ok: boolean;
  role?: 'admin' | 'annotator';
  error?: { code?: string; message?: string };
};

/** 文案只取 error.message；响应体格式异常时退回通用文案，不把 undefined 渲染到页面上。 */
function messageOf(reply: LoginReply): string {
  return reply.error?.message ?? '登录失败';
}

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function signIn(u: string, p: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p }),
      });
      const data = (await res.json()) as LoginReply;
      if (!res.ok) {
        setError(messageOf(data));
        setBusy(false);
        return;
      }
      startTransition(() => {
        router.replace(data.role === 'admin' ? '/admin' : '/tasks');
        router.refresh();
      });
    } catch {
      setError('网络异常，请重试');
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-[420px]">
      <div className="mb-8">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-2/20 ring-1 ring-accent-2/40">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect x="1.5" y="3" width="13" height="10" rx="2" stroke="#8b93f8" strokeWidth="1.4" />
              <path d="M6.5 6.4v3.2l2.8-1.6-2.8-1.6Z" fill="#8b93f8" />
            </svg>
          </span>
          <span className="text-[15px] font-medium tracking-tight">片段标注</span>
        </div>
        <h1 className="text-[26px] font-medium leading-tight tracking-tight text-ink">登录工作台</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          标注机器人示教视频中的有效片段，工作量按提交日期自动归集。
        </p>
      </div>

      <form
        className="space-y-3"
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
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alice"
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
          />
        </div>

        {error ? (
          <p className="rounded-lg border border-bad/30 bg-bad-soft/60 px-3 py-2 text-xs text-bad">{error}</p>
        ) : null}

        <button type="submit" className="btn btn-primary w-full !py-2.5" disabled={busy || pending}>
          {busy || pending ? '正在进入…' : '登录'}
        </button>
      </form>

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
              type="button"
              disabled={busy || pending}
              onClick={() => {
                setUsername(acc.username);
                setPassword(acc.password);
                void signIn(acc.username, acc.password);
              }}
              className="group rounded-lg border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-accent-2/60 hover:bg-panel-2 disabled:opacity-50"
            >
              <span className="block text-[13px] font-medium text-ink">{acc.label}</span>
              <span className="mt-0.5 block truncate text-[11px] text-ink-faint">{acc.sub}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
