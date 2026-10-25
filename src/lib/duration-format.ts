/**
 * 工作量的展示时长：按人话进位，不出现小数小时。
 *
 * `5700` → `5.7s`，`90000` → `1分30秒`，`3900000` → `1小时5分`。
 * 账本的精度是毫秒，但「1.5 小时」要人自己换算 —— 展示时进位到人直接能读的单位。
 *
 * 与 lib/time 的 formatDuration / formatHours 并存而不合并：那两个是媒体时间轴坐标
 * （m:ss.t、HH:MM:SS），改它们的格式会连带改坏播放器与时间轴。这里是工作量读数。
 */

const MS_PER_TENTH = 100;
const TENTHS_PER_SECOND = 10;
const TENTHS_PER_MINUTE = 600;
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;

/**
 * 毫秒 → 人话时长。负数保留符号：净额被冲正压到 0 是常态，万一出现负值也不能假装成正的。
 *
 * 一小时以上只到「分」：秒在工作量口径下是噪声，写成「1小时5分30秒」反而难读。
 */
export function formatHumanDuration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);

  // 不足一分钟先按十分之一秒取整：5.7s 这种精度在片段时长上有意义。
  // 用十分之一秒的整数比较（600），避免 59.96s 四舍五入成「60.0s」这种不存在的写法。
  const tenths = Math.round(abs / MS_PER_TENTH);
  if (tenths < TENTHS_PER_MINUTE) {
    return `${sign}${(tenths / TENTHS_PER_SECOND).toFixed(1)}s`;
  }

  const totalSeconds = Math.round(abs / MS_PER_SECOND);
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;

  if (hours > 0) return `${sign}${hours}小时${minutes > 0 ? `${minutes}分` : ''}`;
  return `${sign}${minutes}分${seconds > 0 ? `${seconds}秒` : ''}`;
}
