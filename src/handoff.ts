/**
 * Handing the work over on a fallback (an ODW extension).
 *
 * When an agent's CLI runs out of quota (or its login is refused) mid-task,
 * its fallback chain moves the call to the next adapter (see ./bridge). By
 * default that adapter starts the work over. With handoff on — `"fallback":
 * { "handoff": true }` in the config, or `handoff: true` on one agent() call —
 * it carries on instead:
 *
 *   - an isolated agent's worktree is kept: the next adapter runs in it, the
 *     partial changes in place (an in-place agent's edits are in the source
 *     tree already);
 *   - a brief of what the last adapter did is put in the next adapter's
 *     prompt, ahead of the task: why it stopped, the files it changed (the
 *     worktree's diff stat; an in-place agent's edit tool calls), the last
 *     plan or to-do list it wrote, the commands it ran and how they ended,
 *     and its last few messages — at most {@link HANDOFF_MAX_BYTES}.
 *
 * "Cross-agent resume carries an inherent performance penalty: you keep the
 * (visible) transcript but lose the reasoning" — the brief is that visible
 * part, cut down to what the next agent needs to pick the work up.
 *
 * A {@link HandoffLog} reads what the call's CLI runs print as it arrives —
 * normalized like a transcript (runtime/transcript-view) — and keeps only
 * what a brief can use, so it holds little whatever the CLI prints;
 * {@link handoffBrief} writes the brief.
 */

import type { CliResult } from "./adapters/types.js";
import { TranscriptNormalizer, type TranscriptEntry } from "./runtime/transcript-view.js";

/** The most a brief may take, in UTF-8 bytes. */
export const HANDOFF_MAX_BYTES = 6 * 1024;

/** The first line of every brief: what the next agent reads first. */
export const HANDOFF_HEADER = "## Handoff: you are continuing work another agent started";

/** Commands, messages and edited files a log keeps: the latest ones. */
const COMMANDS_KEPT = 12;
const MESSAGES_KEPT = 3;
const EDITED_KEPT = 40;
/** Characters of a text CLI's output kept: its end. */
const TEXT_TAIL_CHARS = 2400;
/** Characters of one line a log reads at most; the rest of a longer line is skipped. */
const LINE_MAX_CHARS = 1024 * 1024;

/** The bytes each section of a brief may take; together under {@link HANDOFF_MAX_BYTES}. */
const BUDGET = { why: 600, files: 1100, plan: 1200, commands: 1100, messages: 1300 };
/** Files of the diff stat listed by name; the rest are counted. */
const FILES_LISTED = 30;

/** Tools whose input is the agent's plan or to-do list (lower-cased). */
const PLAN_TOOLS = new Set(["todowrite", "todo_write", "write_todos", "update_plan", "exitplanmode", "plan"]);
/** Tools that run a command (lower-cased). */
const SHELL_TOOLS = new Set(["bash", "shell", "run_command", "run_shell_command", "execute_command", "exec_command", "local_shell"]);
/** Tools that edit files (lower-cased): what an in-place agent's brief lists. */
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "replace",
  "write_file",
  "edit_file",
  "create_file",
  "patch",
]);

/** A command the agent ran, and how it ended (absent: no result came). */
export interface HandoffCommand {
  command: string;
  tool: string;
  outcome?: string;
}

/**
 * What a call's CLI runs printed, as far as a brief needs it: the latest plan,
 * commands, messages and edited files. Fed as the output arrives; never waits.
 */
export class HandoffLog {
  plan: string | null = null;
  readonly commands: HandoffCommand[] = [];
  readonly messages: string[] = [];
  readonly edited: string[] = [];
  /** The end of what a text CLI printed (a JSONL one's text is in `messages`). */
  textTail = "";
  private format: "jsonl" | "text" = "text";
  private normalizer = new TranscriptNormalizer();
  private partial = "";
  private skipping = false;
  private heard = false;

  /** A CLI run starts, printing `format`. */
  beginRun(format: "jsonl" | "text"): void {
    this.flush();
    this.format = format;
    this.normalizer = new TranscriptNormalizer();
    this.heard = false;
  }

  /** What the CLI printed on stdout, as it arrives. */
  stdout(chunk: string): void {
    if (!chunk) return;
    this.heard = true;
    if (this.format === "text") {
      this.textTail = (this.textTail + chunk).slice(-TEXT_TAIL_CHARS);
      return;
    }
    let from = 0;
    for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", from)) {
      const line = this.partial + chunk.slice(from, nl);
      this.partial = "";
      from = nl + 1;
      if (this.skipping) this.skipping = false;
      else this.line(line);
    }
    if (this.skipping) return;
    this.partial += chunk.slice(from);
    // A line too long to be anything a brief uses (a huge tool result) is skipped.
    if (this.partial.length > LINE_MAX_CHARS) {
      this.partial = "";
      this.skipping = true;
    }
  }

  /** The CLI run ended: its last line is read — and its whole stdout, when it streamed none. */
  endRun(cli: CliResult): void {
    if (!this.heard && cli.stdout) this.stdout(cli.stdout);
    this.flush();
  }

  /** Nothing in it a brief could use. */
  get empty(): boolean {
    return !this.plan && this.commands.length === 0 && this.messages.length === 0 && this.edited.length === 0 && !this.textTail.trim();
  }

  private flush(): void {
    const rest = this.partial;
    this.partial = "";
    this.skipping = false;
    if (rest && this.format === "jsonl") this.line(rest);
  }

  private line(line: string): void {
    for (const entry of this.normalizer.line(line)) this.entry(entry);
  }

  private entry(entry: TranscriptEntry): void {
    switch (entry.kind) {
      case "text":
        if (!entry.thinking && entry.text?.trim()) keepLast(this.messages, entry.text.trim(), MESSAGES_KEPT);
        return;
      case "tool_call": {
        const tool = entry.tool ?? "tool";
        const name = tool.toLowerCase();
        if (PLAN_TOOLS.has(name)) {
          const plan = planText(entry.input);
          if (plan) this.plan = plan;
        } else if (SHELL_TOOLS.has(name) || hasCommand(entry.input)) {
          if (entry.text) keepLast(this.commands, { command: entry.text, tool }, COMMANDS_KEPT);
        } else if (EDIT_TOOLS.has(name) && entry.text) {
          const at = this.edited.indexOf(entry.text);
          if (at !== -1) this.edited.splice(at, 1);
          keepLast(this.edited, entry.text, EDITED_KEPT);
        }
        return;
      }
      case "tool_result": {
        // The latest command still waiting for its result, of the same tool when the result names one.
        const pending = [...this.commands].reverse().find((c) => c.outcome === undefined);
        if (!pending || (entry.tool !== undefined && entry.tool !== pending.tool)) return;
        pending.outcome = entry.isError ? `failed (${entry.text ?? "error"})${lastLine(entry.output)}` : `ok (${entry.text ?? "done"})`;
        return;
      }
      case "raw":
        // Codex's to-do list (transcript-view: "to-do: [x] a · [ ] b").
        if (entry.text?.startsWith("to-do: ")) this.plan = entry.text.slice("to-do: ".length).split(" · ").join("\n");
        return;
      default:
        return;
    }
  }
}

/** What a brief is written from. */
export interface HandoffBriefInput {
  /** The adapter that stopped, and why: its quota is spent, or its login was refused. */
  from: string;
  reason: "quota" | "auth";
  /** The adapter that carries on. */
  to: string;
  /** The error the last run ended with. */
  why: string;
  /** The agent works in a worktree of its own (isolation: "worktree"); else in the shared source tree. */
  isolated: boolean;
  /** The worktree's unified diff against its base (isolated), as {@link Workspace.diff} gives it. */
  diff?: string;
  log: HandoffLog;
}

/**
 * The brief the next adapter's prompt starts its task with (see the module
 * doc): at most {@link HANDOFF_MAX_BYTES} of UTF-8, each section within its
 * own budget, so a long one never crowds out the others.
 */
export function handoffBrief(input: HandoffBriefInput): string {
  const { from, to, reason, isolated, log } = input;
  const stopped = reason === "quota" ? "its usage quota ran out" : "its login was refused";
  const where = isolated
    ? "What it changed is already in your working directory (the same worktree it worked in)"
    : "What it changed is already in the working tree (it worked in place, as you do)";
  const parts = [
    HANDOFF_HEADER,
    `You are continuing work another agent started on this same task. It ran on ${from} and stopped before it ` +
      `finished — ${stopped} — so the work moved to you (${to}). ${where}: check it, keep what is right, and ` +
      "finish the task from where it stopped rather than starting over. Its reasoning was not kept; below is " +
      "what it left behind.",
    section("Why it stopped", cut(input.why.trim() || stopped, BUDGET.why)),
  ];
  const files = isolated ? diffStat(input.diff ?? "") : log.edited.map((path) => ` ${path}`);
  const filesTitle = isolated ? "Files it changed (diff stat)" : "Files it edited (from its tool calls)";
  parts.push(section(filesTitle, files.length > 0 ? fitLines(files, BUDGET.files) : "None yet."));
  if (log.plan) parts.push(section("Its last plan", cut(log.plan, BUDGET.plan)));
  if (log.commands.length > 0) {
    const lines = log.commands.map((c) => `- \`${oneLine(c.command, 300)}\` — ${c.outcome ?? "no result (it stopped here)"}`);
    parts.push(section("Commands it ran (latest last)", fitLines(lines, BUDGET.commands, true)));
  }
  const said = log.messages.length > 0 ? log.messages : log.textTail.trim() ? [log.textTail.trim()] : [];
  if (said.length > 0) {
    const each = Math.floor(BUDGET.messages / said.length);
    const quoted = said.map((text) => quote(log.messages.length > 0 ? cutMiddle(text, each - 16) : cutEnd(text, each - 16)));
    parts.push(section(log.messages.length > 0 ? "Its last messages (latest last)" : "The end of its output", quoted.join("\n\n")));
  }
  parts.push("The task follows: the same one it was given.");
  return cut(parts.join("\n\n"), HANDOFF_MAX_BYTES);
}

/** ` path | +3 -1` lines of a unified diff, one per file, in its order. */
export function diffStat(diff: string): string[] {
  const out: string[] = [];
  let current: { path: string; add: number; del: number; binary: boolean } | null = null;
  let renameFrom: string | null = null;
  const done = (): void => {
    if (!current) return;
    out.push(` ${current.path} | ${current.binary ? "binary" : `+${current.add} -${current.del}`}`);
    current = null;
  };
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (head) {
      done();
      current = { path: head[2]!, add: 0, del: 0, binary: false };
      renameFrom = null;
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
      else if (line.startsWith("rename to ") && renameFrom) current.path = `${renameFrom} → ${line.slice("rename to ".length)}`;
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") current.binary = true;
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("+")) current.add++;
    else if (line.startsWith("-")) current.del++;
  }
  done();
  return out;
}

// --- helpers ------------------------------------------------------------------------

function section(title: string, body: string): string {
  return `### ${title}\n${body}`;
}

function keepLast<T>(list: T[], item: T, max: number): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/** A plan tool's input as a checklist: Claude Code's `todos`, Codex's `plan`, or a plan's text. */
export function planText(input: unknown): string | null {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      // An input cut at 4 KB (transcript-view clips it): the steps that came whole.
      const steps = (input.match(/\{[^{}]*\}/g) ?? []).flatMap((step) => {
        try {
          return [JSON.parse(step) as unknown];
        } catch {
          return [];
        }
      });
      const salvaged = steps.length > 0 ? planText({ todos: steps }) : null;
      return salvaged ?? (input.trim() || null);
    }
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const steps = Array.isArray(record.todos) ? record.todos : Array.isArray(record.plan) ? record.plan : null;
  if (steps) {
    const lines = steps.flatMap((step) => {
      if (typeof step === "string") return [`- [ ] ${step}`];
      if (step === null || typeof step !== "object") return [];
      const s = step as Record<string, unknown>;
      const text = [s.content, s.step, s.text, s.title].find((v): v is string => typeof v === "string" && v.trim() !== "");
      if (!text) return [];
      const status = typeof s.status === "string" ? s.status : s.completed === true ? "completed" : "";
      const mark = status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
      return [`- ${mark} ${text.trim()}`];
    });
    return lines.length > 0 ? lines.join("\n") : null;
  }
  const plan = [record.plan, record.explanation].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return plan?.trim() ?? null;
}

function hasCommand(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  return typeof record.command === "string" || typeof record.CommandLine === "string";
}

/** `: <last line>` of a failed tool's output, short. */
function lastLine(output: string | undefined): string {
  const line = output?.trim().split("\n").at(-1)?.trim();
  return line ? `: ${oneLine(line, 200)}` : "";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** As many of `lines` as fit in `budget` bytes — the first ones, or (`latest`) the last — and how many did not. */
function fitLines(lines: string[], budget: number, latest = false): string {
  const kept: string[] = [];
  let used = 0;
  const order = latest ? [...lines].reverse() : lines;
  for (const line of order) {
    const bytes = Buffer.byteLength(line) + 1;
    if (used + bytes > budget - 40 || kept.length >= (latest ? Infinity : FILES_LISTED)) break;
    kept.push(line);
    used += bytes;
  }
  const left = lines.length - kept.length;
  if (latest) kept.reverse();
  if (left > 0) {
    const more = latest ? `… ${left} earlier not shown` : `… and ${left} more`;
    if (latest) kept.unshift(more);
    else kept.push(more);
  }
  return kept.join("\n");
}

/** `text` in at most `max` UTF-8 bytes: its start, cut at a character, ending "…" when cut. */
export function cut(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const bytes = Buffer.from(text, "utf8").subarray(0, max - 3);
  return `${bytes.toString("utf8").replace(/�+$/, "")}…`;
}

/** `text` in at most `max` UTF-8 bytes: its start and its end, cut at characters, "…" between them when cut. */
function cutMiddle(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return `${cut(text, half + 3).slice(0, -1)}…${cutEnd(text, half + 3).slice(1)}`;
}

/** `text` in at most `max` UTF-8 bytes: its end, cut at a character, starting "…" when cut. */
function cutEnd(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  return `…${buf.subarray(buf.length - (max - 3)).toString("utf8").replace(/^�+/, "")}`;
}
