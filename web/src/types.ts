/** Wire types — kept in lockstep with src/runtime/{runs-view,workflows-view}.ts. */

export type RunDisplayState =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "stale"
  /** Paused at a checkpoint() until someone approves or rejects it. */
  | "waiting";

/** `waiting` and `stopped` only occur on checkpoint() nodes the client folds in (checkpoints.ts). */
export type AgentState = "running" | "done" | "failed" | "stale" | "waiting" | "stopped";

/** Tallies over every graph node: `agents` includes exec() command steps. */
export interface RunCounts {
  agents: number;
  running: number;
  done: number;
  failed: number;
  stale: number;
}

export interface RunSummary {
  runId: string;
  /** Which engine produced this run: ODW's own RunStore, or Claude Code's. */
  provider: "odw" | "claude";
  state: RunDisplayState;
  rawState: string;
  stale: boolean;
  name: string;
  description: string | null;
  phases: Array<{ title: string }>;
  source: string | null;
  pid: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  counts: RunCounts;
  progress: number;
  lastActivityTs: number | null;
  /** Token/cost totals when adapters report them (`estimated` when some only had chars/4). */
  usage?: UsageTotals | null;
  /** The oldest checkpoint() waiting for a person, while the run is `waiting`. */
  waiting?: { checkpointId: number; title: string; since: number } | null;
  /**
   * While the run is `paused` because its agents wait for an adapter's spent
   * quota to reset (ODW extension: quotaWait): which adapter, and when the run
   * goes on (epoch seconds) — "paused until 19:10 (codex quota)". Null otherwise.
   */
  pausedFor?: { reason: "quota"; adapter: string; resumeAt: number } | null;
  /** A shared bundle opened by `odw serve --open FILE.odwrun` (ODW extension): when it was bundled. */
  bundle?: { bundledAt: number | null; odwVersion: string | null };
  /** A run `odw eval` started (meta.origin "eval"; ODW extension); absent for every other run. */
  eval?: EvalRunTag;
  /** A dry run (`odw run --dry`; ODW extension): every agent got a stub reply, no model was called. Absent otherwise. */
  dry?: true;
  /**
   * What changed under the workflow since its previous run (ODW extension:
   * drift watch): the run compared with, and each CLI version or requested
   * model that differs. Absent when nothing did.
   */
  drift?: RunDrift;
}

/** One thing that changed since a workflow's previous run (ODW extension: drift watch). */
export interface DriftChange {
  /** An adapter CLI's version (`cli`), or the model an agent label asked for on its adapter (`model`). */
  kind: "cli" | "model";
  adapter: string;
  /** The agent label whose model changed (kind "model"). */
  label?: string;
  /** What the previous run had, and what this one has; null: the CLI's default model. */
  from: string | null;
  to: string | null;
}

/** A run's drift: the run it is compared with, and what changed. */
export interface RunDrift {
  since: string;
  changes: DriftChange[];
}

/** Which `odw eval` run this is: the eval's name, the case, the cell's adapter, the repeat (from 1). */
export interface EvalRunTag {
  name: string;
  case: string;
  adapter: string;
  repeat: number;
}

/**
 * Normalized usage, as adapters report it (src/adapters/usage.ts): `inputTokens`
 * counts every input token, cached or not; the cache fields say how many of them
 * the prompt cache served or stored.
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** `outputTokens` is (partly) a chars/4 estimate: the CLI reported no output tokens. */
  estimated?: boolean;
}

export interface UsageTotals extends Usage {
  estimated?: boolean;
}

/** A checkpoint() waiting for a decision. */
export interface PendingCheckpoint {
  checkpointId: number;
  title: string;
  payload?: unknown;
  /** The payload was cut to 64 KiB for its event: only its start, as text — not something to edit. */
  truncated?: boolean;
  /** The JSON Schema an edited payload must match (ODW extension); the server checks it too. */
  schema?: Record<string, unknown> | null;
  since: number;
}

export interface AgentView {
  /** Stable per-dispatch id from the engine (null for pre-agentId event files). */
  agentId?: number | null;
  /** The value was replayed from an earlier run by `odw resume`. */
  cached?: boolean;
  /** `exec()` steps fold into the same list as agents, and the client adds checkpoint() gates (ODW extensions). */
  kind?: "agent" | "command" | "checkpoint";
  /** A checkpoint node's id, its payload and the person's answer once given. */
  checkpointId?: number | null;
  payload?: unknown;
  decision?: { approved: boolean; note: string | null; by: string | null } | null;
  /** A checkpoint approved with an edited payload (ODW extension): `approvedPayload` is what was approved. */
  edited?: boolean;
  /** With `edited`: the approved payload, as its event keeps it (JSON-safe, cut to 64 KiB). */
  approvedPayload?: unknown;
  /** A command step's per-run id (its `agentId` is null). */
  commandId?: number | null;
  /** A command step's exit code once it settled. */
  exitCode?: number | null;
  /** A command step that is an agent's `expect.command` check: that agent's id (ODW extension). */
  forAgentId?: number;
  /** Why an agent failed: rate_limit, quota, auth, timeout, stalled, not_found, permission, exit, empty_reply, unmet_expectation, mcp_unavailable, runaway, orphaned_background, out_of_scope. */
  failureReason?: string | null;
  /** With `unmet_expectation`: the `expect` checks its work did not meet, one line each (ODW extension). */
  misses?: string[];
  /** A finished agent's tool calls its CLI refused (its reply stood anyway), one line each (ODW extension). */
  denied?: string[];
  /** A finished agent's background work its CLI left running when it replied, which died with it (its reply stood anyway), one line each (ODW extension). */
  orphaned?: string[];
  /** The files it declared it means to change — agent(…, { scope }) globs (ODW extension; src/scope.ts). */
  scope?: string[];
  /** The files it changed outside its scope, finished or failed (ODW extension). */
  outOfScope?: string[];
  /** What the adapter reported spending on this agent. */
  usage?: Usage | null;
  /** What an isolated (worktree) agent changed; its diff is served separately. */
  changes?: AgentChanges | null;
  /** The branch its changes were kept on (`keep: true`), when any. */
  branch?: string | null;
  /** The permission tier its CLI runs at (ODW extension); absent for older runs. */
  permissions?: PermissionTier | null;
  /**
   * `untrusted` when its CLI ran in its way of ignoring the repository's
   * instructions, settings and hooks (ODW extension); absent: trusted.
   */
  trust?: TrustLevel;
  /**
   * The container its CLI ran in — engine, image, network — when the run,
   * its adapter or the call put it in one (ODW extension); absent: on the host.
   */
  sandbox?: AgentSandbox;
  /**
   * The limits it ran under (ODW extension; `agent(…, { limits })`,
   * `agentLimits`) and, with reason `runaway`, `hit`: the one it ran into,
   * what it reached and the evidence. Absent: no limits.
   */
  limits?: AgentLimits;
  /**
   * The adapters it fell back from, in order — their quota was spent or their
   * login refused — before `adapter` (ODW extension). Absent when it never
   * left the adapter it started on.
   */
  fellBackFrom?: string[] | null;
  /** ODW extension (quotaWait): a running agent waiting for `adapter`'s spent quota to reset, holding no slot; when it resets. */
  quotaWait?: { adapter: string; resumeAt?: number };
  /** ODW extension: the MCP servers its CLI started it without (any status but "connected": failed, needs-auth, pending, disabled), for the drawer. */
  mcp?: Array<{ name: string; status: string }> | null;
  label: string;
  phase: string | null;
  state: AgentState;
  /** The adapter it runs on — after a fallback, the one it moved to; once settled, the one that produced its value (or failed last). */
  adapter: string | null;
  attempts: number | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
}

/** One `odw schedule` entry as `GET /api/schedules` serves it (ODW extension). */
export interface ScheduleView {
  name: string;
  workflow: string;
  cron: string;
  backend: "cron" | "launchd" | "systemd";
  cwd: string;
  /** The OS entry is in place; null when that cannot be told. */
  installed: boolean | null;
  lastRun: { runId: string | null; state: string; at: string } | null;
  /** Local ISO time of the next fire, or null when the expression never fires. */
  nextRun: string | null;
}

/** How much an agent may do (ODW extension): read < edit < full. */
export type PermissionTier = "read" | "edit" | "full";

/** Whether an agent's CLI trusted the repository it worked in (ODW extension; `odw run --untrusted`). */
export type TrustLevel = "trusted" | "untrusted";

/** What one agent may do before it is killed as a runaway, and the limit it ran into (ODW extension). */
export interface AgentLimits {
  toolCalls?: number;
  costUsd?: number;
  outputTokens?: number;
  seconds?: number;
  repeat?: number;
  hit?: {
    limit: "toolCalls" | "costUsd" | "outputTokens" | "seconds" | "repeat";
    max: number;
    value: number;
    /** "Bash `npm test` ×5 in a row", "41 tool calls > 40". */
    evidence: string;
  };
}

/** The container an agent's CLI ran in (ODW extension; `odw run --sandbox container`). */
export interface AgentSandbox {
  kind: "container";
  /** null: no engine was found when it started. */
  engine: "docker" | "podman" | null;
  image: string;
  /** "none": no network at all; "default": the engine's default network; "allowlist": only `allow`'s hosts, through the run's egress proxy. */
  network: "none" | "default" | "allowlist";
  allow?: string[];
}

/** A link between a run and the resolver run `odw apply --resolve` started for one of its agents (ODW extension). */
export interface ResolveLink {
  runId: string;
  agentId: number;
}

/** The diffstat of a worktree agent's changes (ODW extension). */
export interface AgentChanges {
  files: number;
  insertions: number;
  deletions: number;
  /** The stored diff was cut at the size cap. */
  truncated?: boolean;
}

export interface RunDetail extends RunSummary {
  script: string | null;
  args: unknown;
  /** Token shapes in `args` were replaced by `«redacted:<kind>»` before it was served (ODW extension); `odw rerun` still uses the originals. */
  argsRedacted?: boolean;
  agents: AgentView[];
  phaseOrder: string[];
  hasResult: boolean;
  /** `redacted`: secrets its message quoted were replaced by `«redacted:<kind>»` (ODW extension). */
  error: { error?: string; stack?: string; redacted?: boolean } | null;
  /** Where the run was initiated from, when recorded by the launcher. */
  origin: string | null;
  /** Run-level adapter override recorded at start, if any. */
  adapter: string | null;
  /** The workflow identity recorded at create time (meta.workflowName). */
  workflowName: string | null;
  /** checkpoint() calls waiting for approval (ODW extension). */
  pendingCheckpoints?: PendingCheckpoint[];
  /** This run resolved a conflict of that run's agent (`odw apply --resolve`; ODW extension). */
  applyResolve?: ResolveLink;
  /** The resolver runs `odw apply --resolve` started for this run's agents. */
  resolvedBy?: ResolveLink[];
  /** Each adapter CLI's version as the run recorded it on its first dispatch, by adapter (ODW extension). */
  cliVersions?: Record<string, CliVersion>;
  /** odw's version, and the sha256 of the workflow source as launched; null for older runs (ODW extension). */
  odwVersion?: string | null;
  sourceHash?: string | null;
}

/** An adapter CLI's `--version` as a run recorded it: null, with why, when the CLI did not tell (ODW extension). */
export interface CliVersion {
  /** The executable probed: the adapter command's first argv element. */
  command: string;
  version: string | null;
  error?: string;
}

/**
 * GET /api/compare?a=<run>&b=<run> — what changed from run A to run B (ODW
 * extension; src/runtime/compare.ts documents every key). 400 unless both are
 * run ids, 404 when either is no ODW run.
 */
export interface RunComparison {
  /** 1; it changes when a key changes meaning. */
  version: 1;
  a: CompareRunInfo;
  b: CompareRunInfo;
  /** How to read it, a sentence each: a run still going (compared as it stands), a run without a recorded setup, different workflows. */
  notes: string[];
  /** What the runs ran with that differs. */
  setup: SetupChange[];
  totals: CompareTotals;
  /** A row per agent of either run, in A's phase and call order (B's new phases in place). */
  agents: AgentComparison[];
}

export interface CompareRunInfo {
  runId: string;
  name: string;
  workflowName: string | null;
  /** Display state: done, failed, stopped, running, paused, waiting, stale, pending. */
  state: string;
  /** Still going: compared as it stands. */
  live: boolean;
  createdAt: number | null;
  odwVersion: string | null;
  sourceHash: string | null;
  resumedFrom: string | null;
}

/**
 * `field`: "source" (sha256), "script", "args", "odwVersion", "budget",
 * "cliVersion.<adapter>", "settings.<key>", "adapterDefinition.<adapter>" (a
 * 12-hex fingerprint), "adapter" / "permissions" (runs without a recorded
 * setup), "adaptersUsed", "modelsUsed" (sorted lists). `a`/`b`: as recorded; null: unknown or unset.
 */
export interface SetupChange {
  field: string;
  a: unknown;
  b: unknown;
}

/** One figure of both runs, and B − A (null when either is unknown). */
export interface CompareMetric {
  a: number | null;
  b: number | null;
  delta: number | null;
}

export interface CompareTotals {
  wallMs: CompareMetric;
  inputTokens: CompareMetric;
  outputTokens: CompareMetric;
  costUsd: CompareMetric;
  agents: CompareMetric;
  done: CompareMetric;
  failed: CompareMetric;
  /** Some output tokens of the run are chars/4 estimates. */
  estimated: { a: boolean; b: boolean };
}

export interface CompareAgentFacts {
  agentId: number | null;
  label: string;
  phase: string | null;
  state: "running" | "done" | "failed" | "stale";
  adapter: string | null;
  /** The model it asked for: a tier keeps its `@` name. */
  model: string | null;
  attempts: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  estimated: boolean;
  /** Replayed by `odw resume`: no CLI ran. */
  replayed: boolean;
  failureReason: string | null;
  error: string | null;
  /** Its kept diff's stats; null when it kept none. */
  changes: AgentChanges | null;
}

export interface AgentComparison {
  /** How A's and B's agents were paired; null when one run has it only. */
  match: "label" | "key" | "order" | null;
  /** Red: "newly-failed"; green: "fixed". */
  outcome: "unchanged" | "newly-failed" | "fixed" | "only-a" | "only-b";
  label: string;
  phase: string | null;
  a: CompareAgentFacts | null;
  b: CompareAgentFacts | null;
  /** B − A; null when either is unknown. */
  delta: {
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    attempts: number | null;
  };
  reply: ReplyComparison;
}

export interface ReplyComparison {
  /** "none": a side has no saved reply (failed, still running, not in that run). */
  status: "identical" | "differs" | "none";
  kind: "text" | "json" | null;
  /** text: unified-diff lines (`@@` headers, ` `/`-`/`+` lines), at most 40, each cut to 200 characters. */
  diff?: string[];
  /** text: lines added and removed over the whole reply. */
  added?: number;
  removed?: number;
  /** json: the paths that differ, at most 20; values as compact JSON cut to 200 characters. */
  paths?: Array<{ path: string; op: "changed" | "added" | "removed"; a?: string; b?: string }>;
  /** json: how many paths differ in all. */
  changed?: number;
  /** Cut: `odw compare <a> <b> --agent <label|id>` shows it whole. */
  truncated: boolean;
}

/** The median and 90th percentile of some samples, and how many there were (nearest rank). */
export interface EstimateSpread {
  p50: number;
  p90: number;
  n: number;
}

/** A run's, a phase's or an adapter's figures across earlier runs; null where none had one. */
export interface EstimateFigures {
  wallMs: EstimateSpread | null;
  costUsd: EstimateSpread | null;
  inputTokens: EstimateSpread | null;
  outputTokens: EstimateSpread | null;
  /** Agents it started per run. */
  agents: EstimateSpread | null;
}

export interface PhaseEstimate extends EstimateFigures {
  /** null: agents started before any phase(). */
  phase: string | null;
  /** How many of the runs had agents in it. */
  runs: number;
}

export interface AdapterEstimate extends EstimateFigures {
  adapter: string;
  runs: number;
}

/**
 * GET /api/estimate?workflow=<name>[&sourceHash=<sha256>] — what a run of a
 * workflow is likely to cost and take, from its last finished runs (ODW
 * extension; src/runtime/estimate.ts documents every key). Without history
 * `match` is null, `total` null, and the one note says so.
 */
export interface WorkflowEstimate {
  version: 1;
  workflow: string;
  sourceHash: string | null;
  /** "sourceHash": runs of this exact source; "name": of the workflow's name (its source differed). */
  match: "sourceHash" | "name" | null;
  /** The runs it is based on, newest first. */
  runs: string[];
  total: EstimateFigures | null;
  phases: PhaseEstimate[];
  adapters: AdapterEstimate[];
  /** Some output tokens are chars/4 estimates. */
  estimated: boolean;
  notes: string[];
}

/** A fan-out's cost forecast, as its `log` event's `forecast` carries it (ODW extension; src/forecast.ts). */
export interface FanOutForecast {
  call: string;
  width: number;
  agents: number;
  phase: string | null;
  label: string | null;
  basis: "label" | "phase";
  perAgentUsd: EstimateSpread;
  usd: number;
  p90Usd: number;
  perAgentOutputTokens: EstimateSpread | null;
  runs: number;
  match: "sourceHash" | "name";
}

/**
 * GET /api/evals — the `odw eval` reports kept under the runs root
 * (`_evals/<name>/<id>.json`), newest first (ODW extension; read only).
 */
export interface EvalReportSummary {
  name: string;
  /** The report's id: its start time (YYYYMMDD-HHMMSS), then 6 hex digits. */
  id: string;
  description: string | null;
  /** The workflow as the eval file names it. */
  workflow: string;
  evalHash: string;
  /** ISO 8601. */
  startedAt: string;
  finishedAt: string;
  totals: EvalTotals;
  adapters: string[];
  /** How many cases. */
  cases: number;
  /** Cells that regressed against the report's baseline; null when it had none. */
  regressed: number | null;
}

/**
 * GET /api/evals/:name/:id — one `odw eval` report (ODW extension;
 * src/eval/report.ts documents every key). Case args are served with token
 * shapes redacted (`redacted: true` then). 400 unless name and id are
 * run-id-like, 404 when there is no such report.
 */
export interface EvalReport {
  /** 1; it changes when a key changes meaning. */
  version: 1;
  name: string;
  id: string;
  /** The eval file, absolute. */
  file: string;
  description: string | null;
  /** sha256 of the definition as run (keys sorted; --adapter and --repeats applied). */
  evalHash: string;
  definition: EvalDefinition;
  workflow: { ref: string; script: string; sourceHash: string | null };
  odwVersion: string;
  /** Each adapter CLI's versions the runs recorded ("unknown" when a CLI did not tell). */
  cliVersions: Record<string, string[]>;
  startedAt: string;
  finishedAt: string;
  /** The eval's whole wall time. */
  wallMs: number;
  totals: EvalTotals;
  /** A row per case × adapter, adapter first, in definition order. */
  cells: EvalCell[];
  /** A row per run, in adapter, case, repeat order. */
  runs: EvalRunRecord[];
  baseline: EvalBaseline | null;
  redacted?: boolean;
}

export interface EvalDefinition {
  workflow: string;
  cases: Array<{ name: string; args: unknown; checks: EvalCheck[] }>;
  /** null: the config's default adapter. */
  adapters: string[] | null;
  repeats: number;
  concurrency: number;
  /** Tokens per run (--budget); null for none. */
  budget: number | null;
  /** Seconds a run may take before it is stopped (and fails); null for no limit. */
  timeout: number | null;
}

/** A check, exactly one of these shapes; `path` is dot/bracket notation into the run's result ("" for all of it). */
export type EvalCheck =
  | { path: string; equals: unknown }
  | { path: string; contains: unknown }
  | { path: string; matches: string; flags?: string }
  | { path: string; exists: boolean }
  | { command: string; timeout?: number }
  | { state: "done" | "failed" | "stopped" }
  | { maxCostUsd: number }
  | { maxSeconds: number };

export interface EvalTotals {
  runs: number;
  passed: number;
  failed: number;
  passRate: number;
  /** Summed over the runs that reported them; null when none did. */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface EvalCell {
  case: string;
  adapter: string;
  runs: number;
  passed: number;
  passRate: number;
  /** Median wall time of its runs. */
  medianMs: number | null;
  /** Total cost; the means are over the runs that reported one. Null when none did. */
  costUsd: number | null;
  meanCostUsd: number | null;
  /** Mean input + output tokens per run. */
  meanTokens: number | null;
  /** Its runs, in repeat order: any two open with `odw compare` (GET /api/compare). */
  runIds: string[];
}

export interface EvalRunRecord {
  runId: string;
  case: string;
  adapter: string;
  /** From 1. */
  repeat: number;
  /** done, failed, stopped — or stale. */
  state: string;
  passed: boolean;
  /** Stopped by the eval's timeout. */
  timedOut: boolean;
  wallMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Some output tokens are chars/4 estimates. */
  estimated: boolean;
  /** The CLI version each adapter's cli_version event recorded (null: unknown). */
  cliVersions: Record<string, string | null>;
  error: string | null;
  /** The checks it missed (`check: "timeout"` when the eval's timeout stopped it), each with what was found. */
  failures: Array<{ check: string; message: string }>;
}

/** The report against `--baseline`'s: A is the baseline, B this report; delta = B − A (null when either is unknown). */
export interface EvalBaseline {
  file: string;
  name: string;
  id: string;
  evalHash: string;
  /** The two ran the same definition. */
  sameDefinition: boolean;
  cells: Array<{
    case: string;
    adapter: string;
    /** "regressed": its pass rate fell; "new"/"missing": only one report has the cell. */
    status: "regressed" | "improved" | "unchanged" | "new" | "missing";
    passRate: CompareMetric;
    meanCostUsd: CompareMetric;
    medianMs: CompareMetric;
  }>;
  regressed: Array<{ case: string; adapter: string }>;
}

/** One adapter row exposed in settings snapshots. */
export interface AdapterListing {
  name: string;
  label: string;
  installed: boolean;
  isDefault: boolean;
  permissionNote: string;
  /** The permission tiers it declares flags for (ODW extension); empty: none, it runs as configured. */
  tiers?: PermissionTier[];
  /** How it runs untrusted: its flags, or that it has no documented way (ODW extension). */
  untrusted?: string;
}

export interface SettingsSnapshot {
  cwd: string;
  configPath: string | null;
  runsRoot: string;
  writable: boolean;
  claudeJobsScope: "all" | "project";
  adapters: Array<AdapterListing & { command: string }>;
  workflowRoots: Array<{
    provider: "odw" | "claude";
    scope: "project" | "global";
    label: string;
    path: string;
  }>;
  /**
   * Run-completion hooks (ODW extension): whether a command is set, the
   * webhook as scheme + host only (its path/query are secret), and what fires
   * them — terminal states, and (opt-in) "waiting": a checkpoint() waits, and
   * "paused": the run pauses for a spent quota.
   */
  notify: {
    command: boolean;
    webhook: string | null;
    on: Array<"done" | "failed" | "stopped" | "waiting" | "paused">;
  };
}

export interface WorkflowSummary {
  /** A Claude Code plugin's workflow (ODW extension): `<plugin>:<name>`. */
  name: string;
  origin: "project" | "global" | "plugin";
  /** `claude-plugin:<plugin>` for a workflow an installed Claude Code plugin ships (ODW extension). */
  provider: "odw" | "claude" | `claude-plugin:${string}`;
  rootLabel: string;
  path: string;
  description: string | null;
  phases: Array<{ title: string }>;
  runCount: number;
  /** A higher-precedence same-named workflow wins `odw run <name>`; we still show this. */
  shadowed: boolean;
  /** A plugin workflow whose bare name runs a project or global workflow instead (ODW extension). */
  note?: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  source: string;
  runs: Array<{ runId: string }>;
}

export interface WorkflowEvent {
  ts: number;
  type: string;
  /** Secrets in its text were replaced by `«redacted:<kind>»` before it was written (ODW extension). */
  redacted?: boolean;
  [key: string]: unknown;
}

export type Connection = "connecting" | "live" | "reconnecting";

/** GET /api/capabilities — whether this dashboard may start/control runs. */
export interface Capabilities {
  writable: boolean;
  /** "token": reads need a token (`odw serve --token`; ODW extension). Absent from older servers. */
  auth?: "token" | "none";
  /** The shared bundle this dashboard shows, read-only (`odw serve --open FILE.odwrun`; ODW extension). */
  bundle?: BundleInfo | null;
  /** Checkpoints can be answered here — off loopback too with `--token-scope approve` (ODW extension). Absent from older servers. */
  decide?: boolean;
}

/** A shared bundle as `odw serve` describes it (ODW extension). */
export interface BundleInfo {
  runId: string;
  /** The bundle file's name. */
  file: string;
  bundledAt: number | null;
  odwVersion: string | null;
  /** Something in it was redacted when it was bundled. */
  redacted: boolean;
  /** Its agents' transcripts are in it. */
  transcripts: boolean;
}

export type ChatRole = "user" | "assistant" | "tool";
export type ChatSessionState = "running" | "idle" | "done";
export type ChatMessageStatus = "streaming" | "done" | "failed";
export type ChatToolStatus = "running" | "done" | "failed" | "stale";
export type ChatMessageKind = "chat.ready" | "chat.linked" | "chat.recorded" | "chat.odw_result";

export interface ChatToolEvent {
  type: string;
  label: string;
  ts: number;
}

export interface ChatToolCall {
  name: "odw.run";
  status: ChatToolStatus;
  workflow: string;
  runId: string;
  progress: number;
  phase: string;
  events: ChatToolEvent[];
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
  kind?: ChatMessageKind;
  status?: ChatMessageStatus;
  tool?: ChatToolCall;
  /** Likely secrets in its text were replaced by `«redacted:<kind>»` before it was kept (ODW extension). */
  redacted?: boolean;
}

export interface ChatLinkedRun {
  runId: string;
  workflow: string;
  state: RunDisplayState;
  progress: number;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  source: string;
  state: ChatSessionState;
  updatedAt: number;
  lastMessage: string;
  linkedRuns: number;
}

export interface ChatSession extends Omit<ChatSessionSummary, "lastMessage" | "linkedRuns"> {
  messages: ChatMessage[];
  linkedRuns: ChatLinkedRun[];
}

/** One event in the cross-run activity stream (GET /api/activity). */
export type ActivityEvent = WorkflowEvent & {
  runId: string;
  /** The run's workflow name. */
  run: string;
  adapter: string | null;
  provider?: "odw" | "claude";
};

/** GET /api/activity — the newest events across runs + running agents per adapter. */
export interface ActivitySnapshot {
  events: ActivityEvent[];
  fleet: Record<string, number>;
}

/** GET /api/runs/:id/agents/:agentId — a completed agent's persisted result. */
export interface AgentResultRecord {
  agentId: number;
  label: string;
  phase: string | null;
  adapter: string | null;
  attempts: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  value: unknown;
  /** Replayed from an earlier run by `odw resume`. */
  cached?: boolean;
  sourceRunId?: string | null;
  changes?: AgentChanges | null;
  branch?: string | null;
  /** The permission tier it ran at (ODW extension). */
  permissions?: PermissionTier;
  /** `untrusted` when its CLI ran untrusted (ODW extension); absent: trusted. */
  trust?: TrustLevel;
  /** The adapters it fell back from before `adapter` produced the value (ODW extension). */
  fellBackFrom?: string[];
  /** The tool calls its CLI refused while it did the work (ODW extension). */
  denied?: string[];
  /** The MCP servers its CLI started it without while it did the work (ODW extension). */
  mcp?: Array<{ name: string; status: string }>;
  /** The background work its CLI left running when it replied (ODW extension). */
  orphaned?: string[];
  /** Secrets in it were replaced by `«redacted:<kind>»` before it was saved (ODW extension): show a "redacted" tag. */
  redacted?: boolean;
}

/** One step of an agent's transcript, normalized (ODW extension; src/runtime/transcript-view.ts). */
export interface TranscriptEntry {
  /** Its place in the transcript, from 0: what `?since=` counts. */
  i: number;
  kind: "text" | "tool_call" | "tool_result" | "error" | "attempt" | "handoff" | "result" | "raw" | "truncated";
  /**
   * text: what the agent wrote; tool_call: what the call is about (the command,
   * the file, …); tool_result: its exit code and size ("exit 1, 12 lines"); the
   * other kinds: what happened, in a sentence (raw: the line itself).
   */
  text?: string;
  /** tool_call, tool_result (and a refused permission): the tool. */
  tool?: string;
  /** tool_call: the tool's input — as JSON text, cut, when it is longer than 4 KB. */
  input?: unknown;
  /** tool_result: what the tool returned. */
  output?: string;
  /** tool_result, result: the tool, or the whole session, failed. */
  isError?: boolean;
  /** A field was cut at 4 KB. */
  clipped?: true;
  /** text: the agent's thinking, not its reply. */
  thinking?: true;
  /** attempt: which CLI run of the call begins (2 = the first one more), and why: schema | stall | rate_limit | expect | fallback. */
  n?: number;
  reason?: string;
  /** attempt, for a fallback (ODW extension): the adapter the call moved to; handoff: the one that carries on. */
  adapter?: string;
  /**
   * handoff (ODW extension): a fallback handed the work over instead of starting it over —
   * the adapter it left; `output` is the brief the next one's prompt started with, `reason` why.
   */
  from?: string;
  /** truncated: the bytes kept before maxTranscriptBytes cut the transcript; handoff: the brief's size. */
  bytes?: number;
  /** result: the turns the session took and what it cost, as its CLI reported. */
  turns?: number;
  costUsd?: number;
  /** Secrets in it were kept out as `«redacted:<kind>»` (ODW extension): show a "redacted" tag. */
  redacted?: true;
}

/**
 * One note on a run's notes board (ODW extension; src/notes.ts): GET
 * /api/runs/:id/notes returns them in order ([] when the run has none; 404
 * for Claude runs). Each is also a `note_added` event, with the same fields
 * but `ts` (the event's own). Agents with notes on post them; ODW posts a
 * `kind: "interface"` one for an isolated agent's kept change, and a
 * `kind: "scope"` one for an agent that changed files outside its scope.
 */
export interface RunNote {
  /** 1, 2, … in the order the board took them. */
  noteId: number;
  ts: number;
  /** The agent that posted it, or that ODW posted it for. */
  by: { agentId: number; label: string };
  /** At most 2000 characters; may span lines. */
  text: string;
  /** "note": the agent's own; "interface": its diff stat and the interface lines it touched; "scope": the files it changed outside its scope. */
  kind: "note" | "interface" | "scope";
  /** Cut at 2000 characters. */
  truncated?: true;
  /** Secrets in it were replaced by `«redacted:<kind>»`. */
  redacted?: true;
}

/** GET /api/runs/:id/agents/:agentId/transcript?since=<i> — 404 when the agent has no transcript. */
export interface TranscriptPage {
  /** The entries from `since` on, at most 1000. */
  entries: TranscriptEntry[];
  /** The `since` of the next page: one past the last entry here. */
  next: number;
  /** More entries are on disk already: ask for `next` at once. */
  more: boolean;
  /** The transcript reached maxTranscriptBytes: the agent's later output was not kept. */
  truncated: boolean;
  /** The agent was replayed by `odw resume`: no CLI ran, so it has no transcript (no entries). */
  replayed: boolean;
}
