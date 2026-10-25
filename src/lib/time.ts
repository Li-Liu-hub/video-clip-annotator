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

/** 今天（按给定时区）的日期文本 */
export function todayIn(timeZone: string): string {
  return localDateOf(Date.now(), timeZone);
}

/**
 * 毫秒 → `YYYY-MM-DD HH:mm:ss`，按给定时区。
 *
 * 审计要精确到秒：同一分钟内可以有多条记录，只显示日期就分不出先后与「谁先谁后」。
 */
export function formatDateTime(utcMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23 而非 h12：午夜若给成 24 点，拼出来的时间戳无法参与下一次解析
    hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));

  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

/**
 * 某一时刻在指定时区相对 UTC 的偏移（毫秒，东八区为 +8 小时）。
 *
 * 用「把墙钟时间当作 UTC 再相减」求偏移，而不是查时区表：
 * 时区规则（含夏令时）只有 Intl 里的那份是最新的。
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const wallMs = Date.parse(`${formatDateTime(utcMs, timeZone).replace(' ', 'T')}Z`);
  // 墙钟精度到秒，被减数也抹到秒，否则偏移里会混进毫秒余数
  return wallMs - Math.floor(utcMs / 1000) * 1000;
}

/**
 * 时区里某一天 00:00:00 对应的 UTC 毫秒。
 *
 * 筛选用的是「自然日」，库里存的是 UTC 毫秒，边界必须先在时区上落准再比较 ——
 * 直接用 UTC 零点会让东八区用户的「今天」缺掉最早 8 小时。
 * 偏移取两次：夏令时切换那天一天内有两个偏移，用第一次的结果定位后再取一次才落得准。
 */
export function dayStartMs(date: string, timeZone: string): number {
  const naiveUtc = Date.parse(`${date}T00:00:00Z`);
  const firstGuess = naiveUtc - zoneOffsetMs(naiveUtc, timeZone);
  return naiveUtc - zoneOffsetMs(firstGuess, timeZone);
}

/** 一天的毫秒数。只用于「从某天的零点推到下一天」，不用于跨时区的区间长度计算。 */
const DAY_MS = 86_400_000;

/**
 * 时区里某一天 23:59:59.999 对应的 UTC 毫秒（闭区间的右端）。
 *
 * 先落到下一天的零点再减 1，而不是「零点 + 24 小时 - 1」：
 * 夏令时切换那天只有 23 或 25 小时，加固定毫秒会少算或多算一小时。
 */
export function dayEndMs(date: string, timeZone: string): number {
  const nextDate = localDateOf(dayStartMs(date, timeZone) + DAY_MS, timeZone);
  return dayStartMs(nextDate, timeZone) - 1;
}


