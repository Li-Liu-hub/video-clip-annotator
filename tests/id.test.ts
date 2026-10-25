/**
 * newId 的形态：16 位小写十六进制，且每次不同。
 *
 * 之前 6 处各写一遍 randomBytes(8)，谁写成 4 字节都不会有编译错误 ——
 * 这两条断言把「字节数」钉在用例里，改小一位就会变红。
 */
import { describe, expect, it } from 'vitest';
import { newId } from '@/lib/db/id';

describe('newId', () => {
  it('生成 16 位十六进制', () => {
    expect(newId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('连续 1000 次不重复', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });
});
