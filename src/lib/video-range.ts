/**
 * HTTP Range 头解析，纯函数零依赖。
 *
 * 只回答「该回哪一段字节」，不碰文件与响应头 —— 206/416 的拼装留给路由层。
 * 只支持单段：浏览器播 <video> 只会发单段请求，多段要拼 multipart/byteranges，
 * 收益为零而实现复杂度翻倍，故按完整文件处理。
 */

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * 单个 bytes 范围：`bytes=<起点>-<末尾>`，两者都可省略其一。
 * 用整串匹配而非 split：多段（含逗号）、其他单位、带空格的畸形头都会落空，
 * 直接归入「无法解析 → 返回完整文件」，不必为每种畸形各写一条分支。
 */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/i;

/**
 * 解析 `Range` 头，返回闭区间字节下标。
 *
 * 末尾越界钳到 size-1 而非回 416：客户端常按估算长度请求 `bytes=0-`，
 * 若判为越界，视频会完全不能播 —— 钳位是 RFC 9110 允许且播放器普遍依赖的行为。
 */
export function parseRange(header: string | null, size: number): RangeResult {
  if (header === null) return { kind: 'full' };

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) return { kind: 'full' };

  const [, startText, endText] = match;
  // `bytes=-` 两侧都空，没有任何有效范围可解，按无法解析处理
  if (startText === '' && endText === '') return { kind: 'full' };

  if (startText === '') {
    // 后缀形式：bytes=-500 表示最后 500 字节
    const suffixLength = Number(endText);
    // 长度为 0 表示「最后 0 字节」，没有可返回的内容
    if (suffixLength === 0) return { kind: 'unsatisfiable' };

    // 后缀比文件还长时从 0 开始，同样是钳位而非 416；空文件时 start 仍 >= size，落入不可满足
    const start = Math.max(0, size - suffixLength);
    if (start >= size) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start, end: size - 1 };
  }

  const start = Number(startText);
  const rawEnd = endText === '' ? null : Number(endText);

  // 语法非法优先于越界判定：`bytes=5-3` 的末尾小于起点，是畸形头，
  // 按 RFC 9110 应忽略整个 Range 头返回完整文件，而不是 416。
  // 若先判 start >= size，小文件上这个畸形头会变成 416，向客户端谎报文件长度。
  if (rawEnd !== null && rawEnd < start) return { kind: 'full' };

  if (start >= size) return { kind: 'unsatisfiable' };

  // 省略末尾 = 到文件尾；末尾越界钳到 size-1 而不是 416
  const end = rawEnd === null ? size - 1 : Math.min(rawEnd, size - 1);

  return { kind: 'partial', start, end };
}
