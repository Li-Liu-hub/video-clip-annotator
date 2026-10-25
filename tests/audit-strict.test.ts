/**
 * 审计的严格模式在四个业务动作上真的生效。
 *
 * `writeAudit` 默认是旁路（吞错）。strict 是对这个默认的反向契约：
 * 漏传一处，没有编译错误、没有运行错误，只有「审计写不进去」时才暴露 ——
 * 而那种时刻正是最需要留痕的时刻。
 *
 * 早先只有 create / submit 有故障注入，把 claim / release / reject / reopen
 * 四处的 strict 全删掉，694 例仍然全绿。这个文件补上那四处。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import type { TenantUser } from '@/lib/services/auth-service';
import { claimTask, releaseTask } from '@/lib/services/task-service';
import { rejectTask, reopenTask } from '@/lib/services/review-service';

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const ALICE_ID = '2222222222222222';
const VIDEO_A = 'b000000000000001';
const PASSWORD_HASH = 'scrypt$1$1$1$00$00';

const ALICE: TenantUser = {
  id: ALICE_ID,
  tenantId: TENANT_A,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  timezone: 'Asia/Shanghai',
  tenantName: 'A 空间',
};

const T_PENDING = 'a000000000000001';
const T_CLAIMED = 'a000000000000002';
const T_SUBMITTED = 'a000000000000003';
const T_REJECTED = 'a000000000000004';

let db: DB;

/** 让审计表不可写：任何 insert 都中止整个事务 */
function blockAudit(): void {
  db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit blocked'); END",
  );
}

function statusOf(taskId: string): string {
  return (db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
}

function addTask(id: string, status: string, claimedBy: string | null): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, TENANT_A, VIDEO_A, `任务 ${id.slice(-1)}`, status, claimedBy, claimedBy ? 0 : null, ALICE_ID, 0);
}

beforeEach(() => {
  db = createDb(':memory:');
  db.prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)').run(
    TENANT_A,
    'A 空间',
    'Asia/Shanghai',
    0,
  );
  db.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator', 0);
  db.prepare(
    `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'video/mp4', ?, ?)`,
  ).run(VIDEO_A, 'a-demo.mp4', `${VIDEO_A}.mp4`, 1024, 60_000, ALICE_ID, 0);

  addTask(T_PENDING, 'pending', null);
  addTask(T_CLAIMED, 'claimed', ALICE_ID);
  addTask(T_SUBMITTED, 'submitted', ALICE_ID);
  addTask(T_REJECTED, 'rejected', ALICE_ID);
});

afterEach(() => {
  db.close();
});

describe('审计写失败时业务必须整体回滚', () => {
  it('领取：任务仍是 pending', () => {
    blockAudit();
    expect(() => claimTask(db, ALICE, T_PENDING)).toThrow();
    expect(statusOf(T_PENDING)).toBe('pending');
  });

  it('归还：任务仍是 claimed', () => {
    blockAudit();
    expect(() => releaseTask(db, ALICE, T_CLAIMED)).toThrow();
    expect(statusOf(T_CLAIMED)).toBe('claimed');
  });

  it('退回：任务仍是 submitted，且没有写进冲正', () => {
    blockAudit();
    expect(() => rejectTask(db, { ...ALICE, role: 'admin' } as never, T_SUBMITTED, '不合格')).toThrow();
    expect(statusOf(T_SUBMITTED)).toBe('submitted');
  });

  it('重新打开：任务仍是 rejected', () => {
    blockAudit();
    expect(() => reopenTask(db, ALICE, T_REJECTED)).toThrow();
    expect(statusOf(T_REJECTED)).toBe('rejected');
  });
});
