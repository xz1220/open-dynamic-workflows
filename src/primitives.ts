/**
 * Programming primitives (L4) — STUB (M2).
 *
 * The verbs a workflow author composes with ordinary JS control flow. In the
 * Claude Code dialect these are *injected globals*, never imported, so the
 * loader binds a freshly-built set of these into the script's scope per run.
 *
 *   - agent     — run one coding agent on a subtask (the only verb that works)
 *   - parallel  — fan out a batch and wait for all of it (barrier)
 *   - pipeline  — stream items through stages independently (no barrier)
 *   - phase     — label the following work for progress display
 *   - log       — surface a progress message
 *   - budget    — token/agent budget exposed to the script (stub in v1)
 *   - workflow  — run another workflow inline (deferred; throws clearly for now)
 *
 * `args` is not here: it is run data injected alongside these globals.
 */

import { notImplemented } from "./errors.js";
import type { JsonSchema } from "./schema.js";
import type { RunContext } from "./context.js";

export interface AgentOptions {
  /** Which configured adapter/CLI to use; falls back to the default. */
  adapter?: string;
  /** A JSON Schema; when set, the reply is validated and returned as an object. */
  schema?: JsonSchema;
  /** Short label for progress display. */
  label?: string;
  /** Override the current phase for this one call (use inside parallel/pipeline). */
  phase?: string;
  /** Reserved (v1.5): map to an adapter's model flag. */
  model?: string;
  /** Reserved (v1.5): map to a named adapter/role. */
  agentType?: string;
  /** Reserved (v1.5): `"worktree"` for git-worktree isolation. */
  isolation?: "worktree";
}

export interface Budget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export type Thunk<T> = () => Promise<T> | T;
export type Stage = (previous: unknown, item: unknown, index: number) => unknown;

/** The surface injected into a workflow script (alongside `args`). */
export interface WorkflowGlobals {
  agent(prompt: string, opts?: AgentOptions): Promise<unknown>;
  parallel<T>(thunks: Array<Thunk<T>>): Promise<Array<T | null>>;
  pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]>;
  phase(title: string): void;
  log(message: unknown): void;
  budget: Budget;
  workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<unknown>;
}

/** Build the injected primitive set bound to a single run's context. */
export function createPrimitives(_ctx: RunContext): WorkflowGlobals {
  throw notImplemented("primitives (M2)");
}
