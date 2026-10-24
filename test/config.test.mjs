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

test("missing credentials keep the bridge disabled", () => {
  const config = resolveConfig(Config({}));
  assert.equal(config.enabled, false);
  assert.match(config.disabledReason, /appId/);
});
