/**
 * G2 CSV 导出：BOM、公式注入防护、转义、CRLF、空值与数字格式，以及导出路由。
 *
 * escapeCell 的每一条规则单独成例：合成一个大断言时，某个前缀被漏掉也照样全绿。
 * 路由用例断言完整响应体，因为「BOM 在、行列对不上」这类问题只有整份比对才看得见。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as exportGet } from '@/app/api/stats/export/route';
import { CSV_BOM, escapeCell, toCsv } from '@/lib/csv';
import { createDb, type DB } from '@/lib/db';
import { insertEntry } from '@/lib/db/repos/ledger-repo';
import { insertSubmission } from '@/lib/db/repos/submission-repo';
import { getCurrentUser } from '@/lib/server/current-user';
import type { SessionUser, TenantUser } from '@/lib/services/auth-service';

vi.mock('@/lib/server/current-user', () => ({ getCurrentUser: vi.fn() }));

/** 路由通过 getDb 取连接；测试把内存库从这里递进去 */
const HOLDER: { db: DB } = { db: null as unknown as DB };
vi.mock('@/lib/server/db', () => ({ getDb: () => HOLDER.db }));

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
/** 同租户同事：验证导出只含自己的行 */
const PEER_ID = '3333333333333333';

const VIDEO_A = 'ddddddddddddddd1';

const T_FORMULA = 'a500000000000001';
const T_PEER = 'a500000000000002';

const S_FORMULA = 'c500000000000001';
const S_PEER = 'c500000000000002';

const D_1001 = '2026-10-01';
const RANGE_QUERY = `from=${D_1001}&to=2026-10-31`;
/** 5700 毫秒刻意不是整秒：秒列必须给出 5.7，而不是四舍五入成 6 */
const OWN_MS = 5_700;
const PEER_MS = 4_000;

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

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  username: 'admin',
  displayName: '平台管理员',
  role: 'admin',
  tenantId: null,
  tenantName: null,
  timezone: 'Asia/Shanghai',
};

let db: DB;

/**
 * 一条标题为 `=1+1` 的账目（公式注入的活样本），外加同租户同事的一条。
 * 唯一索引与「同租户同事」场景互斥，故先移除。
 */
function seed(): DB {
  const fresh = createDb(':memory:');
  fresh.exec('DROP INDEX idx_one_annotator_per_tenant');

  fresh
    .prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
    .run(TENANT_A, 'A 空间', 'Asia/Shanghai', 0);

  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  );
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', PASSWORD_HASH, 'admin');
  insertUser.run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator');
  insertUser.run(PEER_ID, TENANT_A, 'peer', '周予安', PASSWORD_HASH, 'annotator');

  fresh
    .prepare(
      `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
       VALUES (?, 'a-demo.mp4', ?, 1024, 60000, 'video/mp4', ?, 0)`,
    )
    .run(VIDEO_A, `${VIDEO_A}.mp4`, ADMIN_ID);

  return fresh;
}

function addTask(id: string, title: string, claimedBy: string): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 'submitted', ?, 0, ?, 0)`,
  ).run(id, TENANT_A, VIDEO_A, title, claimedBy, ADMIN_ID);
}

function addSubmitChain(args: {
  submissionId: string;
  taskId: string;
  annotatorId: string;
  totalMs: number;
}): void {
  insertSubmission(db, {
    id: args.submissionId,
    taskId: args.taskId,
    tenantId: TENANT_A,
    annotatorId: args.annotatorId,
    submittedAt: 0,
    localDate: D_1001,
    totalMs: args.totalMs,
    segmentCount: 1,
    segmentsJson: '[]',
    createdAt: 0,
  });
  insertEntry(db, {
    id: `e${args.submissionId.slice(1)}`,
    tenantId: TENANT_A,
    taskId: args.taskId,
    submissionId: args.submissionId,
    annotatorId: args.annotatorId,
    deltaMs: args.totalMs,
    entryDate: D_1001,
    kind: 'submit',
    createdAt: 0,
  });
}

function seedLedger(): void {
  addTask(T_FORMULA, '=1+1', ALICE_ID);
  addTask(T_PEER, '任务乙', PEER_ID);
  addSubmitChain({ submissionId: S_FORMULA, taskId: T_FORMULA, annotatorId: ALICE_ID, totalMs: OWN_MS });
  addSubmitChain({ submissionId: S_PEER, taskId: T_PEER, annotatorId: PEER_ID, totalMs: PEER_MS });
}

/** 导出请求。dim 缺省为 task：任务视图能同时验证标题与两次计数列。 */
function request(query = `dim=task&${RANGE_QUERY}`): Request {
  return new Request(`http://localhost/api/stats/export?${query}`);
}

/** 去掉 BOM 后按 CRLF 切行；返回的首行是表头。 */
function linesOf(body: string): string[] {
  return body.replace(CSV_BOM, '').split('\r\n').filter((line) => line.length > 0);
}

beforeEach(() => {
  db = seed();
  HOLDER.db = db;
  seedLedger();
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('escapeCell', () => {
  it('普通文本原样输出', () => {
    expect(escapeCell('普通')).toBe('普通');
  });

  it('含逗号的字段整体加引号', () => {
    expect(escapeCell('含,逗号')).toBe('"含,逗号"');
  });

  it('字段内的引号翻倍', () => {
    expect(escapeCell('含"引号')).toBe('"含""引号"');
  });

  it('含换行的字段整体加引号，否则会把一行拆成两行', () => {
    expect(escapeCell('含\n换行')).toBe('"含\n换行"');
  });

  it('含回车的字段整体加引号', () => {
    expect(escapeCell('含\r回车')).toBe('"含\r回车"');
  });

  it('以等号开头的值加单引号前缀', () => {
    expect(escapeCell('=1+1')).toBe("'=1+1");
  });

  it('以加号开头的值加单引号前缀', () => {
    expect(escapeCell('+86')).toBe("'+86");
  });

  it('以减号开头的值加单引号前缀', () => {
    expect(escapeCell('-1')).toBe("'-1");
  });

  it('以 at 符号开头的值加单引号前缀', () => {
    expect(escapeCell('@x')).toBe("'@x");
  });

  it('以制表符开头的值加单引号前缀', () => {
    expect(escapeCell('\t1')).toBe("'\t1");
  });

  it('null 输出空字符串而不是字面量 null', () => {
    expect(escapeCell(null)).toBe('');
  });

  it('数字不加千分位', () => {
    // 加千分位会让 5,700 变成两列
    expect(escapeCell(5_700)).toBe('5700');
  });

  it('负数同样加前缀，安全优先于「负号变文本」', () => {
    expect(escapeCell(-1)).toBe("'-1");
  });
});

describe('toCsv', () => {
  it('以 BOM 开头', () => {
    // 写死字面量而不是拿 CSV_BOM 去比：常量本身被改成空串时，自比会变成恒真断言
    expect(toCsv(['a'], [['1']]).charCodeAt(0)).toBe(0xfeff);
  });

  it('行尾用 CRLF，不出现裸 LF', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe(`${CSV_BOM}a,b\r\n1,2\r\n`);
  });

  it('表头与数据行逐一对应', () => {
    expect(linesOf(toCsv(['日期', '备注'], [['2026-10-01', null]]))).toEqual([
      '日期,备注',
      '2026-10-01,',
    ]);
  });

  it('表头也走同一套转义', () => {
    expect(linesOf(toCsv(['a,b'], []))).toEqual(['"a,b"']);
  });
});

describe('GET /api/stats/export', () => {
  it('未登录返回 401', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await exportGet(request());
    expect(res.status).toBe(401);
  });

  it('非法 dimension 返回 400', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await exportGet(request(`dim=week&${RANGE_QUERY}`));
    expect(res.status).toBe(400);
  });

  it('返回 text/csv，且响应体以 UTF-8 BOM 字节开头', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await exportGet(request());
    // 必须看原始字节：Response.text() 解 UTF-8 时会吞掉 BOM，断言它等于什么都没验
    const head = Array.from(new Uint8Array(await res.arrayBuffer()).slice(0, 3));
    expect([res.headers.get('Content-Type'), head]).toEqual([
      'text/csv; charset=utf-8',
      [0xef, 0xbb, 0xbf],
    ]);
  });

  it('文件名是纯 ASCII 的 stats-<dim>-<from>_<to>.csv', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await exportGet(request());
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="stats-task-${D_1001}_2026-10-31.csv"`,
    );
  });

  it('表头与秒列齐备，毫秒不丢精度', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await exportGet(request());
    const lines = linesOf(await res.text());
    expect([lines[0], lines[1].split(',').slice(2).join(',')]).toEqual([
      '任务ID,标题,总时长(毫秒),总时长(秒),提交次数,退回次数',
      `${OWN_MS},5.7,1,0`,
    ]);
  });

  it('标题以等号开头时导出带单引号前缀，Excel 不会当公式执行', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await exportGet(request());
    expect(linesOf(await res.text())[1].split(',')[1]).toBe("'=1+1");
  });

  it('标注员导出只含自己的行', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await exportGet(request());
    // 表头 + 自己那一行；同租户同事的 4000 不出现
    expect(linesOf(await res.text()).length).toBe(2);
  });

  it('管理员导出含全部标注员的行', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await exportGet(request());
    expect(linesOf(await res.text()).length).toBe(3);
  });

  it('按日导出时日期列与条目数正确', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await exportGet(request(`dim=day&${RANGE_QUERY}`));
    const lines = linesOf(await res.text());
    expect([lines[0], lines[1]]).toEqual([
      '日期,总时长(毫秒),总时长(秒),条目数',
      `${D_1001},9700,9.7,2`,
    ]);
  });
});

describe('按人明细导出', () => {
  it('人员日期任务及片段数逐列输出并保留标题公式防护', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await exportGet(request(`dim=annotator&${RANGE_QUERY}`));
    expect(linesOf(await res.text())).toEqual([
      '标注员ID,姓名,提交日期,任务ID,任务,有效片段数,总时长(毫秒),总时长(秒),提交次数,退回次数,账本条目数',
      `${ALICE_ID},林小雨,${D_1001},${T_FORMULA},'=1+1,1,5700,5.7,1,0,1`,
    ]);
  });
});

describe('公式前缀与引号的顺序', () => {
  it('含逗号的公式载荷：前缀落在引号内，内部引号翻倍', () => {
    // 唯一能区分「先加前缀再包引号」与「先包引号再加前缀」的用例：
    // 错误顺序会得到 '"=1+1,""x"""'（前缀在引号外），Excel 里引号成了字面量
    expect(escapeCell('=1+1,"x"')).toBe('"\'=1+1,""x"""');
  });

  it('含制表符的载荷也要加前缀', () => {
    // 只判 startsWith('=') 的实现会漏这个 —— Excel 会吃掉制表符再执行。
    // 制表符本身不是引号触发字符，加前缀后不含 , " 换行，所以不包引号
    expect(escapeCell('\t=1+1')).toBe("'\t=1+1");
  });
});
