/**
 * The Claude Code run source: surfaces Claude Code's OWN workflow runs (the ones
 * its Workflow tool spawns) as read-only Jobs, folded into the same
 * {@link RunSummary}/{@link RunDetail} wire types tagged `provider:"claude"`.
 *
 * Claude Code writes two artifacts per run under its per-project session store
 * (`<projectsRoot>/<encoded-cwd>/<session>/`):
 *
 *   - TERMINAL, at completion: `workflows/wf_<id>.json` — a rich journal with
 *     `status`, `workflowProgress[]` (per-agent label/phase/state/tokens/duration),
 *     `phases`, `startTime`, `durationMs`, `result.final`. This is the authoritative
 *     record and yields a full DAG.
 *   - LIVE, while running: `subagents/workflows/wf_<id>/journal.jsonl` — appended
 *     with `{type:"started"|"result", key, agentId}` lines as agents start/finish,
 *     plus `agent-<id>.jsonl` per-agent transcripts. A run is RUNNING iff this dir
 *     exists with NO sibling terminal `wf_<id>.json`.
 *
 * Everything is read-only, node:fs only, per-file try/catch (a foreign or
 * half-written journal is skipped, never fatal — same posture as the run store's
 * reads and workflows-view's readMetaSafe). Units: every journal epoch is MILLISECONDS;
 * ODW uses seconds, so each timestamp is /1000 — EXCEPT `durationMs`, which is
 * already ms and maps 1:1 onto AgentView.durationMs.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { WorkflowEvent } from "../events.js";
import { readdirSafe, readJsonFile, SigCache, statSig } from "./fs-util.js";
import { RUN_ID_RE, type RunSource } from "./run-source.js";
import {
  countAgents,
  type AgentView,
  type RunCounts,
  type RunDetail,
  type RunDisplayState,
  type RunSummary,
} from "./runs-view.js";

/** Encode a working directory to its `~/.claude/projects` dir name. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

export interface ClaudeRunSourceOptions {
  /** Already-resolved root of `~/.claude/projects` (CLAUDE_CONFIG_DIR honored upstream). */
  projectsRoot: string;
  /** The serve cwd — anchors project-scoped discovery. */
  cwd: string;
  /** "all" (default): every project; "project": only the served repo + its git worktrees. */
  scope?: "all" | "project";
  /** Liveness window for the mtime staleness heuristic, in ms (default 90s). */
  freshMs?: number;
  /** Injectable clock for tests (ms). */
  now?: () => number;
}

const ID_PREFIX = "cc-";
const DEFAULT_FRESH_MS = 90_000;
/** Full terminal folds kept in memory (the runs being viewed), not every run's. */
const FOLDS_KEPT = 32;

/** A discovered run: where it lives and whether it is still in flight. */
interface Discovered {
  runId: string; // cc-<wid>
  wid: string; // wf_<...>
  sessDir: string;
  kind: "terminal" | "live";
  /** terminal: the wf_<id>.json path; live: the wf_<id>/ dir path. */
  path: string;
}

/**
 * What a live run's files say, independent of the clock. Whether the run is
 * still RUNNING depends on `now`, so it is decided per read from
 * `aliveUntilMs` — never cached (a crashed Claude session writes nothing, yet
 * its run must turn stale once the freshness window passes).
 */
interface LiveScan {
  kind: "live";
  /** Agents whose last journal line is "started". */
  running: LiveAgent[];
  done: number;
  /** Agents whose last journal line is a result, in journal order. */
  finished: LiveAgent[];
  created: number | null;
  updatedAt: number | null;
  name: string;
  /** Epoch ms until which the freshest journal/transcript write keeps the run alive. */
  aliveUntilMs: number;
}

interface TerminalSummary {
  kind: "terminal";
  summary: RunSummary;
}

type Folded = { summary: RunSummary; detail: RunDetail; events: WorkflowEvent[] };

/** One agent of a live run, as its journal's lines name it (the "started" line carries label and phase). */
interface LiveAgent {
  key: string;
  agentId?: string;
  label?: string;
  phase?: string;
}

/**
 * One agent of a Claude Code run with what a terminal follower needs (`odw
 * logs --agent`, `odw tmux`; an ODW extension): Claude's own agent id and the
 * path of its `agent-<id>.jsonl` transcript (null when the id is not a safe
 * file-name segment, or the journal named none).
 */
export interface ClaudeAgentRef {
  agentId: string | null;
  label: string;
  phase: string | null;
  state: AgentView["state"];
  transcript: string | null;
}

/** A Claude agent id that may name a transcript file: one plain segment. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class ClaudeRunSource implements RunSource {
  readonly provider = "claude" as const;
  readonly controlError = "Claude Code runs are read-only here — observe only.";

  private readonly freshMs: number;
  private readonly now: () => number;
  /** Per-run fold keyed by the run's file signatures (terminal: final; live: clock-free scan). */
  private readonly cache = new SigCache<TerminalSummary | LiveScan>();
  /** Full terminal folds (detail + synthesized events) for the most recently viewed runs. */
  private readonly folds = new SigCache<Folded>(FOLDS_KEPT);
  /** runId → location, from the last {@link discover} walk. */
  private index = new Map<string, Discovered>();

  constructor(private readonly opts: ClaudeRunSourceOptions) {
    this.freshMs = opts.freshMs ?? DEFAULT_FRESH_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  owns(runId: string): boolean {
    return runId.startsWith(ID_PREFIX);
  }
  exists(runId: string): boolean {
    return this.find(runId) !== null;
  }

  listSummaries(): RunSummary[] {
    const out: RunSummary[] = [];
    const live = new Set<string>();
    for (const d of this.discover()) {
      live.add(d.runId);
      out.push(this.summaryOf(d));
    }
    this.cache.retain(live);
    return out;
  }

  summary(runId: string): RunSummary | null {
    const d = this.find(runId);
    return d ? this.summaryOf(d) : null;
  }
  detail(runId: string): RunDetail | null {
    const d = this.find(runId);
    return d ? this.fold(d).detail : null;
  }
  events(runId: string, since: number): WorkflowEvent[] {
    return this.eventLog(runId).slice(Math.max(0, since));
  }
  eventLog(runId: string): readonly WorkflowEvent[] {
    const d = this.find(runId);
    return d ? this.fold(d).events : [];
  }
  result(runId: string): { has: boolean; value: unknown } {
    const d = this.find(runId);
    if (!d || d.kind !== "terminal") return { has: false, value: undefined };
    const j = readJson(d.path);
    const value = j?.result?.final ?? j?.result ?? undefined;
    return { has: value !== undefined && value !== null, value };
  }
  control(): void {
    // Never called: controlError is non-null, so the server refuses with 409.
  }
  decide(): void {
    // Never called either: a Claude Code run has no checkpoint() to answer.
  }
  agentResults(): null {
    return null; // Claude Code keeps no per-agent result records ODW can serve
  }
  agentResult(): null {
    return null;
  }
  agentDiff(): null {
    return null; // nor the diffs of its isolated agents
  }
  agentTranscript(): null {
    return null; // nor ODW transcripts (this source surfaces no raw agent transcripts)
  }

  /**
   * The run's agents with their Claude agent ids and transcript paths — what
   * `odw logs --agent` and `odw tmux` follow (read-only). Null for an unknown run.
   */
  agentRefs(runId: string): ClaudeAgentRef[] | null {
    const d = this.find(runId);
    if (!d) return null;
    const dir = join(d.sessDir, "subagents", "workflows", d.wid);
    const ref = (agentId: unknown, label: string, phase: string | null, state: AgentView["state"]): ClaudeAgentRef => {
      const id = typeof agentId === "string" && AGENT_ID_RE.test(agentId) ? agentId : null;
      return { agentId: id, label, phase, state, transcript: id ? join(dir, `agent-${id}.jsonl`) : null };
    };
    if (d.kind === "terminal") {
      const j = readJson(d.path) ?? {};
      const progress: any[] = Array.isArray(j.workflowProgress) ? j.workflowProgress : [];
      return progress
        .filter((e: any) => e?.type === "workflow_agent")
        .map((a: any) =>
          ref(a.agentId, String(a.label ?? a.agentId ?? "agent"), a.phaseTitle != null ? String(a.phaseTitle) : null, mapAgentState(a.state)),
        );
    }
    const scan = this.scanLive(d);
    const alive = this.now() < scan.aliveUntilMs;
    return [
      ...scan.finished.map((a) => ref(a.agentId, liveLabel(a), a.phase ?? null, "done")),
      ...scan.running.map((a) => ref(a.agentId, liveLabel(a), a.phase ?? null, alive ? "running" : "stale")),
    ];
  }

  // --- discovery -------------------------------------------------------------

  /** The project dirs to scan: all of them, or the served repo + its worktrees. */
  private projectDirs(): string[] {
    const root = this.opts.projectsRoot;
    if (!existsSync(root)) return [];
    const entries = readdirSafe(root).filter((e) => e.isDirectory());
    if ((this.opts.scope ?? "all") === "all") return entries.map((e) => join(root, e.name));
    const base = encodeProjectDir(this.opts.cwd);
    const worktreePrefix = `${base}--claude-worktrees-`;
    return entries
      .filter((e) => e.name === base || e.name.startsWith(worktreePrefix))
      .map((e) => join(root, e.name));
  }

  /**
   * Every Claude run visible from the configured scope, terminal and live — a
   * walk of every project + session dir. Also refreshes the run-location index
   * that lets {@link find} skip the walk.
   */
  protected discover(): Discovered[] {
    const out: Discovered[] = [];
    for (const projDir of this.projectDirs()) {
      for (const sess of readdirSafe(projDir)) {
        if (!sess.isDirectory() || !RUN_ID_RE.test(sess.name)) continue;
        const sessDir = join(projDir, sess.name);
        // terminal journals
        for (const f of readdirSafe(join(sessDir, "workflows"))) {
          if (!f.isFile() || !/^wf_.+\.json$/.test(f.name)) continue;
          out.push(terminalRun(sessDir, f.name.slice(0, -".json".length)));
        }
        // live dirs — running iff no terminal sibling exists yet
        for (const d of readdirSafe(join(sessDir, "subagents", "workflows"))) {
          if (!d.isDirectory() || !/^wf_/.test(d.name)) continue;
          const wid = d.name;
          if (existsSync(join(sessDir, "workflows", `${wid}.json`))) continue; // terminal wins
          out.push({ runId: ID_PREFIX + wid, wid, sessDir, kind: "live", path: join(sessDir, "subagents", "workflows", wid) });
        }
      }
    }
    this.index = new Map(out.map((d) => [d.runId, d]));
    return out;
  }

  /**
   * Locate one run by id within the current scope (used by detail/events/result).
   * The last discovery's index answers in O(1), re-validated against the disk
   * (a live run may have finished since); only a miss pays for a full walk.
   */
  private find(runId: string): Discovered | null {
    if (!this.owns(runId)) return null;
    const known = this.index.get(runId);
    if (known) {
      const current = stillThere(known);
      if (current) {
        if (current !== known) this.index.set(runId, current);
        return current;
      }
    }
    return this.discover().find((d) => d.runId === runId) ?? null;
  }

  /**
   * Cheap change fingerprint: terminal keys on the journal file; live on the
   * journal plus EVERY agent transcript (any of them can be the one keeping
   * the run fresh). Joined, not "newest wins": picking a max by comparing
   * "size:mtime" strings lexicographically ranks "950:…" above "1200:…".
   */
  private signature(d: Discovered): string {
    if (d.kind === "terminal") return `T:${statSig(d.path)}`;
    const parts = [statSig(join(d.path, "journal.jsonl"))];
    const agents = readdirSafe(d.path)
      .filter((f) => f.isFile() && f.name.startsWith("agent-"))
      .map((f) => f.name)
      .sort();
    for (const name of agents) parts.push(`${name}=${statSig(join(d.path, name))}`);
    return `L:${parts.join("|")}`;
  }

  // --- folding ---------------------------------------------------------------

  /** The run's summary as of now, from the signature-gated cache. */
  private summaryOf(d: Discovered): RunSummary {
    const entry = this.cache.get(d.runId, this.signature(d), () =>
      d.kind === "terminal" ? { kind: "terminal", summary: this.foldTerminal(d).summary } : this.scanLive(d),
    );
    return entry.kind === "terminal" ? entry.summary : this.foldLive(d, entry).summary;
  }

  /** Detail + events: cached for terminal runs; rebuilt as of now for live ones. */
  private fold(d: Discovered): Folded {
    if (d.kind === "live") {
      const scan = this.cache.get(d.runId, this.signature(d), () => this.scanLive(d));
      return this.foldLive(d, scan.kind === "live" ? scan : this.scanLive(d), true);
    }
    const folded = this.folds.get(d.runId, this.signature(d), () => this.foldTerminal(d));
    // The cached fold is shared: hand out a detail the caller may freely mutate.
    return { ...folded, detail: { ...folded.detail, agents: folded.detail.agents.map((a) => ({ ...a })) } };
  }

  private foldTerminal(d: Discovered): Folded {
    const j = readJson(d.path) ?? {};
    const progress: any[] = Array.isArray(j.workflowProgress) ? j.workflowProgress : [];
    const phaseEntries = progress.filter((e: any) => e?.type === "workflow_phase");
    const agentEntries = progress.filter((e: any) => e?.type === "workflow_agent");
    const phases = phaseEntries.map((e: any) => ({ title: String(e.title ?? "") }));
    const phaseOrder = phases.map((p) => p.title).filter(Boolean);

    const agents: AgentView[] = agentEntries.map((a: any) => {
      const startedAt = num(a.startedAt) != null ? num(a.startedAt)! / 1000 : null;
      const durationMs = num(a.durationMs);
      return {
        agentId: null, // Claude transcripts use their own string ids, not ODW dispatch ids
        kind: "agent",
        label: String(a.label ?? a.agentId ?? "agent"),
        phase: a.phaseTitle != null ? String(a.phaseTitle) : null,
        state: mapAgentState(a.state),
        adapter: a.model != null ? String(a.model) : null,
        attempts: num(a.attempt),
        error: a.error != null ? String(a.error) : null,
        startedAt,
        finishedAt: startedAt != null && durationMs != null ? startedAt + durationMs / 1000 : null,
        durationMs,
        cached: false,
      };
    });
    const counts = countAgents(agents);
    const startSec = num(j.startTime) != null ? num(j.startTime)! / 1000 : tsFromIso(j.timestamp);
    const durMs = num(j.durationMs);
    const updatedAt = startSec != null && durMs != null ? startSec + durMs / 1000 : startSec;
    const state = mapTerminalState(String(j.status ?? ""));
    const settled = counts.done + counts.failed;

    const summary: RunSummary = {
      runId: d.runId,
      provider: "claude",
      state,
      rawState: String(j.status ?? "completed"),
      stale: false,
      name: String(j.workflowName ?? d.wid),
      description: null,
      phases,
      source: null,
      pid: null,
      createdAt: startSec,
      updatedAt,
      counts,
      progress: counts.agents > 0 ? settled / counts.agents : state === "done" ? 1 : 0,
      lastActivityTs: updatedAt,
    };

    const hasResult = j.result != null;
    const detail: RunDetail = {
      ...summary,
      script: j.script != null ? String(j.script) : null,
      args: parseArgs(j.args),
      agents,
      phaseOrder,
      hasResult,
      error: state === "failed" ? { error: String(j.summary ?? "workflow failed") } : null,
      origin: null,
      adapter: null,
      workflowName: String(j.workflowName ?? d.wid),
    };
    const events = synthTerminalEvents(summary, agents, phaseOrder, j);
    return { summary, detail, events };
  }

  /** Read a live run's journal and the mtimes that decide its freshness. */
  private scanLive(d: Discovered): LiveScan {
    const journal = join(d.path, "journal.jsonl");
    const lines = readLines(journal);
    // Pair by `key` (the stable v2 prompt-hash); an agent is RUNNING iff its LAST line is "started".
    const last = new Map<string, Record<string, any>>();
    // The "started" line names the agent (label, phase); its result line does not.
    const named = new Map<string, Record<string, any>>();
    for (const l of lines) {
      if (!l || typeof l.key !== "string") continue;
      last.set(l.key, l);
      if (l.type === "started") named.set(l.key, l);
    }
    const running: LiveAgent[] = [];
    const finished: LiveAgent[] = [];
    for (const [key, l] of last) {
      const n = named.get(key);
      const agent: LiveAgent = {
        key,
        agentId: typeof l.agentId === "string" ? l.agentId : typeof n?.agentId === "string" ? n.agentId : undefined,
        label: typeof n?.label === "string" && n.label ? n.label : undefined,
        phase: typeof n?.phase === "string" && n.phase ? n.phase : undefined,
      };
      (l.type === "started" ? running : finished).push(agent);
    }
    const done = finished.length;
    // Alive while the journal, or the transcript of an agent still running, was
    // written within the freshness window; a missing file (mtime 0) never is.
    const journalMs = mtimeMs(journal);
    let freshestMs = journalMs;
    for (const r of running) {
      // An id is a file name only in its shape: never a path out of the run directory.
      if (r.agentId != null && AGENT_ID_RE.test(r.agentId)) freshestMs = Math.max(freshestMs, mtimeMs(join(d.path, `agent-${r.agentId}.jsonl`)));
    }
    const created = birthSec(d.path);
    return {
      kind: "live",
      running,
      done,
      finished,
      created,
      updatedAt: journalMs / 1000 || created,
      name: liveName(d.sessDir, d.wid),
      aliveUntilMs: freshestMs + this.freshMs,
    };
  }

  /** Build a live run's views as of now. `withScript` reads the script for the detail view. */
  private foldLive(d: Discovered, scan: LiveScan, withScript = false): Folded {
    const { running, done, finished, created, updatedAt } = scan;
    const alive = this.now() < scan.aliveUntilMs;
    const state: RunDisplayState = alive ? "running" : "stale";

    const agents: AgentView[] = [
      ...running.map(
        (r): AgentView => ({
          agentId: null,
          kind: "agent",
          label: liveLabel(r),
          phase: r.phase ?? null,
          state: alive ? "running" : "stale",
          adapter: null,
          attempts: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          cached: false,
        }),
      ),
      ...finished.map((f): AgentView => ({
        agentId: null,
        kind: "agent",
        label: f.label ?? "agent",
        phase: f.phase ?? null,
        state: "done",
        adapter: null,
        attempts: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        cached: false,
      })),
    ];
    const counts: RunCounts = {
      agents: running.length + done,
      running: alive ? running.length : 0,
      done,
      failed: 0,
      stale: alive ? 0 : running.length,
    };

    const summary: RunSummary = {
      runId: d.runId,
      provider: "claude",
      state,
      rawState: "running",
      stale: state === "stale",
      name: scan.name,
      description: null,
      phases: [],
      source: null,
      pid: null,
      createdAt: created,
      updatedAt,
      counts,
      progress: counts.agents > 0 ? counts.done / counts.agents : 0,
      lastActivityTs: updatedAt,
    };
    const detail: RunDetail = {
      ...summary,
      script: withScript ? readScript(d.sessDir, d.wid) : null,
      args: null,
      agents,
      phaseOrder: [],
      hasResult: false,
      error: null,
      origin: null,
      adapter: null,
      workflowName: null,
    };
    // Finished agents too (started, then finished): a follower of the run sees each settle.
    const events: WorkflowEvent[] = [
      { type: "run_started", ts: created } as WorkflowEvent,
      ...agents.flatMap((a) => {
        const started = { type: "agent_started", ts: updatedAt, label: a.label, phase: a.phase } as WorkflowEvent;
        if (a.state !== "done") return [started];
        return [started, { type: "agent_finished", ts: updatedAt, label: a.label, phase: a.phase } as WorkflowEvent];
      }),
    ];
    return { summary, detail, events };
  }
}

// --- module helpers ----------------------------------------------------------

function terminalRun(sessDir: string, wid: string): Discovered {
  return { runId: ID_PREFIX + wid, wid, sessDir, kind: "terminal", path: join(sessDir, "workflows", `${wid}.json`) };
}

/**
 * Re-validate an indexed location: a terminal journal must still exist; a live
 * run must still exist and is upgraded to its terminal journal once that
 * appears (terminal wins, as in discovery). Null when it is gone.
 */
function stillThere(d: Discovered): Discovered | null {
  if (d.kind === "terminal") return existsSync(d.path) ? d : null;
  const terminal = terminalRun(d.sessDir, d.wid);
  if (existsSync(terminal.path)) return terminal;
  return existsSync(d.path) ? d : null;
}

function mapTerminalState(status: string): RunDisplayState {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  return "failed"; // an unknown terminal status is a failure, never a fake "running"
}

function mapAgentState(state: unknown): AgentView["state"] {
  const s = String(state ?? "");
  if (s === "done") return "done";
  if (s === "failed" || s === "error") return "failed";
  if (s === "running") return "running";
  return "stale";
}

/** Synthesize an ODW-shaped event stream so the Logs tab + phase stepper + DAG render. */
function synthTerminalEvents(
  summary: RunSummary,
  agents: AgentView[],
  phaseOrder: string[],
  j: any,
): WorkflowEvent[] {
  const evs: WorkflowEvent[] = [];
  const start = summary.createdAt ?? 0;
  evs.push({ type: "run_started", ts: start } as WorkflowEvent);
  for (const title of phaseOrder) evs.push({ type: "phase_started", ts: start, phase: title } as WorkflowEvent);
  for (const a of agents) {
    evs.push({ type: "agent_started", ts: a.startedAt ?? start, label: a.label, phase: a.phase, adapter: a.adapter } as WorkflowEvent);
    if (a.state === "failed") {
      evs.push({ type: "agent_failed", ts: a.finishedAt ?? start, label: a.label, phase: a.phase, error: a.error ?? "" } as WorkflowEvent);
    } else if (a.state === "done") {
      evs.push({ type: "agent_finished", ts: a.finishedAt ?? start, label: a.label, phase: a.phase, adapter: a.adapter, attempts: a.attempts } as WorkflowEvent);
    }
  }
  if (Array.isArray(j.logs)) {
    for (const l of j.logs) {
      const message = typeof l === "string" ? l : String(l?.message ?? l?.text ?? "");
      if (message) evs.push({ type: "log", ts: num(l?.ts) ?? start, message } as WorkflowEvent);
    }
  }
  const end = summary.updatedAt ?? start;
  evs.push({ type: summary.state === "failed" ? "run_failed" : "run_finished", ts: end } as WorkflowEvent);
  return evs.sort((a, b) => (num(a.ts) ?? 0) - (num(b.ts) ?? 0));
}

function liveName(sessDir: string, wid: string): string {
  for (const e of readdirSafe(join(sessDir, "workflows", "scripts"))) {
    if (e.isFile() && e.name.endsWith(`-${wid}.js`)) return e.name.slice(0, -`-${wid}.js`.length);
  }
  return "(claude workflow)";
}
function readScript(sessDir: string, wid: string): string | null {
  for (const e of readdirSafe(join(sessDir, "workflows", "scripts"))) {
    if (e.isFile() && e.name.endsWith(`-${wid}.js`)) {
      try {
        return readFileSync(join(sessDir, "workflows", "scripts", e.name), "utf8");
      } catch {
        return null;
      }
    }
  }
  return null;
}
/** A live agent's label: the one its journal gave, else a short id. */
function liveLabel(a: LiveAgent): string {
  return a.label ?? agentLabel(a.agentId, a.key);
}
function agentLabel(agentId: string | undefined, key: string): string {
  if (agentId) return `agent ${agentId.slice(0, 8)}`;
  return `agent ${key.replace(/^v2:/, "").slice(0, 8)}`;
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args ?? null;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}
function tsFromIso(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 1000 : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// --- fs primitives (read-only, never throw) ----------------------------------

/** A Claude journal is foreign JSON with a loose shape: read it untyped. */
function readJson(p: string): any | null {
  return readJsonFile<any>(p);
}
function readLines(p: string): Array<Record<string, any>> {
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, any>> = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // torn final line during a live append — skip; the next read sees it whole
    }
  }
  return out;
}
function mtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
function birthSec(p: string): number | null {
  try {
    const s = statSync(p);
    const ms = s.birthtimeMs || s.ctimeMs;
    return ms ? ms / 1000 : null;
  } catch {
    return null;
  }
}
