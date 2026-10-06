import { defineConfig } from "vitest/config";

/**
 * 测试与覆盖率配置。
 *
 * **覆盖率排除项是有理由的，不是凑数**：下面这几个文件是"插件与宿主之间的装配接缝"
 * —— `apply()` 的接线、cordis 服务注入、飞书 SDK 封装。它们的正确性取决于**真实宿主**
 * 与**真实飞书连接**，单测里只能造一个假 ctx 自欺欺人；它们由真实宿主联调验证
 * （见 `docs/REDESIGN.md` §6.1 的真机验证）。其余所有业务逻辑都必须走单测。
 */
const HOST_WIRING_ONLY = [
  "src/index.ts", // cordis 装配：把各层接到 ctx 上
  "src/cli.ts", // 安装准备 CLI
  "src/dsh/port.ts", // ctx.agents 适配
  "src/dsh/storage.ts", // ctx.storageDomain 适配
  "src/dsh/source.ts", // 消息来源标记（只有类型 + 一个构造器）
  "src/feishu/channel.ts", // @larksuite/channel 封装
];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    /**
     * 这三个超时是**安全网**，不是可选项。
     *
     * 实测教训：一条泄漏了文件描述符的用例（未 close 的 write stream）会让
     * vitest 的 worker **永不退出**，本地看不出来（macOS 行为不同），CI 上表现为
     * 一个跑了十几分钟还没结束的 job —— 而日志里什么都看不到。
     * 有了这三个上限，"挂死"最坏也就是一次有明确报错的失败。
     */
    testTimeout: 15_000,
    hookTimeout: 15_000,
    teardownTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: HOST_WIRING_ONLY,
      /**
       * 门槛按"业务逻辑必须全覆盖"来定，略低于实测值以留出余量。
       */
      thresholds: {
        statements: 92,
        branches: 84,
        functions: 94,
        lines: 92,
      },
    },
  },
});
