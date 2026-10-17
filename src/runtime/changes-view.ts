/**
 * The review side of what isolated agents changed (L5, an ODW extension):
 * what `odw diff` and `odw apply` read of the diffs a run kept.
 *
 * An isolated agent that changed anything left a unified diff in the run
 * directory, `agents/<agentId>.diff` (see ../changes). `odw diff` prints them,
 * or a table of who changed how much; `odw apply` previews and applies them
 * to the working tree it is run in (see ./apply), reading their files here.
 */

import { existsSync } from "node:fs";

import { TRUNCATION_NOTE, type AgentChanges } from "../changes.js";
import { displayWidth, padEndWidth, palette, sanitizeText, truncateToWidth, type TermCaps } from "../tty.js";
import { agentRows, type AgentRow } from "./agents-view.js";
import type { RunStore } from "./run-store.js";

/** An agent of a run that kept a diff, and where. */
export interface ChangedAgent {
  row: AgentRow & { agentId: number };
  file: string;
}

/** The agents of a run that kept a diff, in call order. */
export function changedAgents(store: RunStore, runId: string, rows: AgentRow[] = agentRows(store, runId)): ChangedAgent[] {
  const out: ChangedAgent[] = [];
  for (const row of rows) {
    if (row.agentId === null) continue;
    const file = store.agentDiffPath(runId, row.agentId);
    if (existsSync(file)) out.push({ row: row as AgentRow & { agentId: number }, file });
  }
  return out;
}

// --- reading a kept diff --------------------------------------------------------------

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

/** One file of a diff: its paths (null on the side where it does not exist), what happened, its lines. */
export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  insertions: number;
  deletions: number;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const ESCAPES: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };

/**
 * The files of a diff as ODW keeps it — `a/` and `b/` prefixes, unusual paths
 * C-quoted (the same reading as the dashboard's web/src/components/diff.ts).
 * A diff cut at its size cap yields the files it shows, the last maybe in part.
 */
export function diffFiles(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split("\n")) {
    if (file && (oldLeft > 0 || newLeft > 0)) {
      const op = line[0];
      // A blank line inside a hunk is a context line whose space was trimmed.
      if (op === " " || line === "") {
        oldLeft--;
        newLeft--;
        continue;
      }
      if (op === "-") {
        oldLeft--;
        file.deletions++;
        continue;
      }
      if (op === "+") {
        newLeft--;
        file.insertions++;
        continue;
      }
      if (op === "\\") continue;
      oldLeft = newLeft = 0; // the hunk was cut short
    }
    if (line.startsWith("diff --git ")) {
      const paths = gitPaths(line.slice("diff --git ".length));
      file = { oldPath: paths?.[0] ?? null, newPath: paths?.[1] ?? null, status: "modified", binary: false, insertions: 0, deletions: 0 };
      files.push(file);
      continue;
    }
    if (!file) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    } else if (line.startsWith("--- ")) {
      file.oldPath = headerPath(line.slice(4), "a/");
      if (file.oldPath === null) file.status = "added";
    } else if (line.startsWith("+++ ")) {
      file.newPath = headerPath(line.slice(4), "b/");
      if (file.newPath === null) file.status = "deleted";
    } else if (line.startsWith("new file mode")) {
      file.status = "added";
      file.oldPath = null;
    } else if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      file.newPath = null;
    } else if (/^(rename|copy) from /.test(line)) {
      file.status = line.startsWith("rename") ? "renamed" : "copied";
      file.oldPath = unquote(line.slice(line.indexOf(" from ") + 6));
    } else if (/^(rename|copy) to /.test(line)) {
      file.status = line.startsWith("rename") ? "renamed" : "copied";
      file.newPath = unquote(line.slice(line.indexOf(" to ") + 4));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
  }
  return files;
}

/** The truncation note a diff cut at its size cap ends with, or null when it is whole. */
export function truncationNoteOf(text: string): string | null {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const last = body.slice(body.lastIndexOf("\n") + 1);
  return last.startsWith(TRUNCATION_NOTE) ? last : null;
}

/** A diff's own counts, for a kept diff whose event and record are gone. */
export function countChanges(text: string): AgentChanges {
  const files = diffFiles(text);
  return {
    files: files.length,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated: truncationNoteOf(text) !== null,
  };
}

/** A C-quoted path as git writes it (octal escapes are UTF-8 bytes), and the rest of the line. */
function readQuoted(s: string): [string, string] {
  const bytes: number[] = [];
  let i = 1;
  for (; i < s.length && s[i] !== '"'; i++) {
    let c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      const n = s[++i]!;
      const octal = /^[0-7]{1,3}/.exec(s.slice(i));
      if (octal) {
        bytes.push(parseInt(octal[0], 8) & 0xff);
        i += octal[0].length - 1;
        continue;
      }
      c = ESCAPES[n] ?? n;
    }
    bytes.push(...Buffer.from(c, "utf8"));
  }
  return [Buffer.from(bytes).toString("utf8"), s.slice(i + 1)];
}

function unquote(s: string): string {
  return s.startsWith('"') ? readQuoted(s)[0] : s;
}

function dropPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The two paths of a `diff --git a/X b/Y` line. */
function gitPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const [a, after] = readQuoted(rest);
    return [dropPrefix(a, "a/"), dropPrefix(unquote(after.trimStart()), "b/")];
  }
  // Unrenamed (the common case): "a/X b/X" splits exactly in the middle,
  // which stays right even when X contains " b/".
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)) return [a.slice(2), b.slice(2)];
  }
  const quoted = rest.indexOf(' "');
  if (quoted > 0) return [dropPrefix(rest.slice(0, quoted), "a/"), dropPrefix(unquote(rest.slice(quoted + 1)), "b/")];
  const split = rest.indexOf(" b/");
  if (split > 0) return [dropPrefix(rest.slice(0, split), "a/"), rest.slice(split + 3)];
  return null;
}

/** The path of a `--- a/X` / `+++ b/X` header; null for /dev/null. */
function headerPath(s: string, prefix: string): string | null {
  const path = s.startsWith('"') ? readQuoted(s)[0] : s.split("\t")[0]!;
  return path === "/dev/null" ? null : dropPrefix(path, prefix);
}

// --- showing it ---------------------------------------------------------------------

const MARK: Record<FileStatus, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C" };

/** A file as one line of a listing: its status letter and path ("R old → new"). */
export function fileLabel(f: DiffFile, caps: TermCaps): string {
  const arrow = caps.unicode ? "→" : "->";
  const path = f.status === "renamed" || f.status === "copied" ? `${f.oldPath} ${arrow} ${f.newPath}` : (f.newPath ?? f.oldPath ?? "?");
  return `${MARK[f.status]} ${sanitizeText(path, 200)}`;
}

/** `+3 -1`, or `binary`. */
function lineCounts(f: { binary?: boolean; insertions: number; deletions: number }): string {
  return f.binary ? "binary" : `+${f.insertions} -${f.deletions}`;
}

/** One agent's files, as `odw diff --stat --agent` lists them. */
export function formatFileList(files: DiffFile[], opts: { width: number; caps: TermCaps }): string[] {
  const p = palette(opts.caps);
  const labels = files.map((f) => fileLabel(f, opts.caps));
  const width = Math.min(Math.max(0, ...labels.map(displayWidth)), Math.max(20, opts.width - 20));
  return files.map((f, i) => truncateToWidth(`  ${padEndWidth(truncateToWidth(labels[i]!, width), width)}  ${p.dim(lineCounts(f))}`, opts.width));
}

/**
 * The `odw diff --stat` table: per agent that kept a diff — ID, STATE, LABEL,
 * FILES, lines added (+) and removed (-), and the BRANCH it was kept on — and
 * a mark on a diff that was cut at its size cap.
 */
export function formatChangeTable(
  agents: Array<{ row: AgentRow; changes: AgentChanges }>,
  opts: { width: number; caps: TermCaps },
): string[] {
  const p = palette(opts.caps);
  const header = ["ID", "STATE", "LABEL", "FILES", "+", "-", "BRANCH"];
  const cells = agents.map(({ row, changes }) => [
    String(row.agentId ?? "-"),
    row.state,
    sanitizeText(row.label, 28),
    String(changes.files),
    `+${changes.insertions}`,
    `-${changes.deletions}`,
    row.branch ? sanitizeText(row.branch, 120) : "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => displayWidth(c[i]!))));
  const right = new Set([0, 3, 4, 5]);
  const line = (c: string[]): string =>
    c.map((s, i) => (right.has(i) ? s.padStart(widths[i]!) : padEndWidth(s, widths[i]!))).join("  ").trimEnd();
  const out = [p.dim(line(header))];
  agents.forEach(({ changes }, i) => {
    const cut = changes.truncated ? `  ${p.run("diff cut at maxDiffBytes")}` : "";
    out.push(truncateToWidth(line(cells[i]!) + cut, opts.width));
  });
  return out;
}

/** A diff for a terminal: headers bold, additions and removals in the signal and alarm inks, notes dim. */
export function colorDiff(text: string, caps: TermCaps): string {
  if (!caps.color) return text;
  const p = palette(caps);
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) return p.bold(line);
      if (line.startsWith("+++ ") || line.startsWith("--- ")) return p.bold(line);
      if (line.startsWith("@@")) return p.run(line);
      if (line.startsWith("+")) return p.ok(line);
      if (line.startsWith("-")) return p.err(line);
      if (line.startsWith("#")) return p.dim(line);
      return line;
    })
    .join("\n");
}
