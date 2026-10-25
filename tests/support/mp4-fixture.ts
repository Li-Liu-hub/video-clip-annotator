/**
 * 造最小可解析的 mp4 字节：ftyp +（可选 mdat）+ moov(mvhd)。
 *
 * 用它而不是真视频：版本 0/1、timescale、moov 位置、64 位长度这些边界
 * 在真实素材里凑不齐，而它们正是解析器最容易出错的地方。
 */

const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
/** mvhd 的负载长度：v0 为 100、v1 为 112，与真实编码器写出的 108/120 字节 box 对齐 */
const MVHD_V0_PAYLOAD_BYTES = 100;
const MVHD_V1_PAYLOAD_BYTES = 112;

export function box(type: string, payload: Buffer, options: { largeSize?: boolean } = {}): Buffer {
  const header = Buffer.alloc(options.largeSize ? LARGE_BOX_HEADER_BYTES : BOX_HEADER_BYTES);
  const total = header.length + payload.length;
  if (options.largeSize) {
    header.writeUInt32BE(1, 0);
    header.write(type, 4, 'latin1');
    header.writeBigUInt64BE(BigInt(total), 8);
  } else {
    header.writeUInt32BE(total, 0);
    header.write(type, 4, 'latin1');
  }
  return Buffer.concat([header, payload]);
}

/** 空负载的占位 box：解析时要能被整个跳过 */
export function placeholderBox(type: string, bytes: number): Buffer {
  return box(type, Buffer.alloc(bytes));
}

function ftyp(): Buffer {
  return box(
    'ftyp',
    Buffer.concat([
      Buffer.from('isom', 'latin1'),
      Buffer.from([0, 0, 2, 0]),
      Buffer.from('isomiso2avc1mp41', 'latin1'),
    ]),
  );
}

export type MvhdOptions = { timescale: number; duration: number; version?: 0 | 1 };

export function mvhdBox({ timescale, duration, version = 0 }: MvhdOptions): Buffer {
  if (version === 1) {
    const payload = Buffer.alloc(MVHD_V1_PAYLOAD_BYTES);
    payload.writeUInt8(1, 0);
    // 偏移按规范：版本标志 4 + 创建 8 + 修改 8 → timescale 20、duration 24
    payload.writeUInt32BE(timescale, 20);
    payload.writeBigUInt64BE(BigInt(duration), 24);
    return box('mvhd', payload);
  }

  const payload = Buffer.alloc(MVHD_V0_PAYLOAD_BYTES);
  payload.writeUInt8(0, 0);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box('mvhd', payload);
}

/** moov 容器；children 省略时就是一个空 moov（用来测「有 moov 没有 mvhd」） */
export function moovBox(children: Buffer[] = []): Buffer {
  return box('moov', Buffer.concat(children));
}

export type Mp4Options = {
  /** 期望的时长（毫秒），内部按 timescale 折算成 mvhd 的 duration */
  durationMs: number;
  timescale?: number;
  version?: 0 | 1;
  /** true = moov 放在 mdat 之后（未开 faststart 的编码器就是这样） */
  moovAtEnd?: boolean;
  /** mdat 负载字节数，用来把 moov 推远 */
  mdatBytes?: number;
  /** mdat 用 64 位长度字段 */
  largeMdat?: boolean;
};

/** 造一个完整 mp4。默认 1000 timescale、moov 在前。 */
export function buildMp4({
  durationMs,
  timescale = 1000,
  version = 0,
  moovAtEnd = false,
  mdatBytes = 64,
  largeMdat = false,
}: Mp4Options): Buffer {
  const duration = Math.round((durationMs * timescale) / 1000);
  const moov = moovBox([mvhdBox({ timescale, duration, version })]);
  const mdat = box('mdat', Buffer.alloc(mdatBytes), { largeSize: largeMdat });

  return moovAtEnd ? Buffer.concat([ftyp(), mdat, moov]) : Buffer.concat([ftyp(), moov, mdat]);
}
