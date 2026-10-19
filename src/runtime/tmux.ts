/**
 * `odw tmux <run>` (U5; an ODW extension): watch a run in tmux — one window, an
 * overview pane following the run, and a pane per running agent following its
 * transcript. ODW runs and Claude Code's own (`cc-…`, read-only) alike.
 *
 *   odw tmux <run> [--layout tiled] [--max-panes 6]
 *       inside tmux: opens a window whose first pane runs the overview;
 *       tmux installed, but not inside it: prints the `tmux new-session`
 *       command that does the same; no tmux: prints the commands to follow
 *       the run by hand (odw attach, odw logs --agent … --follow)
 *
 * The overview (`odw tmux <run> --overview`, what that first pane runs) is the
 * one owner of the window's panes: it prints the run's events and, as agents
 * start, splits a pane for each (`odw logs <run> --agent <id> --follow`) up to
 * `--max-panes`; the ones past the cap it lists with the command that follows
 * them. The window keeps a pane whose command ended (`remain-on-exit`): an
 * agent's last lines stay, under the line naming how it settled.
 *
 * Only tmux: no other terminal multiplexer is driven. Every pane command is
 * built from validated ids (a run id, an ODW agent number, a Claude agent id),
 * each word shell-quoted — no label or other run-written text reaches a shell.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { odwInvocation } from "../schedule/command.js";
import { sanitizeText } from "../tty.js";
import { agentRows } from "./agents-view.js";
import type { ClaudeRunSource } from "./claude-run-source.js";
import { claudeRunSource, EventPrinter, isClaudeRunId } from "./claude-watch.js";
import { formatEvent, shellArg } from "./live-view.js";
import { RunObserver } from "./run-liveness.js";
import { RUN_ID_RE } from "./run-source.js";
import type { RunStore } from "./run-store.js";
import type { Writer } from "./transcript-view.js";

/** The layouts `--layout` takes: tmux's own presets. */
export const TMUX_LAYOUTS = ["tiled", "even-horizontal", "even-vertical", "main-horizontal", "main-vertical"] as const;
export const DEFAULT_MAX_PANES = 6;
const MAX_PANES_LIMIT = 32;

/** A running agent a pane can follow: `args` are what follows `odw` in its command. */
export interface PaneAgent {
  /** Stable per agent: which agents already have a pane. */
  key: string;
  label: string;
  args: string[];
}

/** What one look at a run shows the overview. */
export interface WatchPoll {
  /** New lines for the overview pane. */
  lines: string[];
  /** The agents running now. */
  running: PaneAgent[];
  /** Set once the run ended: the overview's exit code and last line. */
  ended: { code: number; line: string } | null;
}

export interface WatchedRun {
  poll(): WatchPoll;
}

/**
 * An ODW run, watched: its events as `odw logs --follow` prints them, its
 * running agents by dispatch id. `flags` find the run from a pane (default:
 * this store's runs root, outright).
 */
export function odwWatchedRun(store: RunStore, runId: string, flags = ["--runs-root", resolve(store.root)]): WatchedRun {
  const observer = new RunObserver(store, runId);
  return {
    poll() {
      const seen = observer.read();
      const lines = seen.events.map(formatEvent);
      if (seen.note) lines.push(seen.note);
      const running = agentRows(store, runId)
        .filter((r) => r.state === "running" && r.agentId !== null)
        .map((r) => ({ key: String(r.agentId), label: r.label, args: ["logs", runId, "--agent", String(r.agentId), "--follow", ...flags] }));
      const state = String(seen.status.state ?? "?");
      const ended = seen.error
        ? { code: 1, line: seen.error }
        : seen.terminal
          ? { code: state === "done" ? 0 : 1, line: `run ${runId} ${state}` }
          : null;
      return { lines, running, ended };
    },
  };
}

/** A Claude Code run, watched (read-only): its rebuilt events, its running agents by Claude agent id. */
export function claudeWatchedRun(src: ClaudeRunSource, runId: string): WatchedRun {
  const printer = new EventPrinter();
  return {
    poll() {
      const summary = src.summary(runId);
      if (!summary) return { lines: [], running: [], ended: { code: 1, line: `${runId} is gone — Claude Code cleaned its files up` } };
      const lines = printer.next(src.eventLog(runId));
      const running = (src.agentRefs(runId) ?? [])
        .filter((a) => a.state === "running" && a.agentId !== null)
        .map((a) => ({ key: a.agentId!, label: a.label, args: ["logs", runId, "--agent", a.agentId!, "--follow"] }));
      const over = summary.state === "done" || summary.state === "failed" || summary.state === "stopped";
      return { lines, running, ended: over ? { code: summary.state === "done" ? 0 : 1, line: `run ${runId} ${summary.state}` } : null };
    },
  };
}

/** Runs one tmux command, returning its stdout; throws when it fails. */
export type TmuxExec = (args: string[]) => string;

export const realTmux: TmuxExec = (args) => execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Is a `tmux` on PATH? */
export function tmuxInstalled(): boolean {
  const probe = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

/** argv as one shell command line (tmux hands a pane's command to the shell). */
export function commandLine(argv: string[]): string {
  return argv.map(shellArg).join(" ");
}

export interface OverviewOptions {
  tmux: TmuxExec;
  /** The overview's own pane (`$TMUX_PANE`): splits and layouts target its window. */
  pane: string;
  layout: string;
  maxPanes: number;
  /** How to run odw in a pane. */
  odw: string[];
  /** Where pane commands start. */
  cwd: string;
  out: Writer;
  pollMs?: number;
}

/**
 * The overview pane: print the run's events, split a pane for each agent that
 * starts (up to the cap), list the rest; return once the run ended.
 */
export async function runOverview(run: WatchedRun, opts: OverviewOptions): Promise<number> {
  const tmux = (args: string[]): boolean => {
    try {
      opts.tmux(args);
      return true;
    } catch {
      return false;
    }
  };
  // Keep each pane once its command ends: an agent's last lines, and how it settled.
  tmux(["set-option", "-w", "-t", opts.pane, "remain-on-exit", "on"]);
  const handled = new Set<string>();
  let panes = 0;
  for (;;) {
    const seen = run.poll();
    for (const line of seen.lines) opts.out.write(`${line}\n`);
    for (const agent of seen.running) {
      if (handled.has(agent.key)) continue;
      handled.add(agent.key);
      const label = sanitizeText(agent.label, 80);
      const command = commandLine([...opts.odw, ...agent.args]);
      if (panes < opts.maxPanes && tmux(["split-window", "-d", "-t", opts.pane, "-c", opts.cwd, command])) {
        panes++;
        tmux(["select-layout", "-t", opts.pane, opts.layout]);
        opts.out.write(`+ pane: ${label}\n`);
      } else {
        // Past the cap (or no room left in the window): the command that follows it.
        opts.out.write(`  no pane for ${label} (${panes} of ${opts.maxPanes} open): ${commandLine(["odw", ...agent.args])}\n`);
      }
    }
    if (seen.ended) {
      opts.out.write(`${seen.ended.line}\n`);
      return seen.ended.code;
    }
    await new Promise((done) => setTimeout(done, opts.pollMs ?? 1000));
  }
}

/** Store flags as cli.ts takes them, and how it opens the store from them. */
type StoreFrom = (values: { config?: string; "runs-root"?: string }) => RunStore;

export interface TmuxCommandIO {
  out: Writer;
  err: Writer;
  env?: Record<string, string | undefined>;
  tmux?: TmuxExec;
  installed?: () => boolean;
  claude?: () => ClaudeRunSource;
  pollMs?: number;
}

/** `odw tmux <run> [--layout L] [--max-panes N] [--overview]`. Exit 0 once the window is open (or the commands printed). */
export async function cmdTmux(rest: string[], storeFrom: StoreFrom, io: TmuxCommandIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      layout: { type: "string" },
      "max-panes": { type: "string" },
      overview: { type: "boolean" },
    },
  });
  const env = io.env ?? process.env;
  const runId = positionals[0];
  if (!runId || positionals.length > 1) {
    io.err.write("odw tmux: give one <run_id>\n");
    return 2;
  }
  const layout = values.layout ?? "tiled";
  if (!(TMUX_LAYOUTS as readonly string[]).includes(layout)) {
    io.err.write(`odw tmux: --layout is one of ${TMUX_LAYOUTS.join(", ")}\n`);
    return 2;
  }
  const maxPanes = values["max-panes"] === undefined ? DEFAULT_MAX_PANES : Number(values["max-panes"]);
  if (!Number.isInteger(maxPanes) || maxPanes < 0 || maxPanes > MAX_PANES_LIMIT) {
    io.err.write(`odw tmux: --max-panes is a whole number from 0 to ${MAX_PANES_LIMIT}\n`);
    return 2;
  }
  if (!RUN_ID_RE.test(runId)) {
    io.err.write(`odw tmux: not a run id: ${sanitizeText(runId, 80)}\n`);
    return 2;
  }

  // Which run: a Claude Code run (read-only) or one of this runs root's.
  // `storeFlags`: what finds it from a printed command (the panes name the runs root outright).
  const storeFlags = values["runs-root"] ? ["--runs-root", resolve(values["runs-root"])] : values.config ? ["--config", resolve(values.config)] : [];
  let run: (flags?: string[]) => WatchedRun;
  if (isClaudeRunId(runId)) {
    const src = (io.claude ?? (() => claudeRunSource()))();
    if (!src.exists(runId)) {
      io.err.write(`no such run: ${runId}\n`);
      return 1;
    }
    run = () => claudeWatchedRun(src, runId);
  } else {
    const store = storeFrom(values);
    if (!store.exists(runId)) {
      io.err.write(`no such run: ${runId}\n`);
      return 1;
    }
    run = (flags) => odwWatchedRun(store, runId, flags);
  }

  const tmux = io.tmux ?? realTmux;
  const odw = odwInvocation();
  if (values.overview) {
    const pane = env.TMUX_PANE;
    if (!pane) {
      io.err.write("odw tmux --overview runs in the pane odw tmux opens (no $TMUX_PANE here): run odw tmux <run> inside tmux\n");
      return 2;
    }
    return runOverview(run(), { tmux, pane, layout, maxPanes, odw, cwd: process.cwd(), out: io.out, pollMs: io.pollMs });
  }

  const overviewArgv = [...odw, "tmux", runId, "--overview", "--layout", layout, "--max-panes", String(maxPanes), ...storeFlags];
  const byHand = (): void => {
    io.out.write(`  ${commandLine(["odw", "attach", runId, ...storeFlags])}\n`);
    for (const agent of run(storeFlags).poll().running) {
      io.out.write(`  ${commandLine(["odw", ...agent.args])}    # ${sanitizeText(agent.label, 80)}\n`);
    }
  };
  if (!(io.installed ?? tmuxInstalled)()) {
    io.out.write("odw tmux: tmux is not installed — follow the run by hand, one terminal each:\n");
    byHand();
    return 0;
  }
  if (!env.TMUX) {
    io.out.write("odw tmux: not inside a tmux session — start one on the run with:\n");
    io.out.write(`  tmux new-session ${shellArg(commandLine(overviewArgv))}\n`);
    io.out.write("or follow it by hand, one terminal each:\n");
    byHand();
    return 0;
  }
  try {
    tmux(["new-window", "-n", `odw:${runId.slice(0, 24)}`, "-c", process.cwd(), commandLine(overviewArgv)]);
  } catch (err) {
    io.err.write(`odw tmux: tmux new-window failed: ${sanitizeText((err as Error).message, 300)}\n`);
    return 1;
  }
  io.out.write(`odw tmux: opened a window on ${runId} — the overview adds a pane per running agent (up to ${maxPanes})\n`);
  return 0;
}
