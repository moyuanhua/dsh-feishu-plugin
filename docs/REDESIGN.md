# dsh-feishu-plugin 重新设计：DSH 原生逻辑

> 本文替代 [`port-analysis-opencode.md`](port-analysis-opencode.md) 作为架构基准。
> 交互逻辑（用户在飞书里看到什么、能做什么）**继续对齐 opencode-feishu-plugin**；
> 但**内部逻辑不再逐层搬运**，改为面向 DeepSeek Harness 的原生接缝重新设计。

## 1. 为什么要改

旧路线是「先把上游测试搬来当规格，再让实现通过」——逐层搬 `routing` / `delivery` /
`session-map` / `commands`。它保证了**行为等价**，但代价是：插件内部结构变成了
opencode 内部结构的一份镜像。

真正的问题不在于"抄"，而在于**镜像结构在两个宿主语义不同的地方必然失真**，而且失真
不会报错——它会静默退化成一个看起来能用的错误行为。上一轮实测出的 6 个缺陷全部属于
这一类：

| # | 现象 | 根因（镜像造成的语义错位） |
|---|---|---|
| 1 | 建完会话就是废会话（`has no provider/model`） | 上游 `createSessionInternal` 把 model 一起带进来；镜像时只搬了 `directory`，**丢掉了 model**——因为 opencode 那边 model 是建会话的隐式参数，dsh 这边是必须显式给的 `agentOptions` |
| 2 | 会话工作目录是 `/private/tmp` | 上游只有"用户选目录"一条路；镜像时退化成了 `process.cwd()`——因为 opencode 有 `/dir` 表单，dsh 版当时还没搬 |
| 3 | 模型报错却显示 ✅ | 上游只有 `done/error` 两态；dsh 的 `TurnEndReasonMap` 有 7 个分支。镜像时用 `default → done` 吞掉了 `error` |
| 4 | 失败原因永远不显示 | 同上：`turn/end` 只取了 `reason.kind`，没取 `reason.error.message`；而 `RunState.reason` 本来会渲染成 `⚠️ …` |
| 5 | 卡片正文重复标题 | 卡片 header 与正文各渲染一次 title（上游 header 语义不同） |
| 6 | `/help` 列了没实现的命令 | 帮助文案是**手写清单**，与真正的命令执行表**没有单一真源** |

结论：**逐层搬运不是安全策略，而是把宿主的语义差异推迟到运行时暴露**。正确做法是
把 dsh 已经拥有的决策**问出来**（read/inject），只在真正属于本插件的地方写逻辑。

## 2. 设计原则

插件只拥有两件事：

1. **飞书侧表现层**（长连接、卡片 JSON、白名单）——与 dsh 无关，可单测；
2. **两个模型之间的翻译层**（飞书的 chat/topic/message/card-action ↔ dsh 的
   agent/session/turn/event/waterfall）。

**dsh 已经拥有的一切，只能读，不能自己算。**

| 关注点 | dsh 的真正所有者 | 本插件该做的 |
|---|---|---|
| 用哪个模型 | `ctx.agentDefaultModel.currentSelection()` | 读；允许配置覆盖；**读不到就拒绝建会话**，不猜 |
| 会话生命周期 | `ctx.agents.create/resume/get` | 带上 `agentOptions:{provider,model}` 与 `meta:{cwd}` |
| 对话状态 | 会话日志（`session/event`） | 投影成卡片，**不另建状态机** |
| 队列 / 插队 | `agent.followup`（下一轮）/ `steer`（下一步）/ `inject`（不唤醒） | 选对动词即可；dsh 的 inbox 自己管排队 |
| 权限审批 | `approval/request` waterfall | 渲染卡片，返回结果词 |
| 追问 | `user-questions/request` waterfall | 渲染卡片，返回结构化答案 |
| 附件入库 | `ctx.attachments` | 从飞书下载字节，交给服务换持久引用 |
| 绑定关系 | `ctx.storageDomain` | 只存「话题/根卡 → sessionId」+ 本插件自有的会话级放行表 |

### 由此删掉的"搬运税"

- `bridge/delivery.ts`（`ExecutionTracker` + `decideDelivery`）与 `bridge/deliver.ts`
  合并为一个 `submitToSession(port, sessionId, message, mode)`。
  **理由**：dsh 的 inbox 拥有排队语义，插件只需要在 `followup`/`steer` 里选一个；
  镜像出来的 `steer|queue` 双决策是把 opencode 的 park 队列搬到一个没有 park 队列的宿主上。
- `bridge/outbound.ts` 里自造的映射词汇 → 与 `TurnEndReasonMap` **一一对应**。
- `SessionMap` 里镜像的会话元数据（title/perm）→ 标题只作**展示缓存**保留，
  权限档位由插件自己的会话级放行表承担（dsh 的 `allowed-once` 之外没有"记住"语义）。

## 3. dsh 原生的终态契约（缺陷 3/4 的修复）

`@deepseek-ai/dsh-session` 的 `TurnEndReasonMap`（`lib/types/types.d.ts:165`）有 7 个分支，
必须**全部**映射，不允许 `default`：

| `TurnEndReason.kind` | 卡片状态 | 图标 | 附加行 |
|---|---|---|---|
| `completed` | `done` | ✅ | — |
| `max-tokens` | `done` | ✅ | ⚠️ 输出达到上限，内容可能被截断 |
| `aborted` | `stopped` | ⏹ | 由 `reason.reason.kind` 派生（`user`/`parent`/`hook`/`disposed`/`legacy`） |
| `interrupted` | `stopped` | ⏹ | 崩溃恢复：上一轮未正常结束 |
| `blocked` | `failed` | ❌ | 被策略拦截（`agent/pre-step` 拒绝等） |
| `error` | `failed` | ❌ | `error.message`（+ `error.code`），类型 `LlmFailure` |
| `forked` | —（仅 fork 种子产生，实时不会出现） | — | — |

`error` 携带的是 `LlmFailure { message, code, status?, requestId? }`。

**空正文必须显式说明**：运行卡正文为空时渲染「（本轮没有文本输出）」，
避免"只有 header 的卡"看起来像一句答案（缺陷 5 的观感来源）。

## 4. 交互契约（从上游保留，不重新设计）

以下行为**逐条对齐** opencode-feishu-plugin，作为验收规格：

- **入口**：p2p 文本 → 路由；主聊天流（无 `thread_id`）是**管理台**，普通文本不进任何会话；
  话题（`thread_id`）或回复根卡（`root_id`）→ 路由到会话；话题内第一条消息建会话。
- **命令**：`/` 开头一律**先于路由**拦截，绝不作为 prompt 送模型；主聊天流与话题内**双 scope**，
  话题内白名单外命令引导回主聊天流。
- **运行卡**：粘性（一会话一卡）、节流 patch、工具块折叠、体积翻页、强停按钮（自签 token + 防重放）。
- **审批**：卡片按钮 → 允许一次 / 本会话放行 / 拒绝；token 自签 + TTL + nonce 防重放；
  只接管**本插件拥有映射**的会话，其余委托宿主。
- **追问**：表单卡为主，自由文本兜底。
- **白名单**：空名单 = 首个发消息者绑定为 owner；非白名单用户的操作被拒。
- **卡片硬限**：请求体 ≤30KB、单卡 ≤200 组件、≤5 表格，超出降级。
- **看门狗**：陈旧执行 → 真实中断 + 通知；等待用户点击的审批/追问算合法等待，不误杀。

## 5. 分层（新）

```
src/feishu/       飞书表现层：长连接 supervisor、卡片 JSON 构建、卡片硬限、通道封装
src/bridge/       翻译层（宿主无关、纯逻辑为主）
  inbound.ts        入站消息归一化 + 门禁
  routing.ts        话题/根卡/主聊天流 → 会话归属
  session-map.ts    绑定关系（storageDomain KV）
  submit.ts         投递：followup | steer（合并旧的 delivery/deliver）
  outbound.ts       session/event → 运行卡投影（终态契约见 §3）
  run-state.ts      运行卡纯 reducer
  run-renderer.ts   运行卡纯渲染
  commands.ts       命令表（**单一真源**，/help 由它生成）
  session-commands.ts 命令执行规划
  approval.ts / questions.ts / permission.ts / perm-presets.ts
  attachments.ts / watchdog.ts / session-recovery.ts
src/dsh/          **唯一**接触 @deepseek-ai/dsh-* 的地方
  port.ts           会话生命周期 + 投递动词
  model.ts          模型解析（配置覆盖 → agentDefaultModel → 失败）
  storage.ts        域表 KV
  source.ts         消息来源声明
  menu.ts           机器人自定义菜单（onRawEvent）
src/index.ts      装配：把上面几层接到 Cordis ctx 上
```

**不可协商的约束**：`src/bridge/**` 与 `src/feishu/**` 不 import 任何 `@deepseek-ai/dsh-*`
运行时模块（类型除外），保证核心逻辑可在没有 dsh 的环境里单测。

## 6. 验收

1. `pnpm typecheck` 干净；`pnpm build` 通过；
2. `pnpm test` 全绿（**367 个用例 / 27 个文件**），且新增覆盖：
   - `TurnEndReasonMap` 全部 7 个分支 + 未知分支判失败（`test/outbound.test.ts`）；
   - 模型解析四态：配置完整 / 配置写一半 / 宿主默认 / 都没有（`test/model.test.ts`）；
   - 目录策略：越界、系统目录、根目录、`allowedRoots` 为空（`test/dirs.test.ts`）；
   - `/help` 与实际命令表一致、不列未实现命令（`test/commands.test.ts`）；
   - 菜单事件解析与未知 key 静默忽略（`test/menu.test.ts`）；
   - 空正文占位、标题只出现在 header（`test/run-renderer.test.ts`）。
3. **真机验证**（真实 dsh 宿主 `0.2.0-rc.2` + 真实飞书应用，见下）。

### 6.1 真机验证结果

用一个只读探针插件挂进真实宿主（`dsh --profile feishu --patch …`），跑的是宿主自己的
agent-loop / llm / session，**不是测试替身**。结果：

| 验证点 | 观测到的真实结果 |
|---|---|
| 插件加载 + 配置 schema | `已加载`，无 schema 报错 |
| `agentDefaultModel` 接入 | `已接入 agentDefaultModel 服务`；`currentSelection()` = `{provider:"opencode-go", model:"deepseek-v4.1-flash", reasoningEffort:"max"}` |
| 飞书长连接 | `飞书长连接已建立`；整轮日志 `level:"error"` 计数 = **0** |
| **缺陷 1 复现**：`agents.create` 不带 `agentOptions` | `turn/end.reason` = `{kind:"error", error:{message:"agent \"probe-a-…\" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall", code:"UNKNOWN"}}` —— 与线上诊断出的那条**逐字一致** |
| **缺陷 3/4 修复**：把上面这条真实载荷喂给插件的真实映射函数 | `describeTurnEnd(...)` → `{outcome:"failed", reason:"agent \"probe-a-…\" has no provider/model: …（UNKNOWN）"}` → 卡片 ❌ + 原因（旧实现是 `default → done` → ✅） |
| **缺陷 1 修复**：`agents.create` 带上 `agentOptions` | 同一轮里 `turn/end.reason` = `{kind:"completed"}` → `describeTurnEnd(...)` → `{outcome:"done"}` —— **会话真的跑完了一整轮** |
| 目录策略 | 真实运行时 `resolveWorkingDir` 返回默认目录正确；`/etc/evil` 被拒（`系统目录不可作为工作目录`） |

> 说明：首次验证时宿主的 `deepseek-official/deepseek-flash` 返回 `Insufficient Balance (402)`，
> 这本身也验证了 `error` 分支的映射（❌ + `Insufficient Balance …（QUOTA）`）；
> 换成可用的 `opencode-go` 路由后即得到 `completed`。

### 6.2 尚未验证（需要人工在飞书里操作）

- 真实飞书入站消息 → 运行卡流式渲染的观感；
- 审批卡按钮点击（允许一次 / 本会话放行 / 拒绝）的真实 toast 与卡片回写；
- 提问卡的自由文本作答；
- 机器人自定义菜单按钮的点击（需要开发者在后台配好菜单项）。

这些路径的逻辑已有单测覆盖，但**飞书侧的端到端观感未经人工确认**。

