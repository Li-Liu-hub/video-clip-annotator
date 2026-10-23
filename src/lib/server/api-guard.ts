/**
 * API 守卫：Route Handler 的「未登录 → 401、角色不符 → 403」。
 *
 * 与 guards.ts 不共用的原因写在那边：这里靠 throw，由 handler 的 catch 交给 toErrorResponse。
 * 反过来若在 API 里用 redirect，XHR 收到的是 HTML 跳转而不是可判定的 JSON。
 */
import { ForbiddenError, UnauthorizedError } from '@/lib/errors';
import { getCurrentUser } from '@/lib/server/current-user';
import { isTenantUser, type SessionUser, type TenantUser } from '@/lib/services/auth-service';

/** API 用。未登录抛 UnauthorizedError(401)。 */
export async function requireApiUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/** API 用。未登录 401；非管理员抛 ForbiddenError(403)。 */
export async function requireApiAdmin(): Promise<SessionUser> {
  const user = await requireApiUser();
  // 已认证但角色不符，与资源是否存在无关，故 403 在此不构成存在性泄漏
  if (user.role !== 'admin') throw new ForbiddenError();
  return user;
}

/**
 * API 用。未登录 401；不是标注员（管理员或身份残缺的账号）抛 ForbiddenError(403)。
 *
 * 管理员不参与标注，且没有租户 —— service 的入参类型是 TenantUser，类型层已挡住，
 * 这里再挡一次是因为类型只在编译期生效，运行期身份仍来自库。
 */
export async function requireApiAnnotator(): Promise<TenantUser> {
  const user = await requireApiUser();
  // 单独赋值：audit:rules 把「同一行既有 ForbiddenError 又有租户字样」判为跨租户 403，
  // 而这里判的是身份是否成立，不是访问范围
  const isAnnotator = isTenantUser(user);
  if (!isAnnotator) throw new ForbiddenError();
  return user;
}
