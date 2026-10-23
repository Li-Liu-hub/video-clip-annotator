/**
 * 页面守卫：Server Component 的「取当前用户 → 未登录 / 角色不符就跳走」。
 *
 * 与 api-guard 分开而非共用：redirect() 靠抛异常（NEXT_REDIRECT）中断渲染，
 * 而 Route Handler 必须 try/catch 兜错，包住它重定向就被吞掉。
 * 故本文件的入口禁止被调用方包 try/catch。
 */
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/server/current-user';
import type { SessionUser } from '@/lib/services/auth-service';

/** 已登录用户。未登录跳转登录页。调用方禁止包 try/catch。 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  // redirect 的返回类型是 never，TS 已在下一行收窄为非 null，无需断言
  if (!user) redirect('/login');
  return user;
}

/** 管理员。未登录跳登录页；非管理员跳 /tasks。 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  // 跳自己的首页而非 notFound()：/admin 并非隐藏路径，404 只会让人以为系统坏了
  if (user.role !== 'admin') redirect('/tasks');
  return user;
}

/**
 * 角色对应的落地页。实现放在 lib/routes.ts：本文件 import 了 next/navigation，
 * 客户端组件从这里取 homePathOf 会连带把服务端依赖打进浏览器 bundle。
 * 在此 re-export，现有 `@/lib/server/guards` 的引用保持可用。
 */
export { homePathOf } from '@/lib/routes';
