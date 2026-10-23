/** 根路径：只做角色分流，本身不渲染任何内容。 */
import { redirect } from 'next/navigation';
import { homePathOf, requireUser } from '@/lib/server/guards';

export default async function Home() {
  // 未登录已由 requireUser 跳走，这里只剩「已登录选哪个落地页」；
  // 守卫内部靠抛异常重定向，故不得包 try/catch
  redirect(homePathOf(await requireUser()));
}
