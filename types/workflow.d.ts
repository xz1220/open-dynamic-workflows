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
 * scripts run as trusted JavaScript, without a sandbox. Each completed agent()
 * result is saved with its run, and `odw resume` replays the unchanged calls of
 * an ended run instead of running them again (an ODW CLI extension).
 */

export {};

declare global {
  /**
   * ODW's JSON Schema subset. A keyword outside it is named in the run's log
   * (the config's `schemaKeywords: "strict"` fails the call instead), and a
   * CLI that validates schemas itself enforces it. See the primitive reference.
   */
  type JsonSchema = Record<string, unknown>;

  interface AgentOptions {
    /**
     * Which configured adapter/CLI to use; falls back to the phase's default, then the run's.
     * ODW extension — Claude Code ignores it: a list such as `["codex", "claude"]` is a
     * fallback chain, in order of preference — when an adapter's quota is spent or its login
     * refused, the call runs again on the next one (fresh prompt, same options, same
     * permission tier), in place of the `fallback` setting's chain.
     */
    adapter?: string | string[];
    /**
     * When set, the reply is checked against ODW's schema subset and returned as
     * a JSON value. A CLI that validates schemas (claude, codex) is also handed it
     * natively (an ODW extension).
     */
    schema?: JsonSchema;
    /** Short label for progress display. */
    label?: string;
    /** Override the current phase for this one call (use inside parallel/pipeline). */
    phase?: string;
    /**
     * CLI-specific model id via `{model}` or flags.model; otherwise ignored with a routing note.
     * ODW extension: `"@fast"` names a tier of the `models` setting — each adapter's own model
     * id for it, picked for the adapter the call runs on (after a fallback, the next one's); an
     * unknown tier fails the call. A `meta.phases` entry's `model` (or `phase(title, { model })`)
     * is the default for the phase's agents; `meta.model` is metadata only.
     */
    model?: string;
    /** Prompt persona, not an adapter name or a loader for Claude roles, tools, permissions, or project subagent definitions. */
    agentType?: string;
    /** Throwaway git worktree at HEAD (needs a committed repo; no uncommitted edits). Cleaned up without merging; agent() does not return its diff, but the run keeps it (`odw diff`, `odw apply`). */
    isolation?: "worktree";
    /**
     * ODW extension — Claude Code ignores it. With `isolation: "worktree"`, also commit the
     * agent's change to a branch `odw/<runId>/<agentId>-<label>` of the source repository
     * (HEAD and the index are never touched); `false` opts out of the `keepBranches` setting.
     */
    keep?: boolean;
    /**
     * ODW extension — Claude Code ignores it. Run this agent at a stricter permission tier
     * than the run's: `"read"` (no edits, no commands) for research and review fan-outs. It
     * may only lower the run's tier (read < edit < full); asking for more fails the call, as
     * does `"read"` on a CLI with no read-only mode.
     */
    permissions?: "read" | "edit" | "full";
    /**
     * ODW extension — Claude Code ignores it. What must hold once the agent replied (after
     * `schema` validation), checked by ODW instead of asking the model; tool calls its CLI
     * refused count as a miss too. Work that misses runs again, on the same adapter, with what
     * it missed appended to its prompt (`expectRetries`), then the call throws (recoverable)
     * with `misses` and reason `"unmet_expectation"` — `"permission"` when refused calls are
     * among them. A call that falls back to another adapter keeps its checks. Without it, MCP
     * servers its CLI started it without are recorded and logged; `"mcpFailures": "fail"`
     * makes one that failed or needs authentication throw with reason `"mcp_unavailable"`.
     */
    expect?: ExpectOptions;
    /** ODW extension: how many times work that missed `expect` runs again (default: the `expectRetries` setting, 1). */
    expectRetries?: number;
    /** ODW extension: accept an empty or whitespace-only reply; without it the call throws with reason `"empty_reply"`. */
    allowEmpty?: boolean;
  }

  /** What {@link AgentOptions.expect} checks (ODW extension). */
  interface ExpectOptions {
    /**
     * `true`: the agent must change some file; `false`: it must change none. Read from git: in
     * place, against the source tree as it was before the agent started (edits a concurrent
     * in-place agent makes count too); with isolation, the change its worktree leaves.
     */
    changes?: boolean;
    /** Globs (`*`, `**`, `?`, `[…]`, `{a,b}`) relative to the agent's workspace: each must match a file it changed or created. */
    files?: string[];
    /** Must exit 0 in the agent's workspace: a string through the shell, an array as argv. Runs as a command step under the agent; a stop kills it. */
    command?: string | string[];
    /** A regular expression (its source, no flags) the reply must match. */
    match?: string;
    /**
     * MCP servers, by name, the agent's CLI must have started it with: each must be listed in
     * the CLI's report (Claude Code's init event) as "connected" — or "pending", still
     * connecting — else it is a miss ("failed", "needs-auth", "disabled", not configured).
     * Needs an adapter that reports its MCP servers (`output.mcpPath`; the built-in claude does).
     */
    mcp?: string[];
    /** Seconds `command` may run before it is killed, which is a miss (default 600). */
    timeout?: number;
  }

  interface Budget {
    /** Output-token dispatch target, or null; not a billing ceiling. */
    total: number | null;
    /** Output tokens spent, shared with children: the CLI's count where it reports usage (built-in claude does), else ceil(reply characters / 4); every attempt counts. */
    spent(): number;
    /** `max(0, total - spent())`, or Infinity if no target. */
    remaining(): number;
  }

  /** The workflow's input value, injected verbatim. */
  const args: unknown;

  /**
   * Run one coding agent; returns reply text or a validated JSON value, not a worktree diff.
   * Saved as soon as it completes; under `odw resume`, a call with the same prompt and
   * options as written (phase, and the defaults a phase gives, aside) returns its saved value
   * instead of running again — without walking a fallback chain. What an isolated
   * agent changed is kept with the run as a diff to review and apply (ODW extension).
   */
  function agent(prompt: string, opts?: AgentOptions): Promise<any>;

  /** Ordered barrier: recoverable failures become null; fatal stop/budget/dispatch-cap/configuration errors propagate after all thunks settle. */
  function parallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>>;

  /** Run each item through stages independently; recoverable failures drop that item to null, fatal errors propagate. */
  function pipeline(
    items: any[],
    ...stages: Array<(previous: any, item: any, index: number) => any>
  ): Promise<any[]>;

  /** Defaults a phase gives its agents (ODW extension — Claude Code ignores them). */
  interface PhaseOptions {
    /** The adapter, or fallback chain, of the phase's agents that name none. */
    adapter?: string | string[];
    /** The model (or `"@tier"`) of the phase's agents that name none. */
    model?: string;
  }

  /**
   * Start a new named phase for progress grouping. ODW extension: `opts` gives the phase's
   * agents an adapter and a model, in place of its `meta.phases` entry's (`{ title, adapter?,
   * model? }`); an option an agent() call sets always wins.
   */
  function phase(title: string, opts?: PhaseOptions): void;

  /** Emit a one-line progress message. */
  function log(message: unknown): void;

  /** Output-token budget; checked before each dispatch and schema retry — once spent, the run ends and running agents are stopped. */
  const budget: Budget;

  /** Inline child sharing scheduler, controls, and budget; only one level. scriptPath is relative to the run source. */
  function workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<any>;

  /** Options for {@link exec} (ODW extension). */
  interface ExecOptions {
    /** Working directory; a relative path resolves against the run's source directory, which is also the default. */
    cwd?: string;
    /** Extra environment variables, layered over the worker's environment. */
    env?: Record<string, string>;
    /** Seconds before the command and every process it started are killed (default 600); the result then has `timedOut`. */
    timeout?: number;
    /** Text written to the command's stdin; without it, stdin is closed at once. */
    input?: string;
    /** Bytes kept per stream, stdout and stderr each (default 8 MiB); the rest is dropped and `truncated` is set. Never fatal. */
    maxOutputBytes?: number;
    /** Short label for progress display; defaults to the first 40 characters of the command. */
    label?: string;
    /** Override the current phase for this one step (use inside parallel/pipeline). */
    phase?: string;
    /** Throw an `ExecError` (recoverable, carrying `.result`) unless the command exits 0. */
    check?: boolean;
  }

  /** What {@link exec} resolves to. */
  interface ExecResult {
    stdout: string;
    stderr: string;
    /** The exit status; null when a signal ended the command (a timeout kill included). 127/126: it could not be launched. */
    exitCode: number | null;
    /** The signal that ended the command (e.g. "SIGKILL" after a timeout), else null. */
    signal: string | null;
    timedOut: boolean;
    /** stdout or stderr went over `maxOutputBytes` and was cut. */
    truncated: boolean;
    durationMs: number;
  }

  /**
   * ODW extension — not portable to Claude Code, whose Workflow tool has no such
   * global. Runs a command without launching a model: a string through the
   * platform shell (`/bin/sh -c`, or `cmd.exe /d /s /c` on Windows), an array
   * as argv with no shell. Asynchronous; a non-zero exit is a result, not an
   * error, unless `check` is set. Takes no agent slot and does not count toward
   * maxAgents or the budget, but waits while the run is paused, and a stop kills
   * it with every process it started. A script's own `exec` binding takes
   * precedence over this one.
   */
  function exec(command: string | string[], opts?: ExecOptions): Promise<ExecResult>;

  /** Options for {@link checkpoint} (ODW extension). */
  interface CheckpointOptions {
    /** What the person should look at (a plan, a summary of the changes): any JSON value, kept up to 64 KiB. */
    payload?: unknown;
    /**
     * A JSON Schema an approver's edited payload must match (ODW's validator, as for agent()):
     * `odw approve` and the dashboard refuse an edit that does not, and so does the run.
     * Without one, any JSON value of at most 256 KiB is taken.
     */
    schema?: Record<string, unknown>;
    /** Seconds to wait for an answer; no limit by default. */
    timeout?: number;
    /** What a timeout means: approve, reject, or (the default) "fail" — throw a recoverable `CheckpointTimeout`. */
    onTimeout?: "approve" | "reject" | "fail";
  }

  /** What {@link checkpoint} resolves to. */
  interface CheckpointResult {
    approved: boolean;
    /** The note given with the answer, or null. */
    note: string | null;
    /** Who answered: `odw approve|reject`, the dashboard (`odw serve`), or the timeout. */
    by: "cli" | "dashboard" | "timeout";
    /**
     * What was approved: the approver's edit (`odw approve --edit|--payload`, or the
     * dashboard) when there is one, else the checkpoint's own payload — undefined when it
     * had none. A rejection and a timeout carry the checkpoint's own.
     */
    payload: unknown;
    /** The approval came with an edited payload that differs (as JSON) from the checkpoint's own. */
    edited: boolean;
  }

  /**
   * ODW extension — not portable to Claude Code, whose workflows take no
   * mid-run input. Pauses the run until a person approves or rejects (`odw
   * approve|reject <run> [--note TEXT] [--checkpoint N]`, or the dashboard);
   * meanwhile the run shows as "waiting". A rejection resolves too — branch on
   * `approved`; an approval may come with an edited payload (`payload`, `edited`).
   * Takes no agent slot and counts toward neither maxAgents nor the
   * budget; a stop ends the wait and the run. `odw resume` asks it again. A
   * script's own `checkpoint` binding takes precedence over this one.
   */
  function checkpoint(title: string, opts?: CheckpointOptions): Promise<CheckpointResult>;

  /** ODW extension: parses meta as a pure literal (never evaluated) and compile-checks the body without running it. Warnings are advisory; a script's own validate binding takes precedence. */
  function validate(source: string): {
    ok: boolean;
    meta?: {
      name: string;
      description: string;
      whenToUse?: string;
      phases?: Array<{ title: string; detail?: string; model?: string; adapter?: string | string[] }>;
      model?: string;
    };
    errors: string[];
    warnings: string[];
  };
}
