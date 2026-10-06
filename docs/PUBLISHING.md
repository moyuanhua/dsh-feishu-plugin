# 发布runbook

三种分发方式，按"给谁用"选：

| 方式 | 命令 | 适用 |
|---|---|---|
| **本地路径** | `dsh plugin --profile <p> add /绝对路径` | 自己的开发机；装成 `link:`，改完 `pnpm build` 重启即生效 |
| **npm** | `dsh plugin --profile <p> add dsh-feishu-plugin` | 公开分发（推荐） |
| **git 地址** | `dsh plugin --profile <p> add git+https://github.com/moyuanhua/dsh-feishu-plugin.git` | 临时给人试；见下方「git 直装的额外一步」 |

---

## 首次发布（0.1.0）—— 必须手动一次

npm 的 **Trusted Publisher（OIDC）只能在包已存在之后配置**，所以第一个版本走 token。三步：

### 1. 生成一个最小权限的 npm token

npmjs.com → **Access Tokens** → Generate New Token → **Granular Access Token**：

- 权限：**只勾 `dsh-feishu-plugin`** 的 **Read and write**（不要给全账号权限）；
- 有效期：短期即可（发完就撤销）。

### 2. 存进 GitHub 仓库

GitHub → 仓库 **Settings → Secrets and variables → Actions → New repository secret**：

```
Name:  NPM_TOKEN
Value: <上一步的 token>
```

> 我（AI）**没有**创建仓库 secret 的权限，这一步只能你来做。

### 3. 手动跑一次 workflow

GitHub → **Actions → "Publish to npm (bootstrap via NPM_TOKEN)" → Run workflow**。

它会在发布前自己跑一遍 `typecheck + build + test`，全绿才 `npm publish --access public --provenance`。

### 4. 发完之后立刻做的两件事

1. **配 Trusted Publisher**：npmjs.com → 包 `dsh-feishu-plugin` → **Settings → Publishing access → Trusted Publisher**：
   ```
   owner:    moyuanhua
   repo:     dsh-feishu-plugin
   workflow: publish.yml
   ```
2. **删掉 `.github/workflows/publish-bootstrap.yml`**，并在 npmjs.com 上开启
   **Require 2FA and disallow tokens**，然后撤销第 1 步那个 token。

---

## 后续发布（0.1.1 起）—— 打 tag 即可

```sh
# 1. 改 package.json 的 version
# 2. 打 tag 推上去
git tag v0.1.1 && git push --follow-tags
```

`publish.yml` 会以 **OIDC（无 secret）+ provenance** 发布。也可以在 Actions 页面手动触发。

> **workflow 文件名必须与 Trusted Publisher 里配的一致**（都叫 `publish.yml`）—— 改名就得同步改 npmjs 上的配置。

---

## git 直装的额外一步

`lib/` 是构建产物、**不入库**，所以从 git 装时必须现场构建，靠 `package.json` 的 `prepare` 脚本。
pnpm 默认**拦下** git 依赖的构建脚本，报：

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
allowBuilds:
  dsh-feishu-plugin@https://codeload.github.com/.../tar.gz/<commit-sha>: true
```

按提示把**那一整行**加进目标 profile 的 `pnpm-workspace.yaml`（`allowBuilds:` 段），再重跑 `add`。

> 注意那个 key 里**带 commit SHA**，每次提交都会变 —— 所以 git 直装只适合临时试用，
> 长期分发请用 npm。经实测：加对 key 后 `prepare` 会构建出 43 个 JS 文件，profile 能正常启动。

---

## 发布前 checklist

- [ ] `package.json` 的 `version` 已更新
- [ ] `engines.dsh` 与 `peerDependencies` 的区间仍然覆盖当前 DSH 版本
      （**这是最容易卡住别人的地方**：不兼容的 peer 会让安装器在 pnpm 之前就拒绝，什么都不下载）
- [ ] `icon` / `locale/*.json` / `README.md` / `LICENSE` / `NOTICE.md` 都在 `files` 白名单里
- [ ] `npm pack --dry-run` 看过内容（确认 `src/`、`test/` 不在里面）
- [ ] `pnpm test:coverage` 过门槛

## DSH 版本兼容

我们钉的是 `>=0.2.0-rc.2 <0.3.0`：

- DSH 出 `0.2.0` 正式版或 `0.2.x` → **仍然兼容**，不用动；
- DSH 出 `0.3.0` → **所有安装都会被拒**，必须发一版放宽 peer 区间。

别指望 npm 的"版本豁免"当常规路径 —— 它是逐 `包@版本` × 逐运行时版本批准的，不继承升级。
