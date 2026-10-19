/**
 * Configuration model shapes (L1).
 *
 * A {@link Config} is the immutable description of *which* coding-agent CLIs
 * exist ({@link Adapter}) and *how* a run behaves ({@link Settings}). It is
 * loaded once at run start and then only read.
 */

import type { TriggerSettings } from "../triggers.js";
import type { EgressAllow } from "./egress.js";
import type { CostGate } from "../forecast.js";
import type { QuestionPolicy } from "../questions.js";
import type { LimitSpec } from "../limits.js";
import type { AccountOf } from "./accounts.js";
import type { ScriptContext } from "../script-context.js";

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
  /**
   * How this CLI takes a call's JSON Schema to enforce itself (an ODW
   * extension; see adapters/native-schema.ts). Without it the schema is
   * described in the prompt, and only ODW validates the reply.
   */
  schema?: SchemaFlag;
  /**
   * ODW extension (see ../agent-types): how this CLI takes an agent
   * definition's `effort` — the flag(s), an element holding `{effort}` getting
   * the level in place (`["-c", "model_reasoning_effort={effort}"]`), else the
   * level appended (`["--effort"]`). Without it, `effort` is logged as not applied.
   */
  effort?: string[];
  /** The `effort` levels it takes; another is logged as not applied. Unset: any. */
  effortLevels?: string[];
  /**
   * ODW extension: the flag that limits this CLI to a comma-separated list of
   * built-in tools (Claude Code's `--tools`) — an agent definition's `tools`,
   * narrowed with any its tier sets. Without it, `tools` act only as a tier cap.
   */
  tools?: string[];
  /** ODW extension: the flag(s) before tool names to deny (Claude Code's `--disallowedTools`) — a definition's `disallowedTools`. */
  disallowedTools?: string[];
}

/**
 * How a CLI takes a JSON Schema natively (an ODW extension): `args`, then the
 * schema — `inline`, its JSON as the next argv element (Claude Code's
 * `--json-schema`); `file`, the path of a file holding it, written for each
 * CLI run and removed after it (Codex's `--output-schema`). They go after
 * every other argument, as a model flag does.
 */
export interface SchemaFlag {
  args: string[];
  mode: "inline" | "file";
  /**
   * The CLI takes only OpenAI strict-mode schemas (Codex): an object at the
   * root, and every object `"additionalProperties": false` with all its
   * properties `required`. Any other schema goes in the prompt instead.
   */
  strict?: boolean;
  /**
   * The CLI takes only schemas whose root is `"type": "object"` (agy refuses
   * any other at startup). Any other schema goes in the prompt instead.
   */
  objectRoot?: boolean;
}

/**
 * How stdout from an adapter becomes the agent's final response — and, for the
 * JSON formats, what the run spent, whether the CLI itself reported it failed,
 * and what it refused the agent (`usagePath`, `costPath`, `errorPath`,
 * `deniedPath`: ODW extensions). A path is a
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
      /**
       * The key that names each event's type (an ODW extension; default
       * `"type"`). agy's stream-json names it `event`: `{"event":"result",…}`.
       * Every event type below — `eventType`, `usageEvent`, `mcpEvent`,
       * `errorEvents`, `background` rules — is read under it.
       */
      eventKey?: string;
      /**
       * Narrows the text events to those whose value at `path` is `equals`
       * (an ODW extension): Codex prints every finished item as an
       * `item.completed` event, and only an `agent_message` item holds the reply.
       */
      match?: OutputMatch;
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
      /**
       * Events that are the CLI's own report that the run failed, apart from
       * its text events (an ODW extension): event type → the path, in such an
       * event, to its message (`true`, a message or an error object; an event
       * with none there is quoted). Codex's `turn.failed` and `error`. The
       * latest one fails the run, classified like any failure whatever its
       * exit — unless a usage event (`usageEvent`: a turn completed) comes
       * after it, for the CLI went on (Codex prints a stream error it retries
       * as an `error` event).
       */
      errorEvents?: Record<string, string[]>;
      /**
       * Path, in a text event, to the value the CLI validated against a schema
       * it was handed natively (Claude Code's `structured_output`). When the
       * last text event has one (not null), it is the reply's value.
       */
      structuredPath?: string[];
      /**
       * Path, in a text event, to the tool calls the CLI refused the agent
       * (Claude Code's `permission_denials`). What the last text event lists
       * is recorded on the agent, or fails it (`permissionDenials`, `expect`).
       */
      deniedPath?: string[];
      /** The events that list the CLI's MCP servers (Claude Code's `system` init event); unset: any event with a list at `mcpPath`. */
      mcpEvent?: string;
      /**
       * Path, in such an event, to the MCP servers the CLI started the agent
       * with, `{ name, status }` each (Claude Code's `mcp_servers`); the latest
       * list decides. One not "connected" is recorded on the agent and logged,
       * or fails it (`mcpFailures`, `expect.mcp`).
       */
      mcpPath?: string[];
      /**
       * The background work the CLI's events say the agent started, and the
       * events that say it ended (an ODW extension): work still open at the
       * latest text event was orphaned — the CLI ended the agent's turn and
       * exited while it ran, and it died with it (`orphanedBackground`).
       */
      background?: BackgroundRules;
      /**
       * The events that are the agent asking the user a question — a
       * clarifying tool call (an ODW extension; see ../questions): the CLI is
       * stopped at once, and the call's `questions` policy decides what next.
       */
      questions?: QuestionRule[];
      /**
       * Where the CLI's events say which model served the agent (an ODW
       * extension; `output.servedModel`): Claude Code's init event `model`,
       * each assistant message's `message.model`, the result's `modelUsage`
       * keys. Recorded beside the model the call asked for; one that is not
       * it is a substitution (`modelMismatch`). Unset: the CLI reports none.
       */
      servedModel?: ServedModelRule[];
    }
  | {
      /** One JSON document on stdout: the paths are read from it. */
      format: "json";
      textPath: string[];
      usagePath?: string[];
      costPath?: string[];
      errorPath?: string[];
      structuredPath?: string[];
      deniedPath?: string[];
      mcpPath?: string[];
    };

/**
 * How a JSONL adapter's events show background work (an ODW extension;
 * `output.background`): a shell command or subagent the agent started without
 * waiting for it (Claude Code's `run_in_background`), and its end. Work is one
 * piece under any of its ids: a start and an end that share one match up, and
 * two starts that share one (a tool call, then the task it registered) are the
 * same work.
 */
export interface BackgroundRules {
  /** Events that say background work started. */
  started: BackgroundRule[];
  /** Events that say background work ended — finished, failed, or was stopped. */
  ended: BackgroundRule[];
}

/** One kind of event that starts or ends background work (ODW extension; see {@link BackgroundRules}). */
export interface BackgroundRule {
  /** The event's `type`. */
  event: string;
  /**
   * Path to an array in the event whose items are each looked at, instead of
   * the event itself (an assistant message's `message.content` blocks).
   */
  each?: string[];
  /** Conditions the event (or item) must meet, all of them. */
  where?: BackgroundCondition[];
  /** Paths to the work's ids in the event (or item); one of them must hold a string or number. */
  ids: string[][];
  /**
   * A regular expression (its source) the strings at `ids` are searched with:
   * the ids are what its first capture group matches, every time it does (a
   * notification written as text, `<task-id>b1</task-id>`). Unset: the values
   * at `ids` are the ids.
   */
  pattern?: string;
  /** Starts only: paths to what kind of work it is, the first string wins ("Bash", "local_agent"). */
  kind?: string[][];
  /** Starts only: paths to what it does, the first non-empty string wins (its description, its command). */
  about?: string[][];
}

/**
 * One kind of event that is the agent asking the user a question (an ODW
 * extension; `output.questions`): Claude Code's `AskUserQuestion` tool call.
 */
export interface QuestionRule {
  /** The event's `type`. */
  event: string;
  /** Path to an array in the event whose items are each looked at (an assistant message's `message.content` blocks). */
  each?: string[];
  /** Conditions the event (or item) must meet, all of them (a tool_use block named AskUserQuestion). */
  where?: BackgroundCondition[];
  /** Path, in the event (or item), to its list of questions; unset: it is one question. */
  list?: string[];
  /** Paths, in each question, to its text: the first non-empty string wins. */
  text: string[][];
  /** Paths, in each question, to its short heading: the first non-empty string wins. */
  header?: string[][];
  /** Path, in each question, to the answers it offers: strings, or objects with a string at `optionLabel`. */
  options?: string[];
  /** Path, in each option object, to its label (default `["label"]`). */
  optionLabel?: string[];
  /** Path, in each question, to whether more than one option may be chosen. */
  multiSelect?: string[];
}

/**
 * One kind of event that names the model serving the agent (an ODW extension;
 * `output.servedModel`): the string at `path` — or each string of an array
 * there, or with `keys` each key of an object there (Claude Code's
 * `modelUsage`) — is a model id the CLI reports it used.
 */
export interface ServedModelRule {
  /** The event's type (at `eventKey`). */
  event: string;
  /** Conditions the event must meet, all of them (a `system` event whose `subtype` is "init"). */
  where?: BackgroundCondition[];
  /** Path, in the event, to the model id — or ids. */
  path: string[];
  /** The value at `path` is an object whose keys are the model ids. */
  keys?: boolean;
}

/** A condition on a background event (ODW extension): the value at `path` is `equals` (one of them), or is not `not` (none of them). */
export interface BackgroundCondition {
  path: string[];
  equals?: BackgroundScalar | BackgroundScalar[];
  not?: BackgroundScalar | BackgroundScalar[];
}

/** A value a background condition compares with. */
export type BackgroundScalar = string | number | boolean | null;

/** A condition on a JSONL event (ODW extension; `match`): its value at `path` is `equals`. */
export interface OutputMatch {
  path: string[];
  equals: string | number | boolean;
}

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
  /** The model asked for is unknown, retired or not available to the account: not retried, it falls back. */
  model_unavailable?: string[];
}

/**
 * How much an agent may do (an ODW extension), loosest last: `read` — look,
 * never edit or run commands; `edit` — what every built-in did before tiers
 * existed; `full` — no sandbox, no approvals (an explicit opt-in).
 */
export type PermissionTier = "read" | "edit" | "full";

/**
 * The argv flags that put one CLI in each tier, spliced where its command has
 * a `{permission_args}` element (ODW extension). `edit` is required; a tier
 * left out is one the CLI cannot be trusted to enforce headless, so ODW
 * refuses it (`read`) or runs the CLI with its `edit` flags and says so (`full`).
 */
export interface PermissionArgs {
  read?: string[];
  edit: string[];
  full?: string[];
}

/**
 * Whether a run trusts the repository it works in (an ODW extension):
 * `trusted` — its agents read what each CLI reads there (CLAUDE.md, AGENTS.md,
 * hooks, MCP servers, project settings); `untrusted` — each CLI runs in its
 * documented way of ignoring them (`untrustedArgs`), and where it has none the
 * run says so (see adapters/trust.ts).
 */
export type TrustLevel = "trusted" | "untrusted";

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
  /**
   * At most this many agents at once on this CLI, inside the run-wide
   * `concurrency` (an ODW extension); unset, only the run-wide cap applies.
   */
  concurrency?: number;
  /**
   * This CLI's model API caches a prompt's prefix (an ODW extension): a
   * fan-out of its agents whose prompts share one starts staggered, so the
   * rest read what the first wrote (see `staggerFanOut`).
   */
  promptCache?: boolean;
  /** Human-friendly label for progress display. */
  label?: string;
  /** Capability declaration: which per-call options this CLI carries natively. */
  flags?: AdapterFlags;
  /** Response decoding; omitted means trimmed plain text. */
  output?: AdapterOutput;
  /** Extra failure wording for this CLI, matched before the built-in table. */
  failures?: AdapterFailures;
  /** Each tier's flags (ODW extension); without them the CLI runs as configured, treated as `edit`. */
  permissionArgs?: PermissionArgs;
  /** What an agent's question does on this CLI; overrides the `questions` setting (ODW extension; see ../questions). */
  questions?: QuestionPolicy;
  /**
   * The flags that take this CLI's question tool away (ODW extension), added
   * at `{permission_args}` when an agent on it runs under `questions: "deny"`
   * (the built-in claude: `--disallowedTools AskUserQuestion`).
   */
  questionArgs?: string[];
  /** Caps this CLI's tier below the run's (ODW extension): an agent on it gets the lower of the two. */
  permissions?: PermissionTier;
  /** What tool calls this CLI refused do to a reply that claims success; overrides `permissionDenials` (ODW extension). */
  permissionDenials?: DenialPolicy;
  /** `untrusted` runs this CLI untrusted whatever the run's trust (ODW extension); `trusted` cannot loosen an untrusted run. */
  trust?: TrustLevel;
  /**
   * The flags that keep the repository's own instructions, settings, hooks and
   * MCP servers from this CLI (ODW extension), added after its tier's flags at
   * `{permission_args}` when it runs untrusted. Absent: it has none, and an
   * untrusted run says so once.
   */
  untrustedArgs?: string[];
  /** What an untrusted run still lets reach this CLI from the repository, said once per run (ODW extension). */
  untrustedNote?: string;
  /**
   * Run this CLI in a container (ODW extension; see ./sandbox): the fields it
   * sets over the run's `sandbox` — its own image, say. It may turn the
   * container on, never off.
   */
  sandbox?: ContainerSpec;
  /** This CLI's own per-agent limits, over the run's `agentLimits` key by key (ODW extension; see ../limits). */
  agentLimits?: LimitSpec;
  /**
   * The hosts this CLI needs to reach — its model API and login — what a
   * container sandbox's `network: { allow: "adapter" }` lets it reach (ODW
   * extension; see ./egress). The built-in adapters declare theirs.
   */
  egressHosts?: string[];
  /** An account of another adapter (ODW extension; see ./accounts): set on the adapters `accounts` expands into. */
  account?: AccountOf;
}

/**
 * Where a sandboxed agent's container may reach (ODW extension): nowhere, the
 * engine's default network, or only the hosts of an allowlist, through an
 * egress proxy outside its container (see ./egress).
 */
export type SandboxNetwork = "none" | "default" | EgressAllow;

/**
 * What a container gets of its CLI's own config and login (ODW extension):
 * `copy` — the CLI's documented files, copied into a private home removed
 * after the run; `mount-ro` — those files bound read-only; `none` — an empty home.
 */
export type SandboxCliConfig = "copy" | "mount-ro" | "none";

/** A host path bound into a sandbox container (ODW extension). */
export interface SandboxMount {
  /** Absolute host path; it must exist. */
  source: string;
  /** Absolute path in the container; defaults to `source`. */
  target: string;
  /** Read-only unless the config says `"readonly": false`. */
  readonly: boolean;
}

/**
 * Run agent CLIs in a container (an ODW extension; see ./sandbox): each CLI
 * run is `<engine> run --rm -i …` on `image`, with the agent's workspace
 * bound at the same path and nothing else of the host but what is listed.
 */
export interface ContainerSandbox {
  kind: "container";
  /** `null`: docker when it is on PATH, else podman. */
  engine: "docker" | "podman" | null;
  /** The image the CLI runs in; it must hold the CLI, and is never pulled. */
  image: string;
  network: SandboxNetwork;
  mounts: SandboxMount[];
  cliConfig: SandboxCliConfig;
  /** `--memory` (e.g. "4g"); null: the engine's default. */
  memory: string | null;
  /** `--cpus`; null: the engine's default. */
  cpus: number | null;
  /** `--pids-limit`. */
  pids: number;
}

/** The run's sandbox (ODW extension): agents on the host, or in a container. */
export type SandboxSetting = "none" | ContainerSandbox;

/** An adapter's sandbox (ODW extension): the container fields it sets over the run's. */
export type ContainerSpec = { kind: "container" } & Partial<Omit<ContainerSandbox, "kind">>;

/**
 * What a reply that claims success does when its CLI refused the agent tool
 * calls (`deniedPath`; an ODW extension): `"warn"` keeps it — the refused calls
 * are recorded on the agent and logged — and `"fail"` fails the agent with
 * reason "permission". A call with `expect` counts them as a miss either way.
 */
export type DenialPolicy = "warn" | "fail";

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
  /**
   * A command run in an isolated agent's worktree just before it is removed
   * (an ODW extension) — on success, failure and stop alike: as
   * `worktreeSetup`, a string runs through the platform shell, an array is
   * an argv; `null` => none. Its failure is logged, never the agent's.
   */
  worktreeTeardown: string | string[] | null;
  /** Seconds the worktree teardown may run before it is killed. */
  worktreeTeardownTimeout: number;
  /** Where each running agent's `ODW_PORT` comes from: `[first, last]`, inclusive (an ODW extension). */
  portRange: [number, number];
  /**
   * Log a warning when one parallel() or pipeline() call fans out wider than
   * this — more thunks, or more items (an ODW extension); `null` => never.
   */
  fanOutWarn: number | null;
  /**
   * Adaptive back-pressure (an ODW extension): a rate limit halves its
   * adapter's concurrency for the rest of the run, never below 1, and each
   * minute without another gives one slot back; `false` keeps the caps fixed.
   */
  adaptiveConcurrency: boolean;
  /**
   * Staggered fan-outs (an ODW extension), on adapters that declare
   * `promptCache`: in one parallel() or pipeline() call, agents whose prompts
   * share a long prefix start `first` at a time, and the rest once the first
   * has produced output or `delayMs` later, whichever is sooner; `null` => off.
   */
  staggerFanOut: StaggerFanOut | null;
  /**
   * Bytes of an isolated agent's diff kept in the run directory (an ODW
   * extension); past it the head is kept, cut at a line, with a note.
   */
  maxDiffBytes: number;
  /**
   * Commit every isolated agent's change to a branch `odw/<runId>/<agentId>-<label>`
   * of the source repository, as `keep: true` does for one agent (an ODW extension).
   */
  keepBranches: boolean;
  /**
   * A command `odw apply` runs at the repository root after each apply (an
   * ODW extension; `--verify` overrides it, `--no-verify` skips it), through
   * the platform shell and bounded by `timeout`: when it fails, that apply is
   * rolled back. `null` => none.
   */
  applyVerify: string | null;
  /**
   * Bytes of each agent's transcript — what its CLI printed — kept in the run
   * directory (an ODW extension); past it, one truncation line. `0` keeps none.
   */
  maxTranscriptBytes: number;
  /**
   * Record each adapter CLI's version once per run (an ODW extension, for
   * `odw compare`): `<cli> --version` beside the adapter's first agent, killed
   * after 3s, as a `cli_version` event; `false` runs no probe.
   */
  recordVersions: boolean;
  /**
   * Drift watch (an ODW extension; see ../drift): when a run's CLI versions or
   * requested models changed since the workflow's previous run, and the
   * workflow has an eval file (`.odw/evals/<name>.json`), start `odw eval
   * <name> --baseline <last report>` once the run ends, detached. `false`
   * (the default) only suggests it in the run's log.
   */
  driftEval: boolean;
  /**
   * The run's notes board for every agent (an ODW extension; see ../notes):
   * the notes so far in each prompt, `ODW_NOTES` to post and read them, and
   * each isolated agent's interface changes posted as it finishes. Off by
   * default; `agent(…, { notes })` and `parallel(…, { notes })` override it.
   */
  notes: boolean;
  /**
   * Workflow memory for every agent and checkpoint (an ODW extension; see
   * ../memory): what earlier runs learned recalled into each prompt, and
   * corrections and lessons kept. Off by default; `agent(…, { memory })` and
   * `checkpoint(…, { memory })` override it. Kept notes are kept either way.
   */
  memory: boolean;
  /**
   * Where workflow memory lives (an ODW extension): relative to the
   * repository's top, `~` allowed; null: `.odw/memory`. A directory outside
   * the repository is the user's own, which an untrusted run may use.
   */
  memoryDir: string | null;
  /**
   * The run's permission tier (an ODW extension; `odw run --permissions`
   * overrides it): an adapter's `permissions` and an agent()'s `permissions`
   * may only lower it.
   */
  permissions: PermissionTier;
  /**
   * Whether the run trusts the repository it works in (an ODW extension;
   * `odw run --untrusted` overrides it): `untrusted` runs every CLI in its
   * documented way of ignoring the repository's instructions, settings and
   * hooks, and refuses the repository's own worktree setup (see adapters/trust.ts).
   */
  trust: TrustLevel;
  /**
   * The environment agent CLIs start with (an ODW extension): `"inherit"`
   * passes ODW's whole environment; `"minimal"` only the basics a CLI needs,
   * the built-ins' documented auth and config variables, `agentEnvPass`,
   * the adapter's `env` and the `ODW_*` run variables.
   */
  agentEnv: "inherit" | "minimal";
  /** Names or `*` globs of more variables a `"minimal"` agent environment passes through. */
  agentEnvPass: string[];
  /**
   * What happens to JSON Schema in an agent()'s schema that ODW's validator
   * does not check (an ODW extension): `"warn"` — the call runs, ODW checks
   * the rest, and the run logs once which keywords, where, and who enforces
   * them (a CLI that takes schemas natively, else nobody); `"strict"` — the
   * call fails before it starts. A malformed schema fails in either mode.
   */
  schemaKeywords: "warn" | "strict";
  /**
   * When an agent's prompt describes its schema (an ODW extension): `"auto"` —
   * only when the CLI does not take the schema natively; `"always"`.
   */
  schemaPrompt: "auto" | "always";
  /**
   * Fallback chains (an ODW extension): adapter name → the adapters a call on
   * it moves to, in order, when its CLI's quota is spent, its login is
   * refused, or the model it asks for is unavailable. An agent() call that
   * lists its own adapters uses that list instead.
   */
  fallback: Record<string, string[]>;
  /**
   * A fallback hands the work over (an ODW extension; `"fallback": {
   * "handoff": true }` in a config file — `handoff` is a reserved key there;
   * see ../handoff): the next adapter goes on in the same workspace, its
   * prompt starting with a brief of what the last one did. `false`: it starts
   * the work over. An agent()'s `handoff` overrides it.
   */
  handoff: boolean;
  /**
   * Model tiers (an ODW extension): tier name → adapter name → that CLI's
   * model id. `model: "@<tier>"` picks the id for the adapter a call runs on.
   */
  models: Record<string, Record<string, string>>;
  /**
   * The run's quota breaker (an ODW extension): after this many quota
   * failures in a row on one adapter, the run's later calls skip it; `null` => never.
   */
  quotaBreaker: number | null;
  /**
   * How many times an agent whose work missed its `expect` checks is run again,
   * told what it missed, before it fails (an ODW extension; `expectRetries`
   * on one agent() call overrides it).
   */
  expectRetries: number;
  /**
   * A reply that claims success while its CLI refused tool calls (an ODW
   * extension): `"warn"` keeps it, recording and logging the refusals;
   * `"fail"` fails the agent with reason "permission". An adapter's own
   * `permissionDenials` overrides it.
   */
  permissionDenials: DenialPolicy;
  /**
   * An agent whose CLI reports an MCP server that could not start —
   * "failed" or "needs-auth" (an ODW extension; `mcpPath`): `"warn"` keeps its
   * reply, recording the servers on the agent and logging them once per run
   * (as Claude Code itself only warns); `"fail"` fails the agent with reason
   * "mcp_unavailable". Servers a call's `expect.mcp` lists are a miss instead.
   */
  mcpFailures: "warn" | "fail";
  /**
   * An agent whose CLI ended its turn with background work still running —
   * a shell command or subagent it started and never waited for, which died
   * when the CLI exited (an ODW extension; `output.background`): `"warn"`
   * keeps its reply, recording the work on the agent as `orphaned` and logging
   * it once; `"fail"` fails the agent with reason "orphaned_background". A
   * call with `expect` counts it as a miss either way.
   */
  orphanedBackground: "warn" | "fail";
  /**
   * An agent that changed files outside its declared `scope` (an ODW
   * extension; see ../scope): `"warn"` keeps its reply, recording the files on
   * the agent as `outOfScope` and logging them; `"fail"` fails the agent with
   * reason "out_of_scope". An agent()'s `scopePolicy` overrides it; a call
   * with `expect` counts such a write as a miss either way.
   */
  scopePolicy: "warn" | "fail";
  /**
   * What an agent's question does — a clarifying tool call its CLI made
   * (an ODW extension; `output.questions`, see ../questions): `"checkpoint"`
   * asks a person at a checkpoint and runs the call again with the answer;
   * `"fail"` fails it with reason "needs_input"; `"deny"` takes the question
   * tool away (`questionArgs`) and tells the agent to assume. An adapter's
   * and an agent()'s `questions` override it.
   */
  questions: QuestionPolicy;
  /**
   * An agent whose CLI ran a destructive git command — `git reset --hard`,
   * `git checkout .`, `git clean -f`, `git push --force`, `git stash
   * drop|clear`, `git branch -D`, … (an ODW extension; see
   * ../destructive-git): `"warn"` keeps its reply, recording the command as a
   * `destructive_git` event on the agent; `"fail"` fails the agent with
   * reason "destructive_git" once its CLI is done (ODW cannot stop the
   * command before it runs). Commands that only reset a working tree count
   * for in-place agents alone.
   */
  destructiveGit: "warn" | "fail";
  /**
   * An agent whose CLI reported it was served by a model other than the one
   * the call asked it for (an ODW extension; `output.servedModel`, see
   * ../served-model): `"warn"` keeps its reply, recording a `model_substituted`
   * event and logging it; `"fail"` fails the agent with reason
   * "model_substituted". A CLI that reports no model is never a mismatch.
   */
  modelMismatch: "warn" | "fail";
  /**
   * Where a workflow body runs (an ODW extension; see ../script-context):
   * `"host"` in the worker's own context, `"strict"` in a fresh vm context
   * with only the primitives and standard built-ins — no `process`,
   * `require`, `import()`, `fetch`. Null (the default): strict for a run a
   * trigger started, a Claude Code plugin's workflow, and a run whose input
   * or repository is untrusted; host for the rest. A run's worker sets it to
   * the context it chose. `vm` is not a security boundary.
   */
  scriptContext: ScriptContext | null;
  /**
   * What odw keeps and serves of its agents — transcripts, saved results,
   * events, the run's error and result, webhook payloads — has its likely
   * secrets replaced by `«redacted:<kind>»` (an ODW extension; see ../redact);
   * `false` keeps it all as printed.
   */
  redact: RedactSettings | false;
  /**
   * Pause for a spent quota (an ODW extension): a call whose fallback chain is
   * out of usage quota waits for the quota to reset — when its CLI said when,
   * at most `max` seconds away — instead of failing; `false` fails it.
   */
  quotaWait: QuotaWaitSettings | false;
  /**
   * OpenTelemetry export (an ODW extension; see ../runtime/otel-export): the
   * worker posts each run's trace once it ended; `false` (the default) sends
   * nothing — the OTEL_* variables alone never turn it on.
   */
  otel: OtelSettings | false;
  /**
   * Where agent CLIs run (an ODW extension; `odw run --sandbox container`
   * turns it on; see ./sandbox): `"none"` — on this machine, as you; a
   * container — each CLI run in a fresh container of `image`, and `exec()`
   * steps too (offline by default). An adapter's and an agent()'s `sandbox`
   * may only tighten it.
   */
  sandbox: SandboxSetting;
  /**
   * What one agent may do before it is killed as a runaway (an ODW extension;
   * see ../limits): tool calls, dollars, output tokens, seconds, and the same
   * tool call in a row. An adapter's `agentLimits` and an agent()'s `limits`
   * override it key by key; `{}` sets none.
   */
  agentLimits: LimitSpec;
  /**
   * Signed one-time approve/reject links for a waiting checkpoint() (an ODW
   * extension; see ../runtime/approve-links): minted into the `waiting`
   * notify hooks while an `odw serve --public-url` runs, each valid `ttl`
   * seconds.
   */
  approveLinks: ApproveLinksSettings;
  /**
   * Signed inbound triggers (an ODW extension; see ../triggers): what `odw
   * serve` starts at `POST /api/triggers/<name>`. `{}` sets none.
   */
  triggers: Record<string, TriggerSettings>;
  /**
   * A cost gate on every parallel() and pipeline() (an ODW extension; see
   * ../forecast): `{ usd }` — a fan-out whose forecast, from earlier runs of
   * the workflow, is over `usd` dollars waits at a checkpoint for a person's
   * go. `null`: none.
   */
  costGate: CostGate | null;
  /**
   * Runs with untrusted input (an ODW extension; see ../untrusted-input):
   * `requireSandbox: true` refuses to start one unless its agents run in a
   * container whose network is an allowlist or none.
   */
  untrustedInput: UntrustedInputSettings;
  /**
   * What `odw gc` keeps (an ODW extension; see ../runtime/gc): an ended run
   * older than `days` has its keep branches deleted and — unless
   * `transcripts` is false — its transcripts and stderr trimmed; `odw gc
   * --older-than` overrides `days`. Nothing is deleted without `odw gc --yes`.
   */
  retention: RetentionSettings;
  /**
   * The cross-run digest (an ODW extension; see ../runtime/digest): `{ cron }`
   * is when `odw schedule add <name> --digest` runs `odw digest --since-last
   * --notify` unless `--cron` says otherwise. `null`: no default time.
   */
  digest: DigestSettings | null;
}

/** When the scheduled digest goes out (see `Settings.digest`). */
export interface DigestSettings {
  /** A five-field cron expression, local time. */
  cron: string;
}

/** How runs with untrusted input are held (see `Settings.untrustedInput`). */
export interface UntrustedInputSettings {
  /** Refuse to start a run with untrusted input unless agents run in a container with an allowlist (or no) network. */
  requireSandbox: boolean;
}

/** What `odw gc` keeps (see `Settings.retention`). */
export interface RetentionSettings {
  /** Days after an ended run's last activity before gc reclaims what it left. */
  days: number;
  /** Whether gc trims an expired run's transcripts and stderr (meta, status, events and results always stay). */
  transcripts: boolean;
}

/** How approve links are minted (see `Settings.approveLinks`). */
export interface ApproveLinksSettings {
  /** Seconds a link stays valid after it is minted. */
  ttl: number;
}

/** Where and how a run's trace is exported (see `Settings.otel`). */
export interface OtelSettings {
  /**
   * The OTLP/HTTP base URL, as OTEL_EXPORTER_OTLP_ENDPOINT takes it
   * (`/v1/traces` is appended); null: the OTEL_EXPORTER_OTLP_* variables, else
   * http://localhost:4318.
   */
  endpoint: string | null;
  /** Headers sent with each export, over OTEL_EXPORTER_OTLP_HEADERS: secrets, never logged or shown. */
  headers: Record<string, string>;
  /** Export what agents replied and their tools' input and output too — redacted and cut. */
  captureContent: boolean;
}

/** What redaction looks for (see `Settings.redact`). */
export interface RedactSettings {
  /**
   * The values (8 characters or more) of the secret-named variables of the
   * environment odw starts agents and commands with, wherever they appear —
   * and of any `NAME=value` of such a name printed.
   */
  env: boolean;
  /** Well-known token shapes: API keys, access tokens, JWTs, private-key blocks, `Bearer` tokens. */
  patterns: boolean;
  /** More regular expressions (JavaScript sources) whose matches are secrets. */
  extra: readonly string[];
}

/** How long a run waits for a spent quota to reset (see `Settings.quotaWait`). */
export interface QuotaWaitSettings {
  /** The longest wait, in seconds: a quota that resets later fails its calls as before. */
  max: number;
}

/** How a fan-out on a prompt-caching adapter is staggered (see `Settings.staggerFanOut`). */
export interface StaggerFanOut {
  /** How many of its agents start at once, before the rest wait. */
  first: number;
  /** The longest the rest wait for the first one's output, in milliseconds. */
  delayMs: number;
}

/** The terminal states a run can end in, and that notify hooks can fire on. */
export type RunEndState = "done" | "failed" | "stopped";

/**
 * What can fire the notify hooks: a terminal state, or — opt-in — "waiting":
 * a checkpoint() starts waiting for a person (once per checkpoint), or
 * "paused": the run pauses for an adapter's spent quota (once per pause), or
 * "digest": `odw digest --notify` sends the cross-run digest (ODW extension).
 */
export type NotifyTrigger = RunEndState | "waiting" | "paused" | "digest";

/**
 * Run-completion hooks (an ODW extension), fired by the worker once a run's
 * terminal state is on disk. They are bounded and can never change the outcome.
 */
export interface NotifySettings {
  /** An argument vector spawned WITHOUT a shell; the run is described in `ODW_*` env vars. */
  command: string[] | null;
  /** An http(s) URL that receives a JSON POST describing the run. */
  webhook: string | null;
  /** What fires the hooks: the three terminal states unless configured; "waiting", "paused" and "digest" only when listed. */
  on: NotifyTrigger[];
}

export interface Config {
  adapters: Record<string, Adapter>;
  settings: Settings;
  /**
   * Account pools (an ODW extension; see ./accounts): adapter name → its
   * accounts' adapter names (`claude@work`, …), in config order. A call on
   * the adapter runs on any of them. Absent: none.
   */
  accounts?: Record<string, string[]>;
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
