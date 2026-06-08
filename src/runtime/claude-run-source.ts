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
 * half-written journal is skipped, never fatal — same posture as RunStore.readJson
 * and workflows-view's readMetaSafe). Units: every journal epoch is MILLISECONDS;
 * ODW uses seconds, so each timestamp is /1000 — EXCEPT `durationMs`, which is
 * already ms and maps 1:1 onto AgentView.durationMs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { WorkflowEvent } from "../events.js";
import type { RunSource } from "./run-source.js";
import type { AgentView, RunCounts, RunDetail, RunDisplayState, RunSummary } from "./runs-view.js";

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

const RUN_ID = /^[A-Za-z0-9._-]+$/;
const ID_PREFIX = "cc-";
const DEFAULT_FRESH_MS = 90_000;

/** A discovered run: where it lives and whether it is still in flight. */
interface Discovered {
  runId: string; // cc-<wid>
  wid: string; // wf_<...>
  sessDir: string;
  kind: "terminal" | "live";
  /** terminal: the wf_<id>.json path; live: the wf_<id>/ dir path. */
  path: string;
}

export class ClaudeRunSource implements RunSource {
  readonly provider = "claude" as const;
  readonly controlError = "Claude Code runs are read-only here — observe only.";

  private readonly freshMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { sig: string; value: RunSummary }>();

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
      const sig = this.signature(d);
      const hit = this.cache.get(d.runId);
      if (hit && hit.sig === sig) {
        out.push(hit.value);
        continue;
      }
      const value = this.summary(d);
      if (!value) continue;
      this.cache.set(d.runId, { sig, value });
      out.push(value);
    }
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
    return out;
  }

  detail(runId: string): RunDetail | null {
    const d = this.find(runId);
    return d ? this.fold(d).detail : null;
  }
  events(runId: string, since: number): WorkflowEvent[] {
    const d = this.find(runId);
    if (!d) return [];
    return this.fold(d).events.slice(Math.max(0, since));
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

  // --- discovery -------------------------------------------------------------

  /** The project dirs to scan: all of them, or the served repo + its worktrees. */
  private projectDirs(): string[] {
    const root = this.opts.projectsRoot;
    if (!existsSync(root)) return [];
    const entries = safeReaddir(root).filter((e) => e.isDirectory());
    if ((this.opts.scope ?? "all") === "all") return entries.map((e) => join(root, e.name));
    const base = encodeProjectDir(this.opts.cwd);
    const worktreePrefix = `${base}--claude-worktrees-`;
    return entries
      .filter((e) => e.name === base || e.name.startsWith(worktreePrefix))
      .map((e) => join(root, e.name));
  }

  /** Every Claude run visible from the configured scope, terminal and live. */
  private discover(): Discovered[] {
    const out: Discovered[] = [];
    for (const projDir of this.projectDirs()) {
      for (const sess of safeReaddir(projDir)) {
        if (!sess.isDirectory() || !RUN_ID.test(sess.name)) continue;
        const sessDir = join(projDir, sess.name);
        // terminal journals
        for (const f of safeReaddir(join(sessDir, "workflows"))) {
          if (!f.isFile() || !/^wf_.+\.json$/.test(f.name)) continue;
          const wid = f.name.slice(0, -".json".length);
          out.push({ runId: ID_PREFIX + wid, wid, sessDir, kind: "terminal", path: join(sessDir, "workflows", f.name) });
        }
        // live dirs — running iff no terminal sibling exists yet
        for (const d of safeReaddir(join(sessDir, "subagents", "workflows"))) {
          if (!d.isDirectory() || !/^wf_/.test(d.name)) continue;
          const wid = d.name;
          if (existsSync(join(sessDir, "workflows", `${wid}.json`))) continue; // terminal wins
          out.push({ runId: ID_PREFIX + wid, wid, sessDir, kind: "live", path: join(sessDir, "subagents", "workflows", wid) });
        }
      }
    }
    return out;
  }

  /** Locate one run by id within the current scope (used by detail/events/result). */
  private find(runId: string): Discovered | null {
    if (!this.owns(runId)) return null;
    return this.discover().find((d) => d.runId === runId) ?? null;
  }

  /** Cheap freshness fingerprint: terminal keys on the journal file; live on the dir's newest mtime. */
  private signature(d: Discovered): string {
    if (d.kind === "terminal") return `T:${statSig(d.path)}`;
    let newest = statSig(join(d.path, "journal.jsonl"));
    for (const f of safeReaddir(d.path)) {
      if (f.isFile() && f.name.startsWith("agent-")) {
        const s = statSig(join(d.path, f.name));
        if (s > newest) newest = s;
      }
    }
    return `L:${newest}`;
  }

  // --- folding ---------------------------------------------------------------

  private summary(d: Discovered): RunSummary | null {
    return d.kind === "terminal" ? this.foldTerminal(d).summary : this.foldLive(d).summary;
  }
  private fold(d: Discovered): { summary: RunSummary; detail: RunDetail; events: WorkflowEvent[] } {
    return d.kind === "terminal" ? this.foldTerminal(d) : this.foldLive(d);
  }

  private foldTerminal(d: Discovered): { summary: RunSummary; detail: RunDetail; events: WorkflowEvent[] } {
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
        label: String(a.label ?? a.agentId ?? "agent"),
        phase: a.phaseTitle != null ? String(a.phaseTitle) : null,
        state: mapAgentState(a.state),
        adapter: a.model != null ? String(a.model) : null,
        attempts: num(a.attempt),
        error: a.error != null ? String(a.error) : null,
        startedAt,
        finishedAt: startedAt != null && durationMs != null ? startedAt + durationMs / 1000 : null,
        durationMs,
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
    };
    const events = synthTerminalEvents(summary, agents, phaseOrder, j);
    return { summary, detail, events };
  }

  private foldLive(d: Discovered): { summary: RunSummary; detail: RunDetail; events: WorkflowEvent[] } {
    const lines = readLines(join(d.path, "journal.jsonl"));
    // Pair by `key` (the stable v2 prompt-hash); an agent is RUNNING iff its LAST line is "started".
    const last = new Map<string, Record<string, any>>();
    for (const l of lines) if (l && typeof l.key === "string") last.set(l.key, l);
    const running: Array<{ key: string; agentId?: string }> = [];
    let done = 0;
    for (const [key, l] of last) {
      if (l.type === "started") running.push({ key, agentId: l.agentId });
      else done++;
    }
    const nowMs = this.now();
    const journalFresh = nowMs - mtimeMs(join(d.path, "journal.jsonl")) < this.freshMs;
    const anyAgentFresh = running.some(
      (r) => r.agentId != null && nowMs - mtimeMs(join(d.path, `agent-${r.agentId}.jsonl`)) < this.freshMs,
    );
    const alive = running.length > 0 ? anyAgentFresh || journalFresh : journalFresh;
    const state: RunDisplayState = alive ? "running" : "stale";

    const agents: AgentView[] = [
      ...running.map(
        (r): AgentView => ({
          label: agentLabel(r.agentId, r.key),
          phase: null,
          state: alive ? "running" : "stale",
          adapter: null,
          attempts: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
        }),
      ),
      ...Array.from({ length: done }, (): AgentView => ({
        label: "agent",
        phase: null,
        state: "done",
        adapter: null,
        attempts: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      })),
    ];
    const counts: RunCounts = {
      agents: running.length + done,
      running: alive ? running.length : 0,
      done,
      failed: 0,
      stale: alive ? 0 : running.length,
    };
    const created = birthSec(d.path);
    const updatedAt = mtimeMs(join(d.path, "journal.jsonl")) / 1000 || created;

    const summary: RunSummary = {
      runId: d.runId,
      provider: "claude",
      state,
      rawState: "running",
      stale: state === "stale",
      name: liveName(d.sessDir, d.wid),
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
      script: readScript(d.sessDir, d.wid),
      args: null,
      agents,
      phaseOrder: [],
      hasResult: false,
      error: null,
    };
    const events: WorkflowEvent[] = [
      { type: "run_started", ts: created } as WorkflowEvent,
      ...agents
        .filter((a) => a.state === "running" || a.state === "stale")
        .map((a) => ({ type: "agent_started", ts: updatedAt, label: a.label }) as WorkflowEvent),
    ];
    return { summary, detail, events };
  }
}

// --- module helpers ----------------------------------------------------------

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

function countAgents(agents: AgentView[]): RunCounts {
  let running = 0,
    done = 0,
    failed = 0,
    stale = 0;
  for (const a of agents) {
    if (a.state === "running") running++;
    else if (a.state === "done") done++;
    else if (a.state === "failed") failed++;
    else stale++;
  }
  return { agents: agents.length, running, done, failed, stale };
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
  for (const e of safeReaddir(join(sessDir, "workflows", "scripts"))) {
    if (e.isFile() && e.name.endsWith(`-${wid}.js`)) return e.name.slice(0, -`-${wid}.js`.length);
  }
  return "(claude workflow)";
}
function readScript(sessDir: string, wid: string): string | null {
  for (const e of safeReaddir(join(sessDir, "workflows", "scripts"))) {
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

function safeReaddir(p: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
function readJson(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
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
function statSig(p: string): string {
  try {
    const s = statSync(p);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "-";
  }
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
