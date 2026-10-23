/**
 * 时间处理的唯一入口。
 *
 * 全库以 UTC 毫秒存储，但「有效时长计入哪一天」是业务概念，
 * 取决于租户所在时区。这个换算只在写入时做一次并固化成文本，
 * 绝不放在查询期计算 —— 否则时区规则或服务器时区一变，历史数字就会漂移。
 */

export function localDateOf(utcMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(utcMs));

  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** 毫秒 → 7:03.5 形式，用于播放器与时间轴显示 */
export function formatDuration(ms: number, withTenths = true): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((abs % 1000) / 100);

  const base = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return sign + (withTenths ? `${base}.${tenths}` : base);
}

/** 毫秒 → 01:23:45 形式，用于日汇总 */
export function formatHours(ms: number): string {
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  const sign = ms < 0 ? '-' : '';
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 今天（按给定时区）的日期文本 */
export function todayIn(timeZone: string): string {
  return localDateOf(Date.now(), timeZone);
}

/** 最近 n 天的日期数组，升序，按给定时区推算 */
export function recentDates(timeZone: string, days: number): string[] {
  const today = todayIn(timeZone);
  const base = new Date(`${today}T00:00:00Z`).getTime();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}
