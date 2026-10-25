# CI：把 `verify.yml` 放进 `.github/workflows/`

`verify.yml` 是完整的 CI 配置（push / PR 跑 `npm run verify`），但它**不能**直接放在
`.github/workflows/`：推送用的 GitHub PAT 只有 `repo` scope，GitHub 对
`.github/workflows/**` 的写入要求 `workflow` scope，会直接拒收：

```
refusing to allow a Personal Access Token to create or update workflow
`.github/workflows/verify.yml` without `workflow` scope
```

## 启用

两种方式，任选其一：

1. **换一个有 `workflow` scope 的 token**（classic PAT 勾选 `workflow`，或 fine-grained
   token 给 `Workflows: Read and write`），然后：

   ```bash
   mkdir -p .github/workflows
   cp docs/ci/verify.yml .github/workflows/verify.yml
   git add .github/workflows/verify.yml
   git commit -m "ci: enable verify workflow"
   git push
   ```

2. **在 GitHub 网页上新建**：仓库 → Actions → New workflow → 直接粘贴
   `docs/ci/verify.yml` 的内容。网页操作使用你的登录态，不受 token scope 限制。

## 本地等价物

`.githooks/pre-push` 在每次 `git push` 前跑 `npm test`（含组件测试）。
首次克隆后启用一次：

```bash
git config core.hooksPath .githooks
```

浏览器门禁不在钩子里（需要构建与 Python Playwright，90 秒起步）；
提交前要跑全量：

```bash
npm run build
npm run verify
```

紧急跳过钩子：`SKIP_VERIFY=1 git push`。
