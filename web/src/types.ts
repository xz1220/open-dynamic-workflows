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
  /** A command step's per-run id (its `agentId` is null). */
  commandId?: number | null;
  /** A command step's exit code once it settled. */
  exitCode?: number | null;
  /** Why an agent failed: rate_limit, quota, auth, timeout, stalled, not_found, permission, exit. */
  failureReason?: string | null;
  /** What the adapter reported spending on this agent. */
  usage?: Usage | null;
  /** What an isolated (worktree) agent changed; its diff is served separately. */
  changes?: AgentChanges | null;
  /** The branch its changes were kept on (`keep: true`), when any. */
  branch?: string | null;
  label: string;
  phase: string | null;
  state: AgentState;
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
  agents: AgentView[];
  phaseOrder: string[];
  hasResult: boolean;
  error: { error?: string; stack?: string } | null;
  /** Where the run was initiated from, when recorded by the launcher. */
  origin: string | null;
  /** Run-level adapter override recorded at start, if any. */
  adapter: string | null;
  /** The workflow identity recorded at create time (meta.workflowName). */
  workflowName: string | null;
  /** checkpoint() calls waiting for approval (ODW extension). */
  pendingCheckpoints?: PendingCheckpoint[];
}

/** One adapter row exposed in settings snapshots. */
export interface AdapterListing {
  name: string;
  label: string;
  installed: boolean;
  isDefault: boolean;
  permissionNote: string;
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
   * them — terminal states, and (opt-in) "waiting": a checkpoint() waits.
   */
  notify: {
    command: boolean;
    webhook: string | null;
    on: Array<"done" | "failed" | "stopped" | "waiting">;
  };
}

export interface WorkflowSummary {
  name: string;
  origin: "project" | "global";
  provider: "odw" | "claude";
  rootLabel: string;
  path: string;
  description: string | null;
  phases: Array<{ title: string }>;
  runCount: number;
  /** A higher-precedence same-named workflow wins `odw run <name>`; we still show this. */
  shadowed: boolean;
}

export interface WorkflowDetail extends WorkflowSummary {
  source: string;
  runs: Array<{ runId: string }>;
}

export interface WorkflowEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export type Connection = "connecting" | "live" | "reconnecting";

/** GET /api/capabilities — whether this dashboard may start/control runs. */
export interface Capabilities {
  writable: boolean;
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
}

/** One step of an agent's transcript, normalized (ODW extension; src/runtime/transcript-view.ts). */
export interface TranscriptEntry {
  /** Its place in the transcript, from 0: what `?since=` counts. */
  i: number;
  kind: "text" | "tool_call" | "tool_result" | "error" | "attempt" | "result" | "raw" | "truncated";
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
  /** attempt: which CLI run of the call begins (2 = the first one more), and why: schema | stall | rate_limit. */
  n?: number;
  reason?: string;
  /** truncated: the bytes kept before maxTranscriptBytes cut the transcript. */
  bytes?: number;
  /** result: the turns the session took and what it cost, as its CLI reported. */
  turns?: number;
  costUsd?: number;
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
