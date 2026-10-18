/**
 * The run's notes board (an ODW extension): what parallel agents tell each other.
 *
 * Parallel coding agents produce changes that work alone and break together,
 * because one changed an interface another relies on. A board scoped to one
 * run lets them say so. It is off unless asked for — `agent(…, { notes: true })`,
 * `parallel(thunks, { notes: true })` or the `notes` setting — so a Claude Code
 * workflow runs exactly as written.
 *
 * An agent with notes on:
 *
 *   - gets `ODW_NOTES`, the path of a small POSIX shell script of its own:
 *     `"$ODW_NOTES" "text"` posts a note, `"$ODW_NOTES"` alone prints the
 *     notes so far. `odw note "text"` does the same where odw is installed;
 *   - finds the notes posted before it started in its prompt, with how to post
 *     one. Notes posted while it runs are NOT pushed into it — a CLI takes its
 *     prompt once — but it can read them again through `"$ODW_NOTES"`;
 *   - when it ran in a worktree and kept a change, has ODW post a note of its
 *     own for it: its diff stat and the interface lines it touched — lines of
 *     its diff hunks that look like declarations (`export`, `def`, `func`,
 *     `pub fn`, `class`, `interface`), a cheap language-agnostic heuristic.
 *
 * The board lives in the run directory:
 *
 *   notes.jsonl                 the board: one {@link Note} per line, append-only
 *   notes/board/notes.txt       the board as text, what `"$ODW_NOTES"` prints
 *   notes/<agentId>/note        the agent's shim (its `ODW_NOTES`)
 *   notes/<agentId>/inbox/      where its shim drops each note, as a file
 *
 * Only the worker writes the board. A shim (or `odw note`) drops the text in
 * its agent's inbox; the worker picks it up — every 250 ms while the agent
 * runs, and once more as it ends — so who posted a note is the inbox it came
 * from, never what the note says. Each note is capped at
 * {@link NOTE_MAX_CHARS} characters and redacted like the run's events, the
 * board at {@link BOARD_MAX_NOTES} notes and {@link BOARD_MAX_BYTES} bytes
 * (later notes are dropped, and the run says so once), and the prompt shows
 * the latest notes up to {@link PROMPT_NOTES_CHARS} characters. Every note is
 * a `note_added` event too.
 *
 * In a container sandbox (./adapters/sandbox) the shim works unchanged: the
 * agent's own notes directory is bound read-write at the same path, the
 * board's directory read-only — no other agent's inbox is there to write to.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { SandboxMount } from "./adapters/types.js";
import type { AgentChanges } from "./changes.js";
import { LOG, NOTE_ADDED, event, type WorkflowEvent } from "./events.js";
import type { Redactor } from "./redact.js";

/** The board, in the run directory. */
export const NOTES_FILE = "notes.jsonl";
/** Where the shims, inboxes and the board's text live, in the run directory. */
export const NOTES_DIR = "notes";

/** Characters of one note kept; past it, the note is cut and marked `truncated`. */
export const NOTE_MAX_CHARS = 2000;
/** Notes a board holds; later ones are dropped. */
export const BOARD_MAX_NOTES = 200;
/** Bytes of notes.jsonl; past it, later notes are dropped. */
export const BOARD_MAX_BYTES = 256 * 1024;
/** Characters of notes an agent's prompt shows: the latest that fit. */
export const PROMPT_NOTES_CHARS = 8000;
/** How often the inboxes of running agents are looked at. */
export const NOTE_POLL_MS = 250;

/** Interface lines a broadcast names, at most, and characters of each. */
const SUMMARY_SIGNATURES = 12;
const SIGNATURE_CHARS = 160;
/** Files a broadcast names, at most. */
const SUMMARY_FILES = 10;

/** One note on the board (a line of notes.jsonl; the `note_added` event carries the same fields). */
export interface Note {
  /** 1, 2, … in the order the board took them. */
  noteId: number;
  ts: number;
  /** Who posted it: the agent whose inbox it came from (or that ODW posted it for). */
  by: { agentId: number; label: string };
  text: string;
  /**
   * "note": the agent posted it; "interface": ODW posted the change it kept;
   * "scope": ODW posted the files it changed outside its declared scope (see ./scope).
   */
  kind: "note" | "interface" | "scope";
  /** Cut at NOTE_MAX_CHARS. */
  truncated?: true;
  /** Likely secrets in it were replaced by `«redacted:<kind>»`. */
  redacted?: true;
}

/** What an agent with notes on gets: its environment, its container binds, its prompt section, and its end. */
export interface AgentNotes {
  /** `ODW_NOTES`: its shim's path. */
  env: Record<string, string>;
  /** Its notes directory read-write and the board's read-only, at the same paths (container sandbox). */
  mounts: SandboxMount[];
  /** The notes posted so far and how to post one, for its prompt. */
  prompt: string;
  /** Take what is left in its inbox, then stop looking. Never throws. */
  close(): void;
}

export interface NotesBoardOptions {
  runDir: string;
  redactor?: Redactor;
  emit: (ev: WorkflowEvent) => void;
  /** How often running agents' inboxes are looked at, in ms (tests). */
  pollMs?: number;
}

/**
 * One run's board, owned by its worker. Nothing is created on disk until an
 * agent with notes on starts or a note is posted.
 */
export class NotesBoard {
  private readonly notes: Note[] = [];
  private bytes = 0;
  private full = false;
  private readonly open = new Map<number, { inbox: string; label: string }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: NotesBoardOptions) {}

  private get dir(): string {
    return join(this.opts.runDir, NOTES_DIR);
  }
  private get boardDir(): string {
    return join(this.dir, "board");
  }

  /** The notes so far, in order. */
  list(): readonly Note[] {
    return this.notes;
  }

  /**
   * Put a note on the board: cleaned, capped, redacted, appended to
   * notes.jsonl, rendered into notes.txt and emitted as `note_added`. Null
   * when it is empty or the board is full. Never throws: a write that fails is logged.
   */
  post(by: { agentId: number; label: string }, raw: string, kind: Note["kind"] = "note"): Note | null {
    let text = cleanNote(raw);
    if (!text) return null;
    if (this.full) return null;
    let truncated = false;
    if (text.length > NOTE_MAX_CHARS) {
      text = text.slice(0, NOTE_MAX_CHARS - 1) + "…";
      truncated = true;
    }
    const redactor = this.opts.redactor;
    const clean = redactor ? redactor.text(text) : text;
    const note: Note = {
      noteId: this.notes.length + 1,
      ts: Date.now() / 1000,
      by: { agentId: by.agentId, label: by.label },
      text: clean,
      kind,
      ...(truncated ? { truncated: true as const } : {}),
      ...(clean !== text ? { redacted: true as const } : {}),
    };
    const line = JSON.stringify(note) + "\n";
    const size = Buffer.byteLength(line);
    if (this.notes.length >= BOARD_MAX_NOTES || this.bytes + size > BOARD_MAX_BYTES) {
      this.full = true;
      this.opts.emit(
        event(LOG, {
          message:
            `the notes board is full (${BOARD_MAX_NOTES} notes or ${BOARD_MAX_BYTES / 1024} KiB): ` +
            `later notes are dropped — the first was from ${by.label}:${by.agentId}`,
          notes: "full",
        }),
      );
      return null;
    }
    try {
      mkdirSync(this.boardDir, { recursive: true });
      appendFileSync(join(this.opts.runDir, NOTES_FILE), line);
    } catch (err) {
      this.opts.emit(event(LOG, { message: `could not keep a note from ${by.label}:${by.agentId}: ${errorText(err)}` }));
      return null;
    }
    this.notes.push(note);
    this.bytes += size;
    this.render();
    const { ts: _ts, ...fields } = note;
    this.opts.emit(event(NOTE_ADDED, fields));
    return note;
  }

  /**
   * Set up an agent with notes on: its shim and inbox, and its prompt section
   * (the notes so far). Its inbox is looked at until {@link AgentNotes.close}.
   */
  openAgent(agentId: number, label: string): AgentNotes {
    const agentDir = join(this.dir, String(agentId));
    const inbox = join(agentDir, "inbox");
    const shim = join(agentDir, "note");
    const boardFile = join(this.boardDir, "notes.txt");
    mkdirSync(inbox, { recursive: true });
    mkdirSync(this.boardDir, { recursive: true });
    if (!existsSync(boardFile)) this.render();
    writeFileSync(shim, shimScript(boardFile, inbox), { mode: 0o755 });
    chmodSync(shim, 0o755);
    this.open.set(agentId, { inbox, label });
    if (!this.timer) {
      this.timer = setInterval(() => this.sweepAll(), this.opts.pollMs ?? NOTE_POLL_MS);
      this.timer.unref();
    }
    let closed = false;
    return {
      env: { ODW_NOTES: shim },
      mounts: [
        { source: agentDir, target: agentDir, readonly: false },
        { source: this.boardDir, target: this.boardDir, readonly: true },
      ],
      prompt: notesPrompt(this.notes),
      close: () => {
        if (closed) return;
        closed = true;
        this.sweep(agentId);
        this.open.delete(agentId);
        if (this.open.size === 0 && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      },
    };
  }

  /** Stop looking at every inbox (the run is over). */
  close(): void {
    for (const agentId of [...this.open.keys()]) this.sweep(agentId);
    this.open.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private sweepAll(): void {
    for (const agentId of this.open.keys()) this.sweep(agentId);
  }

  /** Post what an agent's inbox holds, oldest first, and empty it. */
  private sweep(agentId: number): void {
    const open = this.open.get(agentId);
    if (!open) return;
    let names: string[];
    try {
      names = readdirSync(open.inbox).filter((name) => !name.startsWith("."));
    } catch {
      return;
    }
    const files = names
      .map((name) => {
        const path = join(open.inbox, name);
        try {
          const st = statSync(path);
          return st.isFile() ? { path, name, at: st.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((f): f is { path: string; name: string; at: number } => f !== null)
      .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const file of files) {
      const text = readHead(file.path, NOTE_MAX_CHARS * 4 + 4);
      try {
        unlinkSync(file.path);
      } catch {
        continue; // taken already, or not ours to take
      }
      if (text !== null) this.post({ agentId, label: open.label }, text);
    }
  }

  /** Rewrite notes.txt (atomically: the shim may be reading it). */
  private render(): void {
    try {
      mkdirSync(this.boardDir, { recursive: true });
      const path = join(this.boardDir, "notes.txt");
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, this.notes.length ? this.notes.map(formatNote).join("\n") + "\n" : "");
      renameSync(tmp, path);
    } catch {
      // notes.jsonl holds the board; the text is a view of it.
    }
  }
}

/** A note as a line (or lines) of text: `#2 [agent 3 · api] text`, later lines indented. */
export function formatNote(note: Note): string {
  const kind = note.kind === "interface" ? " (interface change)" : note.kind === "scope" ? " (outside its scope)" : "";
  const [first = "", ...rest] = note.text.split("\n");
  return [`#${note.noteId} [agent ${note.by.agentId} · ${oneLine(note.by.label)}]${kind} ${first}`, ...rest.map((line) => `   ${line}`)].join("\n");
}

/**
 * The prompt section of an agent with notes on: how to post a note and read
 * the board, then the latest notes so far that fit {@link PROMPT_NOTES_CHARS}.
 */
export function notesPrompt(notes: readonly Note[]): string {
  const how =
    "This run has a notes board (an ODW extension): other agents of this run may work alongside you. " +
    "To tell the other agents something they must know (an interface you changed, a decision), run " +
    '`"$ODW_NOTES" "<your note>"` (the same as `odw note "<your note>"`). Keep each note short and concrete. ' +
    'To read the notes posted since you started, run `"$ODW_NOTES"` with no arguments.';
  if (notes.length === 0) return `${how}\n\nNo notes from the other agents in this run yet.`;
  const shown: string[] = [];
  let used = 0;
  for (let i = notes.length - 1; i >= 0; i--) {
    const line = formatNote(notes[i]!);
    if (shown.length > 0 && used + line.length + 1 > PROMPT_NOTES_CHARS) break;
    shown.unshift(line);
    used += line.length + 1;
  }
  const left = notes.length - shown.length;
  const omitted = left > 0 ? `(${left} earlier note${left === 1 ? "" : "s"} left out — run "$ODW_NOTES" to read them all)\n` : "";
  return `${how}\n\nNotes from the other agents in this run:\n${omitted}${shown.join("\n")}`;
}

/** Matches a diff line (after its +/-) that looks like a declaration: what other code may rely on. */
const SIGNATURE_RE =
  /^\s*(?:export\s|(?:async\s+)?def\s|func\s|pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s|(?:(?:public|private|protected|internal|abstract|final|sealed|static|data|open)\s+)*class\s|(?:(?:public|private|protected|internal)\s+)?interface\s)/;

/**
 * The note ODW posts for an agent that kept a change: its diff stat, the
 * files it touched, and the declaration-like lines its hunks add or remove —
 * capped. Null when the diff touches nothing.
 */
export function interfaceSummary(diff: string, changes?: AgentChanges): string | null {
  const files = new Map<string, { add: number; del: number }>();
  const signatures: string[] = [];
  const seen = new Set<string>();
  let file: { add: number; del: number } | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) {
      file = { add: 0, del: 0 };
      files.set(header[2]!, file);
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    if (sign === "+") file.add++;
    else file.del++;
    const body = line.slice(1);
    if (!SIGNATURE_RE.test(body)) continue;
    const shown = `${sign} ${oneLine(body.trim()).slice(0, SIGNATURE_CHARS)}`;
    if (seen.has(shown)) continue;
    seen.add(shown);
    signatures.push(shown);
  }
  if (files.size === 0) return null;
  const count = changes?.files ?? files.size;
  const add = changes?.insertions ?? [...files.values()].reduce((n, f) => n + f.add, 0);
  const del = changes?.deletions ?? [...files.values()].reduce((n, f) => n + f.del, 0);
  const listed = [...files].slice(0, SUMMARY_FILES).map(([path, f]) => `${path} (+${f.add} -${f.del})`);
  const more = files.size > SUMMARY_FILES ? `, and ${files.size - SUMMARY_FILES} more` : "";
  const lines = [`finished with a change to ${count} file${count === 1 ? "" : "s"} (+${add} -${del}): ${listed.join(", ")}${more}`];
  if (signatures.length > 0) {
    lines.push("Interface lines it added (+) or removed (-):");
    lines.push(...signatures.slice(0, SUMMARY_SIGNATURES));
    if (signatures.length > SUMMARY_SIGNATURES) lines.push(`… and ${signatures.length - SUMMARY_SIGNATURES} more`);
  } else {
    lines.push("No interface lines (export, def, func, pub fn, class, interface) in its diff.");
  }
  return lines.join("\n");
}

/** A run's notes, from its notes.jsonl: [] when it has none; malformed lines are skipped. */
export function readNotes(runDir: string): Note[] {
  let text: string;
  try {
    text = readFileSync(join(runDir, NOTES_FILE), "utf8");
  } catch {
    return [];
  }
  const out: Note[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const note = JSON.parse(line) as Note;
      if (isNote(note)) out.push(note);
    } catch {
      // a torn last line, mid-append: the next read sees it whole
    }
  }
  return out;
}

function isNote(value: unknown): value is Note {
  const n = value as Note;
  return (
    n !== null &&
    typeof n === "object" &&
    typeof n.noteId === "number" &&
    typeof n.text === "string" &&
    typeof n.by === "object" &&
    n.by !== null &&
    typeof n.by.agentId === "number" &&
    typeof n.by.label === "string"
  );
}

/**
 * Where `odw note` drops a note, from the agent's environment: the inbox
 * beside its `ODW_NOTES` shim — checked against its `ODW_RUN_ID` and
 * `ODW_AGENT_ID` — or, without one, `<runDir>/notes/<ODW_AGENT_ID>/inbox`
 * of the run `locate` finds. An Error saying what is missing otherwise.
 */
export function inboxFromEnv(
  env: Record<string, string | undefined>,
  locate: (runId: string) => string | null,
): string {
  const runId = env.ODW_RUN_ID;
  const agentId = env.ODW_AGENT_ID;
  if (!runId || !agentId || !/^\d+$/.test(agentId)) {
    throw new Error("odw note posts for an agent of a run: it needs the ODW_RUN_ID and ODW_AGENT_ID its agent CLI was started with");
  }
  const off =
    `agent ${agentId} of run ${runId} has no notes board — turn it on with agent(…, { notes: true }), ` +
    "parallel(…, { notes: true }) or the notes setting";
  const shim = env.ODW_NOTES;
  if (shim) {
    const agentDir = dirname(shim);
    const runDir = dirname(dirname(agentDir));
    if (!isAbsolute(shim) || basename(agentDir) !== agentId || basename(runDir) !== runId) {
      throw new Error(`ODW_NOTES (${shim}) is not agent ${agentId}'s of run ${runId}`);
    }
    const inbox = join(agentDir, "inbox");
    if (!existsSync(inbox)) throw new Error(off);
    return inbox;
  }
  const runDir = locate(runId);
  const inbox = runDir ? join(runDir, NOTES_DIR, agentId, "inbox") : null;
  if (!inbox || !existsSync(inbox)) throw new Error(off);
  return inbox;
}

/** Drop a note in an inbox, whole: written under a dot name, then renamed. */
export function dropNote(inbox: string, text: string): void {
  const name = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const tmp = join(inbox, `.${name}`);
  writeFileSync(tmp, text);
  renameSync(tmp, join(inbox, name));
}

/**
 * An agent's `ODW_NOTES` shim: POSIX sh, its board and inbox written in.
 * With arguments, it drops them (joined by spaces) in its inbox; without,
 * it prints the board.
 */
export function shimScript(boardFile: string, inbox: string): string {
  return [
    "#!/bin/sh",
    "# The run's notes board (an ODW extension), written by odw for one agent.",
    '#   "$ODW_NOTES" "text"   post a note for the other agents of this run',
    '#   "$ODW_NOTES"          print the notes posted so far',
    `board=${shQuote(boardFile)}`,
    `inbox=${shQuote(inbox)}`,
    'if [ "$#" -eq 0 ]; then',
    '  if [ -s "$board" ]; then cat "$board"; else echo "(no notes yet)"; fi',
    "  exit 0",
    "fi",
    "n=0",
    'while [ -e "$inbox/n-$$-$n" ] || [ -e "$inbox/.n-$$-$n" ]; do n=$((n + 1)); done',
    'printf \'%s\' "$*" > "$inbox/.n-$$-$n" && mv "$inbox/.n-$$-$n" "$inbox/n-$$-$n" || exit 1',
    'echo "note posted"',
    "",
  ].join("\n");
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Note text as kept: control characters but newlines and tabs dropped, CRLF folded, trimmed. */
function cleanNote(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** At most `max` bytes of a file, as text; null when it cannot be read. */
function readHead(path: string, max: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
