/**
 * 种子数据。两种形态：
 *   默认        只建一个管理员，口令随机生成并交由调用方打印一次（不落盘、不进 README）
 *   demoLogin   4 账号 / 3 租户 / 17 任务 / 历史账本与审计，口令是文档里的固定值
 *
 * 单独成模块而不是留在 setup.mjs 里，是因为它有两个调用方：
 *   - scripts/setup.mjs：建库后灌一次（npm run dev 的 predev）
 *   - scripts/invariant-check.mjs --temp：在一次性库里灌种子后跑业务链路
 * 抄两份种子必然漂移：改了价目、加了状态，只有一处被改到时，
 * 「种子数据是否自洽」这件事就再也验不准了。
 */
import { randomBytes, scryptSync } from 'node:crypto';

const DAY = 86_400_000;

const nid = () => randomBytes(8).toString('hex');

/** 与 src/lib/services/daily-date.ts 的 localDateOf 等价 */
function localDateOf(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(utcMs));
  const pick = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function hashPassword(password) {
  // 与 src/lib/services/auth-service.ts 保持同一格式：scrypt$<salt hex>$<hash hex>
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

/**
 * 往已建表的库里灌种子。调用方负责 schema 与视频文件。
 *
 * videoSize 由调用方给：task 里的 estimated_ms 取自视频时长，
 * 但 size_bytes 只是展示字段，没有视频文件（--temp 场景）时传 1 即可。
 *
 * demoLogin 默认 false：交付库里不该有口令已知的账号。演示/验收需要固定口令时显式打开。
 * 返回值里的 adminPassword 只在默认模式下有值，调用方必须打印一次就丢掉 ——
 * 写进文件或日志等于把「随机口令」又变回默认口令。
 */
export function seedDatabase(db, { now = Date.now(), videoSize = 1, demoLogin = false } = {}) {
  const demo = demoLogin === true;
  // 12 字符、base64url，手抄不容易错；9 字节熵在口令 + 限流下够用。
  //
  // 默认模式建的是**全量数据**，只是口令随机 —— 安全要防的是「口令已知」，
  // 不是「有数据」。早先的写法在默认模式下连租户与任务都不建，
  // 结果是 npm run dev 登录后什么都看不到，等于把安全性做成了不可用。
  const demoPassword = 'demo123';
  const sharedPassword = demo ? demoPassword : randomBytes(9).toString('base64url');
  const adminPassword = sharedPassword;

  const tenants = [
    { id: nid(), name: '林小雨的工作空间' },
    { id: nid(), name: '陈默的工作空间' },
    { id: nid(), name: '周予安的工作空间' },
  ];

  const adminId = nid();
  const admin = {
    id: adminId,
    tenantId: null,
    username: 'admin',
    displayName: '平台管理员',
    pwd: adminPassword,
    role: 'admin',
  };
  // 四个账号始终都建。默认模式下它们共用同一个随机口令（打印一次），
  // 演示模式下用文档里的固定口令。
  const users = [
    admin,
    { id: nid(), tenantId: tenants[0].id, username: 'alice', displayName: '林小雨', pwd: sharedPassword, role: 'annotator' },
    { id: nid(), tenantId: tenants[1].id, username: 'bob', displayName: '陈默', pwd: sharedPassword, role: 'annotator' },
    { id: nid(), tenantId: tenants[2].id, username: 'carol', displayName: '周予安', pwd: sharedPassword, role: 'annotator' },
  ];

  const videoId = nid();
  const videoDurationMs = 30_000;

  // segs 单位毫秒；daysAgo 决定提交落在哪一天（0 = 今天），hour 决定落在当天几点。
  // 数据故意做得不均匀：有人一天两条、有人隔天一条，统计页的柱状图才看得出起伏。
  const taskSpecs = [
    // 林小雨
    { t: 0, title: '双臂协作 · 取杯与递送', daysAgo: 6, hour: 10, status: 'submitted', segs: [[2100, 6400], [9100, 13800], [19200, 24500]] },
    { t: 0, title: '双臂协作 · 研磨与压粉', daysAgo: 4, hour: 14, status: 'submitted', segs: [[1500, 5200], [7200, 11900], [15600, 20100], [24300, 28800]] },
    { t: 0, title: '双臂协作 · 倾倒与收尾', daysAgo: 3, hour: 11, status: 'submitted', segs: [[4200, 9600], [15200, 21400]] },
    { t: 0, title: '单臂抓取 · 杯口对准',   daysAgo: 1, hour: 15, status: 'submitted', segs: [[2600, 7100], [10300, 15800], [20100, 25900]] },
    { t: 0, title: '双臂协作 · 传递与放开', daysAgo: 0, hour: 9,  status: 'claimed',   segs: [[5100, 10800]] },
    { t: 0, title: '双臂协作 · 端到端演示', daysAgo: 0, hour: 9,  status: 'submitted', segs: [[1600, 6200], [8900, 14100], [18300, 23700], [26200, 31400]] },
    { t: 0, title: '单臂抓取 · 侧向接近',   daysAgo: 0, hour: 9,  status: 'pending',   segs: [] },

    // 陈默
    { t: 1, title: '单臂抓取 · 杯柄对齐',   daysAgo: 5, hour: 9,  status: 'submitted', segs: [[3400, 8100], [12400, 17200]] },
    { t: 1, title: '单臂抓取 · 稳定放置',   daysAgo: 4, hour: 16, status: 'submitted', segs: [[1800, 7900], [11200, 18700], [21000, 27400]] },
    { t: 1, title: '单臂抓取 · 空杯回收',   daysAgo: 2, hour: 10, status: 'submitted', segs: [[3100, 9800], [13400, 19600], [22800, 29100], [30500, 35800]] },
    { t: 1, title: '单臂抓取 · 放置校准',   daysAgo: 1, hour: 14, status: 'submitted', segs: [[4400, 9200], [16700, 22300]] },
    { t: 1, title: '双臂协作 · 端到端流程', daysAgo: 0, hour: 11, status: 'claimed',   segs: [[2900, 7400], [13800, 19600]] },
    { t: 1, title: '单臂抓取 · 二次抓取',   daysAgo: 0, hour: 11, status: 'pending',   segs: [] },

    // 周予安
    { t: 2, title: '推动方块 · 直线轨迹',   daysAgo: 6, hour: 13, status: 'submitted', segs: [[2400, 8900], [12600, 18100]] },
    { t: 2, title: '推动方块 · 避障变道',   daysAgo: 3, hour: 9,  status: 'submitted', segs: [[1900, 7400], [10800, 16300], [20100, 25600]] },
    { t: 2, title: '推动方块 · 反向推回',   daysAgo: 1, hour: 15, status: 'submitted', segs: [[3300, 10100], [14200, 20800]] },
    { t: 2, title: '推动方块 · 定位精度',   daysAgo: 0, hour: 10, status: 'pending',   segs: [] },
  ];

  const insertTenant = db.prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)');
  const insertUser = db.prepare(
    'INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertVideo = db.prepare(
    'INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, description, status, claimed_by, claimed_at, first_submitted_at, reject_reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const insertSegment = db.prepare(
    'INSERT INTO segments (id, task_id, tenant_id, start_ms, end_ms, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertSubmission = db.prepare(
    `INSERT INTO submissions (id, task_id, tenant_id, annotator_id, submitted_at, local_date, total_ms, segment_count, segments_json, superseded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const insertLedger = db.prepare(
    `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'submit', ?)`,
  );
  const insertAudit = db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, tenant_id, action, target_type, target_id, detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '127.0.0.1', 'seed', ?)`,
  );

  const seed = db.transaction(() => {
    for (const t of tenants) insertTenant.run(t.id, t.name, 'Asia/Shanghai', now);

    for (const u of users) {
      insertUser.run(u.id, u.tenantId, u.username, u.displayName, hashPassword(u.pwd), u.role, now);
    }

    // 视频始终插入：任务要引用它。早先只在演示模式插，默认模式下任务的 video_id
    // 外键悬空、整库建不起来 —— 而默认模式本来就是全量数据
    insertVideo.run(videoId, 'aloha-coffee.mp4', 'aloha-coffee.mp4', videoSize, videoDurationMs, 'video/mp4', adminId, now);

    for (const spec of taskSpecs) {
      const tenant = tenants[spec.t];
      const annotator = users[spec.t + 1];
      const taskId = nid();
      const createdAt = now - spec.daysAgo * DAY - 3_600_000;
      const claimedAt = spec.status === 'pending' ? null : createdAt + 90_000;

      // 把提交时刻调到当天指定的 hour 点；若算出来是未来（daysAgo = 0 时），夹到当前时间之前
      let submittedAt = null;
      if (spec.status === 'submitted') {
        const dayAnchor = now - spec.daysAgo * DAY;
        const localHour = new Date(dayAnchor).getHours();
        submittedAt = Math.min(now - 60_000, dayAnchor + (spec.hour - localHour) * 3_600_000);
      }
      const totalMs = spec.segs.reduce((sum, [s, e]) => sum + (e - s), 0);

      insertTask.run(
        taskId,
        tenant.id,
        videoId,
        spec.title,
        '从示教视频中标出机器人完成该子任务的有效片段。',
        spec.status,
        spec.status === 'pending' ? null : annotator.id,
        claimedAt,
        submittedAt,
        adminId,
        createdAt,
      );

      for (const [start, end] of spec.segs) {
        insertSegment.run(nid(), taskId, tenant.id, start, end, '有效操作', createdAt + 120_000);
      }

      if (spec.status === 'submitted' && submittedAt && totalMs > 0) {
        const submissionId = nid();
        const localDate = localDateOf(submittedAt, 'Asia/Shanghai');

        insertSubmission.run(
          submissionId,
          taskId,
          tenant.id,
          annotator.id,
          submittedAt,
          localDate,
          totalMs,
          spec.segs.length,
          JSON.stringify(spec.segs.map(([s, e]) => ({ startMs: s, endMs: e, label: '有效操作' }))),
          submittedAt,
        );

        insertLedger.run(nid(), tenant.id, taskId, submissionId, annotator.id, totalMs, localDate, submittedAt);

        insertAudit.run(nid(), annotator.id, 'annotator', tenant.id, 'task.submit', 'task', taskId,
          JSON.stringify({ totalMs, segmentCount: spec.segs.length }), submittedAt);
      }

      insertAudit.run(nid(), adminId, 'admin', tenant.id, 'task.create', 'task', taskId,
        JSON.stringify({ title: spec.title, tenantId: tenant.id }), createdAt);
    }

    for (const u of users.filter((x) => x.role === 'annotator')) {
      insertAudit.run(nid(), u.id, 'annotator', u.tenantId, 'auth.login', 'user', u.id,
        JSON.stringify({ username: u.username }), now - 3_600_000);
    }
  });

  seed();

  const counts = {
    租户: db.prepare('SELECT COUNT(*) n FROM tenants').get().n,
    用户: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    视频: db.prepare('SELECT COUNT(*) n FROM videos').get().n,
    任务: db.prepare('SELECT COUNT(*) n FROM tasks').get().n,
    已提交: db.prepare("SELECT COUNT(*) n FROM tasks WHERE status = 'submitted'").get().n,
    账本条目: db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n,
    审计记录: db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n,
  };

  // 演示模式下口令是文档里的公开值，没有「一次性秘密」可发
  // 随机模式下把口令交给调用方打印一次；演示模式下没有「需要记住的口令」
  return { counts, sharedPassword: demo ? null : sharedPassword };
}
