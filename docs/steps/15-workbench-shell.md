# E1 · 工作台骨架与视频播放器

**做什么**：标注员点开自己领取的任务，进到一个能看视频、能播放暂停的页面。
时间轴和片段列表先留占位，E2 填。

**依赖**：D3

**预计**：0.5 小时

---

## 这条线的关键：播放器不能随便换

E2 要在视频上方画时间轴，时间轴与播放头必须**共用同一份播放状态**
（当前时间、总时长、是否在播）。

所以 E1 不能用原生 `controls`——那套控件是浏览器自己管的，
拿不到它内部的状态，E2 必然要推倒重来。

E1 就要把 `<video>` 当作受控元素：

```tsx
<video ref={videoRef} src={streamUrl} preload="metadata" />
```

控件自己画：播放/暂停一个按钮，时间显示一个文本。E2 在此基础上加时间轴。

---

## 权限：只认「自己领取的、且还没提交」

| 情况 | 行为 |
|---|---|
| 本租户、`claimed`、`claimed_by` 是自己 | 正常进入 |
| 本租户、`pending`（还没领） | 404——没有任务归属，不该有工作台 |
| 本租户、别人领取 | 404——不泄漏别人在做哪条 |
| 其他租户 | 404 |
| `submitted` / `rejected` | 404（E3 做只读回顾） |
| 管理员 | 307 跳 `/admin/tasks` |

**全部用 404，不用 403**：与 D1/D3 一致，不泄漏任务是否存在。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/workbench-service.ts` | `getWorkTask`，含归属校验 |
| `src/app/api/tasks/[id]/work/route.ts` | GET 返回任务与视频信息（可选，页面直取即可） |
| `src/app/tasks/[id]/work/page.tsx` | 页面（Server Component） |
| `src/app/tasks/[id]/work/Workbench.tsx` | 客户端组件：播放器 + 占位 |
| `tests/workbench.test.ts` | 归属校验的 6 条 |

---

## 契约（不可改动）

### `src/lib/services/workbench-service.ts`

```ts
export type WorkTask = {
  id: string;
  title: string;
  description: string | null;
  status: 'claimed';
  durationMs: number;
  videoFilename: string;
  streamUrl: string;
};

/** 取工作台任务。不是自己领取的、状态不对的，一律 NotFoundError。 */
export function getWorkTask(db: DB, actor: TenantUser, taskId: string): WorkTask;
```

`streamUrl` 由 service 拼：`/api/videos/${videoId}/stream`。
**放在 service 而不是页面**：客户端组件不该知道存储路径的拼法。

---

## 实现要点

### 1. `<video>` 同源请求会自动带上 Cookie

流式接口靠 session 鉴权，而 `<video src>` 发出的请求与页面同源，
浏览器会自动附上 Cookie——**不需要额外签 token，也不要改成 blob URL**。

用 blob URL 的做法（先 fetch 再 createObjectURL）会把整个视频读进内存，
还会失去 Range 支持，拖动进度条就废了。

### 2. `duration` 可能读到 `Infinity`

moov 在文件尾部的 mp4（仓库里的 `pusht-pushblock.mp4` 就是），
`loadedmetadata` 时 `video.duration` 可能是 `Infinity`。

显示层必须兜住：

```tsx
const duration = Number.isFinite(video.duration) ? video.duration : durationMs / 1000;
```

`durationMs` 来自服务端（建任务时写入的），作为兜底值。

### 3. 播放状态用事件驱动，不要轮询

```tsx
useEffect(() => {
  const v = videoRef.current;
  if (!v) return;
  const onTime = () => setCurrentMs(v.currentTime * 1000);
  const onPlay = () => setPlaying(true);
  const onPause = () => setPlaying(false);
  const onEnded = () => setPlaying(false);
  v.addEventListener('timeupdate', onTime);
  v.addEventListener('play', onPlay);
  v.addEventListener('pause', onPause);
  v.addEventListener('ended', onEnded);
  return () => { /* 全部 removeEventListener */ };
}, []);
```

`timeupdate` 频率约 4Hz，对时间显示够用。E2 做播放头动画时应改用
`requestAnimationFrame` 读 `currentTime`，否则播放头会一顿一顿。

### 4. 切换任务要重置播放器

同一组件复用时 `<video>` 的 `src` 变了，但 `currentTime` 不会自动归零。
用 `key={task.id}` 强制重建，或在 `src` 变化时手动 `load()`。

### 5. 卸载时暂停

离开页面时浏览器会自动停，但组件在内存里留着一个仍在缓冲的 video 会占用带宽。
`useEffect` 的 cleanup 里 `v.pause()`。

---

## 页面要求

**布局**：

```
┌────────────────────────────────────────────────┐
│ ← 任务列表   任务标题                  [已领取] │
├──────────────────────────────┬─────────────────┤
│                              │  片段           │
│        视频播放器              │  （E2 填充）    │
│                              │                 │
│  ▶  00:03 / 00:30            │                 │
├──────────────────────────────┴─────────────────┤
│  时间轴占位（E2 填）                            │
└────────────────────────────────────────────────┘
```

- 视频区最大宽度自适应，保持 16:9 或原始比例
- 播放/暂停按钮在视频下方左侧，时间在其右侧（`tnum` 等宽）
- 右侧片段栏宽 280px，空态写「还没有片段」
- 底部时间轴占位高 64px，虚线边框，居中写「时间轴（下一版）」
- 顶部返回链接回 `/tasks`

**视觉**：沿用暗色工作台基调，视频区用 `--color-void` 作背景。

---

## 验收

**自动**

- [ ] 自己领取的 `claimed` 任务能取到 `WorkTask`
- [ ] `pending` 任务 → `NotFoundError`
- [ ] 别人领取的任务 → `NotFoundError`
- [ ] 其他租户的任务 → `NotFoundError`
- [ ] `submitted` 任务 → `NotFoundError`
- [ ] `streamUrl` 形如 `/api/videos/<id>/stream`
- [ ] 现有 350 例全绿

**手工**

- [ ] 从 `/tasks` 点「继续标注」进入工作台
- [ ] 视频能播放、暂停、拖动进度条
- [ ] 时间显示随播放更新
- [ ] 用 `pusht-pushblock.mp4` 建的任务能正常播放（moov 在尾部）
- [ ] 直接访问别人的任务 URL → 404 页
- [ ] 管理员访问 → 跳到 `/admin/tasks`

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 用原生 `controls` | E2 拿不到内部状态，时间轴做不了，必然重写 |
| 先把视频 fetch 成 blob 再播 | 200MB 进内存，且失去 Range，拖动失效 |
| `duration` 直接显示 | moov 在尾部时显示 `Infinity` 或 `NaN` |
| 忘记 removeEventListener | 切换任务后旧监听仍在，状态错乱 |
| 组件复用不重置 | 换任务后进度条停在上一段位置 |
| 用 `setInterval` 轮询 `currentTime` | 播放头卡顿，且离开页面后定时器还在烧 |

---

## 实测记录

| # | 场景 | 结果 |
|---|---|---|
| 1 | 标注员访问自己领取的任务 | 200，页面含 `video`、`type="range"`、`/api/videos/<id>/stream` |
| 2 | 视频流 Range | 206，`Content-Range: bytes 0-1023/2012705` |
| 3 | 访问同租户同事领取的任务 | 404 |
| 4 | 访问本租户 `pending` 任务 | 404 |
| 5 | 管理员访问工作台 | 307 → `/admin/tasks` |

## 文档里的一处自相矛盾（实现时发现）

硬要求写「禁用原生 `controls`」，手工验收写「能拖动进度条」——
两者冲突：没有原生控件、时间轴又是空占位，页面上**根本没有可拖的东西**。

而标注必须能定位到视频任意时刻，否则工作台没有意义。

已补一个最简 `<input type="range">` 作为临时进度条（`seek()` 设 `currentTime`），
E2 的时间轴会取代它。代码里注明了「届时删掉这个 input 与 seek」。

教训：写「禁用某种做法」的硬要求时，要检查验收项是否还依赖被禁掉的东西。

## 完成后

```bash
git add -A && git commit -m "feat(E1): 工作台骨架与视频播放器"
```

**下一步**：E2 时间轴渲染。
