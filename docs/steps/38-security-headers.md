# O4 · 安全响应头

**做什么**：给全部响应加四条头，封住点击劫持与 MIME 嗅探。

**依赖**：—

**预计**：0.5 小时

---

## 为什么现在做

AUDIT §6 从全量扫描那轮就记着这条，但一直没进 INDEX 的未修项表 ——
等于「知道，但不占账」。管理端的「退回」不可撤销，被 iframe 套一层透明覆盖就能骗管理员点下去；
`SameSite=Lax` 拦不住同站请求伪造，因为点击是用户自己发出的。

## 加什么

```
X-Frame-Options: DENY
Content-Security-Policy: frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
```

`frame-ancestors` 是现代口径，`X-Frame-Options` 兜旧浏览器；两条一起给不冲突。

## 为什么不写完整 CSP

Next 的运行时需要 inline script。没有 nonce 基础设施时上严格 CSP，
结果只会是「样式与 hydration 一起挂」，然后有人加 `unsafe-inline` 把它变回装饰品。
这一轮只封「被嵌框」一条：收益明确、代价为零，剩下的等有 nonce 管线再说。

## 产出

| 文件 | 说明 |
|---|---|
| `next.config.ts` | `headers()` 返回全路径规则 |
| `tests/next-config.test.ts` | 直接调用 `headers()`，钉住四条值与作用范围 |

## 验收

- [x] `headers()` 只有一条规则，`source = /:path*`
- [x] 四条头的值与预期一致
- [x] 变异：把 `source` 改成 `/admin/:path*` → 恰好 1 例红
- [x] 实测：`curl -I /login` 四条头都在（见 REPORT）

## 易错点

| 陷阱 | 后果 |
|---|---|
| 只给 `/admin` 加 | 工作台也能被嵌，管理员只是其中一类受害者 |
| 只写 X-Frame-Options | 现代浏览器按 CSP 优先，缺少 frame-ancestors 时行为不一致 |
| 顺手加完整 CSP + unsafe-inline | 看起来有 CSP，实际等于没写 |
| 把 `nosniff` 加到视频流之外又改 Content-Type | 浏览器拒绝渲染；本项目流接口的 MIME 本来就是 video/mp4，不存在这个问题 |

---

## 完成后

```bash
git add -A && git commit -m "feat(O4): 全站安全响应头，封住 iframe 嵌套与 MIME 嗅探"
```
