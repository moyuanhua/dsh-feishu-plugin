# 设计方案：主会话 = 管理台，话题 = 任务会话

> 状态：**已实现**（S1–S4 全部落地，602 个单测 / 38 个文件，覆盖率 97.98%）。
> 本文保留为设计记录；实现与本文的差异见文末「实现记录」。
> 上游指 `opencode-feishu-plugin`（`/Users/code/wps/opencode-feishu-plugin`）；DSH 结论均来自本机实测（附出处）。

---

## 0. 先复盘：为什么现在这么粗糙

不是"忘了搬"，是**三次判断叠加**的结果：

1. **旧路线逐层搬运，停在"最小 `/new`"**。上游的管理面是 6 个模块：
   `quick-new.ts`(196) + `quick-generate.ts` + `setup-cards.ts`(571) + `setup-wizard.ts` +
   `session-list.ts` + `session-list-http.ts` + `session-ops.ts` + `topic-status.ts` + `resume-summary.ts`。
   旧 README 把它们统一记成"⬜ 未移植"。

2. **我上一轮修"缺陷 6"时选了错的做法**。缺陷是"`/help` 列了没实现的命令"，
   我把它修成"**帮助不再提这些命令**"——那是**把承诺删了**，不是**把功能补上**。
   你看到的"粗糙"正是这个选择的直接后果。

3. **我补 `/new` 表单时只补了"表单"**，没补上游真正值钱的那一层：**AI 引导**。
   上游的 `/new` 是"用户说一句话 → AI 判断意图并解析出目录/模型/权限 → **预填**表单 → 用户确认"。
   我做的是"发一张空表单让用户自己填"——交互层级差了一整级。

---

## 1. 目标体验

### 1.1 两个房间，两种身份

| | **主聊天流 = 管理台** | **话题 = 任务会话** |
|---|---|---|
| 有会话吗 | **没有**。它是一张索引页 | 有，恰好一个 dsh 会话 |
| 普通文本 | **AI 理解意图** → 建会话引导 / 会话列表 / 回管理台卡 | 作为 prompt 投给该会话 |
| 命令 | 会话管理类：`/new` `/sessions` `/use` `/resume` `/dir` `/cancel` | 任务操作类：`/current` `/stop` `/steer` `/perm` `/model` `/cd` |
| 强制规则 | **普通文本永不进入任何会话** | 话题内第一条消息 → 建会话并绑定 |

这条分工上游用代码强制（`index.ts:817-820` 只要 `chat_type=p2p`；`routing.ts:38-46` 的决策表；
命令白名单 `commands.ts:166-181`）。我们**保持**。

### 1.2 一句话建会话（核心体验）

```
用户（主聊天流）：帮我看下 wps 那个仓库的编译报错
   ↓ AI 意图识别（一次辅助模型调用）
   intent=create, dir=/Users/code/wps, dir_source=existing,
   title=修复 wps 编译报错, perm=edit
   ↓ 校验（防幻觉）
   dir 命中候选清单 ✅  模型未指定 → 用默认
   ↓
📝 新建会话（**预填好**的表单卡：目录/模型/权限都能改）
   ↓ 用户点「创建会话」
✅ 会话已创建 → **这张卡自己变成话题根卡** → 回复它即进入话题
```

失败降级：AI 超时 / 输出不合法 / 字段校验不过 → **直接给空表单**（`intent=create` 但字段留空是上游认可的合法结果）。

### 1.3 会话列表

```
用户：/sessions   或   "我有哪些会话"
   ↓
🧩 会话列表卡（第 1/3 页 · 共 21 个会话）
1. 修复 wps 编译报错（feishu-1ca0af07…）· 2 小时前 · 💬 已绑话题 · 📍wps   [▶️ 进入]
2. 安装 dlink（feishu-4f35438c…）· 昨天 · 📍Documents/dlink              [▶️ 再开]
   …
[⬅️ 上一页] [➡️ 下一页] [➕ 新建会话]
```

---

## 2. 上游实现全景（我们对照的基线）

### 2.1 AI 意图识别

**文件**（注意路径）：`src/session/quick-new.ts`（提示词/解析/防幻觉匹配）、`src/session/quick-generate.ts`（三条生成通道）、
`src/feishu/quick-new-cards.ts`（"正在识别意图"卡）、入口在 `src/index.ts:1056-1202` 的 `handleQuickNew`。

**提示词**（`quick-new.ts:51-66`，逐字）：

```
你是飞书 AI 助手「管理台」的意图识别器。用户在管理台（还没有会话）发来一条消息。
判断意图并尽量解析建会话字段。只输出一个 JSON 对象，不要任何其他文字：
{"intent":"create|list|chat","dir":"<绝对路径>","dir_source":"given|existing|new","title":"<不超过20字的会话标题>","perm":"readonly|edit|askHigh|trust|空","model":"<providerID/modelID 或空>","reason":"<一句话理由>"}
规则：
- 列出/查看会话 → intent=list，其余字段留空。
- 需要新建会话执行的开发/操作任务 → intent=create；闲聊、问候、询问用法 → chat。
- **目录规则（create 时 dir 绝不允许为空，按优先级）：**
  候选目录包括：最近使用目录、**允许根目录的一级子目录**、历史会话目录（可能带标题线索）。
  ① 用户消息里明确给了路径 → dir=该路径，dir_source="given"；
  ② 否则先看候选里有没有语义匹配的现成目录（尤其允许根目录的一级子目录）→ dir=该候选路径原文，dir_source="existing"；
  ③ 都不匹配才新建：dir=<允许根目录下、英文小写短横线的主题目录>（如 /Users/code/stock-research），dir_source="new"；
  ④ 实在难以命名 → dir=<第一个允许根目录>，dir_source="new"。
- perm 依据用户表述（只读→readonly、可编辑→edit、高风险→askHigh、完全信任→trust）；用户没说就留空。
- model 只能从候选模型中精确复制 providerID/modelID；用户没说就留空。
```

**注入上下文**（`buildQuickNewPrompt`，`quick-new.ts:69-99`）：允许根目录（≤8）、候选目录（≤60，带会话标题作语义线索）、候选模型（≤30）、用户消息（≤2000 字）。

**候选目录的三个来源**（`index.ts:1064-1096`）：会话列表的 `directory`（带标题）、LRU `feishu:v2:recent:dirs`、以及
`allowedRoots.slice(0,3)` 的**一级子目录扫描**（`root-scan.ts`：只扫一层，过滤隐藏目录与 `node_modules`，有 `.git` 的标 "git 仓库"）。

**防幻觉**（`quick-new.ts:156-196`）：
- `dir_source=existing` → 必须在候选清单里**精确命中**（容忍尾斜杠），否则丢弃；
- `dir_source=new` → `slugifyTitle()` 生成 ASCII 短横线名；中文标题 slug 为空则兜底允许根目录；
- `model` → 三级匹配（`providerID/id` → `id` → `name`）**必须命中候选**；
- `perm` → 限定四档。

**输出解析**（`quick-new.ts:113-150`）：取第一个 `{` 到最后一个 `}`，容忍 ```json 围栏与前后杂讯。

**dir 的六种落点与文案**（`resolveConsoleDir`，`index.ts:1000-1045`）：

| 文案 | 条件 |
|---|---|
| `✍️ 目录由**你指定**（可在下方修改）` | `given` 且 dry 校验通过 |
| `` ⚠️ 你指定的目录 `<path>` 不可用：<原因> `` | `given` 但校验失败（**不预填目录**） |
| `✓ 已匹配**历史 / 最近目录**（可在下方修改）` | `existing` 命中候选 |
| `➕ **AI 新建目录**（不存在时会在创建时自动创建…）` | AI 给的路径或 slug 兜底通过 dry 校验 |
| `🏠 使用**允许根目录**（可在下方修改）` | slug 为空或校验失败 → 退回 `allowedRoots[0]` |
| `⚠️ 未配置允许的根目录，请在下方填写目录。` | 没有 allowedRoots（实际上不可达） |

**校验时机**：预填时 **dry**（`create:false`，不碰磁盘）；提交时 **真建**（`mkdir -p`）。

### 2.2 ⚠️ 硬前置：**必须已经存在至少一个会话**

`routingSessionID = entries[0]?.sessionID`，拿不到就直接回管理台卡（`index.ts:1097-1102`）。
原因是它的三条生成通道都要一个 **routing session**（`x-opencode-session` 头 / 临时会话）。

**后果：全新安装、零会话时，AI 引导建会话完全不可用** —— 而"零会话"恰恰是最需要引导的时刻。

### 2.3 三条生成通道（`quick-generate.ts:123-199`）

C 临时会话（`POST /api/session` → `/generate` → `DELETE`）→ A `ctx.generate.text`（8s）→ B 本地 HTTP `POST /api/experimental/generate`（Basic 口令 + 15s）。
三条全失败 → 抛异常 → 回管理台卡。

### 2.4 会话列表：上游要**三级回退**

| 级 | 来源 | 出处 |
|---|---|---|
| 1 | 宿主插件 API `ctx.session.list({order:"desc"})` | `index.ts:656-663` |
| 2 | **HTTP** `GET /api/session?limit=200&order=desc&parentID=null`（发现本机 endpoint + Basic 口令） | `session-list-http.ts:38-70` |
| 3 | 自己的 KV 映射 | `session-list.ts:62` `log.warn("会话列表回退到 SessionMap")` |

**这是 opencode 插件 API 给不出可靠列表的产物，不是设计选择。**

**列表卡精确形状**（`session-cards.ts:83-155`）：
- 头：`🧩 OpenCode 会话（全部）`（blue）；空列表：`还没有会话。点下方「➕ 新建会话」创建，或直接在话题里发消息自动创建。`
- 行：`<序号>. <标题>（`<前12位id>…`）· <相对时间> · 💬 已绑话题 · 📍<目录尾> · ← 当前`
- 行按钮：`▶️ 再开`（已绑话题）／`▶️ 进入`（未绑）；当前会话用 primary
- 页脚：`⬅️ 上一页` `➡️ 下一页`（按需）`➕ 新建会话`（恒有）
- 注记：`` 第 X/Y 页 · 共 N 个会话 ``
- 分页：`sessionPageSize` 5–20，**默认 8**；序号跨页连续
- **行里没有摘要字段**（摘要只在 resume/根卡上）
- 排序：`updatedAt` 降序，`sessionID` 字典序兜底
- 列表是**全机器**的（"全部"），只有"当前"标记是按聊天的

### 2.5 `/resume` 与摘要的四级回退（`session-ops.ts:132-181`、`resume-summary.ts`）

`/resume` 发一张**新的根卡** `🔄 <title>` → `bindRoot` → `reply_in_thread` 在该卡上开话题 →
`bindThread` → **异步**把摘要 patch 回根卡。

摘要四级回退（**第①级 0 次模型调用**，很聪明）：
1. **复用 compaction 摘要** → 标签 `会话摘要`
2. 否则一次"5 条要点"快摘要（`RESUME_SUMMARY_PROMPT`）→ `摘要（快摘要）`
3. 生成失败 → transcript 截取 → `最近会话记录（截取摘要）`
4. 都没有 → `（摘要生成失败，可直接发消息继续）`

### 2.6 话题根卡状态机（`src/session/topic-status.ts`）

**默认不改标题**（避免侧栏抖动），用 header 颜色 + 页脚一行表达：

| 档位 | emoji | header | 页脚 |
|---|---|---|---|
| `review` 待审核 | 🟡 | orange | `🟡 待审核：shell` |
| `running` 运行中 | 🧠 | blue | `🧠 运行中 · 12:03` |
| `pending` 待回复 | ⏳ | grey | `⏳ 待回复（排队 2）` |
| `failed` 失败 | 🔴 | red | `🔴 失败` |
| `interrupted` 已中断 | ⏹ | grey | `⏹ 已中断` |
| `done` 完成 | ✅ | green | `✅ 完成` |

**优先级**：待审核 > 运行中 > 待回复 > 失败/中断 > 完成。

**关键实现细节**：根卡的**渲染基线**（title/dir/model/perm/summary）持久化在 `SessionLink.rootCard`，
状态变化时用 `buildSessionRootCard(base, status)` 重渲 —— 所以刷新状态**不会丢**摘要与元数据。

### 2.7 三条绑定路径

| 路径 | 根卡是 | 谁触发 |
|---|---|---|
| **建会话** | **提交的那张表单卡自己** | 表单提交 |
| **续聊** | 新发的 `🔄 <title>` 卡 | `/resume` 或列表卡的「进入」 |
| **话题优先** | 话题里的第一条消息 | 用户在未绑定话题里直接发言 |

三条都落 `bindRoot` + `bindThread`，回程靠 `root_id` / `thread_id`。

### 2.8 ⚠️ 上游**没有**删除/归档

`removeSession` / `renameSession` 已实现但**零调用者**（只在测试里）。没有 `/delete`、没有列表删除按钮、没有 TTL 清理。
唯一的删除是它自己的临时生成会话（`DELETE /api/session/{id}`）。

### 2.9 上游的几个缺陷（我们不该照搬）

| # | 缺陷 | 出处 |
|---|---|---|
| U1 | **异常路径下"🤔 正在识别意图…"卡永远不消失**（catch 里只发新卡、不 patch 那张） | `index.ts:1198-1201` |
| U2 | 零会话时 AI 引导不可用（§2.2） | `index.ts:1097-1102` |
| U3 | `/resume` **不校验会话是否存在**，可能把话题绑到一个死会话 | `session-ops.ts:167` |
| U4 | 陈旧 wizard 状态会漏进 AI 预填表单 | `setup-wizard.ts:131-139,604-608` |
| U5 | 表单提交检测过宽（任何带 `formValue` 的动作都被当成 setup 提交） | `session-commands.ts:114` |
| U6 | 三级回退的第 3 级数据不校验，被外部删掉的会话仍会出现在列表里 | `session-list.ts:62` |

### 2.10 建会话表单字段

| 字段 | 控件 | 默认 |
|---|---|---|
| `dir` | input | AI 预填的目录（dry 校验过） |
| `dir_select` | select | `✍️ 手动输入路径` / `🏠 <根目录>` / 一级子目录（仓库加 📦）；`initial_option` 匹配当前目录 |
| `model` | select | 去重后 ≤15 项；`initial_option` = 预填/当前默认 |
| `perm` | select | 四档，默认 `edit` |
| 提交 | submit | `✅ 创建会话` |

**目录优先级**（提交时）：下拉（≠自定义）→ 输入框 → `allowedRoots[0]`。

---

## 3. DSH 提供什么（实测）

### 3.1 会话列表：**一个调用就够**

`ctx.sessionQuery`（本机 Host 实测）：

| 方法 | 签名要点 | 用途 |
|---|---|---|
| `listSessions(signal?)` | → `SessionRecord[]`，**"deterministic newest-first"** | **全量会话列表**（含 GUI 会话） |
| `readTitleSnapshots(ids[])` | → 批量标题 + 各自 `updatedAt`，**单次观察**、逐会话隔离失败 | **批量取标题**（不要 N 次单查） |
| `readTitle(id)` | → `{ title, eventSeq, updatedAt, source }` | 单个标题 |
| `readSession(id)` | → 完整日志快照（replay 校验过） | 摘要 / 迁移 |
| `readSurface(id)` | → 当前模型可见面 | 续聊摘要 |
| `filterSessions(filters)` | 支持 `id` / `cwd` / `created-at` / `parent` / `availability` | 过滤子 agent 会话 |
| `traceSession(id)` | → 血缘 | 排除 subagent 树 |

`SessionRecord = { header, live, persisted }`；`SessionHeader = { id, createdAt, cwd?, parentSession?, origin?, agentPreset?, … }`。

**关键**：`dsh-base` 用 `session-query-sqlite` 且 `openAt: never`，官方说明是：
> `openAt: never` keeps `ctx.sessionQuery` mounted — **exact reads, titles, and lineage traces stay available** — while search calls fail with `SESSION_QUERY_SEARCH_DISABLED`

所以我们能用 `listSessions` / `readTitle*` / `readSession`，**但不能依赖 `searchSessions`**（默认关）。

### 3.2 **没有"最后活动时间"**

- `SessionHeader` 只有 `createdAt`；
- `sessionPersistence.stat(id)` → `{ header, revision, eventCount?, sizeBytes? }`，**没有 mtime**；
- `listSessions()` 的 "newest-first" 是**创建时间**序。

这直接影响会话列表卡的"相对时间"。见 §5.4 的三条路线。

### 3.3 辅助 LLM 调用：有官方范式

`dsh-session-title-llm` 的 `generateSessionTitleWithLlm` 是"插件自己发一次小模型调用"的权威样例：

```js
const options = { provider, model, messages: [createUserMessage({content:[{type:'text',text}], source:{kind:'…'}})], system, maxTokens, sessionId, purpose, signal };
```
- 自带 `maxInputBytes` 预检、`deadline(signal, timeoutMs)`、JSON 输出解析；
- `source.kind` 用**自己包合并进 `MessageSourceMap`** 的自定义 kind（官方明说没有通用 `plugin` kind）。

### 3.4 模型目录

`ctx.llm.listProviders()` → `[{id,name}]`；`ctx.llm.listModels(provider)` → `[{id,name,…}]`。
（我已在 `listModelChoices()` 里用过，工作正常。）

### 3.5 每会话投影：**插件可注册自己的状态单元**

`ctx.sessionProjections.register({ key, stateSchema, init, apply, stateVersion })`
—— 官方定义就是"从会话事件折叠出的每会话状态"，**并且 `session-projection-cache` 已经挂载**（写回与冷读重建由框架负责）。

**这对"话题根卡状态"是一个漂亮的答案**：根卡状态本来就是**会话日志的纯函数**。

### 3.6 对照表：上游 vs DSH

| 关注点 | 上游怎么解决 | DSH 怎么解决 |
|---|---|---|
| 全量会话列表 | 插件 API + **HTTP 兜底** + 本地镜像 | `sessionQuery.listSessions()` **一次调用** |
| 会话标题 | 自己的 KV 镜像 | `readTitleSnapshots()`（日志折叠，权威） |
| 最后活动时间 | 自己的 KV `updatedAt` | **没有** → 需自建（§5.4） |
| 目录候选 | 自己扫 + 最近记录 | `fs` + `readdir`（同） |
| 模型候选 | 宿主 API | `ctx.llm.listModels()` |
| 辅助模型调用 | 宿主 `/api/...` | `ctx.llm.stream()` + `deadline` |
| 根卡状态 | 自己写状态机 + 自己持久化 | **`sessionProjections` 注册单元**（框架管持久化） |
| 话题↔会话绑定 | 自己的 storage | **DSH 不拥有** → 必须我们自己存 |
| 日志 | 自己写文件 | `ctx.logger` + 落盘 sink |

---

## 4. 我们的设计

### 4.1 状态归属（最重要的简化）

**只存 DSH 不拥有的东西**：

| 数据 | 归属 | 说明 |
|---|---|---|
| 会话列表 / 标题 / 日志 | **DSH** | 不再镜像（删掉 `feishu:v2:chat:<id>:sessions`） |
| 会话的模型/目录/权限 | **DSH**（日志里的 `request/header`） | 不镜像 |
| 话题 ↔ 会话（`thread` / `root`） | **我们** | 飞书概念，DSH 没有 |
| 每聊天的"当前会话" | **我们** | 管理台概念 |
| 会话级放行工具表 | **我们** | dsh 只有 `allowed-once`，没有"记住" |
| 待提交的表单 | **我们**（内存） | 重启即失效，可接受 |

> 这一条能删掉上游 `session-map.ts` 582 行里**约一半**的镜像逻辑。

### 4.2 主聊天流：AI 意图路由

```
主聊天流收到普通文本
  ↓ ① 先给个"正在理解…"回执卡（可原地 patch）
  ↓ ② 组装上下文：允许根目录 / 候选目录 / 候选模型 / 用户消息
  ↓ ③ 一次辅助 LLM 调用（严格超时，如 15s）
  ↓ ④ 解析 + 防幻觉校验
  ├─ intent=list    → 会话列表卡
  ├─ intent=create  → 预填建会话表单卡
  └─ intent=chat / 失败 → 管理台提示卡
```

**这一步的几个关键决定**（编号见 §5 的完整清单）：

| 决定 | 依据 |
|---|---|
| **不做 HTTP 兜底、临时会话生成** | 上游的三条生成通道（O4）在 DSH 里压成一条 `ctx.llm` 调用 |
| **去掉"必须已有会话"的前置** | 上游硬要求一个 routing session（§2.2）；我们用 `ctx.llm` 直连，**零会话也能引导**（O6） |
| **回执卡必须走到终态** | 上游异常时"🤔 正在识别意图…"永远不消失（U1）；我们要求它一定被 patch 成 成功/失败/降级 之一（O7） |
| 候选目录**实时扫 + 从会话 `cwd` 去重** | 不需要上游的 LRU `recent.ts`（O2） |
| 目录扫描与模型列表**并发** | 上游串行 |
| 输出**先校验再落** | 上游只靠提示词 + 事后 parse；我们有 `dirs.ts` / `listModels` 两道现成校验 |

### 4.3 建会话：AI 预填 + 表单确认

表单字段（对齐上游，但**全部可选**，留空即用默认）：

| 字段 | 控件 | AI 预填 | 校验 |
|---|---|---|---|
| `dir` | input | `dir_source=given` 的路径 | 绝对路径 + 在 `allowedRoots` 内 + 非系统目录 |
| `dir_select` | select | `existing` 命中的候选（高亮） | 同上 |
| `model` | select | 命中的 `provider/model` | 必须在 `listModels` 结果里 |
| `perm` | select | 四档之一 | `isPermissionPreset` |
| 提交 | submit | — | — |

**提交后**：建会话 → **表单卡原地变成话题根卡** → 绑定 `root`+`thread`（上游语义，保留）。

**失败**：表单卡变为说明卡 + `pending` 放回，用户可重新 `/new`。

### 4.4 会话列表卡

**数据来源**（全部来自 DSH，零镜像）：

```
const records  = await sessionQuery.listSessions();
const visible  = records.filter(r => r.header.origin !== 'subagent' && !r.header.parentSession);
const titles   = await sessionQuery.readTitleSnapshots(visible.map(r => r.header.id));
```

**排序**：见下。

**"最近活动时间"的三条路线**（需要你选）：

| 路线 | 做法 | 代价 | 准确度 |
|---|---|---|---|
| **R1 只用 `createdAt`** | 直接 `listSessions()` 顺序 | 0 | 差：老会话哪怕天天用也排在最后 |
| **R2 自建 `lastActivityAt`（推荐）** | 我们从 `session/event` 已经订阅了所有会话；记录每个 session 的最后事件时间，落我们的 KV。没有记录的（纯 GUI 会话）回退 `createdAt` | 小 | 好：飞书驱动的会话 100% 准；GUI 会话退回创建时间 |
| R3 `sessionProjections` 注册单元 | 注册一个 `lastActivityAt` 折叠单元，持久化交给投影缓存 | 中；且**冷会话**仍需读日志重建 | 最好 |

**建议 R2**：会话列表要的是"我用过的排前面"，而"我用过"= "经飞书驱动过"，我们本来就有这个信号。R3 留作后续升级。

**卡片布局**（对齐上游，`session-cards.ts:83-155`）：

```
🧩 飞书会话（第 1/3 页 · 共 21 个）
1. 修复 wps 编译报错（`feishu-1ca0af07…`）· 2 小时前 · 💬 已绑话题 · 📍wps   [▶️ 进入]
2. 安装 dlink（`feishu-4f35438c…`）· 昨天 · 📍dlink                        [▶️ 再开]
[⬅️ 上一页] [➡️ 下一页] [➕ 新建会话]
```
- 每页 8 行（`sessionPageSize` 5–20，默认 8）；
- `▶️ 再开` vs `▶️ 进入`：该会话是否已绑话题；
- `← 当前` 标记当前会话。

**优化点**：上游的列表是"本聊天流全部会话"，我们**保持**（一个 p2p 只有一个管理台）。

### 4.5 话题根卡状态

**用 `sessionProjections` 注册一个单元**，而不是自己写状态机 + 自己持久化：

```ts
ctx.sessionProjections.register({
  key: 'feishu/topic-status',
  stateSchema,
  init: () => ({ phase: 'idle' }),
  apply: (state, event) => { /* turn/start → running; turn/end → done/failed/stopped; approval/asked → review */ },
  stateVersion: 1,
});
```

**但有一个约束**：`review`（待审核）来自 `approval/asked`/`approval/decided` 审计事件 ——
**它们在会话日志里**，所以投影拿得到。这正是它比上游"自己维护状态机"强的地方：**重启后从日志重建，不丢**。

**优化点**：上游的 `TopicStatusMachine` 是内存态，重启即丢；投影天然持久。

### 4.6 命令矩阵（明确"已完成/待实现"）

| 命令 | 主聊天流 | 话题内 | 状态 |
|---|---|---|---|
| `/new` `/form` | ✅ AI 引导 + 表单 | 禁（引导回主聊天流） | **本次做** |
| `/sessions` `/ls` | ✅ 列表卡 | 禁 | **本次做** |
| `/use <序号\|前缀>` | ✅ | 禁 | **本次做** |
| `/resume [序号]` | ✅ 进入话题 | 禁 | 本次做 |
| `/current` | ✅ | ✅ | 已有 |
| `/stop` `/steer` `/perm` | — | ✅ | 已有 |
| `/model` `/cd` `/now` | — | 待定 | ⬜ 本次评估 |
| `/dir` `/cancel` | ✅ | 禁 | **本次做**（表单预填/取消） |

---

## 5. 相对上游的优化点汇总

### 5.1 结构性简化（少写代码且更正确）

| # | 优化 | 收益 |
|---|---|---|
| **O1** | 删掉 HTTP 兜底（`GET /api/session`）与会话镜像，直接用 `sessionQuery` | 少 ~400 行；列表**数据不会漂移**；不再需要发现本机 endpoint + Basic 口令 |
| **O2** | 目录候选改为**实时扫描 + 从会话 `cwd` 去重**，删掉 LRU `recent.ts` | 少一个模块；候选永远是最新的 |
| **O3** | 根卡状态用 `ctx.sessionProjections.register()` | 上游是内存状态机、重启即丢；**投影是会话日志的纯函数，天然持久 + 冷读可重建**（缓存已挂载） |
| **O4** | AI 辅助调用走 `ctx.llm`（有官方范式 `generateSessionTitleWithLlm`）+ `deadline` | 上游的三条生成通道（临时会话 / `ctx.generate` / 本地 HTTP）在 DSH 里**压成一条** |
| **O5** | 会话标题用 `readTitleSnapshots()` 批量取 | 权威（日志折叠），且一次调用拿全部 |

### 5.2 修掉上游的缺陷（不照搬）

| # | 上游缺陷 | 我们的做法 |
|---|---|---|
| **O6** | **零会话时 AI 引导完全不可用**（U2） | 我们用 `ctx.llm` 直连模型，**不需要 routing session** → 全新安装照样能 AI 引导建会话 |
| **O7** | **异常时"正在识别…"卡永远不消失**（U1） | 回执卡**必须**被 patch 成某个终态（成功/失败/降级），不允许留在中间态 |
| **O8** | `/resume` 不校验会话存在（U3） | 进入前用 `sessionQuery.readSession/observeSession` 探活，失败给 `⚠️ 会话不存在` |
| **O9** | 陈旧 wizard 状态漏进 AI 预填（U4） | 每次 `/new` **重建** pending 状态，不与旧状态合并 |
| **O10** | 表单提交检测过宽（U5） | 我们已经用 `action.name === 'setup_submit'` **精确判定**，保持 |
| **O11** | 回退数据不校验、列表出现死会话（U6） | 列表**只从 `sessionQuery` 取**，"不存在"是明确状态而非静默 |

### 5.3 交互增强

| # | 优化 | 收益 |
|---|---|---|
| **O12** | 建会话表单**全字段可选** | 直接点"创建"也能建（上游已有此性质，保持并强调） |
| **O13** | 表单卡**原地变话题根卡** | 少一张卡；话题根就是用户刚操作的那张（保持上游） |
| **O14** | "最后活动时间"用我们**已有的 `session/event` 订阅**自建（R2） | 列表排序符合直觉，成本近零；上游擦的自有 `updatedAt` 会漂移 |
| **O15** | 摘要**先复用会话里已有的 compaction 摘要**（上游第①级，0 次模型调用） | 省一次模型调用；我们可以做得更干净：DSH 的 compaction 结果在日志里有明确事件 |
| **O16** | 保守删除语义：**只解绑，不删 dsh 会话** | 上游没有任何删除（`removeSession` 是死代码）；我们提供一个"从列表移除"= 仅解绑，绝不碰用户的数据 |

**明确不优化（保持上游语义）**：
- 主聊天流普通文本永不进会话；
- `/` 命令优先拦截；
- 话题内白名单（`current/stop/steer/now/help/model/perm/cd/unknown`）；
- 审批卡片按钮语义、token 绑定与 nonce 防重放；
- 「待审核」优先级最高；
- 根卡**默认不改标题**（只用颜色 + 页脚表达状态），避免侧栏话题名抖动；
- 根卡的渲染基线（title/dir/model/perm/摘要）**持久化**，状态刷新不丢信息。

---

## 6. 实现计划（分四步，每步可独立验收）

| 步 | 内容 | 验收 |
|---|---|---|
| **S1** | 删镜像：会话列表/标题从 `sessionQuery` 取；`SessionMap` 只留绑定 | 单测；真实宿主里 `/sessions` 能列出 GUI 建的会话 |
| **S2** | `/sessions` 列表卡（分页、进入/再开、当前标记） | 飞书里点得动 |
| **S3** | AI 意图路由 + 预填表单（`/new`、主聊天流普通文本） | 发"帮我看下 X 仓库"能出预填表单 |
| **S4** | 话题根卡状态（`sessionProjections` 单元 + 渲染） | 话题根卡随运行/待审核/失败变色 |

S1/S2 不依赖模型，可以先做先验；S3 依赖辅助调用，风险最高，放后面。

---

## 7. 需要你拍板的点

### Q1. "最近活动时间"走哪条路线？（列表排序依赖它）

| 路线 | 做法 | 代价 |
|---|---|---|
| R1 | 只用 `createdAt` | 0；但老会话天天用也排最后 |
| **R2（建议）** | 用我们**已经订阅的 `session/event`** 记录每个会话的最后事件时间，落我们的 KV；无记录的（纯 GUI 会话）回退 `createdAt` | 小；飞书驱动的会话 100% 准 |
| R3 | 注册 `sessionProjections` 单元 | 最准，但冷会话仍需读日志重建；实现最重 |

> 上游是自建 `updatedAt`（会漂移）。DSH **没有任何最后活动时间**（`SessionHeader` 只有 `createdAt`，`stat()` 没有 mtime）。

### Q2. AI 意图识别用哪个模型？

- **A（建议）**：跟 `agentDefaultModel` 走 —— 用户换模型，引导跟着换，零额外配置；
- B：单独配一个便宜模型（多一个配置项 + 一处可能配错）。

### Q3. 会话列表的范围？

- **A（建议）**：列**全部** dsh 会话（含你在桌面 App 建的）—— 与上游"全部"语义一致，最实用；
- B：只列"经飞书驱动过的" —— 更聚焦，但用户会问"我在 App 里建的会话去哪了"。

### Q4. `/resume` 的**摘要**这次做不做？

上游的摘要有个很聪明的设计：**第①级直接复用会话里已有的 compaction 摘要（0 次模型调用）**，后面才是一次"5 条要点"快摘要 → transcript 截取 → 放弃。

- **A**：做完整四级（体验最好，多一次模型调用）；
- **B（建议）**：先只做第①级（复用 compaction 摘要）+ 失败占位，**不加额外模型调用**；快摘要留后续。

### Q5. `/model` `/cd` `/now` 这次做不做？

| 命令 | 难度 | 说明 |
|---|---|---|
| `/model` | 低 | 换会话模型 = 下一条消息带新路由；DSH 支持（`agentOptions` 只在创建时给，切换需要新语义） |
| `/now` | 低 | DSH 的 inbox 语义不同，可能直接**不做**（我们默认就是 steer） |
| **`/cd`** | **高** | DSH 的 `session.header.cwd` **创建后不可变**。要么"换绑到一个新会话"（语义变了），要么不做。**建议这次不做，且在 `/help` 里不要列**（避免重犯缺陷 6） |

### Q6. 实现顺序确认

我建议 **S1 删镜像 → S2 会话列表卡 → S3 AI 引导建会话 → S4 根卡状态**。
理由：S1/S2 不依赖模型与 AI，风险最低且能立刻验收；S3 是风险最高的一块（辅助模型调用 + 防幻觉），放后面单独验。

---

## 8. 本轮不做什么（明确边界）

- ❌ 不再新增"我们会自己维护会话列表"的任何代码（O1 的反面）；
- ❌ 不做删除/归档 dsh 会话（O16：只解绑）；
- ❌ 不复现上游的 HTTP 兜底、临时会话生成、LRU 最近目录；
- ❌ 不在 `/help` 里列出未实现的命令（缺陷 6 的教训）。

---

## 附：上游研究结论（供审阅时对照）

- **文件路径更正**（我初稿写错过）：向导状态机 = `src/feishu/wizard.ts`；表单编排 = `src/session/setup-wizard.ts`；
  卡片构建 = `src/feishu/session-cards.ts`；列表数据 = `src/feishu/session-list.ts` + `src/session/session-list.ts`；
  意图模块 = `src/session/quick-new.ts`（**在 `session/` 下，不在 `feishu/`**）；生成通道 = `src/session/quick-generate.ts`。
- 上游版本 `0.2.18`，HEAD `ecf783e`，`src/` 共 58 个 TS 文件。
- 上游的六个缺陷（§2.9 U1–U6）都已在本文档给出对应的优化编号（O6–O11）。

| 能力 | 上游 | 现状（我们） | 本方案 |
|---|---|---|---|
| 主聊天流 AI 意图 | ✅ 完整 | ❌ 只有管理台提示卡 | ✅ 对齐 |
| 建会话表单 | ✅ 预填 | ⚠️ 空表单（我刚加，未测） | ✅ 预填 |
| 会话列表 | ✅ 三级回退 | ❌ 只有纯文本列表 | ✅ DSH 原生 |
| 话题根卡状态 | ✅ 内存状态机 | ❌ 无 | ✅ 投影单元 |
| 审批/提问 | ✅ | ✅ 已有 | 保持 |
| 运行卡 | ✅ | ✅ 已有 | 保持 |
| 话题内回复留在话题 | ✅ | ✅（刚修） | 保持 |

---

## 实现记录（落地时与设计的差异）

| 项 | 设计 | 落地 | 原因 |
|---|---|---|---|
| **S4 根卡状态** | 用 `ctx.sessionProjections.register()` 注册单元 | **插件侧折叠**（`topicStatus` Map + `reduceTopicStatus` 纯函数） | 注册投影需要模块增强一个我们没依赖的包（`dsh-session-projection`）并加依赖；`dsh-goal` 有先例但风险与工作量都不小。**纯状态机一字未改**，将来迁移只换存储层 |
| O16「只解绑不删」 | 提供一个"从列表移除"的动作 | **未做**（本轮没有删除入口） | 会话列表是 DSH 全量的，删除语义留给后续单独设计 |
| Q4 摘要 | 只做第①级（复用 compaction 摘要） | **未做** | `/resume` 当前只发根卡并绑定，摘要留后续 |
| `/cd` | 不做且不在 `/help` 列出 | ✅ 一致 | DSH 的 `session.header.cwd` 创建后不可变 |

**新增的字段与事件**（实现时引入）：
- `SessionLink.lastActivityAt` —— dsh 没有"最后活动时间"，由 `session/event` 自建（设计 §4.4 的 R2）；
- `config.sessionPageSize`（默认 8）/ `config.intentRouting`（默认开）/ `config.intentTimeoutMs`（默认 15s）。

**新增模块**：

| 模块 | 职责 |
|---|---|
| `src/dsh/session-query.ts` | `ctx.sessionQuery` 适配（列表 + 批量标题 + 探活） |
| `src/bridge/session-catalog.ts` | 纯函数：过滤 / 排序 / 分页 / 行渲染 |
| `src/feishu/session-cards.ts` | 列表卡 / 根卡 / 不存在卡 / 按钮解析 |
| `src/bridge/intent.ts` | 纯函数：意图提示词 / 解析 / 防幻觉匹配 / 目录落点 |
| `src/dsh/intent.ts` | `ctx.llm` 辅助调用（严格超时、失败降级） |
| `src/bridge/topic-status.ts` | 纯状态机：话题根卡档位 |

**写测试时发现并修掉的两个真实缺陷**（不在原设计里）：
1. `redactMeta` 只脱敏顶层键 —— `{ opts: { appSecret } }` 会把密钥写进日志；且正则里的 `pat` 会误伤 `path`、`apiKey` 反而漏网。已改为递归 + 两段式判定。
2. `TtlMap.size` 直接返回底层 Map 大小，把已过期项也算进去，与 `get`/`entries` 语义矛盾（会掩盖泄漏）。已统一为"未过期"。
