/**
 * Ambient types for the workflow authoring surface.
 *
 * Workflow scripts are plain JavaScript executed by the runtime with these
 * globals injected (never imported). This declaration file exists purely for
 * editor tooling: drop a reference at the top of a workflow script to get
 * autocomplete and type-checking on the injected primitives —
 *
 *   /// <reference path="../types/workflow.d.ts" />
 *
 * Adjust the path for your script. The script still ships as untyped `.js`.
 * These types describe ODW's authoring surface, not full Claude runtime parity;
 * scripts run as trusted JavaScript, without a sandbox or crash-result replay.
 */

export {};

declare global {
  /** ODW's JSON Schema subset; unsupported keywords are not enforced. See the primitive reference. */
  type JsonSchema = Record<string, unknown>;

  interface AgentOptions {
    /** Which configured adapter/CLI to use; falls back to the default. */
    adapter?: string;
    /** When set, the reply is checked against ODW's schema subset and returned as a JSON value. */
    schema?: JsonSchema;
    /** Short label for progress display. */
    label?: string;
    /** Override the current phase for this one call (use inside parallel/pipeline). */
    phase?: string;
    /** CLI-specific model id via `{model}` or flags.model; otherwise ignored with a routing note. Metadata model fields do not supply a default. */
    model?: string;
    /** Prompt persona, not an adapter name or a loader for Claude roles, tools, permissions, or project subagent definitions. */
    agentType?: string;
    /** Throwaway git worktree at HEAD (needs a committed repo; no uncommitted edits). Cleaned up without merging; agent() does not return its diff. */
    isolation?: "worktree";
  }

  interface Budget {
    /** Estimated output-token dispatch target, or null; not an actual usage or billing ceiling. */
    total: number | null;
    /** ceil(successful final-reply characters / 4), shared with children; excludes input, failures, and intermediate retries. */
    spent(): number;
    /** `max(0, total - spent())`, or Infinity if no target. */
    remaining(): number;
  }

  /** The workflow's input value, injected verbatim. */
  const args: unknown;

  /** Run one coding agent; returns reply text or a validated JSON value, not a worktree diff. */
  function agent(prompt: string, opts?: AgentOptions): Promise<any>;

  /** Ordered barrier: recoverable failures become null; fatal stop/budget/dispatch-cap/configuration errors propagate after all thunks settle. */
  function parallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>>;

  /** Run each item through stages independently; recoverable failures drop that item to null, fatal errors propagate. */
  function pipeline(
    items: any[],
    ...stages: Array<(previous: any, item: any, index: number) => any>
  ): Promise<any[]>;

  /** Start a new named phase for progress grouping. */
  function phase(title: string): void;

  /** Emit a one-line progress message. */
  function log(message: unknown): void;

  /** Estimated output budget; checked before each dispatch and schema retry — once spent, the run ends and running agents are stopped. */
  const budget: Budget;

  /** Inline child sharing scheduler, controls, and budget; only one level. scriptPath is relative to the run source. */
  function workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<any>;

  /** ODW extension: parses meta as a pure literal (never evaluated) and compile-checks the body without running it. Warnings are advisory; a script's own validate binding takes precedence. */
  function validate(source: string): {
    ok: boolean;
    meta?: {
      name: string;
      description: string;
      whenToUse?: string;
      phases?: Array<{ title: string; detail?: string; model?: string }>;
      model?: string;
    };
    errors: string[];
    warnings: string[];
  };
}
