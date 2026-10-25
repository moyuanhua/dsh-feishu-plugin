# 验证记录

日期：2026-10-25 11:40（Asia/Shanghai）

## 已完成

| 项 | 结果 |
|---|---|
| git | `2.50.1 (Apple Git-155)`，已可用 |
| 参考仓库 | `/Users/code/wps/opencode-feishu-plugin` 已 clone |
| 插件构建 | `dsh-feishu-plugin` 0.5.6：`lib/index.js` 自包含 Host + `lib/client.js` 配置页 |
| 插件安装 | `dsh-feishu-plugin` 0.5.6（本地 link）→ `application: applied`；插件列表只有 1 个「飞书桥接」 |
| 飞书凭据校验 | tenant_access_token / bot info 返回 `code: 0` |
| 飞书 WS（独立 SDK 测试） | 使用同一组凭据 `onReady` 触发，`ws client ready` |
| 插件 WS 连接 | 日志出现「飞书长连接已就绪（收到 ready）」，连接状态 `state: connected` |
| 配置页合并 | 同一包内 Client 模块注册配置页；插件详情页直接显示 App ID / Secret / 调试日志表单 |
| 新图标 | DSH 鲸鱼 + 飞书蓝气泡构图，128px / 48px 两档渲染检查通过 |
| 卡片按钮刷新 | 列表/翻页类按钮在回调响应返回卡片；进入/创建话题类按钮只返回 toast，回调后再 patch，避免与新话题创建冲突 |
| 调试开关 | `debugLog` volatile 字段：插件页勾选即强制 debug 级别，日志仍写 `feishu.log` |
| 工具抽屉 | 工具全部收在一个常驻折叠抽屉，只显示总次数；展开见明细；最多保留 12 个 |
| 长连接观测 | 60s 心跳日志（state/inboundCount/lastInboundAgoMs/reconnectAttempts），状态变化单独记录；debugLog 打开后含 SDK ping/pong trace |
| 长连接自愈 | `pingTimeout=30` + 60s 状态 watchdog；半开连接自动断开重连，状态写日志 |
| 意图兜底 | 模型失败时确定性回退：识别到列表/进入/任务文本仍可用默认目录开预填表单 |
| 意图模型 | 意图识别复用插件页配置的默认工作模型（defaultModel），不再有独立 intentModel |
| 意图模型调用 | `prepareCall` 与 `stream` 使用同一份 config，修复 `INVALID_PREPARED_CALL`；标题支持 bigram 模糊匹配 |
| 主会话意图 | “开启会话”由模型在会话列表里判断 create/enter；不确定则多轮 clarify；open 仅作模型失败兜底 |
| 思考保留 | 工具循环进入下一步时不再清空上一步 reasoning，思考抽屉保留最近思考内容 |
| 抽屉常驻 | 思考/工具两个抽屉始终存在并默认折叠；工具只显示次数，展开见明细 |
| 流式卡片 | 固定骨架 + 思考面板折叠 + 思考状态每秒刷新；回答/工具不互相替换 |
| 意图识别 | 主聊天流普通文本 → `ctx.llm` 一次性 JSON 意图分类；目录/模型/会话全部二次校验；失败回退管理台 |
| 话题标题 | 进入/创建会话时卡片 header 使用 DSH 会话标题，飞书话题列表显示真实标题 |
| 话题路由 | 每次进入新建话题并绑定已有 DSH 会话（参考 OpenCode resume）；回答跟随用户发言话题 |
| 会话标识 | 进入老会话的主卡片与话题根卡都显示完整 `session-...` ID，便于在 DSH Web 里定位 |
| 会话简介 | `sessionQuery.readSurface` 读取冷会话 surface；进入老会话时附历史摘要/上一条/上次回复，`/brief` 可重复读取 |
| 新会话默认值 | `defaultDirectory` / `defaultModel` / `defaultPermissionPreset` 均可从插件页编辑；目录走 `uiWorkspace.pickDirectory()`，模型/权限来自 DSH catalog |
| npm 包结构 | `npm pack --dry-run`：10 个文件，含 `lib/index.js`、`lib/client.js`、patch、locale、icon、README/LICENSE/NOTICE |
| Web 配置页 | headless Chrome 实测：插件页 → 飞书桥接 → 配置，App ID 回显正确 |
| 配置页保存 | 通过页面写入 App Secret，提示「已保存」 |
| 实时重连 | 页面把 App ID 改成测试值保存后，日志出现「飞书凭据已更新，长连接已重启」并以新 App ID 启动；随后改回并再次重启成功 |
| 单元测试 | `node --test` 25 项全部通过 |

## 尚未实测

- **真实飞书入站消息 → 自动建会话 → 流式卡片**：需要用户本人向机器人发一条单聊消息（或先发 `/new`）。当前 App 的机器人 open_id：`ou_315a65bbd41ffa459b5054f5d905d502`。
- 群聊 / 群话题：按设计不支持（只处理 p2p）。
- 图片 / 文件：代码路径已实现，但未用真实消息资源验证（需 `im:message:readonly` 且重新发布版本）。
- DSH 审批 / 提问卡片：需要真实会话触发工具审批或 `ask_user_question` 才能端到端验证。

## 如何继续实测

1. 飞书里给这个应用（机器人名 `opencode-mac`）发一条单聊消息：
   - 普通文本 → 应收到「管理台」卡片；
   - `/new` → 应收到建会话表单，提交后自动开话题；
   - 在话题里发消息 → 应出现流式运行卡片。
2. 若没有响应，查看 `~/.dsh/feishu-plugin/feishu.log` 与
   `~/Library/Logs/dsh/dsh.err.log`。
3. 审批卡：在话题里让模型执行需要审批的工具（或把权限预设切到高风险档），应出现「允许一次 / 拒绝」卡片。
