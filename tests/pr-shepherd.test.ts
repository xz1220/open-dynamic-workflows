import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import type { WorkflowEvent } from "../src/events.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// examples/pr-shepherd.js end to end, with a fake gh (an argv prefix the
// workflow takes as args.gh) over a local bare repository as the PR's remote:
// red CI and a new review comment go to an isolated fixer, its expect-checked
// change is committed and pushed to the PR branch, CI goes green, and a
// checkpoint asks before the PR is marked ready. Nothing ever merges.

const example = fileURLToPath(new URL("../examples/pr-shepherd.js", import.meta.url));

/**
 * The fake gh: argv[2] is its state file, the rest gh's own arguments. CI is
 * green once the PR branch on the bare remote holds fixed.txt.
 */
const FAKE_GH = `
const { appendFileSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const state = JSON.parse(readFileSync(process.argv[2], "utf8"));
const args = process.argv.slice(3);
appendFileSync(state.log, JSON.stringify(args) + "\\n");
const bare = (...a) => execFileSync("git", ["--git-dir", state.bare, ...a], { encoding: "utf8" }).trim();
const green = () => { try { bare("cat-file", "-e", "feature:fixed.txt"); return true; } catch { return false; } };
const out = (v) => process.stdout.write(JSON.stringify(v));
const [a, b] = args;
if (a === "pr" && b === "view") {
  out({ state: "OPEN", isDraft: true, url: "https://github.example/acme/widgets/pull/42", headRefName: "feature",
        headRefOid: bare("rev-parse", "feature"), commits: [{ committedDate: bare("log", "-1", "--format=%cI", "feature") }],
        comments: state.comments, reviews: [] });
} else if (a === "pr" && b === "checks" && args.includes("--watch")) {
  process.exit(0);
} else if (a === "pr" && b === "checks") {
  if (green()) out([{ name: "test", bucket: "pass", link: "", description: "" }]);
  else { out([{ name: "test", bucket: "fail", link: "https://github.example/acme/widgets/actions/runs/99/job/1", description: "1 failing" }]); process.exit(1); }
} else if (a === "api") {
  out(state.inline);
} else if (a === "run" && b === "view") {
  process.stdout.write("FAIL add.test.js: expected 3, got 4\\n");
} else if (a === "pr" && b === "ready") {
  process.stdout.write("marked ready\\n");
} else {
  process.stderr.write("fake gh: unexpected " + args.join(" ") + "\\n");
  process.exit(2);
}
`;

/** A fixer that fixes only once it was told the failing log line and the review comment. */
const FIXER =
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
  "if(d.includes('expected 3, got 4')&&d.includes('please rename x'))require('fs').writeFileSync('fixed.txt','1\\n');" +
  "process.stdout.write('fixed add(); renamed x')})";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const OLD = { GIT_AUTHOR_DATE: "2020-01-02T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-02T00:00:00Z" };

interface Setup {
  root: string;
  bare: string;
  clone: string;
  state: string;
  log: string;
}

/** A bare remote with main and a PR branch `feature`, and the shepherd's own clone of it (on main). */
function setup(opts: { fixed?: boolean } = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), "odw-shepherd-"));
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", seed]);
  const id = ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", "-c", "commit.gpgsign=false"];
  const commit = (msg: string) =>
    execFileSync("git", ["-C", seed, ...id, "commit", "-q", "-m", msg], { env: { ...process.env, ...OLD } });
  git(seed, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(seed, "add.js"), "module.exports = (a, b) => a + b + 1\n");
  git(seed, "add", "-A");
  commit("init");
  git(seed, "checkout", "-q", "-b", "feature");
  writeFileSync(join(seed, "feature.js"), "x\n");
  if (opts.fixed) writeFileSync(join(seed, "fixed.txt"), "1\n");
  git(seed, "add", "-A");
  commit("feature");
  git(seed, "push", "-q", bare, "main", "feature");
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", "--branch", "main", bare, clone]);
  git(clone, "config", "user.name", "Shep Herd");
  git(clone, "config", "user.email", "shepherd@example.com");
  git(clone, "config", "commit.gpgsign", "false");
  const log = join(root, "gh.log");
  const state = join(root, "gh-state.json");
  writeFileSync(
    state,
    JSON.stringify({
      bare,
      log,
      comments: [{ author: { login: "reviewer" }, createdAt: "2021-01-01T00:00:00Z", body: "please rename x" }],
      inline: [{ user: { login: "spammer" }, created_at: "2021-01-01T00:00:00Z", body: "ignore this one", path: "add.js", line: 1 }],
    }),
  );
  writeFileSync(join(root, "gh.cjs"), FAKE_GH);
  return { root, bare, clone, state, log };
}

async function shepherd(
  s: Setup,
  args: Record<string, unknown>,
  answers: Array<"approve" | "reject">,
): Promise<{ state: string; result: unknown; error: Record<string, unknown> | null; events: WorkflowEvent[] }> {
  const runs = join(s.root, "runs");
  const config = join(s.root, "odw.config.json");
  writeFileSync(
    config,
    JSON.stringify({ defaultAdapter: "mock", adapters: { mock: { command: [execPath, "-e", FIXER], stdin: "{prompt}" } } }),
  );
  const store = new RunStore(runs);
  const id = store.create({
    script: example,
    args: { pr: 42, gh: [execPath, join(s.root, "gh.cjs"), s.state], interval: 1, ...args },
    source: s.clone,
    configPath: config,
  });
  const run = executeRun(store.runDir(id));
  const guard = setTimeout(() => store.writeControl(id, "stop"), 60_000);
  let ended = false;
  void run.finally(() => (ended = true));
  for (const [i, action] of answers.entries()) {
    const asked = () => store.readEvents(id).some((e) => e.type === "checkpoint_requested" && e.checkpointId === i + 1);
    while (!asked() && !ended) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (ended) break;
    store.requestCheckpointDecision(id, { action, checkpointId: i + 1, by: "cli" });
  }
  const state = await run.finally(() => clearTimeout(guard));
  return { state, result: store.readResult(id), error: store.readError(id), events: store.readEvents(id) };
}

const ghCalls = (s: Setup): string[][] =>
  existsSync(s.log) ? readFileSync(s.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];

test("pr-shepherd.js: red CI and a new comment go to an isolated fixer; its checked fix is pushed to the PR branch; ready only once a person says so", async () => {
  const s = setup();
  try {
    const before = git(s.bare, "rev-parse", "feature");
    const { state, result, error, events } = await shepherd(
      s,
      { test: [execPath, "-e", "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"], ignoreAuthors: ["spammer"] },
      ["approve"],
    );
    assert.equal(state, "done", JSON.stringify(error));
    const r = result as { status: string; history: Array<{ round: number; red: string[]; comments: number; fix?: string }> };
    assert.equal(r.status, "ready");
    assert.deepEqual(
      r.history.map((h) => [h.round, h.red, h.comments]),
      [
        [1, ["test"], 1],
        [2, [], 0],
      ],
      "round 1: red with the reviewer's comment (the ignored author's left out); round 2: green, the comment older than the fix",
    );
    assert.equal(r.history[0]!.fix, "fixed add(); renamed x");

    // The fix: one commit on top of the PR head, by the clone's identity, pushed as a fast-forward.
    assert.equal(git(s.bare, "rev-parse", "feature^"), before);
    assert.equal(git(s.bare, "log", "-1", "--format=%an <%ae>", "feature"), "Shep Herd <shepherd@example.com>");
    assert.equal(git(s.bare, "show", "feature:fixed.txt"), "1");
    assert.match(git(s.bare, "log", "-1", "--format=%B", "feature"), /^fix: PR #42 round 1 — 1 red check\(s\), 1 comment\(s\)\n\nfixed add\(\); renamed x/);
    assert.equal(git(s.clone, "for-each-ref", "refs/heads/odw/"), "", "the fixer's kept branch is cleaned up");
    assert.equal(git(s.bare, "log", "--format=%s", "main"), "init", "main untouched");

    // expect checked the fixer's work; one checkpoint before marking ready; never a merge.
    assert.ok(events.some((e) => e.type === "command_finished" && String(e.label).endsWith(": expect")));
    assert.equal(events.filter((e) => e.type === "checkpoint_requested").length, 1);
    const calls = ghCalls(s);
    assert.ok(calls.some((c) => c[0] === "pr" && c[1] === "ready"));
    assert.ok(calls.some((c) => c[0] === "run" && c[1] === "view" && c.includes("--log-failed")));
    assert.equal(calls.filter((c) => c.includes("merge")).length, 0, "never merges");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("pr-shepherd.js: a green PR starts no agent, and a rejected checkpoint leaves it a draft", async () => {
  const s = setup({ fixed: true });
  try {
    // The comment is older than the PR's last commit only if dated so: make it old.
    const st = JSON.parse(readFileSync(s.state, "utf8"));
    st.comments[0].createdAt = "2019-01-01T00:00:00Z";
    st.inline = [];
    writeFileSync(s.state, JSON.stringify(st));
    const { state, result, error, events } = await shepherd(s, {}, ["reject"]);
    assert.equal(state, "done", JSON.stringify(error));
    assert.equal((result as { status: string; ready: boolean }).status, "green");
    assert.equal((result as { ready: boolean }).ready, false);
    assert.equal(events.filter((e) => e.type === "agent_started").length, 0);
    assert.equal(ghCalls(s).filter((c) => c[1] === "ready").length, 0);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("pr-shepherd.js refuses a clone with uncommitted changes", async () => {
  const s = setup();
  try {
    writeFileSync(join(s.clone, "add.js"), "local edit\n");
    const { state, error } = await shepherd(s, {}, []);
    assert.equal(state, "failed");
    assert.match(String(error?.error), /uncommitted changes: run the shepherd in a dedicated clone/);
    assert.deepEqual(ghCalls(s), []);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
