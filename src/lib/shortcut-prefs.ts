/**
 * 单字符快捷键偏好（WCAG 2.1.4）。
 *
 * I / O / 空格 是「只按一个字符就触发」的快捷键，无障碍规范要求至少满足一条：
 * 可关闭、可重映射、或只在获得焦点时生效。本项目的快捷键绑在 window 上
 * （标注时焦点不固定在某个容器），所以选「可关闭」。
 *
 * 解析只认显式的 'off'：null（没存过）与任何脏值都回落到「开启」。
 * 理由与口令开关相反 —— 这里默认关闭会让第一次使用的人以为快捷键坏了；
 * 脏值更可能是存储被清过，不该顺带改变行为。
 */
export const SINGLE_KEY_SHORTCUTS_STORAGE_KEY = 'vsap.single-key-shortcuts';

export function parseSingleKeyShortcuts(raw: string | null): boolean {
  return raw !== 'off';
}

export function serializeSingleKeyShortcuts(enabled: boolean): string {
  return enabled ? 'on' : 'off';
}
