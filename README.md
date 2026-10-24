# dsh-feishu-plugin

把飞书接进 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)：**一个飞书话题 = 一个 DSH 会话**，审批、提问、模型与权限切换都在飞书卡片里完成。

这是 Host 插件（Cordis bundle），不是 OpenCode 插件；适配层完全使用 DSH 自己的服务：

| 能力 | 使用的 DSH 服务 |
|---|---|
| 会话创建 / 提示 / 取消 | `sessionController`（`create` / `prompt` / `cancel`） |
| 会话列表 / 标题 / 目录 / 运行状态 | `sessionController.list` + Session projections |
| 模型列表 / 切换 | `sessionController.modelCatalog` / `selectModel` |
| 权限预设 | `permissionPresets.catalog` / `set` |
| 审批 | `approval/request` waterfall（一次性授权） |
| 模型反问 | `user-questions/request` waterfall |
| 流式卡片 | `session/event`、`agent/assistant-stream`、`agent/status` |
| 工作目录 | `workingDirectory.set` |
| 图片 / 文件 | `attachments` / `fileUploads` |
| 凭据 UI | `Config`（volatile + secret）+ `settings` + `plugins.bundle.config` / `plugins.row.config` 客户端页面 |

## 当前状态

本机已安装并启用：

- 插件包：`dsh-feishu-plugin` 0.3.0（Host 半侧 + Client 配置页在同一个包里，已接上仓库原有的 npm OIDC 发布流水线）
- 飞书长连接已启动；App ID / Secret 已通过 DSH Web 插件页写入

## 安装

从 npm 安装（发版后）：

```sh
dsh plugin --profile <profile> add dsh-feishu-plugin
```

本地开发安装：

```sh
dsh plugin --profile <profile> add /Users/code/wps/dsh-feishu-plugin
```

发布与版本流程见 [docs/PUBLISHING.md](./docs/PUBLISHING.md)。本仓库沿用
`moyuanhua/dsh-feishu-plugin` 原有的 **npm Trusted Publishing（OIDC + provenance）**
流水线：推 `v*` tag 即发布。

## 飞书后台配置

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用。
2. **添加应用能力 → 机器人**。
3. **权限管理 → API 权限**：
   - `im:message.p2p_msg:readonly`（必开：读取单聊消息）
   - `im:message:send_as_bot`（必开：以机器人身份发消息 / 更新卡片）
   - `im:message:readonly`（接收图片/文件时需要）
4. **事件与回调 → 事件配置**：订阅方式选 **长连接**，添加 `im.message.receive_v1`。
5. **事件与回调 → 回调配置**：订阅方式选 **长连接**，添加 `card.action.trigger`。
6. **版本管理与发布**：创建版本并发布；可用范围建议「仅本人」。
7. 记下 **App ID** 与 **App Secret**。

不申请任何群权限：插件只处理 `p2p` 单聊，机器人物理上收不到群消息。

## 在 DSH 里配置凭据（推荐）

打开 DSH Web GUI → 左侧 **插件** → **已安装插件 → 飞书桥接**：插件详情页会直接显示凭据表单；组件行标题「飞书桥接 ›」也能打开同一配置页。

- **App ID**：直接显示当前值，可修改；
- **App Secret**：密文保存，不会回显；留空 = 保持不变，填入新值再保存；
- 点 **保存** 后，Host 会重建飞书客户端并重新建立 WebSocket 长连接；已有会话不受影响。

凭据保存在当前 profile 的 `cordis.patch.yml` 配置覆盖层（DSH 以 `0600` 权限维护），浏览器读取时 Secret 被 Redaction 遮蔽。

也可以直接写 profile 配置（不推荐手改）：

```yaml
- id: feishu
  name: dsh-feishu-plugin
  config:
    appId: cli_xxxxxxxx
    appSecret: xxxxxxxx
```

## 使用方式

### 主聊天流 = 管理台

| 命令 | 作用 |
|---|---|
| `/new [标题]` | 打开建会话表单（目录 / 模型 / 权限预设） |
| `/sessions`（`/ls`） | 会话列表，可翻页、进入话题 |
| `/open <序号>` / `/resume [序号]` | 为选中的会话新开一个飞书话题 |
| `/help` | 命令帮助 |

主聊天流直接发普通文本不会进入任何会话；会回一张管理台卡片，可一键「用这条消息新建会话」。

### 话题内 = 一个 DSH 会话

直接发文本即对话；支持图片 / 文件（需 `im:message:readonly`）。

| 命令 | 作用 |
|---|---|
| `/stop` | 取消当前回合 |
| `/current` | 查看当前会话（标题 / 目录 / 模型 / 权限 / 状态） |
| `/model [关键词]` | 切换到模型；无参数发选择卡片 |
| `/perm [预设名]` | 切换 DSH 权限预设（沙箱 + 审批策略） |
| `/cd <绝对路径>` | 迁移会话工作目录 |
| `/rename <标题>` | 重命名会话 |
| `/steer <文本>` | 立即插队 |
| `/queue <文本>` | 排队 |
| `/cancel` | 清空未提交的临时状态 |
| `/help` | 帮助 |

### 审批

DSH 的审批请求会变成飞书卡片：**允许一次 / 拒绝**。DSH 本身只提供一次性授权，没有「始终允许」；需要长期放行请在 DSH Web 端切换权限预设（例如 Full access）。

### 模型反问

`ask_user_question` 会变成飞书选项卡片；点按钮作答，或直接在话题里回复文字（单选/无选项问题）。多选题请按卡片提示回复选项标签。

## 配置项

`feishu` 行的 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | — | 飞书应用凭据；UI 可编辑（volatile + secret） |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `allowUsers` | `[]` | open_id 白名单；空 = 首个发消息者绑定为 owner |
| `allowedRoots` | `[家目录, 当前目录]` | 允许作为会话工作目录的根 |
| `defaultDirectory` | 当前目录 | 新会话默认工作目录 |
| `defaultModel` | DSH 默认 | `{ provider, model }` |
| `defaultPermissionPreset` | DSH 默认 | 新会话权限预设 |
| `busyDelivery` | `queue` | 忙碌时 `queue` 排队 / `steer` 插队 |
| `stream` | `true` | 是否流式更新卡片 |
| `streamThrottleMs` | `700` | 卡片更新节流 |
| `acceptAttachments` | `true` | 接收图片/文件 |
| `attachmentMaxBytes` | 20MB | 单附件上限 |
| `approvalTtlMs` | 10 分钟 | 审批卡片有效期 |
| `questionTtlMs` | 10 分钟 | 提问卡片有效期 |
| `staleMessageMs` | 120 秒 | 过期消息忽略窗口 |
| `sessionPageSize` | 8 | 会话列表每页条数 |
| `maxAnswerChars` | 12000 | 单卡回答截断 |
| `logLevel` | `info` | 日志级别 |
| `logFile` | `~/.dsh/feishu-plugin/feishu.log` | 日志文件；`false` 关闭 |

## 与 OpenCode 插件的差异

完整说明见 [docs/adaptation.md](./docs/adaptation.md)。要点：

- **权限**：DSH 只有 `allowed-once` / `rejected`，没有 OpenCode 的 always/session 授权；
- **模型**：DSH 模型目录来自 `llm` / `sessionController`，不再自建 provider 列表；
- **会话**：DSH 的 Session ID、标题、cwd、运行状态来自 Session 投影；
- **开发方案**：DSH Cordis Host 插件 + 同包 Client 模块，不是 OpenCode 的 `Plugin.define`；
- **网关收敛**：DSH 是单 Host 进程，不需要 OpenCode 那种跨 location 的 leader 选举。

## 故障排查

| 现象 | 处理 |
|---|---|
| 发消息没反应 | 应用是否已发布；事件/回调是否都选长连接；`im:message.p2p_msg:readonly` 是否开通 |
| 日志看哪里 | `~/.dsh/feishu-plugin/feishu.log` |
| 改凭据后不生效 | 在插件页保存后看日志是否出现「飞书凭据已更新，长连接已重启」 |
| 图片/文件收不到 | 开 `im:message:readonly` 并重新发布版本 |
| 审批卡收不到 | 该会话必须是从飞书发起的（有话题映射）；Web 本地会话不接管 |
| 点按钮提示凭证无效 | 审批 token 过期（默认 10 分钟）或操作者不在允许名单 |

## 本地开发

```bash
cd /Users/code/wps/dsh-feishu-plugin
pnpm install
pnpm build      # esbuild 自包含 bundle → lib/index.js + lib/client.js
pnpm test       # node:test
```

配置页 Client 模块（与 Host 同一个包，构建时复制为 `lib/client.js`）：

```bash
node --check client.js
```

安装/更新（在本机 profile 中）：

```text
plugin_manager install_bundle  target=/Users/code/wps/dsh-feishu-plugin/dsh-feishu-plugin-0.3.0.tgz
```

> 本机 `pnpm` 不在 PATH，profile 的 `plugin-manager.pnpmCommand` 指向
> `/Users/code/wps/.tools/pnpm`（corepack shim）。

## 已知限制

- 只处理单聊（p2p），不处理群聊 / 群话题。
- 一个飞书话题只能映射一个 DSH 会话；进入已有会话会新开一个话题。
- 审批只有一次性授权；长期放行依赖 DSH 权限预设。
- 音频 / 视频 / 表情包只显示占位文本。
- 长回答在单张卡片内截断；完整内容看 DSH Web 会话。
