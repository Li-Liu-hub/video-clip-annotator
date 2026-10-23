# C1 · 视频上传与播放

**做什么**：流式上传 + 支持拖动的播放。视频存在 `data/videos/`，由带鉴权的路由提供。

**依赖**：B3

**预计**：1.5 小时

---

## 为什么视频不能放 `public/`

静态目录意味着**知道 URL 就能下载**，租户隔离形同虚设。
所以视频存 `data/videos/`，通过 `/api/videos/:id/stream` 提供，每次请求校验身份。

代价是要自己实现 HTTP Range——不做的话，视频能播但不能拖进度条。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/video-range.ts` | Range 头解析，**纯函数** |
| `src/lib/db/repos/video-repo.ts` | videos 表读写 |
| `src/lib/services/video-service.ts` | 上传落盘、鉴权 |
| `src/app/api/videos/route.ts` | POST 上传 / GET 列表 |
| `src/app/api/videos/[id]/stream/route.ts` | GET 播放，支持 Range |
| `tests/video-range.test.ts` | 新增 |

---

## 契约（不可改动）

### `src/lib/video-range.ts`

```ts
export type RangeResult =
  | { kind: 'full' }                              // 无 Range 或无法解析 → 返回整个文件
  | { kind: 'partial'; start: number; end: number } // 闭区间，字节下标
  | { kind: 'unsatisfiable' };                    // 语法合法但范围越界 → 416

export function parseRange(header: string | null, size: number): RangeResult;
```

**只支持单段 Range。** 多段（`bytes=0-99,200-299`）按 `full` 处理——浏览器播视频不会发多段。

### `src/lib/services/video-service.ts`

```ts
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;   // 200 MB

export type UploadInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  stream: ReadableStream<Uint8Array>;
};

/** 写盘并落库。调用方必须已确认是管理员。 */
export function storeVideo(db: DB, actor: SessionUser, input: UploadInput): VideoRow;

/** 取可播放的视频。无权限与不存在都抛 NotFoundError（不泄露存在性）。 */
export function openVideoForRead(db: DB, actor: SessionUser, videoId: string): VideoRow;
```

### 路由

**POST `/api/videos`**（仅管理员）

```
Headers: content-type: video/mp4
         x-filename: demo.mp4
         x-duration-ms: 40000
Body:    文件二进制

200 { ok: true, video: { id, filename, sizeBytes, durationMs, createdAt } }
400 缺少 x-duration-ms / 类型不支持
401/403 未登录或非管理员
413 超过 MAX_VIDEO_BYTES
```

**GET `/api/videos/:id/stream`**

```
无 Range          → 200 + Content-Length + Accept-Ranges: bytes
Range: bytes=0-99 → 206 + Content-Range: bytes 0-99/<size> + Content-Length: 100
Range 越界        → 416 + Content-Range: bytes */<size>
无权限 / 不存在    → 404
```

**GET `/api/videos`**（登录即可，只列自己有权限看的）

---

## 实现要点

### 1. 上传必须真流式

```ts
// ✗ 把 200MB 读进内存，一次请求就能打爆进程
const buf = Buffer.from(await request.arrayBuffer());

// ✓ 边读边写
await pipeline(Readable.fromWeb(input.stream), createWriteStream(finalPath));
```

**判据**：上传过程中进程内存不随文件大小线性增长。

### 2. 文件名不进路径

用户给的 `filename` 只存进数据库做展示。磁盘路径用服务端生成的 id：

```ts
const storedName = `${videoId}.mp4`;
```

否则 `x-filename: ../../.env` 就能覆盖任意文件。

扩展名也要按 `mime-type` 白名单推导，不信任 `filename` 的后缀。

### 3. 先写临时文件再 rename

```ts
const tmp = `${finalPath}.part`;
await pipeline(stream, createWriteStream(tmp));
await rename(tmp, finalPath);   // 同分区内原子
```

中途失败留下 `.part` 而不是半个「正常」文件。否则播放时 `Content-Length` 与实际字节数不符，浏览器会卡死。

### 4. Range 解析的三条规则

```
bytes=0-99      → { start: 0, end: 99 }
bytes=100-      → { start: 100, end: size-1 }      // 省略末尾 = 到文件尾
bytes=-500      → { start: size-500, end: size-1 } // 后缀形式：最后 500 字节
bytes=0-999999  → end 钳到 size-1，不是 416
bytes=999999-   → 416（start >= size）
```

**末尾越界要钳位而不是报错**：客户端常发 `bytes=0-` 或按估算长度请求，
钳位后返回实际范围是标准行为。

### 5. 206 响应必须带 `Content-Range`

格式：`bytes <start>-<end>/<total>`。少了它浏览器不知道拿到的是哪一段，会一直重试。

`Content-Length` 必须是 `end - start + 1`，不是文件总长。

### 6. 视频鉴权：能看「自己租户任务用到的视频」

`videos` 表没有 `tenant_id`（视频是共享资产）。判定规则：

- 管理员：全部可看
- 标注员：`EXISTS (SELECT 1 FROM tasks WHERE tasks.video_id = videos.id AND tasks.tenant_id = actor.tenantId)`

无权限与不存在**都返回 404**，不返回 403。

### 7. 时长的来源

服务端不调 `ffprobe`（会引入外部依赖，破坏「一键运行」）。
时长由客户端在上传前用 `<video>` 元素读出，放在 `x-duration-ms` 头里。

**这是信任边界上的妥协**：标注员能看到错误时长（比如把 40s 说成 1h），
但他改不了别人的数据，且片段端点由 `segments` 表约束。做法记在 `report.md` 的已知缺口里。

---

## 验收

- [ ] `parseRange(null, 1000)` → `{ kind: 'full' }`
- [ ] `parseRange('bytes=0-99', 1000)` → `{ start: 0, end: 99 }`
- [ ] `parseRange('bytes=100-', 1000)` → `{ start: 100, end: 999 }`
- [ ] `parseRange('bytes=-500', 1000)` → `{ start: 500, end: 999 }`
- [ ] `parseRange('bytes=0-99999', 1000)` → `{ start: 0, end: 999 }`（钳位）
- [ ] `parseRange('bytes=1000-', 1000)` → `unsatisfiable`
- [ ] `parseRange('bytes=abc', 1000)` → `full`（无法解析按完整返回）
- [ ] `parseRange('bytes=0-99,200-299', 1000)` → `full`（多段不支持）
- [ ] `parseRange('bytes=-0', 1000)` → `unsatisfiable`
- [ ] 上传非管理员 → 403
- [ ] 上传超限 → 413
- [ ] 上传后文件落在 `data/videos/<id>.mp4`，无 `.part` 残留
- [ ] 播放带 Range 返回 206 且 `Content-Range` 正确
- [ ] 播放无 Range 返回 200 且 `Accept-Ranges: bytes`
- [ ] 标注员访问其他租户的视频 → 404
- [ ] 现有 177 例全绿

---

## 实测记录

`npx next dev` + curl，用 152KB 的 `demo.mp4`：

| # | 请求 | 结果 |
|---|---|---|
| 1 | POST `/api/videos`（admin） | 200，id 为 16 位 hex，落盘 `data/videos/<id>.mp4`，无 `.part` 残留 |
| 2 | GET 无 Range | 200，`Accept-Ranges: bytes`、`Content-Length: 155646`、`Content-Type: video/mp4` |
| 3 | `Range: bytes=0-99` | 206，`Content-Range: bytes 0-99/155646`、`Content-Length: 100` |
| 4 | `Range: bytes=0-` | 206，`Content-Range: bytes 0-155645/155646`（**不是 416**） |
| 5 | `Range: bytes=999999-` | 416，`Content-Range: bytes */155646` |
| 6 | 标注员访问未关联任务的视频 | 404 |
| 7 | 标注员访问随机 id | 404，**与 6 的响应逐字节相同** |

**第 3 条特意验了字节内容**：响应头正确但偏移算错的实现能骗过前者，
把返回的 100 字节与原文件前 100 字节 `cmp` 才证明偏移真的对。

**第 7 条是存在性保护的实证**：两份 404 去掉 `Date` 头后 `diff` 为空——
攻击者无法区分「这个视频属于别人」与「这个视频不存在」。

## 易错点

| 陷阱 | 后果 |
|---|---|
| `await request.arrayBuffer()` | 200MB 进内存，并发几个请求进程就 OOM |
| 用 `x-filename` 拼路径 | `../../.env` 覆盖任意文件 |
| 不走 `.part` 临时文件 | 中途失败留下半截文件，播放时长度不符卡死 |
| Range 末尾不钳位 | 客户端请求 `bytes=0-` 得到 416，视频完全不能播 |
| 206 缺 `Content-Range` | 浏览器无限重试，表现为「一直在加载」 |
| `Content-Length` 用了文件总长 | 浏览器读满后继续等，进度条卡在开头 |
| 跨租户返回 403 | 泄漏「这个视频存在」 |
| 播放路由忘了 `runtime = 'nodejs'` | Edge runtime 没有 `fs`，构建或运行时报错 |

---

## 完成后

```bash
git add -A && git commit -m "feat(C1): 流式上传与 Range 播放"
```
