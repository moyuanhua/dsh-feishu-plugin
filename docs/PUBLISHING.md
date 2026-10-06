# 发布runbook

三种分发方式，按"给谁用"选：

| 方式 | 命令 | 适用 |
|---|---|---|
| **本地路径** | `dsh plugin --profile <p> add /绝对路径` | 自己的开发机；装成 `link:`，改完 `pnpm build` 重启即生效 |
| **npm** | `dsh plugin --profile <p> add dsh-feishu-plugin` | 公开分发（推荐） |
| **git 地址** | `dsh plugin --profile <p> add git+https://github.com/moyuanhua/dsh-feishu-plugin.git` | 临时给人试；见下方「git 直装的额外一步」 |

---

## 首次发布已完成（0.1.0，2026-10-06）

0.1.0 走了一次性 token 手动发布（npm 的 Trusted Publisher 只能在包已存在后配置）。
**此后不再需要 token**：`publish-bootstrap.yml` 已删除，npmjs.com 上也应开启
「Require 2FA and disallow tokens」并撤销当时那个 granular token。

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

## 已修复：首次安装会失败一次（0.1.0 → 0.2.0）

**0.1.0 的问题**：运行时要依赖 `@larksuite/channel`，它会带进 `protobufjs`，
pnpm ≥10 默认拦下它的构建脚本 → 全新 profile 上首次 `dsh plugin add` 必然失败：

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs@7.6.6
```

而且失败后**直接重试是无效的**：会输出 "Already up to date" 且 `RC=0`，
但不会写 `dsh.profile.bundles` —— 正是「装了不生效」。

**0.2.0 的修法**：把 `@larksuite/channel` 与 `zod` 打进 `lib/`（与上游自包含 bundle 一致），
`dependencies` 只剩一个 Config schema 包。实测全新 profile：`Packages: +4`、一次成功、
无 `ERR_PNPM_IGNORED_BUILDS`。

### 打包这件事有两个必须保留的坑（都在 `scripts/bundle.mjs` 里）

CJS 依赖被打进 ESM 时，esbuild 的 `__require` 垫片会抛
`Dynamic require of "util" is not supported`；补了 `require` 之后还会撞
`__dirname is not defined in ES module scope`（飞书 SDK 用它读自己的 package.json）。
所以 banner 里那三行 **`require` / `__filename` / `__dirname` 的 shim 一个都不能删**。

静态检查看不出这类问题 —— 所以 `scripts/bundle.mjs` 末尾有一个**真的 import 一次**的
冒烟测试，失败即构建失败。

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
