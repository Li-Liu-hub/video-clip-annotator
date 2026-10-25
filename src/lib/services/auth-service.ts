/**
 * 身份体系的唯一实现：密码哈希、凭据校验、会话签发与解析、身份装配、角色判定。
 *
 * 不 import next/headers —— 读 cookie 放在 lib/server/current-user，
 * 本层才能在内存库上单测。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { nowMs, type DB } from '@/lib/db';
import { findByUsername, findWithTenantById, type UserWithTenantRow } from '@/lib/db/repos/user-repo';
import {
  deleteExpired,
  deleteSession,
  findSession,
  findSessionWithUser,
  insertSession,
} from '@/lib/db/repos/session-repo';
import { AUDIT_ACTIONS } from '@/lib/audit-actions';
import { UnauthorizedError } from '@/lib/errors';
import { writeAudit, type AuditEntry } from './audit-service';

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'annotator';
  tenantId: string | null; // 管理员为 null
  tenantName: string | null;
  timezone: string; // 来自 tenants.timezone，管理员为默认值
};

/** 标注员一定持有租户。管理员与「数据被改坏的标注员」都不满足。 */
export type TenantUser = SessionUser & { role: 'annotator'; tenantId: string };

/**
 * 只回答「是否满足」，不承担「必须满足」的断言职责 —— 因此不抛错。
 * 各调用场景要的 HTTP 状态码不同（页面跳转 / 404 / 500），
 * 在这里写死一种就等于替调用方决定了失败语义。
 * 用类型守卫而非布尔函数：窄化后 tenantId 在类型层面即 string，调用方无需每处判空。
 */
export function isTenantUser(user: SessionUser): user is TenantUser {
  // 判 typeof 而非判 null：畸形数据里字段可能缺失（undefined），一道条件覆盖两种情况。
  // 再排空串：空串不是「没有租户」而是脏数据，放过去会让 WHERE tenant_id = '' 静默返空集，
  // 比 null 难查得多——null 至少会在判空处暴露。
  return (
    user.role === 'annotator' && typeof user.tenantId === 'string' && user.tenantId.length > 0
  );
}

export const SESSION_COOKIE = 'vsap_sid';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PASSWORD_SCHEME = 'scrypt';
/** salt 16 字节、派生 64 字节，与 scripts/setup.mjs 灌入的种子哈希同格式 */
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** 24 字节随机数 → 48 位十六进制会话 id，不可猜且不必签名 */
const SESSION_ID_BYTES = 24;
/** 管理员不属于任何租户，取不到 tenants.timezone；统计页的管理员视图仍需按日分组 */
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const CREDENTIAL_MESSAGE = '用户名或密码不正确';

/**
 * 登录失败的三种原因，只写进审计，不进响应 —— 对外三种共用上面那一句文案。
 *
 * 分开记是因为行为模式不同：撞库会有大量 no_such_user，记错密码集中在少数几个 bad_password。
 * inactive 指凭据正确但账号不可用（见 isUsableIdentity）。
 */
export type LoginFailureReason = 'bad_password' | 'no_such_user' | 'inactive';

/** 请求上下文由路由层采集后注入：service 层不得 import next/headers。 */
export type AuthAuditContext = { ip?: string | null; userAgent?: string | null };

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, KEY_BYTES);
  return `${PASSWORD_SCHEME}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * 长度与字符集都先校验：畸形串（空 salt、非十六进制）交给 scryptSync 会抛 RangeError，
 * 登录接口就从 401 变成 500。
 */
function isHexBytes(text: string, bytes: number): boolean {
  return text.length === bytes * 2 && /^[0-9a-f]+$/i.test(text);
}

/** 恒定时间比较。格式不合法一律返回 false，不抛错。 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3) return false;

  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== PASSWORD_SCHEME) return false;
  if (!isHexBytes(saltHex, SALT_BYTES) || !isHexBytes(hashHex, KEY_BYTES)) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = scryptSync(plain, Buffer.from(saltHex, 'hex'), expected.length);
  // 先比长度：timingSafeEqual 长度不等会抛 RangeError
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * 用户不存在时用来跑一次等价开销的哈希。
 *
 * 若查不到用户就直接抛错，响应时间会是「存在」的 1/2000，
 * 攻击者据此可批量枚举用户名——「同一句文案」的防护就白做了。
 * 延迟初始化：避免模块加载时白付一次 scrypt。
 */
let dummyHash: string | null = null;
function getDummyHash(): string {
  if (!dummyHash) dummyHash = hashPassword('__no_such_user__');
  return dummyHash;
}

/** 校验凭据并返回身份。失败统一抛 UnauthorizedError，不区分「用户不存在」与「密码错」。 */
export function authenticate(
  db: DB,
  username: string,
  password: string,
  context: AuthAuditContext = {},
): SessionUser {
  const credential = findByUsername(db, username);

  // 无论用户是否存在都跑一次 scrypt，消除时间侧信道
  const passwordOk = verifyPassword(password, credential?.password_hash ?? getDummyHash());

  // 三种失败原因分开记在审计里，对外却共用同一个出口 —— 泄漏「用户不存在」
  // 等于送攻击者半个用户名枚举器，所以响应里说粗的、日志里记细的。
  if (!credential) failLogin(db, { username, reason: 'no_such_user', actorId: null, context });
  if (!passwordOk) failLogin(db, { username, reason: 'bad_password', actorId: credential.id, context });

  // 身份字段单独再查一次：密码哈希不进入装配身份的那条链路
  const identity = findWithTenantById(db, credential.id);
  if (!identity || !isUsableIdentity(identity)) {
    failLogin(db, { username, reason: 'inactive', actorId: credential.id, context });
  }

  // 登录是清理过期会话的天然时机，否则 sessions 表只增不减
  purgeExpiredSessions(db, nowMs());
  return toSessionUser(identity);
}

/**
 * 登录审计的写入口，一律旁路：审计表写不进去时人还是该能登录。
 *
 * 这里再包一层 try/catch 而不是只依赖 writeAudit 的默认旁路，
 * 是为了让「认证不受审计影响」成为本文件的保证，而不是被调方的实现细节。
 */
function auditLogin(db: DB, entry: AuditEntry): void {
  try {
    writeAudit(db, entry);
  } catch {
    // writeAudit 内部已记过 error 日志，此处只拦异常，不重复输出
  }
}

/**
 * 登录失败的唯一出口：**先写审计，再抛错**。
 *
 * 顺序反了，异常会把审计那一行一起带走 —— 所有失败登录都不留痕，
 * 而这恰恰是被爆破时最需要留痕的路径（连续失败才是入侵信号）。
 *
 * 只记 username 与 reason：密码、哈希一概不写，日志会被导出、会被贴进工单。
 */
function failLogin(
  db: DB,
  args: {
    username: string;
    reason: LoginFailureReason;
    actorId: string | null;
    context: AuthAuditContext;
  },
): never {
  auditLogin(db, {
    actorId: args.actorId,
    // 未通过认证，不写角色与租户：角色属于已认证身份；actorId 只用来把这次尝试关联到账号
    actorRole: null,
    tenantId: null,
    action: AUDIT_ACTIONS.authLoginFailed,
    detail: { username: args.username, reason: args.reason },
    ip: args.context.ip ?? null,
    userAgent: args.context.userAgent ?? null,
  });
  throw new UnauthorizedError(CREDENTIAL_MESSAGE);
}

/**
 * 「账号可用」= 标注员确实挂在某个租户上。
 *
 * schema 的 CHECK 已保证这一点，但手工改库、旧库迁移会绕过它。那样装配出的会话能登录，
 * 之后每条 tenant_id 查询都静默返空，症状离原因很远，故在登录时按不可用处理。
 */
function isUsableIdentity(row: UserWithTenantRow): boolean {
  return row.role === 'admin' || (typeof row.tenant_id === 'string' && row.tenant_id.length > 0);
}

/**
 * 登录并为本次会话签发新 id。
 * staleSessionId 存在时先销毁——防会话固定：不让请求带来的旧 sid 在登录后继续有效。
 *
 * 先校验再清旧会话，顺序不可颠倒：反过来的话，攻击者拿错误密码反复调用
 * 就能把受害者的在线会话挤下线，等于一个不需要口令的踢人接口。
 */
export function loginWithFreshSession(
  db: DB,
  username: string,
  password: string,
  staleSessionId?: string,
  context: AuthAuditContext = {},
): { user: SessionUser; sessionId: string } {
  const user = authenticate(db, username, password, context);

  // 只销毁属于当前登录用户的旧会话。
  // 否则任何知道他人 sid 的人，都能用自己的账号登录一次把对方踢下线——反复调用即构成 DoS。
  // 用不过滤过期的 findSession：过期行同样该被清掉。
  if (staleSessionId) {
    const stale = findSession(db, staleSessionId);
    if (stale && stale.user_id === user.id) destroySession(db, staleSessionId);
  }

  const sessionId = createSession(db, user.id);

  /**
   * 成功后写在这里而不是 authenticate：会话只有签发之后才存在。
   *
   * detail 里**不放 sessionId**。这个 schema 里 sessions.id 就是 cookie 的值 ——
   * 写进审计等于把一份 7 天有效的凭据存进了一张会被导出、会被贴进工单的表，
   * 而审计页的「详情」正是原样渲染 detail 的。
   * 事后要查「这次会话活了多久」，用 actorId + created_at 对 sessions 表即可。
   */
  auditLogin(db, {
    actorId: user.id,
    actorRole: user.role,
    tenantId: user.tenantId,
    action: AUDIT_ACTIONS.authLogin,
    detail: { username: user.username },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { user, sessionId };
}

/** 签发会话，返回 session id（48 位十六进制）。 */
export function createSession(db: DB, userId: string): string {
  const id = randomBytes(SESSION_ID_BYTES).toString('hex');
  const issuedAt = nowMs();
  insertSession(db, id, userId, issuedAt + SESSION_TTL_MS, issuedAt);
  return id;
}

/** 按 session id 解析身份；不存在、已过期、用户已删除均返回 null。 */
export function resolveSession(db: DB, sessionId: string): SessionUser | null {
  const row = findSessionWithUser(db, sessionId, nowMs());
  return row ? toSessionUser(row) : null;
}

/** 删除会话。session 不存在时静默成功。 */
export function destroySession(db: DB, sessionId: string): void {
  deleteSession(db, sessionId);
}

/** 清理过期会话，返回删除行数。登录时顺带调用。 */
export function purgeExpiredSessions(db: DB, nowMs: number): number {
  // 形参名沿用契约；此处遮蔽同名时钟函数是刻意的：清理只认调用方给的时刻，不读系统时钟
  return deleteExpired(db, nowMs);
}

/** 装配身份的单一出口：时区缺省在此补齐，其余字段一律来自库。 */
function toSessionUser(row: UserWithTenantRow): SessionUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    timezone: row.timezone ?? DEFAULT_TIMEZONE,
  };
}
