/** 根路径：只做角色分流，本身不渲染任何内容。 */
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';

export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  redirect(user.role === 'admin' ? '/admin' : '/tasks');
}
