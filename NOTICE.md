# 来源与授权说明（NOTICE）

本仓库是一个 **DeepSeek Harness（dsh / Cordis）插件**，不是 opencode 插件的分支或复刻发行版。

## 移植自

`opencode-feishu-plugin` — <https://github.com/moyuanhua/opencode-feishu-plugin>
MIT License, Copyright (c) 2026 moyuanhua（见本仓库 `LICENSE`，与之同许可同作者）

以下文件为**逐行搬运**（仅调整相对 import 路径 / 包名 / 宿主存储适配，未改逻辑），保留原文件头注释与出处标注：

| 本仓库文件 | 来源文件 |
|---|---|
| `src/utils/ttl-map.ts` | `src/utils/ttl-map.ts` |
| `src/security/token.ts` | `src/security/token.ts` |
| `src/security/allowlist.ts` | `src/security/allowlist.ts` |
| `src/logger.ts` | `src/logger.ts` |
| `src/bridge/routing.ts` | `src/feishu/routing.ts` |
| `src/bridge/delivery.ts` | `src/feishu/delivery.ts` |
| `src/bridge/session-map.ts` | `src/feishu/session-map.ts` |
| `src/bridge/commands.ts` | `src/feishu/commands.ts` |
| `src/bridge/perm-presets.ts` | `src/feishu/perm-presets.ts` |
| `src/bridge/permission.ts`（纯策略部分） | `src/permission.ts` |
| `src/bridge/forms.ts` | `src/feishu/forms.ts` |
| `src/bridge/watchdog.ts` | `src/feishu/watchdog.ts` |
| `src/bridge/session-recovery.ts` | `src/feishu/session-recovery.ts` |
| `src/feishu/cards.ts` 的审批卡三个构建器 | `src/feishu/cards.ts` |
| `src/feishu/cards.ts` | `src/feishu/cards.ts` |
| `src/feishu/card-limits.ts` | `src/feishu/card-limits.ts` |
| `src/bridge/run-state.ts` | `src/feishu/run-state.ts` |
| `src/bridge/run-renderer.ts` | `src/feishu/run-renderer.ts` |

**规格测试同样搬运**（"先搬上游测试作规格，再让实现通过"）：

| 本仓库测试 | 来源测试 |
|---|---|
| `test/token.test.ts` | `test/token.test.ts` |
| `test/routing.test.ts` | `test/routing.test.ts` |
| `test/delivery.test.ts` | `test/delivery.test.ts` |
| `test/session-map.test.ts` | `test/session-map.test.ts` |
| `test/commands.test.ts` | `test/commands.test.ts` |
| `test/perm-presets.test.ts` | `test/perm-presets.test.ts` |
| `test/permission.test.ts` | `test/permission.test.ts` |
| `test/forms.test.ts` | `test/forms.test.ts` |
| `test/watchdog.test.ts` | `test/watchdog.test.ts` |
| `test/session-recovery.test.ts` | `test/session-recovery.test.ts` |

附件层：`src/bridge/attachments.ts` 搬上游 `feishu/attachments.ts` 的**纯语义**（可支持类型、
文件名清洗、大小上限、下载超时、失败降级为占位文本）；落盘部分按 dsh 的附件服务重写。

宿主适配（本仓库新增，非搬运）：`src/bridge/questions.ts`（上游 `FormRelay` 的 waterfall 变体）、`src/bridge/approval.ts`（上游 `ApprovalManager` 的 waterfall 变体——
dsh 用 `ctx.on('approval/request', …)` 直接 await 用户点击并返回结果词，不需要 evaluate hook + reply API），`src/dsh/port.ts`（`ctx.agents` / `createUserMessage`）、
`src/dsh/storage.ts`（`ctx.storageDomain` → 上游 KV 端口）、`src/dsh/source.ts`（`MessageSourceMap` 增强）、
`src/bridge/outbound.ts`（运行卡控制器）、`src/config.ts`、`src/index.ts`。

## 设计参考（未复制代码）

- `dsh-lark-channel`（BSD-3-Clause）— 参考其 **DSH 侧插件约定**：`package.json` 的 `dsh.bundle.patch`、`cordis.patch.yml` 的 `insert` 形状、`name`/`inject`/`Config`/`apply` 导出、凭据经 host `settings` 持久化。代码为独立实现。
- `@deepseek-ai/schemastery` — 配置 schema 的唯一依赖（dsh 官方配置约定）。
- `@larksuite/channel`（MIT，飞书官方维护）— 飞书长连接 / 事件归一化 / 流式卡片 / 附件 / 扫码注册。

## 为什么新开仓库而不是改造上游

上游插件是 **opencode V2 单宿主**插件（`Plugin.define` + `ctx.permission/session/event`），其 15,404 行中约 90% 与 opencode 语义耦合（`delivery: steer|queue`、`permission.evaluate` 改写、inbox park 取消、compaction 摘要复用、location 60 分钟回收保活）。dsh 的宿主语义（Cordis `ctx.*`、`session`/`agent`/`approval`/`user-questions` 接缝）与之不同。

因此本仓库的定位是：**搬运已验证的宿主无关内核（协议/安全/策略层，≈5.5k 行，含单测），重写宿主层**；等本仓库的分层稳定后，再把其中通用层抽成独立包反向提供给 opencode 侧使用（"先分离、后抽象"）。
