# C2 · 视频管理页

**做什么**：管理员上传视频、看已有视频列表。带上传进度与客户端预检。

**依赖**：C1

**预计**：0.5 小时

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/video-upload.ts` | 客户端用的纯函数：文件校验、读取时长、XHR 上传 |
| `src/app/admin/layout.tsx` | 管理员区外壳（侧栏/顶栏） |
| `src/app/admin/videos/page.tsx` | 页面（Server Component，`requireAdmin`） |
| `src/app/admin/videos/VideoManager.tsx` | 客户端组件：上传 + 列表 |
| `tests/video-upload.test.ts` | 纯函数部分 |

---

## 两个必须知道的技术事实

### 1. `fetch` 拿不到上传进度

`fetch` 的 `Response.body` 是**下载**流；上传过程完全不可观测。
要进度条只能用 `XMLHttpRequest` 的 `upload.onprogress`。

```ts
const xhr = new XMLHttpRequest();
xhr.upload.onprogress = (e) => {
  if (e.lengthComputable) onProgress(e.loaded / e.total);
};
xhr.open('POST', '/api/videos');
xhr.setRequestHeader('Content-Type', file.type);
xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
xhr.setRequestHeader('x-duration-ms', String(durationMs));
xhr.send(file);
```

不要为了「统一用 fetch」而放弃进度条——这是 API 能力边界，不是风格问题。

### 2. 不少 MP4 的 `duration` 是 `Infinity`

`<video>` 读到 `duration === Infinity` 通常意味着 **moov atom 在文件尾部**，
浏览器还没解析到。直接用它会让 `x-duration-ms` 变成 `"Infinity"`，服务端 `Number()` 得 `NaN`。

标准的绕法是「跳到一个极大的时间点，逼浏览器加载到文件尾」：

```ts
function readDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    const done = (ms: number) => {
      URL.revokeObjectURL(url);
      resolve(Math.round(ms));
    };

    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) {
        done(video.duration * 1000);
        return;
      }
      // moov 在尾部：逼浏览器 seek 到末尾以触发解析
      video.currentTime = 1e101;
      video.ontimeupdate = () => {
        video.ontimeupdate = null;
        done(video.duration * 1000);
      };
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取视频时长'));
    };
    video.src = url;
  });
}
```

---

## 契约

### `src/lib/video-upload.ts`

```ts
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const ACCEPTED_MIME = ['video/mp4'] as const;

export type FileCheck =
  | { ok: true }
  | { ok: false; reason: 'too-large' | 'bad-type' | 'empty' };

/** 纯函数，不碰 DOM，可在 node 环境测。 */
export function checkFile(file: { size: number; type: string }): FileCheck;

/** 浏览器 API，不写单测。 */
export function readDurationMs(file: File): Promise<number>;

export type UploadHandle = { promise: Promise<VideoSummary>; abort: () => void };

/** 浏览器 API，不写单测。失败时 reject 一个带中文 message 的 Error。 */
export function uploadVideo(
  file: File,
  durationMs: number,
  onProgress: (ratio: number) => void,
): UploadHandle;

export type VideoSummary = {
  id: string;
  filename: string;
  sizeBytes: number;
  durationMs: number;
  createdAt: number;
};
```

`checkFile` 返回**判别联合**而不是字符串：调用方在 switch 里穷尽三种原因，
文案映射就在 UI 一处。

---

## 页面要求

**布局**：沿用 `admin/layout.tsx` 的外壳，内容区一张表或卡片列表。

**列表每行**：文件名、时长（`mm:ss`）、大小（MB）、上传时间、操作（「去建任务」占位，D2 接）

**上传区**：
- 拖拽区 + 点击选择
- 选中后立即显示文件名、大小、读到的时长
- 预检失败（类型/大小/空文件）就地提示，不发请求
- 上传中显示百分比与进度条，按钮禁用
- 成功后就地插入列表顶部，不整页刷新
- 失败显示错误，可重试

**空态**：没有视频时给一句话 + 指向上传区，不要留一片空白。

---

## 验收

**自动**

- [ ] `checkFile` 对 `size = 0` 返回 `empty`
- [ ] `checkFile` 对 `size = MAX_UPLOAD_BYTES` 返回 `ok`（等于上限允许）
- [ ] `checkFile` 对 `size = MAX + 1` 返回 `too-large`
- [ ] `checkFile` 对 `type = 'video/webm'` 返回 `bad-type`
- [ ] `checkFile` 对 `type = 'video/mp4'` 与空 `type` 的行为明确（空 type 按 `bad-type`）
- [ ] `tsc`、`eslint`、`npm test` 全绿

**手工**

- [ ] 非管理员访问 `/admin/videos` → 跳 `/tasks`
- [ ] 上传一个正常 mp4 → 进度条从 0 走到 100%，列表顶部出现新行
- [ ] 上传一个 2MB 以内的文件时，进度条可见地分几段推进（不是瞬间 100%）
- [ ] 选一个 `.txt` 改后缀为 `.mp4` → 提示类型不支持，不发请求
- [ ] 选一个 300MB 文件 → 提示超过上限，不发请求
- [ ] 上传中重复点击 → 无第二个请求
- [ ] 刷新页面，新视频仍在列表

---

## 实测记录

| # | 场景 | 结果 |
|---|---|---|
| 1 | 管理员访问 `/admin` | 307 → `/admin/videos` |
| 2 | 管理员访问 `/admin/videos` | 200，页面含「视频管理」「demo.mp4」「00:40」 |
| 3 | 标注员访问 `/admin/videos` | 307 → `/tasks` |
| 4 | 上传 `encodeURIComponent('测试视频.mp4')` | 200，库中 `filename` 为 `测试视频.mp4`（不是 `%E6%B5%8B...`） |

**第 4 条暴露了 C1 的缺口**：客户端必须 `encodeURIComponent`（HTTP 头只能放 ASCII），
但 C1 的服务端没解码，中文名会原样存成百分号串。C2 一并补上解码，
并给非法编码加了 try/catch 兜底。

## 易错点

| 陷阱 | 后果 |
|---|---|
| 用 `fetch` 做上传 | 没有进度，只能显示「上传中…」转圈 |
| 直接用 `video.duration` | 遇到 moov 在尾部的 mp4 得到 `Infinity` → `x-duration-ms: Infinity` → 服务端 `NaN` → 400 |
| 忘记 `URL.revokeObjectURL` | 每读一次文件泄漏一个 blob，上传十几个后内存明显上涨 |
| `x-filename` 直接放中文 | HTTP 头必须是 ASCII，浏览器会抛错或乱码；用 `encodeURIComponent` 并在服务端解码 |
| 进度按 `loaded / total` 但 `lengthComputable` 为 false | 除以 0 得到 `NaN`，进度条宽度变成 `NaN%` |
| 上传成功后 `router.refresh()` | 整页重渲染，进度条闪一下才消失；应本地插入列表 |
| 预检只查大小不查类型 | 把 200MB 的 `.mov` 传上去，服务端才拒，白等一轮 |

---

## 完成后

```bash
git add -A && git commit -m "feat(C2): 视频管理页，带上传进度"
```
