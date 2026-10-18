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
 *     `pub fn`, `class`, `interface`), a cheap language-agnostic heuristic;
 *   - with memory on too, can keep a note for later runs of the workflow:
 *     `"$ODW_NOTES" --keep "text"` (or `odw note --keep [--paths …]`) posts
 *     it marked `keep`, and the worker hands it to the run's workflow memory
 *     (./memory), written when the run ends. An agent with memory off is not
 *     told of `--keep`; a note it posts so anyway goes on the board unkept, and
 *     the run says so.
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
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

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
  /** Posted with `--keep` (ODW extension; see ./memory): it becomes workflow memory when the run ends. */
  keep?: true;
  /** A kept note's globs (`odw note --keep --paths`): it goes stale once files they match change. */
  paths?: string[];
}

/** What an agent with notes on gets: its environment, its container binds, its prompt section, and its end. */
export interface AgentNotes {
  /** `ODW_NOTES`: its shim's path. */
  env: Record<string, string>;
  /** Its inbox read-write, its shim and the board's directory read-only, at the same paths (container sandbox). */
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
  /** Told of each note posted with `--keep`, once it is on the board (workflow memory; see ./memory). */
  onKeep?: (note: Note) => void;
}

/**
 * One run's board, owned by its worker. Nothing is created on disk until an
 * agent with notes on starts or a note is posted.
 */
export class NotesBoard {
  private readonly notes: Note[] = [];
  private bytes = 0;
  private full = false;
  private readonly open = new Map<number, { inbox: string; agentDir: string; label: string; keep: boolean }>();
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
  post(
    by: { agentId: number; label: string },
    raw: string,
    kind: Note["kind"] = "note",
    keep?: { paths: string[] },
  ): Note | null {
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
      ...(keep ? { keep: true as const, ...(keep.paths.length ? { paths: keep.paths } : {}) } : {}),
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
    if (note.keep) {
      try {
        this.opts.onKeep?.(note);
      } catch (err) {
        this.opts.emit(event(LOG, { message: `could not keep note #${note.noteId} for later runs: ${errorText(err)}` }));
      }
    }
    return note;
  }

  /**
   * Set up an agent with notes on: its shim and inbox, and its prompt section
   * (the notes so far). Its inbox is looked at until {@link AgentNotes.close}.
   * `keep`: it has workflow memory on, so the notes it asks to keep are kept
   * (see ./memory); without, it is not told of `--keep`.
   */
  openAgent(agentId: number, label: string, opts: { keep?: boolean } = {}): AgentNotes {
    const keep = opts.keep === true;
    const agentDir = join(this.dir, String(agentId));
    const inbox = join(agentDir, "inbox");
    const shim = join(agentDir, "note");
    const boardFile = join(this.boardDir, "notes.txt");
    mkdirSync(inbox, { recursive: true });
    mkdirSync(this.boardDir, { recursive: true });
    if (!existsSync(boardFile)) this.render();
    writeFileSync(shim, shimScript(boardFile, inbox), { mode: 0o755 });
    chmodSync(shim, 0o755);
    this.open.set(agentId, { inbox, agentDir, label, keep });
    if (!this.timer) {
      this.timer = setInterval(() => this.sweepAll(), this.opts.pollMs ?? NOTE_POLL_MS);
      this.timer.unref();
    }
    let closed = false;
    return {
      env: { ODW_NOTES: shim },
      // Not its whole notes directory: from there it could swap its inbox for a link.
      mounts: [
        { source: inbox, target: inbox, readonly: false },
        { source: shim, target: shim, readonly: true },
        { source: this.boardDir, target: this.boardDir, readonly: true },
      ],
      prompt: notesPrompt(this.notes, keep),
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

  /**
   * Post what an agent's inbox holds, oldest first, and empty it. The inbox
   * is the agent's to write, so nothing in it is followed: the inbox must be
   * a real directory inside its agent's notes directory, and only regular
   * files in it are read (and only they are removed).
   */
  private sweep(agentId: number): void {
    const open = this.open.get(agentId);
    if (!open) return;
    const inbox = realInbox(open.inbox, open.agentDir);
    if (!inbox) return;
    let names: string[];
    try {
      names = readdirSync(inbox).filter((name) => !name.startsWith("."));
    } catch {
      return;
    }
    const files = names
      .map((name) => {
        const path = join(inbox, name);
        try {
          const st = lstatSync(path);
          return st.isFile() ? { path, name, at: st.mtimeMs, ino: st.ino } : null;
        } catch {
          return null;
        }
      })
      .filter((f): f is { path: string; name: string; at: number; ino: number } => f !== null)
      .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const file of files) {
      const text = readHead(file.path, NOTE_MAX_CHARS * 4 + 4, file.ino);
      if (text === null) continue; // swapped for something else since: left alone
      try {
        // Only the file just read: unlink never follows the name's own link,
        // and one swapped in since is not ours to take.
        if (lstatSync(file.path).ino !== file.ino) continue;
        unlinkSync(file.path);
      } catch {
        continue; // taken already, or not ours to take
      }
      if (file.name.startsWith(KEEP_PREFIX)) {
        const kept = keptNote(text);
        if (open.keep) {
          this.post({ agentId, label: open.label }, kept.text, "note", { paths: kept.paths });
          continue;
        }
        // Memory is off for it: on the board, but not kept for later runs.
        const posted = this.post({ agentId, label: open.label }, kept.text);
        if (posted) {
          this.opts.emit(
            event(LOG, {
              message: `note #${posted.noteId} from ${open.label}:${agentId} asked to be kept, but memory is off for that agent — posted, not kept`,
            }),
          );
        }
      } else {
        this.post({ agentId, label: open.label }, text);
      }
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

/** An inbox file named so holds a note to keep as workflow memory (`--keep`; see ./memory). */
export const KEEP_PREFIX = "keep-";

/**
 * A kept note's inbox file: `{"text": …, "paths": [globs]}` as `odw note
 * --keep --paths` writes it, else (the shim's `--keep`) the note's plain text.
 * Paths that are not relative globs inside the repository are dropped.
 */
export function keptNote(raw: string): { text: string; paths: string[] } {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; paths?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
      const paths = Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === "string") : [];
      return { text: parsed.text, paths: paths.flatMap((p) => safeGlob(p)).slice(0, 20) };
    }
  } catch {
    // plain text
  }
  return { text: raw, paths: [] };
}

/** One glob as memory keeps it, or none (see checkMemoryPaths in ./memory, which odw note applies first). */
function safeGlob(path: string): string[] {
  const glob = path.trim().replace(/\\/g, "/");
  if (!glob || glob.startsWith("/") || glob.startsWith(":") || /^[A-Za-z]:/.test(glob) || glob.split("/").includes("..")) return [];
  return [glob.length > 300 ? glob.slice(0, 300) : glob];
}

/** A note as a line (or lines) of text: `#2 [agent 3 · api] text`, later lines indented. */
export function formatNote(note: Note): string {
  const kind =
    (note.kind === "interface" ? " (interface change)" : note.kind === "scope" ? " (outside its scope)" : "") +
    (note.keep ? " (kept for later runs)" : "");
  const [first = "", ...rest] = note.text.split("\n");
  return [`#${note.noteId} [agent ${note.by.agentId} · ${oneLine(note.by.label)}]${kind} ${first}`, ...rest.map((line) => `   ${line}`)].join("\n");
}

/**
 * The prompt section of an agent with notes on: how to post a note and read
 * the board, then the latest notes so far that fit {@link PROMPT_NOTES_CHARS}.
 * `keep`: it has workflow memory on, so it is told how to keep a note for later runs.
 */
export function notesPrompt(notes: readonly Note[], keep = false): string {
  const how =
    "This run has a notes board (an ODW extension): other agents of this run may work alongside you. " +
    "To tell the other agents something they must know (an interface you changed, a decision), run " +
    '`"$ODW_NOTES" "<your note>"` (the same as `odw note "<your note>"`). Keep each note short and concrete. ' +
    'To read the notes posted since you started, run `"$ODW_NOTES"` with no arguments.' +
    (keep
      ? ' A note that later runs of this workflow should know too (a lasting lesson, not this run\'s chatter) can be kept: `"$ODW_NOTES" --keep "<your note>"`.'
      : "");
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

/** Drop a note in an inbox, whole: written under a dot name, then renamed. `keep`: a note to keep as workflow memory. */
export function dropNote(inbox: string, text: string, keep?: { paths: string[] }): void {
  const name = `${keep ? KEEP_PREFIX : ""}${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const tmp = join(inbox, `.${name}`);
  writeFileSync(tmp, keep ? JSON.stringify({ text, paths: keep.paths }) : text);
  renameSync(tmp, join(inbox, name));
}

/**
 * An agent's `ODW_NOTES` shim: POSIX sh, its board and inbox written in.
 * With arguments, it drops them (joined by spaces) in its inbox — after a
 * leading `--keep`, as a note to keep for later runs; without, it prints
 * the board.
 */
export function shimScript(boardFile: string, inbox: string): string {
  return [
    "#!/bin/sh",
    "# The run's notes board (an ODW extension), written by odw for one agent.",
    '#   "$ODW_NOTES" "text"          post a note for the other agents of this run',
    '#   "$ODW_NOTES" --keep "text"   ...and keep it for later runs of the workflow (workflow memory)',
    '#   "$ODW_NOTES"                 print the notes posted so far',
    `board=${shQuote(boardFile)}`,
    `inbox=${shQuote(inbox)}`,
    "keep=",
    'if [ "$1" = "--keep" ]; then',
    "  keep=keep-",
    "  shift",
    '  if [ "$#" -eq 0 ]; then echo \'usage: "$ODW_NOTES" --keep "text"\' >&2; exit 2; fi',
    "fi",
    'if [ "$#" -eq 0 ]; then',
    '  if [ -s "$board" ]; then cat "$board"; else echo "(no notes yet)"; fi',
    "  exit 0",
    "fi",
    "n=0",
    'f="${keep}n-$$-$n"',
    'while [ -e "$inbox/$f" ] || [ -e "$inbox/.$f" ]; do n=$((n + 1)); f="${keep}n-$$-$n"; done',
    'printf \'%s\' "$*" > "$inbox/.$f" && mv "$inbox/.$f" "$inbox/$f" || exit 1',
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

/**
 * An agent's inbox as a real path, or null when it is not one to read: it must
 * be a directory itself — not a link to one — whose real path lies in the
 * agent's own notes directory.
 */
function realInbox(inbox: string, agentDir: string): string | null {
  try {
    if (!lstatSync(inbox).isDirectory()) return null;
    const real = realpathSync(inbox);
    const parent = realpathSync(agentDir);
    return real.startsWith(parent.endsWith(sep) ? parent : parent + sep) ? real : null;
  } catch {
    return null;
  }
}

/**
 * At most `max` bytes of a regular file, as text; null when it cannot be read
 * or is not one. The name's own link is never followed, a FIFO never waited
 * on, and with `ino` the file opened must be that one.
 */
function readHead(path: string, max: number, ino?: number): string | null {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW where the platform has it (not Windows, where links need privilege).
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || (ino !== undefined && st.ino !== ino)) return null;
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
