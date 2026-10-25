/**
 * 全链路验收：把「领任务 → 标注 → 提交 → 计入工作量 → 退回 → 重新打开」跑一遍。
 *
 * 为什么要有这个脚本：
 * 707 例单测覆盖的是每个函数自己，但它们拼起来能不能用是另一件事 ——
 * F1 写完提交接口、F2 写完退回接口时，界面上都没有入口，
 * 单测全绿而人点不到。这个脚本走的是真实 HTTP，验的是「连起来能用」。
 *
 * 用法：
 *   node scripts/setup.mjs --reset           # 干净的库
 *   npx next dev -p 3000                     # 另开一个终端
 *   node scripts/e2e-check.mjs               # 跑这个
 */
import Database from 'better-sqlite3';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3000';
const DB_PATH = 'data/app.db';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 每个角色一个 cookie 罐：标注员与管理员的会话不能混。 */
function jar() {
  return { cookie: '' };
}

async function call(who, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (who.cookie) headers.cookie = who.cookie;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((value) => value.startsWith('vsap_sid='));
  if (session) who.cookie = session.split(';')[0];
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML 页面（工作台、审计页）不是 JSON，保留原文给调用方判断
  }
  return { status: response.status, json, text, headers: response.headers };
}

function db() {
  return new Database(DB_PATH, { readonly: true });
}

console.log(`\n== 全链路验收 @ ${BASE}\n`);

const alice = jar();
const admin = jar();

// ── 1. 登录 ──────────────────────────────────────────────
console.log('[1] 登录');
const aliceLogin = await call(alice, 'POST', '/api/auth/login', {
  username: 'alice',
  password: 'demo123',
});
check('标注员登录 200', aliceLogin.status === 200, aliceLogin.status);

const adminLogin = await call(admin, 'POST', '/api/auth/login', {
  username: 'admin',
  password: 'admin123',
});
check('管理员登录 200', adminLogin.status === 200, adminLogin.status);

const badLogin = await call(jar(), 'POST', '/api/auth/login', {
  username: 'alice',
  password: 'wrong',
});
check('密码错返回 401', badLogin.status === 401, badLogin.status);

const ghostLogin = await call(jar(), 'POST', '/api/auth/login', {
  username: 'nobody',
  password: 'x',
});
check(
  '用户不存在与密码错的回包完全相同（不泄漏）',
  ghostLogin.status === badLogin.status &&
    ghostLogin.json?.error?.message === badLogin.json?.error?.message,
  { ghost: ghostLogin.json, bad: badLogin.json },
);

// ── 2. 造一条新任务再领 ──────────────────────────────────
// 不依赖种子里的 pending：上一次运行会把它们领完，脚本就不幂等了
console.log('[2] 创建并领取任务');
const seedDb = db();
const video = seedDb.prepare('SELECT id FROM videos LIMIT 1').get();
seedDb.close();

// 取 alice 自己所属的租户：任务建在别人的租户下，她根本领不到
const tenantDb = db();
const tenant = tenantDb
  .prepare('SELECT tenant_id AS id FROM users WHERE username = ?')
  .get('alice');
tenantDb.close();

const created = await call(admin, 'POST', '/api/tasks', {
  videoId: video.id,
  tenantIds: [tenant.id],
  title: `验收任务 ${new Date().toISOString()}`,
});
check('管理员创建任务 200', created.status === 200, created.json ?? created.status);
const pending = { id: created.json?.ids?.[0] };
check('拿到新任务 id', Boolean(pending.id), created.json);

const claim = await call(alice, 'POST', `/api/tasks/${pending.id}/claim`);
check('领取 200', claim.status === 200, claim.status);

const claimAgain = await call(alice, 'POST', `/api/tasks/${pending.id}/claim`);
check('重复领取 409', claimAgain.status === 409, claimAgain.status);

// ── 3. 标注 ──────────────────────────────────────────────
console.log('[3] 标注');
const seg = await call(alice, 'POST', `/api/tasks/${pending.id}/segments`, {
  startMs: 1_000,
  endMs: 6_000,
  label: '有效操作',
});
check('建片段 200', seg.status === 200, seg.json ?? seg.status);

const overlap = await call(alice, 'POST', `/api/tasks/${pending.id}/segments`, {
  startMs: 2_000,
  endMs: 4_000,
});
check('重叠片段被拒 409', overlap.status === 409, overlap.status);

// ── 4. 提交 ──────────────────────────────────────────────
console.log('[4] 提交');
// 种子里当天已有账目：断言「增量」而不是「绝对值」，否则验的是种子数据
// 统计是「按日」的，所以基线也必须按日取 —— 取全时段净额会与后面比的对象不是一回事
const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const beforeSubmit = db();
const baselineNet = beforeSubmit
  .prepare(
    'SELECT COALESCE(SUM(delta_ms), 0) AS net FROM ledger_entries WHERE tenant_id = ? AND entry_date = ?',
  )
  .get(tenant.id, todayIso).net;
beforeSubmit.close();
const submit = await call(alice, 'POST', `/api/tasks/${pending.id}/submit`);
check('提交 200', submit.status === 200, submit.json ?? submit.status);
check('提交返回 totalMs=5000', submit.json?.submission?.totalMs === 5_000, submit.json);

const submitAgain = await call(alice, 'POST', `/api/tasks/${pending.id}/submit`);
check('重复提交 409', submitAgain.status === 409, submitAgain.status);

const afterSubmit = db();
const taskRow = afterSubmit
  .prepare('SELECT status, first_submitted_at, reject_reason FROM tasks WHERE id = ?')
  .get(pending.id);
const sub = afterSubmit
  .prepare('SELECT total_ms, segment_count, local_date, segments_json FROM submissions WHERE task_id = ?')
  .get(pending.id);
const ledger = afterSubmit
  .prepare('SELECT delta_ms, entry_date, kind FROM ledger_entries WHERE task_id = ?')
  .all(pending.id);
afterSubmit.close();

check('任务转 submitted', taskRow.status === 'submitted', taskRow.status);
check('first_submitted_at 已写', taskRow.first_submitted_at !== null);
check('快照 total_ms 等于片段时长之和', sub?.total_ms === 5_000, sub?.total_ms);
check('快照不含 id', !sub?.segments_json?.includes('"id"'), sub?.segments_json);
check('账本条数为 1 且为正', ledger.length === 1 && ledger[0].delta_ms === 5_000 && ledger[0].kind === 'submit', ledger);
check('账本日期与快照一致', ledger[0]?.entry_date === sub?.local_date, {
  ledger: ledger[0]?.entry_date,
  snapshot: sub?.local_date,
});

// ── 5. 只读形态 ──────────────────────────────────────────
console.log('[5] 提交后页面应是只读');
const readonlyPage = await call(alice, 'GET', `/tasks/${pending.id}/work`);
check('工作台 200', readonlyPage.status === 200, readonlyPage.status);
check('显示「已提交，仅供查看」', readonlyPage.text.includes('已提交，仅供查看'));
check('不渲染删除按钮', !readonlyPage.text.includes('删除第'));
check('不渲染提交区', !readonlyPage.text.includes('个片段，合计'));

// ── 6. 统计与导出 ────────────────────────────────────────
console.log('[6] 统计与导出');
const today = sub?.local_date ?? todayIso;
const stats = await call(alice, 'GET', `/api/stats?dim=day&from=${today}&to=${today}`);
check('统计 200', stats.status === 200, stats.status);
check(
  '统计的当日净额比提交前多了 5000',
  (stats.json?.rows?.[0]?.totalMs ?? 0) === baselineNet + 5_000,
  { after: stats.json?.rows?.[0]?.totalMs, baseline: baselineNet },
);

const csvResponse = await fetch(`${BASE}/api/stats/export?dim=day&from=${today}&to=${today}`, {
  headers: { cookie: admin.cookie },
});
const csvBytes = new Uint8Array(await csvResponse.arrayBuffer());
check('导出 200', csvResponse.status === 200, csvResponse.status);
// 必须按字节判：fetch 的 text() 解 UTF-8 时会把 BOM 当 BOM 吃掉，
// 用它写的断言是恒真的（reviewer 在 G2 就指出过这一点）
check(
  '导出带 BOM（EF BB BF）',
  csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
  [...csvBytes.slice(0, 3)],
);
const csv = { headers: csvResponse.headers, text: new TextDecoder().decode(csvBytes) };
check(
  '导出类型是 csv',
  (csv.headers.get('content-type') ?? '').includes('text/csv'),
  csv.headers.get('content-type'),
);

const badRange = await call(alice, 'GET', '/api/stats?dim=day&from=2026-02-31&to=2026-03-01');
check('不存在的日历日 400', badRange.status === 400, badRange.status);

// ── 7. 退回 ──────────────────────────────────────────────
console.log('[7] 退回');
const reject = await call(admin, 'POST', `/api/tasks/${pending.id}/reject`, {
  reason: '片段标得太短，请补上后半段',
});
check('退回 200', reject.status === 200, reject.json ?? reject.status);

const afterReject = db();
const rejectedTask = afterReject
  .prepare('SELECT status, reject_reason FROM tasks WHERE id = ?')
  .get(pending.id);
const revoke = afterReject
  .prepare("SELECT delta_ms, entry_date FROM ledger_entries WHERE task_id = ? AND kind = 'revoke'")
  .get(pending.id);
const netAfterReject = afterReject
  .prepare('SELECT SUM(delta_ms) AS net FROM ledger_entries WHERE task_id = ?')
  .get(pending.id);
afterReject.close();

check('任务转 rejected', rejectedTask.status === 'rejected', rejectedTask.status);
check('退回原因已落库', rejectedTask.reject_reason === '片段标得太短，请补上后半段');
check('冲正金额为负且等于提交量', revoke.delta_ms === -5_000, revoke);
check('冲正记在原提交日', revoke.entry_date === today, { revoke: revoke.entry_date, today });
check('净额归零', netAfterReject.net === 0, netAfterReject.net);

const statsAfterReject = await call(alice, 'GET', `/api/stats?dim=day&from=${today}&to=${today}`);
check(
  '退回后统计的当日净额回到提交前的基线',
  statsAfterReject.json?.rows?.[0]?.totalMs === baselineNet,
  { after: statsAfterReject.json?.rows?.[0]?.totalMs, baseline: baselineNet },
);

// ── 8. 重新打开 ──────────────────────────────────────────
console.log('[8] 重新打开');
const reopen = await call(alice, 'POST', `/api/tasks/${pending.id}/reopen`);
check('重新打开 200', reopen.status === 200, reopen.json ?? reopen.status);

const workAfterReopen = await call(alice, 'GET', `/tasks/${pending.id}/work`);
check('重新打开后能进工作台', workAfterReopen.status === 200, workAfterReopen.status);
check(
  '工作台顶部显示退回原因',
  workAfterReopen.text.includes('片段标得太短'),
  '未在 HTML 中找到退回原因',
);

const submitAgainAfterReopen = await call(alice, 'POST', `/api/tasks/${pending.id}/submit`);
check('重新打开后可以再次提交', submitAgainAfterReopen.status === 200, submitAgainAfterReopen.status);

const finalDb = db();
const finalNet = finalDb
  .prepare('SELECT SUM(delta_ms) AS net FROM ledger_entries WHERE task_id = ?')
  .get(pending.id);
const openSubs = finalDb
  .prepare('SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND superseded_by IS NULL')
  .get(pending.id);
finalDb.close();

check('再次提交后净额等于新的提交量', finalNet.net === 5_000, finalNet.net);
check('未被取代的快照只有一条', openSubs.n === 1, openSubs.n);

// ── 9. 权限 ──────────────────────────────────────────────
console.log('[9] 权限');
const anon = await call(jar(), 'GET', '/api/stats?dim=day&from=2026-10-01&to=2026-10-31');
check('未登录访问统计 401', anon.status === 401, anon.status);

const anonExport = await call(jar(), 'GET', '/api/stats/export?dim=day&from=2026-10-01&to=2026-10-31');
check('未登录导出 401', anonExport.status === 401, anonExport.status);

const aliceAudit = await call(alice, 'GET', '/admin/audit');
check('标注员进审计页被挡（跳走或 403）', aliceAudit.status !== 200 || !aliceAudit.text.includes('审计日志'), aliceAudit.status);

const adminAudit = await call(admin, 'GET', '/admin/audit');
check('管理员能进审计页', adminAudit.status === 200, adminAudit.status);
check('审计页能看到登录记录', adminAudit.text.includes('登录'));

// ── 10. 审计内容 ─────────────────────────────────────────
console.log('[10] 审计内容');
const auditDb = db();
const actions = auditDb.prepare('SELECT action, COUNT(*) AS n FROM audit_logs GROUP BY action').all();
const credentialColumn = auditDb
  .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE detail LIKE '%sessionId%'")
  .get();
auditDb.close();

const actionNames = actions.map((row) => row.action);
check('有 auth.login', actionNames.includes('auth.login'), actionNames);
check('有 auth.login_failed', actionNames.includes('auth.login_failed'), actionNames);
check('有 task.submit', actionNames.includes('task.submit'), actionNames);
check('有 task.reject', actionNames.includes('task.reject'), actionNames);
check('有 task.reopen', actionNames.includes('task.reopen'), actionNames);
check('审计里不含 sessionId（凭据不入库）', credentialColumn.n === 0, credentialColumn.n);

// ── 结果 ─────────────────────────────────────────────────
console.log(`\n== ${pass} 项通过，${fail} 项失败`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
