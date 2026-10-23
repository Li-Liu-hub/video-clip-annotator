-- 视频片段标注平台 · 数据模型
--
-- 时间统一以 UTC 毫秒（INTEGER）存储。
-- 「哪一天」是业务概念，在写入时按租户时区算成 YYYY-MM-DD 并固化为 TEXT，
-- 查询期绝不再做换算 —— 否则服务器时区或租户时区一变，历史统计会整体漂移。
--
-- 本文件由 createDb() 与 setup.mjs 执行，不含 IF NOT EXISTS：
-- 重复执行应当报错，而不是静默跳过已经过期的表结构。

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────
-- 租户：标注员的个人工作空间，与标注员 1:1
-- ─────────────────────────────────────────────
CREATE TABLE tenants (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  timezone    TEXT    NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  INTEGER NOT NULL
);

-- ─────────────────────────────────────────────
-- 用户：管理员不属于任何租户；标注员必须属于一个租户
-- ─────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT    PRIMARY KEY,
  tenant_id     TEXT    REFERENCES tenants(id),
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,   -- scrypt$<salt hex>$<hash hex>
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'annotator')),
  created_at    INTEGER NOT NULL,
  CHECK ((role = 'admin'     AND tenant_id IS NULL) OR
         (role = 'annotator' AND tenant_id IS NOT NULL))
);

-- 一个租户只能有一个标注员。
-- WHERE 不能省：管理员的 tenant_id 全是 NULL，要明确这个唯一性只约束标注员。
CREATE UNIQUE INDEX idx_one_annotator_per_tenant
  ON users(tenant_id) WHERE role = 'annotator';

-- ─────────────────────────────────────────────
-- 视频资产：独立于任务，支持一个视频被多个任务引用
-- ─────────────────────────────────────────────
CREATE TABLE videos (
  id            TEXT    PRIMARY KEY,
  filename      TEXT    NOT NULL,
  storage_path  TEXT    NOT NULL,   -- 相对 data/videos/ 的路径
  size_bytes    INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  mime_type     TEXT    NOT NULL DEFAULT 'video/mp4',
  uploaded_by   TEXT    NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  CHECK (size_bytes > 0),
  CHECK (duration_ms > 0)
);

-- ─────────────────────────────────────────────
-- 任务：管理员创建时选定租户，任务进入该租户的 pending 池
-- ─────────────────────────────────────────────
CREATE TABLE tasks (
  id                 TEXT    PRIMARY KEY,
  tenant_id          TEXT    NOT NULL REFERENCES tenants(id),
  video_id           TEXT    NOT NULL REFERENCES videos(id),
  title              TEXT    NOT NULL,
  description        TEXT,
  status             TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'submitted', 'rejected')),
  claimed_by         TEXT    REFERENCES users(id),
  claimed_at         INTEGER,
  first_submitted_at INTEGER,
  reject_reason      TEXT,
  created_by         TEXT    NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  -- 状态与领取人必须同步。超时回收时若漏清 claimed_by，UPDATE 会被直接拒绝。
  CHECK ((status = 'pending'  AND claimed_by IS NULL) OR
         (status <> 'pending' AND claimed_by IS NOT NULL))
);

CREATE INDEX idx_tasks_tenant ON tasks(tenant_id, status);
CREATE INDEX idx_tasks_status ON tasks(status, created_at);

-- ─────────────────────────────────────────────
-- 片段：工作区。标注员正在编辑的内容，可增删改。
-- tenant_id 是刻意的冗余：某条查询忘了 join tasks 时，租户谓词依然生效。
-- ─────────────────────────────────────────────
CREATE TABLE segments (
  id         TEXT    PRIMARY KEY,
  task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id  TEXT    NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  CHECK (end_ms > start_ms),   -- 不允许零长片段
  CHECK (start_ms >= 0)
);

CREATE INDEX idx_segments_task ON segments(task_id, start_ms);

-- ─────────────────────────────────────────────
-- 提交：存档。提交那一刻的冻结副本，之后永不修改内容。
-- segments_json 的作用：退回后草稿会继续被编辑，但这次提交标了什么必须永久可查。
-- ─────────────────────────────────────────────
CREATE TABLE submissions (
  id            TEXT    PRIMARY KEY,
  task_id       TEXT    NOT NULL REFERENCES tasks(id),
  tenant_id     TEXT    NOT NULL,
  annotator_id  TEXT    NOT NULL REFERENCES users(id),
  submitted_at  INTEGER NOT NULL,
  local_date    TEXT    NOT NULL,   -- 提交日（按租户时区），固化后不再变
  total_ms      INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  segments_json TEXT    NOT NULL,
  superseded_by TEXT    REFERENCES submissions(id),
  created_at    INTEGER NOT NULL,
  CHECK (total_ms > 0),
  CHECK (segment_count > 0)
);

CREATE INDEX idx_submissions_task ON submissions(task_id, created_at);

-- ─────────────────────────────────────────────
-- 账本：只追加。统计的唯一数据源。
-- 冲正记在「事件发生日」而非「原提交日」，所以历史日期永远不会被改写。
-- ─────────────────────────────────────────────
CREATE TABLE ledger_entries (
  id            TEXT    PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  task_id       TEXT    NOT NULL,
  submission_id TEXT    NOT NULL REFERENCES submissions(id),
  annotator_id  TEXT    NOT NULL REFERENCES users(id),
  delta_ms      INTEGER NOT NULL,   -- 正=计入，负=冲正
  entry_date    TEXT    NOT NULL,   -- 计入哪一天（事件发生日）
  kind          TEXT    NOT NULL CHECK (kind IN ('submit', 'revoke')),
  created_at    INTEGER NOT NULL,
  CHECK ((kind = 'submit' AND delta_ms > 0) OR
         (kind = 'revoke' AND delta_ms < 0))
);

CREATE INDEX idx_ledger_daily ON ledger_entries(tenant_id, entry_date);
CREATE INDEX idx_ledger_task  ON ledger_entries(task_id, created_at);

-- ─────────────────────────────────────────────
-- 审计：只追加，不参与任何业务计算。
-- 刻意不设外键：审计记录必须比被审计对象活得久。
-- ─────────────────────────────────────────────
CREATE TABLE audit_logs (
  id          TEXT    PRIMARY KEY,
  actor_id    TEXT,                 -- 登录失败时为 NULL
  actor_role  TEXT,
  tenant_id   TEXT,                 -- 管理员全局操作时为 NULL
  action      TEXT    NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,                 -- JSON 字符串
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_audit_time   ON audit_logs(created_at);
CREATE INDEX idx_audit_actor  ON audit_logs(actor_id, created_at);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);

-- ─────────────────────────────────────────────
-- 会话
-- ─────────────────────────────────────────────
CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ─────────────────────────────────────────────
-- 区间不重叠：数据层兜底
--
-- 应用层也会校验（为了给用户可读提示），但应用层有三个缺口：
--   1. 两个请求同时通过检查、同时插入
--   2. 将来新加的接口忘了调用校验
--   3. 临时脚本绕过 API
-- 触发器在数据层，以上路径都是同一个入口。
--
-- 语义：半开区间 [start, end)。
-- 因此 [10000,20000) 与 [20000,30000) 不算重叠 —— 首尾相接是合法的连续标注。
-- ─────────────────────────────────────────────
CREATE TRIGGER trg_segment_no_overlap_ins
BEFORE INSERT ON segments
BEGIN
  SELECT RAISE(ABORT, 'OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM segments
    WHERE task_id  = NEW.task_id
      AND start_ms < NEW.end_ms
      AND end_ms   > NEW.start_ms
  );
END;

CREATE TRIGGER trg_segment_no_overlap_upd
BEFORE UPDATE OF start_ms, end_ms ON segments
BEGIN
  SELECT RAISE(ABORT, 'OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM segments
    WHERE task_id  = NEW.task_id
      AND id      <> NEW.id      -- 排除自己，否则任何片段都改不动
      AND start_ms < NEW.end_ms
      AND end_ms   > NEW.start_ms
  );
END;
