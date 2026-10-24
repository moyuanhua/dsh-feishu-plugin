/**
 * Client half of dsh-feishu-plugin.
 *
 * It contributes the plugin's configuration page to the Web UI's Plugins page.
 * The page edits the two volatile fields declared by the Host Config schema:
 * appId and appSecret. Writes go through the plugin manager's ConfigPageForm,
 * which persists them through the profile's config editor and applies them
 * live; the Host half restarts the Feishu long connection on change.
 */
window.__ModuleLoader__.load({
  id: "dsh-feishu-plugin",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect } = React;

    const styles = {
      page: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "640px" },
      row: { display: "flex", flexDirection: "column", gap: "6px" },
      label: { fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" },
      input: {
        boxSizing: "border-box",
        height: "36px",
        padding: "0 12px",
        border: "1px solid var(--dsw-alias-border-l4)",
        borderRadius: "var(--dsw-radius-md, 8px)",
        background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-primary)",
        outline: "none",
        font: "inherit",
        fontSize: "13px",
      },
      hint: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      actions: { display: "flex", alignItems: "center", gap: "12px" },
      button: {
        height: "32px",
        padding: "0 14px",
        border: "0",
        borderRadius: "var(--dsw-radius-md, 8px)",
        background: "var(--dsw-alias-state-business-primary)",
        color: "var(--dsw-alias-label-primary-foreground, #fff)",
        cursor: "pointer",
        font: "inherit",
        fontSize: "13px",
      },
      buttonDisabled: { opacity: 0.5, cursor: "default" },
      status: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
      error: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)" },
      summary: { fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" },
      toggleRow: { display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" },
      toggle: { width: "16px", height: "16px", marginTop: "1px", accentColor: "var(--dsw-alias-state-business-primary)", flex: "none" },
      section: {
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        paddingTop: "14px",
        borderTop: "1px solid var(--dsw-alias-border-l3)",
      },
      sectionTitle: { fontSize: "13px", lineHeight: "20px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      inline: { display: "flex", alignItems: "center", gap: "8px" },
      inputFlex: {
        boxSizing: "border-box",
        height: "36px",
        padding: "0 12px",
        border: "1px solid var(--dsw-alias-border-l4)",
        borderRadius: "var(--dsw-radius-md, 8px)",
        background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-primary)",
        outline: "none",
        font: "inherit",
        fontSize: "13px",
        flex: "1",
        minWidth: "0",
      },
      select: {
        boxSizing: "border-box",
        height: "36px",
        padding: "0 12px",
        border: "1px solid var(--dsw-alias-border-l4)",
        borderRadius: "var(--dsw-radius-md, 8px)",
        background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-primary)",
        outline: "none",
        font: "inherit",
        fontSize: "13px",
      },
      secondaryButton: {
        height: "36px",
        padding: "0 12px",
        border: "1px solid var(--dsw-alias-border-l4)",
        borderRadius: "var(--dsw-radius-md, 8px)",
        background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-primary)",
        cursor: "pointer",
        font: "inherit",
        fontSize: "13px",
        flex: "none",
      },
      badge: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "12px",
        padding: "1px 8px",
        borderRadius: "999px",
        background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-secondary)",
      },
    };

    function FeishuConfig(props) {
      const view = props?.view === "page" ? "page" : "summary";
      const form = props?.form;
      const state = form?.state;
      const value = state?.value ?? {};

      const [appId, setAppId] = useState("");
      const [appSecret, setAppSecret] = useState("");
      const [debugLog, setDebugLog] = useState(false);
      const [defaultDir, setDefaultDir] = useState("");
      const [defaultModelSel, setDefaultModelSel] = useState("");
      const [defaultPerm, setDefaultPerm] = useState("");
      const [catalogs, setCatalogs] = useState({ models: [], perms: [] });
      const [catalogError, setCatalogError] = useState("");
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState("");

      useEffect(() => {
        setAppId(typeof value.appId === "string" ? value.appId : "");
      }, [value.appId]);

      useEffect(() => {
        setDebugLog(value.debugLog === true);
      }, [value.debugLog]);

      const currentDir = typeof value.defaultDirectory === "string" ? value.defaultDirectory : "";
      const currentModel =
        value.defaultModel && typeof value.defaultModel.provider === "string" && value.defaultModel.provider
          ? `${value.defaultModel.provider}::${value.defaultModel.model ?? ""}`
          : "";
      const currentPerm =
        typeof value.defaultPermissionPreset === "string" ? value.defaultPermissionPreset : "";

      useEffect(() => setDefaultDir(currentDir), [currentDir]);
      useEffect(() => setDefaultModelSel(currentModel), [currentModel]);
      useEffect(() => setDefaultPerm(currentPerm), [currentPerm]);

      useEffect(() => {
        let alive = true;
        if (typeof props?.loadCatalogs !== "function") return undefined;
        props
          .loadCatalogs()
          .then((next) => {
            if (!alive) return;
            setCatalogs({ models: next.models ?? [], perms: next.perms ?? [] });
            setCatalogError("");
          })
          .catch((error) => {
            if (alive) setCatalogError(error instanceof Error ? error.message : String(error));
          });
        return () => {
          alive = false;
        };
      }, [props?.loadCatalogs]);

      if (view === "summary") {
        return h(
          "span",
          { style: styles.summary },
          value.appId
            ? h("span", null, h("span", { style: styles.badge }, "飞书已配置"), " ", value.appId, value.debugLog ? " · 调试日志开" : "")
            : "配置飞书 App ID / App Secret，启用飞书话题 ↔ DSH 会话桥接。",
        );
      }

      const writable = state?.writable !== false;
      const dirty =
        appId !== (typeof value.appId === "string" ? value.appId : "") ||
        appSecret.trim() !== "" ||
        debugLog !== (value.debugLog === true) ||
        defaultDir.trim() !== currentDir ||
        defaultModelSel !== currentModel ||
        defaultPerm !== currentPerm;

      const save = async () => {
        if (!form || !writable || busy) return;
        setBusy(true);
        setNotice("");
        try {
          const ops = [];
          const nextAppId = appId.trim();
          if (nextAppId !== (typeof value.appId === "string" ? value.appId : "")) {
            ops.push({ op: "set", path: ["appId"], value: nextAppId });
          }
          if (appSecret.trim()) {
            ops.push({ op: "set", path: ["appSecret"], value: appSecret.trim() });
          }
          if (debugLog !== (value.debugLog === true)) {
            ops.push({ op: "set", path: ["debugLog"], value: debugLog });
          }
          if (defaultDir.trim() !== currentDir) {
            if (defaultDir.trim()) ops.push({ op: "set", path: ["defaultDirectory"], value: defaultDir.trim() });
            else ops.push({ op: "unset", path: ["defaultDirectory"] });
          }
          if (defaultModelSel !== currentModel) {
            if (defaultModelSel) {
              const [provider, model] = defaultModelSel.split("::");
              ops.push({ op: "set", path: ["defaultModel"], value: { provider, model } });
            } else {
              ops.push({ op: "unset", path: ["defaultModel"] });
            }
          }
          if (defaultPerm !== currentPerm) {
            if (defaultPerm) ops.push({ op: "set", path: ["defaultPermissionPreset"], value: defaultPerm });
            else ops.push({ op: "unset", path: ["defaultPermissionPreset"] });
          }
          if (ops.length === 0) {
            setNotice("没有需要保存的变更。");
            return;
          }
          const accepted = await form.mutate(ops, state?.revision);
          if (accepted) {
            setAppSecret("");
            setNotice("已保存，配置已生效。");
          } else {
            setNotice("保存被拒绝：请检查 App ID / App Secret 是否正确，或刷新后重试。");
          }
        } catch (error) {
          setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        { style: styles.page },
        h(
          "div",
          { style: styles.hint },
          "凭据只写入当前 DSH profile 的配置覆盖层，不会出现在浏览器读取的明文响应里；App Secret 以密文角色保存。",
        ),
        h(
          "div",
          { style: styles.row },
          h("label", { style: styles.label }, "App ID"),
          h("input", {
            style: styles.input,
            value: appId,
            spellCheck: false,
            autoComplete: "off",
            placeholder: "cli_xxxxxxxx",
            disabled: !writable || busy,
            onChange: (event) => setAppId(event.target.value),
          }),
          h("span", { style: styles.hint }, "飞书开放平台 → 应用信息 → 凭证与基础信息。"),
        ),
        h(
          "div",
          { style: styles.row },
          h("label", { style: styles.label }, "App Secret"),
          h("input", {
            style: styles.input,
            type: "password",
            value: appSecret,
            spellCheck: false,
            autoComplete: "new-password",
            placeholder: "留空 = 保持当前密钥不变",
            disabled: !writable || busy,
            onChange: (event) => setAppSecret(event.target.value),
          }),
          h(
            "span",
            { style: styles.hint },
            "出于安全原因，已保存的密钥不会回显；需要更换时填入新值再保存。",
          ),
        ),
        h(
          "div",
          { style: styles.section },
          h("div", { style: styles.sectionTitle }, "新会话默认值"),
          h(
            "div",
            { style: styles.row },
            h("label", { style: styles.label }, "默认工作目录"),
            h(
              "div",
              { style: styles.inline },
              h("input", {
                style: styles.inputFlex,
                value: defaultDir,
                spellCheck: false,
                placeholder: "留空 = 使用进程当前目录",
                disabled: !writable || busy,
                onChange: (event) => setDefaultDir(event.target.value),
              }),
              h(
                "button",
                {
                  type: "button",
                  style: { ...styles.secondaryButton, ...(busy ? styles.buttonDisabled : {}) },
                  disabled: busy || typeof props?.pickDirectory !== "function",
                  onClick: async () => {
                    try {
                      const picked = await props.pickDirectory();
                      if (picked) setDefaultDir(picked);
                    } catch (error) {
                      setNotice(`选择目录失败：${error instanceof Error ? error.message : String(error)}`);
                    }
                  },
                },
                "选择目录",
              ),
            ),
            h("span", { style: styles.hint }, "新建会话与话题内自动建会话都会使用这个目录；留空则用 DSH 当前目录。"),
          ),
          h(
            "div",
            { style: styles.row },
            h("label", { style: styles.label }, "默认工作模型"),
            h(
              "select",
              {
                style: styles.select,
                value: defaultModelSel,
                disabled: !writable || busy,
                onChange: (event) => setDefaultModelSel(event.target.value),
              },
              h("option", { value: "" }, "跟随 DSH 默认模型"),
              currentModel && !catalogs.models.some((model) => `${model.provider}::${model.model}` === currentModel)
                ? h("option", { value: currentModel }, `${currentModel}（当前配置，目录中未找到）`)
                : null,
              ...catalogs.models.map((model) =>
                h(
                  "option",
                  { key: `${model.provider}::${model.model}`, value: `${model.provider}::${model.model}` },
                  `${model.providerName ? `${model.providerName} / ` : ""}${model.name}`,
                ),
              ),
            ),
            h("span", { style: styles.hint }, "新建会话时预选；也可在会话内用 /model 临时切换。"),
          ),
          h(
            "div",
            { style: styles.row },
            h("label", { style: styles.label }, "默认工作权限"),
            h(
              "select",
              {
                style: styles.select,
                value: defaultPerm,
                disabled: !writable || busy,
                onChange: (event) => setDefaultPerm(event.target.value),
              },
              h("option", { value: "" }, "跟随 DSH 默认权限"),
              currentPerm && !catalogs.perms.some((perm) => perm.value === currentPerm)
                ? h("option", { value: currentPerm }, `${currentPerm}（当前配置，目录中未找到）`)
                : null,
              ...catalogs.perms.map((perm) =>
                h(
                  "option",
                  { key: perm.value, value: perm.value },
                  `${perm.name}${perm.description ? ` — ${perm.description}` : ""}`,
                ),
              ),
            ),
            h("span", { style: styles.hint }, "新建会话时应用；之后可在会话内用 /perm 切换。"),
          ),
          catalogError ? h("span", { style: styles.error }, `模型/权限目录读取失败：${catalogError}`) : null,
        ),
        h(
          "label",
          { style: styles.toggleRow },
          h("input", {
            type: "checkbox",
            style: styles.toggle,
            checked: debugLog,
            disabled: !writable || busy,
            onChange: (event) => setDebugLog(event.target.checked),
          }),
          h(
            "span",
            { style: styles.label },
            "调试日志（写入 feishu.log：消息路由、卡片操作、prompt 错误与 stack）",
          ),
        ),
        h(
          "div",
          { style: styles.actions },
          h(
            "button",
            {
              type: "button",
              style: { ...styles.button, ...(busy || !writable || !dirty ? styles.buttonDisabled : {}) },
              disabled: busy || !writable || !dirty,
              onClick: save,
            },
            busy ? "保存中…" : "保存",
          ),
          h(
            "span",
            { style: notice.startsWith("保存失败") || notice.startsWith("保存被拒绝") ? styles.error : styles.status },
            notice,
          ),
        ),
        h(
          "div",
          { style: styles.hint },
          "保存后如果 App ID / Secret 有变化，Host 会重建飞书客户端并重新建立 WebSocket 长连接；正在进行的会话不受影响。",
        ),
      );
    }

    /**
     * The bundle page passes no form prop; bind the entry's shared
     * ConfigForm directly so the credentials editor renders on the package
     * page itself, where users look first.
     */
    function BundleConfig({ configForm, loadCatalogs, pickDirectory }) {
      const [state, setState] = useState(() => configForm.getSnapshot());
      useEffect(() => configForm.subscribe(() => setState(configForm.getSnapshot())), [configForm]);
      const form = { state, mutate: configForm.mutate.bind(configForm) };
      return h(FeishuConfig, { view: "page", form, loadCatalogs, pickDirectory });
    }

    return {
      inject: [
        "slots",
        "configForms",
        "remote",
        "remote.session",
        "remote.permissionPresets",
        "uiWorkspace",
      ],
      apply(ctx) {
        const configForm = ctx.configForms.get("feishu");
        const loadCatalogs = async () => {
          const [modelsResult, permsResult] = await Promise.all([
            ctx.remote.session.modelCatalog(),
            ctx.remote.permissionPresets.catalog(),
          ]);
          const models = [];
          if (modelsResult.ok) {
            for (const group of modelsResult.value.groups ?? []) {
              for (const model of group.models ?? []) {
                models.push({
                  provider: group.id,
                  providerName: group.name || group.id,
                  model: model.id,
                  name: model.name || model.id,
                });
              }
            }
          }
          const perms = permsResult.ok
            ? (permsResult.value.options ?? []).map((option) => ({
                value: option.value,
                name: option.name || option.value,
                description: option.description,
              }))
            : [];
          return { models, perms };
        };
        const pickDirectory = async () => {
          const picked = await ctx.uiWorkspace.pickDirectory();
          return picked ?? undefined;
        };
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.config",
              key: "dsh-feishu-plugin",
              inject: () => ({ configForm, loadCatalogs, pickDirectory }),
            },
            BundleConfig,
          ),
        );
        ctx.slots.inject("plugins.row.config", () =>
          ctx.slots.register(
            {
              name: "plugins.row.config",
              key: "dsh-feishu-plugin#feishu",
              inject: () => ({ loadCatalogs, pickDirectory }),
            },
            FeishuConfig,
          ),
        );
      },
    };
  },
});
