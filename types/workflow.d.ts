/**
 * Ambient types for the workflow authoring surface.
 *
 * Workflow scripts are plain JavaScript executed by the runtime with these
 * globals injected (never imported). This declaration file exists purely for
 * editor tooling: drop a reference at the top of a workflow script to get
 * autocomplete and type-checking on the injected primitives —
 *
 *   /// <reference types="open-dynamic-workflows/types/workflow" />
 *
 * — even though the script itself ships and runs as untyped `.js`. This mirrors
 * the typed authoring experience of Claude Code's built-in workflow runtime.
 */

export {};

declare global {
  /** A JSON Schema object (the structured-output contract for `agent`). */
  type JsonSchema = Record<string, unknown>;

  interface AgentOptions {
    /** Which configured adapter/CLI to use; falls back to the default. */
    adapter?: string;
    /** When set, the reply is validated against it and returned as an object. */
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

  interface Budget {
    /** The run's token target, or null if none was set. */
    total: number | null;
    /** Output tokens spent so far this run (best-effort). */
    spent(): number;
    /** `max(0, total - spent())`, or Infinity if no target. */
    remaining(): number;
  }

  /** The workflow's input value, injected verbatim. */
  const args: unknown;

  /** Run one coding agent on a subtask. The only verb that does work. */
  function agent(prompt: string, opts?: AgentOptions): Promise<any>;

  /** Run thunks concurrently and wait for all (barrier); a failure becomes null. */
  function parallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>>;

  /** Stream each item through stages independently (no barrier). */
  function pipeline(
    items: any[],
    ...stages: Array<(previous: any, item: any, index: number) => any>
  ): Promise<any[]>;

  /** Start a new named phase for progress grouping. */
  function phase(title: string): void;

  /** Emit a one-line progress message. */
  function log(message: unknown): void;

  /** Token/agent budget exposed to the script. */
  const budget: Budget;

  /** Run another workflow inline as a sub-step (one level of nesting). */
  function workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<any>;
}
