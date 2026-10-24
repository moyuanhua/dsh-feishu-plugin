# 验证记录

日期：2026-10-24 21:55（Asia/Shanghai）

## 已完成

| 项 | 结果 |
|---|---|
| git | `2.50.1 (Apple Git-155)`，已可用 |
| 参考仓库 | `/Users/code/wps/opencode-feishu-plugin` 已 clone |
| 插件构建 | `dsh-feishu-plugin` 0.4.0：`lib/index.js` 自包含 Host + `lib/client.js` 配置页 |
| 插件安装 | `dsh-feishu-plugin` 0.4.0（tarball）→ `application: applied`；插件列表只有 1 个「飞书桥接」 |
| 飞书凭据校验 | tenant_access_token / bot info 返回 `code: 0` |
| 飞书 WS（独立 SDK 测试） | 使用同一组凭据 `onReady` 触发，`ws client ready` |
| 插件 WS 连接 | 日志出现「飞书长连接已就绪（收到 ready）」，连接状态 `state: connected` |
| 配置页合并 | 同一包内 Client 模块注册配置页；插件详情页直接显示 App ID / Secret / 调试日志表单 |
| 新图标 | DSH 鲸鱼 + 飞书蓝气泡构图，128px / 48px 两档渲染检查通过 |
| 卡片按钮刷新 | 卡片更新改为在 `card.action.trigger` 回调响应里返回 `card`（并行延迟 patch 兜底），避免 Feishu 在回调结束后用原卡片覆盖 |
| 调试开关 | `debugLog` volatile 字段：插件页勾选即强制 debug 级别，日志仍写 `feishu.log` |
| 新会话默认值 | `defaultDirectory` / `defaultModel` / `defaultPermissionPreset` 均可从插件页编辑；目录走 `uiWorkspace.pickDirectory()`，模型/权限来自 DSH catalog |
| npm 包结构 | `npm pack --dry-run`：10 个文件，含 `lib/index.js`、`lib/client.js`、patch、locale、icon、README/LICENSE/NOTICE |
| Web 配置页 | headless Chrome 实测：插件页 → 飞书桥接 → 配置，App ID 回显正确 |
| 配置页保存 | 通过页面写入 App Secret，提示「已保存」 |
| 实时重连 | 页面把 App ID 改成测试值保存后，日志出现「飞书凭据已更新，长连接已重启」并以新 App ID 启动；随后改回并再次重启成功 |
| 单元测试 | `node --test` 8 项全部通过 |

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
