/** 管理员区：布局统一鉴权，并复用全站导航、账号与退出外壳。 */
import AppShell from '@/components/app-shell';
import { requireAdmin } from '@/lib/server/guards';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // 角色判定放在布局：/admin 子树只有一个入口，后续新增页不必各自记得加守卫
  const user = await requireAdmin();

  return (
    <AppShell user={{ displayName: user.displayName, role: user.role }}>{children}</AppShell>
  );
}
