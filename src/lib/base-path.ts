/**
 * 部署在子路径时的路径前缀（例如 nginx 把 `/vsap/` 反代到本应用）。
 *
 * 本地与测试不设 `NEXT_PUBLIC_BASE_PATH`，函数退化为恒等，行为与之前完全一致。
 *
 * 只给「Next 不会自动加前缀」的地方用：
 *   - fetch / XMLHttpRequest 的 URL
 *   - <a href>、<video src> 这类原生属性
 *   - 服务端 redirect() 的目标
 * `next/link` 与 `router.push/replace` 由 Next 自己加，别重复包一层。
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function withBasePath(path: string): string {
  if (!BASE_PATH || !path.startsWith('/')) return path;
  return `${BASE_PATH}${path}`;
}
