/**
 * 三个门禁函数的判定矩阵。
 *
 * 合并前这三条规则分散在 segment-service（两份）、workbench-service、review-service（内联）里，
 * 改一处漏一处不会有编译错误。矩阵把「谁能过哪道门」一次性钉死：
 * 任何一处放宽（例如把 rejected 放进可读、把 submitted 判成可写）都会让某一行红。
 *
 * 用错误的 code 而不是错误类型做期望：名字与状态码由 errors.ts 统一决定，
 * 断言到 code 才能同时守住「没变成 403」与「没变成 400」。
 */
import { describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import { AppError } from '@/lib/errors';
import type { TenantUser } from '@/lib/services/auth-service';
import {
  requireOwnedTask,
  requireReadableTask,
  requireWritableTask,
} from '@/lib/services/segment-service';

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';
const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
/** 同租户同事：schema 的唯一索引不允许，本场景为验证 claimed_by 谓词而造 */
const ALICE_PEER_ID = '3333333333333333';
const BOB_ID = '4444444444444444';
const VIDEO_ID = 'ddddddddddddddd1';
const PASSWORD_HASH = 'scrypt$00$00';

const T_CLAIMED = 'a000000000000001';
const T_SUBMITTED = 'a000000000000002';
const T_REJECTED = 'a000000000000003';
const T_PENDING = 'a000000000000004';
const T_PEER = 'a000000000000005';
const T_OTHER_TENANT = 'b000000000000001';
const T_MISSING = 'a0000000000000ff';

const ALICE: TenantUser = {
  id: ALICE_ID,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: TENANT_A,
  tenantName: 'A 空间',
  timezone: 'Asia/Shanghai',
};

function seed(): DB {
  const db = createDb(':memory:');
  db.exec('DROP INDEX idx_one_annotator_per_tenant');

  const insertTenant = db.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_A, 'A 空间', 'Asia/Shanghai', 0);
  insertTenant.run(TENANT_B, 'B 空间', 'Asia/Shanghai', 0);

  const insertUser = db.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', PASSWORD_HASH, 'admin', 0);
  insertUser.run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(ALICE_PEER_ID, TENANT_A, 'alice_peer', '周予安', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(BOB_ID, TENANT_B, 'bob', '陈默', PASSWORD_HASH, 'annotator', 0);

  db.prepare(
    `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
     VALUES (?, 'demo.mp4', 'demo.mp4', 1024, 60000, 'video/mp4', ?, 0)`,
  ).run(VIDEO_ID, ADMIN_ID);

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, '任务', ?, ?, ?, ?, 0)`,
  );
  const add = (
    id: string,
    tenantId: string,
    status: 'pending' | 'claimed' | 'submitted' | 'rejected',
    claimedBy: string | null,
  ) => insertTask.run(id, tenantId, VIDEO_ID, status, claimedBy, claimedBy ? 1_000 : null, ADMIN_ID);

  add(T_CLAIMED, TENANT_A, 'claimed', ALICE_ID);
  add(T_SUBMITTED, TENANT_A, 'submitted', ALICE_ID);
  // 退回的行 claimed_by 不清空，正是「归属成立但状态不允许」的那一格
  add(T_REJECTED, TENANT_A, 'rejected', ALICE_ID);
  add(T_PENDING, TENANT_A, 'pending', null);
  add(T_PEER, TENANT_A, 'claimed', ALICE_PEER_ID);
  add(T_OTHER_TENANT, TENANT_B, 'claimed', BOB_ID);

  return db;
}

type Gate = (db: DB, actor: TenantUser, taskId: string) => unknown;

/** 把「过 / 404 / 409」压成一个可比较的值；非 AppError 一律记为 unexpected */
function outcomeOf(gate: Gate, db: DB, taskId: string): string {
  try {
    gate(db, ALICE, taskId);
    return 'ok';
  } catch (err) {
    return err instanceof AppError ? err.code : 'unexpected';
  }
}

describe('三个门禁函数的判定矩阵', () => {
  it('归属、可读、可写三道门对七种任务形态的判定与预期一致', () => {
    const db = seed();

    const actual = [
      T_CLAIMED,
      T_SUBMITTED,
      T_REJECTED,
      T_PENDING,
      T_PEER,
      T_OTHER_TENANT,
      T_MISSING,
    ].map((taskId) => [
      taskId,
      outcomeOf(requireOwnedTask, db, taskId),
      outcomeOf(requireReadableTask, db, taskId),
      outcomeOf(requireWritableTask, db, taskId),
    ]);

    const NOT_FOUND = 'NOT_FOUND';
    const CONFLICT = 'STATE_CONFLICT';
    expect(actual).toEqual([
      // 本人 claimed：三道门全过
      [T_CLAIMED, 'ok', 'ok', 'ok'],
      // 本人 submitted：可读（只读回顾），不可写
      [T_SUBMITTED, 'ok', 'ok', CONFLICT],
      // 本人 rejected：归属成立，但读按不存在处理、写按状态冲突处理
      [T_REJECTED, 'ok', NOT_FOUND, CONFLICT],
      // pending 没有归属：三道门都按不存在处理，不泄露它还在池子里
      [T_PENDING, NOT_FOUND, NOT_FOUND, NOT_FOUND],
      // 同租户同事领取：归属不成立，一律 404 而不是 403
      [T_PEER, NOT_FOUND, NOT_FOUND, NOT_FOUND],
      // 其他租户
      [T_OTHER_TENANT, NOT_FOUND, NOT_FOUND, NOT_FOUND],
      // 不存在的 id
      [T_MISSING, NOT_FOUND, NOT_FOUND, NOT_FOUND],
    ]);

    db.close();
  });
});
