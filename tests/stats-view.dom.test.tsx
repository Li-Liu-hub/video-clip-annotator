// @vitest-environment jsdom
/** R1 统计原生表单契约：action 必须包含部署 basePath。 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('统计日期表单', () => {
  it('子路径部署时提交到带前缀的统计地址', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/vsap');
    const { default: StatsView } = await import('@/app/stats/StatsView');
    const { container } = render(
      <StatsView
        result={{ dimension: 'day', rows: [] }}
        range={{ from: '2026-10-20', to: '2026-10-26' }}
        today="2026-10-26"
        isAdmin={false}
        rangeAdjusted={false}
      />,
    );

    expect(container.querySelector('form')?.getAttribute('action')).toBe('/vsap/stats');
  });
});
