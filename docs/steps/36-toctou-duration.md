# O3 · 提交的 TOCTOU 与服务端视频时长

**做什么**：修两条「数据能被合法地弄脏」的路径。

**依赖**：F1、C1

**预计**：4 小时

---

## 1 提交时片段在事务外读

**现状**（`submit-service.ts:42-60`）：

```
requireWritableTask(db, actor, taskId)   ← 事务外
listByTask(db, actor.tenantId, taskId)   ← 事务外，读片段
if (segments.length === 0) throw ...
return writeTx(db, () => {
  // 只重判任务状态，不重判片段
  ...
})
```

**为什么是问题**：同一标注员的并发「删片段」可以在两次读之间落地
（那时任务仍是 `claimed`，`requireWritableTask` 会放行），
随后提交把**已删除的片段**写进快照与账本。

结果：快照里的片段数与当前片段列表不一致，账本金额与草稿对不上。
现有不变量（`listTaskBalanceMismatches`）只比账本与 submissions，抓不到。

**修法**：把读取挪进事务。

```ts
return writeTx(db, () => {
  const task = requireWritableTask(db, actor, taskId);   // 事务内重判
  const segments = listByTask(db, actor.tenantId, taskId);
  if (segments.length === 0) throw new StateConflictError(EMPTY_SEGMENTS_MESSAGE);
  ...
});
```

**为什么这个修法对**：`writeTx` 是 `BEGIN IMMEDIATE`，写锁在事务开始时就拿到了。
并发删除要么在事务前完成（那这次提交读到的是删后的状态，正确），
要么等这次提交结束（那它删的是已提交任务的片段 —— 而 `deleteSegment` 要求 `claimed`，
此时任务已是 `submitted`，它会 404）。

**但注意**：`requireWritableTask` 会抛 `NotFoundError` / `StateConflictError`，
在事务内抛会正常回滚，行为与现在一致。

### 顺带加一条不变量

`invariants.ts` 加一条：**快照里的 segments_json 必须与提交时刻一致**——
但那个时刻过去了，没法验。所以改成验**可验的部分**：

```
对每条有有效提交的任务：
  快照的 total_ms 必须等于 segments_json 里各段之和
```

这条现在没验。它能抓到「写快照时算错金额」，而 `total_ms` 与 `delta_ms` 的一致性
是由另一条规则保证的 —— 两条一起才能锁死。

---

## 2 视频时长完全信任客户端

**现状**（`api/videos/route.ts:66`、`video-service.ts:82`）：

```ts
const durationMs = Number(request.headers.get('x-duration-ms'));
// 只校验是正整数，没有上限，不与文件实际时长比对
```

而 `tasks.estimated_ms` 取自它，片段合法范围 `endMs <= task.estimated_ms` 也取自它。

**为什么是问题**：这是「工作量以毫秒计」系统里唯一防注水的闸门，却由上传方一句话决定。
声明 999 小时即可让标注员合法标出 999 小时。需要管理员权限，故列为低 ——
但管理员也可能填错。

**修法**：服务端解析 mp4 的 `moov` 读真实时长。

项目已经有读时长的能力（E1 的 `video.duration` 兜底、`fixtures/videos/pusht-pushblock.mp4`
就是 moov 在尾部的样本）。要点：

1. 解析 `ftyp` / `moov` / `mvhd`，取 `timescale` 与 `duration`，算毫秒
2. **moov 在尾部**也要能读（`pusht-pushblock.mp4` 就是这种）
3. 解析失败时**不接受上传**，报「无法读取视频时长」——
   宁可拒绝，也不要放一个 999 小时的时长进来
4. 客户端传的 `x-duration-ms` 只作为**交叉校验**：
   与服务端解析值差超过 2 秒就拒绝（说明客户端撒谎或文件不完整）

**上限**：`MAX_VIDEO_DURATION_MS = 4 小时`。超过拒绝。

**为什么要有上限**：一个 4 小时的视频，标注员标满也就是 4 小时；
但 999 小时会把这个租户的账本彻底搞乱，且统计上看不出来。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/submit-service.ts` | 读取挪进事务 |
| `src/lib/invariants.ts` / `invariant-repo.ts` | 加速照金额自洽 |
| `src/lib/mp4-duration.ts` | 解析 moov / mvhd（纯函数，接受 Buffer） |
| `src/lib/services/video-service.ts` | 用解析值，交叉校验 |
| `tests/submit-toctou.test.ts` / `tests/mp4-duration.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// lib/mp4-duration.ts
export type Mp4DurationResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: 'no-moov' | 'bad-mvhd' | 'zero-duration' | 'truncated' };

/**
 * 从 mp4 的字节里读时长。
 *
 * 必须支持 moov 在文件尾部（faststart 未开启的编码器都是这样，
 * fixtures 里的 pusht-pushblock.mp4 就是）。所以不能只读前 N 字节，
 * 要顺着 box 链走。
 *
 * 纯函数：接受整个 Buffer，不碰文件系统，便于单测。
 */
export function readMp4Duration(bytes: Uint8Array): Mp4DurationResult;
```

```ts
// services/video-service.ts
export const MAX_VIDEO_DURATION_MS = 4 * 60 * 60 * 1000;
/** 客户端声明值与服务端解析值允许的偏差 */
export const DURATION_TOLERANCE_MS = 2_000;
```

---

## 验收

**自动**

- [ ] TOCTOU：并发「删片段 + 提交」后，快照的 segments_json 与 segments 表一致
      （用真实的并发调用，不是模拟）
- [ ] TOCTOU 修复后，现有提交用例全绿（事务内抛错能正常回滚）
- [ ] 新不变量：快照 `total_ms` ≠ `segments_json` 各段之和 → 报错
- [ ] `readMp4Duration` 对 `fixtures/videos/aloha-coffee.mp4` 返回 30000±50ms
- [ ] 对 `fixtures/videos/pusht-pushblock.mp4`（moov 在尾部）返回正确时长
- [ ] 非 mp4 字节 → `no-moov`
- [ ] 截断的 mp4 → `truncated`，不抛
- [ ] 时长 > 4 小时 → 上传 400
- [ ] 客户端声明与服务端差 > 2 秒 → 上传 400
- [ ] 声明与服务端一致 → 上传成功，`estimated_ms` 用**服务端**的值
- [ ] 现有 782 例全绿

**手工**

- [ ] 上传一个真实 mp4（用 `fixtures/videos/aloha-coffee.mp4`），任务时长显示 30 秒
- [ ] 上传一个改过 `x-duration-ms` 的请求 → 被拒

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 只读文件前 64KB 找 moov | moov 在尾部时永远找不到（pusht 就是这种） |
| 解析失败时回落到客户端声明值 | 等于没做 |
| 用 `mvhd.duration / timescale` 时混淆整数与浮点 | 时长差几个数量级 |
| 事务内 `requireWritableTask` 抛错后没回滚 | 需要验证 `writeTx` 的异常路径 |
| 不变量只验 `total_ms` 与账本、不验与 `segments_json` | 抓不到「写快照时算错金额」 |

---

## 完成后

```bash
git add -A && git commit -m "fix(O3): 提交读取挪进事务，视频时长改为服务端解析"
```
