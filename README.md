# dsh-feishu-plugin

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）接进飞书 / Lark：**一个飞书话题 = 一个 dsh 会话，权限审批直接在飞书卡片上点按钮。**

设计目标与 [`opencode-feishu-plugin`](https://github.com/moyuanhua/opencode-feishu-plugin) 对齐，但宿主换成 dsh 的 Cordis 插件体系，并坚持**最小权限**：只申请 `im:message.p2p_msg:readonly` + `im:message:send_as_bot` 两个 scope，不申请任何群权限 —— 机器人在平台层面就收不到群消息。

> 状态：**M3b（会话桥 + 运行卡）**。已完成：配置层、token 内核、长连接 supervisor、入站决策、单人 owner 绑定、话题↔会话映射（storageDomain）、会话创建与投递（followup/steer）、**运行卡（流式回显 + 工具块 + 强停按钮）**、`/help` `/status` `/stop`。共 **154 个单测 / 12 个文件全绿**；已在真实 dsh 宿主 + 真实飞书应用上验证过连接、入站决策与投递路径。审批卡/提问卡/附件为 M4。

## 为什么单独开一个仓库

上游插件是 opencode V2 单宿主插件（`Plugin.define` + `ctx.permission/session/event`）。它的 15,404 行里约 90% 与 opencode 语义绑定：`delivery: steer|queue`、`permission.evaluate` 改写、inbox park 取消、compaction 摘要复用、location 60 分钟回收保活、`/api/plugin` 续期。dsh 的语义（Cordis `ctx.*`、`ctx.agents` 的 `followup/steer/inject`、`approval/request` waterfall、`storageDomain`）与之不同。

因此这里**不做"跨宿主通用内核"抽象**，而是：

1. **搬运宿主无关内核**（协议 / 安全 / 策略，≈5.5k 行，含 11k 行单测）— 逐文件出处见 [NOTICE.md](NOTICE.md)；
2. **重写宿主层** — 面向 dsh 接缝，而不是兼容两个宿主；
3. 等本仓库分层稳定后，再把其中真正通用的层抽成独立包，**反向**给 opencode 侧用（先分离、后抽象）。

上游 `index.ts`(1801 行) 里约 80% 是"能力探测 + HTTP 兜底 + 多实例防御"，在单一宿主里应当**变短**而不是复用：去掉兜底后装配层预计落到 500–700 行。

## 逐层搬运上游逻辑（进行中）

按"**先把上游测试搬来当规格，再让实现通过**"的方式逐层搬（避免凭理解重写行为）：

| 层 | 上游文件 | 本仓库 | 上游规格测试 | 状态 |
|---|---|---|---|---|
| 路由 | `src/feishu/routing.ts` | `src/bridge/routing.ts` | `test/routing.test.ts`（8 用例） | ✅ |
| 会话映射 | `src/feishu/session-map.ts`（582 行，5 层 key） | `src/bridge/session-map.ts` | `test/session-map.test.ts`（24 用例） | ✅ |
| 命令矩阵 | `src/feishu/commands.ts`（16 命令 + 双 scope） | `src/bridge/commands.ts` | `test/commands.test.ts`（21 用例） | ✅ |
| 投递决策 | `src/feishu/delivery.ts` | `src/bridge/delivery.ts` | `test/delivery.test.ts`（10 用例） | ✅ |
| 运行卡 | `run-state/run-renderer/cards/card-limits` | 同名（`bridge/`、`feishu/`） | `test/run-*.test.ts`、`cards/card-limits`（79 用例） | ✅ |
| token / 白名单 / 日志 | `security/token`、`security/allowlist`、`logger` | 同名 | 逐条搬运 | ✅ |
| 入站主流程接线 | `src/index.ts:816-918` `handleMessage` | `src/index.ts` | 由 `routing`/`session-map` 规格覆盖 | ✅ |
| 建会话表单 / 会话列表卡 / 恢复摘要 | `setup-wizard`、`session-list`、`resume-summary` 等 | — | — | ⬜ |
| 审批（策略 + 卡片 + 桥） | `permission.ts`、`perm-presets.ts`、审批卡构建器 | `bridge/permission.ts`、`bridge/perm-presets.ts`、`bridge/approval.ts`、审批卡构建器 | `test/permission.test.ts`（17）、`test/perm-presets.test.ts`（9）、`test/approval.test.ts`（13） | ✅ |
| **提问（表单卡 + 文本作答）** | `forms.ts`、`form-relay.ts` | `bridge/forms.ts`、`bridge/questions.ts` | `test/forms.test.ts`（12）、`test/questions.test.ts`（17） | ✅ |
| **看门狗 + 恢复例程** | `watchdog.ts`、`session-recovery.ts` | `bridge/watchdog.ts`、`bridge/session-recovery.ts` | `test/watchdog.test.ts`（4）、`test/session-recovery.test.ts`（5） | ✅ |
| 附件 / 建会话表单 / 会话列表卡 | `attachments`、`setup-wizard`、`session-list` | — | — | ⬜ |

**产品语义（来自上游，已落地）**：
- 主聊天流（无 `thread_id` 的普通文本）= **管理台**，普通文本**不进入任何会话**，回管理台提示卡；
- 话题（回复形成 thread / 回复根卡带 `root_id`）→ 路由到会话；
- 命令**先于路由**拦截，绝不把 `/xxx` 当 prompt；
- 忙时投递：空闲 → `steer`；忙时按 `busyDelivery`（默认 `steer` 插队 / `queue` 排队）；
- 话题内命令有白名单（`/new` `/sessions` `/use` `/resume` `/dir` `/cancel` `/form` 被禁，引导回主聊天流）。

**DM 场景怎么用**（没有 quickNew 时的上游行为）：`/new` 建会话并发出"根卡" → **回复那张卡**开始对话
（回复只带 `root_id`，正是 `decideRoute` 的 root 兜底分支）；或把 `threadRouting` 设为 `false` 走"普通文本进当前会话"的回退模式。

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
- **M2 连接** ✅ `@larksuite/channel` 长连接 supervisor（世代化 + 有界指数退避 + dispose 收敛）、入站决策纯函数、单人 owner 绑定、结构化脱敏日志
- **M3a 会话桥** ✅ 话题↔会话映射（`ctx.storageDomain` 领域表 `feishu_topics`）、会话创建、投递（`followup`/`steer`）
- **M3b 运行卡** ✅ 运行卡控制器（流式正文 + 工具块 + 强停按钮，700ms 节流遵守飞书 10 次/秒限制）、`/help` `/status` `/stop`、卡片回调验签 + 防重放
- **M4 决策桥**：审批卡（四档 gate + 白名单 + token 校验）、提问卡、看门狗、附件
- **M5 发布**：扫码 onboarding、locale/icon、peer 区间对齐、兼容性矩阵与文档

## 官方文档核对（`docs/user/develop/`）

实现前逐篇读过官方开发文档（`basic/` 四篇 + `framework/` 三篇），并按其规则修正了三处：

| 文档规则 | 出处 | 落地 |
|---|---|---|
| 可调参数必须做成配置字段（"能否在 `cordis.yml` 里改这个值而不改代码？"） | `basic/config.zh.md:78-92` | 退避参数、卡片节流/上限、标题长度全部进 `Config` |
| 默认值写在 schema；非法配置在**加载时**响亮失败 | `basic/config.zh.md:9-45,94-96` | 区间约束（`min/max`）进 schemastery，`resolveConfig` 只做派生 |
| 与宿主共享实例的 dsh 包必须**同时**在 `peerDependencies` 与 `devDependencies` | `basic/publish.zh.md:103` | 已补 4 个 dsh peer（`^0.2.0-rc.2`，带预发布标签才过兼容闸门） |
| 卸载清理逆序但异步并发；顺序相关的清理放同一个 `ctx.effect` | `framework/index.zh.md:63` | 拆除标志 `disposed` + 单个 effect 内串行 stop |

**一条与文档不符的实测**：`framework/service.zh.md:95-99` 写"可选依赖：不写 inject，用 `ctx.get()` 查询"。但在 0.2.0-rc.2 的真实宿主里探针实测：

```
ctx.get('agents')  = object      ← 已在 inject 里的服务
ctx.get('tools')   = undefined
ctx.get('sessionTitle') = undefined   ← 未 inject 的可选服务拿不到
ctx.sessionTitle   = ✗ 抛 cannot get property "sessionTitle" without inject
```

所以本插件的可选服务统一用 `ctx.inject([...], sub => …)` 子级（`src/dsh/port.ts` 的 `sessionTitle` 就是这样），这也是 M3a 首次真实投递失败的原因。

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
