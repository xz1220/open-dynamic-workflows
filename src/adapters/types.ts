/**
 * Configuration model shapes (L1).
 *
 * A {@link Config} is the immutable description of *which* coding-agent CLIs
 * exist ({@link Adapter}) and *how* a run behaves ({@link Settings}). It is
 * loaded once at run start and then only read.
 */

/**
 * Which per-call options this CLI can carry, and the argv flag that carries
 * each. An option absent here is one this adapter does NOT support natively, so
 * the router routes it elsewhere (e.g. prompt injection) or logs that it could
 * not be honoured — it is never silently dropped. Declaring support is one line
 * of config; no code change adds a CLI's model flag.
 */
export interface AdapterFlags {
  /** The flag(s) that select a model, e.g. `["--model"]` or `["-m"]`. */
  model?: string[];
}

/**
 * How stdout from an adapter becomes the agent's final response — and, for the
 * JSON formats, what the run spent and whether the CLI itself reported it
 * failed (`usagePath`, `costPath`, `errorPath`: ODW extensions). A path is a
 * list of object keys; a whole number in it indexes an array (negative: from
 * its end). When the declared text is not there, the raw stdout is the reply
 * and the run's log says why (see adapters/output.ts).
 */
export type AdapterOutput =
  | { format: "text" }
  | {
      /** Newline-delimited JSON events; the last matching text event wins. */
      format: "jsonl";
      eventType: string;
      textPath: string[];
      select: "last";
      /** The events usage and cost are read from (default: `eventType`); every one adds up. */
      usageEvent?: string;
      /** Path, in a usage event, to its token counts (normalized by adapters/usage.ts). */
      usagePath?: string[];
      /** Path, in a usage event, to its cost in US dollars. */
      costPath?: string[];
      /**
       * Path, in a text event, to the CLI's own failure report: `true`, a
       * message, or an error object. When the last text event has one, the
       * run failed with it (classified like any failure), whatever its exit.
       */
      errorPath?: string[];
    }
  | {
      /** One JSON document on stdout: the paths are read from it. */
      format: "json";
      textPath: string[];
      usagePath?: string[];
      costPath?: string[];
      errorPath?: string[];
    };

/**
 * An adapter's own failure wording (ODW extension): regular-expression sources
 * per failure class, matched case-insensitively against the end of a failed
 * run's output before the built-in table (see adapters/failures.ts).
 */
export interface AdapterFailures {
  /** Throttling or overload: retried after a backoff. */
  rate_limit?: string[];
  /** A spent usage window, credit balance or plan limit: not retried. */
  quota?: string[];
  /** Not logged in, or refused credentials: not retried. */
  auth?: string[];
}

/** How to invoke one coding-agent CLI. */
export interface Adapter {
  name: string;
  /** Argument-vector template; `{placeholder}` tokens are expanded per call. */
  command: string[];
  /** Optional stdin template (e.g. `"{prompt}"`). */
  stdin?: string;
  /** Extra environment variables layered over the process environment. */
  env?: Record<string, string>;
  /** Per-call timeout in seconds; falls back to the run-wide setting. */
  timeout?: number;
  /**
   * Stall timeout in seconds for this CLI; falls back to the run-wide setting.
   * `0` turns the stall watchdog off for this adapter.
   */
  stallTimeout?: number;
  /** Human-friendly label for progress display. */
  label?: string;
  /** Capability declaration: which per-call options this CLI carries natively. */
  flags?: AdapterFlags;
  /** Response decoding; omitted means trimmed plain text. */
  output?: AdapterOutput;
  /** Extra failure wording for this CLI, matched before the built-in table. */
  failures?: AdapterFailures;
}

/** Run-wide knobs independent of any single adapter. */
export interface Settings {
  /** Which adapter `agent()` uses when a call does not name one. */
  defaultAdapter: string | null;
  /** Max agent CLIs running at once; `null` => auto from CPU count. */
  concurrency: number | null;
  /** Hard ceiling on total dispatches per run (runaway guard). */
  maxAgents: number;
  /** Per-agent CLI timeout in seconds; `null` => no timeout. */
  timeout: number | null;
  /**
   * Stall watchdog: seconds an agent CLI may go without writing to stdout or
   * stderr before it is killed and restarted; `null` => off. Only for CLIs that
   * stream progress — a text-mode CLI may print nothing until it is done.
   */
  stallTimeout: number | null;
  /** How many times one agent call is restarted after stalling before it fails. */
  stallRestarts: number;
  /**
   * How many times one agent call is retried after its CLI hit a rate limit,
   * with exponential backoff that honors a retry-after the CLI printed.
   */
  transientRetries: number;
  /** The longest single backoff wait before such a retry, in seconds. */
  maxBackoff: number;
  /** Extra attempts when a schema fails to validate. */
  schemaRetries: number;
  /** Directory runs are stored under; `null` => `~/.odw/runs`. */
  runsRoot: string | null;
  /** Directory workflows are resolved by name from; `null` => `~/.odw/workflows`. */
  workflowsRoot: string | null;
  /** Directory Claude Code saved workflows are read from; `null` => `~/.claude/workflows`. */
  claudeWorkflowsRoot: string | null;
  /**
   * Which Claude Code runs the Jobs tab surfaces: `"all"` aggregates every
   * project's runs (the observatory default, matching the global ODW runs root);
   * `"project"` narrows to the served repo and its git worktrees. `"all"` is
   * broader — it exposes other projects' run names/results on this loopback server.
   */
  claudeJobsScope: "all" | "project";
  /** Hooks fired when a run ends; `null` => none. */
  notify: NotifySettings | null;
  /**
   * A command run in each new isolated worktree before its agent starts (an
   * ODW extension): a string runs through the platform shell, an array is an
   * argv run without one; `null` => none.
   */
  worktreeSetup: string | string[] | null;
  /** Seconds the worktree setup may run before it is killed and its agent fails. */
  worktreeSetupTimeout: number;
  /** Where each running agent's `ODW_PORT` comes from: `[first, last]`, inclusive (an ODW extension). */
  portRange: [number, number];
  /**
   * Log a warning when one parallel() or pipeline() call fans out wider than
   * this — more thunks, or more items (an ODW extension); `null` => never.
   */
  fanOutWarn: number | null;
}

/** The terminal states a run can end in, and that notify hooks can fire on. */
export type RunEndState = "done" | "failed" | "stopped";

/**
 * What can fire the notify hooks: a terminal state, or — opt-in — "waiting":
 * a checkpoint() starts waiting for a person (once per checkpoint).
 */
export type NotifyTrigger = RunEndState | "waiting";

/**
 * Run-completion hooks (an ODW extension), fired by the worker once a run's
 * terminal state is on disk. They are bounded and can never change the outcome.
 */
export interface NotifySettings {
  /** An argument vector spawned WITHOUT a shell; the run is described in `ODW_*` env vars. */
  command: string[] | null;
  /** An http(s) URL that receives a JSON POST describing the run. */
  webhook: string | null;
  /** What fires the hooks: the three terminal states unless configured; "waiting" only when listed. */
  on: NotifyTrigger[];
}

export interface Config {
  adapters: Record<string, Adapter>;
  settings: Settings;
}

/** The outcome of a single CLI invocation. */
export interface CliResult {
  returncode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Killed by the stall watchdog: no output for the stall timeout. */
  stalled?: boolean;
  /** Wall-clock seconds the process ran. */
  duration: number;
}

/** True when the process exited cleanly and was not killed for time or silence. */
export function cliOk(result: CliResult): boolean {
  return result.returncode === 0 && !result.timedOut && !result.stalled;
}

/** The label to show for an adapter (its `label`, else its name). */
export function adapterDisplayName(adapter: Adapter): string {
  return adapter.label ?? adapter.name;
}
