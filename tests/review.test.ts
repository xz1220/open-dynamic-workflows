import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { diffFiles } from "../src/runtime/changes-view.js";
import { formatReview } from "../src/runtime/review-cli.js";
import { agentEvidence, appendReview, latestMarks, readReviews, REVIEWS_FILE, ReviewReader, riskLevel, scoreAgent } from "../src/runtime/review.js";
import { RunStore } from "../src/runtime/run-store.js";
import type { AgentView } from "../src/runtime/runs-view.js";
import { startServer } from "../src/runtime/server.js";
import { localLauncher } from "../src/identity.js";
import { executeRun } from "../src/runtime/worker.js";

// The review queue (ODW extension): kept diffs across runs, riskiest first,
// every point explained; marks in reviews.jsonl; odw apply marks applied.

const EDIT_AGENT = fileURLToPath(new URL("./fixtures/edit-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** Run the CLI in `cwd`, capturing what it prints. */
async function cli(argv: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
    err.push(String(s));
    return true;
  };
  const home = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.chdir(home);
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

function view(over: Partial<AgentView> = {}): AgentView {
  return {
    agentId: 1,
    kind: "agent",
    label: "fix",
    phase: null,
    state: "done",
    adapter: "claude",
    attempts: 1,
    error: null,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1000,
    cached: false,
    changes: { files: 1, insertions: 3, deletions: 1, truncated: false },
    branch: null,
    ...over,
  };
}

const small = { files: 1, insertions: 3, deletions: 1, truncated: false };

/** A diff touching `paths` (one added line each), git-style. */
function diffOf(paths: Array<string | { path: string; deleted?: true; binary?: true }>): string {
  return paths
    .map((p) => {
      const { path, deleted, binary } = typeof p === "string" ? { path: p } : p;
      if (binary) return `diff --git a/${path} b/${path}\nindex 1..2 100644\nBinary files a/${path} and b/${path} differ\n`;
      if (deleted) return `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
      return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n x\n+y\n`;
    })
    .join("");
}

test("the score: each kind of path, its checks and its history add points, each with why; a passed expect.command takes one off", () => {
  const files = diffFiles(
    diffOf([
      ".github/workflows/ci.yml",
      "db/migrations/0042_users.sql",
      "src/auth/session.ts",
      "package-lock.json",
      "src/thing.test.ts",
      { path: "tests/old_test.ts", deleted: true },
      { path: "assets/logo.png", binary: true },
    ]),
  );
  const s = scoreAgent(view(), { files: 7, insertions: 6, deletions: 1, truncated: false }, files, undefined);
  assert.deepEqual(s.categories, ["ci", "migrations", "auth", "deps", "tests", "binary"]);
  const by = new Map(s.factors.map((f) => [f.key, f]));
  assert.deepEqual(by.get("ci"), { key: "ci", points: 3, why: "touches CI: .github/workflows/ci.yml" });
  assert.equal(by.get("migrations")!.points, 3);
  assert.equal(by.get("auth")!.why, "touches auth or security code: src/auth/session.ts");
  assert.equal(by.get("deps")!.why, "changes dependencies: package-lock.json");
  assert.equal(by.get("tests")!.why, "changes tests: src/thing.test.ts, tests/old_test.ts");
  assert.equal(by.get("tests-deleted")!.why, "deletes tests: tests/old_test.ts");
  assert.equal(by.get("binary")!.why, "binary files: assets/logo.png");
  assert.equal(by.get("files")!.points, 1, "7 files");
  assert.equal(s.score, 3 + 3 + 3 + 2 + 1 + 2 + 2 + 1);
  assert.equal(s.risk, "high");
  assert.deepEqual(
    s.factors.map((f) => f.points),
    [...s.factors.map((f) => f.points)].sort((a, b) => b - a),
    "largest first",
  );
  // Not auth: an AUTHORS file, a tokenizer.
  const quiet = scoreAgent(view(), small, diffFiles(diffOf(["AUTHORS", "src/tokenizer.ts", "README.md"])), undefined);
  assert.deepEqual([quiet.score, quiet.risk, quiet.factors, quiet.categories], [0, "low", [], []]);

  // What the run recorded about the agent.
  const failed = view({
    state: "failed",
    failureReason: "unmet_expectation",
    misses: ['no file matching "test/**" may change, and 1 did: test/a.test.ts', "the command `npm test` exited 1"],
    outOfScope: ["src/other.ts"],
    orphaned: ["npm run dev (pid 7)"],
    destructiveGit: [{ command: "git reset --hard", what: "git reset --hard" }],
    fellBackFrom: ["codex"],
    partial: true,
    usage: { costUsd: 6.5 } as AgentView["usage"],
  });
  const events = [
    { ts: 1, type: "log", agentId: 1, retry: { reason: "expect", n: 1, of: 2 } },
    { ts: 1, type: "log", agentId: 1, retry: { reason: "rate_limit", n: 1, of: 3 } },
    { ts: 1, type: "handoff", agentId: 1, from: "codex", to: "claude" },
    { ts: 1, type: "apply_resolved", agentId: 1, outcome: "applied" },
    { ts: 1, type: "log", agentId: 2, retry: { reason: "stall", n: 1, of: 1 } },
  ];
  const ev = agentEvidence(events, []);
  const f = scoreAgent(failed, { files: 1, insertions: 400, deletions: 0, truncated: true }, [], ev.get(1));
  const keys = Object.fromEntries(f.factors.map((x) => [x.key, x]));
  assert.equal(keys.untouched!.points, 4);
  assert.match(keys.untouched!.why, /^changed files it must not: no file matching "test\/\*\*"/);
  assert.equal(keys.expect!.why, "missed its expect: the command `npm test` exited 1");
  assert.equal(keys.failed, undefined, "an expect miss is not counted twice as a failure");
  assert.equal(keys.scope!.why, "changed 1 file(s) outside its scope: src/other.ts");
  assert.equal(keys.orphaned!.points, 2);
  assert.equal(keys["destructive-git"]!.why, "ran destructive git: git reset --hard");
  assert.equal(keys.deadline!.points, 3);
  assert.equal(keys.truncated!.points, 2);
  assert.equal(keys.lines!.why, "a sizeable change: 400 lines");
  assert.equal(keys.fallback!.why, "fell back from codex (handed over: codex → claude)");
  assert.equal(keys.resolve!.why, "conflicted at apply: a resolver ran (applied)");
  assert.equal(keys["expect-retry"]!.why, "met its expect only after 1 retry");
  assert.equal(keys.retries!.why, "retried 1 time(s): rate_limit ×1");
  assert.equal(keys.cost!.why, "cost $6.50");
  assert.equal(f.risk, "high");

  // Another failure reason counts as unfinished work.
  const crashed = scoreAgent(view({ state: "failed", failureReason: "exit" }), small, [], undefined);
  assert.deepEqual(crashed.factors, [{ key: "failed", points: 3, why: "it failed (exit): the change is unfinished work" }]);
  assert.equal(crashed.risk, "medium");

  // A passed expect.command is evidence for it, never below zero.
  const cmd = agentEvidence([], [view({ kind: "command", agentId: null, forAgentId: 1, state: "done" })]);
  const checked = scoreAgent(view(), small, [], cmd.get(1));
  assert.deepEqual([checked.score, checked.factors], [0, [{ key: "checked", points: -1, why: "its expect.command check passed" }]]);
  assert.deepEqual([riskLevel(2), riskLevel(3), riskLevel(5), riskLevel(6)], ["low", "medium", "medium", "high"]);
});

test("marks: append-only lines with who and how; the last one stands; malformed lines are skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-review-marks-"));
  try {
    appendReview(dir, { agentId: 1, state: "dismissed", by: "cli:dan <d@example.com>", via: "cli", note: "  not needed\r\n" }, 100);
    appendFileSync(join(dir, REVIEWS_FILE), "{nope\n" + JSON.stringify({ ts: 1, agentId: -1, state: "reviewed" }) + "\n" + JSON.stringify({ ts: 1, agentId: 1, state: "lgtm" }) + "\n");
    appendReview(dir, { agentId: 2, state: "reviewed", by: null, via: "dashboard" }, 101);
    appendReview(dir, { agentId: 1, state: "open", by: "ann", via: "dashboard" }, 102);
    const marks = readReviews(dir);
    assert.deepEqual(marks, [
      { ts: 100, agentId: 1, state: "dismissed", by: "cli:dan <d@example.com>", via: "cli", note: "not needed" },
      { ts: 101, agentId: 2, state: "reviewed", by: null, via: "dashboard" },
      { ts: 102, agentId: 1, state: "open", by: "ann", via: "dashboard" },
    ]);
    assert.equal(latestMarks(marks).get(1)!.state, "open");
    assert.deepEqual(readReviews(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A run made by hand: its events, and a kept diff per agent. */
function handRun(store: RunStore, opts: { name: string; createdAt?: number; origin?: string; agents: Array<{ id: number; label: string; diff: string; failed?: string }> }): string {
  const id = store.create({ script: `/demo/${opts.name}.js`, args: null, source: "/demo", workflowName: opts.name, ...(opts.origin ? { origin: opts.origin } : {}) });
  if (opts.createdAt !== undefined) {
    const metaPath = join(store.runDir(id), "meta.json");
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), createdAt: opts.createdAt }));
  }
  store.updateStatus(id, { state: "done", name: opts.name });
  for (const a of opts.agents) {
    const changes = { ...diffFiles(a.diff).reduce((c, f) => ({ files: c.files + 1, insertions: c.insertions + f.insertions, deletions: c.deletions + f.deletions }), { files: 0, insertions: 0, deletions: 0 }), truncated: false };
    const file = store.agentDiffPath(id, a.id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, a.diff);
    appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 10, type: "agent_started", agentId: a.id, label: a.label, phase: "Fix", adapter: "claude" }) + "\n");
    const end = a.failed
      ? { ts: 20, type: "agent_failed", agentId: a.id, label: a.label, phase: "Fix", adapter: "claude", error: "boom", reason: a.failed, changes }
      : { ts: 20, type: "agent_finished", agentId: a.id, label: a.label, phase: "Fix", adapter: "claude", attempts: 1, changes };
    appendFileSync(store.eventsPath(id), JSON.stringify(end) + "\n");
  }
  // An agent that kept nothing is no entry.
  appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 21, type: "agent_started", agentId: 99, label: "reader", adapter: "claude" }) + "\n");
  appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 22, type: "agent_finished", agentId: 99, label: "reader", adapter: "claude", attempts: 1 }) + "\n");
  appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 23, type: "run_finished" }) + "\n");
  return id;
}

interface Hand {
  root: string;
  store: RunStore;
  risky: string;
  calm: string;
  old: string;
}
let hand: Hand;

before(() => {
  const root = mkdtempSync(join(tmpdir(), "odw-review-"));
  const store = new RunStore(join(root, "runs"));
  const now = Date.now() / 1000;
  const risky = handRun(store, {
    name: "risky",
    createdAt: now - 3600,
    agents: [
      { id: 1, label: "ci", diff: diffOf([".github/workflows/ci.yml", "src/auth/login.ts"]) },
      { id: 2, label: "docs", diff: diffOf(["README.md"]) },
    ],
  });
  const calm = handRun(store, { name: "calm", createdAt: now - 60, agents: [{ id: 0, label: "half", diff: diffOf(["src/a.ts"]), failed: "exit" }] });
  const old = handRun(store, { name: "old", createdAt: now - 30 * 86_400, agents: [{ id: 3, label: "deps", diff: diffOf(["package.json"]) }] });
  handRun(store, { name: "an-eval", origin: "eval", agents: [{ id: 1, label: "x", diff: diffOf([".github/workflows/x.yml"]) }] });
  hand = { root, store, risky, calm, old };
});

after(() => {
  rmSync(hand.root, { recursive: true, force: true });
});

test("the queue: every kept diff across runs, riskiest first; an eval's runs, agents that kept nothing and marked entries are left out", () => {
  const reader = new ReviewReader(hand.store);
  const q = reader.queue();
  assert.deepEqual(
    q.entries.map((e) => [e.runId, e.agentId, e.label, e.score, e.risk]),
    [
      [hand.risky, 1, "ci", 6, "high"],
      [hand.calm, 0, "half", 3, "medium"],
      [hand.old, 3, "deps", 2, "low"],
      [hand.risky, 2, "docs", 0, "low"],
    ],
  );
  assert.deepEqual([q.open, q.marked], [4, 0]);
  const top = q.entries[0]!;
  assert.deepEqual([top.run, top.runState, top.phase, top.adapter, top.agentState], ["risky", "done", "Fix", "claude", "done"]);
  assert.deepEqual(top.changes, { files: 2, insertions: 2, deletions: 0, truncated: false });

  // --since: only the runs created in the window.
  assert.deepEqual(
    reader.queue({ since: Date.now() / 1000 - 7 * 86_400 }).entries.map((e) => e.runId),
    [hand.risky, hand.calm, hand.risky],
  );

  // Marked: off the queue, and back with `open`; `all` lists them with the mark.
  appendReview(hand.store.runDir(hand.risky), { agentId: 2, state: "dismissed", by: "ann", via: "cli" });
  const after1 = reader.queue();
  assert.deepEqual([after1.entries.length, after1.open, after1.marked], [3, 3, 1]);
  const all = reader.queue({ all: true });
  assert.equal(all.entries.find((e) => e.agentId === 2)!.review!.state, "dismissed");
  appendReview(hand.store.runDir(hand.risky), { agentId: 2, state: "open", by: "ann", via: "cli" });
  assert.equal(reader.queue().open, 4);
});

test("odw review prints each entry with its reasons and the commands that act on it; --json; mark by id or label", async () => {
  const flags = ["--runs-root", hand.store.root];
  const text = await cli(["review", ...flags]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^4 kept diff\(s\) to review, riskiest first\n/);
  assert.match(text.out, new RegExp(`HIGH    6  ${hand.risky} · agent 1 \\(ci\\) · 2 file\\(s\\) \\+2 -0 · risky\\n\\s+\\+3  touches CI: \\.github/workflows/ci\\.yml\\n\\s+\\+3  touches auth or security code: src/auth/login\\.ts\\n`));
  assert.match(text.out, new RegExp(`odw diff ${hand.risky} --agent 1 · odw apply ${hand.risky} --agent 1 --check · odw review mark ${hand.risky} 1 reviewed`));
  assert.match(text.out, /small, and nothing on record against it/);
  assert.match(text.out, / · failed/);

  const json = await cli(["review", "--json", "--since", "7d", ...flags]);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries[0].factors[0], { key: "ci", points: 3, why: "touches CI: .github/workflows/ci.yml" });

  const marked = await cli(["review", "mark", hand.risky, "ci", "reviewed", "--note", "looked at the workflow", ...flags]);
  assert.equal(marked.code, 0, marked.err);
  assert.equal(marked.out, `marked agent 1 of run ${hand.risky} reviewed\n`);
  const mark = readReviews(hand.store.runDir(hand.risky)).at(-1)!;
  assert.deepEqual([mark.agentId, mark.state, mark.via, mark.note], [1, "reviewed", "cli", "looked at the workflow"]);
  assert.match(mark.by ?? "", /^cli/, "who marked it");
  const left = await cli(["review", ...flags]);
  assert.match(left.out, /^3 kept diff\(s\) to review, riskiest first · 1 already dealt with \(--all lists them\)/);
  assert.match((await cli(["review", "--all", ...flags])).out, / · reviewed by cli/);
  assert.equal((await cli(["review", "mark", hand.risky, "1", "open", ...flags])).out, `agent 1 of run ${hand.risky} is back on the review queue\n`);

  // Mistakes.
  assert.equal((await cli(["review", "mark", hand.risky, "1", "lgtm", ...flags])).code, 2);
  assert.equal((await cli(["review", "mark", hand.risky, "1", ...flags])).code, 2);
  assert.equal((await cli(["review", "--since", "soon", ...flags])).code, 2);
  assert.equal((await cli(["review", "mark", "../x", "1", "reviewed", ...flags])).code, 2);
  assert.equal((await cli(["review", "mark", "no-such-run", "1", "reviewed", ...flags])).code, 1);
  const nobody = await cli(["review", "mark", hand.risky, "nobody", "reviewed", ...flags]);
  assert.equal(nobody.code, 1);
  assert.match(nobody.err, /has no agent 'nobody'/);
  const reader = await cli(["review", "mark", hand.risky, "reader", "reviewed", ...flags]);
  assert.equal(reader.code, 1);
  assert.match(reader.err, /kept no diff: there is nothing to review/);

  assert.equal(formatReview({ entries: [], open: 0, marked: 2 }), "nothing to review: no kept diff waits · 2 already dealt with (--all lists them)");
});

test("HTTP: GET /api/review; POST …/agents/:agentId/review marks it as who asks, behind the write guard", async () => {
  const handle = await startServer({ store: hand.store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(hand.root, "no-claude") });
  const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    fetch(`${handle.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const q = await fetch(`${handle.url}/api/review`).then((r) => r.json());
    assert.equal(q.entries[0].agentId, 1);
    assert.equal(q.open, q.entries.length);
    assert.equal((await fetch(`${handle.url}/api/review?since=nope`)).status, 400);
    const recent = await fetch(`${handle.url}/api/review?since=7d`).then((r) => r.json());
    assert.ok(recent.entries.every((e: { runId: string }) => e.runId !== hand.old));

    const ok = await post(`/api/runs/${hand.calm}/agents/0/review`, { state: "dismissed", note: "redo it" });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual([body.ok, body.state, body.via, body.note], [true, "dismissed", "dashboard", "redo it"]);
    const mark = readReviews(hand.store.runDir(hand.calm)).at(-1)!;
    assert.equal(mark.via, "dashboard");
    assert.equal(mark.by, localLauncher(), "who asks: the user who runs odw serve, without a token");
    const after = await fetch(`${handle.url}/api/review`).then((r) => r.json());
    assert.ok(!after.entries.some((e: { runId: string }) => e.runId === hand.calm), "off the queue");
    const all = await fetch(`${handle.url}/api/review?all=1`).then((r) => r.json());
    assert.equal(all.entries.find((e: { runId: string }) => e.runId === hand.calm).review.state, "dismissed");

    assert.equal((await post(`/api/runs/${hand.calm}/agents/0/review`, { state: "lgtm" })).status, 400);
    assert.equal((await post(`/api/runs/${hand.calm}/agents/0/review`, { state: "reviewed", note: 5 })).status, 400);
    assert.equal((await post(`/api/runs/${hand.calm}/agents/99/review`, { state: "reviewed" })).status, 404, "it kept no diff");
    assert.equal((await post(`/api/runs/${hand.calm}/agents/x/review`, { state: "reviewed" })).status, 400);
    assert.equal((await post(`/api/runs/no-such-run/agents/0/review`, { state: "reviewed" })).status, 404);
    // CSRF: not JSON, or another origin, is refused before anything is written.
    const before = readReviews(hand.store.runDir(hand.calm)).length;
    assert.equal((await post(`/api/runs/${hand.calm}/agents/0/review`, { state: "open" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(`/api/runs/${hand.calm}/agents/0/review`, { state: "open" }, { "content-type": "application/json", origin: "http://evil.example" })).status, 403);
    assert.equal(readReviews(hand.store.runDir(hand.calm)).length, before);
  } finally {
    await handle.close();
  }

  // Off loopback, marks are refused like every other write.
  const remote = await startServer({ store: hand.store, port: 0, host: "0.0.0.0", claudeProjectsRoot: join(hand.root, "no-claude") });
  try {
    const refused = await fetch(`http://127.0.0.1:${new URL(remote.url).port}/api/runs/${hand.calm}/agents/0/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "open" }),
    });
    assert.equal(refused.status, 409);
  } finally {
    await remote.close();
  }
});

test("odw apply marks what it applied cleanly as applied — not a --check — and it leaves the queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-review-apply-"));
  try {
    const src = join(root, "repo");
    mkdirSync(src);
    git(src, "init", "-q");
    writeFileSync(join(src, "a.txt"), "a\n");
    git(src, "add", "-A");
    git(src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
    const configPath = join(root, "odw.config.json");
    writeFileSync(configPath, JSON.stringify({ defaultAdapter: "edit", adapters: { edit: { command: [execPath, EDIT_AGENT], stdin: "{prompt}" } } }));
    const script = join(root, "wf.js");
    writeFileSync(
      script,
      "export const meta = { name: 'wf', description: 'd' }\n" +
        "return await parallel([\n" +
        `  () => agent('EDITS: ' + JSON.stringify({ write: { 'a.txt': 'a, edited\\n' } }), { isolation: 'worktree', label: 'small', expect: { command: 'exit 0' } }),\n` +
        `  () => agent('EDITS: ' + JSON.stringify({ write: { '.github/workflows/ci.yml': 'on: push\\n' } }), { isolation: 'worktree', label: 'ci' }),\n` +
        "])\n",
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: src, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done");
    const flags = ["--runs-root", store.root, "--config", configPath];

    const before = new ReviewReader(store).queue();
    assert.deepEqual(
      before.entries.map((e) => [e.label, e.risk, e.factors.map((f) => f.key)]),
      [
        ["ci", "medium", ["ci"]],
        ["small", "low", ["checked"]],
      ],
      "its expect.command step counts for it",
    );

    const check = await cli(["apply", id, "--agent", "small", "--check", ...flags], src);
    assert.equal(check.code, 0, check.err);
    assert.deepEqual(readReviews(store.runDir(id)), [], "a preview marks nothing");

    const applied = await cli(["apply", id, "--agent", "small", ...flags], src);
    assert.equal(applied.code, 0, applied.err);
    assert.equal(readFileSync(join(src, "a.txt"), "utf8"), "a, edited\n");
    const marks = readReviews(store.runDir(id));
    assert.equal(marks.length, 1);
    assert.deepEqual([marks[0]!.agentId, marks[0]!.state, marks[0]!.via], [before.entries[1]!.agentId, "applied", "apply"]);
    assert.deepEqual(
      new ReviewReader(store).queue().entries.map((e) => e.label),
      ["ci"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
