/**
 * 身份体系的唯一实现：密码哈希、凭据校验、会话签发与解析、身份装配。
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
  findSessionWithUser,
  insertSession,
} from '@/lib/db/repos/session-repo';
import { UnauthorizedError } from '@/lib/errors';

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'annotator';
  tenantId: string | null; // 管理员为 null
  tenantName: string | null;
  timezone: string; // 来自 tenants.timezone，管理员为默认值
};

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
export function authenticate(db: DB, username: string, password: string): SessionUser {
  const credential = findByUsername(db, username);

  // 无论用户是否存在都跑一次 scrypt，消除时间侧信道
  const passwordOk = verifyPassword(password, credential?.password_hash ?? getDummyHash());

  // 两种失败必须是同一条分支：分叉就等于给攻击者一个枚举用户名的信号
  if (!credential || !passwordOk) {
    throw new UnauthorizedError(CREDENTIAL_MESSAGE);
  }

  // 身份字段单独再查一次：密码哈希不进入装配身份的那条链路
  const identity = findWithTenantById(db, credential.id);
  if (!identity) {
    // 校验与装配之间用户被删除，按登录失败处理，不暴露中间状态
    throw new UnauthorizedError(CREDENTIAL_MESSAGE);
  }

  // 登录是清理过期会话的天然时机，否则 sessions 表只增不减
  purgeExpiredSessions(db, nowMs());
  return toSessionUser(identity);
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
