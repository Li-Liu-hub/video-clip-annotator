/**
 * 片段列表选中项的迁移规则。
 *
 * 纯函数零依赖：不读状态、不改入参、不发请求。
 *
 * 这两个判定抽出来的理由与 E4 那四条核心规则相同：它们写在 onClick / 回调里
 * 就没人守得住。「删除后选中去哪」和「替换后选中去哪」都是**判断**，
 * 而不是数组运算 —— 而判断恰恰是最容易被写错、且测试最容易漏掉的部分。
 * 想用 pickNextSelection 单独覆盖是不够的：它只回答「下一个是谁」，
 * 不回答「该不该迁移」。
 */

/** 只要求 id：本文件不引入 service 层类型，仓库里任何带 id 的片段都能用。 */
export type SelectableSegment = { id: string };

/**
 * 删除 removedId 之后的选中项。
 *
 * 用删除前的下标去取 rest[index]：删除只影响被删项之后的下标，
 * 因此 rest[index] 正好是「原位置的下一个」。优先下一个而非上一个，
 * 是因为连续删除时视线停在原位置往下。
 */
export function pickNextSelection(
  segments: readonly SelectableSegment[],
  removedId: string,
): string | null {
  const index = segments.findIndex((segment) => segment.id === removedId);
  // 不在列表里就没有「原位置」可言：返回 null，不猜一个最近的项
  if (index < 0) return null;

  const rest = segments.filter((segment) => segment.id !== removedId);
  return rest[index]?.id ?? rest[index - 1]?.id ?? null;
}

/**
 * 保存成功后应选中谁。
 *
 * E4 的替换是「先删后插」，片段 id 会变。若被替换的正是当前选中项，
 * 选中必须跟到新 id —— 否则 selectedId 指向一个已不存在的行，
 * 列表与时间轴都不再高亮，用户会以为选中丢了。
 *
 * 新增（replacesId 为 null）不动选中：不影响用户当前正在看的那一段。
 */
export function selectionAfterSave(
  selectedId: string | null,
  replacesId: string | null,
  savedId: string,
): string | null {
  if (replacesId === null) return selectedId;
  return selectedId === replacesId ? savedId : selectedId;
}

/**
 * 删除成功后应选中谁。
 *
 * 关键在第一个分支：**删的不是选中项就什么都不做**。
 * 需求文档只写了「删除后选中迁移到下一项」，照字面无条件迁移的话，
 * 选中在第 1 行时删第 3 行，高亮会莫名跳到第 2 行。
 * 而文档给的三个验收用例（中间/末尾/唯一）全是「删选中项」，一条都抓不到这个错。
 */
export function selectionAfterDelete(
  selectedId: string | null,
  removedId: string,
  segments: readonly SelectableSegment[],
): string | null {
  if (selectedId !== removedId) return selectedId;
  return pickNextSelection(segments, removedId);
}
