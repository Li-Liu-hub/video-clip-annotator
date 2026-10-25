/**
 * 上传前预检的用例。
 *
 * 预检决定「哪些文件根本不发请求」，是唯一能在 node 环境验证的上传逻辑；
 * readDurationMs 与 uploadVideo 依赖浏览器 API，留给手工验收。
 */
import { describe, expect, it } from 'vitest';
import { checkFile } from '@/lib/video-upload';
import { MAX_VIDEO_BYTES } from '@/lib/video-limits';

describe('checkFile 拒绝不可上传的文件', () => {
  it('空文件返回 empty', () => {
    expect(checkFile({ size: 0, type: 'video/mp4' })).toEqual({ ok: false, reason: 'empty' });
  });

  it('超过上限一个字节返回 too-large', () => {
    expect(checkFile({ size: MAX_VIDEO_BYTES + 1, type: 'video/mp4' })).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('非 MP4 类型返回 bad-type', () => {
    expect(checkFile({ size: 1024, type: 'video/webm' })).toEqual({ ok: false, reason: 'bad-type' });
  });

  it('空 MIME 按 bad-type 处理，不靠扩展名猜内容', () => {
    expect(checkFile({ size: 1024, type: '' })).toEqual({ ok: false, reason: 'bad-type' });
  });
});

describe('checkFile 放行合法文件', () => {
  it('恰好等于上限的大小允许上传', () => {
    expect(checkFile({ size: MAX_VIDEO_BYTES, type: 'video/mp4' })).toEqual({ ok: true });
  });

  it('video/mp4 且大小正常时通过', () => {
    expect(checkFile({ size: 1024, type: 'video/mp4' })).toEqual({ ok: true });
  });
});
