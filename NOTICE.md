# 来源与授权说明（NOTICE）

本仓库是 **DeepSeek Harness（dsh / Cordis）插件**，不是 opencode 插件的分支或复刻发行版。

## 设计参考

- `opencode-feishu-plugin` — <https://github.com/moyuanhua/opencode-feishu-plugin>
  MIT License, Copyright (c) 2026 moyuanhua（与本仓库同作者、同许可）。
  本插件参考其产品交互（话题 = 会话、管理台、建会话表单、审批/提问卡、流式运行卡），
  宿主侧实现全部按 dsh 的 Cordis 服务重写，不直接复用 opencode 的 `Plugin.define`、
  `permission.evaluate`、`ctx.session` 等 API。
- dsh 官方包文档与 TypeScript 声明 — <https://github.com/deepseek-ai/deepseek-harness>
  用于确认 `sessionController`、`approval/request`、`user-questions/request`、
  `session/event`、`agent/assistant-stream`、`permissionPresets`、`settings` 等接缝的用法。

## 运行时依赖

- `@larksuiteoapi/node-sdk`（MIT，飞书官方）— 飞书长连接、消息、卡片、资源下载。
  该依赖在构建时打进 `lib/index.js`，发布包没有运行时 `dependencies`。

## 图标

`icon.svg` 为原创构图：DSH 官方鲸鱼标记（取自 `@deepseek-ai/dsh-web-frontend`，MIT）
+ 飞书蓝对话气泡。DSH 鲸鱼路径保留自官方品牌资产，未做商标性使用。

## 许可

本仓库代码以 MIT 许可发布；`LICENSE` 中的 Copyright (c) 2026 moyuanhua 沿用自仓库历史。
