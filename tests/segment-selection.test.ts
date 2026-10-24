/** pickNextSelection 的契约用例：删除后选中迁移到哪一段。 */
import { describe, expect, it } from 'vitest';
import {
  pickNextSelection,
  selectionAfterDelete,
  selectionAfterSave,
} from '@/lib/segment-selection';

const FIRST = { id: 'aaaa000000000001' };
const SECOND = { id: 'aaaa000000000002' };
const THIRD = { id: 'aaaa000000000003' };

describe('pickNextSelection：删除后选中迁移', () => {
  it('删除中间一段时选中原位置的下一个', () => {
    expect(pickNextSelection([FIRST, SECOND, THIRD], SECOND.id)).toBe(THIRD.id);
  });

  it('删除最后一段时选中原位置的上一段', () => {
    expect(pickNextSelection([FIRST, SECOND, THIRD], THIRD.id)).toBe(SECOND.id);
  });

  it('删除唯一一段时无可迁移项，返回 null', () => {
    expect(pickNextSelection([FIRST], FIRST.id)).toBeNull();
  });

  it('removedId 不在列表里时返回 null', () => {
    expect(pickNextSelection([FIRST, SECOND], THIRD.id)).toBeNull();
  });
});

/**
 * 两个「该不该迁移」的判定。
 *
 * 这组用例的存在理由与 E4 那四条核心规则相同：判断写在组件里就没人守得住。
 * 尤其是「删的不是选中项时一动不动」—— 需求文档的三个验收用例
 * （删中间 / 删末尾 / 删唯一）全是「删选中项」，一条都抓不到这个错。
 */
describe('selectionAfterSave：替换后选中跟到新 id', () => {
  it('替换的正是选中项时，选中变为新 id', () => {
    expect(selectionAfterSave('old', 'old', 'fresh')).toBe('fresh');
  });

  it('替换的不是选中项时，选中保持不变', () => {
    expect(selectionAfterSave('mine', 'other', 'fresh')).toBe('mine');
  });

  it('纯新增时选中保持不变', () => {
    expect(selectionAfterSave('mine', null, 'fresh')).toBe('mine');
  });
});

describe('selectionAfterDelete：删除后选中的去向', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('删除选中的中间项时，选中落到原位置的下一个', () => {
    expect(selectionAfterDelete('b', 'b', rows)).toBe('c');
  });

  it('删除的不是选中项时，选中一动不动', () => {
    // 照字面「删除后迁移到下一项」写会得到 a→b，高亮莫名跳走
    expect(selectionAfterDelete('a', 'c', rows)).toBe('a');
  });

  it('删除的 id 不在列表里且不是选中项时，选中一动不动', () => {
    expect(selectionAfterDelete('a', 'ghost', rows)).toBe('a');
  });
});
