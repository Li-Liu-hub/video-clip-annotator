/**
 * 审计列表的展示回落。
 *
 * 「谁」这一列是本页最容易做错的地方：登录失败的行 actorId 是 NULL，
 * 直接显示「未知」就把唯一的线索（detail.username）丢了。
 * 被爆破时，那串用户名正是唯一能追的东西。
 */
import { describe, expect, it } from 'vitest';
import { actorLabelOf, detailPreviewOf, targetLabelOf, UNKNOWN_ACTOR } from '@/lib/audit-display';

const row = (over: Partial<Parameters<typeof actorLabelOf>[0]>) => ({
  actorName: null,
  attemptedUsername: null,
  targetTitle: null,
  targetId: null,
  ...over,
});

describe('谁', () => {
  it('正常记录显示用户名', () => {
    expect(actorLabelOf(row({ actorName: '林知遥' }))).toBe('林知遥');
  });

  it('登录失败（用户不存在）回落到尝试的用户名，而不是「未知」', () => {
    // 这条是整页最容易漏的：actorId 为 NULL 时若显示「未知」，
    // 撞库记录就彻底失去调查价值
    expect(actorLabelOf(row({ attemptedUsername: 'nobody' }))).toBe('nobody');
  });

  it('两者都没有才显示未知用户', () => {
    expect(actorLabelOf(row({}))).toBe(UNKNOWN_ACTOR);
  });
});

describe('对象', () => {
  it('join 得到标题就显示标题', () => {
    expect(targetLabelOf(row({ targetTitle: '城市道路早高峰' }))).toBe('城市道路早高峰');
  });

  it('join 不到就退回 id 前 8 位', () => {
    expect(targetLabelOf(row({ targetId: 'a100000000000001' }))).toBe('a1000000');
  });

  it('两者都没有显示占位符', () => {
    expect(targetLabelOf(row({}))).toBe('—');
  });
});

describe('详情摘要', () => {
  it('短文本原样返回', () => {
    expect(detailPreviewOf('短', null)).toBe('短');
  });

  it('超过 60 字截断并加省略号', () => {
    const long = 'x'.repeat(80);
    expect(detailPreviewOf(long, null)).toBe(`${'x'.repeat(60)}…`);
  });

  it('有解析结果时优先用键值拼接', () => {
    expect(detailPreviewOf('原始串', [{ key: 'reason', value: 'bad_password' }])).toBe(
      'reason: bad_password',
    );
  });
});
