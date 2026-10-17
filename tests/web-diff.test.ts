/**
 * The dashboard's diff reader: real `git diff` output in, files/hunks/line
 * numbers out, and the review sheet rendered from them.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { diffBar, parseDiff, renderDiff } from "../web/src/components/diff.ts";

/** A repository with one commit, then every kind of change git can show, staged. */
function gitDiff(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-diff-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "core.quotePath=true", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", ...args], {
        encoding: "utf8",
      });
    git("init", "-q");
    const put = (path: string, body: string | Buffer) => writeFileSync(join(dir, path), body);
    put("keep.ts", "const a = 1;\nconst x = 1;\nconst c = 3;\n");
    put("gone.txt", "gone\n");
    put("old-name.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\n");
    put("img.bin", Buffer.from([0, 1, 2]));
    mkdirSync(join(dir, "dir b"));
    put("dir b/a b.txt", "x\n");
    put("tail.txt", "no newline");
    put("run.sh", "#!/bin/sh\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");

    put("keep.ts", "const a = 1;\nconst x = 2;\nconst c = 3;\n");
    unlinkSync(join(dir, "gone.txt"));
    git("mv", "old-name.txt", "new-name.txt");
    put("new-name.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n");
    put("img.bin", Buffer.from([0, 9, 2]));
    put("dir b/a b.txt", "<script>y</script>\n");
    put("tail.txt", "no newline, now longer");
    chmodSync(join(dir, "run.sh"), 0o755);
    put("café.txt", "café\n");
    git("add", "-A");
    return git("diff", "--cached", "-M", "--no-color", "--no-ext-diff", "HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseDiff reads every kind of change git prints", () => {
  const diff = parseDiff(gitDiff());
  const byPath = new Map(diff.files.map((f) => [f.newPath ?? f.oldPath, f]));

  const cafe = byPath.get("café.txt")!;
  assert.equal(cafe.status, "added", "quoted, octal-escaped UTF-8 path decoded");
  assert.equal(cafe.oldPath, null);
  assert.deepEqual(cafe.hunks[0]!.lines, [{ op: "+", text: "café", old: null, new: 1 }]);

  const spaced = byPath.get("dir b/a b.txt")!;
  assert.equal(spaced.oldPath, "dir b/a b.txt", "a path with spaces and ' b/' splits right; the header's tab is dropped");
  assert.equal(spaced.status, "modified");

  const gone = byPath.get("gone.txt")!;
  assert.equal(gone.status, "deleted");
  assert.equal(gone.newPath, null);
  assert.equal(gone.deletions, 1);

  const bin = byPath.get("img.bin")!;
  assert.equal(bin.binary, true);
  assert.equal(bin.hunks.length, 0);

  const keep = byPath.get("keep.ts")!;
  assert.deepEqual(
    keep.hunks[0]!.lines.map((l) => [l.op, l.old, l.new]),
    [[" ", 1, 1], ["-", 2, null], ["+", null, 2], [" ", 3, 3]],
    "old and new line numbers advance independently",
  );

  const renamed = byPath.get("new-name.txt")!;
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "old-name.txt");
  assert.equal(renamed.hunks[0]!.section, "beta", "the section heading after @@ is kept apart from the range");
  assert.equal(renamed.insertions, 1);

  const mode = byPath.get("run.sh")!;
  assert.equal(mode.modeChange, "100644 → 100755");
  assert.equal(mode.hunks.length, 0);

  const tail = byPath.get("tail.txt")!;
  assert.deepEqual(
    tail.hunks[0]!.lines.map((l) => l.op),
    ["-", "\\", "+", "\\"],
    "a no-newline marker mid-hunk does not end the hunk",
  );

  assert.equal(diff.files.length, 8);
  assert.deepEqual(diff.notes, []);
  assert.equal(diff.insertions, diff.files.reduce((n, f) => n + f.insertions, 0));
});

test("renderDiff escapes code, marks the changed span and paints numbers from attributes", () => {
  const html = renderDiff(parseDiff(gitDiff()));
  assert.ok(!html.includes("<script>"), "file content is escaped");
  assert.ok(html.includes("&lt;script&gt;y&lt;/script&gt;"));
  // const x = 1; → const x = 2; — only the digit is marked.
  assert.match(html, /const x = <mark>1<\/mark>;/);
  assert.match(html, /const x = <mark>2<\/mark>;/);
  assert.ok(html.includes('data-n="2"'), "line numbers ride on attributes, so copying code skips them");
  assert.ok(html.includes("Binary file — not shown."));
  assert.ok(html.includes("Only the file mode changed."));
  assert.match(html, /class="dk dk-R"/);
});

test("parseDiff survives a diff cut mid-hunk and keeps the cut note", () => {
  const text = [
    "diff --git a/big.txt b/big.txt",
    "--- a/big.txt",
    "+++ b/big.txt",
    "@@ -1,40 +1,40 @@",
    "-old 1",
    "+new 1",
    "[odw] diff truncated at 2 MB — 3 more files not shown",
  ].join("\n");
  const diff = parseDiff(text);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0]!.hunks[0]!.lines.length, 2);
  assert.deepEqual(diff.notes, ["[odw] diff truncated at 2 MB — 3 more files not shown"]);
  assert.match(renderDiff(diff), /class="dnotes"/);
});

test("renderDiff stops at its line budget and folds lock files and deletions", () => {
  const lines = (n: number, sign: string) => Array.from({ length: n }, (_, i) => `${sign}line ${i}`).join("\n");
  const file = (path: string, n: number) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${n} @@\n${lines(n, "+")}`;
  const text = [file("src/a.ts", 30), file("package-lock.json", 10), file("src/b.ts", 30), file("src/c.ts", 5)].join("\n");
  const html = renderDiff(parseDiff(text), { maxLines: 50, fullCmd: "odw diff RUN --agent 3" });
  assert.match(html, /<details class="dfile" data-file="1">/, "a lock file starts folded");
  assert.match(html, /<details class="dfile" data-file="0" open>/);
  assert.equal((html.match(/<tr class="add">/g) ?? []).length, 50, "no more rows than the budget");
  assert.match(html, /20 more lines in this file are not shown/);
  assert.match(html, /1 more files are not drawn here — the full diff: <code>odw diff RUN --agent 3<\/code>/);
});

test("diffBar splits five cells and always shows a side that changed", () => {
  const cells = (html: string) => [...html.matchAll(/<i class="(\w)"><\/i>/g)].map((m) => m[1]).join("");
  assert.equal(cells(diffBar(10, 0)), "aaaaa");
  assert.equal(cells(diffBar(0, 0)), "zzzzz");
  assert.equal(cells(diffBar(1000, 1)), "aaaad", "one deletion still shows");
  assert.equal(cells(diffBar(3, 2)), "aaadd");
});

test("changed spans snap to whole words", () => {
  const text = [
    "diff --git a/c.ts b/c.ts",
    "--- a/c.ts",
    "+++ b/c.ts",
    "@@ -1,2 +1,2 @@",
    "-export const TTL = 60;",
    "-  return store[k];",
    "+export const TTL = 300;",
    "+  return store.get(k) ?? null;",
  ].join("\n");
  const html = renderDiff(parseDiff(text));
  assert.match(html, /TTL = <mark>60<\/mark>;/);
  assert.match(html, /TTL = <mark>300<\/mark>;/);
  assert.match(html, /return store<mark>\[k\]<\/mark>;/);
  assert.match(html, /return store<mark>\.get\(k\) \?\? null<\/mark>;/);
});
