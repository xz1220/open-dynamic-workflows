/**
 * Watching Claude Code's own workflow runs from a terminal (U5; an ODW
 * extension): what `odw status|logs|attach <cc-…>` print — read-only, from the
 * same run store the dashboard reads (see ./claude-run-source).
 *
 *   status   the run's state, name and agents (label, phase, state, Claude's
 *            agent id — what `--agent` takes)
 *   logs     the run's events; `--follow` prints each new one until the run
 *            ends (a live run's events are rebuilt from its journal on every
 *            read, so a follower prints what it has not printed yet)
 *   logs --agent <id|label>
 *            one agent's `agent-<id>.jsonl` transcript, normalized like an ODW
 *            agent's (./transcript-view); `--raw` prints its lines as kept;
 *            `--follow` goes on until the agent settles
 *   attach   a header, then `logs --follow`
 *
 * Nothing here writes: stopping or answering a Claude Code run stays in Claude
 * Code. Claude Code may clean its transcripts up; a run that vanished mid-follow
 * ends the follow with a note.
 */

import { resolveClaudeProjectsRoot } from "../adapters/config.js";
import type { WorkflowEvent } from "../events.js";
import { palette, sanitizeText, type TermCaps } from "../tty.js";
import { ClaudeRunSource, type ClaudeAgentRef } from "./claude-run-source.js";
import { formatEvent } from "./live-view.js";
import { RUN_ID_RE } from "./run-source.js";
import { formatTranscriptEntry, LineTail, TranscriptNormalizer, type Writer } from "./transcript-view.js";

/** Is this a Claude Code run's id (`cc-wf_…`), one safe path segment? */
export function isClaudeRunId(runId: string | undefined): boolean {
  return typeof runId === "string" && runId.startsWith("cc-") && RUN_ID_RE.test(runId);
}

/**
 * The Claude Code runs a terminal command sees: every project's, under
 * `~/.claude/projects` (CLAUDE_CONFIG_DIR honored) — an id names one run
 * wherever it was started.
 */
export function claudeRunSource(cwd = process.cwd()): ClaudeRunSource {
  return new ClaudeRunSource({ projectsRoot: resolveClaudeProjectsRoot(), cwd, scope: "all" });
}

export interface ClaudeWatchIO {
  out: Writer;
  err: Writer;
  /** How long a follower waits between reads (ms). */
  pollMs?: number;
}

const ENDED = new Set(["done", "failed", "stopped"]);
const READ_ONLY = "a Claude Code run: read-only here — stop or answer it in Claude Code";

/** The note for a run id no source knows. */
function noSuchRun(runId: string): string {
  return `no such run: ${sanitizeText(runId, 120)} (Claude Code runs are read from ${resolveClaudeProjectsRoot()}; Claude Code may have cleaned it up)\n`;
}

/** `odw status <cc-…>`: the run, then a line per agent. */
export function claudeStatus(src: ClaudeRunSource, runId: string, io: ClaudeWatchIO): number {
  const summary = src.summary(runId);
  const agents = src.agentRefs(runId);
  if (!summary || !agents) {
    io.err.write(noSuchRun(runId));
    return 1;
  }
  io.out.write(`${runId}  [${summary.state}]  ${sanitizeText(summary.name, 120)}\n`);
  io.out.write(`  ${READ_ONLY}\n`);
  if (summary.state === "stale") io.out.write("  stale: nothing written for a while — its Claude Code session may have ended\n");
  const c = summary.counts;
  io.out.write(`  agents: ${c.agents} (${c.running} running, ${c.done} done, ${c.failed} failed${c.stale ? `, ${c.stale} stale` : ""})\n`);
  for (const a of agents) io.out.write(`    ${agentLine(a)}\n`);
  if (agents.some((a) => a.agentId)) io.out.write(`  an agent's transcript: odw logs ${runId} --agent <id|label> [--follow]\n`);
  return 0;
}

function agentLine(a: ClaudeAgentRef): string {
  const phase = a.phase ? `  (${sanitizeText(a.phase, 60)})` : "";
  return `${a.state.padEnd(8)} ${(a.agentId ?? "-").padEnd(18)} ${sanitizeText(a.label, 80)}${phase}`;
}

/**
 * `odw logs <cc-…> [--follow]`: the run's events, then (following) each new
 * one until the run ends. Exit 0 when it ended done (or without following),
 * 1 when it failed, stopped, or vanished.
 */
export async function claudeLogs(src: ClaudeRunSource, runId: string, follow: boolean, io: ClaudeWatchIO): Promise<number> {
  if (!src.exists(runId)) {
    io.err.write(noSuchRun(runId));
    return 1;
  }
  const printer = new EventPrinter();
  let staleNoted = false;
  for (;;) {
    // The summary first: events read after it are at least as new.
    const summary = src.summary(runId);
    if (!summary) {
      io.err.write(`odw logs: ${runId} is gone — Claude Code cleaned its files up\n`);
      return 1;
    }
    for (const line of printer.next(src.eventLog(runId))) io.out.write(`${line}\n`);
    if (!follow) return 0;
    if (ENDED.has(summary.state)) return summary.state === "done" ? 0 : 1;
    if (summary.state === "stale" && !staleNoted) {
      io.err.write("odw logs: nothing written for a while — its Claude Code session may have ended (still following; Ctrl-C stops)\n");
      staleNoted = true;
    }
    await sleep(io.pollMs ?? 500);
  }
}

/** `odw attach <cc-…>`: what the run is, then its events as they come. */
export async function claudeAttach(src: ClaudeRunSource, runId: string, io: ClaudeWatchIO): Promise<number> {
  const summary = src.summary(runId);
  if (!summary) {
    io.err.write(noSuchRun(runId));
    return 1;
  }
  io.err.write(`attached to ${runId} (${sanitizeText(summary.name, 120)}) — ${READ_ONLY}; Ctrl-C detaches\n`);
  return claudeLogs(src, runId, true, io);
}

/**
 * Prints a rebuilt event list's new events: an event is new when the list holds
 * more events like it (same type, label, phase, message) than were printed.
 */
export class EventPrinter {
  private readonly printed = new Map<string, number>();

  next(events: readonly WorkflowEvent[]): string[] {
    const seen = new Map<string, number>();
    const out: string[] = [];
    for (const ev of events) {
      const key = [ev.type, ev.label ?? "", ev.phase ?? "", ev.message ?? ""].map(String).join("\u0000");
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > (this.printed.get(key) ?? 0)) {
        this.printed.set(key, n);
        out.push(formatEvent(ev));
      }
    }
    return out;
  }
}

/** One agent of a Claude run by its id (or an id prefix of 6+ characters) or label. */
export function matchClaudeAgents(agents: ClaudeAgentRef[], ref: string): ClaudeAgentRef[] {
  const byId = agents.filter((a) => a.agentId !== null && a.agentId === ref);
  if (byId.length > 0) return byId;
  if (ref.length >= 6) {
    const byPrefix = agents.filter((a) => a.agentId?.startsWith(ref));
    if (byPrefix.length > 0) return byPrefix;
  }
  return agents.filter((a) => a.label === ref);
}

export interface ClaudeAgentLogsOptions extends ClaudeWatchIO {
  raw: boolean;
  follow: boolean;
  caps: TermCaps;
  width: number;
}

/**
 * `odw logs <cc-…> --agent <id|label> [--raw] [--follow]`: one agent's
 * transcript as Claude Code keeps it. Claude's session lines also carry
 * attachments and bookkeeping; only its messages are shown (`--raw` shows all).
 * Following ends when the agent settles: exit 0 done, 1 failed or gone.
 */
export async function claudeAgentLogs(src: ClaudeRunSource, runId: string, ref: string, opts: ClaudeAgentLogsOptions): Promise<number> {
  const agents = src.agentRefs(runId);
  if (!agents) {
    opts.err.write(noSuchRun(runId));
    return 1;
  }
  const matches = matchClaudeAgents(agents, ref);
  if (matches.length === 0) {
    opts.err.write(`run ${runId} has no agent '${sanitizeText(ref, 80)}' (see odw status ${runId})\n`);
    return 1;
  }
  if (matches.length > 1) {
    const ids = matches.map((a) => `${a.agentId ?? "?"} (${a.state})`).join(", ");
    opts.err.write(`'${sanitizeText(ref, 80)}' matches ${matches.length} agents of run ${runId}: ${ids} — pick one: odw logs ${runId} --agent <id>\n`);
    return 1;
  }
  let agent = matches[0]!;
  const who = `agent ${agent.agentId ?? "?"} (${sanitizeText(agent.label, 80)})`;
  if (!agent.transcript) {
    opts.err.write(`${who}: its run names no agent id, so there is no transcript to read\n`);
    return 1;
  }
  const tail = new LineTail(agent.transcript);
  let normalizer = new TranscriptNormalizer();
  const read = (): boolean =>
    tail.read(
      (line) => {
        if (!line.trim()) return;
        if (opts.raw) {
          opts.out.write(`${line}\n`);
          return;
        }
        if (!isClaudeMessage(line)) return;
        for (const entry of normalizer.line(line)) {
          for (const text of formatTranscriptEntry(entry, opts)) opts.out.write(`${text}\n`);
        }
      },
      () => {
        normalizer = new TranscriptNormalizer();
        opts.err.write(`odw logs: the transcript of ${who} was replaced; printing it again\n`);
      },
    );
  let found = read();
  let code = agent.state === "failed" ? 1 : 0;
  if (opts.follow) {
    for (;;) {
      const now = src.agentRefs(runId)?.find((a) => a.agentId === agent.agentId);
      found = read() || found;
      if (!now) {
        opts.err.write(`odw logs: ${who} is gone — Claude Code cleaned its run up\n`);
        code = 1;
        break;
      }
      agent = now;
      if (agent.state === "done" || agent.state === "failed") {
        code = agent.state === "done" ? 0 : 1;
        break;
      }
      await sleep(opts.pollMs ?? 500);
    }
  }
  if (!found) opts.err.write(`${who} has no transcript${agent.state === "running" ? " yet" : " (Claude Code may have cleaned it up)"}\n`);
  if (opts.follow && !opts.raw) {
    const p = palette(opts.caps);
    const mark = agent.state === "done" ? p.ok(`${sanitizeText(agent.label, 80)}: done`) : p.err(`${sanitizeText(agent.label, 80)}: ${agent.state}`);
    const rule = opts.caps.unicode ? "──" : "--";
    opts.out.write(`${rule} ${mark} ${rule}\n`);
  }
  return code;
}

/** A Claude session line worth reading: a message (user, assistant, system, result), not an attachment or bookkeeping. */
function isClaudeMessage(line: string): boolean {
  try {
    const event = JSON.parse(line) as { type?: unknown; isMeta?: unknown };
    return (event.type === "user" || event.type === "assistant" || event.type === "system" || event.type === "result") && event.isMeta !== true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
