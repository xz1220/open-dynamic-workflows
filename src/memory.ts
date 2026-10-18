/**
 * Workflow memory with provenance (an ODW extension, opt-in).
 *
 * Each run starts cold: a correction a person made in one run is violated
 * again in the next. Memory keeps what earlier runs of a workflow learned in
 * the repository, as `.odw/memory/<workflow>.jsonl` — one {@link MemoryEntry}
 * per line — so it is reviewed in pull requests like any other file.
 *
 * Entries come only from explicit sources, never from a model summarizing:
 *
 *   - `odw note --keep "…"` (or `"$ODW_NOTES" --keep "…"`): a note an agent
 *     posts on the run's notes board and asks to keep — kind "note";
 *   - a checkpoint() rejected with a note, or approved with an edited payload
 *     — kind "correction" (the edit is summarized by a structural diff of
 *     the payload, not by a model);
 *   - an `expect` miss a later attempt of the same agent met — kind "lesson";
 *   - `odw memory add <wf> "text"`.
 *
 * Kept notes are always kept (the agent asked); corrections and lessons only
 * where memory is on: the `memory` setting, `agent(…, { memory: true })`
 * for that agent's lessons, `checkpoint(…, { memory: true | { paths } })`
 * for its corrections. What a run learned is written once it ends (kept
 * notes included), redacted with the run's redactor; the file holds at most
 * {@link MEMORY_MAX_ENTRIES} entries, the oldest pruned past it (said in the
 * run's log). The same entry learned again (same kind, text and paths)
 * replaces the older copy, so its provenance is the latest.
 *
 * Recall: an agent with memory on — `agent(…, { memory: true })`, or the
 * `memory` setting — finds the entries that still apply ahead of its task,
 * under "What earlier runs of this workflow learned", newest first, at most
 * {@link RECALL_MAX_BYTES} bytes. An entry is stale when a file its `paths`
 * (globs, relative to the repository's top) match changed between its
 * `commit` and HEAD (`git diff --name-only <commit> HEAD`); stale entries
 * are left out, and the run says how many. An entry without paths never goes
 * stale; one with paths whose commit git does not know (or outside git) is
 * stale: nothing vouches for it.
 *
 * An untrusted run (see ./untrusted) neither recalls nor keeps memory that
 * lives in the repository: the file is the repository's content, which an
 * untrusted run does not take instructions from, and what such a run learned
 * would reach later trusted runs' prompts. Memory the user keeps outside the
 * repository — `memoryDir` set by their own config to a directory outside it
 * — is theirs, and an untrusted run reads and writes it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { expandHome } from "./adapters/config.js";
import type { TrustLevel } from "./adapters/types.js";
import { LOG, event, type WorkflowEvent } from "./events.js";
import { globToRegExp } from "./expect.js";
import type { Redactor } from "./redact.js";
import { repositoryRoot } from "./untrusted.js";

/** Where memory lives, relative to the repository's top, unless `memoryDir` says otherwise. */
export const MEMORY_DIR = join(".odw", "memory");
/** Entries one workflow's file keeps; past it, the oldest are pruned. */
export const MEMORY_MAX_ENTRIES = 500;
/** Bytes of entries an agent's prompt recalls: the newest that fit. */
export const RECALL_MAX_BYTES = 4096;
/** Characters of one entry's text kept; past it, the text is cut. */
export const MEMORY_TEXT_MAX_CHARS = 2000;
/** The heading recalled entries go under. */
export const MEMORY_HEADING = "What earlier runs of this workflow learned";

export const MEMORY_KINDS = ["note", "correction", "lesson"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** One line of `.odw/memory/<workflow>.jsonl`. */
export interface MemoryEntry {
  /** 1, 2, … in the order the file took them; never reused within a file. */
  id: number;
  text: string;
  kind: MemoryKind;
  /** Globs, relative to the repository's top: the entry is stale once a file they match changes. [] never goes stale. */
  paths: string[];
  /** HEAD when it was learned (null: not a git repository). */
  commit: string | null;
  /** The run it came from (null: `odw memory add`). */
  run: string | null;
  /** The agent it came from, by label. */
  agent?: string;
  /** When it was learned, ISO 8601. */
  at: string;
}

/** What a source asks to keep; the store adds id, commit, run and time. */
export interface MemoryDraft {
  kind: MemoryKind;
  text: string;
  paths?: string[];
  agent?: string;
}

// --- where -----------------------------------------------------------------------------

/** The memory directory of the repository `source` is in: `memoryDir` (relative to the repository's top), else `.odw/memory`. */
export function memoryDirFor(source: string, setting: string | null | undefined): string {
  const root = repositoryRoot(source);
  return setting ? resolve(root, expandHome(setting)) : join(root, MEMORY_DIR);
}

/** Whether `dir` lies inside the repository `source` is in — the repository's own memory, not the user's. */
export function memoryInRepository(dir: string, source: string): boolean {
  const root = realOr(repositoryRoot(source));
  const path = realOr(dir);
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The file name a workflow's memory goes by: its name with anything but
 * letters, digits, `.`, `_` and `-` as `_` (a plugin's `p:name` is `p_name`).
 * Never a path: an Error for a name that maps to none.
 */
export function memoryFileName(workflow: string): string {
  const name = workflow.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  if (!name || /^\.+$/.test(name) || name.startsWith(".") || name.length > 200) {
    throw new Error(`"${workflow}" is not a workflow name memory can be kept under`);
  }
  return `${name}.jsonl`;
}

/** The memory file of `workflow` in `dir`. */
export function memoryFile(dir: string, workflow: string): string {
  return join(dir, memoryFileName(workflow));
}

/** The workflows that have a memory file in `dir`, by file name (without .jsonl), sorted. */
export function memoryWorkflows(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."))
      .map((name) => name.slice(0, -".jsonl".length))
      .sort();
  } catch {
    return [];
  }
}

// --- reading and writing ----------------------------------------------------------------

/** A memory file's entries, in order: [] when there is none; malformed lines are skipped. */
export function readMemory(file: string): MemoryEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (isEntry(entry)) out.push(entry);
    } catch {
      // a line someone broke by hand: the rest still counts
    }
  }
  return out;
}

/** Write a memory file whole (atomically: a run may be reading it). */
export function writeMemory(file: string, entries: readonly MemoryEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""));
  renameSync(tmp, file);
}

export interface AddMemoryOptions {
  /** The run the entries come from (null: none). */
  run: string | null;
  /** The commit they were learned at (null: outside git). */
  commit: string | null;
  redactor?: Redactor;
  /** Entries the file keeps (default {@link MEMORY_MAX_ENTRIES}). */
  max?: number;
  /** The time they were learned (tests). */
  now?: Date;
}

/**
 * Add entries to a memory file: each cleaned, cut at
 * {@link MEMORY_TEXT_MAX_CHARS}, redacted, given the next id; an older entry
 * with the same kind, text and paths is replaced. Past `max` entries the
 * oldest go. Returns what was added and how many were pruned. Throws when the
 * file cannot be written.
 */
export function addMemory(file: string, drafts: readonly MemoryDraft[], options: AddMemoryOptions): { added: MemoryEntry[]; pruned: number } {
  const entries = readMemory(file);
  let next = entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  const at = (options.now ?? new Date()).toISOString();
  const added: MemoryEntry[] = [];
  for (const draft of drafts) {
    let text = cleanText(draft.text);
    if (!text) continue;
    if (text.length > MEMORY_TEXT_MAX_CHARS) text = text.slice(0, MEMORY_TEXT_MAX_CHARS - 1) + "…";
    if (options.redactor) text = options.redactor.text(text);
    const paths = [...new Set(draft.paths ?? [])];
    const entry: MemoryEntry = {
      id: next++,
      text,
      kind: draft.kind,
      paths,
      commit: options.commit,
      run: options.run,
      ...(draft.agent ? { agent: options.redactor ? options.redactor.text(draft.agent) : draft.agent } : {}),
      at,
    };
    const same = entries.findIndex((old) => old.kind === entry.kind && old.text === entry.text && samePaths(old.paths, entry.paths));
    if (same !== -1) entries.splice(same, 1);
    entries.push(entry);
    added.push(entry);
  }
  const max = options.max ?? MEMORY_MAX_ENTRIES;
  const pruned = Math.max(0, entries.length - max);
  if (pruned > 0) entries.splice(0, pruned);
  if (added.length > 0 || pruned > 0) writeMemory(file, entries);
  return { added, pruned };
}

/**
 * Check the globs an entry is about: relative to the repository's top, no
 * `..` segment, no git pathspec magic. An Error saying which is wrong.
 */
export function checkMemoryPaths(paths: readonly unknown[]): string[] {
  return paths.map((path) => {
    if (typeof path !== "string" || path.trim() === "") throw new Error(`memory paths are globs (non-empty strings); got ${JSON.stringify(path)}`);
    const glob = path.trim().replace(/\\/g, "/");
    if (isAbsolute(glob) || glob.startsWith("/") || /^[A-Za-z]:/.test(glob)) {
      throw new Error(`memory paths are relative to the repository's top; got "${path}"`);
    }
    if (glob.split("/").includes("..")) throw new Error(`memory paths stay inside the repository; got "${path}"`);
    if (glob.startsWith(":")) throw new Error(`memory paths are globs, not git pathspecs; got "${path}"`);
    try {
      globToRegExp(glob);
    } catch (err) {
      throw new Error(`memory path "${path}" is not a glob: ${(err as Error).message}`);
    }
    return glob.startsWith("./") ? glob.slice(2) : glob;
  });
}

// --- staleness ----------------------------------------------------------------------------

/** HEAD of the repository `source` is in; null outside git (or with no commit yet). */
export function headCommitOf(source: string): string | null {
  try {
    const sha = execFileSync("git", ["-C", source, "rev-parse", "--verify", "-q", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    return COMMIT_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The ids of the entries that no longer apply: one with paths is stale when a
 * file they match (a glob, or a directory and all under it) changed between
 * its commit and HEAD — or when its commit is unknown to git, or there is no
 * git. Entries without paths never are. One `git diff` per distinct commit.
 */
export function staleEntries(root: string, entries: readonly MemoryEntry[]): Set<number> {
  const stale = new Set<number>();
  const changed = new Map<string, string[] | null>();
  for (const entry of entries) {
    if (entry.paths.length === 0) continue;
    const commit = entry.commit;
    if (!commit || !COMMIT_RE.test(commit)) {
      stale.add(entry.id);
      continue;
    }
    if (!changed.has(commit)) changed.set(commit, changedSince(root, commit));
    const files = changed.get(commit);
    if (!files) {
      stale.add(entry.id);
      continue;
    }
    if (files.length === 0) continue;
    const patterns = entry.paths.flatMap((glob) => {
      try {
        const bare = glob.replace(/\/+$/, "");
        return [globToRegExp(bare), globToRegExp(`${bare}/**`)];
      } catch {
        return [];
      }
    });
    // A glob that no longer compiles vouches for nothing.
    if (patterns.length === 0 || files.some((file) => patterns.some((pattern) => pattern.test(file)))) stale.add(entry.id);
  }
  return stale;
}

/** The files that changed between `commit` and HEAD, relative to the top; null when git cannot say. */
function changedSince(root: string, commit: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", root, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", "-z", "--no-ext-diff", commit, "HEAD", "--"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** One workflow's memory as `odw memory list --json` and GET /api/memory show it. */
export interface WorkflowMemory {
  /** The workflow, as its file names it. */
  workflow: string;
  file: string;
  entries: Array<MemoryEntry & { stale: boolean }>;
}

/**
 * The memory of the repository `source` is in — of `workflow`, or of every
 * workflow that has a file — each entry marked stale or not. Throws on a
 * workflow name memory cannot be kept under.
 */
export function listMemory(source: string, setting: string | null | undefined, workflow?: string): WorkflowMemory[] {
  const dir = memoryDirFor(source, setting);
  const root = repositoryRoot(source);
  return (workflow !== undefined ? [workflow] : memoryWorkflows(dir)).map((name) => {
    const file = memoryFile(dir, name);
    const entries = readMemory(file);
    const stale = staleEntries(root, entries);
    return { workflow: name, file, entries: entries.map((entry) => ({ ...entry, stale: stale.has(entry.id) })) };
  });
}

// --- recall -------------------------------------------------------------------------------

/** What recall put in an agent's prompt, and what it left out. */
export interface Recall {
  /** The prompt section; "" when no entry applies. */
  text: string;
  shown: number;
  stale: number;
  /** Entries that apply but did not fit {@link RECALL_MAX_BYTES}. */
  cut: number;
}

/**
 * The prompt section of the entries that still apply: newest first (by id),
 * as many as fit `maxBytes`, under {@link MEMORY_HEADING}.
 */
export function recallSection(entries: readonly MemoryEntry[], stale: ReadonlySet<number>, maxBytes = RECALL_MAX_BYTES): Recall {
  const live = entries.filter((entry) => !stale.has(entry.id)).sort((a, b) => b.id - a.id);
  const head =
    `## ${MEMORY_HEADING}\n` +
    "(ODW workflow memory: kept from earlier runs of this workflow by people and checks, not by a model. " +
    "Take them into account; the task below still comes first.)";
  const lines: string[] = [];
  let used = Buffer.byteLength(head);
  for (const entry of live) {
    const line = formatEntry(entry);
    const size = Buffer.byteLength(line) + 1;
    if (used + size > maxBytes) break;
    lines.push(line);
    used += size;
  }
  return {
    text: lines.length ? `${head}\n${lines.join("\n")}` : "",
    shown: lines.length,
    stale: entries.length - live.length,
    cut: live.length - lines.length,
  };
}

/** An entry as a line (or lines) of a prompt or of `odw memory list`: `- [correction · 2026-10-18] text`. */
export function formatEntry(entry: MemoryEntry): string {
  const [first = "", ...rest] = entry.text.split("\n");
  const about = entry.paths.length ? ` (about ${entry.paths.join(", ")})` : "";
  return [`- [${entry.kind} · ${entry.at.slice(0, 10)}] ${first}${rest.length ? "" : about}`, ...rest.map((line, i) => `  ${line}${i === rest.length - 1 ? about : ""}`)].join("\n");
}

// --- the run's memory ------------------------------------------------------------------------

export interface RunMemoryOptions {
  /** The run's source directory: memory is its repository's. */
  source: string;
  /** The `memoryDir` setting. */
  dir: string | null;
  runId: string;
  /** The workflow's name, once known (the worker learns it as the script loads). */
  workflow: () => string | null;
  trust: TrustLevel;
  redactor?: Redactor;
  emit: (ev: WorkflowEvent) => void;
  /** False for a run no model answers (`odw test`, `--dry`): it recalls, but keeps nothing. */
  write?: boolean;
}

/**
 * One run's memory, owned by its worker: recall read once, on the first agent
 * that asks; what the run learned held until {@link RunMemory.flush}.
 */
export class RunMemory {
  private readonly dir: string;
  private readonly allowed: boolean;
  private recalled: Recall | null | undefined;
  private readonly pending: MemoryDraft[] = [];
  private readonly commits: Array<string | null> = [];
  private refusedSaid = false;

  constructor(private readonly opts: RunMemoryOptions) {
    this.dir = memoryDirFor(opts.source, opts.dir);
    this.allowed = opts.trust !== "untrusted" || !memoryInRepository(this.dir, opts.source);
  }

  /** The recall section for an agent's prompt ("" when nothing applies); said once per run. Never throws. */
  recall(): string {
    if (this.recalled !== undefined) return this.recalled?.text ?? "";
    this.recalled = null;
    if (!this.allowed) {
      this.refused();
      return "";
    }
    const workflow = this.opts.workflow();
    if (!workflow) return "";
    try {
      const file = memoryFile(this.dir, workflow);
      const entries = readMemory(file);
      const recall = recallSection(entries, staleEntries(repositoryRoot(this.opts.source), entries));
      this.recalled = recall;
      const where = this.where(file);
      const parts = [`${recall.shown} entr${recall.shown === 1 ? "y" : "ies"} recalled from ${where}`];
      if (recall.stale > 0) parts.push(`${recall.stale} stale (files they are about changed since) left out`);
      if (recall.cut > 0) parts.push(`${recall.cut} older left out over the ${RECALL_MAX_BYTES}-byte cap`);
      this.say(`memory: ${parts.join("; ")}`, { recalled: recall.shown, stale: recall.stale, cut: recall.cut });
      return recall.text;
    } catch (err) {
      this.say(`memory: could not recall: ${errorText(err)}`);
      return "";
    }
  }

  /** Keep `draft` once the run ends, at HEAD as it is now. Never throws. */
  record(draft: MemoryDraft): void {
    if (!cleanText(draft.text)) return;
    if (!this.allowed) {
      this.refused();
      return;
    }
    this.pending.push(draft);
    this.commits.push(headCommitOf(this.opts.source));
  }

  /** Write what the run learned; said in the run's log. Never throws. */
  flush(): void {
    if (this.pending.length === 0) return;
    const drafts = this.pending.splice(0);
    const commits = this.commits.splice(0);
    if (this.opts.write === false) {
      this.say(`memory: ${drafts.length} entr${drafts.length === 1 ? "y" : "ies"} not kept — a run no model answers keeps no memory`);
      return;
    }
    const workflow = this.opts.workflow();
    if (!workflow) return;
    try {
      const file = memoryFile(this.dir, workflow);
      let added = 0;
      let pruned = 0;
      // One write per commit the entries were learned at (usually one).
      for (const commit of [...new Set(commits)]) {
        const group = drafts.filter((_, i) => commits[i] === commit);
        const done = addMemory(file, group, { run: this.opts.runId, commit, redactor: this.opts.redactor });
        added += done.added.length;
        pruned += done.pruned;
      }
      const where = this.where(file);
      this.say(`memory: kept ${added} entr${added === 1 ? "y" : "ies"} in ${where}`, { kept: added });
      if (pruned > 0) {
        this.say(`memory: ${where} is over ${MEMORY_MAX_ENTRIES} entries — pruned the ${pruned} oldest`, { pruned });
      }
    } catch (err) {
      this.say(`memory: could not keep what this run learned: ${errorText(err)}`);
    }
  }

  private where(file: string): string {
    const rel = relative(repositoryRoot(this.opts.source), file);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : file;
  }

  private refused(): void {
    if (this.refusedSaid) return;
    this.refusedSaid = true;
    this.say(
      `memory: an untrusted run neither recalls nor keeps the repository's memory (${this.where(this.dir)}) — ` +
        "it is the repository's content; set memoryDir in your own config to a directory outside the repository to use yours",
      { trust: "untrusted" },
    );
  }

  private say(message: string, fields: Record<string, unknown> = {}): void {
    try {
      this.opts.emit(event(LOG, { message, memory: fields }));
    } catch {
      // the log is unwritable for a moment: memory goes on without the line
    }
  }
}

// --- corrections -------------------------------------------------------------------------------

/** Changes an edit summary lists before "and N more". */
const EDIT_CHANGES = 8;
/** Characters of a value an edit summary shows. */
const EDIT_VALUE_CHARS = 80;

/**
 * What a person changed in a checkpoint's payload, as a structural diff — no
 * model: `$.steps[2]: "a" → "b"; removed $.extra; added $.owner = "x"`.
 */
export function editSummary(before: unknown, after: unknown): string {
  const changes: string[] = [];
  const walk = (a: unknown, b: unknown, at: string): void => {
    if (jsonText(a) === jsonText(b)) return;
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of Object.keys(a)) {
        if (!(key in b)) changes.push(`removed ${at}${keyPath(key)}`);
        else walk(a[key], b[key], `${at}${keyPath(key)}`);
      }
      for (const key of Object.keys(b)) if (!(key in a)) changes.push(`added ${at}${keyPath(key)} = ${shown(b[key])}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (i >= b.length) changes.push(`removed ${at}[${i}]`);
        else if (i >= a.length) changes.push(`added ${at}[${i}] = ${shown(b[i])}`);
        else walk(a[i], b[i], `${at}[${i}]`);
      }
      return;
    }
    changes.push(`${at}: ${shown(a)} → ${shown(b)}`);
  };
  walk(before, after, "$");
  const more = changes.length - EDIT_CHANGES;
  return changes.slice(0, EDIT_CHANGES).join("; ") + (more > 0 ? `; and ${more} more` : "");
}

// --- helpers ------------------------------------------------------------------------------------

const COMMIT_RE = /^[0-9a-f]{7,64}$/;

function isEntry(value: unknown): value is MemoryEntry {
  const e = value as MemoryEntry;
  return (
    e !== null &&
    typeof e === "object" &&
    typeof e.id === "number" &&
    typeof e.text === "string" &&
    (MEMORY_KINDS as readonly string[]).includes(e.kind) &&
    Array.isArray(e.paths) &&
    e.paths.every((p) => typeof p === "string") &&
    (e.commit === null || typeof e.commit === "string") &&
    typeof e.at === "string"
  );
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** Text as kept: control characters but newlines and tabs dropped, CRLF folded, trimmed. */
function cleanText(raw: string): string {
  return String(raw)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keyPath(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function jsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function shown(value: unknown): string {
  const text = jsonText(value) ?? String(value);
  return text.length > EDIT_VALUE_CHARS ? text.slice(0, EDIT_VALUE_CHARS - 1) + "…" : text;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Not there yet: its nearest existing parent's real path, plus the rest.
    const parent = dirname(path);
    return parent === path ? path : join(realOr(parent), basename(path));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
