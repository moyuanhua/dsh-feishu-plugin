# 配套配置界面 与 分发方案（设计提案）

> 状态：**提案**，未实施。所有"D SH 提供了什么"的结论都标注了出处（package README / 实测 inspect）。

## 决策记录

| # | 决定 | 日期 |
|---|---|---|
| D1 | **配置页放同一个包里**（`./client` 导出 + `dsh.client`），不拆伴生包 | 2026-10-05 |
| D2 | **分发用 npm**，形态对齐 `opencode-feishu-plugin` | 2026-10-05 |
| D3 | **发布暂缓**：本地开发 → 你先测 → 再谈发布 | 2026-10-05 |

D1 的理由见 §2.2（含对上一版高估风险的自更正）。D3 意味着：`package.json` 只保留**对本地测试也无害**的发布准备，
不写任何猜测性的 `repository` / `homepage`（仓库还没配 remote，编一个 URL 是错的）。

## 0. 结论先说

**配置界面值得做，但不能只靠 schema。** DSH 给了"半套"：

- **免费**：组合包卡片、行开关、locale 标题/描述、`icon`、Config schema 校验 + 投影成 JSON Schema。
- **不免费**：**没有任何已发布的客户端把 schema 渲染成表单**。`@deepseek-ai/dsh-settings` 原文：
  > 每个表单报告 `autoGenerate`（默认开启），供按 schema 生成页面的客户端使用；**目前没有已发布的客户端这样做**。

  官方那四个配置页（shell / agent-loop / subagent / web-search）**各是一个手写的伴生包**，不是自动生成的。

所以要做的是：**加一个客户端半侧，在插件页上占一个自己的配置页**。

**分发真正的门槛不在 npm。** 三件事按难度排序：

1. **飞书应用注册**（非代码，对方必须自己做，且最容易劝退）；
2. **DSH 版本兼容**（peer 不匹配 → 安装被**前置拒绝**）；
3. **pnpm 构建脚本拦截**（`protobufjs` → `ERR_PNPM_IGNORED_BUILDS`）。

---

## 1. DSH 已经提供了什么（实测结论）

| 能力 | 归属 | 说明 |
|---|---|---|
| 组合包卡片 / 行 / 详情页 | `dsh-client-ui-plugin-manager` | 侧栏**插件**页；卡片、行开关、安装/卸载 |
| 显示标题与描述 | `locale/zh.json` 的 `meta.title` / `meta.description` | 缺失时回退 `package.json`；**读取不需要激活插件** |
| 图标 | `package.json` 的 `icon` | 相对 manifest 目录；SVG/PNG/JPEG/WebP ≤256KiB |
| Config schema 校验 | Loader | schemastery → StandardSchemaV1 |
| **schema → JSON Schema 投影** | `host/Config` inspect provider | 实测带 `x-cordis.volatile` 标记与 `$defs.loaderExpression`（`!!js` 标量的惰性表示） |
| 行的配置页 | `plugins.row.config` slot | **键 = `<包名>#<行 id>`**；注册后该行多一个**配置**控件 |
| 整包配置页 | `plugins.bundle.config` slot | 键 = 组合包名；渲染在组合包页的描述与行之间 |
| 官方插件卡片 | `plugins.item` slot | 官方分组；`view: 'summary'` 渲染在标题下 |
| 表单状态与写入 | 页面宿主注入 `form.state` + `form.mutate(operations, expectedRevision)` | 自定义页负责草稿与校验提示，可复用 `ui-primitives` 的 `ConfigField` |
| 秘密处理 | `dsh-settings` + `ctx.credentials` | settings 表单**保留秘密值**（只给存在性标记）；`credentials.describe/set` 是凭据写入路径 |
| 写入落地 | `ctx.configEditor.edit()` | 写 profile patch，保留注释与 `!!js`；无效值/被更高层覆盖时不改文件 |
| 客户端半侧声明 | `package.json` 的 `dsh.client` + `./client` export | `platform: 'web'`、`immediately`、`inject` |

**我们的 `cordis.patch.yml` 已经声明了 `id: feishu`** —— 这正是 `plugins.row.config` 需要的行 id，所以挂载点天然就位。

---

## 2. 配置界面设计

### 2.1 挂载点

```
key = `dsh-feishu-plugin#feishu`
```

用户路径：侧栏 **插件** → 已安装 → `dsh-feishu-plugin` 卡片 → 行 `feishu` → **配置** → 我们的页面。

### 2.2 三个必须处理的坑（这是本节的重点）

#### 坑 1：行被关掉 → 页面也消失（**风险已下调**）

> `dsh-client-modules` 只把一个包的浏览器半侧挂在说明符恰为包名的那一行 Loader 行上，所以组合包为自己或任一行注册的页面，**都会在那一行被关闭时一起消失**。

**上一版把这个坑写重了，这里更正。** 行的**开关是插件页自己画的**（`ui-plugin-manager` 拥有，调 `pluginManager.setPluginEnabled`），
只有页面**内容**来自我们的客户端半侧。所以行被关掉之后：

- 行开关**还在**，用户在同一张卡片上就能把行重新打开 → **恢复路径是一键的**；
- 丢的只是"配置页"本身，而那时用户本来也不需要改配置。

**因此这不构成拆伴生包的理由**（这也是 D1 的依据）。

真正会自锁的是下面那条。

#### 坑 2：行加载失败 → 客户端半侧不挂载 → 页面消失（**真问题**）

行 failed 时浏览器半侧不发送，用户**再也打不开配置页去改那个把它弄坏的值**。

触发路径比想象中窄，但**恰好包含我们文档里教用户做的那件事**：
- `configEditor.edit()` 会在写盘**之前**按 Config schema 校验，所以从 UI 存不进非法值；
- 但我们在 README 里写了"手工把 `insert:` 那条抄进 profile 的 `cordis.patch.yml`" —— **手改 YAML 改坏 schema → 行 failed → UI 没了**；
- 另外 `!!js` 表达式求值失败也走这条路。

我们现在 [src/config.ts](../src/config.ts) 的策略正是"非法取值在插件加载时**就响亮失败**"，
配上配置页就是把自己锁死。

**对策**：对**用户可编辑**的字段，schema 只做"可解析"级别的约束，语义校验移到 `apply()` 里降级处理
（日志 + 拒绝连接 + **保持行 active**，让客户端半侧照常挂载）。硬约束只留给真正的编程错误。

> 与 [REDESIGN.md](REDESIGN.md) 的"响亮失败"不矛盾：那里管的是**运行时**（拿不到模型/目录就不建会话），
> 这里管的是**配置层**（读得进来但用不了时，不要把 UI 一起弄没）。两者都服务于"失败要可见且可改"。


#### 坑 3：秘密值不能进 patch

插件配置写在 profile 的 `cordis.patch.yml`（0600，但仍是明文），会进 git、会被贴进 issue。

**对策**（我们已经有半套）：`appSecretRef` + `ctx.credentials`
- `credentials.describe(ref)` → `{configured, source, writable}`，**不回读明文**；
- `credentials.set(ref, value)` → 写进 provider 管理的凭据库（Models 页写 API key 用的是同一条路）；
- patch 里只留 **ref 名**，不落 secret。

配置页的凭据字段应该：显示"已配置 / 未配置 + 来源"、写入走 `credentials.set`、**永不显示明文**。

### 2.3 页面内容（分组）

| 分组 | 字段 | 控件要点 |
|---|---|---|
| **凭据** | `appId` / `appSecretRef` | appId 明文；secret 只显示存在性 + "重新填写" |
| **飞书应用** | 连接状态、Domain（飞书/ Lark） | 只读状态徽标 + 下拉 |
| **工作目录** | `cwd` / `allowedRoots` | 目录选择器（`host/directory-picker` 存在）；展示校验结果 |
| **模型** | `provider` / `model` / `reasoningEffort` | 留空 = 用 DSH 默认；选项来自 `ctx.llm.listProviders()` / `listModels()` |
| **权限边界** | `permissionGate` / `allowTools` / `denyTools` / `allowUsers` / `groupEnabled` | 枚举 + 列表编辑；**这一组最值得有 UI** |
| **交互** | `busyDelivery` / `stream` / `threadRouting` / 超时 | 枚举 + 数字 |
| **诊断** | `logLevel` / `logFile`、当前连接状态 | 枚举 + 只读 |

行尾部：**保存 / 重置为部署默认**，以及一条"改动会在重启后生效（或 HMR 立即生效）"的提示。

### 2.4 spike 结论：**已用静态分析解决**，不用猜了

原计划跑一个最小 client 半侧去打印 `form.state`。改成直接读发行版源码，结论一样确定，且**没有碰你的 profile**：

| 读的文件 | 得到的事实 |
|---|---|
| `dsh-client-ui-plugin-manager/lib/client.js` | `rowConfigKey(bundle,rowId)` = `` `${bundle}#${rowId}` ``；`RowDetail` 收到的是 `formFor(openRow.rowId)` |
| 同上 | `formFor(id)`：仅当 `configForms.describe()` 里有 `ns === id` 的**设置命名空间**时才返回 `{state,mutate}`，否则 `undefined` |
| `dsh-settings/lib/types/redact.js` | *"`role('secret')` 字段在跨线之前**被移除**；另附 sidecar 记录每个秘密位置**当前是否有值**"* |
| `dsh-web-search-deepseek/lib/index.js` | 官方写法：**每个字段都 `.volatile()`**，密钥是 `z.string().role("secret").volatile()` |

**三条硬结论：**

1. **只有 `.volatile()` 字段能进这张表单。** 不标 volatile 的字段，表单**看不到、也改不了**（`dsh-settings`：*"表单只展示活动且可唯一定位的 profile 条目中的 volatile 字段"*；普通配置仍走配置文件）。
2. **密钥是现成机制**：`role('secret')` → 浏览器**收不到值**，只收到"已配置"标记；保存时发**路径寻址**的编辑，客户端没收到的字段**原样保留**。不需要我们自己搞一套 RPC。
3. 因此**配置页的可行性完全取决于"我们愿不愿意把这些字段标成 volatile"**。

### 2.5 字段分类（这是配置页真正的工作量所在）

标 `.volatile()` 意味着**热生效、不重启**：插件的 `apply()` 不会被重跑，所以我们必须**在使用时读 Config 引用**，并在必要时自己做出反应。

| 组 | 字段 | 处理 |
|---|---|---|
| **A. 直接可标 volatile** | `logLevel` `permissionGate` `allowTools` `denyTools` `busyDelivery` `stream` `cardThrottleMs` `staleExecutionMs` `questionTtlMs` `approvalTtlMs` `topicTitleMaxChars` `maxAttachmentBytes` `attachmentTimeoutMs` `groupEnabled` `threadRouting` `allowUsers` | 改成"用时读引用"，表单直接可用 |
| **B. 标 volatile + 自己监听变化** | `appId` `appSecret`（`.role('secret')`）`domain` | 变了要**重连长连接**；需要监听 Config 引用变化触发重连 |
| **C. 结构性、不适合 volatile** | `cwd` `allowedRoots` `provider` `model` `reasoningEffort` | 只影响**新建会话**，可以在建会话时读引用 → 也可以 volatile；但 `allowedRoots` 变更要考虑已在跑的会话 |

> **结论：A + C 基本可以全量 volatile（都是"用时读"），B 需要加一个"配置变更 → 重连"的路径。**
> 这样配置页就能覆盖我们**几乎全部**配置，而不是只覆盖零头。

### 2.6 凭据的两条路（都要）

1. **`appSecret` 用 `role('secret').volatile()`** —— 表单里是密码框，浏览器永远拿不到明文；
2. **`appSecretRef` 用 `role('credential-ref')`**（已经有了）—— 值走 `ctx.credentials` 凭据库，
   适合"不想把密钥写在 patch 里"的部署。

两者并存：填了 `appSecret` 用它，否则解析 `appSecretRef`。**这与 [REDESIGN.md](REDESIGN.md) §2 的克制原则一致：秘密要么进凭据库，要么进 0600 的 patch，绝不出现在日志或卡片里。**


---

## 3. 分发设计

### 3.1 四条安装路径（都可用）

| 路径 | 命令 / 入口 | 适用 |
|---|---|---|
| **npm registry** | 插件页 → 添加插件 → 包名；或 `dsh plugin --profile <p> add dsh-feishu-plugin` | 公开分发（推荐） |
| **本地绝对路径** | `add /abs/path` | 内网 / 私发；`inspect` 直接读 `package.json` |
| **Git 地址 / tarball** | `add <git-url>` | 支持，但**兼容性只能装完再判**，不通过会回滚 |
| **手工 patch 层** | 把 `insert:` 那条抄进 profile 的 `cordis.patch.yml` | 无包管理器；**没有升级路径** |

Web 页面的完整流程（Host 已实现，不需要我们写）：`inspect` 预览 → 选注册表（官方/npmmirror/自定义）→
`pnpm add` → 立即启用 → 失败自动**恢复 `package.json` 与 `pnpm-lock.yaml`**。

### 3.2 对方要做什么（交付清单）

1. 有 DSH（Desktop 或 CLI）且版本落在我们 `engines.dsh` / peer 范围内；
2. 在**飞书开放平台**建一个自建应用 → 开**长连接**订阅方式 → 加两个 scope
   （`im:message.p2p_msg:readonly` + `im:message:send_as_bot`）→ 发布版本 → 拿 appId/appSecret；
3. 装插件（上述四条之一）；
4. 打开配置页填 appId + secret → 保存；
5. 在飞书里给机器人发一条消息（**首个发消息者自动成为 owner**）。

### 3.3 版本兼容（最容易卡住的一条）

安装器会在 `pnpm` 运行**之前**读 peer 声明，不兼容就**直接失败、什么都不下载**：

> 不兼容的 DSH peer 会在 pnpm 运行前使操作失败……调用方随请求提交的构建批准在此检查之前记录，会保留下来。

我们现在是 `^0.2.0-rc.2`（7 个 dsh 包）。后果：
- DSH 升到 rc.3 → 有人装不上，除非我们**同步放宽 peer** 或对方手动加豁免；
- 豁免要 `acceptRisk: true`，且是**逐 `包@版本` × 逐运行时版本**的，不继承升级 —— 不该指望它当常规路径。

**对策**：
- `engines.dsh` 声明我们真正验证过的范围（**声明是声明**：`dsh-package-manifest` 明确"当前安装器和加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`"，真正生效的是 peer）；
- 把 peer 放宽到 `>=0.2.0-rc.2 <0.3.0` 这类**下界严格、上界宽松**的区间，而不是钉死 rc；
- 在 README 里写清"我们验证过哪些 DSH 版本"，并给一条 `dsh plugin version-exemptions` 的逃生说明。

### 3.4 构建脚本与其它已知摩擦

| 摩擦 | 现象 | 对策 |
|---|---|---|
| pnpm 拦构建脚本 | `ERR_PNPM_IGNORED_BUILDS`，**组合包不会被追加进 bundles**，看起来"装了但没生效" | 已有 `prepare` CLI；Web 页面现在也有"允许这些脚本并重试" |
| 安全 | appSecret 明文进 patch | `appSecretRef` + 凭据库（§2.2 坑 3） |
| 升级 | "插件安装后暂不支持自动更新：升级需先卸载再安装新版" | README 写清升级步骤 |
| 首次上手 | 对方看到一堆开关不知道从哪开始 | 配置页顶部放一个"三步走"引导 + 连接状态 |

---

## 4. 本地测试路径（**已实测通过**）

用**本地目录**安装，不做任何发布：

```sh
# 1) 构建
cd /Users/code/wps/dsh-feishu-plugin && pnpm build

# 2) 装进某个 profile（本地目录会被装成 link:，改完 pnpm build 即生效，不用重装）
dsh plugin --profile <profile> add /Users/code/wps/dsh-feishu-plugin

# 3) 填凭据（见下），然后启动
dsh --profile <profile>
```

实测结果：安装后 profile 的 `package.json` 变成

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-feishu-plugin"] } },
  "dependencies": { "dsh-feishu-plugin": "link:/Users/code/wps/dsh-feishu-plugin" }
}
```

启动日志：`已加载` → `飞书长连接已建立`，**0 条 error**。

### 凭据怎么给（测试期两种）

| 方式 | 做法 | 适用 |
|---|---|---|
| 环境变量 | 启动时带 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（bundle patch 里就是 `!!js process.env.…`） | 终端里跑，最快 |
| profile patch | 往 `$DSH_HOME/profiles/<p>/cordis.patch.yml` 写一条 `- id: feishu` 覆盖，**config 是整体替换，要写全** | 桌面 App（从 Finder 启动拿不到 shell 环境） |

> 第二种的"整体替换、要写全"就是配置页最该解决的问题 —— 也是 §2 存在的理由。

### 测试时要看什么

1. 飞书里给机器人发一条消息 → 应收到运行卡（流式正文 + 工具块）；
2. **故意配错一次**（比如错 appId）→ 应看到明确的失败，而不是静默无响应；
3. 触发一次工具审批 → 卡片上点「允许一次」；
4. 点机器人菜单的 `new` / `sessions` → 应和手敲 `/new` `/sessions` 效果一致。

---

## 5. 建议的落地顺序

| # | 事项 | 为什么这个顺序 |
|---|---|---|
| 1 | **降级策略改造**（坑 2）：schema 放宽 + `apply()` 降级 | 配置页的前提；不改的话，配错就自锁 |
| 2 | **配置字段 volatile 化**（§2.5 A/C 组）+ 用时读引用 | 不做这步，配置页只能编辑零头 |
| 3 | **`appId`/`appSecret` 变更 → 重连长连接**（§2.5 B 组） | 这一步才是"配置页真的有用"的关键 |
| 4 | **`locale/zh.json` + `icon` 补齐** | 零风险，插件页卡片先像样 |
| 5 | **client 半侧 + `plugins.row.config` 页面** | 前面就位后，页面本身只是画表单 |
| 6 | **本地全流程测试**（§4） | 你验收 |
| 7 | 发布准备（npm） | D3：后面再谈 |

~~spike~~ 已完成（§2.4，静态分析），不再是阻塞项。

**发布前需要补的**（现在不做）：`repository` / `homepage` / `bugs`（等仓库有 remote）、
`engines.dsh` 已就位、peer 区间已改为显式下界+上界、一条真实 npm 安装路径的端到端验证。
