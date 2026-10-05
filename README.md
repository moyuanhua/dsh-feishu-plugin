# dsh-feishu-plugin

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）接进飞书 / Lark：**一个飞书话题 = 一个 dsh 会话，权限审批直接在飞书卡片上点按钮。**

设计目标与 [`opencode-feishu-plugin`](https://github.com/moyuanhua/opencode-feishu-plugin) 对齐，但宿主换成 dsh 的 Cordis 插件体系，并坚持**最小权限**：只申请 `im:message.p2p_msg:readonly` + `im:message:send_as_bot` 两个 scope，不申请任何群权限 —— 机器人在平台层面就收不到群消息。

> 状态：**M2（连接层）**。配置层、卡片 token 安全内核、飞书长连接 supervisor、入站决策与单人白名单已完成并有 39 个单测；已在真实 dsh 宿主里验证过"加载 + 连接失败退避"两条路径（见下"开发期验证"）。尚未接线会话投递（M3）。

## 为什么单独开一个仓库

上游插件是 opencode V2 单宿主插件（`Plugin.define` + `ctx.permission/session/event`）。它的 15,404 行里约 90% 与 opencode 语义绑定：`delivery: steer|queue`、`permission.evaluate` 改写、inbox park 取消、compaction 摘要复用、location 60 分钟回收保活、`/api/plugin` 续期。dsh 的语义（Cordis `ctx.*`、`ctx.agents` 的 `followup/steer/inject`、`approval/request` waterfall、`storageDomain`）与之不同。

因此这里**不做"跨宿主通用内核"抽象**，而是：

1. **搬运宿主无关内核**（协议 / 安全 / 策略，≈5.5k 行，含 11k 行单测）— 逐文件出处见 [NOTICE.md](NOTICE.md)；
2. **重写宿主层** — 面向 dsh 接缝，而不是兼容两个宿主；
3. 等本仓库分层稳定后，再把其中真正通用的层抽成独立包，**反向**给 opencode 侧用（先分离、后抽象）。

上游 `index.ts`(1801 行) 里约 80% 是"能力探测 + HTTP 兜底 + 多实例防御"，在单一宿主里应当**变短**而不是复用：去掉兜底后装配层预计落到 500–700 行。

## 架构

```
src/
├─ index.ts             # Cordis 入口：name / inject / Config / apply
├─ config.ts            # schemastery schema + 解析夹取（永不抛异常；缺凭据只禁用）
├─ utils/ttl-map.ts     # 惰性过期 TTL Map（去重 / 防重放 / 待批跟踪）
├─ security/token.ts    # 卡片按钮自签 token（HMAC + 用途隔离 + TTL + nonce 防重放）
└─ (M2–M4) feishu/      # 长连接与卡片：@larksuite/channel 封装
   (M2–M4) bridge/      # 话题↔会话映射、入站投递、流式回显、审批/提问桥
```

dsh 接缝（M2 起接入，均已确认存在）：

| 用途 | 接缝 |
|---|---|
| 建会话 / 取回 agent | `ctx.agents.create/resume`、`ctx.sessionController.resolveAgent(sessionId)` |
| 投递用户消息 | `agent.followup(msg)`（唤醒下一轮）/ `agent.steer(msg)`（插队）/ `agent.inject(msg)`（只进上下文） |
| 中断 | `agent.cancel({kind:'user'})` |
| 实时文本 | `ctx.on('agent/assistant-stream')` → `frame.chunk.type === 'text-delta'` |
| 持久结算 / 工具活动 | `ctx.on('session/event')` → `assistant/message` / `tool/call` / `tool/result` / `turn/end` |
| 工具审批 | `ctx.on('approval/request', (req, next) => …)` 返回 `allowed-once` / `rejected` / `cancelled`（fail-closed） |
| agent 提问 | `ctx.on('user-questions/request', (req, next) => …)` 返回 `{answers:[{id,selected,custom?}]}` |
| 斜杠命令 | `ctx.commands.register/execute` |
| 话题映射持久化 | `ctx.storageDomain`（`defineDomain` + `domainTable`） |
| 凭据 | `ctx.credentials`（`credentialRef` + `describe/set/unset`，永不回读明文） |

飞书侧使用官方 `@larksuite/channel`（MIT，飞书维护）：WS 长连接 + 自动重连 + 心跳、事件归一化（message / cardAction / reaction）、**流式打字机卡片**、附件上传下载、扫码设备码注册应用 —— 省掉上游自己实现的约 7k 行飞书管道代码。

## 里程碑

- **M1 骨架** ✅ 工具链、bundle patch、配置 schema、token 内核 + 单测
- **M2 连接** ✅ `@larksuite/channel` 长连接 supervisor（世代化 + 有界指数退避 + dispose 收敛）、入站决策纯函数（白名单 / 群开关 / bot 回环 / 空消息 / 命令识别）、单人 owner 绑定、结构化脱敏日志
- **M3 会话桥**：话题↔会话映射（`ctx.storageDomain`）、投递（`followup`/`steer`）、流式回显卡片、`/new` `/sessions` `/resume` `/stop`
- **M4 决策桥**：审批卡（四档 gate + 白名单 + token 校验）、提问卡、强停、看门狗、附件
- **M5 发布**：扫码 onboarding、locale/icon、peer 区间对齐、兼容性矩阵与文档

## 开发期验证（已完成）

用**隔离的 DSH_HOME** + `--patch` 覆盖层指向本地构建产物，不碰真实 profile：

```sh
pnpm run build
cat > /tmp/feishu-dev.patch.yml <<'YAML'
- insert:
    - id: feishu
      name: '/Users/code/wps/dsh-feishu-plugin/lib/index.js'   # 绝对路径
      config:
        logLevel: debug
YAML
DSH_HOME=/tmp/dsh-feishu-dev dsh web --patch /tmp/feishu-dev.patch.yml --no-open --port 3099
```

已实测的两条路径：

1. **加载路径**（无凭据）：插件被 cordis 加载、`apply()` 执行、schema 校验通过，只告警并保持禁用，宿主正常启动。
2. **连接路径**（假凭据）：`@larksuite/channel` 正常初始化（`client ready` / `event-dispatch is ready`），`connect()` 打到真实飞书 API 后失败，supervisor 按 500→1000→2000→4000→8000→16000→30000(封顶) 退避重试，宿主照常提供服务。

**部署前提**：SDK 的 `connect()` 会先调 `/open-apis/bot/v3/info` 解析 bot 身份 —— 应用**必须已添加"机器人"能力并发布版本**，否则会一直停在这一步。

## 权限清单（部署时照做）

| 项 | 值 |
|---|---|
| API 权限（必开） | `im:message.p2p_msg:readonly`、`im:message:send_as_bot` |
| API 权限（可选，图片/文件） | `im:message:readonly` |
| 事件订阅方式 | **使用长连接接收事件**（不要选 Webhook） |
| 订阅事件 | `im.message.receive_v1` |
| 回调 | `card.action.trigger`（零权限要求） |
| 机器人能力 | 必须开启并发布版本 |
| 可用范围 | 建议"仅本人" —— 这是单人边界的平台层保证 |
| **不要申请** | 任何群相关 scope（`im:message.group_at_msg*`），这样机器人物理上收不到群消息 |

## 配置

见 [cordis.patch.yml](cordis.patch.yml)（含逐项注释与默认值）。凭据走 `appId` / `appSecret` 或 `appSecretRef`。

安装（尚未发布到 npm，M5 之后）：

```sh
dsh plugin --profile <name> add dsh-feishu-plugin
```

本地开发安装会把包以 `link:` 形式追加进 profile 的 `dsh.profile.bundles`。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

## 许可

MIT，Copyright (c) 2026 moyuanhua。移植来源与授权说明见 [NOTICE.md](NOTICE.md)。
