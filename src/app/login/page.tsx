/** 登录页。已登录的访问者直接跳到各自的工作台，避免重复登录。 */
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/server/current-user';
import { homePathOf } from '@/lib/routes';
import LoginAside from './LoginAside';
import LoginForm from './LoginForm';

export default async function LoginPage() {
  const user = await getCurrentUser();
  // 方向与 requireUser 相反（已登录就离开），复用它会把自己重定向成死循环；
  // 只借用 homePathOf，角色分流规则仍只有一处
  if (user) redirect(homePathOf(user));

  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[1.15fr_minmax(440px,42%)]">
      <LoginAside />
      {/* 窄屏只有右栏，靠左栏的 hidden 控制显隐；这里不写固定宽度，免得 375px 挤成一团 */}
      <section className="flex min-h-screen items-center justify-center px-6 py-14 lg:px-10">
        <LoginForm />
      </section>
    </main>
  );
}
