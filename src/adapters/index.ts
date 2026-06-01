/** L1 adapter layer — uniform CLI invocation. */

export type { Adapter, Settings, Config, CliResult } from "./types.js";
export { cliOk, adapterDisplayName } from "./types.js";
export { expand, expandAll, PLACEHOLDERS } from "./placeholders.js";
export type { PlaceholderName, PlaceholderContext } from "./placeholders.js";
export { BUILTIN_ADAPTERS, DEFAULT_SETTINGS } from "./builtin.js";
export type { RawAdapter } from "./builtin.js";
export { loadConfig, defaultConfig, resolveConcurrency, CONFIG_ENV_VAR } from "./config.js";
export { runCommand } from "./runner.js";
export type { CommandRunner, RunCommandOptions } from "./runner.js";
