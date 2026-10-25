/**
 * 登录失败计数：同一 IP + 同一用户名在 60 秒内失败 5 次后拒绝，直到窗口结束。
 *
 * 位置按 O1 契约放在 lib/server（不放 lib/services）：它不 import next/*、
 * 不碰数据库，只认 key 与时间戳，因此能在内存里单独测。
 *
 * 拒绝必须便宜：路由层先问 isLocked 再决定是否校验凭据，
 * 被锁时**不跑 scrypt** —— 否则限流只挡住了猜中的结果，没挡住 CPU 开销。
 *
 * 内存实现的四条限制（知道边界才能判断它够不够）：
 * 1. 进程重启即清空。可接受：这是防爆破的临时闸门，不是审计；真正的失败留痕在 audit_logs。
 * 2. 多实例不共享。部署多个副本时每个进程各算一份，限流近似失效；本项目是单实例。
 * 3. Map 随 key 增长。每次记失败顺带惰性清理过期桶，键数越过阈值时全表扫一遍。
 * 4. 不按 IP 单独计数。内网共用一个出口 IP 时，一个人输错五次会锁住整个办公室；
 *    只按「IP + 用户名」组合，牺牲一点防护面换取不误伤。
 */

/** 窗口内允许的失败次数；到第 6 次请求即拒绝。单位：次 */
export const MAX_FAILURES = 5;
/** 计数窗口长度。单位：毫秒 */
export const WINDOW_MS = 60_000;
/** 拿不到 IP 时的占位：仍按用户名分桶，不会退化成全局计数 */
const NO_IP = 'unknown';
/** 桶数越过它先清理过期项。取 512：单实例下正常登录的并发量远低于此，清理成本可忽略 */
const SWEEP_THRESHOLD = 512;

type Bucket = { failures: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** 计数的唯一 key 形态。用户名统一小写，避免 Alice / alice 各占一个桶绕过上限。 */
export function throttleKey(ip: string | null, username: string): string {
  return `${ip ?? NO_IP}:${username.toLowerCase()}`;
}

/**
 * 是否应直接拒绝这次尝试。
 *
 * 顺手删掉已过期的桶：读路径是唯一高频入口，把清理放这里，
 * 就不需要定时器，也不会让「过期但没人再试」的 key 一直占着内存。
 */
export function isLocked(key: string, nowMs: number): boolean {
  const bucket = buckets.get(key);
  if (!bucket) return false;
  if (nowMs >= bucket.resetAt) {
    buckets.delete(key);
    return false;
  }
  return bucket.failures >= MAX_FAILURES;
}

/** 记一次失败。窗口已过则开新窗口从 1 数起。 */
export function noteFailure(key: string, nowMs: number): void {
  const bucket = buckets.get(key);
  if (!bucket || nowMs >= bucket.resetAt) {
    buckets.set(key, { failures: 1, resetAt: nowMs + WINDOW_MS });
  } else {
    bucket.failures += 1;
  }

  if (buckets.size > SWEEP_THRESHOLD) sweep(nowMs);
}

/** 成功登录后清零：此前错了 4 次，成功一次之后再错仍从 1 数起。 */
export function clearFailures(key: string): void {
  buckets.delete(key);
}

function sweep(nowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (nowMs >= bucket.resetAt) buckets.delete(key);
  }
}

/** 仅供测试：清空全部桶。生产代码不得调用。 */
export function resetThrottle(): void {
  buckets.clear();
}
