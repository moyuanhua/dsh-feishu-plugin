# 从 opencode-feishu-plugin 到 dsh-feishu-plugin：适配说明

参考仓库：`/Users/code/wps/opencode-feishu-plugin`（OpenCode V2 插件）。
本插件只借鉴产品功能与飞书侧交互，运行层全部改用 DSH 的公开服务与插件模型。

## 1. 开发方案不同

| | opencode-feishu-plugin | dsh-feishu-plugin |
|---|---|---|
| 载体 | `@opencode/plugin` 的 `Plugin.define` | Cordis Host 插件（`export function apply`） |
| 打包 | tsup 打成自包含 ESM | esbuild 打成自包含 ESM |
| 安装 | OpenCode `plugins[]` | `dsh.bundle.patch` + `plugin_manager install_bundle` |
| 配置 | `feishu.json` + 环境变量 | Cordis `Config` schema，profile patch 持久化 |
| UI | 无 | 同包 Client 模块注册 DSH Web 插件页配置页 |
| 网关收敛 | 跨 location/进程 leader 选举 | DSH 单 Host 进程，不需要 |
| 生命周期 | OpenCode location 可能被回收，需要保活 | Host 进程常驻，插件随 bundle 启停 |
| 状态存储 | `ctx.storage`（OpenCode） | `~/.dsh/feishu-plugin/state.json`（原子写） |

## 2. 权限不同

OpenCode 的 `permission.evaluate` 支持 `once / always / session`，权限规则可按 action/resource 配置。

DSH 的 `dsh-user-approval` 是 **一次性审批 seam**：

- 结果只有 `allowed-once`、`rejected`、`cancelled`、`unavailable`；
- 没有“始终允许”，也没有按工具/资源的持久规则；
- 长期放行由 **权限预设**（`permissionPresets`：sandbox mode + approval policy）承担，而不是审批卡；
- 失败关闭：没有 answerer 时 `unavailable`，相当于拒绝。

因此本插件的审批卡只有「允许一次 / 拒绝」，并在卡片上说明长期放行请到 Web 端切换权限预设。`/perm` 切换的是 DSH 进程级权限预设目录（如 `workspace-write`、`danger-full-access`）。

## 3. 模型不同

OpenCode：

- 自己从 `ctx.model` / provider 列表构建下拉；
- 模型切换走 session 的 model 字段；
- 默认模型来自 `opencode.json` 或最近使用。

DSH：

- 模型目录由 `sessionController.modelCatalog()` 提供（provider 分组 + 默认选择 + 失败项）；
- 切换走 `sessionController.selectModel({ sessionId, provider, model })`；
- 默认选择来自 `agentDefaultModel`（profile 配置）；
- 模型能力（图片输入等）由 `llm.resolveModelInfo` 在 Host 侧校验。

因此创建表单/模型卡直接消费 DSH 的 catalog，不再维护第二份模型列表；模型不可用时由 DSH 返回 `session/model-unavailable`。

## 4. 会话列表不同

OpenCode：

- 通过 HTTP / `ctx.session.list()` 读 `SessionInfo`，标题、`location.directory`、时间字段形状不稳定，需要兼容归一化。

DSH：

- `sessionController.list({}, signal)` 返回 `SessionSummary[]`；
- 标题来自 `title` projection，模型来自 `modelSelection` projection，权限来自 `permissions` projection；
- `running` / `blank` / `agentAvailable` / `cwd` 由 Host 直接给出；
- 冷会话不需要 resume 就能列表；`inspect()` 可在不激活 Agent 的情况下读取。

因此列表卡直接用 DSH 的 summary + projection，不再自己猜字段。

## 5. 会话创建不同

OpenCode：`session.create({ directory, model, permissions })` + setup 向导。

DSH：

1. `sessionController.create({ cwd })` 创建并发布 live Agent；
2. `ensureAgent(sessionId)`（幂等）；
3. `permissionPresets.set(session, preset)` 写权限预设；
4. `sessionController.selectModel({...})` 写模型选择；
5. `sessionController.rename({...})` 写标题；
6. 在飞书侧 `reply_in_thread` 开话题并持久化 thread/root → session 映射。

## 6. 审批 / 提问接入点不同

OpenCode：`permission.asked` 事件 + `permission.reply` HTTP。

DSH：

- 审批：注册 `approval/request` waterfall，`async (req, next) => outcome`；只接管有飞书话题映射的 agent，其他会话 `next()` 交回 Web UI；
- 提问：注册 `user-questions/request` waterfall，返回 `{ answers }`；
- 二者都绑定 `req.signal`，取消时自动收卡；
- 卡片 token 用 HMAC 自签 + 过期时间，防止伪造/重放。

## 7. 流式渲染不同

OpenCode：订阅 `message.part.updated` / `execution.*` 等事件。

DSH：

- `session/event`：`turn/start`、`step/start`、`tool/call`、`tool/result`、`assistant/message`、`turn/end`；
- `agent/assistant-stream`：进程内 token 增量（文本/推理/tool-call delta）；
- `agent/status`：idle/running；
- `agent/error`：回合错误；
- 会话日志是唯一事实源；卡片只是展示层，最终答案从 `assistant/message` 取。

## 8. 飞书侧保留的产品能力

- 单聊长连接（WSClient），不监听端口、不需要公网；
- 话题 → 会话（一个会话可绑定多个话题，每次进入新开话题）；
- 主聊天流管理台；
- `/new` 表单（目录 / 模型 / 权限）；
- 会话列表、翻页、进入话题；
- 流式运行卡、思考/工具抽屉、最终答案、强制停止；
- 审批卡、提问卡；
- 图片 / 文件接收；
- owner 绑定 / allowlist / 消息去重 / 过期消息过滤；
- 日志落文件。

## 9. 有意没抄的部分

- 跨 location 的网关 leader 选举与位置保活（DSH 不需要）；
- OpenCode 的 `quickNew` 实现细节（DSH 版用自己的 JSON 意图协议 + clarify 多轮历史，不照搬其 generate 会话方案）；
- OpenCode 的 `permission.evaluate` 规则引擎（DSH 用权限预设）；
- OpenCode 的 resume 摘要卡（DSH 版改为读取 `sessionQuery.readSurface`，进入话题时附简介；不做隐式 compaction）；
- OpenCode 的 `feishu.json` 多来源配置优先级（DSH 统一走 Cordis Config + profile patch）。
