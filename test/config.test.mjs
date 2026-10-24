import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/config-schema.js";
import { resolveConfig } from "../src/config.js";

test("volatile schema fields resolve through live references", () => {
  const parsed = Config({
    appId: "cli_test",
    appSecret: "secret_test",
    domain: "feishu",
    allowedRoots: ["/tmp"],
  });
  const config = resolveConfig(parsed);
  assert.equal(config.enabled, true);
  assert.equal(config.appId, "cli_test");
  assert.equal(config.appSecret, "secret_test");
  assert.equal(config.domain, "feishu");
  assert.deepEqual(config.allowedRoots, ["/tmp"]);
});

test("debugLog switch forces debug level", () => {
  const on = resolveConfig(Config({ appId: "x", appSecret: "y", debugLog: true }));
  assert.equal(on.debugLog, true);
  assert.equal(on.logLevel, "debug");
  const off = resolveConfig(Config({ appId: "x", appSecret: "y", logLevel: "warn", debugLog: false }));
  assert.equal(off.debugLog, false);
  assert.equal(off.logLevel, "warn");
});

test("missing credentials keep the bridge disabled", () => {
  const config = resolveConfig(Config({}));
  assert.equal(config.enabled, false);
  assert.match(config.disabledReason, /appId/);
});
