# dsh-feishu-plugin

**把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）接进飞书 / Lark。**
在飞书里开一个话题就能派活给 dsh，代码跑完的结果、要你点头的权限审批、需要你补充的信息，
全部以卡片形式回到飞书里 —— **不需要公网地址，不需要服务器**。

```
你（飞书主聊天流）：帮我看下 wps 那个仓库的编译报错
      ↓  AI 识别意图，自动把目录/模型/权限填好
📝 新建会话（目录、模型、权限都可改）
      ↓  点「创建会话」
✅ 会话已创建 —— 这张卡自己变成话题根卡
      ↓  在话题里继续说话
⏳ 运行卡（流式输出 + 工具调用 + 强制停止）
🔐 权限请求（点「允许一次」就继续）
✅ 完成
```

> 交互设计与 [`opencode-feishu-plugin`](https://github.com/moyuanhua/opencode-feishu-plugin) 一致，宿主换成 dsh 的 Cordis 插件体系。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **一个飞书话题 = 一个 dsh 会话** | 话题里发消息就是给这个会话派活；话题之间互不干扰，各自独立上下文 |
| **AI 引导建会话** | 在主聊天流随口说一句要干什么，AI 判断意图、匹配目录与模型、预填表单，你确认即可 |
| **会话列表** | `/sessions` 列出**全部** dsh 会话（包括你在桌面 App 里建的），带相对时间、目录、是否已绑话题，可翻页、可直接进入 |
| **流式运行卡** | 模型输出、工具调用实时回显；工具块自动折叠；运行中可点「强制停止」 |
| **卡片上审批** | 工具要权限时直接在飞书卡片上点，不用回到电脑前 |
| **卡片上追问** | 模型需要你补充信息时发提问卡，点选项或直接回文字都行 |
| **话题状态一目了然** | 话题根卡随状态变色：🟡 待审核 / 🧠 运行中 / ⏳ 待回复 / 🔴 失败 / ⏹ 已中断 / ✅ 完成 |
| **图片与文件** | 直接把图或文件发进话题，会自动落盘并交给模型 |
| **机器人菜单** | 飞书底部的 `new` / `sessions` 按钮等价于 `/new` / `/sessions` |
| **看门狗** | 会话卡死会自动中断并通知你（等待你审批/回答的时间不算卡死） |

## 为什么用它

- **最小权限**：基础只申请两个 scope（`im:message.p2p_msg:readonly` 收单聊消息 +
  `im:message:send_as_bot` 发卡片）。**机器人在平台层面就收不到群消息** —— 我们不订阅群消息事件，
  也不申请它需要的 `im:message.group_msg`（敏感权限），不存在"被拉进群乱说话"的可能。
  收图片/文件需要额外开一个 `im:message`（平台要求），**不用附件就别开**。
- **不需要公网端点**：走飞书长连接（WebSocket），你在自己电脑上跑就行。
- **单人对单机**：首个给机器人发消息的人自动绑定为 owner，之后其他人会被静默忽略；
  配合飞书后台的"可用范围：仅本人"，边界由平台兜底。
- **失败看得见**：模型报错会显示 ❌ 和**真实原因**，不会把失败装成成功。

---

## 快速开始

### 1. 在飞书开放平台建一个应用

1. 到 [飞书开放平台](https://open.feishu.cn/app) 创建**企业自建应用**；
2. **添加「机器人」能力**并**发布版本**（不发布的话长连接会一直卡在解析 bot 身份）；
3. **事件与回调**：
   - 订阅方式选 **使用长连接接收事件**（不要选 Webhook）；
   - 订阅事件：`im.message.receive_v1`；
   - （可选）订阅 **机器人自定义菜单事件** `application.bot.menu_v6`，否则底部菜单按钮点了没反应；
   - 添加回调：`card.action.trigger`（卡片按钮必需，零权限要求）；
4. **权限管理**按下表开权限；
5. **可用范围**建议选「仅本人」；
6. 发布版本，记下 **App ID** 与 **App Secret**。

### 2. 安装插件

```sh
dsh plugin --profile <profile> add dsh-feishu-plugin
```

**这一步在全新 profile 上会先失败一次**，这是已知的、也是必经的：

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs@7.6.6
```

原因：pnpm ≥10 默认拒绝运行依赖的构建脚本，而本插件的飞书 SDK 会带进 `protobufjs`。
**那次失败不是白跑** —— dsh 已经在 profile 里留下了需要你表态的占位符。按顺序走完：

```sh
# ① 用本包自带的 CLI 把占位符改成明确的 false（幂等，随便跑几次都行）
dsh-feishu-plugin prepare --profile <profile>

# ② 清掉半装状态，再装一次（这一步不能省：直接重试会因为"Already up to date"
#    跳过包裹选择，结果是"依赖装了、bundles 没加 = 装了不生效"）
cd $DSH_HOME/profiles/<profile>
rm -rf node_modules pnpm-lock.yaml
python3 -c "import json;p='package.json';d=json.load(open(p));d.pop('dependencies',None);json.dump(d,open(p,'w'),indent=2)"

# ③ 重新安装
dsh plugin --profile <profile> add dsh-feishu-plugin
```

验证（不需要启动）：

```sh
python3 -c "import json;print(json.load(open('$DSH_HOME/profiles/<profile>/package.json'))['dsh']['profile']['bundles'])"
# 应包含 dsh-feishu-plugin
```

> 也可以在**侧栏 → 插件**页里图形化完成同样的操作（安装、允许构建脚本、启用）。

### 3. 填配置

把凭据写进该 profile 的 `cordis.patch.yml`（路径 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: feishu
  config:
    appId: cli_xxxxxxxxxxxx
    appSecret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    # 其余字段见下方「配置项」，留空即用默认值
```

> 注意：patch 的 `config` 是**整体替换**而不是深合并 —— 覆盖这一行时要把它需要的字段都写出来。

### 4. 启动并绑定

```sh
dsh --profile <profile>
```

看到 `飞书长连接已建立` 就成功了。然后在飞书里**给机器人发一条消息** ——
**第一个发消息的人会自动成为 owner**，之后其他人会被静默忽略。

---

## 怎么用

### 主聊天流 = 管理台

**普通文本不会进入任何会话**，它只做一件事：理解你想干什么。

```
帮我看下 wps 那个仓库的编译报错
```

AI 会判断这是"要干活"，然后：
- 匹配到 `/Users/code/wps` 这个目录（候选来自你允许的根目录下的子目录 + 历史会话目录）；
- 用你当前的默认模型；
- **把表单预填好发给你**，目录、模型、权限都能改，点「创建会话」即可。

如果只是闲聊或问用法，它会回一张管理台提示卡，不会建会话。

也可以直接敲 `/new` 打开空白表单。

### 话题 = 任务会话

在话题里发消息就是给这个会话派活：

```
你：这个报错怎么修
🤖：（流式输出 + 工具调用，实时回显）
🔐 权限请求：shell
     [✅ 允许一次] [🔓 始终允许] [✅ 本会话内允许该工具] [❌ 拒绝]
```

**一张话题根卡**会跟着状态变色，一眼看出这个会话在干嘛。

### 命令

**主聊天流与话题内是两套命令**：建会话/会话管理在主聊天流做，任务操作用话题内命令。

| 命令 | 在哪用 | 作用 |
|---|---|---|
| `/new [标题]`、`/form [标题]` | 主聊天流 | 打开发建会话表单 |
| `/sessions`（别名 `/ls`） | 主聊天流 | 会话列表卡（翻页 / 进入 / 新建） |
| `/use <序号\|会话id前缀>` | 主聊天流 | 切换当前会话 |
| `/current` | 都可以 | 看当前（话题内为"本话题"）会话 |
| `/stop` | 都可以 | 中断正在跑的任务 |
| `/steer <文本>` | 都可以 | 打断当前步骤，立即插队发送 |
| `/perm [档位]` | 都可以 | 查看 / 修改本会话的权限档位 |
| `/help` | 都可以 | 显示帮助（**只列真正可用的命令**） |

话题内敲建会话类命令，会提示你回主聊天流（`/new` `/sessions` `/use` 等）。

**还没实现的命令**：`/model` `/cd` `/now` `/dir` `/cancel` `/resume`。
它们**不会出现在 `/help` 里**（避免误导），但敲了会明确告诉你原因。
其中"续聊历史会话"由**会话列表卡的「▶️ 进入 / ▶️ 再开」**承担。

### 权限档位

建会话时可以选四档，决定这个会话里工具调用要怎样审批：

| 档位 | 含义 |
|---|---|
| 🔒 只读 | 禁止编辑 / 执行 / 写入，最安全 |
| ✏️ 可编辑 | 允许改文件；执行命令需你审批（默认） |
| ⚠️ 高风险审批 | 继承默认规则，对 shell / 编辑 / 外部目录逐次审批 |
| 🔓 完全信任 | 放行全部操作，请谨慎使用 |

「本会话内允许该工具」只影响**当前会话**，其他会话不受影响；改权限档位会清空这个放行表。

### 发图片和文件

直接把图片或文件发进话题即可，会自动下载并交给模型；下载失败不会阻断这一轮，只会在正文里附一行说明。

> 需要开 `im:message` 权限（见「权限清单」）。没开的话附件会被跳过，文字照常收到。

---

## 配置项

完整字段与注释见 [`cordis.patch.yml`](cordis.patch.yml)。常用字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `appId` / `appSecret` | — | 飞书应用凭据（必需，否则插件保持禁用） |
| `appSecretRef` | — | 改用凭据库里的名字（不把密钥写进配置文件） |
| `domain` | `https://open.feishu.cn` | 国际版填 `https://open.larksuite.com` |
| `allowedRoots` | `[用户家目录]` | 允许作为会话工作目录的根；**越界一律拒绝** |
| `cwd` | `allowedRoots[0]` | 新会话的默认工作目录 |
| `allowUsers` | `[]` | open_id 白名单；空 = 仅首个发消息者绑定的 owner |
| `groupEnabled` | `false` | 群入口开关（默认关，且平台上收不到群消息） |
| `permissionGate` | `gate` | 全局审批门：`off` / `notify` / `gate` / `lockdown` |
| `allowTools` / `denyTools` | 读类工具免审批 | 免审批白名单（支持 `prefix*`）与强制拒绝 |
| `busyDelivery` | `steer` | 会话忙时新消息：`steer` 立即插队 / `queue` 排队 |
| `intentRouting` | `true` | 主聊天流的 AI 意图识别；关掉就只回管理台提示卡 |
| `intentTimeoutMs` | `15000` | 意图识别超时（超时降级为空表单，不影响使用） |
| `sessionPageSize` | `8` | 会话列表每页行数（5–20） |
| `provider` / `model` | 用 dsh 默认模型 | 想给飞书单独指定模型时**两个都要写** |
| `staleExecutionMs` | `300000` | 看门狗阈值；`0` 关闭 |
| `approvalTtlMs` | `600000` | 审批按钮有效期 |
| `cardThrottleMs` | `700` | 运行卡更新节流（飞书限同一卡片 ≤10 次/秒） |
| `logLevel` / `logFile` | `info` / 关 | 排错时设 `debug` 与 `logFile: true` |

**建会话的两个前置条件**（拿不到就**拒绝建会话**并说明原因，而不是建一个跑不起来的会话）：

| 关注点 | 取值顺序 |
|---|---|
| 模型 | 配置 `provider`+`model` → dsh 的默认模型 |
| 工作目录 | 表单里选的 → 配置 `cwd` → `allowedRoots[0]`，再过越界与系统目录校验 |

---

## 权限清单（部署时照做）

| 项 | 值 |
|---|---|
| API 权限（必开） | `im:message.p2p_msg:readonly` —— 接收用户发给机器人的单聊消息 |
| API 权限（必开） | `im:message:send_as_bot` —— 以应用身份发消息（所有卡片都靠它） |
| **API 权限（要收图片/文件就必开）** | **`im:message`** —— 官方《获取消息中的资源文件》要求 `im:message` / `im:message:readonly` / `im:message.history:readonly` **任一即可**。**不开则只收得到文字，附件会被跳过** |
| 事件订阅方式 | **使用长连接接收事件**（不要选 Webhook） |
| 订阅事件 | `im.message.receive_v1` |
| 订阅事件（可选） | `application.bot.menu_v6` —— 机器人自定义菜单，不订阅则底部菜单按钮点了没反应 |
| 回调 | `card.action.trigger` —— 卡片按钮必需（零权限要求） |
| 机器人能力 | 必须开启并**发布版本** |
| 可用范围 | 建议「仅本人」—— 单人边界的平台层保证 |
| **不要申请** | 任何 `im:message.group_msg*`（获取群组中所有消息，敏感权限）与 `im:message.group_at_msg*` |

> **`im:message` 名字里带"群组"，但不会让机器人收到群消息。**
> 它只影响能否**通过 API 读取**消息；能不能**收到**群消息由**事件权限**决定 ——
> 我们既不订阅群消息事件、也不申请 `im:message.group_msg`，所以机器人在平台层面就收不到群消息。
>
> 如果连附件也不需要，那就**不要开 `im:message`**，权限可以收到最紧；插件会自动降级为只收文字。

---

## 常见问题

**装了但没生效？**
`dsh --profile <profile> --dump-config | grep '== dsh-feishu-plugin'` 看层在不在。
不在的话多半是 `ERR_PNPM_IGNORED_BUILDS`（见「安装」里的说明）。

**在飞书里发消息没反应？**
1. 看日志有没有 `飞书长连接已建立`；
2. 确认应用**已开启机器人能力并发布版本**（否则连 bot 身份都解析不出来）；
3. 确认你是 owner 或白名单用户 —— **非白名单用户会被静默忽略**（不回复，这是有意的）；
4. 把 `logLevel` 设成 `debug` 再看。

**点了机器人底部菜单没反应？**
需要在开发者后台订阅 `application.bot.menu_v6`。没订阅的话事件根本不会推过来，
日志里也不会有"收到机器人菜单事件"。

**消息发出去了，但卡片停在"运行中"不动？**
模型或网络卡住时看门狗会在 `staleExecutionMs`（默认 5 分钟）后自动中断并通知你。
等待你审批或回答的时间**不算卡死**，不会被误杀。

**发图片/文件给机器人，它说收不到？**
去开发者后台加 **`im:message`** 权限并重新发布版本 —— 《获取消息中的资源文件》要求
`im:message` / `im:message:readonly` / `im:message.history:readonly` 任一。
没这个权限时附件会被跳过，但**文字消息照常工作**（这是有意的降级，不会把整轮弄挂）。

**报错显示 ❌ 和一个我看不懂的原因？**
卡片上那行 ⚠️ 是模型/服务商返回的**原始错误**（如 `Insufficient Balance（QUOTA）`）。
这是有意保留的 —— 比"失败了但不说为什么"有用。

---

## 参与开发

```sh
pnpm install
pnpm run typecheck
pnpm test              # 602 个用例
pnpm run test:coverage # 覆盖率门槛写在 vitest.config.ts
pnpm run build
```

设计文档（写给维护者，不是使用说明）：

| 文档 | 内容 |
|---|---|
| [docs/REDESIGN.md](docs/REDESIGN.md) | 分层与宿主接缝：哪些归 dsh、哪些归插件，终态契约 |
| [docs/DESIGN-SESSION-MANAGEMENT.md](docs/DESIGN-SESSION-MANAGEMENT.md) | 会话管理面（管理台 / 话题 / AI 引导 / 列表 / 根卡状态）的设计与实现记录 |
| [docs/CONFIG-UI-AND-DISTRIBUTION.md](docs/CONFIG-UI-AND-DISTRIBUTION.md) | 配套配置界面与分发方案（提案） |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | 发布 runbook（首次 bootstrap / 后续打 tag / DSH 版本兼容） |
| [NOTICE.md](NOTICE.md) | 与 `opencode-feishu-plugin` 的来源与授权说明 |

## 许可

MIT，Copyright (c) 2026 moyuanhua。
