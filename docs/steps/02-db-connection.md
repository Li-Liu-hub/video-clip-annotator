# A2 · 连接与事务封装

**做什么**：定下「怎么拿数据库连接」和「怎么写事务」这两个问题的唯一答案。

**依赖**：A1

**预计**：0.5 小时

**为什么值得单独一步**：连接管理看起来是小事，但它决定了整个项目能不能被测。
写成全局单例 → 测试无法隔离 → 后面所有测试都不可靠。这个决定只能在地基阶段做。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/index.ts` | `createDb()` / `getDb()` / `writeTx()` |

---

## 两个入口，各有明确用途

### `createDb(path)` —— 工厂，用于测试与初始化

```ts
export function createDb(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  applyPragmas(db);
  db.exec(loadSchema());   // 建表
  return db;
}
```

- **会执行 schema**，所以 `createDb(':memory:')` 直接拿到一个可用的空库
- 每个测试用例调一次，互不干扰
- 对已存在的库重复调用会**报错**（schema 里没有 `IF NOT EXISTS`），这是刻意的：
  旧表结构被静默沿用，比报错危险得多

### `getDb()` —— 单例，用于生产

```ts
const globalForDb = globalThis as unknown as { __appDb?: DB };

export function getDb(): DB {
  if (globalForDb.__appDb) return globalForDb.__appDb;
  /* 打开、设 pragma */
  globalForDb.__appDb = db;
  return db;
}
```

- **不执行 schema**（库由 `setup.mjs` 初始化）
- 必须挂 `globalThis`：Next.js 开发模式会反复求值模块，不缓存会每次热重载新开一个文件句柄

---

## PRAGMA 三项，缺一不可

```ts
db.pragma('journal_mode = WAL');   // 读写不互相阻塞
db.pragma('foreign_keys = ON');    // SQLite 默认是关的！
db.pragma('busy_timeout = 5000');  // 写冲突时等待，而不是立刻抛 SQLITE_BUSY
```

`foreign_keys` 默认关闭是 SQLite 最著名的坑——外键写好了、看起来很安全，实际一条都没生效。
它还是**连接级**设置，不是数据库级，所以每个新连接都要设。

---

## `writeTx` 显式接收 db

```ts
export function writeTx<T>(db: DB, fn: (tx: DB) => T): T {
  const wrapped = db.transaction(() => fn(db));
  return wrapped.immediate();
}
```

**为什么不像常见写法那样内部调 `getDb()`**：那样测试里就没法用内存库，所有涉及事务的
service 函数都变得不可测。多传一个参数，换来整条链路的可测性。

`BEGIN IMMEDIATE` 而不是默认的 `BEGIN`：立即取写锁，让「检查约束 → 写入」在同一个临界区内
完成。默认的 `BEGIN` 是延迟加锁，两个事务可能都通过了检查再同时写。

**不允许嵌套调用**。better-sqlite3 的事务不支持嵌套，service 里如果已经在一个事务中，
就把逻辑拆成内部函数，由外层事务统一调用。

---

## 用法约定

**repo 层**：接收 `db`，不关心它是不是事务

```ts
export function findTaskById(db: DB, tenantId: string | null, id: string): Task | null
```

**service 层**：只读操作直接用 `db`，写操作开事务

```ts
export function listTasks(db: DB, actor: SessionUser, f: TaskFilter) {
  return taskRepo.list(db, scopeOf(actor, f), f);   // 无事务
}

export function claimTask(db: DB, actor: SessionUser, taskId: string) {
  return writeTx(db, (tx) => {                       // 有事务
    const changed = taskRepo.claim(tx, actor.tenantId!, actor.id, taskId);
    if (changed !== 1) throw new StateConflictError('任务已被领取或状态不允许');
    writeAudit(tx, actor, 'task.claim', 'task', taskId);
    return taskRepo.findById(tx, actor.tenantId, taskId)!;
  });
}
```

---

## 验收

- [ ] `createDb(':memory:')` 返回可用的空库（直接 `SELECT COUNT(*) FROM tasks` 返回 0）
- [ ] 对同一个 `:memory:` 库重复 `createDb` 不会冲突（每次都是新实例）
- [ ] `createDb` 指向已存在的库文件 → 报错（表已存在）
- [ ] `PRAGMA foreign_keys` 返回 `1`
- [ ] `PRAGMA journal_mode` 返回 `wal`
- [ ] `writeTx` 内抛错后，写入被回滚
- [ ] `writeTx` 内的 `tx` 与外层 `db` 是同一个对象

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 忘了 `foreign_keys = ON` | 外键全部无效，删任务留下孤儿片段 |
| `getDb` 没挂 `globalThis` | 开发模式每次热重载新开连接，几十次后句柄耗尽 |
| `writeTx` 内部调 `getDb()` | 测试无法注入内存库，所有事务代码不可测 |
| 用 `BEGIN` 而非 `BEGIN IMMEDIATE` | 并发下检查与写入不在同一临界区 |
| schema 用了 `IF NOT EXISTS` | 改了表结构但旧库静默沿用，线上行为与代码不一致 |
| 在 `:memory:` 库上断言 `journal_mode = 'wal'` | 内存库永远是 `memory`，测试必假失败 |
| 建表失败时不 `close()` | 文件句柄悬挂，临时文件删不掉（Windows 上直接 EPERM） |

后两条是实际踩到的：`:memory:` 不支持 WAL 是 SQLite 的固有行为，验证 WAL 必须用文件库；
`createDb` 第一次写没有 `try/catch` 关闭连接，导致「对已有库重复建库应当报错」这条用例
跑完后临时文件删不掉。**测试把实现的缺陷逼出来了**，这比测试通过本身更有价值。

---

## 完成后

```bash
git add -A && git commit -m "feat(A2): 连接工厂、单例与事务封装"
```
