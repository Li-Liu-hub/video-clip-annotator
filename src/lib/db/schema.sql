-- 视频片段标注平台 · 数据模型
-- 时间统一以 UTC 毫秒（INTEGER）存储；「哪一天」在写入时按租户时区换算为文本并固化。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  INTEGER NOT NULL
);

-- 角色与租户归属的约束写进 CHECK：
-- 管理员是平台角色（跨租户），标注员必须属于某个租户。
-- 这不是注释，漏了会直接被数据库拒绝。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id),
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'annotator')),
  created_at    INTEGER NOT NULL,
  CHECK (
    (role = 'admin'     AND tenant_id IS NULL) OR
    (role = 'annotator' AND tenant_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  title              TEXT NOT NULL,
  description        TEXT,
  video_path         TEXT NOT NULL,
  video_duration_ms  INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'submitted', 'rejected')),
  assignee_id        TEXT REFERENCES users(id),
  claimed_at         INTEGER,
  first_submitted_at INTEGER,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  CHECK (
    (status = 'pending' AND assignee_id IS NULL) OR
    (status <> 'pending' AND assignee_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant   ON tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);

-- 草稿态时间段。tenant_id 是防御性冗余：即使某条查询忘了 join tasks，
-- 租户谓词依然生效。
CREATE TABLE IF NOT EXISTS segments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  CHECK (end_ms > start_ms),
  CHECK (start_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_segments_task ON segments(task_id, start_ms);

-- 提交快照。segments_json 冻结提交那一刻的标注内容，
-- 之后草稿怎么改都不会污染历史。
CREATE TABLE IF NOT EXISTS submissions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  tenant_id     TEXT NOT NULL,
  annotator_id  TEXT NOT NULL REFERENCES users(id),
  submitted_at  INTEGER NOT NULL,
  local_date    TEXT NOT NULL,
  total_ms      INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  segments_json TEXT NOT NULL,
  superseded_by TEXT REFERENCES submissions(id),
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id, created_at);

-- 只追加账本。delta_ms 为正表示计入，为负表示冲正。
-- 统计永远等于 SUM(delta_ms) GROUP BY entry_date，历史日期不会被后续操作改写。
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  annotator_id  TEXT NOT NULL,
  delta_ms      INTEGER NOT NULL,
  entry_date    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('submit', 'revoke')),
  created_at    INTEGER NOT NULL,
  CHECK (
    (kind = 'submit' AND delta_ms > 0) OR
    (kind = 'revoke' AND delta_ms < 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_ledger_daily ON ledger_entries(tenant_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_task  ON ledger_entries(task_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
