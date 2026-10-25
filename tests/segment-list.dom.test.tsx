// @vitest-environment jsdom
/**
 * SegmentList 的两条无障碍契约（G4 / G5）。
 *
 * 这两条都发生在「删除中 / 删除后」这种必须真渲染才有 DOM 的时刻：
 * 纯函数测不到 aria-busy，也测不到焦点落在谁身上。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SegmentList from '@/app/tasks/[id]/work/SegmentList';
import type { SegmentRow } from '@/lib/services/segment-service';

const FIRST: SegmentRow = { id: 'a000000000000001', startMs: 0, endMs: 1_000, label: null };
const SECOND: SegmentRow = { id: 'b000000000000002', startMs: 2_000, endMs: 3_000, label: null };

afterEach(cleanup);

describe('删除中的可读状态（G4）', () => {
  it('正在删除的行带 aria-busy，label 说明「哪一行在删」', () => {
    render(
      <SegmentList
        segments={[FIRST, SECOND]}
        selectedId={null}
        deletingId={FIRST.id}
        onSelect={() => {}}
        onDelete={() => {}}
        busy
      />,
    );

    const button = screen.getByRole('button', { name: '第 1 段删除中' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('删除中');
  });
});

describe('删除后的焦点续接（G5）', () => {
  it('焦点落到 focusRequest 指定的下一段', () => {
    render(
      <SegmentList
        segments={[FIRST, SECOND]}
        selectedId={null}
        deletingId={null}
        onSelect={() => {}}
        onDelete={() => {}}
        busy={false}
        focusRequest={{ targetId: SECOND.id, seq: 1 }}
      />,
    );

    const active = document.activeElement as HTMLElement;
    expect(active.tagName).toBe('BUTTON');
    expect(active.textContent).toContain('0:02');
  });

  it('列表空了就聚焦空态文本，不把焦点留在 body', () => {
    render(
      <SegmentList
        segments={[]}
        selectedId={null}
        deletingId={null}
        onSelect={() => {}}
        onDelete={() => {}}
        busy={false}
        focusRequest={{ targetId: null, seq: 2 }}
      />,
    );

    const active = document.activeElement as HTMLElement;
    expect(active.tagName).toBe('P');
    expect(active.getAttribute('tabindex')).toBe('-1');
    expect(active.textContent).toContain('还没有片段');
  });
});
