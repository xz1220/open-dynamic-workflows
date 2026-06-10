/** Wire types — kept in lockstep with src/runtime/{runs-view,workflows-view}.ts. */

export type RunDisplayState =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "stale";

export type AgentState = "running" | "done" | "failed" | "stale";

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
}

export interface AgentView {
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

export interface RunDetail extends RunSummary {
  script: string | null;
  args: unknown;
  agents: AgentView[];
  phaseOrder: string[];
  hasResult: boolean;
  error: { error?: string; stack?: string } | null;
  /** Where the run was initiated from ("launch" for GUI-launched runs). */
  origin: string | null;
  /** Run-level adapter override recorded at launch, if any. */
  adapter: string | null;
  /** The workflow identity recorded at create time (meta.workflowName). */
  workflowName: string | null;
}

/** One row of GET /api/adapters — the Launch view's agent picker. */
export interface AdapterListing {
  name: string;
  label: string;
  installed: boolean;
  isDefault: boolean;
  permissionNote: string;
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
