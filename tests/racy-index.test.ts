/**
 * Git trusts its index's stat cache for an entry only when the entry is older
 * than the index file itself; one that is not ("racily clean") is re-read.
 * The diff capture stages a worktree into a COPY of its index, and a copy
 * stamped "now" would make git trust the cache for a same-size edit made in
 * the second the worktree was checked out — losing that edit from the kept
 * diff (seen under load on CI-like timing). The copy must keep the index's
 * mtime.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { listChanges, snapshotWorktree } from "../src/changes.js";

test("a same-size edit whose stat matches the index cache is still found (the index copy keeps git's racy-clean check)", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-racy-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    git(repo, "init", "-q");
    // ctime cannot be set from user space: take it out of git's comparison so
    // the cached stat can match the edited file exactly.
    git(repo, "config", "core.trustctime", "false");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
    const base = git(repo, "rev-parse", "HEAD");
    const work = join(root, "work");
    git(repo, "worktree", "add", "-q", "--detach", work, base);
    const scratch = join(root, "scratch");
    mkdirSync(scratch);

    // The checkout's second, long ago: the file, then the index's cached stat of it.
    const then = new Date("2020-01-01T00:00:00Z");
    const file = join(work, "a.txt");
    utimesSync(file, then, then);
    git(work, "update-index", "--refresh");
    const baseline = await snapshotWorktree(work, []);

    // The agent's edit: same size, same inode, and — as if made in that same
    // second — the same mtime. The index file was written in that second too.
    writeFileSync(file, "one\nTWO\nthree\n");
    utimesSync(file, then, then);
    const index = resolve(work, git(work, "rev-parse", "--git-path", "index"));
    utimesSync(index, then, then);
    assert.equal(statSync(file).size, 14);

    assert.deepEqual(await listChanges({ top: repo, work, base, scratch }, baseline), ["a.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
