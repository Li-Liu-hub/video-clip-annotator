/** 角色到落地页的映射。纯函数、零依赖，服务端守卫与客户端表单共用同一份。 */

/**
 * 只声明用得到的 role 字段，不引 SessionUser：
 * 客户端没有会话对象，引服务端类型会把整个认证层拖进浏览器 bundle。
 */
type Role = 'admin' | 'annotator';

export function homePathOf(user: { role: Role }): string {
  return user.role === 'admin' ? '/admin' : '/tasks';
}
