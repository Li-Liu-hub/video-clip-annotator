/**
 * mp4 时长解析：真样本 + 构造边界。
 *
 * 两个真样本覆盖了两种容器布局（moov 在前 / 在尾），
 * 构造样本覆盖真素材凑不出的分支（版本 1、timescale 0、截断位置、64 位长度）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMp4Duration } from '@/lib/mp4-duration';
import { box, buildMp4, moovBox, mvhdBox, placeholderBox } from './support/mp4-fixture';

const FIXTURE_DIR = path.join(process.cwd(), 'fixtures', 'videos');

/** 直接按负载造 mvhd：需要非法版本号时才能这么绕过 fixture 的缺省值 */
function mvhdRaw(payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write('mvhd', 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function fixtureBytes(name: string): Uint8Array {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

describe('真样本', () => {
  it('aloha-coffee.mp4（moov 在前）读出 30 秒', () => {
    const result = readMp4Duration(fixtureBytes('aloha-coffee.mp4'));
    expect(result.ok && Math.abs(result.durationMs - 30_000) <= 50).toBe(true);
  });

  it('pusht-pushblock.mp4（moov 在 6.7MB 处）也读得出真时长', () => {
    // 只读前 64KB 的实现在这里必红：moov 在第 6735984 字节
    expect(readMp4Duration(fixtureBytes('pusht-pushblock.mp4'))).toEqual({
      ok: true,
      durationMs: 2_565_000,
    });
  });
});

describe('非 mp4 与损坏字节', () => {
  it('任意文本字节返回 no-moov', () => {
    expect(readMp4Duration(Buffer.from('this-is-not-an-mp4-file'))).toEqual({
      ok: false,
      reason: 'no-moov',
    });
  });

  it('空字节返回 no-moov', () => {
    expect(readMp4Duration(Buffer.alloc(0))).toEqual({ ok: false, reason: 'no-moov' });
  });

  it('结构完整但没有 moov 返回 no-moov', () => {
    const bytes = Buffer.concat([placeholderBox('ftyp', 24), placeholderBox('mdat', 32)]);
    expect(readMp4Duration(bytes)).toEqual({ ok: false, reason: 'no-moov' });
  });

  it('在 moov 内部被切断返回 truncated 且不抛', () => {
    // 取真样本前 4KB：ftyp 完整，moov 声明 18806 字节却只剩不到一千
    const bytes = fixtureBytes('aloha-coffee.mp4').slice(0, 4_096);
    expect(readMp4Duration(bytes)).toEqual({ ok: false, reason: 'truncated' });
  });

  it('尾部只剩几个字节读不出头返回 truncated', () => {
    const bytes = Buffer.concat([placeholderBox('ftyp', 24), Buffer.from([0, 0, 0])]);
    expect(readMp4Duration(bytes)).toEqual({ ok: false, reason: 'truncated' });
  });

  it('moov 里没有 mvhd 返回 bad-mvhd', () => {
    expect(readMp4Duration(Buffer.concat([placeholderBox('ftyp', 24), moovBox()]))).toEqual({
      ok: false,
      reason: 'bad-mvhd',
    });
  });

  it('timescale 为 0 返回 bad-mvhd 而不是算出 Infinity', () => {
    const moov = moovBox([mvhdBox({ timescale: 0, duration: 30_000 })]);
    expect(readMp4Duration(Buffer.concat([placeholderBox('ftyp', 24), moov]))).toEqual({
      ok: false,
      reason: 'bad-mvhd',
    });
  });

  it('duration 为 0 返回 zero-duration', () => {
    const moov = moovBox([mvhdBox({ timescale: 1000, duration: 0 })]);
    expect(readMp4Duration(Buffer.concat([placeholderBox('ftyp', 24), moov]))).toEqual({
      ok: false,
      reason: 'zero-duration',
    });
  });

  it('v0 的 duration 全 1（时长未知）按 zero-duration 处理', () => {
    const moov = moovBox([mvhdBox({ timescale: 1000, duration: 0xffff_ffff })]);
    expect(readMp4Duration(Buffer.concat([placeholderBox('ftyp', 24), moov]))).toEqual({
      ok: false,
      reason: 'zero-duration',
    });
  });

  it('未知的 mvhd 版本返回 bad-mvhd', () => {
    // 版本 2 以上没有定义，解析器只能拒绝：猜字段布局会算出毫无意义的时长
    const payload = Buffer.alloc(100);
    payload.writeUInt8(7, 0);
    payload.writeUInt32BE(1000, 12);
    payload.writeUInt32BE(30_000, 16);
    const bytes = Buffer.concat([placeholderBox('ftyp', 24), moovBox([mvhdRaw(payload)])]);
    expect(readMp4Duration(bytes)).toEqual({ ok: false, reason: 'bad-mvhd' });
  });
});

describe('时长换算', () => {
  it('v1 的 64 位 duration 能读出', () => {
    const bytes = buildMp4({ durationMs: 90_000, version: 1 });
    expect(readMp4Duration(bytes)).toEqual({ ok: true, durationMs: 90_000 });
  });

  it('90000 timescale 的不足一毫秒取整为最近的毫秒', () => {
    // 2000 / 90000 秒 = 22.22ms
    const bytes = buildMp4({ durationMs: 22, timescale: 90_000 });
    expect(readMp4Duration(bytes)).toEqual({ ok: true, durationMs: 22 });
  });

  it('moov 在尾部（mdat 在前）同样读得出', () => {
    const bytes = buildMp4({ durationMs: 42_000, moovAtEnd: true, mdatBytes: 128 * 1024 });
    expect(readMp4Duration(bytes)).toEqual({ ok: true, durationMs: 42_000 });
  });

  it('64 位长度字段的 mdat 能被整个跳过', () => {
    const bytes = buildMp4({ durationMs: 12_000, moovAtEnd: true, largeMdat: true });
    expect(readMp4Duration(bytes)).toEqual({ ok: true, durationMs: 12_000 });
  });

  it('mdat 里的假 moov 是数据，不能抢在真 moov 前被当成时长', () => {
    const decoy = moovBox([mvhdBox({ timescale: 1000, duration: 999_000 })]);
    const real = moovBox([mvhdBox({ timescale: 1000, duration: 42_000 })]);
    const bytes = Buffer.concat([placeholderBox('ftyp', 24), box('mdat', decoy), real]);

    // 全文搜 "moov" 的实现会命中诱饵并返回 999 秒；走 box 链才会跳过整个 mdat
    expect(readMp4Duration(bytes)).toEqual({ ok: true, durationMs: 42_000 });
  });

  it('64 位 box 长度小于扩展头时拒绝，不让游标停在原地', () => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(0n, 8);

    expect(readMp4Duration(header)).toEqual({ ok: false, reason: 'no-moov' });
  });

  it('扩展头的 mvhd 也能按正确偏移读出时长', () => {
    const mvhd = mvhdBox({ timescale: 1000, duration: 30_000 });
    const largeHeader = Buffer.alloc(16);
    largeHeader.writeUInt32BE(1, 0);
    largeHeader.write('mvhd', 4, 'latin1');
    largeHeader.writeBigUInt64BE(BigInt(mvhd.length + 8), 8);
    const largeMvhd = Buffer.concat([largeHeader, mvhd.subarray(8)]);
    const bytes = Buffer.concat([placeholderBox('ftyp', 24), moovBox([largeMvhd])]);

    expect(readMp4Duration(bytes)).toEqual({ ok: true, durationMs: 30_000 });
  });

  it('解析层不设时长上限：5 小时的时长照样读得出（上限在 service）', () => {
    const bytes = buildMp4({ durationMs: 5 * 60 * 60 * 1000 });
    expect(readMp4Duration(bytes)).toEqual({ ok: true, durationMs: 18_000_000 });
  });
});
