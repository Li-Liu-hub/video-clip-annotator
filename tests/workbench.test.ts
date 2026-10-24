/**
 * 工作台入口的归属校验：只有「本租户 + 自己领取 + claimed 或 submitted」能取到 WorkTask。
 *
 * 其余四种（待领取 / 同事领取 / 其他租户 / 已退回）必须同为 NotFoundError ——
 * 分开断言而非合成一条，是为了让任何一种被改成 403 或成功返回时单独变红。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import type { TenantUser } from '@/lib/services/auth-service';
import { getWorkTask } from '@/lib/services/workbench-service';

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';
const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
/** 同租户同事：schema 的唯一索引不允许，本场景为验证 claimed_by 谓词而造 */
const ALICE_PEER_ID = '3333333333333333';
const BOB_ID = '4444444444444444';

const VIDEO_A = 'ddddddddddddddd1';
const VIDEO_B = 'ddddddddddddddd2';

const T_MINE = 'a000000000000001';
const T_PENDING = 'a000000000000002';
const T_PEER = 'a000000000000003';
const T_SUBMITTED = 'a000000000000004';
const T_REJECTED = 'a000000000000005';
const T_OTHER_TENANT = 'b000000000000001';

const VIDEO_A_MS = 60_000;
const TITLE = '装配线示教';
const DESCRIPTION = '把取件动作拆成片段';
const PASSWORD_HASH = 'scrypt$00$00';

const ALICE: TenantUser = {
  id: ALICE_ID,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: TENANT_A,
  tenantName: 'A 空间',
  timezone: 'Asia/Shanghai',
};

let db: DB;

function seed(): DB {
  const fresh = createDb(':memory:');

  // 移除「一个租户只有一个标注员」唯一索引：同租户同事是校验 claimed_by 的必要场景。
  // 工作台不能依赖「租户内只有我一个人」这个假设，否则该谓词形同虚设。
  fresh.exec('DROP INDEX idx_one_annotator_per_tenant');

  const insertTenant = fresh.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_A, 'A 空间', 'Asia/Shanghai', 0);
  insertTenant.run(TENANT_B, 'B 空间', 'Asia/Shanghai', 0);

  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', PASSWORD_HASH, 'admin', 0);
  insertUser.run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(ALICE_PEER_ID, TENANT_A, 'alice_peer', '周予安', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(BOB_ID, TENANT_B, 'bob', '陈默', PASSWORD_HASH, 'annotator', 0);

  const insertVideo = fresh.prepare(
    `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'video/mp4', ?, ?)`,
  );
  insertVideo.run(VIDEO_A, 'a-demo.mp4', `${VIDEO_A}.mp4`, 1024, VIDEO_A_MS, ADMIN_ID, 0);
  insertVideo.run(VIDEO_B, 'b-demo.mp4', `${VIDEO_B}.mp4`, 1024, VIDEO_A_MS, ADMIN_ID, 0);

  return fresh;
}

/** claimed_by 与 status 必须同步（schema 的 CHECK），pending 行单独传 null。 */
function addTask(
  id: string,
  tenantId: string,
  videoId: string,
  status: 'pending' | 'claimed' | 'submitted' | 'rejected',
  claimedBy: string | null,
): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, description, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    tenantId,
    videoId,
    TITLE,
    DESCRIPTION,
    status,
    claimedBy,
    claimedBy ? 1_000 : null,
    ADMIN_ID,
    1_000,
  );
}

function seedTasks(): void {
  addTask(T_MINE, TENANT_A, VIDEO_A, 'claimed', ALICE_ID);
  addTask(T_PENDING, TENANT_A, VIDEO_A, 'pending', null);
  addTask(T_PEER, TENANT_A, VIDEO_A, 'claimed', ALICE_PEER_ID);
  addTask(T_SUBMITTED, TENANT_A, VIDEO_A, 'submitted', ALICE_ID);
  // 退回的行 claimed_by 不清空（schema 要求非 pending 必须有归属），正是「看着是自己的、其实不是」
  addTask(T_REJECTED, TENANT_A, VIDEO_A, 'rejected', ALICE_ID);
  addTask(T_OTHER_TENANT, TENANT_B, VIDEO_B, 'claimed', BOB_ID);
}

beforeEach(() => {
  db = seed();
  seedTasks();
});

afterEach(() => {
  db.close();
});

describe('getWorkTask 归属校验', () => {
  it('自己领取的 claimed 任务返回契约里的工作台数据', () => {
    expect(getWorkTask(db, ALICE, T_MINE)).toMatchObject({
      id: T_MINE,
      title: TITLE,
      description: DESCRIPTION,
      status: 'claimed',
      durationMs: VIDEO_A_MS,
      videoFilename: 'a-demo.mp4',
    });
  });

  it('还没领取的 pending 任务抛 NotFoundError', () => {
    expect(() => getWorkTask(db, ALICE, T_PENDING)).toThrow(NotFoundError);
  });

  it('同租户同事领取的任务抛 NotFoundError', () => {
    expect(() => getWorkTask(db, ALICE, T_PEER)).toThrow(NotFoundError);
  });

  it('其他租户的任务抛 NotFoundError', () => {
    expect(() => getWorkTask(db, ALICE, T_OTHER_TENANT)).toThrow(NotFoundError);
  });

  it('已提交的 submitted 任务返回工作台数据，status 为 submitted（E8 只读回顾）', () => {
    // E3/E4 时期这里断言 NotFoundError：当时工作台只服务「还没提交」的标注。
    // E8 起已提交任务能打开，页面按 status 传 readOnly。需求变更，不是回归。
    expect(getWorkTask(db, ALICE, T_SUBMITTED)).toMatchObject({
      id: T_SUBMITTED,
      status: 'submitted',
    });
  });

  it('已退回的 rejected 任务抛 NotFoundError', () => {
    // 放行就等于让人打开一个已回到池子的任务，看到的是过期数据
    expect(() => getWorkTask(db, ALICE, T_REJECTED)).toThrow(NotFoundError);
  });

  it('streamUrl 指向视频流接口而非存储路径', () => {
    expect(getWorkTask(db, ALICE, T_MINE).streamUrl).toBe(`/api/videos/${VIDEO_A}/stream`);
  });
});
