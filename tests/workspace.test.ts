import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { ConfigError, isFatalError } from "../src/errors.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";
import { withWorkspace } from "../src/workspace.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** A one-commit repo with a.txt — the smallest worktree-able source. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-src-"));
  writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return dir;
}

test("worktree mode isolates via a real git worktree and diffs edits AND new files", async () => {
  const src = makeRepo();
  try {
    const diff = await withWorkspace(src, "worktree", async (ws) => {
      assert.notEqual(ws.path, src, "worktree must be a separate directory");
      assert.ok(existsSync(join(ws.path, "a.txt")), "worktree has the committed tree");
      await writeFile(join(ws.path, "a.txt"), "line1\nCHANGED\n");
      await writeFile(join(ws.path, "brand-new.txt"), "hello\n");
      // Agents habitually stage and even commit — that must not hide work,
      // because the diff is taken against the pinned base commit.
      git(ws.path, "add", "a.txt");
      git(ws.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "agent commit");
      return ws.diff();
    });
    assert.match(diff, /a\/a\.txt/);
    assert.match(diff, /^\+CHANGED$/m);
    // intent-to-add makes brand-new files part of the diff too
    assert.match(diff, /brand-new\.txt/);
    assert.match(diff, /^\+hello$/m);
    // the real source tree is untouched, and the worktree is gone from git
    assert.equal(await readFile(join(src, "a.txt"), "utf8"), "line1\nline2\n");
    const worktrees = git(src, "worktree", "list", "--porcelain");
    assert.equal(worktrees.trim().split("\n\n").length, 1, "only the main worktree remains");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("worktree mode maps a repo SUBDIRECTORY source to the matching subdir", async () => {
  const src = makeRepo();
  const sub = join(src, "packages", "foo");
  try {
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "f.txt"), "sub\n");
    git(src, "add", "-A");
    git(src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "sub");
    const diff = await withWorkspace(sub, "worktree", async (ws) => {
      assert.ok(ws.path.endsWith(join("packages", "foo")), `agent lands in the subdir, got ${ws.path}`);
      assert.ok(existsSync(join(ws.path, "f.txt")));
      await writeFile(join(ws.path, "f.txt"), "edited\n");
      return ws.diff();
    });
    assert.match(diff, /packages\/foo\/f\.txt/);
    assert.equal(await readFile(join(sub, "f.txt"), "utf8"), "sub\n");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a worktree the agent LOCKED is still cleaned up completely", async () => {
  const src = makeRepo();
  try {
    await withWorkspace(src, "worktree", async (ws) => {
      git(src, "worktree", "lock", ws.path);
      return null;
    });
    const worktrees = git(src, "worktree", "list", "--porcelain");
    assert.equal(worktrees.trim().split("\n\n").length, 1, "no stale locked registration");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("worktree mode on a non-git directory fails with an actionable, fatal ConfigError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-plain-"));
  try {
    await assert.rejects(
      withWorkspace(dir, "worktree", async () => "unreachable"),
      (err: Error) => err instanceof ConfigError && isFatalError(err) && /needs a git repository/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isolated agents on a non-git source fail the run instead of becoming silent nulls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-plain-"));
  try {
    const store = new RunStore(join(dir, "runs"));
    const config = join(dir, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({ defaultAdapter: "mock", adapters: { mock: { command: [execPath, "-e", "process.stdout.write('ok')"] } } }),
    );
    const script = join(dir, "wf.js");
    writeFileSync(
      script,
      "export const meta = { name: 'wf', description: 'd' }\n" +
        "return await parallel([() => agent('a', { isolation: 'worktree' }), () => agent('b', { isolation: 'worktree' })])\n",
    );
    const id = store.create({ script, args: null, source: dir, configPath: config });
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.match(String(store.readError(id)?.error), /needs a git repository/);
    assert.equal(store.hasResult(id), false, "no [null, null] result is recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inplace mode runs in the source and yields no diff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-plain-"));
  writeFileSync(join(dir, "a.txt"), "x\n");
  try {
    const out = await withWorkspace(dir, "inplace", async (ws) => {
      assert.equal(ws.path, dir);
      return ws.diff();
    });
    assert.equal(out, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
