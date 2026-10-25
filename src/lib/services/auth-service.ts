/**
 * 身份体系的唯一实现：密码哈希、凭据校验、会话签发与解析、身份装配、角色判定、改密。
 *
 * 不 import next/headers —— 读 cookie 放在 lib/server/current-user，
 * 本层才能在内存库上单测。
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { nowMs, writeTx, type DB } from '@/lib/db';
import {
  findById,
  findByUsername,
  findWithTenantById,
  updatePasswordHash,
  type UserWithTenantRow,
} from '@/lib/db/repos/user-repo';
import {
  deleteExpired,
  deleteOtherSessionsOfUser,
  deleteSession,
  findSession,
  findSessionWithUser,
  insertSession,
} from '@/lib/db/repos/session-repo';
import { AUDIT_ACTIONS, AUTH_PASSWORD_CHANGED_ACTION } from '@/lib/audit-actions';
import { UnauthorizedError, ValidationError } from '@/lib/errors';
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

/** 改密的最短长度。与登录不共用常量：登录不限长度（老口令可能更短），只在设置新口令时要求。 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * scrypt 的异步版：计算落在 libuv 线程池里，不占事件循环。
 *
 * 同步版每次约 66ms，20 个并发登录就是 1.3 秒内全站不可用 ——
 * 一个未认证接口能当 DoS 开关用，这才是必须换掉的真实原因。
 *
 * 标注返回类型是必须的：scrypt 有多个重载，promisify 对它只能推出 unknown。
 */
const deriveAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** 派生密钥的唯一异步入口。集中在这里，将来换参数只改一处。 */
async function deriveKey(plain: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return deriveAsync(plain, salt, keylen);
}

/**
 * 登录失败的三种原因，只写进审计，不进响应 —— 对外三种共用上面那一句文案。
 *
 * 分开记是因为行为模式不同：撞库会有大量 no_such_user，记错密码集中在少数几个 bad_password。
 * inactive 指凭据正确但账号不可用（见 isUsableIdentity）。
 */
export type LoginFailureReason = 'bad_password' | 'no_such_user' | 'inactive';

/** 请求上下文由路由层采集后注入：service 层不得 import next/headers。 */
export type AuditContext = { ip?: string | null; userAgent?: string | null };

function formatHash(salt: Buffer, derived: Buffer): string {
  return `${PASSWORD_SCHEME}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * 同步哈希只服务三个不经过请求的调用方：测试夹具、scripts/seed.mjs、以及下面的占位哈希。
 * 请求路径一律走异步版 —— 在请求线程里跑 scryptSync 正是 O1 要修的问题之一。
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  return formatHash(salt, scryptSync(plain, salt, KEY_BYTES));
}

/** 异步哈希：改密时算新口令的存储值。 */
async function hashPasswordAsync(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  return formatHash(salt, await deriveKey(plain, salt, KEY_BYTES));
}

/**
 * 长度与字符集都先校验：畸形串（空 salt、非十六进制）交给 scrypt 会抛 RangeError，
 * 登录接口就从 401 变成 500。
 */
function isHexBytes(text: string, bytes: number): boolean {
  return text.length === bytes * 2 && /^[0-9a-f]+$/i.test(text);
}

/**
 * 恒定时间比较。格式不合法一律返回 false，不抛错。
 *
 * 异步只换了计算方式，比较逻辑一字未改：先校验格式再比长度，
 * 长度不等时 timingSafeEqual 会抛 RangeError。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3) return false;

  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== PASSWORD_SCHEME) return false;
  if (!isHexBytes(saltHex, SALT_BYTES) || !isHexBytes(hashHex, KEY_BYTES)) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = await deriveKey(plain, Buffer.from(saltHex, 'hex'), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * 用户不存在时用来跑一次等价开销的哈希。
 *
 * 若查不到用户就直接抛错，响应时间会是「存在」的 1/2000，
 * 攻击者据此可批量枚举用户名——「同一句文案」的防护就白做了。
 * 延迟初始化：避免模块加载时白付一次 scrypt。
 * 这里保留同步版：一个进程只算一次，摊到请求上可忽略；换成异步会让 authenticate 多一个 await 分支。
 */
let dummyHash: string | null = null;
function getDummyHash(): string {
  if (!dummyHash) dummyHash = hashPassword('__no_such_user__');
  return dummyHash;
}

/** 校验凭据并返回身份。失败统一抛 UnauthorizedError，不区分「用户不存在」与「密码错」。 */
export async function authenticate(
  db: DB,
  username: string,
  password: string,
  context: AuditContext = {},
): Promise<SessionUser> {
  const credential = findByUsername(db, username);

  // 无论用户是否存在都跑一次 scrypt，消除时间侧信道
  const passwordOk = await verifyPassword(password, credential?.password_hash ?? getDummyHash());

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
    context: AuditContext;
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
export async function loginWithFreshSession(
  db: DB,
  username: string,
  password: string,
  staleSessionId?: string,
  context: AuditContext = {},
): Promise<{ user: SessionUser; sessionId: string }> {
  const user = await authenticate(db, username, password, context);

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

export type PasswordChangeInput = { currentPassword: string; newPassword: string };

/**
 * 改密。成功后销毁该用户除当前会话外的所有会话。
 *
 * 旧密码错与登录失败抛同一个错误（同一句文案）：
 * 区分「旧密码错」与「账号不存在」等于给了半个用户名枚举器。
 *
 * 为什么多一个 currentSessionId：契约的四个入参里没有「当前是哪条会话」，
 * 而「保留当前会话」必须知道它。做成可选而非必选，是为了让四个参数的调用形式仍然成立；
 * 缺省时没有可保留的对象，按「销毁全部会话」处理（安全侧默认）。
 *
 * 为什么整段放进 writeTx：改密要同时改哈希、踢掉旧会话、留审计。
 * 「口令已换但旧会话还活着」和「换了口令但没留痕」都不该发生，所以三件事要么全成要么全不成。
 */
export async function changePassword(
  db: DB,
  actor: SessionUser,
  input: PasswordChangeInput,
  context: AuditContext,
  currentSessionId?: string,
): Promise<void> {
  // 先校验新口令的形状：不合格就不必付一次 scrypt。只要求长度，不要求大小写数字符号 ——
  // 复杂度规则的实际效果是让人在末尾加个 1!，长度才是唯一有意义的门槛。
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (input.newPassword === input.currentPassword) {
    throw new ValidationError('新密码不能与当前密码相同');
  }

  // 账号按会话身份回表取，不按用户名重新查：actor 已由会话证明，用户名只用于审计。
  // 取不到（并发删号）时仍跑一次等价开销的校验，与登录同一套防时序侧信道的逻辑。
  const credential = findById(db, actor.id);
  const currentOk = await verifyPassword(
    input.currentPassword,
    credential?.password_hash ?? getDummyHash(),
  );
  if (!credential || !currentOk) throw new UnauthorizedError(CREDENTIAL_MESSAGE);

  const passwordHash = await hashPasswordAsync(input.newPassword);

  writeTx(db, (tx) => {
    updatePasswordHash(tx, actor.id, passwordHash);
    // currentSessionId 缺省时传空串：sessions.id 是 48 位十六进制，空串匹配不到任何一行
    deleteOtherSessionsOfUser(tx, actor.id, currentSessionId ?? '');
    // detail 只放 username：口令、新旧哈希一概不进审计表，它会被导出、会被贴进工单
    writeAudit(
      tx,
      {
        actorId: actor.id,
        actorRole: actor.role,
        tenantId: actor.tenantId,
        action: AUTH_PASSWORD_CHANGED_ACTION,
        detail: { username: actor.username },
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      { strict: true },
    );
  });
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
