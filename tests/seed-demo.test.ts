/**
 * 登录页「一键进入」与种子必须说同一套账号口令。
 *
 * 这条契约此前没有任何测试守着，于是 O1 把 seed 的 admin 口令改成与标注员共用的
 * demo123，而登录页仍发 admin123 —— 按钮点下去直接 401，828 例全绿。
 * 纯客户端行为测不到，但「登录页那张表能不能登进演示库」测得到。
 */
import { describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS } from '@/lib/demo-accounts';
import { createDb } from '@/lib/db';
import { authenticate } from '@/lib/services/auth-service';
import { seedDatabase } from '../scripts/seed.mjs';

describe('演示种子的口令', () => {
  it('登录页列出的每个演示账号都能登进演示库，显示名也对得上', async () => {
    const db = createDb(':memory:');
    seedDatabase(db, { demoLogin: true });

    for (const account of DEMO_ACCOUNTS) {
      const actor = await authenticate(db, account.username, account.password);
      // name 是登录页展示的名字，必须与 users.display_name 一致，否则页面在撒谎
      expect([account.username, actor.displayName, actor.role]).toEqual([
        account.username,
        account.name,
        account.username === 'admin' ? 'admin' : 'annotator',
      ]);
    }
    db.close();
  });

  it('四个演示账号覆盖 admin 与三位标注员', () => {
    expect(DEMO_ACCOUNTS.map((account) => account.username)).toEqual([
      'admin',
      'alice',
      'bob',
      'carol',
    ]);
  });

  it('admin 的演示口令不是标注员那个', async () => {
    const db = createDb(':memory:');
    seedDatabase(db, { demoLogin: true });

    // 若 seed 又把 admin 与标注员并成同一个口令，登录页的 admin123 会再次失效
    await expect(authenticate(db, 'admin', 'demo123')).rejects.toMatchObject({
      name: 'UnauthorizedError',
    });
    db.close();
  });

  it('默认模式四个账号共用一个随机口令，固定口令全部失效', async () => {
    const db = createDb(':memory:');
    const { sharedPassword } = seedDatabase(db, { demoLogin: false });
    // 默认模式必须给出一个可用的随机口令；为 null 说明种子又按演示模式处理了
    if (!sharedPassword) throw new Error('默认模式没有生成随机口令');

    const admin = await authenticate(db, 'admin', sharedPassword);
    const alice = await authenticate(db, 'alice', sharedPassword);
    expect([admin.role, alice.username]).toEqual(['admin', 'alice']);

    await expect(authenticate(db, 'admin', 'admin123')).rejects.toMatchObject({
      name: 'UnauthorizedError',
    });
    db.close();
  });
});
