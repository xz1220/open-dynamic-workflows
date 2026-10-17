/** L1 adapter layer — uniform CLI invocation. */

export type { Adapter, AdapterOutput, Settings, Config, CliResult } from "./types.js";
export { cliOk, adapterDisplayName } from "./types.js";
export { expand, expandAll, PLACEHOLDERS } from "./placeholders.js";
export type { PlaceholderName, PlaceholderContext } from "./placeholders.js";
export { BUILTIN_ADAPTERS, DEFAULT_SETTINGS } from "./builtin.js";
export type { RawAdapter } from "./builtin.js";
export { AdapterOutputDecoder, decodeAdapterOutput, decodeOutput } from "./output.js";
export type { DecodedOutput } from "./output.js";
export { addUsage, normalizeUsage } from "./usage.js";
export type { Usage } from "./usage.js";
export {
  loadConfig,
  defaultConfig,
  resolveAdapter,
  resolveConcurrency,
  resolveRunsRoot,
  CONFIG_ENV_VAR,
} from "./config.js";
export { runCommand } from "./runner.js";
export type { CommandRunner, RunCommandOptions } from "./runner.js";
