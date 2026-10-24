/** Live (volatile) Config schema: the fields the DSH settings UI may edit. */
import Schema from "@deepseek-ai/schemastery";

export const Config = Schema.object({
  // The two credentials are the only volatile fields: they are edited from the
  // plugin's page and applied live, without remounting the bundle.
  appId: Schema.string().default("").volatile(),
  appSecret: Schema.string().role("secret").default("").volatile(),

  domain: Schema.union(["feishu", "lark"]).default("feishu"),
  allowUsers: Schema.array(Schema.string()).default([]),
  allowedRoots: Schema.array(Schema.string()).default([]),
  defaultDirectory: Schema.string().default(""),
  defaultModel: Schema.object({
    provider: Schema.string().default(""),
    model: Schema.string().default(""),
  }).default({ provider: "", model: "" }),
  defaultPermissionPreset: Schema.string().default(""),
  busyDelivery: Schema.union(["queue", "steer"]).default("queue"),
  acceptAttachments: Schema.boolean().default(true),
  attachmentMaxBytes: Schema.number().default(20 * 1024 * 1024),
  attachmentTimeoutMs: Schema.number().default(30_000),
  stream: Schema.boolean().default(true),
  streamThrottleMs: Schema.number().default(700),
  approvalTtlMs: Schema.number().default(10 * 60_000),
  questionTtlMs: Schema.number().default(10 * 60_000),
  staleMessageMs: Schema.number().default(120_000),
  sessionPageSize: Schema.number().default(8),
  maxAnswerChars: Schema.number().default(12_000),
  logLevel: Schema.union(["debug", "info", "warn", "error"]).default("info"),
  logFile: Schema.any(),
  stateFile: Schema.string().default(""),
  signSecret: Schema.string().role("secret").default(""),
});
