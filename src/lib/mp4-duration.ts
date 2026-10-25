/**
 * 从 mp4 字节里读真实时长：顺 box 链找 moov，读其中的 mvhd。
 *
 * 纯函数，不碰文件系统：上传校验与单测共用同一份实现，
 * 测试可以直接喂 fixtures 的字节，不必先造临时文件。
 */

export type Mp4DurationResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: 'no-moov' | 'bad-mvhd' | 'zero-duration' | 'truncated' };

/** box 头：4 字节长度 + 4 字节类型 */
const BOX_HEADER_BYTES = 8;
/** 长度字段为 1 时真长度写在头之后，头变 16 字节 */
const LARGE_BOX_HEADER_BYTES = 16;

/**
 * v0 的 mvhd 至少要 28 字节：头 8 + 版本标志 4 + 创建/修改时刻各 4 + timescale 4 + duration 4。
 * v1 把两个时刻与 duration 换成 64 位，共 40 字节。
 */
const MVHD_V0_BYTES = 28;
const MVHD_V1_BYTES = 40;

/** v0 的 timescale / duration 字段偏移（相对 mvhd 起点） */
const V0_TIMESCALE_OFFSET = 20;
const V0_DURATION_OFFSET = 24;
/** v1 的偏移：创建/修改时刻各 8 字节，于是 timescale 后移到 28、duration 到 32 */
const V1_TIMESCALE_OFFSET = 28;
const V1_DURATION_OFFSET = 32;

/** v0 的 duration 为 32 位全 1 表示「时长未知」（分片 mp4 常见），不可用于业务 */
const UNKNOWN_DURATION = 0xffff_ffff;

const MOOV = 'moov';
const MVHD = 'mvhd';

type BoxHeader = { type: string; size: number; headerBytes: number };

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/** 64 位长度转数字；超出 2^53 的只可能是构造出来的，返回 null 交给调用方判坏。 */
function readUint64(bytes: Uint8Array, offset: number): number | null {
  const high = readUint32(bytes, offset);
  const low = readUint32(bytes, offset + 4);
  if (high > 0x1f_ffff) return null;
  return high * 2 ** 32 + low;
}

function boxTypeAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

/**
 * 读一个 box 头。读不出来返回 null：调用方据此区分「这不是 mp4」与「mp4 被截断」。
 *
 * size 为 0 表示「延伸到文件尾」（只允许出现在最后一个 box），
 * 按剩余长度折算，否则游标会原地不动。
 */
function readBoxHeader(bytes: Uint8Array, offset: number): BoxHeader | null {
  if (offset + BOX_HEADER_BYTES > bytes.length) return null;

  const type = boxTypeAt(bytes, offset + 4);
  const size32 = readUint32(bytes, offset);

  if (size32 === 1) {
    if (offset + LARGE_BOX_HEADER_BYTES > bytes.length) return null;
    const size = readUint64(bytes, offset + 8);
    // 扩展头自身就占 16 字节；更小的声明长度会让游标倒退或原地不动
    if (size === null || size < LARGE_BOX_HEADER_BYTES) return null;
    return { type, size, headerBytes: LARGE_BOX_HEADER_BYTES };
  }

  if (size32 === 0) {
    return { type, size: bytes.length - offset, headerBytes: BOX_HEADER_BYTES };
  }

  // 小于头的长度字段无法解释，按坏头处理
  if (size32 < BOX_HEADER_BYTES) return null;
  return { type, size: size32, headerBytes: BOX_HEADER_BYTES };
}

/** 由 timescale / duration 算毫秒。四舍五入而非截断：30000.6ms 应报 30001。 */
function toDurationMs(timescale: number, duration: number): Mp4DurationResult {
  // timescale 为 0 会算出 Infinity，属坏 mvhd 而不是「时长为 0」
  if (timescale === 0) return { ok: false, reason: 'bad-mvhd' };
  if (duration <= 0) return { ok: false, reason: 'zero-duration' };

  const durationMs = Math.round((duration * 1000) / timescale);
  // 不足半毫秒的时长取整成 0，业务上等于没有时长
  if (durationMs <= 0) return { ok: false, reason: 'zero-duration' };
  return { ok: true, durationMs };
}

function readMvhd(bytes: Uint8Array, boxStart: number, header: BoxHeader): Mp4DurationResult {
  // 偏移常量按普通 8 字节头书写；扩展头多出的 8 字节统一后移
  const base = boxStart + header.headerBytes - BOX_HEADER_BYTES;
  const version = bytes[boxStart + header.headerBytes] ?? 0;

  if (version === 0) {
    if (header.size < MVHD_V0_BYTES + header.headerBytes - BOX_HEADER_BYTES) {
      return { ok: false, reason: 'bad-mvhd' };
    }
    const timescale = readUint32(bytes, base + V0_TIMESCALE_OFFSET);
    const rawDuration = readUint32(bytes, base + V0_DURATION_OFFSET);
    return toDurationMs(timescale, rawDuration === UNKNOWN_DURATION ? 0 : rawDuration);
  }

  if (version === 1) {
    if (header.size < MVHD_V1_BYTES + header.headerBytes - BOX_HEADER_BYTES) {
      return { ok: false, reason: 'bad-mvhd' };
    }
    const timescale = readUint32(bytes, base + V1_TIMESCALE_OFFSET);
    const duration = readUint64(bytes, base + V1_DURATION_OFFSET);
    if (duration === null) return { ok: false, reason: 'bad-mvhd' };
    return toDurationMs(timescale, duration);
  }

  // 版本 2 以上尚未定义，宁可拒绝也不猜字段布局
  return { ok: false, reason: 'bad-mvhd' };
}

/** moov 的直接子 box 里找 mvhd。moov 完整但没有 mvhd，说明容器本身坏了。 */
function readMoov(bytes: Uint8Array, from: number, end: number): Mp4DurationResult {
  let offset = from;
  while (offset + BOX_HEADER_BYTES <= end) {
    const header = readBoxHeader(bytes, offset);
    // 声明的长度越过 moov 边界：内部结构被截断
    if (header === null || offset + header.size > end) return { ok: false, reason: 'truncated' };
    if (header.type === MVHD) return readMvhd(bytes, offset, header);
    offset += header.size;
  }
  return { ok: false, reason: 'bad-mvhd' };
}

/**
 * 顺着顶层 box 链走到文件尾，遇到 moov 就解析。
 *
 * 必须走到底而不是只读前 N 字节：未开 faststart 的编码器把 moov 放在 mdat 之后，
 * fixtures/videos/pusht-pushblock.mp4 就是这种（moov 在 6.7MB 处）。
 *
 * 为什么用「此前是否成功解析过 box」区分 no-moov 与 truncated：
 * 首字节就不像 box 头的是别的文件格式（no-moov）；
 * 已经读出一个合法 box 之后中途越界，只可能是 mp4 没传完（truncated）。
 */
export function readMp4Duration(bytes: Uint8Array): Mp4DurationResult {
  let offset = 0;
  let sawValidBox = false;

  while (offset + BOX_HEADER_BYTES <= bytes.length) {
    const header = readBoxHeader(bytes, offset);
    if (header === null) {
      return { ok: false, reason: sawValidBox ? 'truncated' : 'no-moov' };
    }

    const boxEnd = offset + header.size;
    if (boxEnd > bytes.length) {
      return { ok: false, reason: sawValidBox ? 'truncated' : 'no-moov' };
    }

    if (header.type === MOOV) return readMoov(bytes, offset + header.headerBytes, boxEnd);

    sawValidBox = true;
    offset = boxEnd;
  }

  // 恰好停在文件尾：结构完整但没有 moov
  if (offset >= bytes.length) return { ok: false, reason: 'no-moov' };
  // 尾部剩 1~7 字节读不出头：已解析过 box，说明文件被截断
  return { ok: false, reason: sawValidBox ? 'truncated' : 'no-moov' };
}
