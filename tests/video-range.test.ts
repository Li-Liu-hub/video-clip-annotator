/**
 * HTTP Range 头解析的用例。
 *
 * parseRange 是纯函数，播放路由的 206 / 416 全部由它的返回值决定，
 * 因此这里是「拖动进度条能否工作」唯一可自动验证的部分。
 */
import { describe, expect, it } from 'vitest';
import { parseRange } from '@/lib/video-range';

const SIZE = 1000;

describe('无 Range 或无法解析', () => {
  it('没有 Range 头时返回整个文件', () => {
    expect(parseRange(null, SIZE)).toEqual({ kind: 'full' });
  });

  it('空字符串 Range 头按完整文件返回', () => {
    expect(parseRange('', SIZE)).toEqual({ kind: 'full' });
  });

  it('范围不是数字时按完整文件返回', () => {
    expect(parseRange('bytes=abc', SIZE)).toEqual({ kind: 'full' });
  });

  it('多段 Range 按完整文件返回（浏览器播视频不会发多段）', () => {
    expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'full' });
  });

  it('非 bytes 单位按完整文件返回', () => {
    expect(parseRange('items=0-99', SIZE)).toEqual({ kind: 'full' });
  });

  it('缺少数字的 bytes=- 按完整文件返回', () => {
    expect(parseRange('bytes=-', SIZE)).toEqual({ kind: 'full' });
  });

  it('末尾小于起点属于非法 spec，按完整文件返回', () => {
    // RFC 9110：非法 ranges-specifier 必须忽略。回 416 会让视频完全不能播
    expect(parseRange('bytes=99-0', SIZE)).toEqual({ kind: 'full' });
  });
});

describe('闭区间起止', () => {
  it('bytes=0-99 返回 start=0 end=99', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ kind: 'partial', start: 0, end: 99 });
  });

  it('bytes=100- 省略末尾表示到文件尾', () => {
    expect(parseRange('bytes=100-', SIZE)).toEqual({ kind: 'partial', start: 100, end: 999 });
  });

  it('bytes=0- 覆盖整个文件仍是 partial', () => {
    expect(parseRange('bytes=0-', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });
});

describe('末尾越界钳位', () => {
  it('bytes=0-99999 的 end 钳到 size-1 而不是报 416', () => {
    expect(parseRange('bytes=0-99999', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('end 恰好等于 size-1 时原样返回', () => {
    expect(parseRange('bytes=0-999', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });
});

describe('后缀形式', () => {
  it('bytes=-500 表示最后 500 字节', () => {
    expect(parseRange('bytes=-500', SIZE)).toEqual({ kind: 'partial', start: 500, end: 999 });
  });

  it('后缀长度超过文件大小时从 0 开始', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('后缀长度为 0 时不可满足', () => {
    expect(parseRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('起点越界', () => {
  it('start 等于文件大小时不可满足', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('start 大于文件大小时不可满足', () => {
    expect(parseRange('bytes=5000-5100', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('空文件上的显式范围不可满足', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('语法非法优先于越界', () => {
  it('末尾小于起点时即使起点越过文件尾也按完整返回', () => {
    // 若先判 start >= size，这个小文件上的畸形头会变成 416，向客户端谎报文件长度
    expect(parseRange('bytes=5-3', 3)).toEqual({ kind: 'full' });
  });

  it('bytes=0-0 只返回第一个字节', () => {
    expect(parseRange('bytes=0-0', SIZE)).toEqual({ kind: 'partial', start: 0, end: 0 });
  });

  it('bytes=999- 返回最后一字节', () => {
    expect(parseRange('bytes=999-', SIZE)).toEqual({ kind: 'partial', start: 999, end: 999 });
  });

  it('后缀长度恰好等于文件大小时覆盖整包，但仍算 partial', () => {
    expect(parseRange('bytes=-1000', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });
});
