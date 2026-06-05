/**
 * Open Dynamic Workflows — a runtime that runs Claude Code-format dynamic
 * workflow scripts against any coding-agent CLI.
 *
 * A workflow script is plain JavaScript in Claude's dialect: `export const meta`
 * at the top, then a body that uses injected globals (`agent`, `parallel`,
 * `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`) with top-level
 * `await`/`return`. The `odw` CLI starts such a script in the background and the
 * runtime executes it, handing back only the final return value.
 *
 * This module is the library entry point (for embedding the engine); the CLI is
 * the usual front door.
 */

export const VERSION = "0.2.2";

// Errors & events
export * from "./errors.js";
export * from "./events.js";

// L1 adapters
export type { Adapter, Settings, Config, CliResult } from "./adapters/types.js";
export { BUILTIN_ADAPTERS, DEFAULT_SETTINGS } from "./adapters/builtin.js";
export { expand, expandAll, PLACEHOLDERS } from "./adapters/placeholders.js";

// L4 primitives & schema (authoring surface)
export type {
  AgentOptions,
  Budget,
  WorkflowGlobals,
  Thunk,
  Stage,
} from "./primitives.js";
export type { JsonSchema } from "./schema.js";

// Loader / transform (the crux) & meta shape
export type { WorkflowMeta, WorkflowPhaseMeta, LoadedWorkflow } from "./loader.js";

// L5 runtime
export { RunStore, startRun, waitFor, executeRun } from "./runtime/index.js";
