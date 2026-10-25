#!/usr/bin/env node
/**
 * 浏览器层门禁：每个脚本一套「独立种子库 + 独立服务」。
 *
 * 为什么不用同一个库跑三个脚本：它们都假设「alice 的已领取任务里有 1 段」，
 * 上一个脚本留下的拖拽/删除会污染下一个。共用库时第一遍能过、第二遍必挂，
 * 那种门禁比没有更糟。
 *
 * 依赖：
 *   - 已 npm run build（.next/BUILD_ID 存在）
 *   - Python 3 + playwright（pip install playwright && playwright install chromium）
 *     PYTHON 环境变量可指定解释器；默认依次试 python / python3 / py
 *
 * 用法：npm run test:browser
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.BROWSER_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = process.env.SHOT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vsap-shots-'));
const SCRIPTS = (process.env.BROWSER_SCRIPTS ?? 'browser-check.py,browser-polish.py,browser-a11y.py')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
  console.error('[browser] 找不到 .next/BUILD_ID，先跑 npm run build');
  process.exit(1);
}

/** 找一个能 import playwright 的解释器；装没装比版本更重要。 */
function findPython() {
  const candidates = [process.env.PYTHON, 'python', 'python3', 'py'].filter(Boolean);
  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ['-c', 'import playwright'], {
      encoding: 'utf8',
      env: process.env,
    });
    if (probe.status === 0) return cmd;
  }
  console.error('[browser] 找不到带 playwright 的 Python。');
  console.error('  安装：pip install playwright && python -m playwright install chromium');
  console.error('  或用 PYTHON=/path/to/python 指定解释器。');
  process.exit(1);
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/login`);
      if (res.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function freshDbPath() {
  const file = path.join(os.tmpdir(), `vsap-browser-${process.pid}-${Date.now()}.db`);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  return file;
}

function cleanupDb(file) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
}

async function runOne(python, script) {
  const dbPath = freshDbPath();
  const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.mjs'), '--reset'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_PATH: dbPath, DEMO_LOGIN: '1' },
    stdio: 'ignore',
  });
  if (seed.status !== 0) {
    console.error(`[browser] ${script}: 种子库创建失败`);
    cleanupDb(dbPath);
    return false;
  }

  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: dbPath },
      stdio: 'ignore',
    },
  );

  let ok = false;
  try {
    if (!(await waitForServer())) {
      console.error(`[browser] ${script}: 服务在 ${PORT} 端口没有起来`);
    } else {
      const result = spawnSync(python, [path.join(HERE, script)], {
        cwd: ROOT,
        env: {
          ...process.env,
          BASE_URL: BASE,
          DB_PATH: dbPath,
          SHOT_DIR,
        },
        stdio: 'inherit',
      });
      ok = result.status === 0;
    }
  } finally {
    stopServer(server);
    // 等端口释放，否则下一个脚本会撞上 TIME_WAIT / 旧进程
    await new Promise((resolve) => setTimeout(resolve, 500));
    cleanupDb(dbPath);
  }
  return ok;
}

const python = findPython();
let failed = 0;
for (const script of SCRIPTS) {
  console.log(`\n[browser] ── ${script} ──`);
  if (!(await runOne(python, script))) failed += 1;
}

console.log(`\n[browser] ${SCRIPTS.length - failed}/${SCRIPTS.length} 个脚本通过`);
console.log(`[browser] 截图目录：${SHOT_DIR}`);
process.exit(failed === 0 ? 0 : 1);
