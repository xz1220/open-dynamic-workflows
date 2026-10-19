/**
 * The foreground run view: attach to a run directory and narrate it.
 *
 * `odw run` (interactive) and `odw attach` sit on top of this module. Attaching
 * NEVER changes the execution model — the worker stays a detached process and
 * this is just another reader of the run directory (same files as `odw logs`),
 * so Ctrl-C detaches the viewer and the run keeps going.
 *
 * Two renderers share one incremental timeline:
 *
 *   - live (stderr is a TTY): a permanent, chronological scrollback (phase
 *     markers, settled agents, log lines) plus a bounded, repainted active
 *     block (running agents + a summary footer). Every printed line is
 *     sanitized and hard-truncated to the terminal width, so the cursor-up
 *     arithmetic of the repaint is exact — one logical line is one physical
 *     line, always.
 *
 *   - line (anything else): plain, append-only event lines — the machine
 *     shape, identical in spirit to `odw logs --follow`.
 *
 * Stream discipline: ALL narration goes to stderr; stdout carries only the
 * final result JSON (on success), so `odw run … | jq .` keeps working even in
 * the live view.
 *
 * A checkpoint() waiting for a person (ODW extension) is narrated with the
 * exact `odw approve|reject` commands that answer it, and stays in the live
 * view's active block until it is answered.
 *
 * What the run spends (ODW extension) shows in the summary line: output
 * tokens — what `--budget` counts — and the running cost once agents that
 * report it have settled; each settled agent's line carries its own cost.
 *
 * An agent that fell back to another adapter (an ODW extension) shows the
 * adapters it went through — `codex → claude` — while it runs and once it
 * settled.
 *
 * A run paused for an adapter's spent quota (an ODW extension: quotaWait)
 * says until when in its summary line: "paused until 19:10 (codex quota)".
 */

import { formatSeconds } from "../adapters/failures.js";
import { addUsage, type Usage } from "../adapters/usage.js";
import type { WorkflowEvent } from "../events.js";
import { fanOutLine } from "../fanout.js";
import { limitLabel } from "../limits.js";
import { clockTime, pausedForOf, pausedText } from "../quota-wait.js";
import {
  cursor,
  detectCaps,
  fmtDuration,
  fmtElapsed,
  fmtTokens,
  fmtUsd,
  glyphs,
  padEndWidth,
  palette,
  sanitizeText,
  truncateToWidth,
  type Glyphs,
  type Palette,
  type TermCaps,
} from "../tty.js";
import { DEADLINE_EXIT_CODE, deadlineReport, stoppedByDeadline } from "./deadline.js";
import { RunObserver } from "./run-liveness.js";
import { RunStore, TERMINAL_STATES } from "./run-store.js";
import { applyAgentEvent, type AgentView, type SafetySnapshotView } from "./runs-view.js";

// --- mode resolution -----------------------------------------------------------

export type RunMode = "attach" | "wait" | "detach";

/** The one rule for CI/ODW_DETACH-style flags — init's prompt gate reuses it. */
export function envTruthy(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Decide what `odw run` does after starting the run.
 *
 * Explicit flags always win (and conflict loudly). Otherwise the default is
 * foreground-attach ONLY for a bare interactive invocation — both stdout and
 * stderr are TTYs and no CI/ODW_DETACH environment says otherwise. Every
 * captured, piped, cron, or agent-shell invocation keeps the historical
 * detach-and-print-the-id contract (`RUN=$(odw run …)` stays correct).
 */
export function resolveRunMode(
  flags: { fg?: boolean; detach?: boolean; wait?: boolean },
  io: { stdoutTTY: boolean; stderrTTY: boolean },
  env: Record<string, string | undefined>,
): { mode: RunMode } | { usageError: string } {
  const picked = [
    flags.fg ? "--fg" : null,
    flags.detach ? "--detach" : null,
    flags.wait ? "--wait" : null,
  ].filter((f): f is string => f !== null);
  if (picked.length > 1) {
    return { usageError: `${picked.join(" and ")} are mutually exclusive` };
  }
  if (flags.fg) return { mode: "attach" };
  if (flags.wait) return { mode: "wait" };
  if (flags.detach) return { mode: "detach" };
  if (envTruthy(env.ODW_DETACH)) return { mode: "detach" };
  if (envTruthy(env.CI)) return { mode: "detach" };
  return { mode: io.stdoutTTY && io.stderrTTY ? "attach" : "detach" };
}

// --- plain event formatting (shared with `odw logs`) -----------------------------

/** One event as a plain log line (no ANSI; event text sanitized). */
export function formatEvent(ev: WorkflowEvent): string {
  const stamp = new Date(((ev.ts as number) ?? 0) * 1000).toLocaleTimeString();
  const type = String(ev.type ?? "?");
  const phase = ev.phase ? ` (${sanitizeText(ev.phase, 80)})` : "";
  let detail = "";
  if (type === "log") detail = sanitizeText(ev.message, 300);
  else if (type === "phase_started") detail = `phase: ${sanitizeText(ev.phase, 80)}`;
  else if (type.startsWith("agent_")) {
    detail = sanitizeText(ev.label ?? "agent", 120) + fallbackTag(ev);
    if (type === "agent_failed") {
      const misses = missesOf(ev);
      detail += ` — ${failureTag(ev)}${misses ? sanitizeText(`did not meet: ${misses.join("; ")}`, 300) : sanitizeText(ev.error, 200)}`;
    }
    if (type === "agent_finished" && ev.cached === true) detail += ` (replayed from ${sanitizeText(ev.sourceRunId, 80)})`;
    // Tool calls its CLI refused under a reply that stood (ODW extension).
    const denied = type === "agent_finished" ? linesOf(ev.denied) : null;
    if (denied) detail += ` — refused: ${sanitizeText(denied.join("; "), 200)}`;
    // Background work its CLI left running under a reply that stood (ODW extension).
    const orphaned = type === "agent_finished" ? linesOf(ev.orphaned) : null;
    if (orphaned) detail += ` — left running: ${sanitizeText(orphaned.join("; "), 200)}`;
    // The models its CLI said served it (ODW extension; see ../served-model).
    const served = type === "agent_finished" ? linesOf(ev.servedModel) : null;
    if (served) detail += ` — served by ${sanitizeText(served.join(", "), 200)}`;
  } else if (type.startsWith("command_")) detail = commandDetail(ev, type);
  else if (type === "checkpoint_requested") {
    detail = `#${String(ev.checkpointId)} ${sanitizeText(ev.title, 200)}${ev.truncated === true ? " (payload truncated)" : ""}`;
  } else if (type === "checkpoint_resolved") detail = `#${String(ev.checkpointId)} ${answerText(ev)}`;
  // An adapter CLI's version, recorded on its first dispatch (ODW extension).
  else if (type === "cli_version") {
    detail = `${sanitizeText(ev.adapter, 40)}: ${sanitizeText(ev.version ?? `unknown (${String(ev.error ?? "?")})`, 160)}`;
  }
  // A CLI updated under the run; the host asleep, the stall timers started over (ODW extensions).
  else if (type === "cli_version_changed" || type === "host_suspended") detail = sanitizeText(ev.message, 400);
  // A note on the run's notes board (ODW extension; see ../notes).
  else if (type === "note_added") {
    const by = ev.by as { agentId?: unknown; label?: unknown } | undefined;
    detail = `#${String(ev.noteId)} ${sanitizeText(by?.label ?? "?", 60)}:${String(by?.agentId ?? "?")} ${sanitizeText(ev.text, 300)}`;
  }
  // The working tree's safety snapshot, and a destructive git command an agent ran (ODW extensions; see ../safety).
  else if (type === "safety_snapshot" || type === "destructive_git") detail = sanitizeText(ev.message, 400);
  // Another model served an agent than the one it asked for (ODW extension; see ../served-model).
  else if (type === "model_substituted") detail = sanitizeText(ev.message, 400);
  // An ACP agent's permission request, as its tier answered it (ODW extension; see ../adapters/acp).
  else if (type === "acp_permission") detail = sanitizeText(ev.message, 400);
  // How a parallel() or pipeline() came out (ODW extension; see ../fanout).
  else if (type === "fanout_done") detail = sanitizeText(fanOutLine(ev), 400);
  else detail = sanitizeText(ev.error ?? ev.runId ?? "", 200);
  return `[${stamp}] ${type.padEnd(15)}${phase} ${detail}`.trimEnd();
}

/**
 * Why an agent failed, ahead of its (truncated) error: `[rate_limit] `, or
 * `[quota, retry after 3h 22m] ` when the CLI said when; "" without a reason.
 */
function failureTag(ev: WorkflowEvent): string {
  if (typeof ev.reason !== "string" || ev.reason === "") return "";
  const after = typeof ev.retryAfter === "number" ? `, retry after ${formatSeconds(ev.retryAfter)}` : "";
  return `[${sanitizeText(ev.reason, 40)}${after}] `;
}

/** The adapters an agent fell back through, after its label: " (codex → claude)"; "" when it did not (ODW extension). */
function fallbackTag(ev: WorkflowEvent): string {
  const from = Array.isArray(ev.fellBackFrom) ? ev.fellBackFrom.filter((name) => typeof name === "string") : [];
  if (from.length === 0 || typeof ev.adapter !== "string") return "";
  return ` (${adapterPath(from, ev.adapter, "→")})`;
}

/** "codex → claude": the adapters an agent left, then the one it is on — each sanitized. */
function adapterPath(fellBackFrom: readonly string[], adapter: string, arrow: string): string {
  return [...fellBackFrom, adapter].map((name) => sanitizeText(name, 40)).join(` ${arrow} `);
}

/** How many agents that fell back `odw status` names; past them, a count. */
const FALLBACKS_NAMED = 5;

/**
 * What `odw status` says about fallbacks (ODW extensions): the agents that
 * moved down their fallback chain — "search:3 codex → claude" — and the
 * adapters the run's quota breaker took out. No lines for a run without either.
 */
export function fallbackLines(agents: AgentView[], events: WorkflowEvent[]): string[] {
  const lines: string[] = [];
  const moved = agents.filter((a) => a.kind === "agent" && a.adapter !== null && (a.fellBackFrom?.length ?? 0) > 0);
  if (moved.length > 0) {
    const named = moved
      .slice(0, FALLBACKS_NAMED)
      .map((a) => `${sanitizeText(a.label, 40)}:${a.agentId ?? "?"} ${adapterPath(a.fellBackFrom!, a.adapter!, "→")}`);
    const more = moved.length > FALLBACKS_NAMED ? `, and ${moved.length - FALLBACKS_NAMED} more` : "";
    lines.push(`fell back: ${moved.length} agent${moved.length === 1 ? "" : "s"} — ${named.join(", ")}${more}`);
  }
  const tripped = new Set<string>();
  for (const e of events) if (e.type === "log" && e.tripped === true && typeof e.adapter === "string") tripped.add(e.adapter);
  if (tripped.size > 0) {
    const names = [...tripped].map((name) => sanitizeText(name, 40)).join(", ");
    lines.push(`quota breaker: ${names} out of usage quota — the run's later agents skip ${tripped.size === 1 ? "it" : "them"}`);
  }
  return lines;
}

/**
 * What `odw status` says about accounts (ODW extension; see
 * ../adapters/accounts): per adapter with accounts — an agent's adapter
 * `claude@work` — how many agents ran on each, how many run there now, and
 * how many left it for another. No lines for a run without one.
 */
export function accountLines(agents: AgentView[]): string[] {
  const pools = new Map<string, Map<string, { on: number; running: number; left: number }>>();
  const tally = (account: string) => {
    const at = account.lastIndexOf("@");
    if (at <= 0) return undefined;
    const base = account.slice(0, at);
    if (!pools.has(base)) pools.set(base, new Map());
    const pool = pools.get(base)!;
    if (!pool.has(account)) pool.set(account, { on: 0, running: 0, left: 0 });
    return pool.get(account)!;
  };
  for (const a of agents) {
    if (a.kind !== "agent") continue;
    const on = a.adapter !== null ? tally(a.adapter) : undefined;
    if (on) {
      on.on += 1;
      if (a.state === "running") on.running += 1;
    }
    for (const left of new Set(a.fellBackFrom ?? [])) {
      const from = tally(left);
      if (from) from.left += 1;
    }
  }
  const plural = (n: number, what: string): string => `${n} ${what}${n === 1 ? "" : "s"}`;
  return [...pools.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([base, pool]) => {
      const parts = [...pool.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([name, t]) =>
          [
            `${sanitizeText(name, 40)} ${plural(t.on, "agent")}`,
            ...(t.running > 0 ? [`${t.running} running`] : []),
            ...(t.left > 0 ? [`${t.left} moved on (quota or login)`] : []),
          ].join(", "),
        );
      return `accounts of ${sanitizeText(base, 40)}: ${parts.join(" · ")}`;
    });
}

/** How many runaway agents `odw status` names; past them, a count. */
const RUNAWAYS_NAMED = 5;

/**
 * What `odw status` says about runaways (ODW extension; see ../limits): the
 * agents killed at one of their limits, each with the evidence — "fix:3
 * Bash `npm test` ×5 in a row (limits.repeat=5)". No line for a run without one.
 */
export function runawayLines(agents: AgentView[]): string[] {
  const hits = agents.filter((a) => a.kind === "agent" && a.limits?.hit);
  if (hits.length === 0) return [];
  const named = hits
    .slice(0, RUNAWAYS_NAMED)
    .map((a) => `${sanitizeText(a.label, 40)}:${a.agentId ?? "?"} ${sanitizeText(a.limits!.hit!.evidence, 120)} (${limitLabel(a.limits!.hit!)})`);
  const more = hits.length > RUNAWAYS_NAMED ? `, and ${hits.length - RUNAWAYS_NAMED} more` : "";
  return [`runaway: ${hits.length} agent${hits.length === 1 ? "" : "s"} killed at a limit — ${named.join(", ")}${more}`];
}

/**
 * What `odw status` says about agents that stopped to ask a question nobody
 * answered (reason "needs_input"; ODW extension, see ../questions): each, with
 * what it asked. No line for a run without one.
 */
export function needsInputLines(agents: AgentView[]): string[] {
  return agents
    .filter((a) => a.kind === "agent" && a.state === "failed" && a.failureReason === "needs_input")
    .slice(0, RUNAWAYS_NAMED)
    .map((a) => {
      const asked = a.questions?.length ? `: ${sanitizeText(a.questions.join("; "), 300)}` : "";
      return `needs input: ${sanitizeText(a.label, 40)}:${a.agentId ?? "?"} stopped to ask${asked}`;
    });
}

/**
 * What `odw status` says about the working tree's safety (ODW extension; see
 * ../safety): the run's snapshot, and the agents that ran destructive git
 * commands. No lines for a run without either.
 */
export function safetyLines(runId: string, agents: AgentView[], snapshot: SafetySnapshotView | undefined): string[] {
  const lines: string[] = [];
  if (snapshot) {
    lines.push(
      `safety snapshot: ${snapshot.tracked} changed and ${snapshot.untracked} untracked file(s) at ${sanitizeText(snapshot.ref, 120)} ` +
        `(${snapshot.commit.slice(0, 12)}) — odw restore ${runId} puts them back`,
    );
  }
  const ran = agents.filter((a) => a.kind === "agent" && (a.destructiveGit?.length ?? 0) > 0);
  if (ran.length > 0) {
    const named = ran
      .slice(0, RUNAWAYS_NAMED)
      .map((a) => `${sanitizeText(a.label, 40)}:${a.agentId ?? "?"} ${sanitizeText([...new Set(a.destructiveGit!.map((h) => h.what))].join(", "), 120)}`);
    const more = ran.length > RUNAWAYS_NAMED ? `, and ${ran.length - RUNAWAYS_NAMED} more` : "";
    lines.push(`destructive git: ${ran.length} agent${ran.length === 1 ? "" : "s"} — ${named.join(", ")}${more}`);
  }
  return lines;
}

/** The `expect` checks a failed agent's work missed (agent_failed's `misses`; ODW extension), or null. */
function missesOf(ev: WorkflowEvent): string[] | null {
  return linesOf(ev.misses);
}

/** An event's list of lines (`misses`, `denied`), or null when it has none. */
function linesOf(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const lines = raw.filter((line): line is string => typeof line === "string");
  return lines.length > 0 ? lines : null;
}

/** Misses listed under a failed agent in the live view, at most. */
const MAX_MISS_LINES = 5;

/**
 * What a run (or an agent) spent, in one line for people: "17.9k tokens in
 * (12.7k cache read, 5.1k cache write) · 812 out · $0.0387"; a `~` marks
 * output tokens that are (partly) chars/4 estimates.
 */
export function formatUsage(usage: Usage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    const cache = [
      usage.cacheReadTokens ? `${fmtTokens(usage.cacheReadTokens)} cache read` : null,
      usage.cacheWriteTokens ? `${fmtTokens(usage.cacheWriteTokens)} cache write` : null,
    ].filter((part): part is string => part !== null);
    parts.push(`${fmtTokens(usage.inputTokens)} tokens in${cache.length > 0 ? ` (${cache.join(", ")})` : ""}`);
  }
  if (usage.outputTokens !== undefined) {
    const tokens = usage.inputTokens === undefined ? " tokens" : "";
    parts.push(`${usage.estimated ? "~" : ""}${fmtTokens(usage.outputTokens)}${tokens} out`);
  }
  if (usage.costUsd !== undefined) parts.push(fmtUsd(usage.costUsd));
  return parts.join(" · ");
}

/**
 * The summary line's spend: output tokens (what `--budget` counts) and the
 * cost when known. A run whose events carry no usage (an older engine's)
 * shows status.json's estimate instead, as before.
 */
function spendParts(usage: Usage | undefined, status: Record<string, unknown>): Array<string | null> {
  if (!usage) {
    const spent = typeof status.spentTokens === "number" ? status.spentTokens : 0;
    return [spent > 0 ? `~${spent} tok` : null];
  }
  return [
    usage.outputTokens !== undefined ? `${usage.estimated ? "~" : ""}${fmtTokens(usage.outputTokens)} tok` : null,
    usage.costUsd !== undefined ? fmtUsd(usage.costUsd) : null,
  ];
}

/** A failure class in the live view's words; "exit" says no more than the error line below it. */
function reasonText(reason: string | undefined): string | null {
  if (!reason || reason === "exit") return null;
  const words: Record<string, string> = {
    rate_limit: "rate limited",
    network: "lost its connection",
    quota: "out of quota",
    auth: "not logged in",
    timeout: "timed out",
    stalled: "stalled",
    not_found: "CLI not found",
    permission: "permission denied",
    empty_reply: "empty reply",
    unmet_expectation: "expectations not met",
    runaway: "runaway",
    orphaned_background: "left background work running",
    out_of_scope: "wrote outside its scope",
    needs_input: "asked a question nobody answered",
    destructive_git: "ran a destructive git command",
    model_substituted: "served by another model",
  };
  return words[reason] ?? sanitizeText(reason.replace(/_/g, " "), 40);
}

/**
 * How a checkpoint was answered: "approved by cli — note", "approved with
 * edits by dashboard", "rejected by timeout", or — no answer — "not
 * answered: <why>".
 */
function answerText(ev: WorkflowEvent): string {
  if (ev.error != null) return `not answered: ${sanitizeText(ev.error, 200)}`;
  const note = typeof ev.note === "string" && ev.note !== "" ? ` — ${sanitizeText(ev.note, 200)}` : "";
  // Who answered, by name (ODW extension), beside the channel.
  const who = typeof ev.who === "string" && ev.who !== "" ? ` (${sanitizeText(ev.who, 120)})` : "";
  return `${verdictText(ev)} by ${sanitizeText(ev.by ?? "?", 20)}${who}${note}`;
}

/** "approved", "approved with edits" (an edited payload; ODW extension) or "rejected". */
function verdictText(ev: WorkflowEvent): string {
  return ev.approved !== true ? "rejected" : ev.edited === true ? "approved with edits" : "approved";
}

/**
 * The exact commands that answer checkpoint `checkpointId` of a run; `flags`
 * (e.g. `--runs-root <dir>`) make them find the run from where they are printed.
 */
export function checkpointCommands(
  runId: string,
  checkpointId: number,
  flags: string[] = [],
): { approve: string; reject: string } {
  const args = [runId, "--checkpoint", String(checkpointId), ...flags].map(shellArg).join(" ");
  return { approve: `odw approve ${args}`, reject: `odw reject ${args}` };
}

/** One argument as a POSIX shell would need it typed. */
export function shellArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * An exec() step as a log detail: its label and command when it starts (just
 * `$ command` when the label is the default, the command itself), then how it
 * ended — `exit 0`, or command_failed's error — and how long it took.
 */
function commandDetail(ev: WorkflowEvent, type: string): string {
  const command = sanitizeText(ev.command, 200);
  const label = sanitizeText(ev.label ?? command, 120);
  const labelIsCommand = label === command || (label.endsWith("…") && command.startsWith(label.slice(0, -1)));
  const name = labelIsCommand ? `$ ${command}` : label;
  if (type === "command_started") return labelIsCommand || command === "" ? name : `${name} — $ ${command}`;
  const outcome = type === "command_finished" ? `exit ${String(ev.exitCode ?? 0)}` : sanitizeText(ev.error ?? "failed", 200);
  const took = typeof ev.durationMs === "number" ? ` (${fmtDuration(ev.durationMs)})` : "";
  return `${name} — ${outcome}${took}`;
}

// --- the live renderer -----------------------------------------------------------

interface StreamLike {
  write(chunk: string): void;
  isTTY?: boolean;
  columns?: number;
}

/** Meta fragments joined with a separator dot; null/empty fragments drop out. */
function metaJoin(g: Glyphs, parts: Array<string | null>): string {
  return parts.filter((x): x is string => x !== null && x !== "").join(` ${g.bullet} `);
}

/** A node's label in the terminal: exec() command steps get a shell prompt. */
function nodeLabel(a: AgentView): string {
  return a.kind === "command" ? `$ ${a.label}` : a.label;
}

class LiveView {
  private readonly agents: AgentView[] = [];
  /** checkpoint() calls waiting for an answer: id → title (sanitized). */
  private readonly asked = new Map<number, string>();
  private blockLines = 0;
  private tick = 0;
  private labelW = 8;
  private currentPhase: string | null = null;
  private done = 0;
  private failed = 0;
  /** What the settled agents spent, from their events' `usage`. */
  private usage: Usage | undefined;
  runStartTs: number | null = null;

  constructor(
    private readonly runId: string,
    private readonly name: string,
    caps: TermCaps,
    private readonly err: StreamLike,
    private readonly now: () => number,
    /** What the printed `odw approve|reject` commands need to find the run (`--runs-root`). */
    private readonly commandFlags: string[] = [],
    private readonly p: Palette = palette(caps),
    private readonly g: Glyphs = glyphs(caps),
  ) {}

  private width(): number {
    const cols = this.err.columns;
    return typeof cols === "number" && cols > 0 ? cols : 80;
  }

  private line(s: string): string {
    return truncateToWidth(s, this.width());
  }

  /** Erase the active block (cursor returns to the end of the scrollback). */
  eraseBlock(): void {
    if (this.blockLines > 0) {
      this.err.write(cursor.up(this.blockLines) + cursor.toCol1 + cursor.eraseDown);
      this.blockLines = 0;
    }
  }

  /**
   * Abandon the active block without erasing it. After a terminal resize the
   * old physical line count is unknowable (rewrap), so cursor-up erasure could
   * eat scrollback; leaving one stale block behind is the safe failure mode.
   */
  abandonBlock(): void {
    this.blockLines = 0;
  }

  private permanent(lines: string[]): void {
    for (const l of lines) this.err.write(this.line(l) + "\n");
  }

  /** The run's name and id, how to detach — and, for a run just started, its banner lines (permissions, concurrency). */
  header(banner?: string): void {
    const { p, g } = this;
    this.permanent([
      `${p.accent(g.header)} ${p.bold(this.name)}  ${p.dim(this.runId)}`,
      `  ${p.dim(`^C detaches (run keeps going) ${g.bullet} odw attach ${this.runId}`)}`,
      ...bannerLines(banner).map((line) => `  ${p.dim(line)}`),
    ]);
  }

  /** Fold new events into the timeline; print their permanent lines. */
  applyEvents(events: WorkflowEvent[]): void {
    const { p, g } = this;
    const out: string[] = [];
    for (const ev of events) {
      if (ev.type === "run_started" && typeof ev.ts === "number") this.runStartTs = ev.ts;
      if (ev.type === "phase_started") {
        this.currentPhase = ev.phase != null ? String(ev.phase) : null;
        const title = sanitizeText(ev.phase, 120);
        const ruleW = Math.max(0, Math.min(this.width() - 4 - title.length, 46 - title.length));
        out.push("", `  ${p.bold(title)} ${p.dim(g.rule.repeat(Math.max(2, ruleW)))}`);
        continue;
      }
      if (ev.type === "log") {
        out.push(`    ${p.dim(`${g.bullet} ${sanitizeText(ev.message, 300)}`)}`);
        // A fallback's line moves its running agent to the next adapter (ODW extension).
        applyAgentEvent(this.agents, ev);
        continue;
      }
      // The working tree's safety snapshot, and a destructive git command an agent ran (ODW extensions; see ../safety).
      if (ev.type === "safety_snapshot" || ev.type === "destructive_git") {
        const line = `${g.bullet} ${sanitizeText(ev.message, 400)}`;
        out.push(`    ${ev.type === "destructive_git" ? p.err(line) : p.dim(line)}`);
        applyAgentEvent(this.agents, ev);
        continue;
      }
      // Another model served an agent than the one it asked for (ODW extension; see ../served-model).
      if (ev.type === "model_substituted") {
        out.push(`    ${p.run(`${g.bullet} ${sanitizeText(ev.message, 400)}`)}`);
        applyAgentEvent(this.agents, ev);
        continue;
      }
      // An ACP agent's permission request, as its tier answered it (ODW extension): amber unless allowed.
      if (ev.type === "acp_permission") {
        const line = `${g.bullet} ${sanitizeText(ev.message, 400)}`;
        out.push(`    ${ev.decision === "allowed" ? p.dim(line) : p.run(line)}`);
        continue;
      }
      // How a parallel() or pipeline() came out (ODW extension; see ../fanout): amber when most of it is null.
      if (ev.type === "fanout_done") {
        const line = `${g.bullet} ${sanitizeText(fanOutLine(ev), 400)}`;
        const bad = ev.belowMinOk === true || (typeof ev.total === "number" && (Number(ev.failed) + Number(ev.null)) * 2 > ev.total);
        out.push(`    ${bad ? p.run(line) : p.dim(line)}`);
        continue;
      }
      if (ev.type === "checkpoint_requested" && typeof ev.checkpointId === "number") {
        const title = sanitizeText(ev.title, 120);
        this.asked.set(ev.checkpointId, title);
        const { approve, reject } = checkpointCommands(this.runId, ev.checkpointId, this.commandFlags);
        // An agent's question is answered with a note (ODW extension; see ../questions).
        const asking = ev.question !== undefined && ev.question !== null;
        out.push(
          `    ${p.run(g.wait)} ${p.bold(title)}  ${p.dim(`checkpoint #${ev.checkpointId} ${g.bullet} ${asking ? "an agent asks" : "waiting for a decision"}`)}`,
          `      ${p.dim(asking ? `answer:  ${approve} --note '<answer>'` : `approve: ${approve}`)}`,
          `      ${p.dim(asking ? `decline: ${reject}` : `reject:  ${reject}`)}`,
        );
        continue;
      }
      if (ev.type === "checkpoint_resolved" && typeof ev.checkpointId === "number") {
        const title = this.asked.get(ev.checkpointId) ?? `checkpoint #${ev.checkpointId}`;
        this.asked.delete(ev.checkpointId);
        out.push(this.answeredLine(title, ev));
        continue;
      }
      const { opened, settled } = applyAgentEvent(this.agents, ev);
      if (opened) {
        const w = sanitizeText(nodeLabel(opened), 60).length;
        this.labelW = Math.max(this.labelW, Math.min(24, w));
      }
      if (settled) {
        if (settled.state === "done") this.done++;
        else this.failed++;
        if (settled.usage) this.usage = addUsage(this.usage, settled.usage);
        out.push(this.settledLine(settled));
        if (settled.state === "failed" && settled.misses?.length) {
          // What its work missed, one check a line, says more than the error that lists them.
          for (const miss of settled.misses.slice(0, MAX_MISS_LINES)) {
            out.push(`      ${p.err(`${g.fail} ${sanitizeText(miss, 200)}`)}`);
          }
          const more = settled.misses.length - MAX_MISS_LINES;
          if (more > 0) out.push(`      ${p.dim(`… ${more} more`)}`);
        } else if (settled.state === "failed" && settled.error) {
          out.push(`      ${p.err(sanitizeText(settled.error, 200))}`);
        }
      }
    }
    if (out.length > 0) {
      this.eraseBlock();
      this.permanent(out);
    }
  }

  /** The adapter a node runs (or ran) on, after any it fell back from (ODW extension): "codex → claude". */
  private adapterText(a: AgentView): string | null {
    if (a.adapter === null) return null;
    return adapterPath(a.fellBackFrom ?? [], a.adapter, this.g.arrow);
  }

  private settledLine(a: AgentView): string {
    const { p, g } = this;
    const label = padEndWidth(sanitizeText(nodeLabel(a), 60), this.labelW);
    const glyph = a.state === "done" ? p.ok(g.ok) : p.err(g.fail);
    const meta = metaJoin(g, [
      a.phase !== null && a.phase !== this.currentPhase ? sanitizeText(a.phase, 40) : null,
      this.adapterText(a),
      a.state === "failed" ? reasonText(a.failureReason) : null,
      // A replayed result (odw resume) took no time and ran nothing.
      a.cached ? "replayed" : a.durationMs !== null ? fmtDuration(a.durationMs) : null,
      !a.cached && a.attempts !== null && a.attempts > 1 ? `${a.attempts} tries` : null,
      a.usage?.costUsd !== undefined ? fmtUsd(a.usage.costUsd) : null,
      // Its reply stood though its CLI refused tool calls (ODW extension): the log line before says which.
      a.state === "done" && a.denied?.length ? `${a.denied.length === 1 ? "1 tool call" : `${a.denied.length} tool calls`} refused` : null,
      // Its reply stood though its CLI left background work running (ODW extension).
      a.state === "done" && a.orphaned?.length ? `${a.orphaned.length === 1 ? "1 background task" : `${a.orphaned.length} background tasks`} orphaned` : null,
    ]);
    return `    ${glyph} ${label}  ${p.dim(meta)}`;
  }

  /** A checkpoint's answer in the scrollback: approved, rejected, or not answered (the run ended first). */
  private answeredLine(title: string, ev: WorkflowEvent): string {
    const { p, g } = this;
    if (ev.error != null) {
      return `    ${p.err(g.fail)} ${title}  ${p.dim(`not answered ${g.bullet} ${sanitizeText(ev.error, 160)}`)}`;
    }
    const approved = ev.approved === true;
    const meta = metaJoin(g, [
      verdictText(ev),
      `by ${sanitizeText(ev.by ?? "?", 20)}`,
      typeof ev.note === "string" && ev.note !== "" ? `"${sanitizeText(ev.note, 120)}"` : null,
    ]);
    return `    ${approved ? p.ok(g.ok) : p.run(g.stop)} ${title}  ${p.dim(meta)}`;
  }

  /** Redraw the active block (running agents + footer). Call every frame. */
  repaint(status: Record<string, unknown>, control: string | null): void {
    const { p, g } = this;
    this.tick++;
    const spin = g.spinner[this.tick % g.spinner.length]!;
    const running = this.agents.filter((a) => a.state === "running");
    const nowSec = this.now() / 1000;

    const block: string[] = [""];
    for (const a of running) {
      const label = padEndWidth(sanitizeText(nodeLabel(a), 60), this.labelW);
      // One waiting out a spent quota (quotaWait) is not working: it says until when.
      const wait = a.quotaWait;
      const meta = metaJoin(g, [
        a.phase !== null && a.phase !== this.currentPhase ? sanitizeText(a.phase, 40) : null,
        this.adapterText(a),
        wait
          ? `waits for ${sanitizeText(wait.adapter, 40)} quota${wait.resumeAt !== undefined ? ` until ${clockTime(wait.resumeAt, this.now())}` : ""}`
          : a.startedAt !== null
            ? fmtDuration((nowSec - a.startedAt) * 1000)
            : null,
      ]);
      block.push(`    ${wait ? p.run(g.wait) : p.run(spin)} ${label}  ${p.dim(meta)}`);
    }
    // Every question still open, with the command that answers it.
    for (const [id, title] of this.asked) {
      const { approve } = checkpointCommands(this.runId, id, this.commandFlags);
      block.push(`    ${p.run(g.wait)} ${title}  ${p.dim(`#${id} ${g.bullet} ${approve}`)}`);
    }

    const paused = status.state === "paused";
    // Paused for a spent quota (ODW extension: quotaWait): until when, and for which adapter.
    const pausedFor = paused ? pausedForOf(status.pausedFor) : null;
    const stopping = control === "stop" && !TERMINAL_STATES.has(String(status.state));
    const startSec = this.runStartTs ?? nowSec;
    const parts = metaJoin(g, [
      `${running.length} running`,
      `${this.done} done`,
      this.failed > 0 ? p.err(`${this.failed} failed`) : null,
      this.asked.size > 0 ? p.run(`${this.asked.size} waiting for a decision`) : null,
      ...spendParts(this.usage, status),
      fmtElapsed((nowSec - startSec) * 1000),
      stopping ? p.run("stopping…") : null,
      paused ? p.run(pausedFor ? sanitizeText(pausedText(pausedFor, this.now()), 80) : "paused") : null,
    ]);
    const head = paused ? p.run(g.stop) : running.length === 0 && this.asked.size > 0 ? p.run(g.wait) : p.run(spin);
    block.push(`  ${head} ${p.dim(parts)}`);

    this.eraseBlock();
    for (const l of block) this.err.write(this.line(l) + "\n");
    this.blockLines = block.length;
  }

  /** Replace the active block with the run's final one-line verdict. */
  finalize(state: string, status: Record<string, unknown>, error: string | null): void {
    const { p, g } = this;
    this.eraseBlock();
    const nowSec = this.now() / 1000;
    const startSec = this.runStartTs ?? nowSec;
    const commands = this.agents.filter((a) => a.kind === "command").length;
    const meta = metaJoin(g, [
      `${this.agents.length - commands} agents`,
      commands > 0 ? `${commands} commands` : null,
      this.failed > 0 ? p.err(`${this.failed} failed`) : null,
      ...spendParts(this.usage, status),
      fmtElapsed((nowSec - startSec) * 1000),
    ]);
    const lines: string[] = [""];
    if (state === "done") lines.push(`  ${p.ok(`${g.ok} done`)}  ${p.dim(meta)}`);
    else if (state === "failed") {
      lines.push(`  ${p.err(`${g.fail} failed`)}  ${p.dim(meta)}`);
      if (error) lines.push(`  ${p.err(sanitizeText(error, 300))}`);
    } else if (state === "stopped") lines.push(`  ${p.err(`${g.stop} stopped`)}  ${p.dim(meta)}`);
    else lines.push(`  ${p.dim(`${g.bullet} ${state}`)}  ${p.dim(meta)}`);
    lines.push("");
    this.permanent(lines);
  }

  /** A dim note above the (erased) active block — detach / timeout messaging. */
  note(text: string): void {
    this.eraseBlock();
    this.permanent(["", `  ${this.p.dim(text)}`, ""]);
  }
}

// --- the attach loop --------------------------------------------------------------

export interface AttachOptions {
  out: StreamLike;
  err: StreamLike;
  /** Live TTY rendering; defaults to `err.isTTY`. */
  live?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Install SIGINT/SIGTERM/SIGHUP handlers (default true; tests pass false). */
  signals?: boolean;
  /** Platform override for tests (default process.platform). */
  platform?: NodeJS.Platform;
  /** Flags the printed `odw approve|reject` commands need to find the run (e.g. `--runs-root <dir>`). */
  commandFlags?: string[];
  /**
   * Lines about the run that just started — its permissions, its concurrency
   * (ODW extensions) — one per line of the string, printed before its events.
   */
  banner?: string;
}

/** A start banner's lines, each sanitized for the terminal; none for no banner. */
export function bannerLines(banner: string | undefined): string[] {
  return (banner ?? "")
    .split("\n")
    .map((line) => sanitizeText(line, 1000))
    .filter((line) => line !== "");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Attach to a run and render it until it settles (or we detach). Returns the
 * process exit code: 0 done, 1 failed/stopped/vanished, 3 stopped by its --deadline, 124 timeout, 130
 * detached by Ctrl-C. The run itself is never affected by detaching.
 */
export async function attachRun(
  store: RunStore,
  runId: string,
  opts: AttachOptions,
): Promise<number> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  // Live rendering needs real cursor control, not just a TTY: TERM=dumb (or no
  // TERM at all) gets the plain line stream even under --fg. Windows consoles
  // set no TERM yet handle VT sequences (Node enables them), like detectCaps.
  const platform = opts.platform ?? process.platform;
  const cursorCapable =
    opts.err.isTTY === true && (env.TERM === undefined ? platform === "win32" : env.TERM !== "dumb");
  const live = (opts.live ?? opts.err.isTTY === true) && cursorCapable;
  const caps = detectCaps(opts.err, env, platform);
  const pollMs = opts.pollMs ?? (live ? 120 : 250);
  const attachStart = now();
  const deadline = opts.timeoutMs !== undefined ? attachStart + opts.timeoutMs : null;

  const status0 = store.readStatus(runId);
  const meta0 = store.readMeta(runId);
  // meta.name is workflow-author-controlled: sanitize before it touches the
  // terminal, like every other event-derived string.
  const name = sanitizeText(
    (status0.name as string) ||
      String(meta0.script ?? "")
        .split(/[\\/]/)
        .pop() ||
      runId,
    80,
  );

  const view = live ? new LiveView(runId, name, caps, opts.err, now, opts.commandFlags) : null;

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  const cleanupSignals: Array<() => void> = [];
  const restoreScreen = () => {
    if (view) {
      view.eraseBlock();
      opts.err.write(cursor.show);
    }
  };
  if (opts.signals !== false) {
    process.on("SIGINT", onSigint);
    cleanupSignals.push(() => process.removeListener("SIGINT", onSigint));
    for (const [sig, code] of [
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const) {
      const h = () => {
        restoreScreen();
        process.exit(code);
      };
      process.on(sig, h);
      cleanupSignals.push(() => process.removeListener(sig, h));
    }
    // Ctrl-Z must not park the shell with a hidden cursor: restore the screen,
    // re-raise the default suspend, and re-arm on resume.
    const onTstp = () => {
      restoreScreen();
      process.removeListener("SIGTSTP", onTstp);
      process.kill(process.pid, "SIGTSTP");
      process.on("SIGTSTP", onTstp);
    };
    const onCont = () => {
      if (view) {
        opts.err.write(cursor.hide);
        view.abandonBlock(); // repaint fresh on the next frame
      }
    };
    process.on("SIGTSTP", onTstp);
    process.on("SIGCONT", onCont);
    cleanupSignals.push(() => process.removeListener("SIGTSTP", onTstp));
    cleanupSignals.push(() => process.removeListener("SIGCONT", onCont));
  }

  // A resize rewraps old physical lines, making the cursor-up count a lie —
  // abandon the block instead of corrupting scrollback (see abandonBlock).
  const errStream = opts.err as { on?: Function; removeListener?: Function };
  const onResize = () => view?.abandonBlock();
  if (view && typeof errStream.on === "function") {
    errStream.on("resize", onResize);
    cleanupSignals.push(() => errStream.removeListener?.("resize", onResize));
  }

  if (view) {
    opts.err.write(cursor.hide);
    view.header(opts.banner);
  } else {
    for (const line of bannerLines(opts.banner)) opts.err.write(line + "\n");
  }

  const observer = new RunObserver(store, runId, now);

  const finishLine = (code: number, cleanup: () => void): number => {
    cleanup();
    return code;
  };
  const cleanup = () => {
    for (const c of cleanupSignals) c();
    if (view) opts.err.write(cursor.show);
  };

  try {
    for (;;) {
      const observed = observer.read();
      if (view) view.applyEvents(observed.events);
      else {
        for (const ev of observed.events) {
          opts.err.write(formatEvent(ev) + "\n");
          if (ev.type === "checkpoint_requested" && typeof ev.checkpointId === "number") {
            const { approve, reject } = checkpointCommands(runId, ev.checkpointId, opts.commandFlags);
            // An agent's question is answered with a note (ODW extension; see ../questions).
            if (ev.question) opts.err.write(`  answer:  ${approve} --note '<answer>'\n  decline: ${reject}\n`);
            else opts.err.write(`  approve: ${approve}\n  reject:  ${reject}\n`);
          }
        }
      }
      const status = observed.status;
      const state = String(status.state ?? "");
      const control = store.readControl(runId);
      const note = observed.error ?? observed.note;
      if (note) {
        if (view) view.note(note);
        else opts.err.write(note + "\n");
      }
      if (observed.error) return finishLine(1, cleanup);
      if (observed.terminal) {
        return finishLine(await settle(store, runId, state, status, view, opts), cleanup);
      }

      if (view) view.repaint(status, control);

      if (interrupted) {
        const msg = `detached — run continues in the background (odw attach ${runId})`;
        if (view) view.note(msg);
        else opts.err.write(msg + "\n");
        return finishLine(130, cleanup);
      }
      if (deadline !== null && now() >= deadline) {
        const secs = Math.round((opts.timeoutMs ?? 0) / 1000);
        const msg = `timed out after ${secs}s — run continues (odw attach ${runId})`;
        if (view) view.note(msg);
        else opts.err.write(msg + "\n");
        return finishLine(124, cleanup);
      }

      await sleep(pollMs);
    }
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Terminal-state wrap-up: final paint, result/error to the right stream, code. */
async function settle(
  store: RunStore,
  runId: string,
  state: string,
  status: Record<string, unknown>,
  view: LiveView | null,
  opts: AttachOptions,
): Promise<number> {
  // Drain any events that landed between the last poll and the status flip, so
  // the scrollback shows every agent settled before the verdict line.
  // (A fresh cursor would re-print everything; reuse is handled by the caller's
  // cursor already being past — we only need the final repaint here.)
  const error = store.readError(runId);
  const errText = typeof status.error === "string" ? status.error
    : error && typeof error.error === "string" ? error.error : null;
  if (view) view.finalize(state, status, errText);

  if (state === "done") {
    // result.json is written just before the status flip; tolerate a beat.
    for (let i = 0; i < 10 && !store.hasResult(runId); i++) await sleep(100);
    opts.out.write(JSON.stringify(store.readResult(runId), null, 2) + "\n");
    return 0;
  }
  // Stopped by its --deadline (ODW extension): what it finished, and exit 3.
  if (stoppedByDeadline({ ...status, state })) {
    const report = deadlineReport(store, runId);
    opts.out.write(JSON.stringify(report, null, 2) + "\n");
    if (!view) opts.err.write(`run was stopped at its deadline (--deadline ${String(report.deadline)}); finished agents kept: ${(report.finished as unknown[]).length}\n`);
    return DEADLINE_EXIT_CODE;
  }
  if (!view) {
    if (state === "failed") opts.err.write(`run failed: ${sanitizeText(errText ?? "unknown error", 300)}\n`);
    else if (state === "stopped") opts.err.write("run was stopped before completion\n");
  }
  return 1;
}
