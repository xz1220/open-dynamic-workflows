import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";

import { ChangeRecorder, changedSince, rebaseline, relativeToDir, snapshotTree } from "../src/changes.js";
import { withWorkspace } from "../src/workspace.js";

// What an agent changed, read from git (ODW extension: what an `expect`
// check reads): in place, against a snapshot of the source tree taken before
// the agent started; isolated, the paths of the diff its worktree leaves.

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function commit(dir: string, message = "c"): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", message);
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-tree-"));
  git(dir, "init", "-q");
  write(dir, files);
  commit(dir, "init");
  return dir;
}

test("relativeToDir makes a root-relative path relative to a directory of the tree", () => {
  const table: Array<[string, string, string]> = [
    ["", "src/a.ts", "src/a.ts"],
    ["src", "src/a.ts", "a.ts"],
    ["src", "src/lib/b.ts", "lib/b.ts"],
    ["src", "README.md", "../README.md"],
    ["packages/foo", "packages/bar/x.ts", "../bar/x.ts"],
    ["packages/foo", "top.txt", "../../top.txt"],
    ["src", "srcx/a.ts", "../srcx/a.ts"],
  ];
  for (const [dir, path, expected] of table) assert.equal(relativeToDir(dir, path), expected, `${path} from ${dir}`);
});

test("in place: what changed since a snapshot — new, edited, reverted, deleted and committed — and not what was dirty before", async () => {
  const repo = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "keep.txt": "k\n" });
  try {
    // The user's uncommitted work, there before the agent starts.
    write(repo, { "a.txt": "user edit\n", "draft.txt": "user draft\n", "b.txt": "user edit\n" });
    const snap = await snapshotTree(repo);
    assert.deepEqual(await changedSince(snap), [], "nothing changed yet");

    write(repo, { "new.txt": "n\n", "a.txt": "agent edit\n" }); // created; edited again
    git(repo, "checkout", "--", "b.txt"); // the agent reverted the user's edit: a change of the tree
    unlinkSync(join(repo, "c.txt")); // deleted
    assert.deepEqual(await changedSince(snap), ["a.txt", "b.txt", "c.txt", "new.txt"]);
    assert.ok(!(await changedSince(snap)).includes("draft.txt"), "the user's untouched draft is not a change");

    // A commit leaves `git status` clean for its files: what HEAD moved over counts.
    write(repo, { "keep.txt": "committed\n" });
    git(repo, "add", "keep.txt");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "agent");
    assert.ok((await changedSince(snap)).includes("keep.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("in place: a repository's first commit counts what it holds; a snapshot outside git is an error", async () => {
  const repo = mkdtempSync(join(tmpdir(), "odw-tree-"));
  const plain = mkdtempSync(join(tmpdir(), "odw-tree-plain-"));
  try {
    git(repo, "init", "-q");
    const snap = await snapshotTree(repo);
    assert.equal(snap.head, null, "no commit yet");
    write(repo, { "first.txt": "1\n" });
    commit(repo);
    assert.deepEqual(await changedSince(snap), ["first.txt"]);
    await assert.rejects(snapshotTree(plain), /git rev-parse failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("in place: rebaselined paths start over — what was done to them is gone, a later edit counts", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  try {
    const snap = await snapshotTree(repo);
    write(repo, { "report.xml": "<ok/>", "a.txt": "agent\n" });
    assert.deepEqual(await changedSince(snap), ["a.txt", "report.xml"]);
    await rebaseline(snap, ["report.xml"]);
    assert.deepEqual(await changedSince(snap), ["a.txt"]);
    write(repo, { "report.xml": "<edited/>" });
    assert.deepEqual(await changedSince(snap), ["a.txt", "report.xml"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("isolated: a workspace's changed paths are its kept diff's — commits in, setup files out — relative to the workspace", async () => {
  const repo = makeRepo({ "top.txt": "t\n", "pkg/a.txt": "a\n" });
  try {
    const setup = { command: [execPath, "-e", "require('fs').writeFileSync('setup.out', 'built')"] };
    const paths = await withWorkspace(
      join(repo, "pkg"),
      "worktree",
      async (ws) => {
        assert.notEqual(ws.path, join(repo, "pkg"));
        write(ws.path, { "b.txt": "b\n", "../top.txt": "edited\n" });
        commit(ws.path, "agent commit"); // committed in the worktree: still the agent's change
        write(ws.path, { "a.txt": "edited\n" });
        return ws.changedPaths();
      },
      setup,
    );
    assert.deepEqual(paths?.sort(), ["../top.txt", "a.txt", "b.txt"], "setup.out was there before the agent started");
    const inPlace = await withWorkspace(repo, "inplace", async (ws) => ws.changedPaths());
    assert.equal(inPlace, null, "in place, the caller compares against its own snapshot");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ChangeRecorder.redo: once a run of a retry that starts over is in, its change supersedes the earlier one — even none", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  const dir = mkdtempSync(join(tmpdir(), "odw-tree-keep-"));
  const recorder = (name: string) =>
    new ChangeRecorder({ path: join(dir, name), maxDiffBytes: 1 << 20, branch: null, message: "m" });
  /** One isolated CLI run that writes `files`, as the bridge reports it. */
  const run = (changes: ChangeRecorder, files: Record<string, string>) =>
    withWorkspace(repo, "worktree", async (ws) => {
      write(ws.path, files);
      await changes.capture(ws);
    });
  try {
    // Without redo, an attempt that changed nothing leaves the earlier change standing (a schema retry).
    const plain = recorder("plain.diff");
    await run(plain, { "first.txt": "1\n" });
    await plain.endAttempt();
    await run(plain, {});
    await plain.endAttempt();
    assert.equal((await plain.settle())?.changes.files, 1);

    // After redo, the next run's change replaces it — here, nothing.
    const redone = recorder("redone.diff");
    await run(redone, { "first.txt": "1\n" });
    await redone.endAttempt();
    redone.redo();
    await run(redone, {});
    await redone.endAttempt();
    assert.equal(await redone.settle(), null);
    assert.equal(existsSync(join(dir, "redone.diff")), false);

    // A retry that never ran (it failed before its CLI started) leaves the earlier change.
    const unrun = recorder("unrun.diff");
    await run(unrun, { "first.txt": "1\n" });
    await unrun.endAttempt();
    unrun.redo();
    assert.equal((await unrun.settle())?.changes.files, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
