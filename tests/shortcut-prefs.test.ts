/**
 * 单字符快捷键偏好（A3 / WCAG 2.1.4）。
 *
 * 解析只认显式 'off'：这一条与口令开关的方向相反，写反了会让第一次使用的人
 * 以为快捷键坏了，而且没有任何界面提示。用例把「默认开启」与「脏值回落」钉住。
 */
import { describe, expect, it } from 'vitest';
import { parseSingleKeyShortcuts, serializeSingleKeyShortcuts } from '@/lib/shortcut-prefs';

describe('单字符快捷键偏好', () => {
  it('没存过（null）默认开启', () => {
    expect(parseSingleKeyShortcuts(null)).toBe(true);
  });

  it('显式存了 off 才关闭', () => {
    expect(parseSingleKeyShortcuts('off')).toBe(false);
  });

  it('on 与无法识别的脏值都回落到开启', () => {
    expect(parseSingleKeyShortcuts('on')).toBe(true);
    expect(parseSingleKeyShortcuts('0')).toBe(true);
    expect(parseSingleKeyShortcuts('')).toBe(true);
  });

  it('序列化只有 on / off 两个值', () => {
    expect([serializeSingleKeyShortcuts(true), serializeSingleKeyShortcuts(false)]).toEqual([
      'on',
      'off',
    ]);
  });

  it('序列化与解析互为逆运算', () => {
    for (const enabled of [true, false]) {
      expect(parseSingleKeyShortcuts(serializeSingleKeyShortcuts(enabled))).toBe(enabled);
    }
  });
});
