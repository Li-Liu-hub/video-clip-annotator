# E1 · 片段区间校验

**做什么**：把标注员提交的一串时间区间校验成可入库的形态：排序、查重叠、算总时长。

**依赖**：无

**预计**：1 小时

**这是全项目最适合 TDD 的一块**：纯函数、无 I/O、无时间依赖、边界清晰。
先写测试，再写实现，不接受反过来的顺序。

---

## 规则来源

标注员做的事：在视频里标出「机器人真正在动」的片段，跳过静止、准备、人工干预的时段。

所以每个片段是一个 `[startMs, endMs)` 左闭右开区间，`endMs - startMs` 计入工作量。

写进库前必须保证：区间在视频范围内、不为空、互不重叠。
否则账本会算出比视频还长的工作量。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/segment-interval.ts` | `normalizeSegments`，纯函数零依赖 |
| `tests/segment-interval.test.ts` | **先写，后实现** |

---

## 契约（不可改动）

```ts
export type Segment = { startMs: number; endMs: number };

/** 短于这个长度的片段视为误触。 */
export const MIN_SEGMENT_MS = 200;

/** 单次提交的片段数上限，防滥用。 */
export const MAX_SEGMENTS = 100;

export type SegmentIssue =
  | { code: 'empty' }                          // 一个片段都没有
  | { code: 'too-many'; count: number }        // 超过上限
  | { code: 'not-finite'; index: number }      // NaN / ±Infinity
  | { code: 'negative'; index: number }        // startMs < 0
  | { code: 'reversed'; index: number }        // startMs >= endMs
  | { code: 'out-of-range'; index: number }    // endMs > durationMs
  | { code: 'too-short'; index: number }       // 长度 < MIN_SEGMENT_MS
  | { code: 'overlap'; index: number; previousIndex: number };

export type NormalizeResult =
  | { ok: true; segments: Segment[]; totalMs: number }
  | { ok: false; issue: SegmentIssue };

/**
 * 校验并规范化片段列表。
 * 成功时 segments 按 startMs 升序返回，totalMs 为各段长度之和。
 * 失败时返回第一个问题，index 均为**入参数组的下标**。
 */
export function normalizeSegments(
  raw: readonly Segment[],
  durationMs: number,
): NormalizeResult;
```

---

## 校验顺序（顺序本身是契约的一部分）

```
1. 数组为空                → empty
2. 数量 > MAX_SEGMENTS     → too-many
3. 逐项检查（按入参顺序）：
   not-finite → negative → reversed → out-of-range → too-short
   同一项命中多个问题时，返回**先命中的那个**
4. 排序（按 startMs）
5. 相邻扫描查重叠
   重叠 → overlap，index 是后一段的原始下标，previousIndex 是前一段的原始下标
```

**为什么逐项检查要先于排序**：排序会把非法值（NaN）放到不可预期的位置，
先校验才能保证排序阶段的数据是干净的。

**为什么错误带原始下标**：标注员看到「第 3 段太短」才能回去改第 3 段。
如果报排序后的位置，他找的是另一段。

---

## 边界判定表

`durationMs = 30_000`（30 秒），`MIN_SEGMENT_MS = 200`。

| # | 输入 | 期望 | 理由 |
|---|---|---|---|
| 1 | `[]` | `empty` | 没有可提交的内容 |
| 2 | `[{0, 1000}]` | ok，total 1000 | 正常 |
| 3 | `[{0, 0}]` | `reversed` @0 | 零长度视为起点不早于终点 |
| 4 | `[{1000, 500}]` | `reversed` @0 | 终点在起点前 |
| 5 | `[{-100, 500}]` | `negative` @0 | 起点越界 |
| 6 | `[{0, 30001}]` | `out-of-range` @0 | 终点超出视频 |
| 7 | `[{0, 30000}]` | ok | 终点**等于**时长合法（左闭右开） |
| 8 | `[{0, 199}]` | `too-short` @0 | 短于 200ms |
| 9 | `[{0, 200}]` | ok | 恰好 200ms 合法 |
| 10 | `[{NaN, 1000}]` | `not-finite` @0 | — |
| 11 | `[{0, Infinity}]` | `not-finite` @0 | — |
| 12 | `[{5000, 9000}, {1000, 3000}]` | ok，**返回顺序被重排**为 `[1000-3000, 5000-9000]` | 输出恒有序 |
| 13 | `[{0, 2000}, {1000, 3000}]` | `overlap` @1 prev=0 | 有交集 |
| 14 | `[{0, 2000}, {2000, 4000}]` | **ok**，total 4000 | 端点相接不算重叠 |
| 15 | `[{1000, 3000}, {0, 2000}]`（乱序但重叠） | `overlap`：index=0（原下标），prev=1 | 排序后再判，但报原始下标 |
| 16 | `[{0, 2000}, {2000, 4000}, {4000, 6000}]` | ok，total 6000 | 多段相接 |
| 17 | 101 个合法片段 | `too-many` | 上限 |
| 18 | `durationMs = 0`，`[{0, 100}]` | `out-of-range` @0 | 空视频没有可标内容 |
| 19 | `[{5000, 6000}, {5000, 6000}]` | `overlap` @1 prev=0 | 完全重复 |

**第 14 条是最容易写错的**：`[{0,2000}, {2000,4000}]` 两个区间端点相接，
按左闭右开语义并集是 `[0,4000)`，没有任何一毫秒被算两次，**必须放行**。
判据用 `cur.startMs < prev.endMs`（严格小于），不是 `<=`。

---

## 实现要点

### 1. 重叠判据用严格小于

```ts
if (cur.startMs < prev.endMs) → overlap
```

- `cur.start < prev.end`：有交集 → 拒绝
- `cur.start === prev.end`：首尾相接 → 放行

写成 `<=` 会把所有正常的多段标注全部打回——标注员通常会连续标多个片段。

### 2. 输出必须是新数组，且不修改入参

`raw.sort()` 会原地排序调用方的数组。用 `[...raw].sort(...)` 或 `toSorted`。

标注员正在编辑的数组被校验函数偷偷改序，UI 上的片段会跳来跳去。

### 3. `totalMs` 用整数累加

毫秒是整数，但浮点输入（`1.5`）能通过 `Number.isFinite`。
入口处不做四舍五入，由调用方保证整数；这里只用 `end - start` 求和，
结果若是小数就说明调用方传错了，**不要静默 round**。

### 4. 重叠检测要带原始下标

```ts
const indexed = raw.map((seg, i) => ({ seg, i }));
// 排序
indexed.sort((a, b) => a.seg.startMs - b.seg.startMs);
// 扫描
for (let k = 1; k < indexed.length; k++) {
  const prev = indexed[k - 1].seg;
  const cur = indexed[k].seg;
  if (cur.startMs < prev.endMs) {
    return { ok: false, issue: { code: 'overlap', index: indexed[k].i, previousIndex: indexed[k - 1].i } };
  }
}
```

注意 `index` 是 `indexed[k].i`（原始下标），不是 `k`。

### 5. 返回的 `segments` 是排序后的副本

不要再把 `indexed` 里的对象引用直接返回——调用方拿到后若修改，
会同时改掉它自己传进来的对象。

```ts
return { ok: true, segments: indexed.map(({ seg }) => ({ startMs: seg.startMs, endMs: seg.endMs })), totalMs };
```

---

## 验收

全部是自动化断言，没有手工项：

- [ ] 边界表 19 条逐条覆盖
- [ ] 输入数组在调用后**顺序不变**（不被原地排序）
- [ ] 返回的 `segments` 与入参对象**不是同一个引用**
- [ ] 修改返回的 `segments` 不影响入参
- [ ] `totalMs` 等于各段长度之和
- [ ] 现有 328 例全绿

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 重叠判据写成 `<=` | 所有多段标注被打回，标注员无法提交 |
| `raw.sort()` 原地排序 | 校验函数改了调用方的数组，UI 片段顺序跳变 |
| 返回 `indexed` 里的对象引用 | 调用方修改返回值会污染自己的入参 |
| 报排序后的下标而非原始下标 | 错误提示指向错误的片段 |
| 不判 `Number.isFinite` | `NaN` 参与比较恒 false，能一路穿透到 `totalMs` 变成 NaN |
| 静默 `Math.round` | 浮点输入被悄悄修正，问题在账本里才暴露 |

---

## 完成后

```bash
git add -A && git commit -m "feat(E1): 片段区间校验，纯函数 TDD"
```

**下一步**：E2 标注编辑器（把这个函数接进 UI）。
