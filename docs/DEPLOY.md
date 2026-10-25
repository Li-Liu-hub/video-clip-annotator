# 部署：子路径 `/vsap/`

当前演示入口：<http://49.234.49.192/vsap/login>（HTTP，仅演示，勿放真实数据）。

## 为什么是子路径

- 服务器的公网只放行了 80 / 22；8080 在云安全组层面就不通，UFW 放行也没用。
- 80 已经被一个 Docker nginx（`ap-nginx`）占用，根路径是既有的展示站，不能动。
- 用域名指到这台机器会被 DNSPod 的未备案拦截（`/login` 直接 302 到 webblock），
  所以不能用 `nip.io` 之类的通配域名，只能用 **IP + 路径**。
- 结论：在既有的 80 端口 nginx 上加一个 `location /vsap/`，应用以 `basePath` 运行。

## 拓扑

```
浏览器 http://49.234.49.192/vsap/...
  └─ Docker nginx (ap-nginx, 端口 80)
       └─ location /vsap/ → http://172.28.0.1:3000
            └─ systemd: vsap.service
                 └─ next start -H 0.0.0.0 -p 3000
                      └─ SQLite /opt/vsap/data/app.db
```

`172.28.0.1` 是 Docker 网桥网关；容器里访问宿主机的 3000 走这个地址。
宿主机的 3000 只对 `172.28.0.0/16` 放行（UFW），外网仍然不可达。

## 两个必须成对设置的环境变量

| 变量 | 值 | 什么时候 |
|---|---|---|
| `NEXT_PUBLIC_BASE_PATH` | `/vsap` | **构建时和运行时都要**。Next 启动时会重新读 `next.config.ts`；只在构建时设，运行时会退回根路径，表现为 `/vsap/login` 404、`/login` 200 |
| `SESSION_COOKIE_SECURE` | `0` | 仅限没有 TLS 的演示。默认生产会带 `Secure`，HTTP 下浏览器不保存，表现为登录接口 200、下一跳又回登录页。上 HTTPS 后删掉这一行 |

## systemd

`/etc/systemd/system/vsap.service`：

```ini
[Service]
User=ubuntu
WorkingDirectory=/opt/vsap
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DATABASE_PATH=/opt/vsap/data/app.db
Environment=NEXT_PUBLIC_BASE_PATH=/vsap
Environment=SESSION_COOKIE_SECURE=0
ExecStart=/opt/node22/bin/node node_modules/next/dist/bin/next start -H 0.0.0.0 -p 3000
Restart=always
```

## nginx（既有 80 端口容器）

`/opt/agent-platform/nginx/nginx.conf` 的 `server { listen 80; ... }` 里追加：

```nginx
location = /vsap {
    return 301 /vsap/;
}

location /vsap/ {
    proxy_pass http://172.28.0.1:3000;   # 不带 URI，保留 /vsap/ 前缀
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    client_max_body_size 512m;
}
```

改完：

```bash
sudo docker exec ap-nginx nginx -t
sudo docker exec ap-nginx nginx -s reload
```

## 重建 / 更新

```bash
# 本地打包（排除依赖、构建产物与数据）
tar --exclude=node_modules --exclude=.next --exclude=.git --exclude=data \
    -czf /tmp/vsap-src.tgz .
# 传到服务器后
tar -xzf /tmp/vsap-src.tgz -C /opt/vsap
cd /opt/vsap
NEXT_PUBLIC_BASE_PATH=/vsap npm run build
sudo systemctl restart vsap
```

首次部署还需要 `npm ci` 与 `DEMO_LOGIN=1 npm run db:reset`；Node 装在 `/opt/node22`。

## 数据与备份

- 库：`/opt/vsap/data/app.db`（WAL 模式，备份要连同 `-wal/-shm` 一起，或先停服务）。
- 视频：`/opt/vsap/data/videos/`。
- 既有站点与容器不受影响；`/vsap/` 只是新增了一个 location。

## 注意

- 当前是**演示数据 + 固定口令**（`DEMO_LOGIN=1` 种子），公网可访问，不要放真实数据。
- 没有 TLS：登录 Cookie 依赖 `SESSION_COOKIE_SECURE=0`；正式环境应上 HTTPS 并去掉它。
- 云安全组只开 80/22；新增端口需要在腾讯云控制台放行，服务器上的 UFW 只是第二道。
