/**
 * DSH 客户端（浏览器半侧）的模块形状。
 *
 * 这些包只存在于 **宿主运行时**（浏览器里），不能作为本仓库的依赖安装 ——
 * 所以这里只声明我们用到的部分。打包时它们被 esbuild 外部化，由宿主的
 * 客户端模块系统在浏览器里提供。
 *
 * 形状来源：官方 `dsh-client-ui-settings-agent-loop` 的编译产物
 * （`lib/client.js`），逐条对齐，不是猜的。
 */
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  /** 一个分节字段的读写规格（`settings*Field()` 的返回值）。 */
  export interface SettingsFieldSpec {
    readonly field: string;
    format(value: unknown): string;
    parse(text: string): { kind: "set"; value: unknown } | { kind: "clear" } | undefined;
  }

  /** 表单里单个字段的状态。 */
  export interface SettingsFieldState {
    readonly text: string;
    readonly overridden: boolean;
    readonly invalid: boolean;
  }

  /** 表单级状态。 */
  export interface SettingsFormShell {
    readonly available: boolean;
    readonly writable: boolean;
    readonly dirty: boolean;
    readonly invalid: boolean;
    readonly saving: boolean;
    readonly failed: boolean;
  }

  /** 宿主为某个命名空间提供的配置 scope。 */
  export interface SettingsScope {
    subscribe(listener: () => void): () => void;
    getSnapshot(): { readonly status: string; readonly writable: boolean };
  }

  export function settingsTextField(field: string): SettingsFieldSpec;
  export function settingsNumberField(field: string): SettingsFieldSpec;

  export class SettingsFormModel {
    constructor(scope: SettingsScope, specs: readonly SettingsFieldSpec[], secrets?: readonly unknown[]);
    bind<T>(project: () => T): (selector: (snapshot: T) => unknown) => unknown;
    shell(): SettingsFormShell;
    field(field: string): SettingsFieldState;
    actions(): Record<string, unknown>;
    dispose(): void;
  }

  export function SettingsForm(props: Record<string, unknown>): unknown;
  export function SettingsValueField(props: Record<string, unknown>): unknown;
  export function SettingsSecretField(props: Record<string, unknown>): unknown;
}

declare module "react/jsx-runtime" {
  export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): unknown;
  export function jsxs(type: unknown, props: Record<string, unknown>, key?: unknown): unknown;
  export const Fragment: unknown;
}
