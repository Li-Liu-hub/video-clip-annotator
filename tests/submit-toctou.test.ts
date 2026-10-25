/**
 * 提交的 TOCTOU：并发「删片段」与「提交」交错时，快照必须只含提交时刻仍存在的片段。
 *
 * 真并发而不是模拟：删除方在自己的线程、自己的连接里开真实写事务并持锁停留，
 * 主线程的提交会阻塞在这把锁上 —— 于是「提交读到哪一版片段」完全由事务边界决定。
 * 修复前，提交的片段列表在事务外读出，这段等待刚好给删除留出了落地窗口。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import { AppError } from '@/lib/errors';
import type { TenantUser } from '@/lib/services/auth-service';
import { submitTask } from '@/lib/services/submit-service';

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
const VIDEO_ID = 'ddddddddddddddd1';
const PASSWORD_HASH = 'scrypt$00$00';

const TASK_TWO = 'a000000000000001';
const TASK_ONE = 'a000000000000002';
const SEG_FIRST = 'c000000000000001';
const SEG_SECOND = 'c000000000000002';
const SEG_ONLY = 'c000000000000003';

/** 两段：4000ms 与 2500ms。删掉第二段后，快照金额必须只剩 4000。 */
const SEG_A = { startMs: 1_000, endMs: 5_000 };
const SEG_B = { startMs: 10_000, endMs: 12_500 };

/** 删除方持锁时长：远小于 busy_timeout（5000），又足够长到让主线程必然排在它后面 */
const HOLD_MS = 150;

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
let dbPath: string;
let workDir: string;

function seed(target: DB): void {
  const insertTenant = target.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_A, 'A 空间', 'Asia/Shanghai', 0);

  target
    .prepare(
      `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN_ID, null, 'admin', '平台管理员', PASSWORD_HASH, 'admin', 0);
  target
    .prepare(
      `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator', 0);

  target
    .prepare(
      `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
       VALUES (?, 'demo.mp4', 'demo.mp4', 1024, 60000, 'video/mp4', ?, 0)`,
    )
    .run(VIDEO_ID, ADMIN_ID);
}

function addClaimedTask(taskId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 'claimed', ?, 1, ?, 0)`,
  ).run(taskId, TENANT_A, VIDEO_ID, `任务 ${taskId.slice(-1)}`, ALICE_ID, ADMIN_ID);
}

function addSegment(id: string, taskId: string, segment: { startMs: number; endMs: number }): void {
  db.prepare(
    `INSERT INTO segments (id, task_id, tenant_id, start_ms, end_ms, label, created_at)
     VALUES (?, ?, ?, ?, ?, '说话人A', 0)`,
  ).run(id, taskId, TENANT_A, segment.startMs, segment.endMs);
}

type ConcurrentDelete = {
  /** 删除已在写事务内执行（尚未提交） */
  deleted: Promise<void>;
  /** 删除事务已提交，写锁释放 */
  committed: Promise<void>;
  stop: () => Promise<void>;
};

function waitForMessage(worker: Worker, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (message !== expected) return;
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
  });
}

function startConcurrentDelete(segmentId: string): ConcurrentDelete {
  const worker = new Worker(new URL('./support/concurrent-delete.mjs', import.meta.url), {
    workerData: { dbPath, segmentId, holdMs: HOLD_MS },
    // 主进程的 execArgv 带的是 vitest 自己的 node 选项，继承给这个纯 JS worker 只会添乱
    execArgv: [],
  });

  return {
    deleted: waitForMessage(worker, 'deleted'),
    committed: waitForMessage(worker, 'committed'),
    stop: () => worker.terminate().then(() => undefined),
  };
}

function countSegments(taskId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM segments WHERE task_id = ?').get(taskId) as {
    n: number;
  };
  return row.n;
}

function countRows(table: 'submissions' | 'ledger_entries'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function snapshotOf(taskId: string): { total_ms: number; segment_count: number } {
  return db
    .prepare('SELECT total_ms, segment_count FROM submissions WHERE task_id = ?')
    .get(taskId) as { total_ms: number; segment_count: number };
}

function statusOf(taskId: string): string {
  return (db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string })
    .status;
}

function capture(fn: () => unknown): string {
  try {
    fn();
    return 'none';
  } catch (err) {
    return err instanceof AppError ? err.name : err instanceof Error ? err.name : 'non-error';
  }
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'vsap-toctou-'));
  dbPath = path.join(workDir, 'app.db');
  db = createDb(dbPath);
  seed(db);

  addClaimedTask(TASK_TWO);
  addSegment(SEG_FIRST, TASK_TWO, SEG_A);
  addSegment(SEG_SECOND, TASK_TWO, SEG_B);
  addClaimedTask(TASK_ONE);
  addSegment(SEG_ONLY, TASK_ONE, SEG_A);
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('并发删片段与提交', () => {
  it('并发删片段后，快照的段数等于片段表剩余的段数', async () => {
    const deleter = startConcurrentDelete(SEG_SECOND);
    await deleter.deleted;

    const result = submitTask(db, ALICE, TASK_TWO);
    await deleter.committed;
    await deleter.stop();

    expect([result.segmentCount, countSegments(TASK_TWO), snapshotOf(TASK_TWO).segment_count]).toEqual([
      1, 1, 1,
    ]);
  });

  it('并发删片段后，快照与账本的金额只剩剩下的那一段', async () => {
    const deleter = startConcurrentDelete(SEG_SECOND);
    await deleter.deleted;

    submitTask(db, ALICE, TASK_TWO);
    await deleter.committed;
    await deleter.stop();

    const ledger = db
      .prepare('SELECT delta_ms FROM ledger_entries WHERE task_id = ?')
      .get(TASK_TWO) as { delta_ms: number };
    const remaining = SEG_A.endMs - SEG_A.startMs;
    expect([snapshotOf(TASK_TWO).total_ms, ledger.delta_ms]).toEqual([remaining, remaining]);
  });

  it('并发删掉唯一片段后提交抛 409，且什么都没写', async () => {
    const deleter = startConcurrentDelete(SEG_ONLY);
    await deleter.deleted;

    const failure = capture(() => submitTask(db, ALICE, TASK_ONE));
    await deleter.committed;
    await deleter.stop();

    expect([failure, countRows('submissions'), countRows('ledger_entries'), statusOf(TASK_ONE)]).toEqual([
      'StateConflictError',
      0,
      0,
      'claimed',
    ]);
  });
});
