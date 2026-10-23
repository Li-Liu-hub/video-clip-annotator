import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';

export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  redirect(user.role === 'admin' ? '/admin' : '/tasks');
}
