import { copyFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("lib", { recursive: true, force: true });
await mkdir("lib", { recursive: true });

await build({
  entryPoints: ["src/index.js"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  // Several bundled CJS dependencies call require() lazily; provide a real
  // module-scope require so esbuild's __require helper does not throw.
  // The Feishu SDK also reads its own package.json through __dirname.
  banner: {
    js: 'import { createRequire as __dshCreateRequire } from "node:module"; import { fileURLToPath as __dshFileURLToPath } from "node:url"; import { dirname as __dshDirname } from "node:path"; const require = __dshCreateRequire(import.meta.url); const __filename = __dshFileURLToPath(import.meta.url); const __dirname = __dshDirname(__filename);',
  },
  // Self-contained on purpose: the published package has no runtime deps.
  packages: "bundle",
  logLevel: "info",
});

await copyFile("client.js", "lib/client.js");

// Static checks cannot catch the CJS-in-ESM failures above; import once.
const smoke = await import(new URL(`../lib/index.js?smoke=${Date.now()}`, import.meta.url));
if (typeof smoke.apply !== "function") throw new Error("lib/index.js did not export apply()");
if (!smoke.Config) throw new Error("lib/index.js did not export Config");
console.log("smoke import ok:", Object.keys(smoke).join(", "));
