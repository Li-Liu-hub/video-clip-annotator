# STEP 03 · 视频资产与上传

**目标**：管理员能上传视频，有权限的人能播放（支持拖动进度条）。

**前置**：02 完成（需要登录态判断权限）

**预计**：1.5 小时

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/videoService.ts` | 上传、列表、按 id 取 |
| `src/app/api/videos/route.ts` | `POST` 上传 / `GET` 列表 |
| `src/app/api/videos/[id]/stream/route.ts` | `GET` Range 播放 |
| `src/app/admin/videos/page.tsx` | 上传界面 |
| `src/components/admin/UploadPanel.tsx` | 带进度的上传组件 |

---

## 关键实现

### 1. 上传：流式写入，不经过内存

前端用 `XMLHttpRequest`（需要 `upload.onprogress`），把 `File` 直接作为 body：

```ts
const xhr = new XMLHttpRequest();
xhr.open('POST', '/api/videos');
xhr.setRequestHeader('Content-Type', 'video/mp4');
xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
xhr.setRequestHeader('X-Duration-Ms', String(durationMs));
xhr.upload.onprogress = (e) => setProgress(e.loaded / e.total);
xhr.send(file);
```

后端不解析 multipart，直接接原始流：

```ts
const stream = Readable.fromWeb(request.body as ReadableStream);
await pipeline(stream, createWriteStream(tmpPath));
```

**不要用 `request.formData()`**。它会把整个文件读进内存或临时文件，500MB 会出问题。

### 2. 校验顺序

```
① 检查 Content-Length（或读取计数）→ 超 500MB 立即 413，销毁临时文件
② 检查 X-Filename 扩展名
③ 读前 12 字节，校验 MP4 魔数（第 4–7 字节是 'ftyp'）
④ 写入完成后校验 X-Duration-Ms 合理性（>0 且 < 86400000）
⑤ rename 到正式路径
⑥ INSERT videos + INSERT audit_logs
```

**先写临时文件，校验通过再 rename**。这样磁盘上不会出现「半截的正式文件」。

### 3. Range 播放（本步最容易出错的地方）

`<video>` 拖动进度条会发 `Range` 请求，服务端必须正确响应 `206`，否则无法拖动。

```ts
const range = request.headers.get('range');
const stat = fs.statSync(filePath);
const size = stat.size;

if (!range) {
  // 全量返回
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size),
               'Accept-Ranges': 'bytes' },
  });
}

const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
if (!m) return new Response(null, { status: 416 });

let start = m[1] ? Number(m[1]) : 0;
let end = m[2] ? Number(m[2]) : size - 1;

// 处理 "bytes=-1024"（最后 N 字节）：此时 m[1] 为空，m[2] 有值
if (!m[1] && m[2]) {
  start = Math.max(0, size - Number(m[2]));
  end = size - 1;
}

if (start >= size || end >= size || start > end) {
  return new Response(null, {
    status: 416,
    headers: { 'Content-Range': `bytes */${size}` },
  });
}

return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
  status: 206,
  headers: {
    'Content-Type': 'video/mp4',
    'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
  },
});
```

**三个必须做对的点**

1. `Content-Length` 是 `end - start + 1`，不是 `size`
2. 越界必须返回 `416` 且带 `Content-Range: bytes */<size>`
3. `bytes=-N` 是「最后 N 字节」，不是「从 -N 开始」——这个反向语义最容易写错

### 4. 权限：视频流必须过鉴权

```ts
// video 本身不绑租户，通过 task 反查
const allowed = await canAccessVideo(db, user, videoId);
if (!allowed) return new Response(null, { status: 404 });  // 不是 403
```

管理员：全部可看。
标注员：只有自己租户下有任务引用该视频时可看。

**返回 404 不返回 403**：403 等于告诉对方「这个视频存在但不给你看」，泄露了资源存在性。

### 5. 为什么不能放 `public/`

Next 会把 `public/` 下的文件当静态资源直接服务，**任何人知道 URL 就能下载，鉴权形同虚设**。
所以视频存 `data/videos/`，必须经过上面的路由。

---

## 验收标准

- [ ] 上传一个 10 MB 的 mp4，进度条走完，列表出现条目
- [ ] 上传 `.txt` 改名为 `.mp4` → 被魔数校验拒绝（415）
- [ ] 上传超过 500MB → 413，且 `data/videos/` 里没有残留临时文件
- [ ] 在 `<video>` 里拖动进度条，Network 面板出现 `206` 响应
- [ ] `curl -H "Range: bytes=0-1023" .../stream -I` 返回 `206` 且 `Content-Range` 正确
- [ ] `curl -H "Range: bytes=0-" .../stream -I` 返回 `206`
- [ ] 标注员 alice 用 carol 租户的视频 id 请求 → `404`

---

## 容易错的地方

| 陷阱 | 后果 |
|---|---|
| 用 `formData()` 读上传 | 500MB 时 OOM |
| `Content-Length` 用了 `size` 而非区间长度 | 视频播放卡住或截断 |
| 没处理 `bytes=-N` 反序语义 | Safari 播放异常（它会发这种请求） |
| 视频放 `public/` | 绕过全部权限 |
| 校验前就 rename 到正式路径 | 磁盘上留下无法识别的坏文件 |
| 流式读取没设 `Content-Type` | 浏览器当二进制下载而不是播放 |

---

## 完成后

管理员能上传、能预览。标注端还不能用（任务还没做完），下一步把任务串起来。
