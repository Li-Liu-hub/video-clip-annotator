/** 快捷键纯判定的契约用例：焦点归属、入/出点归一、页脚文案。 */
import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_HINTS,
  formatShortcutHint,
  isTypingTarget,
  normalizeMarkRange,
} from '@/lib/shortcuts';

/**
 * 只带判定会读的两个属性。真元素另有几十个成员，与「是不是输入目标」无关，
 * 而本项目的用例跑在 node 环境，没有 DOM 可造。
 */
function fakeTarget(tagName: string, isContentEditable = false): EventTarget {
  return { tagName, isContentEditable } as unknown as EventTarget;
}

describe('isTypingTarget：焦点在可输入元素里就不处理快捷键', () => {
  it('input 是输入目标', () => {
    expect(isTypingTarget(fakeTarget('INPUT'))).toBe(true);
  });

  it('textarea 是输入目标', () => {
    expect(isTypingTarget(fakeTarget('TEXTAREA'))).toBe(true);
  });

  it('select 是输入目标', () => {
    expect(isTypingTarget(fakeTarget('SELECT'))).toBe(true);
  });

  it('contenteditable 的 div 是输入目标（富文本里 tagName 就是 DIV）', () => {
    expect(isTypingTarget(fakeTarget('DIV', true))).toBe(true);
  });

  it('普通 div 不是输入目标', () => {
    expect(isTypingTarget(fakeTarget('DIV'))).toBe(false);
  });

  it('button 不是输入目标', () => {
    expect(isTypingTarget(fakeTarget('BUTTON'))).toBe(false);
  });

  it('body 不是输入目标', () => {
    expect(isTypingTarget(fakeTarget('BODY'))).toBe(false);
  });

  it('target 为 null 时不是输入目标（keydown 可能没有 target）', () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('normalizeMarkRange：入点与出点归一', () => {
  it('入早于出时原样返回', () => {
    expect(normalizeMarkRange(3000, 5000)).toEqual({ startMs: 3000, endMs: 5000 });
  });

  it('出早于入时归一成前小后大，而不是报错', () => {
    expect(normalizeMarkRange(5000, 3000)).toEqual({ startMs: 3000, endMs: 5000 });
  });

  it('长度恰好等于最小时必须放行（边界只有一处解释）', () => {
    expect(normalizeMarkRange(1000, 1100)).toEqual({ startMs: 1000, endMs: 1100 });
  });

  it('长度不足最小时返回 null，由调用方决定怎么提示', () => {
    expect(normalizeMarkRange(1000, 1050)).toBeNull();
  });

  it('零长区间返回 null（两端打在同一点）', () => {
    expect(normalizeMarkRange(2000, 2000)).toBeNull();
  });
});

describe('SHORTCUT_HINTS：页脚文案', () => {
  it('覆盖空格、I/O、Delete 三组键位，改键位时不会漏改提示', () => {
    expect(SHORTCUT_HINTS.map(formatShortcutHint)).toEqual([
      'Space 播放 / 暂停',
      'I / O 设入点 / 出点建片段',
      'Delete 删除选中片段',
      '← → 播放头 1s（Shift 100ms）',
      'Esc 取消拖拽 / 清除入点',
    ]);
  });
});
