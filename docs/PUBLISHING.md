# 发布 runbook

本仓库沿用 `moyuanhua/dsh-feishu-plugin` 原有的 npm 发布方式：
**Trusted Publishing（OIDC）+ provenance**，不需要任何 npm token secret。

## 已配置好的部分

- npm 包名：`dsh-feishu-plugin`（已发布到 0.2.2，0.3.0 为本次重写）
- Trusted Publisher：`owner=moyuanhua`、`repo=dsh-feishu-plugin`、`workflow=publish.yml`
- `.github/workflows/publish.yml`：推 `v*` tag 或手动触发
- `.github/workflows/ci.yml`：push / PR 上跑 build + test

## 发一版

```sh
# 1. 改 package.json 的 version
pnpm build && pnpm test
git add -A && git commit -m "chore: release x.y.z"
git push
git tag vX.Y.Z
git push --follow-tags
```

`publish.yml` 会：

1. `pnpm install --frozen-lockfile`
2. `pnpm build`（`lib/index.js` + `lib/client.js`）并 `pnpm test`
3. `npm publish --access public --provenance`

发布前请确认 npmjs.com 上包的 Trusted Publisher 仍指向本仓库的 `publish.yml`；
workflow 文件名不能改。

## 本地验证发布内容

```sh
pnpm pack --dry-run
```

应包含：

```
lib/index.js
lib/client.js
cordis.patch.yml
locale/zh.json
locale/en.json
icon.svg
README.md
LICENSE
NOTICE.md
```

`src/`、`test/`、`docs/`、`node_modules/` 不进 npm 包。

## 自包含 bundle 的两个坑

`@larksuiteoapi/node-sdk` 及其 CJS 依赖打进 ESM 时会触发：

- `Dynamic require of "util" is not supported`
- `__dirname is not defined in ES module scope`

`scripts/build.mjs` 的 banner 提供了 `require` / `__filename` / `__dirname` 三个 shim；
构建末尾还会真实 `import` 一次 `lib/index.js` 做冒烟检查，失败即构建失败。这三个 shim 不要删。

## 版本与 DSH 兼容区间

`package.json`：

```json
"engines": { "dsh": ">=0.2.0-rc.2 <0.3.0" }
```

DSH 出 0.2.x 不用改；出 0.3.0 需要放宽区间后再发版。
