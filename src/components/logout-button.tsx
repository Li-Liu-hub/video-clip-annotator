'use client';

/** 统一退出入口：调用既有认证接口，成功回登录页，失败留在原页重试。 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { withBasePath } from '@/lib/base-path';

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  async function logout() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(withBasePath('/api/auth/login'), { method: 'DELETE' });
      if (!response.ok) {
        setError('退出失败，请重试');
        return;
      }
      router.replace('/login');
      router.refresh();
      return;
    } catch {
      setError('网络异常，退出失败，请重试');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void logout()}
      >
        {busy ? '退出中…' : '退出'}
      </button>
      {error ? (
        <p role="alert" className="max-w-56 text-right text-[11.5px] text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
