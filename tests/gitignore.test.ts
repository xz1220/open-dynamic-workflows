import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The .odw/ ignore is narrowed so authored named workflows are committed while
// run state and scratch stay ignored. A careless re-blanket of `.odw/` would
// silently un-track team workflows, so pin the contract down with `git check-ignore`.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** True when git would ignore `path` (check-ignore exits 0 on a match). */
function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: repoRoot, stdio: "pipe" });
    return true;
  } catch {
    return false; // exit 1 → no ignore match
  }
}

test("everything under .odw/workflows is committed; runs and scratch stay ignored", { skip: !gitAvailable() }, () => {
  assert.equal(isIgnored(".odw/runs/20260101-000000-abc123/meta.json"), true, "run state must stay ignored");
  assert.equal(isIgnored(".odw/ai-news-10-codex.js"), true, "loose .odw scratch must stay ignored");
  assert.equal(isIgnored(".odw/workflows/release-notes.js"), false, "named workflows must be tracked");
  // The whole .odw/workflows subtree is tracked (forward-compatible with v2 subdir
  // namespacing and any committed helpers); nested files are path-runnable today
  // even though v1 has no by-name namespacing.
  assert.equal(isIgnored(".odw/workflows/ci/flaky-hunt.js"), false, "the workflows subtree is tracked");
});
