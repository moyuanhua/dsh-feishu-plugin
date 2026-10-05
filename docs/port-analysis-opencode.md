# opencode-feishu-plugin → DeepSeek Harness / Cordis 移植分析

只读分析（未改动项目任何文件）。基线：`package.json` v0.2.18，peer `@opencode/plugin >=2.0.16`（实测 2.0.16–2.0.18，见 `package.json:55-57`）；`src/` 58 个 TS 文件 / 15,404 行；`test/` 49 文件 / 11,253 行；纯逻辑（飞书+安全+工具层）≈5,529 行。

---

## 1. 模块清单表

| 文件 | 行 | 职责 | 关键导出（行号） |
|---|---|---|---|
| `src/index.ts` | 1801 | 唯一入口：`Plugin.define` 装配全部 ctx 适配、路由、审批、看门狗、cleanup | `default`(:101)；内部适配 `cancelQueuedPrompts`(:1506) `replyForm`(:1541) `promoteQueuedInbox`(:1571) `replyPermission`(:1603) `promptSession`(:1634) `readSessionMessages`(:1662) `compactSession`(:1706) |
| `src/types.ts` | 224 | 共享类型；刻意不 import opencode，保证纯模块可单测（:1-5） | `IncomingMessage`(:36) `CardAction`(:66) `PermissionRequestLike`(:83) `PermissionRepliedLike`(:98) `SessionLink`(:181) `ThreadLink`(:211) `StorageLike`(:220) |
| `src/config.ts` | 592 | 配置解析/校验，永不抛异常；options > `plugins/feishu.json` > env | `resolveConfig`(:236) `ResolvedConfig`(:24) `normalizeGatewayLocation`(:439) `resolveLogFile`(:463) `expandEnv`(:512) `deriveSignSecret`(:521) `shouldRegisterEvaluate`(:534) |
| `src/logger.ts` | 121 | 结构化 JSON 日志 + secret 脱敏 + 文件 sink | `createLogger`(:53) `redactMeta`(:37) `maskId`(:76) `errorMessage`(:81) `createLogSink`(:100) |
| `src/lifecycle.ts` | 251 | 进程级 setup 单例守卫 + 网关精确匹配选举 + 未命中告警 | `acquireProcessGuard`(:53) `releaseProcessGuard`(:65) `markExactGateway`(:103) `waitForExactGateway`(:124) `trackGatewayLocationSeen`(:191) |
| `src/permission.ts` | 492 | 审批门：策略纯函数 + 审批卡状态机（token/防重放/会话放行） | `decideEffect`(:55) `decideEffectForSession`(:93) `parseApprovalValue`(:129) `parseAllowSessionValue`(:148) `ApprovalManager`(:210) |
| `src/session-commands.ts` | 214 | 会话命令**薄门面**：文本命令分发 + 卡片回调 3 秒 toast | `SessionCommands`(:49)、`handleText`(:87) `handleCardAction`(:111) `dispatch`(:153) |
| `src/security/token.ts` | 296 | 卡片按钮自签 token：HMAC-SHA256 + b64url + TTL + nonce 防重放 | `signApproval`(:82) `verifyApproval`(:105) `signStop`(:232) `verifyStop`(:254) `signAllowSession`(:155) `verifyAllowSession`(:187) `ReplayGuard`(:281) |
| `src/security/allowlist.ts` | 97 | 单人白名单/owner 引导（纯判定 + 首个发消息者绑定） | `isUserAllowed`(:12) `matchesAny`(:19) `OwnerPolicy`(:31) `OWNER_STORAGE_KEY`(:10) |
| `src/utils/ttl-map.ts` | 86 | 惰性过期 TTL Map（去重/防重放/待批跟踪） | `TtlMap`(:6)、`setIfAbsent`(:60) `entries`(:84) |
| `src/utils/throttle.ts` | 82 | leading+trailing 节流器（流式卡片 ≥400ms） | `createThrottler`(:24) `Throttler`(:6) |
| `src/feishu/gateway.ts` | 164 | 飞书长连接：WSClient + EventDispatcher 注册 3 个事件 | `startGateway`(:39)、注册表 :56-117 |
| `src/feishu/events.ts` | 272 | 飞书事件 → 内部模型归一化（纯函数） | `parseIncomingMessage`(:130) `parseCardAction`(:190) `parseBotMenuEvent`(:173) `extractMessageText`(:33) `isP2PChat`(:224) `describeCardActionEvent`(:251) |
| `src/feishu/sender.ts` | 291 | 飞书发送薄封装（create/reply/patch/text/file/delete）+ 发送层卡片守卫 | `createFeishuSender`(:90) `FeishuSender`(:56) `describeLarkError`(:18) |
| `src/feishu/cards.ts` | 290 | 卡片 JSON 2.0 构建（流式/审批/提示/终答），28KB 截断 | `buildStreamingCard`(:45) `buildApprovalCard`(:60) `buildResolvedCard`(:177) `cardButton`(:229) `truncateCardContent`(:258) `MAX_CARD_BYTES`(:13) |
| `src/feishu/session-cards.ts` | 480 | 会话列表卡/恢复卡/**统一话题根卡**构建器 | `buildSessionRootCard`(:196) `buildSessionListCard`(:83) `buildSessionOpenedCard`(:323) `parseSessionCardValue`(:158) `sessionRowLine`(:69) |
| `src/feishu/setup-cards.ts` | 571 | 建会话表单卡（目录/模型/权限）与表单值解析 | `buildSetupFormCard`(:283) `parseSetupFormValues`(:448) `resolveSetupFormDir`(:429) `SETUP_FORM_CMD`(:59) `parseSetupCardValue`(:500) |
| `src/feishu/card-limits.ts` | 273 | 卡片内容守卫：表格降级为代码块（≤5 硬限）+ 组件数 ≤200 | `enforceCardLimits`(:180) `toCardMarkdown`(:163) `degradeExtraTables`(:135) `DEFAULT_CARD_MAX_TABLES`(:20) |
| `src/feishu/run-state.ts` | 273 | 运行卡**纯 reducer**（块/页脚/终态，按 assistantMessageID 分 step） | `reduce`(:125) `initialRunState`(:73) `RunState`(:43) `RunEvent`(:57) |
| `src/feishu/run-renderer.ts` | 380 | 运行卡渲染：工具块折叠（≥3 合并）、字段与整卡体积截断 | `renderRunCard`(:56) `RenderRunCardOptions`(:36)；常量 :22-30 |
| `src/feishu/run-controller.ts` | 449 | 运行卡生命周期：beginRun/节流 patch/排队晋升/终态收尾 | `createRunController`(:143) `QUEUED_DRAIN_GRACE_MS`(:141) |
| `src/feishu/run-stop.ts` | 118 | 「强制停止」按钮：value 解析 + 白名单→验签→防重放 | `StopController`(:57) `parseStopActionValue`(:24) `buildStopValue`(:35) |
| `src/feishu/forms.ts` | 281 | opencode form/question 归一化 + 表单卡构建 | `normalizeForm`(:82) `buildFormCard`(:171) `parseFormAction`(:117) `isComplete`(:140) |
| `src/feishu/form-relay.ts` | 434 | 待答表单中继：form.created→表单卡；选项点击/自由文本→答复 | `FormRelay`(:72)、`onCreated`(:83) `consumeText`(:186) `hasPendingFor`(:257) |
| `src/feishu/form-reply.ts` | 148 | 表单答复的**本机 HTTP 兜底**（`service.json` + Basic 认证） | `discoverLocalService`(:51) `serviceStatePath`(:45) `authHeaders`(:78) `replyFormOverHttp`(:119) `cancelFormOverHttp`(:92) |
| `src/feishu/delivery.ts` | 118 | 投递决策（steer/queue）+ 执行态跟踪 + 子会话父链 | `decideDelivery`(:24) `ExecutionTracker`(:28) `SessionParentLinks`(:82) |
| `src/feishu/session-recovery.ts` | 107 | 共享恢复例程：中断 + 取消排队 + 清执行态 + 卡片收尾 | `createSessionRecovery`(:47) `SessionRecoveryDeps`(:19) |
| `src/feishu/watchdog.ts` | 58 | 卡死扫描（陈旧执行/排队超时），默认 60s 一拍 | `startWatchdog`(:54) `runWatchdogTick`(:31) |
| `src/feishu/routing.ts` | 53 | 话题路由决策纯函数（thread→root→新建→管理台） | `decideRoute`(:38) `commandScope`(:51) `RouteFacts`(:19) |
| `src/feishu/commands.ts` | 195 | 命令表/别名解析 + 帮助文案 + 话题禁用集 | `parseCommand`(:65) `isCommand`(:57) `helpText`(:130) `isCommandAllowedInThread`(:179) `topicTitle`(:190) |
| `src/feishu/perm-presets.ts` | 126 | 权限四档 → ruleset/gateMode/askActions（纯表） | `PERMISSION_PRESETS`(:27) `presetToRuleset`(:64) `presetGateMode`(:86) `presetAskActions`(:91) `appendAllowRules`(:112) |
| `src/feishu/dirs.ts` | 173 | 工作目录校验：绝对路径 + allowedRoots + 系统目录禁区 + realpath 逃逸检查 | `validateDirectory`(:95) `isUnder`(:67) `SYSTEM_DIRS`(:18) |
| `src/feishu/root-scan.ts` | 80 | 允许根目录一级子目录扫描（目录候选，≤15） | `scanRootSubdirs`(:46) `MAX_ROOT_SUBDIRS`(:22) |
| `src/feishu/attachments.ts` | 238 | 图片/文件下载挂载：落盘会话目录，超限/超时降级 | `downloadAttachment`(:173) `resolveAttachmentDir`(:26) `AttachmentResourceClient`(:45) `ATTACHMENT_DIR_RELATIVE`(:18) |
| `src/feishu/session-map.ts` | 582 | 飞书 chat/thread/root ↔ session 映射持久化 + 内存热缓存 | `SessionMap`(:61)、key 前缀 :21-30；`bindThread`(:130) `resolveByThread`(:159) `resolveByRoot`(:192) `setSessionMeta`(:112) `ensureSessionLink`(:266) `setRootCard`(:326) |
| `src/feishu/session-list.ts` | 217 | opencode 会话列表归一化（id/title/model/permissions/location） | `normalizeSessionList`(:37) `normalizeSessionInfo`(:53) `extractSessionPermissions`(:79) `extractSessionTitle`(:69) `toMillis`(:98) `fallbackEntries`(:137) |
| `src/feishu/models.ts` | 160 | 模型列表归一化/匹配与**读回校验** | `normalizeModelList`(:24) `extractSessionModel`(:72) `matchModel`(:127) `ModelSwitchOutcome`(:87) |
| `src/feishu/dedup.ts` | 88 | 按 messageId 跨实例去重（storage + 内存快路径，TTL 10min） | `MessageDedup`(:26) `DEFAULT_DEDUP_TTL_MS`(:19) |
| `src/feishu/wizard.ts` | 162 | 建会话向导状态持久化 + reducer | `WizardStore`(:112) `reduceWizard`(:39) `wizardStepHint`(:59) `WIZARD_KEY_PREFIX`(:11) |
| `src/feishu/recent.ts` | 83 | 最近目录/模型存储 | `RecentStore`(:35) `RECENT_DIRS_KEY`(:10) `RECENT_MODELS_KEY`(:11) |
| `src/feishu/topic-guidance.ts` | 79 | 话题软引导：向 system 注入一句主题说明（带 marker 去重） | `injectTopicGuidance`(:52) `buildTopicGuidance`(:44) `TOPIC_GUIDANCE_MARKER`(:17) |
| `src/feishu/quick-new-cards.ts` | 19 | 「识别中」占位卡 | `buildQuickNewThinkingCard`(:5) |
| `src/runtime/event-router.ts` | 260 | **事件分发纯函数**：opencode 事件名 → reducer/审批/表单接线 | `routeEvent`(:44) `EventRouterDeps`(:16) `extractErrorText`(:229) `contentToText`(:242) |
| `src/runtime/card-action-router.ts` | 65 | 卡片回调分流顺序：表单→强停→压缩→命令/向导→审批 | `routeCardAction`(:28) `CardActionRouterDeps`(:14) |
| `src/runtime/topic-status.ts` | 173 | 话题根卡状态接线：档位变化才整卡 patch + 节流 + 连续失败熔断 | `createTopicStatusController`(:59) `MAX_CONSECUTIVE_FAILURES`(:20) |
| `src/session/context.ts` | 328 | 会话命令的共享契约与通用原语（reply/patchCard/loadModels/scope 解析） | `SessionCommandsDeps`(:50) `SessionPrimitives`(:164) `createSessionContext`(:275)、4 个子 API 接口 :182/:212/:234/:245 |
| `src/session/session-list.ts` | 466 | `/sessions` 三级数据源 + 分页卡 + 「进入话题」全流程 + 恢复摘要 patch | `cmdSessions`(:31) `loadSessionEntries`(:52) `buildListCard`(:117) `enterSessionThread`(:161) `applySessionCardAction`(:412) |
| `src/session/setup-wizard.ts` | 669 | `/new` `/form` `/dir` `/model` `/perm` `/cancel` + 表单提交建会话开话题 | `cmdNew`(:68) `openSetupForm`(:96) `buildPrefilledSetupForm`(:125) `applySetupFormSubmit`(:400) `createSessionFromSetup`(:491) |
| `src/session/session-ops.ts` | 245 | `/use` `/current` `/stop` `/cd` `/resume` `/now` `/steer` | 各命令 :20/:40/:78/:108/:132/:184/:211 |
| `src/session/model-perm.ts` | 222 | 话题内模型切换/权限档位编排与回执 | `switchModelInThread`(:98) `setPermInThread`(:141) `renderModelCard`(:58) `modelSwitchDoneCard`(:191) |
| `src/session/topic-status.ts` | 291 | 话题状态**纯状态机**：档位优先级 review>running>pending>failed>done | `TopicStatusMachine`(:159) `computeTopicStatus`(:69) `topicStatusFooter`(:89) `topicStatusMeta`(:51) |
| `src/session/resume-summary.ts` | 267 | 恢复卡摘要三路径：复用 compaction 摘要→快摘要→截取 | `summarizeSession`(:187) `extractLatestSummary`(:92) `buildTranscript`(:113) `RESUME_SUMMARY_PROMPT`(:20) `TRANSCRIPT_LIMIT`(:23) |
| `src/session/compact.ts` | 204 | 「🗜 压缩并总结」：白名单→验签→防重放→触发+轮询新摘要 | `CompactController`(:76) `parseCompactActionValue`(:33) `COMPACT_CMD`(:23) |
| `src/session/compact-http.ts` | 101 | 压缩/读消息的 HTTP 兜底（`ctx.session.compact`/`message.list` 常缺） | `compactSessionHttp`(:71) `fetchSessionMessagesHttp`(:38) |
| `src/session/session-list-http.ts` | 70 | `GET /api/session` 全量会话兜底（含 TUI/Web） | `listSessionsOverHttp`(:45)；参数 limit/order/parentID :52-54 |
| `src/session/keepalive.ts` | 340 | location 保活：`GET /api/plugin` 续期/重建 + 进程级看门狗 + 探针会话 | `touchLocationOverHttp`(:59) `ensureGatewayWatchdog`(:236) `startKeepalive`(:323) `KEEPALIVE_SESSION_TITLE`(:35) |
| `src/session/quick-generate.ts` | 290 | 「不喂整会话」的临时生成三级通道 C→A→B | `quickGenerateWithSession`(:123) `sessionRoutingHeaders`(:89) `TEMP_SESSION_TITLE`(:38) |
| `src/session/quick-new.ts` | 196 | 主聊天流一句话建会话：prompt 构造 + 决策解析 + 目录/模型匹配 | `buildQuickNewPrompt`(:69) `parseQuickNewDecision`(:113) `matchCandidateDirectory`(:169) `slugifyTitle`(:156) |

依赖方向：`index.ts` → (`config`/`lifecycle`/`security`/`feishu/*`/`session/*`/`runtime/*`)；`types.ts` 无入边（`src/types.ts:1-5`）。

---

## 2. 宿主耦合面（最重要）

### 2.1 `@opencode/plugin`：唯一 import 与唯一 hook 注册点

- 唯一 import：`import { Plugin } from "@opencode/plugin"`（`src/index.ts:17`）；除此以外全仓库无 opencode 运行时 import（`grep "@opencode"` 只命中注释：`src/types.ts:4`、`src/feishu/form-reply.ts:5`、`src/session/compact-http.ts:4`、`src/session/quick-generate.ts:17`）。
- 导出形态：`export default Plugin.define({ id: "feishu", async setup(ctx) {...} })`（`src/index.ts:101-223`）。
- 生命周期契约：`setup` 返回 `() => Promise<void>` cleanup（`src/index.ts:1466-1484`）；禁用/重复 setup/非网关 location 时返回 no-op `async () => {}`（`src/index.ts:117`、`184`、`211`）。
- 三个 hook：`ctx.permission.hook("evaluate", cb)`（`src/index.ts:795`，返回 `{dispose}` :1479）、`ctx.session.hook("context", cb)`（`src/index.ts:692-710`，运行时可能缺失 :715）、`ctx.event.subscribe({signal})` 异步迭代（`src/index.ts:1319`）。
- 插件发现约定：只加载 `plugins/<name>/index.js`，不读 `package.json#main`（`index.js:1-4`）。

### 2.2 `ctx.*` 域清单（穷尽，含可选/降级标记）

| ctx 成员 | 调用点 | 形状要点 |
|---|---|---|
| `ctx.options` | `index.ts:104` | `Readonly<Record<string, unknown>>`（`types.ts:20`） |
| `ctx.location.directory` | `index.ts:137,1436` | 当前 location 绝对目录；按 location 多实例加载 |
| `ctx.storage.get/set/remove` | `index.ts:231-235` | 唯一持久化；`StorageLike`（`types.ts:220-224`），无 CAS（`dedup.ts:14-16` 明说非原子） |
| `ctx.event.subscribe({signal})` | `index.ts:1319` | `AsyncIterable<{type,data}>`；正常结束也需重连（`index.ts:1306-1340`，退避 1s→30s :1312-1313） |
| `ctx.permission.hook("evaluate", cb)` | `index.ts:795` | 可变事件 `{sessionID, action, effect?, message?}`；置 `ask` 前必须能投递飞书否则跳过（`index.ts:807-810`） |
| `ctx.permission.reply(arg, opts)` | `index.ts:1604-1627` | `arg={sessionID, requestID, reply}`；字段名回退 `decision`（`index.ts:1494-1496,1620-1626`） |
| `ctx.session.create({title, model, location, permissions})` | `index.ts:400-405` | 返回 `{id}`（`"ses..."`，`quick-generate.ts:271`） |
| `ctx.session.get({sessionID}, {headers})` | `index.ts:433-440,669-681` | 读回 `Session.Info`：`model{providerID,id}`、`title/slug`、`permissions[]`、`location.directory`（`models.ts:72-84`、`feishu/session-list.ts:53-100`） |
| `ctx.session.list({order})`（可选） | `index.ts:656-663` | 运行时通常**未暴露**（`session-list.ts:1-5`） |
| `ctx.session.update({sessionID, permissions})` | `index.ts:521,555-562` | 覆盖式写 ruleset，最后匹配优先（`types.ts:110`） |
| `ctx.session.move({sessionID, directory})` | `index.ts:531` | `/cd` |
| `ctx.session.switchModel({sessionID, model}, {headers})` | `index.ts:478-482` | 只影响后续 turn，必须读回校验（`index.ts:464-472`） |
| `ctx.session.interrupt({sessionID, resume:false}, {headers})` | `index.ts:314-319` | `resume:false` 不续跑；不取消 park 的队列（`index.ts:1499-1505`） |
| `ctx.session.prompt({sessionID, text, delivery, files})` | `index.ts:1641-1652` | `delivery: "steer"\|"queue"`（`delivery.ts:16`）；`files:[{uri:"file://..."}]`（`index.ts:1255,1269`） |
| `ctx.session.compact({sessionID}, {headers})`（可选） | `index.ts:1712-1722` | 缺失时 HTTP 兜底（`compact-http.ts:71`） |
| `ctx.session.form.reply({sessionID, formID, answer})`（可选） | `index.ts:1546-1562` | 2.0.16–2.0.18 恒 undefined（`form-reply.ts:3-8`） |
| `ctx.session.inbox.list/cancel/update`（可选） | `index.ts:1511-1517,1577-1586` | 项含 `{id, delivery}`；用于取消 park / 提升 steer |
| `ctx.session.message.list` / `ctx.message.list`（可选） | `index.ts:1672-1687` | `{sessionID, limit:200}`，compaction 摘要来源 |
| `ctx.session.context({sessionID})`（可选兜底） | `index.ts:1669-1697` | **精简形状、无 summary**，仅转写兜底（`resume-summary.ts:5-6`） |
| `ctx.generate.text({prompt, model}, {headers})`（可选） | `index.ts:617-634,1128-1135` | requestOptions 可能不被转发（`quick-generate.ts:17`） |
| `ctx.model.list()` | `index.ts:420` | 归一化见 `models.ts:24` |

跨 location 路由头（非可选）：`x-opencode-directory`（URL 编码）出现在 `index.ts:319,439,561,675,1518,1556,1587,1611,1668,1716`、`compact-http.ts:50,86`、`quick-generate.ts:91`、`form-reply.ts:103,133`、`keepalive.ts:73`；`x-opencode-session` 在 `quick-generate.ts:90`。

### 2.3 opencode 事件名（`runtime/event-router.ts:55-226`，共 20 个）

`session.created`(:56)、`permission.asked`(:80)、`permission.replied`(:86)、`form.created`(:89)、`form.replied`(:95)、`form.cancelled`(:98)、`session.text.started`(:101)、`session.text.delta`(:110)、`session.text.ended`(:124)、`session.tool.input.started`(:139)、`session.tool.input.ended`(:149)、`session.tool.success`(:154)、`session.tool.error`(:163)、`session.execution.started`(:172)、`session.execution.succeeded`(:179)、`session.execution.failed`(:186)、`session.execution.interrupted`(:194)、`session.status`（busy/retry/idle，:203-213）、`session.idle`(:216)。任意事件都读 `data.sessionID` 刷新判活（:52-53）。

### 2.4 opencode HTTP 端点（全部为「同机兜底」通道）

| 端点 | 用途 | 证据 |
|---|---|---|
| `GET /api/plugin?location[directory]=` | 续期 LayerMap；已回收则**重建 location**（唯一有效通道） | `keepalive.ts:87`；结论 :13-17 |
| `GET /api/session?limit&order&parentID` | 全量会话列表（含 TUI/Web） | `session-list-http.ts:52-59` |
| `POST /api/session` | 建会话（保活探针 / 临时生成会话） | `keepalive.ts:104`、`quick-generate.ts:221` |
| `DELETE /api/session/{id}` | 删探针/临时会话 | `keepalive.ts:129`、`quick-generate.ts:253` |
| `GET /api/session/{id}/message?limit=200` | 完整消息（含 compaction `summary`） | `compact-http.ts:48` |
| `POST /api/session/{id}/compact` | 触发原生压缩 | `compact-http.ts:81` |
| `POST /api/session/{id}/generate` | 会话管线一次性生成（自动带路由头） | `quick-generate.ts:240` |
| `POST /api/experimental/generate` | 无会话上下文生成（次选） | `quick-generate.ts:179` |
| `POST /api/session/{id}/form/{formID}/reply` | 提交表单答复 | `form-reply.ts:128` |
| `DELETE /api/session/{id}/form/{formID}` | 取消 pending form（解除阻塞） | `form-reply.ts:101` |

服务发现与认证：`$XDG_STATE_HOME|~/.local/state` + `/opencode/service.json`，字段 `url`/`password`，Basic `opencode:<password>`（`form-reply.ts:45-82`）；超时 8s/15s/30s 各处硬编码（`keepalive.ts:70`、`compact-http.ts:55,92`、`quick-generate.ts:187`）。

### 2.5 用到的 opencode 数据模型字段

- Session：`id|sessionID`、`title|slug`、`model{providerID,id}`、`permissions[{action,resource,effect}]`、`location.directory`、`updatedAt`（number/字符串/ISO/`Effect DateTime`，`feishu/session-list.ts:98-127`、`models.ts:72-84`）。
- permission request：`{id, sessionID, action, resources[], save[]?, message?, source{type:"tool",messageID,id}}`（`types.ts:83-95`）；`save[]` 非空才允许「始终允许」持久化（`permission.ts:233`）。
- permission reply：`{sessionID, requestID, reply:"once"|"always"|"reject"}`（`types.ts:98-102`）。
- form：`{id, sessionID, title, fields[{key,type,title,description,required,hidden,options[{value,label,description}],custom,default}], metadata}`（`feishu/forms.ts:21-116`）；字段类型自由文本（`string` 默认）。
- message/part：`assistantMessageID` 分 step（`run-state.ts:83-91`）；tool 事件 `{id,name,input,content|error}`（`event-router.ts:139-171`）；`content` 形状三态（string / `[{text}]` / `{text}`，`event-router.ts:242-259`）。
- compaction 消息：`type:"compaction"` + `status:"running|completed|failed"` + `summary`，**只认 completed**（`resume-summary.ts:85-101`）。
- inbox：`{id, delivery}`（`index.ts:1521,1589`）。

### 2.6 纯逻辑（可近乎直接复用）vs 必须重写

**可直接复用（无 opencode import，依赖全部注入，共 ≈5.5k 行）**：`types.ts`、`logger.ts`、`config.ts`（仅路径/环境约定）、`lifecycle.ts`（仅 `globalThis`）、`security/*`、`utils/*`、`feishu/cards.ts`、`session-cards.ts`、`setup-cards.ts`、`quick-new-cards.ts`、`card-limits.ts`、`forms.ts`、`run-state.ts`、`run-renderer.ts`、`events.ts`、`commands.ts`、`routing.ts`、`perm-presets.ts`、`dirs.ts`、`root-scan.ts`、`dedup.ts`、`wizard.ts`、`recent.ts`、`models.ts`、`feishu/session-list.ts`、`topic-guidance.ts`、`run-stop.ts`、`delivery.ts`、`session-recovery.ts`、`watchdog.ts`、`permission.ts`、`runtime/event-router.ts`（仅字符串契约）、`runtime/card-action-router.ts`、`session/topic-status.ts`、`session/quick-new.ts`、`session/resume-summary.ts`、`session/compact.ts`。

**必须重写（宿主耦合集中处）**：
1. `src/index.ts`（1801 行）——`Plugin.define`、全部 `ctx.*` 适配、`typeof api === "function"` 保护、README 级装配逻辑。
2. 事件订阅层（`index.ts:1306-1363`）——事件名/负载契约需按新宿主映射。
3. 权限 hook 与 reply 适配（`index.ts:795-813,1603-1628`）。
4. `session/keepalive.ts`(340)、`lifecycle.ts` 的网关选举（`index.ts:131-212`）、`GET /api/plugin` 保活——若新宿主无 location 60 分钟回收则整体删除。
5. HTTP 兜底四件套：`form-reply.ts`(148)、`compact-http.ts`(101)、`session-list-http.ts`(70)、`quick-generate.ts`(290) 的 B/C 通道——取决于新宿主 API 完整度。
6. `permission.ts` 中依赖 `sessionID/requestID` 语义的部分（状态机本身纯，但 `ReplyInput.directory` 语义 :158-169 需替换）。
7. 飞书侧仅 `gateway.ts` 的注册表（:56-117）与 `sender.ts` 的方法集（:56-81）需按桥接目标调整；卡片/文本层不动。

---

## 3. 运行架构

### 3.1 会话映射与路由

- 三层 key（`session-map.ts:21-30`）：`feishu:v2:chat:<chatId>:sessions`=`{sessions:[{sessionID,title,updatedAt}],active?}`、`feishu:v2:session:<sid>`=`SessionLink`、`feishu:v2:thread:<tid>`=`ThreadLink`、`feishu:v2:root:<rootId>`=`{sessionID}`、`feishu:v2:session-thread:<sid>`=`{threadId}`；旧单值 key 读取即迁移（:374-389）。
- 内存热缓存五张 Map（:62-72），`hasSession/getLink` 为 `permission.evaluate` 同步热路径（:83-90）。
- 路由决策纯函数（`routing.ts:38-46`）：命令 → thread 命中 → root 命中（**无 threadId 也算**，恢复卡靠它）→ 有 threadId 则建会话 → 否则主聊天流回管理台提示卡。
- 入站主流程（`index.ts:816-918`）：p2p 过滤(:817) → 白名单 `owner.admit`(:821) → 去重 claim(:830) → `threadRouting=false` 回退(:836-845) → 命令拦截(:849) → 路由 → root 命中补写 thread 映射（读回 message meta，:888-894）→ 表单自由文本优先消费(:897) → `runInSession`。
- 话题新建：`createSessionInternal`(:389-416) + `bindThread`+`bindRoot`(:914-915)，标题 `topicTitle`（首条消息 20 字，`commands.ts:190`）。
- 反向索引用于列表卡标记「已绑话题」（`session-list.ts:131`）。

### 3.2 权限审批状态机

- 四档全局 gate（`types.ts:17`、`config.ts:580-583` 默认 `gate`）：`off/notify` 不改写；`denyTools` 优先拒绝；`allowTools` 直接放行（默认 `read/glob/grep/webfetch`，`config.ts:206`）；`lockdown` 未命中 allow 即 deny；否则 `ask`（`permission.ts:55-69`）。
- 会话级覆盖（`permission.ts:93-121`）：`gateMode=off` 完全不介入；`deny > allow > 会话放行 allowActions > askActions > 继承（不改写）`，避免只读工具被误伤。四档映射：readonly=deny edit/write/shell+bash 且 gate off；edit=allow edit + ask shell/bash；askHigh=空 ruleset + ask shell/bash/edit/external_directory；trust=`*` allow（`perm-presets.ts:39-93`）。
- 安全边界：只有存在飞书映射的会话才允许置 `ask`，否则 TUI 会话会永久挂起（`index.ts:805-810`）。
- 卡上按钮（`cards.ts:78-92`）：允许一次/始终允许（无 `save[]` 时文案降级 :72-76）/本会话内允许/拒绝（拒绝会级联驳回本会话其余待批，:70）。
- 点击校验顺序（`permission.ts:309-336`、:365-410）：白名单 → 验签（绑定 operator）→ 会话匹配 → nonce 消费 → 后台 reply + patch；3 秒窗口内只同步返回 `{toast}`（`card-action-router.ts:1-7`）。
- token 设计（`security/token.ts`）：`body.hmac` 两段式，body=base64url(JSON claims)，`hmac=HMAC-SHA256(secret)`（:44-46,95-96）；三类载荷 `{r,s,u,e,n}`(:17-28)、`{p:"allow_session",r,s,a,e,n}`(:146-153)、`{p:"stop",s,e,n}`(:225-230)；secret 未配置时由 appSecret 派生 `sha256("opencode-feishu-v2/approval/v1:"+appSecret)`（`config.ts:209,521-523`）；`timingSafeEqual` 比较、长度不等直接拒（:64-69）；TTL 默认 10min（夹取 30s–24h，`config.ts:260`）；压缩按钮 token 单独 24h（`index.ts:1799-1801`）；`ReplayGuard.consume(nonce, ttl)` 首次 true（:281-295），approval/stop/compact 各持一个 guard（`index.ts:335,586,770`）。
- 会话内放行落两处：`SessionLink.allowActions` + `ctx.session.update` 追加 allow 规则（`index.ts:544-572`），ruleset 失败仍以 allowActions 兜底（:563-570）；换档清空 allowActions（:523-527）；shell/bash 成对放行（`perm-presets.ts:101-103`）。
- 目录边界：`allowedRoots` 默认 `[homedir()]`（`config.ts:207-208,263-265`）；`validateDirectory` 校验绝对路径→禁区→白名单→必要时 mkdir -p→**realpath 后再校验一次防符号链接逃逸**（`dirs.ts:95-158`）；系统目录清单 `dirs.ts:18-32`。

### 3.3 卡片渲染与流式回填

- 统一 JSON 2.0 + `config.update_multi:true`；按钮必须直放 `body.elements` 且用 `behaviors:[{type:"callback",value}]`（1.0 的 `tag:"action"` 会 400，`cards.ts:222-240`）。
- 单卡 28KB 截断并闭合代码围栏（`cards.ts:13,258-277`）；表格 ≤4（硬限 5）超限降级为代码块、组件数 ≤200 丢弃最旧（`card-limits.ts:20-25,180`）；发送层再兜一次（`sender.ts:96-108`）。
- 运行卡：`beginRun` 先发回执卡再 prompt（顺序注释 `index.ts:1242`；`run-controller.ts:268-306`）→ 事件进纯 reducer（`run-state.ts:125-273`）→ ≥400ms 节流 patch，终态强制 flush（`run-controller.ts:152,248-265`；`throttle.ts:24`）。
- 渲染折叠：连续工具 ≥3 合并摘要（只留名称行），最新一个展开，终态整体折叠（`run-renderer.ts:1-13,22-30`）；工具块上限 12、文本块 2048（`config.ts:278-279`）。
- 长回答拆分：尾部文本 ≥600 字符 → 单独卡（>20KB 转 `.md` 文件），运行卡留提示（`run-controller.ts:112-125,348-374`；`index.ts:274-304`）。
- 话题根卡状态：档位变化才整卡 patch（`runtime/topic-status.ts:97-120`，默认 1000ms 节流 `config.ts:275`），用持久化 `rootCard` 重渲染以免丢摘要（`session-cards.ts:196-260`）；连续失败 3 次熔断（`runtime/topic-status.ts:20`）。

### 3.4 忙时插队 vs 排队、`/steer`、强制停止

- `decideDelivery(running, busyDelivery)`：空闲 `steer`；忙时按 `busyDelivery`（默认 steer 插队；queue 原生排队）（`delivery.ts:19-26`；`config.ts:203,291`）。
- 执行态权威源双轨：`session.execution.*` + `session.status`（`event-router.ts:172-215`）；`session.execution.interrupted` 必须处理否则永久 queue（:194-196 注释）。
- 排队卡命运：`execution.started` 晋升队首，否则宽限 3s 按「已随本轮处理」收尾（`run-controller.ts:9-15,141,164-187`）；首个活动事件兜底晋升（:333-344）。
- `/steer <文本>` 强制 steer（`session-ops.ts:211-233` → `index.ts:731-734` 以 `forceDelivery="steer"` 重跑）；`/now` 把已排队消息经 inbox 提升为 steer（`session-ops.ts:184-209`；`index.ts:1571-1601`），inbox 缺失返回 -1 并提示不支持。
- 强制停止：卡片按钮 token 每次 patch 重签（`run-controller.ts:39`；`index.ts:267`），校验后走共享恢复例程 `interrupt + cancelQueued(inbox) + markEnded + 卡片收尾`（`session-recovery.ts:47-100`；`index.ts:310-339`）。

### 3.5 看门狗与 location 保活

- 看门狗：默认 60s 一拍（`watchdog.ts:54`），两类目标——陈旧执行（`ExecutionTracker.stale`，`delivery.ts:56-65`）与排队超时（`run-controller.ts:402-415`）；阈值 `staleExecutionMs` 默认 5min、0=关闭（`config.ts:261`；`index.ts:1389-1402`）。判活规则：任意事件沿**父子链路**刷新（`delivery.ts:82-117`；`index.ts:1344`）；待答表单/未决审批算合法等待不判 stale（`index.ts:1386-1387`；`permission.ts:345`、`form-relay.ts:257`）。
- location 保活：opencode 两条 60min 回收路径（LayerMap / LocationActivity），会话路由不续期，只有 `GET /api/plugin` 续期且能重建（`keepalive.ts:4-28`）。心跳默认 20min（夹取 5–45min，`config.ts:292-296`）；主力 `GET /api/plugin` + 辅助探针会话创建/删除（`keepalive.ts:81-137`）；进程级看门狗挂 `Symbol.for` 槽位与进程同寿、持独立日志 sink（`keepalive.ts:168-293`）；网关实例用 `authoritative` 校正目标（`index.ts:1439-1453`）。
- 多实例收敛：`acquireProcessGuard`（`lifecycle.ts:53-63`）+ gatewayLocation 精确匹配优先/子目录宽限窗（`lifecycle.ts:74-137`；`config.ts:299-300` 默认 3000ms）+ 未命中延迟告警（`lifecycle.ts:191-231`）。

### 3.6 附件下载挂载

- 仅 image/file（`events.ts:100-120`）；下载用 `client.im.messageResource.get({params:{type},path:{message_id,file_key}})` + `writeFile`（`attachments.ts:45-59,183-194`）。
- 落盘：显式 `attachmentsDir` > `<会话目录>/.opencode/temp/opencode-feishu-plugin/` > 系统临时目录（`attachments.ts:18-30`）；默认目录写 `.gitignore`（:36-42,181）；文件名 `messageId-<sanitized>`（:193）。
- 上限 20MB（夹取 1–100MB）、超时 30s（夹取 5–120s）（`config.ts:283-288`）；超限删除并拒绝（`attachments.ts:196-202`）；失败降级为 `[附件] 下载失败：…` 文本不阻断（`index.ts:1271-1273`）；成功后以 `file://` URI 走 prompt `files`（`index.ts:1269`）。

### 3.7 配置与日志

- 优先级 options > `<configDir>/plugins/feishu.json` > env（仅 `FEISHU_APP_ID/SECRET`）（`config.ts:226-250`）；`configDir` = `OPENCODE_CONFIG_DIR` 或 `~/.config/opencode`（:415-421）；支持 `{env:NAME}`/`${NAME}`/`$NAME`（:512-518）。
- 红线：永不抛异常，缺 appId/appSecret 只禁用并 warn（`config.ts:306-314`；`index.ts:109-118`）；warning 不含 secret（`config.ts:232-234`）。
- 约 60 项配置全部 clamp（`config.ts:259-300`），`ResolvedConfig` 定义 :24-204；`logFile` 落在配置目录内会告警（写文件会触发插件重载风暴，:14-21,481-490）——这是 opencode 特有陷阱。
- 日志：JSON 行 `{t,level,msg,meta}`（`logger.ts:59-65`），键名含 secret/token/password/pat/authorization 一律 `<redacted>`、>512 字符截断（:37-51）；open_id 只留前 8 位（:76-79）；文件 sink append + 0600（:100-121）。

---

## 4. 移植建议

### 4.1 最小宿主抽象接口 `HostAdapter`

| 方法 | 语义 | 原代码位置 |
|---|---|---|
| `storage.get/set/remove(key,value)` | 唯一持久化（建议新宿主提供原子 `setIfAbsent` 以修复去重非原子） | `index.ts:231-235`；`dedup.ts:14-16` |
| `location(): string \| undefined` | 当前实例工作目录（多实例收敛/路由头依据） | `index.ts:137,1436` |
| `createSession({title,model,directory,permissions}) → {id}` | 建会话 | `index.ts:400-405` |
| `getSession({sessionID,directory}) → unknown` | 读会话信息（模型/标题/权限/目录） | `index.ts:669-681` |
| `listSessions({order}) → unknown[]` | 全量会话列表 | `index.ts:656-663` |
| `updateSession({sessionID,permissions,directory})` | 写 ruleset（覆盖式） | `index.ts:521,555-562` |
| `moveSession({sessionID,directory})` | 会话换目录 | `index.ts:531` |
| `switchModel({sessionID,model,directory})` | 切模型（需读回校验语义） | `index.ts:474-516` |
| `interruptSession({sessionID,directory})` | 中断当前执行（不续跑） | `index.ts:314-319` |
| `prompt({sessionID,text,delivery,files})` | 投递消息；`delivery` 支持 steer/queue | `index.ts:1634-1653` |
| `listQueued({sessionID,directory})` / `cancelQueued(ids)` / `promoteQueued(ids)` | park 队列的读/取消/提升为 steer | `index.ts:1506-1533,1571-1601` |
| `replyPermission({sessionID,requestID,reply,directory})` | 权限答复 | `index.ts:1603-1628` |
| `listMessages({sessionID,limit,directory}) → unknown` | 完整消息（含 compaction summary） | `index.ts:1662-1700` |
| `compactSession({sessionID,directory})` | 触发原生压缩 | `index.ts:1706-1723` |
| `replyForm({sessionID,formID,answer,directory})` / `cancelForm(...)` | 表单答复/取消 | `index.ts:1541-1565`；`form-reply.ts:92,119` |
| `generateText({prompt,model,sessionID,directory}) → unknown` | 无会话上下文的一次性生成（快摘要/意图识别） | `index.ts:616-646,1123-1136` |
| `listModels() → ModelEntry[]` | 模型列表 | `index.ts:418-426` |
| `subscribeEvents({signal}) → AsyncIterable<{type,data}>` | 事件流（需自带重连或由 adapter 保证不复用一次性流） | `index.ts:1306-1340` |
| `onPermissionEvaluate(handler) → {dispose}` | 权限策略改写 hook（事件形状 `{sessionID,action,effect,message}`） | `index.ts:795-813` |
| `onContextInject(handler) → {dispose}` | system 注入 hook（话题软引导） | `index.ts:692-710`；`topic-guidance.ts:52` |
| `now()/setTimer/clearTimer` | 时钟与定时器注入（现全仓已注入，直接复用） | `utils/throttle.ts:16`、`ttl-map.ts:6`、`watchdog.ts:54` |
| `onDispose(cb)` | 卸载回调（gateway.stop/订阅 abort/各控制器 dispose） | `index.ts:1466-1484` |
| （可选）`keepaliveProbe()` | 仅当新宿主有 location 空闲回收时需要；对应 `GET /api/plugin` | `keepalive.ts:59-141` |
| （可选）`localHttpService()` | 仅当原生 API 不全时保留 service.json + Basic 兜底 | `form-reply.ts:45-82` |

### 4.2 改写清单（按工作量从低到高）

1. **字符串/路径常量**：`config.ts` 的 configDir/stateDir/service.json 路径与 env 名（`config.ts:214,415-429`、`form-reply.ts:45-48`）；日志前缀（`logger.ts:56`）。~0.5 天。
2. **事件名映射表**：只改 `event-router.ts:55-226` 的 case 与字段读取（若新宿主事件形状不同）；`EventRouterDeps` 契约不变。~1 天。
3. **权限 hook + reply 适配**：`index.ts:795-813,1603-1628`；`permission.ts` 仅改 `ReplyInput.directory` 语义（:158-169）。~1–2 天。
4. **HostAdapter 实现**（会话域 ~15 个方法）：`index.ts:389-681` 与文末 7 个辅助函数。可删掉全部 `typeof api === "function"` 探测与 HTTP 兜底（`index.ts` 少约 300–400 行）。~3–5 天。
5. **`index.ts` 装配重写**：`setup` 主体（:101-223 位置/单例逻辑按新宿主裁剪）、入站路由（:816-918）、quick-new（:992-1202）、装配与 cleanup（:1287-1484）。~5–8 天。
6. **保活/选举删除**：`session/keepalive.ts`(340) + `lifecycle.ts` 网关选举（:74-231）+ `index.ts:131-212,1431-1461`。若新宿主无 60min 回收，可整体删（约 600 行）；若需要，则重写 probe 为目标宿主的等价「唤醒」调用。~0.5 天（删）或 3 天（重写）。
7. **HTTP 兜底四件套替换**：`form-reply.ts`、`compact-http.ts`、`session-list-http.ts`、`quick-generate.ts`（B/C 通道）→ 若新宿主原生暴露对应能力则删除（约 600 行），否则改为 HostAdapter 方法。~1–3 天。
8. **表单/`question` 工具中继适配**：`form-relay.ts`(434) + `forms.ts` 的字段模型需映射到新宿主的反问机制；若新宿主无等价物，则需自建「结构化提问」协议（`forms.ts:21-116`）。~3–5 天（风险最高，因为它是防止 agent 永久挂起的关键）。
9. **飞书桥接目标改造**：若目标宿主也要接飞书，`gateway.ts:56-117` 注册表与 `sender.ts:56-81` 方法集可直接保留；若只是复用会话/审批内核，则 `gateway`/`cards`/`session-cards` 全部旁路。

### 4.3 判断：抽共用内核 vs 新区重写宿主层

**结论：保留纯逻辑内核（原样搬运 + 保留 49 个单测文件），只重写宿主层；不要把整个插件抽成「跨宿主通用内核」。**

理由：
1. 复用价值集中在**协议与安全**层：飞书卡片 JSON 2.0 构建与守卫（`cards.ts`+`card-limits.ts`+`*-cards.ts` ≈1,600 行）、事件归一化（`events.ts`）、自签 token/防重放（`security/token.ts`）、权限策略纯函数（`permission.ts:55-121`）、目录边界（`dirs.ts`）——这些**不含任何 opencode 依赖**（`src/types.ts:4` 明确以此为设计目标），且被 11k 行测试覆盖。抽成 `feishu-protocol` / `agent-approval` 两个内部包是净收益。
2. 抽象「会话/事件」层做跨宿主通用内核的收益低：耦合面不是 API 形状而是**语义**——`delivery: steer|queue`、`permission.evaluate` 改写、`inbox` park 取消、`compaction summary` 复用、location 60 分钟回收（`keepalive.ts:4-28`）都是 opencode 特有语义。`HostAdapter`（4.1）足够，再往上抽象会造出只有两个实现的空壳层。
3. 最贵的是 `index.ts`（1801 行），但它 80% 是「探测 + 兜底 + 多实例防御」，在单一新宿主里应当**变短而非复用**：删除 HTTP 兜底、`typeof` 探测、gatewayLocation 选举后，装配层预计落到 500–700 行。
4. 落地顺序建议：先搬 4.1 之前的纯模块与其测试（几乎零改动）→ 实现 HostAdapter → 重写 `index.ts` 装配 → 逐项回填 `/sessions`、审批卡、运行卡、看门狗 → 最后决定表单中继是适配还是重设计。
