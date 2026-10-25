/**
 * 视频服务用例：真实写盘、类型与大小校验、时长以服务端解析为准、跨租户可见性。
 *
 * 落盘目录指向 os.tmpdir()：要验证的是 .part → rename 的真实过程，
 * mock fs 就测不到「有没有残留半个文件」，而那正是此功能点最贵的坑。
 * 上传的字节必须是真的 mp4：时长改由服务端解析，随便几个字节再也进不了库。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import { AppError } from '@/lib/errors';
import type { SessionUser } from '@/lib/services/auth-service';
import {
  DURATION_TOLERANCE_MS,
  listVisibleVideos,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DURATION_MS,
  openVideoForRead,
  storeVideo,
  videoFilePath,
  type UploadInput,
} from '@/lib/services/video-service';
import { buildMp4 } from './support/mp4-fixture';

const TENANT_A = '1111111111111111';
const TENANT_B = '2222222222222222';
const ADMIN_ID = '3333333333333333';
const ALICE_ID = '4444444444444444';
const BOB_ID = '5555555555555555';
const TASK_A = '6666666666666666';
const TASK_B = '7777777777777777';
const PASSWORD_HASH = 'scrypt$00$00';
/** 40 秒的最小合法 mp4；服务端解析出来的时长就是 40000 */
const VALID_MP4 = buildMp4({ durationMs: 40_000 });
/** 5 小时：超过上传上限 */
const TOO_LONG_MP4 = buildMp4({ durationMs: 5 * 60 * 60 * 1000 });
/** 造不出时长：不是 mp4，解析应当失败而不是回落到声明值 */
const NOT_MP4 = Buffer.from('fake-mp4-bytes-for-test');
const ORIGINAL_VIDEO_DIR = process.env.VIDEO_DIR;

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  username: 'admin',
  displayName: '平台管理员',
  role: 'admin',
  tenantId: null,
  tenantName: null,
  timezone: 'Asia/Shanghai',
};

const ALICE: SessionUser = {
  id: ALICE_ID,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: TENANT_A,
  tenantName: 'A 空间',
  timezone: 'Asia/Shanghai',
};

const BOB: SessionUser = {
  id: BOB_ID,
  username: 'bob',
  displayName: '陈小舟',
  role: 'annotator',
  tenantId: TENANT_B,
  tenantName: 'B 空间',
  timezone: 'Asia/Shanghai',
};

let db: DB;
let videoDir: string;

function seed(): DB {
  const fresh = createDb(':memory:');
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
  insertUser.run(BOB_ID, TENANT_B, 'bob', '陈小舟', PASSWORD_HASH, 'annotator', 0);
  return fresh;
}

/** 造一个任务：视频的可见性完全由「哪个租户的任务引用了它」决定。 */
function linkTask(taskId: string, tenantId: string, videoId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, created_by, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, 0)`,
  ).run(taskId, tenantId, videoId, '示例任务', ADMIN_ID);
}

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function inputOf(bytes: Buffer = VALID_MP4, overrides: Partial<UploadInput> = {}): UploadInput {
  return {
    filename: 'demo.mp4',
    mimeType: 'video/mp4',
    sizeBytes: bytes.length,
    durationMs: 40_000,
    stream: streamOf(bytes),
    ...overrides,
  };
}

function describeFailure(err: unknown): { name: string; status: number } {
  if (err instanceof AppError) return { name: err.name, status: err.status };
  if (err instanceof Error) return { name: err.name, status: 0 };
  return { name: 'non-error', status: 0 };
}

/** 把抛出物压成可断言的字面量；未抛出返回 null。 */
function failure(fn: () => unknown): { name: string; status: number } | null {
  try {
    fn();
    return null;
  } catch (err) {
    return describeFailure(err);
  }
}

/** storeVideo 是 async，入参校验失败表现为 rejection 而不是同步抛出 */
async function rejection(promise: Promise<unknown>): Promise<{ name: string; status: number } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return describeFailure(err);
  }
}

function filesInVideoDir(): string[] {
  return readdirSync(videoDir).sort();
}

beforeEach(() => {
  db = seed();
  videoDir = mkdtempSync(path.join(tmpdir(), 'vsap-videos-'));
  process.env.VIDEO_DIR = videoDir;
});

afterEach(() => {
  db.close();
  rmSync(videoDir, { recursive: true, force: true });
  if (ORIGINAL_VIDEO_DIR === undefined) delete process.env.VIDEO_DIR;
  else process.env.VIDEO_DIR = ORIGINAL_VIDEO_DIR;
});

describe('storeVideo 落盘', () => {
  it('落盘内容与上传的字节完全一致', async () => {
    const video = await storeVideo(db, ADMIN, inputOf());
    expect(readFileSync(videoFilePath(video))).toEqual(VALID_MP4);
  });

  it('落盘文件名使用服务端生成的 id 而非用户给的 filename', async () => {
    const video = await storeVideo(db, ADMIN, inputOf(VALID_MP4, { filename: '../../.env' }));
    expect(path.basename(video.storage_path)).toBe(`${video.id}.mp4`);
  });

  it('用户给的 filename 只进数据库做展示', async () => {
    const video = await storeVideo(db, ADMIN, inputOf(VALID_MP4, { filename: '../../.env' }));
    expect(video.filename).toBe('../../.env');
  });

  it('上传成功后目录里没有 .part 残留', async () => {
    await storeVideo(db, ADMIN, inputOf());
    expect(filesInVideoDir().filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('库里记录的 size_bytes 等于实际字节数', async () => {
    const video = await storeVideo(db, ADMIN, inputOf());
    expect(video.size_bytes).toBe(VALID_MP4.length);
  });

  it('落库后的行可按 id 读回', async () => {
    const video = await storeVideo(db, ADMIN, inputOf());
    expect(openVideoForRead(db, ADMIN, video.id).filename).toBe('demo.mp4');
  });
});

describe('storeVideo 校验', () => {
  it('非 MP4 类型抛 ValidationError', async () => {
    const result = await rejection(
      storeVideo(db, ADMIN, inputOf(VALID_MP4, { mimeType: 'text/html' })),
    );
    expect(result).toEqual({ name: 'ValidationError', status: 400 });
  });

  it('声明大小超过上限抛 413', async () => {
    const result = await rejection(
      storeVideo(db, ADMIN, inputOf(VALID_MP4, { sizeBytes: MAX_VIDEO_BYTES + 1 })),
    );
    expect(result).toEqual({ name: 'PayloadTooLargeError', status: 413 });
  });

  it('时长为 0 抛 ValidationError', async () => {
    const result = await rejection(storeVideo(db, ADMIN, inputOf(VALID_MP4, { durationMs: 0 })));
    expect(result).toEqual({ name: 'ValidationError', status: 400 });
  });

  it('空请求体抛 ValidationError', async () => {
    const result = await rejection(storeVideo(db, ADMIN, inputOf(Buffer.alloc(0))));
    expect(result).toEqual({ name: 'ValidationError', status: 400 });
  });

  it('空请求体失败后目录里没有残留文件', async () => {
    await rejection(storeVideo(db, ADMIN, inputOf(Buffer.alloc(0))));
    expect(filesInVideoDir()).toEqual([]);
  });
});

describe('storeVideo 用服务端解析的时长', () => {
  it('声明值与解析值一致时入库，duration_ms 取服务端解析值', async () => {
    const video = await storeVideo(db, ADMIN, inputOf());
    expect(video.duration_ms).toBe(40_000);
  });

  it('声明值偏小但在容差内仍接受，入库的仍是服务端值', async () => {
    // 声明 38.5 秒、文件 40 秒：差 1.5 秒在 2 秒容差内，落库必须写 40 秒
    const video = await storeVideo(
      db,
      ADMIN,
      inputOf(VALID_MP4, { durationMs: 40_000 - DURATION_TOLERANCE_MS + 500 }),
    );
    expect(video.duration_ms).toBe(40_000);
  });

  it('声明值与解析值相差超过 2 秒时抛 ValidationError', async () => {
    const result = await rejection(
      storeVideo(db, ADMIN, inputOf(VALID_MP4, { durationMs: 40_000 + DURATION_TOLERANCE_MS + 1 })),
    );
    expect(result).toEqual({ name: 'ValidationError', status: 400 });
  });

  it('解析不出时长的字节不被接受，且不落库', async () => {
    const result = await rejection(storeVideo(db, ADMIN, inputOf(NOT_MP4)));
    expect([result, filesInVideoDir()]).toEqual([
      { name: 'ValidationError', status: 400 },
      [],
    ]);
  });

  it('时长超过 4 小时时抛 ValidationError', async () => {
    const result = await rejection(
      storeVideo(db, ADMIN, inputOf(TOO_LONG_MP4, { durationMs: MAX_VIDEO_DURATION_MS + 1 })),
    );
    expect(result).toEqual({ name: 'ValidationError', status: 400 });
  });

  it('超过上限的上传失败后目录里没有残留文件', async () => {
    await rejection(
      storeVideo(db, ADMIN, inputOf(TOO_LONG_MP4, { durationMs: MAX_VIDEO_DURATION_MS + 1 })),
    );
    expect(filesInVideoDir()).toEqual([]);
  });
});

describe('openVideoForRead 可见性', () => {
  it('管理员可读任意视频', async () => {
    const video = await storeVideo(db, ADMIN, inputOf());
    expect(openVideoForRead(db, ADMIN, video.id).id).toBe(video.id);
  });

  it('标注员可读本租户任务引用的视频', async () => {
    const video = await storeVideo(db, ADMIN, inputOf());
    linkTask(TASK_A, TENANT_A, video.id);
    expect(openVideoForRead(db, ALICE, video.id).id).toBe(video.id);
  });

  it('标注员读其他租户的视频抛 NotFoundError', async () => {
    const video = await storeVideo(db, ADMIN, inputOf());
    linkTask(TASK_B, TENANT_B, video.id);
    expect(failure(() => openVideoForRead(db, ALICE, video.id))).toEqual({
      name: 'NotFoundError',
      status: 404,
    });
  });

  it('不存在的 id 与无权限抛同一个 404（不泄露存在性）', () => {
    expect(failure(() => openVideoForRead(db, ALICE, 'deadbeefdeadbeef'))).toEqual({
      name: 'NotFoundError',
      status: 404,
    });
  });

  it('标注员的列表只含本租户任务引用的视频', async () => {
    const mine = await storeVideo(db, ADMIN, inputOf());
    const others = await storeVideo(db, ADMIN, inputOf());
    linkTask(TASK_A, TENANT_A, mine.id);
    linkTask(TASK_B, TENANT_B, others.id);
    expect(listVisibleVideos(db, ALICE).map((v) => v.id)).toEqual([mine.id]);
  });

  it('与本租户无关的视频不出现在列表里', async () => {
    const onlyForA = await storeVideo(db, ADMIN, inputOf());
    linkTask(TASK_A, TENANT_A, onlyForA.id);
    expect(listVisibleVideos(db, BOB)).toEqual([]);
  });

  it('管理员的列表包含全部视频', async () => {
    const first = await storeVideo(db, ADMIN, inputOf());
    const second = await storeVideo(db, ADMIN, inputOf());
    expect(listVisibleVideos(db, ADMIN).map((v) => v.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});
