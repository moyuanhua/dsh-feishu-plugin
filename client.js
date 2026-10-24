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
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState("");

      useEffect(() => {
        setAppId(typeof value.appId === "string" ? value.appId : "");
      }, [value.appId]);

      if (view === "summary") {
        return h(
          "span",
          { style: styles.summary },
          value.appId
            ? h("span", null, h("span", { style: styles.badge }, "飞书已配置"), " ", value.appId)
            : "配置飞书 App ID / App Secret，启用飞书话题 ↔ DSH 会话桥接。",
        );
      }

      const writable = state?.writable !== false;
      const dirty = appId !== (typeof value.appId === "string" ? value.appId : "") || appSecret.trim() !== "";

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
          if (ops.length === 0) {
            setNotice("没有需要保存的变更。");
            return;
          }
          const accepted = await form.mutate(ops, state?.revision);
          if (accepted) {
            setAppSecret("");
            setNotice("已保存。飞书长连接会自动使用新凭据重连。");
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
    function BundleConfig({ configForm }) {
      const [state, setState] = useState(() => configForm.getSnapshot());
      useEffect(() => configForm.subscribe(() => setState(configForm.getSnapshot())), [configForm]);
      const form = { state, mutate: configForm.mutate.bind(configForm) };
      return h(FeishuConfig, { view: "page", form });
    }

    return {
      inject: ["slots", "configForms"],
      apply(ctx) {
        const configForm = ctx.configForms.get("feishu");
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.config",
              key: "dsh-feishu-plugin",
              inject: () => ({ configForm }),
            },
            BundleConfig,
          ),
        );
        ctx.slots.inject("plugins.row.config", () =>
          ctx.slots.register(
            {
              name: "plugins.row.config",
              key: "dsh-feishu-plugin#feishu",
            },
            FeishuConfig,
          ),
        );
      },
    };
  },
});
