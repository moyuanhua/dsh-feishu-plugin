/** Narrow adapter over the real DSH Host services. */
import { isAbsolute, resolve } from "node:path";
import { describeError, isRecord, str, truncate, validateDirectory, expandHome } from "../utils.js";

function signal() {
  return new AbortController().signal;
}

export class DshBridge {
  constructor(ctx, config, log) {
    this.ctx = ctx;
    this.config = config;
    this.log = log;
    this.running = new Set();
    this.summaryCache = new Map();
    this.summaryAt = 0;
  }

  controller() {
    const service = this.ctx.get?.("sessionController") ?? this.ctx.sessionController;
    if (!service) throw new Error("DSH sessionController 服务不可用");
    return service;
  }

  sessionStore() {
    return this.ctx.get?.("sessions") ?? this.ctx.sessions;
  }

  permissionService() {
    return this.ctx.get?.("permissionPresets") ?? this.ctx.permissionPresets;
  }

  defaultDirectory() {
    return (
      this.ctx.get?.("workingDirectory")?.defaultDirectory ??
      this.ctx.workingDirectory?.defaultDirectory ??
      this.config.defaultDirectory
    );
  }

  async listSummaries(force = false) {
    const now = Date.now();
    if (!force && now - this.summaryAt < 2_000 && this.summaryCache.size > 0) {
      return [...this.summaryCache.values()];
    }
    const value = await this.controller().list({}, signal());
    const items = Array.isArray(value?.items) ? value.items : [];
    this.summaryCache = new Map(items.map((item) => [str(item.sessionId), item]));
    this.summaryAt = now;
    for (const item of items) {
      if (item.running) this.running.add(str(item.sessionId));
      else this.running.delete(str(item.sessionId));
    }
    return items;
  }

  view(summary) {
    const sessionId = str(summary.sessionId);
    const live = this.sessionStore()?.get?.(sessionId);
    const projections = summary.projections?.values ?? {};
    let title = str(projections.title ?? "").trim();
    let cwd = str(summary.cwd ?? "") || str(live?.header?.cwd ?? "");
    let perm = str(projections.permissions?.currentValue ?? "") || undefined;
    const selection = projections.modelSelection ?? {};
    let model = selection.next ?? selection.lastUsed ?? undefined;

    if (live) {
      try {
        const stateTitle = this.ctx.get?.("sessionProjections")?.stateOf?.(live, "title");
        if (typeof stateTitle === "string" && stateTitle.trim()) title = stateTitle.trim();
      } catch {
        /* projection absent */
      }
      try {
        const statePerm = this.ctx.get?.("sessionProjections")?.stateOf?.(live, "permissions");
        if (statePerm?.currentValue) perm = str(statePerm.currentValue);
      } catch {
        /* ignore */
      }
      try {
        const stateModel = this.ctx.get?.("sessionProjections")?.stateOf?.(live, "modelSelection");
        if (stateModel?.next ?? stateModel?.lastUsed) model = stateModel.next ?? stateModel.lastUsed;
      } catch {
        /* ignore */
      }
      const context = live.requestContext?.();
      if (context?.provider && context?.model) model = { provider: context.provider, model: context.model };
      cwd = str(live.header?.cwd ?? cwd);
    }

    return {
      sessionId,
      title: title || "(未命名会话)",
      cwd: cwd || undefined,
      updatedAt: Number(summary.updatedAt) || 0,
      running: this.running.has(sessionId) || Boolean(summary.running),
      blank: Boolean(summary.blank),
      agentAvailable: Boolean(summary.agentAvailable),
      perm,
      model: model && model.provider && model.model
        ? { provider: str(model.provider), model: str(model.model) }
        : undefined,
    };
  }

  async views() {
    const summaries = await this.listSummaries(true);
    return summaries
      .filter((item) => str(item.sessionId) && !item.parentSessionId && item.origin !== "subagent")
      .map((item) => this.view(item))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async viewOf(sessionId) {
    const summary = this.summaryCache.get(sessionId);
    if (summary) return this.view(summary);
    try {
      const summaries = await this.listSummaries(true);
      const found = summaries.find((item) => str(item.sessionId) === sessionId);
      if (found) return this.view(found);
    } catch (error) {
      this.log.debug("读取会话摘要失败", { sessionId, error: describeError(error) });
    }
    const live = this.sessionStore()?.get?.(sessionId);
    if (live) return this.view({ sessionId, updatedAt: Date.now(), cwd: live.header?.cwd });
    return { sessionId, title: "(未知会话)", updatedAt: 0, running: false };
  }

  async modelCatalog() {
    const catalog = await this.controller().modelCatalog();
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    const models = [];
    for (const group of groups) {
      const provider = str(group.id);
      const providerName = str(group.name) || provider;
      for (const model of Array.isArray(group.models) ? group.models : []) {
        models.push({
          provider,
          providerName,
          model: str(model.id),
          name: str(model.name) || str(model.id),
          description: str(model.description) || undefined,
        });
      }
    }
    return {
      models,
      default: isRecord(catalog?.default) && catalog.default.provider
        ? { provider: str(catalog.default.provider), model: str(catalog.default.model) }
        : undefined,
      failures: Array.isArray(catalog?.failures) ? catalog.failures : [],
    };
  }

  permissionCatalog() {
    try {
      const catalog = this.permissionService()?.catalog?.();
      const options = Array.isArray(catalog?.options) ? catalog.options : [];
      return {
        options: options.map((option) => ({
          value: str(option.value),
          name: str(option.name) || str(option.value),
          description: str(option.description) || undefined,
        })),
        defaultPreset: str(catalog?.defaultPreset) || undefined,
      };
    } catch (error) {
      this.log.debug("读取权限目录失败", { error: describeError(error) });
      return { options: [], defaultPreset: undefined };
    }
  }

  async ensureAgent(sessionId) {
    const result = await this.controller().resolveAgent(sessionId);
    if (result?.error) throw new Error(`${result.error.code ?? "session"}: ${result.error.message ?? ""}`);
    if (result?.agent) return result.agent;
    const agent = this.ctx.get?.("agents")?.get?.(sessionId);
    if (agent) return agent;
    throw new Error("无法恢复该会话的 agent");
  }

  async createSession({ cwd, title, model, preset }) {
    const check = validateDirectory(cwd || this.defaultDirectory(), this.config.allowedRoots);
    if (!check.ok) throw new Error(check.reason);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(check.path, { recursive: true });

    const created = await this.controller().create({ cwd: check.path });
    const sessionId = str(created.sessionId);
    if (!sessionId) throw new Error("创建会话失败：未返回 sessionId");

    await this.ensureAgent(sessionId);
    if (preset) await this.setPermission(sessionId, preset);
    if (model?.provider && model?.model) {
      await this.controller().selectModel({
        sessionId,
        provider: model.provider,
        model: model.model,
      });
    }
    if (title?.trim()) {
      await this.controller().rename({ sessionId, title: truncate(title.trim(), 120) });
    }
    this.log.info("已创建 DSH 会话", { sessionId, cwd: check.path, preset, model });
    return sessionId;
  }

  async setPermission(sessionId, preset) {
    await this.ensureAgent(sessionId);
    const session = this.sessionStore()?.get?.(sessionId);
    if (!session) throw new Error("会话未激活，无法切换权限");
    this.permissionService()?.set?.(session, preset);
  }

  async changeDirectory(sessionId, path) {
    const check = validateDirectory(path, this.config.allowedRoots);
    if (!check.ok) throw new Error(check.reason);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(check.path, { recursive: true });
    const agent = await this.ensureAgent(sessionId);
    const service = this.ctx.get?.("workingDirectory") ?? this.ctx.workingDirectory;
    if (!service) throw new Error("当前部署没有 workingDirectory 服务");
    return await service.set(agent, check.path);
  }

  async prompt(sessionId, content, mode, requestId) {
    // The Remote wrapper normally supplies this signal; direct Host calls must
    // pass one because prompt admission calls signal.throwIfAborted().
    const signal = new AbortController().signal;
    return await this.controller().prompt({
      requestId,
      sessionId,
      mode,
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, signal);
  }

  async cancel(sessionId) {
    try {
      return this.controller().cancel({ sessionId });
    } catch (error) {
      this.log.warn("取消会话失败", { sessionId, error: describeError(error) });
      return undefined;
    }
  }

  async uploadFile(sessionId, bytes, name) {
    const uploads = this.ctx.get?.("fileUploads") ?? this.ctx.fileUploads;
    if (!uploads?.uploadStream) throw new Error("当前部署不支持文件上传");
    const data = (async function* () {
      yield bytes;
    })();
    return await uploads.uploadStream({ sessionId, data, name });
  }

  isRunning(sessionId) {
    return this.running.has(sessionId);
  }

  setRunning(sessionId, running) {
    if (running) this.running.add(sessionId);
    else this.running.delete(sessionId);
  }
}
