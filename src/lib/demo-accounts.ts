/**
 * 演示账号的唯一来源。
 *
 * 登录页的「一键进入」按这里的口令登录，`scripts/seed.mjs` 的演示模式必须给同一组
 * 账号设同一组口令 —— 两处曾各改一半：seed 把 admin 并成 demo123、登录页仍发
 * admin123，按钮点下去必然 401，而当时 828 例全绿。
 *
 * `tests/seed-demo.test.ts` 逐条拿这里的数据去登录演示库，把两端钉在一起。
 * 新增/改名演示账号时，先改这里，再改 seed 的显示名。
 *
 * 注意：本模块只被登录页与测试引用。默认构建（`NEXT_PUBLIC_DEMO_LOGIN` 未开）里
 * 登录页那处引用会被判成死代码，整份数据随之摇掉 —— 这是安全属性，改动后必须重验
 * `grep -rl "admin123" .next/static` 无输出。
 */
export const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', name: '平台管理员', note: '跨租户 · 发布与统计' },
  { username: 'alice', password: 'demo123', name: '林小雨', note: '标注员 · 独立租户' },
  { username: 'bob', password: 'demo123', name: '陈默', note: '标注员 · 独立租户' },
  { username: 'carol', password: 'demo123', name: '周予安', note: '标注员 · 独立租户' },
] as const;
