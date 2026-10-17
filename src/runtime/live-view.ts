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
 */

import type { WorkflowEvent } from "../events.js";
import {
  cursor,
  detectCaps,
  fmtDuration,
  fmtElapsed,
  glyphs,
  padEndWidth,
  palette,
  sanitizeText,
  truncateToWidth,
  type Glyphs,
  type Palette,
  type TermCaps,
} from "../tty.js";
import { RunObserver } from "./run-liveness.js";
import { RunStore, TERMINAL_STATES } from "./run-store.js";
import { applyAgentEvent, type AgentView } from "./runs-view.js";

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
    detail = sanitizeText(ev.label ?? "agent", 120);
    if (type === "agent_failed") detail += ` — ${sanitizeText(ev.error, 200)}`;
  } else detail = sanitizeText(ev.error ?? ev.runId ?? "", 200);
  return `[${stamp}] ${type.padEnd(15)}${phase} ${detail}`.trimEnd();
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

class LiveView {
  private readonly agents: AgentView[] = [];
  private blockLines = 0;
  private tick = 0;
  private labelW = 8;
  private currentPhase: string | null = null;
  private done = 0;
  private failed = 0;
  runStartTs: number | null = null;

  constructor(
    private readonly runId: string,
    private readonly name: string,
    caps: TermCaps,
    private readonly err: StreamLike,
    private readonly now: () => number,
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

  header(): void {
    const { p, g } = this;
    this.permanent([
      `${p.accent(g.header)} ${p.bold(this.name)}  ${p.dim(this.runId)}`,
      `  ${p.dim(`^C detaches (run keeps going) ${g.bullet} odw attach ${this.runId}`)}`,
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
        continue;
      }
      const { opened, settled } = applyAgentEvent(this.agents, ev);
      if (opened) {
        const w = sanitizeText(opened.label, 60).length;
        this.labelW = Math.max(this.labelW, Math.min(24, w));
      }
      if (settled) {
        if (settled.state === "done") this.done++;
        else this.failed++;
        out.push(this.settledLine(settled));
        if (settled.state === "failed" && settled.error) {
          out.push(`      ${p.err(sanitizeText(settled.error, 200))}`);
        }
      }
    }
    if (out.length > 0) {
      this.eraseBlock();
      this.permanent(out);
    }
  }

  private settledLine(a: AgentView): string {
    const { p, g } = this;
    const label = padEndWidth(sanitizeText(a.label, 60), this.labelW);
    const glyph = a.state === "done" ? p.ok(g.ok) : p.err(g.fail);
    const meta = metaJoin(g, [
      a.phase !== null && a.phase !== this.currentPhase ? sanitizeText(a.phase, 40) : null,
      a.adapter !== null ? sanitizeText(a.adapter, 40) : null,
      a.durationMs !== null ? fmtDuration(a.durationMs) : null,
      a.attempts !== null && a.attempts > 1 ? `${a.attempts} tries` : null,
    ]);
    return `    ${glyph} ${label}  ${p.dim(meta)}`;
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
      const label = padEndWidth(sanitizeText(a.label, 60), this.labelW);
      const meta = metaJoin(g, [
        a.phase !== null && a.phase !== this.currentPhase ? sanitizeText(a.phase, 40) : null,
        a.adapter !== null ? sanitizeText(a.adapter, 40) : null,
        a.startedAt !== null ? fmtDuration((nowSec - a.startedAt) * 1000) : null,
      ]);
      block.push(`    ${p.run(spin)} ${label}  ${p.dim(meta)}`);
    }

    const paused = status.state === "paused";
    const stopping = control === "stop" && !TERMINAL_STATES.has(String(status.state));
    const spent = typeof status.spentTokens === "number" ? status.spentTokens : 0;
    const startSec = this.runStartTs ?? nowSec;
    const parts = metaJoin(g, [
      `${running.length} running`,
      `${this.done} done`,
      this.failed > 0 ? p.err(`${this.failed} failed`) : null,
      spent > 0 ? `~${spent} tok` : null,
      fmtElapsed((nowSec - startSec) * 1000),
      stopping ? p.run("stopping…") : null,
      paused ? p.run("paused") : null,
    ]);
    const head = paused ? p.run(g.stop) : p.run(spin);
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
    const spent = typeof status.spentTokens === "number" ? status.spentTokens : 0;
    const meta = metaJoin(g, [
      `${this.agents.length} agents`,
      this.failed > 0 ? p.err(`${this.failed} failed`) : null,
      spent > 0 ? `~${spent} tok` : null,
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
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Attach to a run and render it until it settles (or we detach). Returns the
 * process exit code: 0 done, 1 failed/stopped/vanished, 124 timeout, 130
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

  const view = live ? new LiveView(runId, name, caps, opts.err, now) : null;

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
    view.header();
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
        for (const ev of observed.events) opts.err.write(formatEvent(ev) + "\n");
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
  if (!view) {
    if (state === "failed") opts.err.write(`run failed: ${sanitizeText(errText ?? "unknown error", 300)}\n`);
    else if (state === "stopped") opts.err.write("run was stopped before completion\n");
  }
  return 1;
}
