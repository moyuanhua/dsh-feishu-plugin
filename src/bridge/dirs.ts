/**
 * 工作目录策略（**纯函数**，不做 IO）。
 *
 * 为什么需要它：旧实现的 `cwd` 直接回落 `process.cwd()`，于是"宿主进程恰好从哪启动"
 * 就决定了会话的工作目录 —— 实测里飞书会话的工作目录变成了 `/private/tmp`，因为验证宿主
 * 是在 `/tmp` 下启动的。这是一个**用户完全无法察觉、也无法选择**的隐式决策。
 *
 * 新策略（对齐上游 `feishu/dirs.ts` 的产品语义）：
 * 1. 目录必须有**明确来源**：配置的 `cwd`，或 `allowedRoots` 的第一项；
 * 2. 必须落在 `allowedRoots` 之内（越界一律拒绝，不做静默夹取）；
 * 3. 拒绝系统目录 —— 让"在 `/` 或 `/usr` 里开一个编码会话"这类明显错误尽早失败；
 * 4. 校验失败时给出的文案与上游逐字对齐，用户看到的提示在两版插件里一致。
 *
 * 真正的文件系统检查（存在性 / 是否目录 / 是否需要创建）由调用方注入，因此本模块可单测。
 */
import { isAbsolute, resolve, sep } from "node:path";

/** 永不允许作为工作目录的系统路径（前缀匹配）。 */
const SYSTEM_DIRS: readonly string[] = [
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/var",
  "/dev",
  "/proc",
  "/sys",
  "/System",
  "/Library",
];

export type DirResolution =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly message: string };

/** 规范化：展开 `~`、折叠 `.`/`..`、去掉结尾分隔符（根目录除外）。 */
export function normalizeDir(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? resolve(process.env.HOME ?? "/", trimmed.slice(2))
    : trimmed;
  const absolute = resolve(expanded);
  return absolute.length > 1 && absolute.endsWith(sep) ? absolute.slice(0, -1) : absolute;
}

/** `child` 是否等于 `root` 或位于 `root` 之下（按路径段比较，避免 `/a/bc` 命中 `/a/b`）。 */
export function isWithin(child: string, root: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function looksLikeSystemDir(dir: string): boolean {
  return SYSTEM_DIRS.some((sys) => dir === sys || isWithin(dir, sys));
}

export interface ResolveWorkingDirInput {
  /** 用户显式给出的目录（`/new <dir>` / 表单输入）；缺省 = 用 `defaultDir`。 */
  readonly requested?: string | undefined;
  /** 配置的 `cwd`；没有则用 `allowedRoots[0]`。 */
  readonly defaultDir?: string | undefined;
  /** 允许的工作目录根（必须非空）。 */
  readonly allowedRoots: readonly string[];
}

/**
 * 决定一个会话的工作目录。
 *
 * 顺序与上游一致：显式目录 → 默认目录（配置 cwd → allowedRoots[0]），然后做三项校验。
 * **任何情况下都不会回落 `process.cwd()`。**
 */
export function resolveWorkingDir(input: ResolveWorkingDirInput): DirResolution {
  const roots = input.allowedRoots.map(normalizeDir).filter(Boolean);
  if (roots.length === 0) {
    return { ok: false, message: "未配置允许的工作目录根（allowedRoots），无法确定默认目录。" };
  }

  const requested = input.requested?.trim() ? normalizeDir(input.requested) : "";
  const fallback = input.defaultDir?.trim() ? normalizeDir(input.defaultDir) : "";
  const candidate = requested || fallback || roots[0]!;

  if (!isAbsolute(candidate)) {
    return { ok: false, message: "目录必须是**绝对路径**（以 / 开头）。" };
  }
  if (candidate === "/") {
    return { ok: false, message: "不能使用根目录 `/`，请选择具体的项目子目录。" };
  }
  if (looksLikeSystemDir(candidate)) {
    return { ok: false, message: `系统目录不可作为工作目录：\`${candidate}\`。` };
  }
  if (!roots.some((root) => isWithin(candidate, root))) {
    return {
      ok: false,
      message: `目录不在允许范围内。允许的根目录：${roots.join("、")}。`,
    };
  }
  return { ok: true, dir: candidate };
}
