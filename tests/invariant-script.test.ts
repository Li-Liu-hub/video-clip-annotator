/**
 * I2 检查器脚本的接线验收：验的不是规则，是「规则接到库上之后还活着」。
 *
 * 三件事各一条：
 *   - 干净库 → 退出码 0（检查器不会恒抛）
 *   - 脏库   → 退出码 1 且报出具体规则（检查器不会恒真）
 *   - --temp → 退出码 0（pretest 依赖这条路径，它必须不碰 data/app.db）
 *
 * 起子进程而不是 import：脚本的价值有一半在「退出码」和「真的能跑」，
 * 在进程内调 findViolations 测不到这两样。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '@/lib/db';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts', 'invariant-check.mjs');

const created: string[] = [];

function tempDbPath(tag: string): string {
  const file = path.join(os.tmpdir(), `invariant-${tag}-${process.pid}-${Date.now()}.db`);
  created.push(file);
  return file;
}

function run(args: string[], dbPath: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const file of created.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  }
});

describe('I2 不变量检查器脚本', () => {
  // 三条都起子进程，默认 5 秒上限在「全量并行 + 各自再 spawn node」时会顶破。
  // 放宽的是等待时间，断言一字未改。
  it('干净库上退出码为 0 并报告 0 项违反', { timeout: 20_000 }, () => {
    const file = tempDbPath('clean');
    createDb(file).close();

    const result = run([], file);
    expect([result.status, result.stdout.includes('0 项违反')]).toEqual([0, true]);
  });

  it('脏库上退出码为 1 并点名规则', { timeout: 20_000 }, () => {
    const file = tempDbPath('dirty');
    const db = createDb(file);
    db.prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)').run(
      'aaaaaaaaaaaaaaaa',
      'A 空间',
      'Asia/Shanghai',
      0,
    );
    db.prepare(
      `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
       VALUES ('1111111111111111', NULL, 'admin', '平台管理员', 'scrypt$00$00', 'admin', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
       VALUES ('ddddddddddddddd1', 'demo.mp4', 'demo.mp4', 1024, 60000, 'video/mp4', '1111111111111111', 0)`,
    ).run();
    // 故意造脏：submitted 却没有领取人。schema 的 CHECK 正防这个，故临时关掉约束
    db.pragma('ignore_check_constraints = ON');
    db.prepare(
      `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, created_by, created_at)
       VALUES ('a000000000000001', 'aaaaaaaaaaaaaaaa', 'ddddddddddddddd1', '任务', 'submitted', NULL, '1111111111111111', 0)`,
    ).run();
    db.pragma('ignore_check_constraints = OFF');
    db.close();

    const result = run([], file);
    expect([result.status, result.stdout.includes('[status-claimed-pair]')]).toEqual([1, true]);
  });

  // 这一条还要在一次性库里跑完整业务链路（含口令哈希），耗时最长
  it('--temp 在一次性库上跑完整链路后退出码为 0', { timeout: 20_000 }, () => {
    const result = run(['--temp'], tempDbPath('unused'));

    expect([result.status, result.stdout.includes('0 项违反')]).toEqual([0, true]);
  });
});
