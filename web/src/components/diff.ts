/**
 * Unified diffs — what an isolated agent changed — parsed from `git diff`
 * output and drawn as a review sheet: one collapsible card per file with old
 * and new line numbers, and the span that changed inside a replaced line
 * marked. Line numbers and +/− signs are painted by CSS from attributes, so
 * copying a selection copies the code only.
 *
 * Diffs can be megabytes, so a view paints them once into a frozen host (see
 * `data-morph="skip"` in morph.ts) instead of on every live re-render, and the
 * renderer stops after a line budget with a pointer to the full text.
 */
import { t } from "../i18n";
import { esc, fmtCount } from "../util";

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface DiffLine {
  /** " " context, "+" added, "-" removed, "\\" git's no-newline marker. */
  op: " " | "+" | "-" | "\\";
  text: string;
  old: number | null;
  new: number | null;
}

export interface DiffHunk {
  /** `@@ -a,b +c,d @@`, without the section heading git prints after it. */
  range: string;
  /** The enclosing function or section, when git found one. */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** null for an added file. */
  oldPath: string | null;
  /** null for a deleted file. */
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  /** "100644 → 100755" when the file mode changed. */
  modeChange: string | null;
  hunks: DiffHunk[];
  insertions: number;
  deletions: number;
}

export interface ParsedDiff {
  files: DiffFile[];
  /** Lines outside any file, e.g. a truncation note. */
  notes: string[];
  insertions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const ESCAPES: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };

/** Read a C-quoted path as git writes it (octal escapes are UTF-8 bytes); returns it and the rest. */
function readQuoted(s: string): [string, string] {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = 1;
  for (; i < s.length && s[i] !== '"'; i++) {
    let c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      const n = s[++i]!;
      if (n >= "0" && n <= "7") {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i))![0];
        bytes.push(parseInt(oct, 8) & 0xff);
        i += oct.length - 1;
        continue;
      }
      c = ESCAPES[n] ?? n;
    }
    for (const b of encoder.encode(c)) bytes.push(b);
  }
  return [new TextDecoder().decode(new Uint8Array(bytes)), s.slice(i + 1)];
}

function unquote(s: string): string {
  return s.startsWith('"') ? readQuoted(s)[0] : s;
}

function dropPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The two paths of a `diff --git a/X b/Y` line (renames and quoting included). */
function gitPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const [a, after] = readQuoted(rest);
    const b = after.trimStart();
    return [dropPrefix(a, "a/"), dropPrefix(unquote(b), "b/")];
  }
  // Unrenamed (the common case): "a/X b/X" splits exactly in the middle, which
  // stays right even when X contains " b/".
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

/** Parse `git diff` output. Anything it does not recognize is kept as a note, never thrown. */
export function parseDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { files: [], notes: [], insertions: 0, deletions: 0 };
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let oldMode = "";
  let binaryPatch = false;
  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const op = line[0];
      // A blank line inside a hunk is a context line whose space was trimmed.
      if (op === " " || line === "") {
        hunk.lines.push({ op: " ", text: line.slice(1), old: oldNo++, new: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (op === "-") {
        hunk.lines.push({ op: "-", text: line.slice(1), old: oldNo++, new: null });
        oldLeft--;
        file!.deletions++;
        continue;
      }
      if (op === "+") {
        hunk.lines.push({ op: "+", text: line.slice(1), old: null, new: newNo++ });
        newLeft--;
        file!.insertions++;
        continue;
      }
      if (op !== "\\") hunk = null; // the hunk was cut short (a truncated diff)
    }
    if (hunk && line[0] === "\\") {
      hunk.lines.push({ op: "\\", text: line.slice(2), old: null, new: null });
      continue;
    }
    hunk = null;
    if (line.startsWith("diff --git ")) {
      const paths = gitPaths(line.slice(11));
      file = {
        oldPath: paths?.[0] ?? null,
        newPath: paths?.[1] ?? null,
        status: "modified",
        binary: false,
        modeChange: null,
        hunks: [],
        insertions: 0,
        deletions: 0,
      };
      out.files.push(file);
      binaryPatch = false;
      oldMode = "";
      continue;
    }
    if (!file) {
      if (line.trim()) out.notes.push(line);
      continue;
    }
    if (binaryPatch) continue; // literal/delta payload of a `GIT binary patch`
    const m = HUNK.exec(line);
    if (m) {
      hunk = { range: line.slice(0, line.indexOf("@@", 2) + 2), section: m[5] ?? "", lines: [] };
      file.hunks.push(hunk);
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      continue;
    }
    if (line.startsWith("--- ")) {
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
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      file.status = line.startsWith("rename") ? "renamed" : "copied";
      file.oldPath = unquote(line.slice(line.indexOf(" from ") + 6));
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      file.status = line.startsWith("rename") ? "renamed" : "copied";
      file.newPath = unquote(line.slice(line.indexOf(" to ") + 4));
    } else if (line.startsWith("old mode ")) {
      oldMode = line.slice(9);
    } else if (line.startsWith("new mode ")) {
      file.modeChange = `${oldMode || "?"} → ${line.slice(9)}`;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
      binaryPatch = line === "GIT binary patch";
    } else if (!/^(index |similarity index|dissimilarity index)/.test(line) && line.trim()) {
      out.notes.push(line);
    }
  }
  for (const f of out.files) {
    out.insertions += f.insertions;
    out.deletions += f.deletions;
  }
  return out;
}

// --- rendering ----------------------------------------------------------------

/** The path a file is known by now (its old one when it was deleted). */
export function filePath(f: DiffFile): string {
  return f.newPath ?? f.oldPath ?? "?";
}

const STATUS_MARK: Record<FileStatus, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C" };

export function statusMark(f: DiffFile): string {
  return `<span class="dk dk-${STATUS_MARK[f.status]}" title="${esc(t(f.status))}">${STATUS_MARK[f.status]}</span>`;
}

/** A path with its directory dimmed, so the file name carries the line. */
export function pathHtml(path: string): string {
  const cut = path.lastIndexOf("/") + 1;
  return `<span class="dpath">${cut ? `<span class="dir">${esc(path.slice(0, cut))}</span>` : ""}<span class="base">${esc(path.slice(cut))}</span></span>`;
}

/** "+12 −3" in the signal and alarm inks. */
export function deltaHtml(insertions: number, deletions: number): string {
  return `<span class="dn"><b class="ins">+${fmtCount(insertions)}</b><b class="del">−${fmtCount(deletions)}</b></span>`;
}

/** Five cells split between insertions and deletions, like a diffstat. */
export function diffBar(insertions: number, deletions: number): string {
  const total = insertions + deletions;
  let add = total ? Math.round((insertions / total) * 5) : 0;
  if (insertions && !add) add = 1;
  let del = total ? Math.min(5 - add, Math.round((deletions / total) * 5)) : 0;
  if (deletions && !del) {
    del = 1;
    if (add + del > 5) add--;
  }
  const cells = Array.from({ length: 5 }, (_, i) => (i < add ? "a" : i < add + del ? "d" : "z"));
  return `<span class="dbar" aria-hidden="true">${cells.map((c) => `<i class="${c}"></i>`).join("")}</span>`;
}

const WORD = /[\p{L}\p{N}_$]/u;

/** Lock files and build output: reviewed last, so they start folded. */
const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor)\//;

/**
 * For each replaced line (a run of removals followed by a run of additions,
 * paired in order), the span between the common prefix and suffix — the part
 * that actually changed. Lines that share too little get no mark: everything
 * changed, and marking it all is noise.
 */
function changedSpans(lines: DiffLine[]): Map<number, [number, number]> {
  const spans = new Map<number, [number, number]>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.op !== "-") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]!.op === "-") i++;
    const addStart = i;
    while (i < lines.length && lines[i]!.op === "+") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const a = lines[delStart + k]!.text;
      const b = lines[addStart + k]!.text;
      if (a.length > 600 || b.length > 600) continue;
      let pre = 0;
      const max = Math.min(a.length, b.length);
      while (pre < max && a[pre] === b[pre]) pre++;
      // Never split a surrogate pair.
      if (pre > 0 && /[\ud800-\udbff]/.test(a[pre - 1]!)) pre--;
      let suf = 0;
      while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
      if (suf > 0 && /[\udc00-\udfff]/.test(a[a.length - suf]!)) suf--;
      // Snap to whole words: 60 → 300 marks both numbers, not "6" and "30".
      while (pre > 0 && WORD.test(a[pre - 1]!) && (WORD.test(a[pre] ?? "") || WORD.test(b[pre] ?? ""))) pre--;
      while (
        suf > 0 &&
        WORD.test(a[a.length - suf]!) &&
        (WORD.test(a[a.length - suf - 1] ?? "") || WORD.test(b[b.length - suf - 1] ?? ""))
      ) {
        suf--;
      }
      if (pre + suf < Math.min(a.length, b.length) * 0.3) continue;
      if (a.length - suf > pre) spans.set(delStart + k, [pre, a.length - suf]);
      if (b.length - suf > pre) spans.set(addStart + k, [pre, b.length - suf]);
    }
  }
  return spans;
}

function codeHtml(text: string, span: [number, number] | undefined): string {
  if (!span) return esc(text);
  return `${esc(text.slice(0, span[0]))}<mark>${esc(text.slice(span[0], span[1]))}</mark>${esc(text.slice(span[1]))}`;
}

const ROW_CLASS: Record<DiffLine["op"], string> = { " ": "ctx", "+": "add", "-": "del", "\\": "eof" };

function hunkRows(h: DiffHunk, budget: { left: number }): string {
  const spans = changedSpans(h.lines);
  const rows = [
    `<tr class="dh"><td class="o"></td><td class="n"></td><td class="c"><span class="rng">${esc(h.range)}</span>${h.section ? ` ${esc(h.section)}` : ""}</td></tr>`,
  ];
  for (let i = 0; i < h.lines.length && budget.left > 0; i++, budget.left--) {
    const l = h.lines[i]!;
    rows.push(
      `<tr class="${ROW_CLASS[l.op]}"><td class="o"${l.old != null ? ` data-n="${l.old}"` : ""}></td>` +
        `<td class="n"${l.new != null ? ` data-n="${l.new}"` : ""}></td><td class="c">${codeHtml(l.text, spans.get(i))}</td></tr>`,
    );
  }
  return rows.join("");
}

function fileBody(f: DiffFile, budget: { left: number }): string {
  if (f.binary) return `<p class="dnote">${t("Binary file — not shown.")}</p>`;
  if (!f.hunks.length) {
    const why = f.status === "renamed" ? t("Renamed without changes.") : f.modeChange ? t("Only the file mode changed.") : t("No line changes.");
    return `<p class="dnote">${why}</p>`;
  }
  if (budget.left <= 0) return "";
  const lines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
  const shownBefore = budget.left;
  const rows = f.hunks.map((h) => (budget.left > 0 ? hunkRows(h, budget) : "")).join("");
  const cut = lines - (shownBefore - budget.left);
  return (
    `<div class="dscroll"><table class="dtab"><tbody>${rows}</tbody></table></div>` +
    (cut > 0 ? `<p class="dnote">${t("{n} more lines in this file are not shown.", { n: fmtCount(cut) })}</p>` : "")
  );
}

export interface DiffRenderOptions {
  /** Paint at most this many diff lines in total (default 3000). */
  maxLines?: number;
  /** A command that prints the whole diff, offered when lines are left out. */
  fullCmd?: string;
}

/** The review sheet: one card per file, folded when it is generated, deleted or huge. */
export function renderDiff(diff: ParsedDiff, opts: DiffRenderOptions = {}): string {
  const budget = { left: opts.maxLines ?? 3000 };
  let hiddenFiles = 0;
  const cards = diff.files.map((f, i) => {
    const path = filePath(f);
    const size = f.insertions + f.deletions;
    // Past the line budget a file shows its header only, folded.
    const drawn = budget.left > 0 || !f.hunks.length;
    if (!drawn) hiddenFiles++;
    const open = drawn && !GENERATED.test(path) && f.status !== "deleted" && size <= 400;
    const from =
      (f.status === "renamed" || f.status === "copied") && f.oldPath && f.oldPath !== path
        ? `<span class="dfrom">${t("from")} ${esc(f.oldPath)}</span>`
        : "";
    return (
      `<details class="dfile" data-file="${i}"${open ? " open" : ""}>` +
      `<summary>${statusMark(f)}${pathHtml(path)}${from}` +
      (f.modeChange ? `<span class="dmode">${esc(f.modeChange)}</span>` : "") +
      `<span class="dsp"></span>${f.binary ? `<span class="tag">${t("binary")}</span>` : deltaHtml(f.insertions, f.deletions)}${diffBar(f.insertions, f.deletions)}</summary>` +
      fileBody(f, budget) +
      `</details>`
    );
  });
  const notes = diff.notes.length ? `<pre class="dnotes">${esc(diff.notes.join("\n"))}</pre>` : "";
  const rest =
    hiddenFiles && opts.fullCmd
      ? `<p class="dnote more">${t("{n} more files are not drawn here — the full diff: {cmd}", { n: hiddenFiles, cmd: `<code>${esc(opts.fullCmd)}</code>` })}</p>`
      : "";
  return `<div class="diff">${cards.join("")}${rest}${notes}</div>`;
}
