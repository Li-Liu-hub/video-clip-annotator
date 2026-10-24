/**
 * 快捷键的纯判定：焦点是否在可输入元素内、入/出点归一、页脚键位文案。
 *
 * 只做判定，不绑定事件、不读播放器 —— 绑在 useShortcuts，可单测的部分全在这里。
 */
import { MIN_SEGMENT_MS } from '@/lib/interval';

/** 这些元素里按键是打字，不是快捷键。 */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * 焦点在可输入元素里时不处理全局快捷键。
 *
 * 不用 `target instanceof HTMLElement`：用例跑在 node 环境（vitest environment: 'node'），
 * 没有 HTMLElement 构造器，`instanceof` 会让这条判定连用例都写不出来。
 * 改成读 tagName / isContentEditable 两个属性 —— target 只可能是元素或 window / document，
 * 后两者没有 tagName，落不进 TYPING_TAGS，结论与 instanceof 版一致。
 *
 * isContentEditable 不能漏：富文本编辑器里 tagName 是 DIV，只判标签名会放行整组快捷键。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const element = target as EventTarget & { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === 'string' && TYPING_TAGS.has(element.tagName.toUpperCase());
}

/**
 * 把入点与出点归一成合法区间（min/max）。
 *
 * 取 min/max 而非报错：拖回播放头再按 O 是常见动作，提示「出点不能早于入点」
 * 只会让用户多点一次。两者都存在但长度不足 MIN_SEGMENT_MS 时返回 null ——
 * 阈值只有 interval.ts 一份，调用方不再自己写一遍下限。
 */
export function normalizeMarkRange(
  markInMs: number,
  markOutMs: number,
): { startMs: number; endMs: number } | null {
  const startMs = Math.min(markInMs, markOutMs);
  const endMs = Math.max(markInMs, markOutMs);
  // 用 < 而非 <=：恰好等于下限是合格的，边界只许有一处解释
  return endMs - startMs < MIN_SEGMENT_MS ? null : { startMs, endMs };
}

/**
 * 页脚展示的键位提示。抽成常量而不是散在 JSX 里：
 * 文案是用户可见的约定，用例锁住它，改键位时不会漏改提示。
 */
export const SHORTCUT_HINTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: 'Space', label: '播放 / 暂停' },
  { keys: 'I / O', label: '设入点 / 出点建片段' },
  { keys: 'Delete', label: '删除选中片段' },
  { keys: '← →', label: '播放头 1s（Shift 100ms）' },
  { keys: 'Esc', label: '取消拖拽 / 清除入点' },
];

/** 把一条提示拼成可读文本，页脚用它渲染整行，避免键位与说明两处各写一遍。 */
export function formatShortcutHint(hint: { keys: string; label: string }): string {
  return `${hint.keys} ${hint.label}`;
}
