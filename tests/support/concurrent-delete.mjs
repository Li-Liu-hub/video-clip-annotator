/**
 * 并发删片段的协作线程：在真实写事务里删掉指定片段，持锁停留后再提交。
 *
 * 为什么用 worker：要复现的是「提交卡在写锁上、删除先落地」的真实交错，
 * 同线程里按顺序调用两次只能证明实现按我设想的顺序执行。
 *
 * 为什么这里写 SQL 而不调 deleteSegment：worker 加载不了 TS 服务层，
 * 而本用例要验的是事务边界（谁先拿到写锁），删除的业务规则由 segment 用例覆盖。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { dbPath, segmentId, holdMs } = workerData;

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec('BEGIN IMMEDIATE');
db.prepare('DELETE FROM segments WHERE id = ?').run(segmentId);
parentPort.postMessage('deleted');

// 持锁停留：主线程的提交会阻塞在这把锁上，于是「读片段」必然发生在删除之后
await delay(holdMs);
db.exec('COMMIT');
db.close();
parentPort.postMessage('committed');
