import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { decodeOutput } from "../src/adapters/output.js";
import type { Adapter, CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { AdapterExecutionError, AgentError, UnmetExpectationError } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { Expectations, globToRegExp, planChecks } from "../src/expect.js";
import { resumeKey } from "../src/journal.js";
import { attachRun, formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail, foldAgents } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { FakeTerm } from "./fake-term.js";

// Evidence of success (ODW extension): `expect` checks on agent() — each kind
// passing, missing, retried into a pass and retried into a typed failure, in
// place and isolated, against real git repositories — and the silent
// failures typed without opt-in: an empty reply, and permission denials under
// a reply that claims success.

const POSIX_ONLY = { skip: process.platform === "win32" };
const EXPECT_AGENT = fileURLToPath(new URL("./fixtures/expect-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A repo with `committed` in its one commit, and `dirty` written over it afterwards (the user's uncommitted work). */
function makeRepo(committed: Record<string, string>, dirty: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-expect-src-"));
  git(dir, "init", "-q");
  write(dir, committed);
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  write(dir, dirty);
  return dir;
}

/** One invocation of the scripted agent, as it logged it. */
interface Call {
  n: number;
  /** The adapter that ran it. */
  adapter: string;
  cwd: string;
  /** The `expect` feedback its prompt carried, from its first line on; null on a first attempt. */
  feedback: string | null;
  schemaRetry: boolean;
}

interface Flow {
  id: string;
  state: string;
  store: RunStore;
  result: Record<string, unknown>;
  events: WorkflowEvent[];
  calls: Call[];
}

/**
 * Run one agent() call as a workflow over `source`, with the scripted agent as
 * the default adapter: `plan` is its steps, `opts` its options. The workflow
 * returns `{ value }`, or `{ error }` when the call threw.
 */
async function runAgent(opts: {
  root: string;
  source: string;
  plan: unknown[];
  opts?: Record<string, unknown>;
  config?: Record<string, unknown>;
  claude?: boolean;
  adapter?: Record<string, unknown>;
  more?: Record<string, Record<string, unknown> & { claude?: boolean }>;
}): Promise<Flow> {
  const body =
    "try { return { value: await agent('Fix the bug. PLAN: ' + JSON.stringify(args.plan), args.opts) } }\n" +
    "catch (err) { return { error: String(err) } }\n";
  return runFlow({ ...opts, body, args: { plan: opts.plan, opts: { label: "fixer", ...opts.opts } } });
}

async function runFlow(opts: {
  root: string;
  source: string;
  body: string;
  args?: unknown;
  config?: Record<string, unknown>;
  /** Where the run store keeps its runs (default: under `root`). */
  runsIn?: string;
  /** The scripted agent speaks Claude Code's stream-json, refusals included. */
  claude?: boolean;
  /** More fields of the scripted adapter's entry. */
  adapter?: Record<string, unknown>;
  /**
   * More adapters, by name, that run the scripted agent too — on the same
   * plan, counted in the same log — with more fields of their entries.
   */
  more?: Record<string, Record<string, unknown> & { claude?: boolean }>;
}): Promise<Flow> {
  const log = join(opts.root, "calls.jsonl");
  const configPath = join(opts.root, "odw.config.json");
  const scripted = (name: string, claude?: boolean): Record<string, unknown> => ({
    command: claude ? [execPath, EXPECT_AGENT, log, "--claude"] : [execPath, EXPECT_AGENT, log],
    stdin: "{prompt}",
    env: { EXPECT_AGENT_ADAPTER: name },
    ...(claude ? { output: CLAUDE_LIKE } : {}),
  });
  const more = Object.entries(opts.more ?? {}).map(([name, { claude, ...fields }]) => [name, { ...scripted(name, claude), ...fields }]);
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "scripted",
      ...opts.config,
      adapters: { scripted: { ...scripted("scripted", opts.claude), ...opts.adapter }, ...Object.fromEntries(more) },
    }),
  );
  const script = join(opts.root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${opts.body}`);
  const store = new RunStore(opts.runsIn ?? join(opts.root, "runs"));
  const id = store.create({ script, args: opts.args ?? null, source: opts.source, configPath });
  const state = await executeRun(store.runDir(id));
  return {
    id,
    state,
    store,
    result: (store.readResult(id) ?? {}) as Record<string, unknown>,
    events: store.readEvents(id),
    calls: calls(log),
  };
}

/** The output declaration of the built-in claude adapter, for the scripted agent's --claude mode. */
const CLAUDE_LIKE = {
  format: "jsonl",
  eventType: "result",
  textPath: ["result"],
  select: "last",
  errorPath: ["is_error"],
  deniedPath: ["permission_denials"],
};

function calls(log: string): Call[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call) : [];
}

function ofType(events: WorkflowEvent[], type: string): WorkflowEvent[] {
  return events.filter((e) => e.type === type);
}

/** A command that passes only once `file` exists in its working directory, saying why it fails. */
const passesWith = (file: string): string[] => [
  execPath,
  "-e",
  `if(!require('fs').existsSync(${JSON.stringify(file)})){console.error('1 failing: add() returns NaN');process.exit(1)}console.log('all green')`,
];

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

// --- the options -------------------------------------------------------------------

test("expect, expectRetries and allowEmpty are checked when agent() is called: a misuse is a recoverable error", () => {
  const plan = planChecks({
    expect: { changes: true, files: ["src/**/*.ts"], command: ["npm", "test"], match: "^DONE", timeout: 30 },
    expectRetries: 2,
    allowEmpty: true,
  });
  assert.equal(plan.allowEmpty, true);
  assert.equal(plan.expectRetries, 2);
  assert.deepEqual(plan.expect && { ...plan.expect, files: plan.expect.files.map((f) => f.glob), match: String(plan.expect.match) }, {
    changes: true,
    files: ["src/**/*.ts"],
    command: ["npm", "test"],
    match: "/^DONE/",
    mcp: [],
    untouched: [],
    timeout: 30,
  });
  assert.equal(planChecks({}).expect, null);
  assert.equal(planChecks({ expect: {} }).expect, null, "no check, nothing to check");
  assert.equal(planChecks({ expect: { command: "npm test" } }).expect?.timeout, 600, "commands get 600 s by default");
  assert.equal(planChecks({}).allowEmpty, false);

  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ expect: "changes" }, /^agent\(\): expect must be an object of checks — \{ changes\?, files\?, command\?, match\?, mcp\?, untouched\?, timeout\? \}; got a string$/],
    [{ expect: [] }, /expect must be an object of checks .*got an empty array/],
    [{ expect: { change: true } }, /^agent\(\): expect has no check "change"; use changes, files, command, match, mcp, untouched, timeout$/],
    [{ expect: { untouched: "test/**" } }, /expect\.untouched must be an array of globs \(non-empty strings\); got a string/],
    [{ expect: { untouched: ["/repo/test/**"] } }, /expect\.untouched globs are relative to the agent's workspace; got "\/repo\/test\/\*\*"/],
    [{ expect: { untouched: ["test/{a"] } }, /expect\.untouched has an invalid glob "test\/\{a": an unclosed \{/],
    [{ expect: { changes: "yes" } }, /expect\.changes must be true or false; got a string/],
    [{ expect: { files: "src/**" } }, /expect\.files must be an array of globs \(non-empty strings\); got a string/],
    [{ expect: { files: [""] } }, /expect\.files must be an array of globs/],
    [{ expect: { files: ["/etc/passwd"] } }, /expect\.files globs are relative to the agent's workspace; got "\/etc\/passwd"/],
    [{ expect: { files: ["src/{a,b"] } }, /expect\.files has an invalid glob "src\/\{a,b": an unclosed \{/],
    [{ expect: { files: ["src/[ab"] } }, /an unclosed \[/],
    [{ expect: { command: "  " } }, /expect\.command must be a command string \(run by the shell\) or an argv array of strings; got an empty string/],
    [{ expect: { command: [] } }, /expect\.command must be .*; got an empty array/],
    [{ expect: { command: ["npm", 1] } }, /expect\.command must be/],
    [{ expect: { match: "(unclosed" } }, /expect\.match is not a valid regular expression/],
    [{ expect: { match: /re/ } }, /expect\.match must be a regular expression's source, as a string; got an object/],
    [{ expect: { command: "x", timeout: 0 } }, /expect\.timeout must be a positive number of seconds; got 0/],
    [{ expectRetries: -1 }, /^agent\(\): expectRetries must be a whole number, 0 or more; got -1$/],
    [{ expectRetries: 1.5 }, /expectRetries must be a whole number/],
    [{ allowEmpty: "yes" }, /^agent\(\): allowEmpty must be true or false; got a string$/],
  ];
  for (const [opts, message] of cases) {
    assert.throws(() => planChecks(opts), (err: unknown) => err instanceof AgentError && message.test(err.message), JSON.stringify(opts));
  }
});

test("globs match whole workspace-relative paths: *, **, ?, classes, braces and escapes", () => {
  const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);
  const table: Array<[string, string, boolean]> = [
    ["README.md", "README.md", true],
    ["./README.md", "README.md", true],
    ["*.md", "README.md", true],
    ["*.md", "docs/a.md", false],
    ["docs/*.md", "docs/a.md", true],
    ["docs/*.md", "docs/sub/a.md", false],
    ["src/**", "src/a.ts", true],
    ["src/**", "src/a/b/c.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "tests/deep/a.test.ts", true],
    ["src/**/index.ts", "src/index.ts", true],
    ["src/**/index.ts", "src/a/b/index.ts", true],
    ["src/a**.ts", "src/abc.ts", true],
    ["src/a**.ts", "src/a/b.ts", false],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file10.txt", false],
    ["[ab].txt", "a.txt", true],
    ["[ab].txt", "c.txt", false],
    ["[!ab].txt", "c.txt", true],
    ["[!ab].txt", "a.txt", false],
    ["[]x].txt", "].txt", true],
    ["*.{ts,js}", "a.js", true],
    ["*.{ts,js}", "a.py", false],
    ["a+b(1).txt", "a+b(1).txt", true],
    ["\\*.txt", "*.txt", true],
    ["\\*.txt", "a.txt", false],
    ["../README.md", "../README.md", true],
  ];
  for (const [glob, path, expected] of table) assert.equal(matches(glob, path), expected, `${glob} vs ${path}`);
});

test("a misused option fails that call before it is dispatched; the next call still runs as agent 1", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runFlow({
      root,
      source: root,
      body:
        "let misuse = null\n" +
        "try { await agent('PLAN: [{}]', { expect: { change: true } }) } catch (err) { misuse = String(err) }\n" +
        "return { misuse, value: await agent('PLAN: [{\"reply\":\"ok\"}]', { label: 'next' }) }\n",
    });
    assert.equal(flow.state, "done");
    assert.match(String(flow.result.misuse), /^AgentError: agent\(\): expect has no check "change"/);
    assert.equal(flow.result.value, "ok");
    assert.deepEqual(ofType(flow.events, "agent_started").map((e) => [e.agentId, e.label]), [[1, "next"]]);
    assert.equal(flow.calls.length, 1, "the misused call never ran its CLI");
  } finally {
    cleanup(root);
  }
});

// --- in place: changes, files, command, match ------------------------------------------

test("changes: true — work that changed nothing runs again, told what it missed, and passes once it changes a file", async () => {
  // The user's own uncommitted work is in the tree before the agent starts: it is not the agent's change.
  const src = makeRepo({ "a.txt": "bug\n" }, { "wip.txt": "the user's draft\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: src,
      plan: [{ reply: "fixed" }, { write: { "a.txt": "fix\n" }, reply: "fixed for real" }],
      opts: { expect: { changes: true } },
    });
    assert.equal(flow.state, "done");
    assert.deepEqual(flow.result, { value: "fixed for real" });
    assert.equal(flow.calls.length, 2);
    assert.equal(flow.calls[0]!.feedback, null);
    const feedback = flow.calls[1]!.feedback!;
    assert.match(feedback, /^Your previous attempt at this task did not meet these expectations, which are checked again when you reply:\n- a file must change, and none did\n/);
    assert.match(feedback, /The previous attempt's changes are still in your working directory/);

    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.equal(finished.attempts, 2, "the retry is a second attempt");
    const retried = ofType(flow.events, "log").find((e) => Array.isArray(e.misses));
    assert.ok(retried, "the retry is logged");
    assert.equal(
      retried.message,
      "fixer:1 did not meet its expectations — running it again, told what it missed (1/1): a file must change, and none did",
    );
    assert.deepEqual(retried.misses, ["a file must change, and none did"]);
    assert.deepEqual(retried.retry, { reason: "expect", n: 1, of: 1 });
    assert.equal(retried.agentId, 1);
    // The transcript says why the CLI ran again.
    const transcript = readFileSync(flow.store.agentTranscriptPaths(flow.id, 1).transcript, "utf8");
    assert.match(transcript, /^\{"kind":"attempt","n":2,"reason":"expect"\}$/m);
  } finally {
    cleanup(src, root);
  }
});

test("changes: true — work that never changes a file fails with reason unmet_expectation and its misses", async () => {
  const src = makeRepo({ "a.txt": "bug\n" }, { "wip.txt": "the user's draft\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: src,
      plan: [{ reply: "All fixed!" }],
      opts: { expect: { changes: true }, expectRetries: 2 },
    });
    assert.equal(flow.state, "done", "a failed agent is the script's to handle");
    assert.equal(
      flow.result.error,
      "UnmetExpectationError: adapter 'scripted' did not meet its expectations after 2 retries: a file must change, and none did",
    );
    assert.equal(flow.calls.length, 3, "the first attempt and expectRetries: 2 more");
    const failed = ofType(flow.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "unmet_expectation");
    assert.deepEqual(failed.misses, ["a file must change, and none did"]);
    assert.equal(ofType(flow.events, "log").filter((e) => Array.isArray(e.misses)).length, 2);
    // The read model carries both: what the dashboard and /api/runs/:id serve.
    const [agent] = detail(flow.store, flow.id).agents;
    assert.equal(agent!.state, "failed");
    assert.equal(agent!.failureReason, "unmet_expectation");
    assert.deepEqual(agent!.misses, ["a file must change, and none did"]);
  } finally {
    cleanup(src, root);
  }
});

test("changes: false — an agent that must not touch files passes beside the user's own edits, and fails when it edits", async () => {
  const src = makeRepo({ "a.txt": "x\n" }, { "wip.txt": "the user's draft\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const clean = await runAgent({ root, source: src, plan: [{ reply: "looks fine" }], opts: { expect: { changes: false } } });
    assert.deepEqual(clean.result, { value: "looks fine" });

    // The expectRetries setting (here 0) bounds the retries when the call does not.
    const edits = await runAgent({
      root: root2,
      source: src,
      plan: [{ write: { "b.txt": "oops\n", "a.txt": "y\n" }, reply: "reviewed" }],
      opts: { expect: { changes: false } },
      config: { expectRetries: 0 },
    });
    assert.equal(
      edits.result.error,
      "UnmetExpectationError: adapter 'scripted' did not meet its expectations: no file may change, and 2 did: a.txt, b.txt",
    );
    assert.equal(edits.calls.length, 1);
  } finally {
    cleanup(src, root, root2);
  }
});

test("in place: the run's own directory in the source tree — a project-local runsRoot — is never the agent's change", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    // The run writes its events and the agent's transcript there while the agent works.
    const flow = await runFlow({
      root,
      source: src,
      runsIn: join(src, ".odw-runs"),
      body: "return await agent('PLAN: [{\"reply\":\"looked\"}]', { expect: { changes: false }, expectRetries: 0 })\n",
    });
    assert.equal(flow.state, "done", JSON.stringify(flow.store.readError(flow.id)));
    assert.equal(flow.result as unknown, "looked");
    assert.ok(existsSync(flow.store.agentTranscriptPaths(flow.id, 1).transcript), "the run did write inside the tree");
  } finally {
    cleanup(src, root);
  }
});

test("files — each glob needs a file the agent changed or created; deleting one does not count", async () => {
  const src = makeRepo({ "src/a.ts": "a\n", "docs/x.md": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: src,
      plan: [
        { write: { "docs/y.md": "y\n" }, remove: ["src/a.ts"] },
        { write: { "src/lib/b.ts": "b\n" }, reply: "added b" },
      ],
      opts: { expect: { files: ["src/**/*.ts", "docs/*.md"] } },
    });
    assert.deepEqual(flow.result, { value: "added b" });
    const feedback = flow.calls[1]!.feedback!;
    assert.match(feedback, /^- a file matching "src\/\*\*\/\*\.ts" must change or be created, and none did$/m);
    assert.doesNotMatch(feedback, /docs/, "docs/y.md met its glob in the first attempt");
  } finally {
    cleanup(src, root);
  }
});

test("untouched — in place, editing or deleting a protected file is a miss naming it; restored, the work passes", async () => {
  const committed = {
    "src/add.js": "module.exports = (a, b) => a - b\n",
    "test/add.test.js": "assert(add(1, 2) === 3)\n",
    ".github/workflows/ci.yml": "on: push\n",
  };
  // The user's own draft test, uncommitted before the agent starts, is not the agent's change.
  const src = makeRepo(committed, { "test/draft.test.js": "the user's draft\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: src,
      plan: [
        // Gaming the check: skip the test and drop CI, beside the real fix.
        { write: { "src/add.js": "module.exports = (a, b) => a + b\n", "test/add.test.js": "// skipped\n" }, remove: [".github/workflows/ci.yml"] },
        { write: { "test/add.test.js": committed["test/add.test.js"], ".github/workflows/ci.yml": committed[".github/workflows/ci.yml"] }, reply: "fixed add" },
      ],
      opts: { expect: { changes: true, untouched: ["test/**", "**/*.snap", ".github/**"] } },
    });
    assert.deepEqual(flow.result, { value: "fixed add" });
    assert.equal(flow.calls.length, 2);
    const feedback = flow.calls[1]!.feedback!;
    assert.match(
      feedback,
      /^- no file matching "test\/\*\*", "\.github\/\*\*" may change, and 2 did: (\.github\/workflows\/ci\.yml, test\/add\.test\.js|test\/add\.test\.js, \.github\/workflows\/ci\.yml)\. Those files are not yours to change: restore them/m,
    );
    assert.doesNotMatch(feedback, /draft|snap/, "the user's draft and an unmatched glob are not named");
  } finally {
    cleanup(src, root);
  }
});

test("untouched — isolated, a created file counts too; a protected path still touched after the retries fails with its misses", async () => {
  const src = makeRepo({ "src/view.js": "old\n", "__snapshots__/view.snap": "old\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: src,
      plan: [{ write: { "src/view.js": "new\n", "__snapshots__/view.snap": "new\n", "test/view.test.js": "new test\n" }, reply: "updated" }],
      opts: { isolation: "worktree", expect: { untouched: ["**/*.snap", "test/**"] }, expectRetries: 0 },
    });
    assert.equal(
      flow.result.error,
      "UnmetExpectationError: adapter 'scripted' did not meet its expectations: no file matching \"**/*.snap\", \"test/**\" may change, " +
        "and 2 did: __snapshots__/view.snap, test/view.test.js",
    );
    const failed = ofType(flow.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "unmet_expectation");
    assert.equal(git(src, "status", "--porcelain"), "", "the source tree is untouched");
    // Untouched alone is a check; protected files nobody touched pass it.
    assert.notEqual(planChecks({ expect: { untouched: ["test/**"] } }).expect, null);
    assert.equal(planChecks({ expect: { untouched: [] } }).expect, null, "no glob, nothing to check");
  } finally {
    cleanup(src, root);
  }
});

test("in place: an agent's commits count, and paths are relative to the agent's workspace — a subdirectory --source included", async () => {
  const repo = makeRepo({ "top.txt": "t\n", "packages/foo/README.md": "foo\n" });
  const source = join(repo, "packages", "foo");
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    // A commit leaves `git status` clean: what HEAD moved over is the change.
    const committed = await runAgent({
      root,
      source,
      plan: [{ write: { "src/x.ts": "x\n" }, commit: "add x", reply: "committed" }],
      opts: { expect: { changes: true, files: ["src/*.ts"] } },
    });
    assert.deepEqual(committed.result, { value: "committed" });
    // The agent's process.cwd() is the real path (macOS: /var → /private/var).
    assert.equal(committed.calls[0]!.cwd, realpathSync(source));

    const outside = await runAgent({
      root: root2,
      source,
      plan: [{ write: { "../../top.txt": "edited\n" }, reply: "edited" }],
      opts: { expect: { changes: false }, expectRetries: 0 },
    });
    assert.deepEqual(ofType(outside.events, "agent_failed")[0]!.misses, ["no file may change, and 1 did: ../../top.txt"]);
  } finally {
    cleanup(repo, root, root2);
  }
});

test("command — it must exit 0 in the agent's workspace; a red run is retried with its output, as a command step under the agent", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runFlow({
      root,
      source: src,
      args: { command: passesWith("fixed.txt") },
      body:
        "phase('Fix')\n" +
        "const plan = [{ reply: 'fixed it' }, { write: { 'fixed.txt': '1' }, reply: 'really fixed' }]\n" +
        "return await agent('PLAN: ' + JSON.stringify(plan), { label: 'fixer', expect: { command: args.command } })\n",
    });
    assert.equal(flow.state, "done");
    assert.equal(flow.result as unknown, "really fixed");
    const feedback = flow.calls[1]!.feedback!;
    assert.match(feedback, /^- `.*` must exit 0, and it exited with code 1\. Its output ended with:\n<<<\n1 failing: add\(\) returns NaN\n>>>$/m);

    // Each check is an exec() step of the run, in the agent's phase, carrying the agent's id.
    const started = ofType(flow.events, "command_started");
    assert.equal(started.length, 2);
    for (const ev of started) {
      assert.equal(ev.forAgentId, 1);
      assert.equal(ev.label, "fixer: expect");
      assert.equal(ev.phase, "Fix");
    }
    assert.deepEqual(
      ofType(flow.events, "command_failed").map((e) => [e.exitCode, e.error]),
      [[1, "exited with code 1"]],
    );
    const nodes = foldAgents(flow.events);
    assert.deepEqual(
      nodes.map((n) => [n.kind, n.label, n.state, n.forAgentId]),
      [
        ["agent", "fixer", "done", undefined],
        ["command", "fixer: expect", "failed", 1],
        ["command", "fixer: expect", "done", 1],
      ],
    );
  } finally {
    cleanup(src, root);
  }
});

test("command — work that stays red fails with what it missed; the command runs where the agent ran", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    // No git repository is needed for a command or a match.
    const where = join(root, "where.txt");
    const flow = await runAgent({
      root,
      source: root,
      plan: [{ reply: "tried" }],
      opts: {
        expect: { command: [execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(where)}, process.cwd() + ' ' + process.env.ODW_AGENT_ID); process.exit(3)`] },
      },
    });
    assert.match(String(flow.result.error), /did not meet its expectations after 1 retry: `.*` must exit 0, and it exited with code 3$/);
    const failed = ofType(flow.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "unmet_expectation");
    assert.match(String((failed.misses as string[])[0]), /^`.*` must exit 0, and it exited with code 3$/);
    assert.equal(readFileSync(where, "utf8"), `${flow.calls[0]!.cwd} 1`, "in the agent's directory, with its ODW_AGENT_ID");
  } finally {
    cleanup(root);
  }
});

test("in place: what a check's command writes in the tree is not the agent's change when the work is judged again", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    // The test command leaves an untracked report, and fails.
    const command = [execPath, "-e", "require('fs').writeFileSync('report.xml', '<failures/>'); process.exit(1)"];
    const flow = await runAgent({
      root,
      source: src,
      plan: [{ reply: "nothing to do" }],
      opts: { expect: { changes: true, command } },
    });
    assert.ok(existsSync(join(src, "report.xml")), "the command did write its report");
    assert.equal(flow.calls.length, 2);
    // The retry changed nothing either: the report does not pass for its work.
    const misses = ofType(flow.events, "agent_failed")[0]!.misses as string[];
    assert.equal(misses.length, 2);
    assert.equal(misses[0], "a file must change, and none did");
    assert.match(misses[1]!, /must exit 0, and it exited with code 1$/);
  } finally {
    cleanup(src, root);
  }
});

test("command — one that outlives expect.timeout is killed, and that is a miss", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: root,
      plan: [{ reply: "done" }],
      opts: { expect: { command: [execPath, "-e", "setTimeout(() => {}, 60000)"], timeout: 0.3 }, expectRetries: 0 },
    });
    assert.match(String(flow.result.error), /`.*` must exit 0, and it timed out after 0\.3s$/);
    assert.match(String(ofType(flow.events, "command_failed")[0]!.error), /^timed out after 0\.3s$/);
  } finally {
    cleanup(root);
  }
});

test("match — the reply must match the regular expression", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: root,
      plan: [{ reply: "working on it" }, { reply: "DONE: 3 files" }],
      opts: { expect: { match: "^DONE: \\d+ files$" } },
    });
    assert.deepEqual(flow.result, { value: "DONE: 3 files" });
    assert.match(flow.calls[1]!.feedback!, /^- the reply must match \/\^DONE: \\d\+ files\$\/, and it does not$/m);

    const never = await runAgent({
      root: root2,
      source: root2,
      plan: [{ reply: "working on it" }],
      opts: { expect: { match: "^DONE" } },
    });
    assert.deepEqual(ofType(never.events, "agent_failed")[0]!.misses, ["the reply must match /^DONE/, and it does not"]);
  } finally {
    cleanup(root, root2);
  }
});

test("expect.changes outside a git repository fails the agent before its CLI runs, saying why", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({ root, source: root, plan: [{ reply: "x" }], opts: { expect: { changes: true, files: ["a"] } } });
    assert.match(
      String(flow.result.error),
      /^AgentError: agent\(\): expect\.changes and expect\.files read what the agent changed from git, and '.*' is not in a git repository \(.*\) — run it in one, or check the work with expect\.command$/,
    );
    assert.equal(flow.calls.length, 0, "no tokens spent on work that cannot be checked");
    assert.equal(ofType(flow.events, "agent_failed").length, 1);
  } finally {
    cleanup(root);
  }
});

// --- with isolation: what the kept diff holds ---------------------------------------------

test("isolated: what the agent changed is what its kept diff holds — its commits count, the setup's files do not", async () => {
  const src = makeRepo({ "a.txt": "old\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const ran = join(root, "setup-ran");
    const flow = await runFlow({
      root,
      source: src,
      // The setup leaves a file in every worktree before its agent starts: not the agent's change.
      config: {
        worktreeSetup: [
          execPath,
          "-e",
          `const fs = require('fs'); fs.writeFileSync('setup.out', 'built'); fs.appendFileSync(${JSON.stringify(ran)}, 'ran\\n')`,
        ],
      },
      body:
        "const looked = await agent('PLAN: [{\"reply\":\"looked\"}]', { label: 'reader', isolation: 'worktree', expect: { changes: false } })\n" +
        "const committed = await agent('PLAN: [{\"write\":{\"a.txt\":\"new\\\\n\"},\"commit\":\"agent commit\",\"reply\":\"committed\"}]', " +
        "{ label: 'writer', isolation: 'worktree', expect: { changes: true, files: ['a.txt'] } })\n" +
        "return { looked, committed }\n",
    });
    assert.equal(flow.state, "done", JSON.stringify(flow.store.readError(flow.id)));
    assert.equal(readFileSync(ran, "utf8"), "ran\nran\n", "the setup ran in both worktrees");
    assert.deepEqual(flow.result, { looked: "looked", committed: "committed" });
    assert.equal(flow.calls.length, 2, "both met their checks the first time");
    assert.notEqual(flow.calls[0]!.cwd, src, "each ran in its own worktree");
    assert.deepEqual(ofType(flow.events, "agent_finished")[1]!.changes, { files: 1, insertions: 1, deletions: 1, truncated: false });
    assert.equal(git(src, "status", "--porcelain"), "", "the source tree is untouched");
  } finally {
    cleanup(src, root);
  }
});

test("isolated: a schema retry that only reformats is judged on the work of the attempt that did it", async () => {
  const src = makeRepo({ "a.txt": "bug\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runFlow({
      root,
      source: src,
      args: {
        command: [execPath, "-e", "process.exit(require('fs').readFileSync('a.txt','utf8') === 'fixed\\n' ? 0 : 1)"],
      },
      body:
        "const plan = [{ write: { 'a.txt': 'fixed\\n' }, reply: 'I fixed a.txt' }, { reply: '{\"fixed\": true}' }]\n" +
        "const schema = { type: 'object', required: ['fixed'], properties: { fixed: { type: 'boolean' } } }\n" +
        "return await agent('PLAN: ' + JSON.stringify(plan), { isolation: 'worktree', schema, expect: { changes: true, files: ['a.txt'], command: args.command } })\n",
    });
    assert.equal(flow.state, "done", JSON.stringify(flow.store.readError(flow.id)));
    assert.deepEqual(flow.result, { fixed: true });
    assert.deepEqual(flow.calls.map((c) => [c.schemaRetry, c.feedback]), [[false, null], [true, null]]);
    // The check ran once, in the worktree that held the work; the reformat changed nothing.
    assert.deepEqual(ofType(flow.events, "command_finished").map((e) => e.exitCode), [0]);
    assert.equal(ofType(flow.events, "command_started").length, 1);
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.equal(finished.attempts, 2);
    assert.deepEqual(finished.changes, { files: 1, insertions: 1, deletions: 1, truncated: false });
  } finally {
    cleanup(src, root);
  }
});

test("in place: a schema retry comes first, then the checks run once, on the reply that validated", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runFlow({
      root,
      source: root,
      args: { command: [execPath, "-e", "process.exit(0)"] },
      body:
        "const plan = [{ reply: 'verdict: PASS' }, { reply: '{\"verdict\": \"PASS\"}' }]\n" +
        "const schema = { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL'] } } }\n" +
        "return await agent('PLAN: ' + JSON.stringify(plan), { schema, expect: { command: args.command, match: '\"verdict\": \"PASS\"' } })\n",
    });
    assert.deepEqual(flow.result, { verdict: "PASS" });
    assert.deepEqual(flow.calls.map((c) => c.schemaRetry), [false, true]);
    assert.equal(ofType(flow.events, "command_started").length, 1, "no check of a reply that failed the schema");
  } finally {
    cleanup(root);
  }
});

test("isolated: a retry starts over in a fresh worktree, and the change it leaves replaces the earlier one", async () => {
  const src = makeRepo({ "a.txt": "a\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: src,
      plan: [{ write: { "wrong.txt": "x\n" }, reply: "done" }, { write: { "right.txt": "y\n" }, reply: "done again" }],
      opts: { isolation: "worktree", expect: { command: passesWith("right.txt") } },
    });
    assert.deepEqual(flow.result, { value: "done again" });
    assert.match(flow.calls[1]!.feedback!, /You start again in a fresh checkout: the previous attempt's changes are not in it/);
    assert.notEqual(flow.calls[0]!.cwd, flow.calls[1]!.cwd);
    const diff = readFileSync(flow.store.agentDiffPath(flow.id, 1), "utf8");
    assert.match(diff, /^diff --git a\/right\.txt b\/right\.txt$/m);
    assert.doesNotMatch(diff, /wrong\.txt/, "the first attempt's change is superseded");

    // A retry that changes nothing leaves nothing — the change it was asked not to make is gone.
    const undone = await runAgent({
      root: root2,
      source: src,
      plan: [{ write: { "wrong.txt": "x\n" }, reply: "edited" }, { reply: "left it alone" }],
      opts: { isolation: "worktree", expect: { changes: false } },
    });
    assert.deepEqual(undone.result, { value: "left it alone" });
    assert.equal(ofType(undone.events, "agent_finished")[0]!.changes, undefined);
    assert.equal(existsSync(undone.store.agentDiffPath(undone.id, 1)), false);
  } finally {
    cleanup(src, root, root2);
  }
});

// --- with a fallback chain: a hop keeps the checks, a retry keeps its adapter --------------

/** What a CLI prints when its usage quota is spent, as tests/failures.test.ts samples it. */
const QUOTA = "You've hit your usage limit. Upgrade to Pro or try again in 3h 22m.";

/** The `attempt` lines of an agent's transcript: why each CLI run after the first ran, and where. */
function attemptsOf(flow: Flow, agentId = 1): Array<[unknown, unknown]> {
  const transcript = readFileSync(flow.store.agentTranscriptPaths(flow.id, agentId).transcript, "utf8");
  return transcript
    .split("\n")
    .filter((line) => line.startsWith('{"kind":"attempt"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((attempt) => [attempt.reason, attempt.adapter]);
}

test("a fallback hop keeps the call's expect, and a miss is retried on the adapter that produced it", async () => {
  const src = makeRepo({ "a.txt": "a\n" });
  const src2 = makeRepo({ "a.txt": "a\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    // Out of quota on its first adapter, the call starts over on the next one,
    // whose work is checked as the first one's would have been — and retried there.
    const flow = await runAgent({
      root,
      source: src,
      more: { backup: {} },
      config: { fallback: { scripted: ["backup"] } },
      plan: [{ reply: QUOTA, exit: 1 }, { reply: "nothing to do" }, { write: { "b.txt": "b\n" }, reply: "fixed" }],
      opts: { expect: { changes: true } },
    });
    assert.deepEqual(flow.result, { value: "fixed" });
    assert.deepEqual(flow.calls.map((c) => c.adapter), ["scripted", "backup", "backup"]);
    assert.equal(flow.calls[1]!.feedback, null, "the hop starts the work over, with a fresh prompt");
    assert.match(flow.calls[2]!.feedback!, /^- a file must change, and none did$/m);
    assert.deepEqual(attemptsOf(flow), [
      ["fallback", "backup"],
      ["expect", undefined],
    ]);
    const logs = ofType(flow.events, "log").map((e) => String(e.message));
    assert.deepEqual(logs.slice(0, 2), [
      "fixer:1 → backup after scripted quota",
      "fixer:1 did not meet its expectations — running it again, told what it missed (1/1): a file must change, and none did",
    ]);
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.deepEqual([finished.adapter, finished.fellBackFrom, finished.attempts], ["backup", ["scripted"], 2]);

    // A retry whose CLI then runs out of quota falls back like any run: the
    // next adapter starts the work over, judged against the tree as it was
    // before the call began.
    const moved = await runAgent({
      root: root2,
      source: src2,
      more: { backup: {} },
      config: { fallback: { scripted: ["backup"] } },
      plan: [{ reply: "nothing to do" }, { reply: QUOTA, exit: 1 }, { write: { "b.txt": "b\n" }, reply: "fixed" }],
      opts: { expect: { changes: true } },
    });
    assert.deepEqual(moved.result, { value: "fixed" });
    assert.deepEqual(moved.calls.map((c) => c.adapter), ["scripted", "scripted", "backup"]);
    assert.match(moved.calls[1]!.feedback!, /^- a file must change, and none did$/m);
    assert.equal(moved.calls[2]!.feedback, null);
    assert.deepEqual(attemptsOf(moved), [
      ["expect", undefined],
      ["fallback", "backup"],
    ]);
    const done = ofType(moved.events, "agent_finished")[0]!;
    assert.deepEqual([done.adapter, done.fellBackFrom, done.attempts], ["backup", ["scripted"], 1]);
  } finally {
    cleanup(src, src2, root, root2);
  }
});

test("in place: what an adapter changed before it ran out of quota stays in the tree, and counts as the call's change", async () => {
  const src = makeRepo({ "a.txt": "a\n" }, { "notes.txt": "the user's own edit\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: src,
      more: { backup: {} },
      config: { fallback: { scripted: ["backup"] } },
      plan: [{ write: { "b.txt": "b\n" }, reply: QUOTA, exit: 1 }, { reply: "b.txt is already there" }],
      opts: { expect: { changes: true, files: ["b.txt"] } },
    });
    assert.deepEqual(flow.result, { value: "b.txt is already there" });
    assert.deepEqual(flow.calls.map((c) => [c.adapter, c.feedback]), [
      ["scripted", null],
      ["backup", null],
    ]);
  } finally {
    cleanup(src, root);
  }
});

test("isolated: each hop is judged on its own worktree — what the adapter that ran out of quota changed does not count", async () => {
  const src = makeRepo({ "a.txt": "bug\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: src,
      more: { backup: {} },
      config: { fallback: { scripted: ["backup"] } },
      plan: [
        // The first adapter fixes a.txt but replies off-schema; its schema retry runs out of quota.
        { write: { "a.txt": "first\n" }, reply: "I fixed a.txt" },
        { reply: QUOTA, exit: 1 },
        // The next one starts in a fresh worktree, without that change, and replies without doing the work…
        { reply: '{"fixed": true}' },
        // …so it is told, and does it.
        { write: { "a.txt": "second\n" }, reply: '{"fixed": true}' },
      ],
      opts: {
        isolation: "worktree",
        schema: { type: "object", required: ["fixed"], properties: { fixed: { type: "boolean" } } },
        expect: { changes: true, files: ["a.txt"] },
      },
    });
    assert.deepEqual(flow.result, { value: { fixed: true } });
    assert.deepEqual(
      flow.calls.map((c) => [c.adapter, c.schemaRetry]),
      [
        ["scripted", false],
        ["scripted", true],
        ["backup", false],
        ["backup", false],
      ],
    );
    assert.notEqual(flow.calls[2]!.cwd, flow.calls[0]!.cwd);
    assert.equal(flow.calls[2]!.feedback, null);
    assert.match(flow.calls[3]!.feedback!, /^- a file must change, and none did$/m);
    assert.match(flow.calls[3]!.feedback!, /^- a file matching "a\.txt" must change or be created, and none did$/m);
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.deepEqual([finished.adapter, finished.fellBackFrom], ["backup", ["scripted"]]);
    assert.deepEqual(finished.changes, { files: 1, insertions: 1, deletions: 1, truncated: false });
    const diff = readFileSync(flow.store.agentDiffPath(flow.id, 1), "utf8");
    assert.match(diff, /^\+second$/m);
    assert.doesNotMatch(diff, /first/, "the change the first adapter left went with its worktree");
  } finally {
    cleanup(src, root);
  }
});

// --- stop ----------------------------------------------------------------------------------

/** Whether `pid` is a live (non-zombie) process. POSIX only. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

test("a stop kills a running expect command at once and ends the run", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const log = join(root, "calls.jsonl");
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ defaultAdapter: "scripted", adapters: { scripted: { command: [execPath, EXPECT_AGENT, log], stdin: "{prompt}" } } }),
    );
    const script = join(root, "wf.js");
    writeFileSync(
      script,
      "export const meta = { name: 'wf', description: 'd' }\n" +
        "return await agent('PLAN: [{\"reply\":\"ok\"}]', { label: 'slow', expect: { command: 'sleep 30 & echo $! > sleeper.pid; wait' } })\n",
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    const run = executeRun(store.runDir(id));
    const pidFile = join(root, "sleeper.pid");
    assert.ok(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""));
    const sleeper = Number(readFileSync(pidFile, "utf8").trim());
    const stoppedAt = Date.now();
    store.writeControl(id, "stop");
    assert.equal(await run, "stopped");
    assert.ok(Date.now() - stoppedAt < 8000, "the stop was not honoured promptly");
    assert.ok(await eventually(() => !isRunning(sleeper)), `sleeper ${sleeper} survived the stop`);
    const events = store.readEvents(id);
    const killed = ofType(events, "command_failed")[0]!;
    assert.match(String(killed.error), /^aborted: run was stopped/);
    assert.equal(killed.forAgentId, 1);
    assert.match(String(ofType(events, "agent_failed")[0]!.error), /RunStopped/);
  } finally {
    cleanup(root);
  }
});

// --- silent failures, typed without opt-in ------------------------------------------------

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

function config(adapter: string) {
  const cfg = defaultConfig();
  cfg.settings.defaultAdapter = adapter;
  return cfg;
}

test("an empty or whitespace-only reply fails with reason empty_reply — not retried, not schema-checked — unless allowEmpty", async () => {
  for (const reply of ["", "  \n\t "]) {
    let runs = 0;
    const bridge = new Bridge(config("codex"), {
      runner: async () => {
        runs++;
        return ok(reply);
      },
    });
    await assert.rejects(
      bridge.run({ prompt: "x", schema: { type: "object" } }),
      (err: unknown) =>
        err instanceof AdapterExecutionError &&
        err.reason === "empty_reply" &&
        /^adapter 'codex' replied with nothing — it did not answer \(odw doctor --smoke checks a CLI headless\); pass allowEmpty: true if an empty reply is a valid answer$/.test(err.message),
    );
    assert.equal(runs, 1, "no schema retry for nothing");
    const allowed = await new Bridge(config("codex"), { runner: async () => ok(reply) }).run({ prompt: "x", allowEmpty: true });
    assert.equal(allowed.value, "");
  }
  // Claude Code's result event with an empty result is an empty reply too; its stderr is the evidence.
  const claude = new Bridge(config("claude"), {
    runner: async () => ({ ...ok(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" })), stderr: "warning: nothing to do" }),
  });
  await assert.rejects(claude.run({ prompt: "x" }), /^AdapterExecutionError: adapter 'claude' replied with nothing — .*: warning: nothing to do$/);
});

test("the whole stack: an empty reply fails the agent with reason empty_reply; allowEmpty takes it as the answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const empty = await runAgent({ root, source: root, plan: [{ reply: "" }] });
    assert.match(String(empty.result.error), /^AdapterExecutionError: adapter 'scripted' replied with nothing/);
    assert.equal(ofType(empty.events, "agent_failed")[0]!.reason, "empty_reply");
    const allowed = await runAgent({ root: root2, source: root2, plan: [{ reply: "" }], opts: { allowEmpty: true } });
    assert.deepEqual(allowed.result, { value: "" });
  } finally {
    cleanup(root, root2);
  }
});

/** Claude Code's stream-json, as `claude -p --output-format stream-json --verbose` prints it, ending in `result`. */
const claudeStream = (result: Record<string, unknown>): string =>
  [
    { type: "system", subtype: "init", cwd: "/repo", session_id: "s", tools: ["Read", "Edit", "Bash"], permissionMode: "acceptEdits" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] },
      session_id: "s",
    },
    {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      message: "Permission to use Bash has been denied.",
      session_id: "s",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      result: "Fixed the bug; the tests should pass now.",
      session_id: "s",
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
      permission_denials: [],
      ...result,
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n";

const DENIALS = [
  { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "npm test", description: "Run the tests" } },
  { tool_name: "WebFetch", tool_use_id: "toolu_2", tool_input: { url: "https://example.com/spec", prompt: "read it" } },
  { tool_name: "mcp__github__create_issue", tool_use_id: "toolu_3", tool_input: { title: "x" } },
];

test("the decoder reads the tool calls a CLI refused from its result event (deniedPath), one line each", () => {
  const claude = defaultConfig().adapters.claude!;
  assert.deepEqual(decodeOutput(claude, claudeStream({ permission_denials: DENIALS })).denied, [
    "Bash (npm test)",
    "WebFetch (https://example.com/spec)",
    "mcp__github__create_issue",
  ]);
  assert.equal("denied" in decodeOutput(claude, claudeStream({})), false, "an empty list refused nothing");
  // Only the last result event counts, as for its text and its error.
  const twice = claudeStream({ permission_denials: DENIALS }) + JSON.stringify({ type: "result", result: "again", permission_denials: [] }) + "\n";
  assert.equal(decodeOutput(claude, twice).denied, undefined);
  // Any JSON adapter can declare where its CLI lists refusals: strings, or objects naming the tool.
  const json: Adapter = { name: "j", command: ["j"], output: { format: "json", textPath: ["text"], deniedPath: ["refused"] } };
  assert.deepEqual(decodeOutput(json, JSON.stringify({ text: "ok", refused: ["shell: rm -rf build", { name: "net", input: { url: "http://x" } }] })), {
    text: "ok",
    denied: ["shell: rm -rf build", "net (http://x)"],
  });
});

/** The permission failure of a claude agent refused `Bash (npm test)`, as its error says it. */
const REFUSED_NPM_TEST =
  "adapter 'claude' was refused a permission it needed — allow it in the adapter's permissionArgs for its tier, or switch adapter with " +
  "--adapter <name>: denied: Bash (npm test)";

test("refused tool calls: by default the reply stands and reports them; permissionDenials \"fail\", run-wide or per adapter, fails it", async () => {
  let runs = 0;
  const runner = async (): Promise<CliResult> => {
    runs++;
    return ok(claudeStream({ permission_denials: DENIALS }));
  };
  const warned = await new Bridge(config("claude"), { runner }).run({ prompt: "fix the bug" });
  assert.equal(warned.value, "Fixed the bug; the tests should pass now.");
  assert.deepEqual(warned.denied, ["Bash (npm test)", "WebFetch (https://example.com/spec)", "mcp__github__create_issue"]);
  assert.equal(runs, 1);

  const strict = config("claude");
  strict.settings.permissionDenials = "fail";
  runs = 0;
  await assert.rejects(
    new Bridge(strict, { runner }).run({ prompt: "fix the bug" }),
    (err: unknown) =>
      err instanceof AdapterExecutionError &&
      err.reason === "permission" &&
      err.message === `${REFUSED_NPM_TEST}; WebFetch (https://example.com/spec); mcp__github__create_issue`,
  );
  assert.equal(runs, 1, "a refused permission is not retried");

  // An adapter's own policy wins over the run's, either way.
  const strictAdapter = config("claude");
  strictAdapter.adapters.claude = { ...strictAdapter.adapters.claude!, permissionDenials: "fail" };
  await assert.rejects(
    new Bridge(strictAdapter, { runner }).run({ prompt: "x" }),
    (err: unknown) => err instanceof AdapterExecutionError && err.reason === "permission",
  );
  const lenientAdapter = config("claude");
  lenientAdapter.settings.permissionDenials = "fail";
  lenientAdapter.adapters.claude = { ...lenientAdapter.adapters.claude!, permissionDenials: "warn" };
  assert.equal((await new Bridge(lenientAdapter, { runner }).run({ prompt: "x" })).denied?.length, 3);

  // No refusals: nothing to report.
  const fine = await new Bridge(config("claude"), { runner: async () => ok(claudeStream({})) }).run({ prompt: "x" });
  assert.equal(fine.denied, undefined);

  // A failure the CLI reported itself is still that failure, whatever it refused on the way.
  const loggedOut = new Bridge(config("claude"), {
    runner: async () => ok(claudeStream({ is_error: true, result: "Not logged in · Please run /login", permission_denials: DENIALS })),
  });
  await assert.rejects(loggedOut.run({ prompt: "x" }), (err: unknown) => err instanceof AdapterExecutionError && err.reason === "auth");
});

test("with expect, refused tool calls are a miss: retried with them named, then a permission failure with what else was missed", async () => {
  const plan = planChecks({ expect: { match: "^Fixed" } }).expect!;
  const checks = () => new Expectations(plan, 1, { exec: async () => assert.fail("no command to run") });
  const prompts: string[] = [];
  const once = new Bridge(config("claude"), {
    runner: async (_command, options) => {
      prompts.push(options?.stdin ?? "");
      return ok(claudeStream(prompts.length === 1 ? { permission_denials: DENIALS.slice(0, 1) } : {}));
    },
  });
  const out = await once.run({ prompt: "fix it" }, { expect: checks() });
  assert.equal(out.attempts, 2);
  assert.equal(out.denied, undefined, "the work that passed went without refusals");
  assert.match(
    prompts[1]!,
    /^- no tool call may be refused, and 1 was: Bash \(npm test\)\. Those calls are not allowed here: do the task without them\.$/m,
  );

  // Still refused after its retries: a permission failure, with the rest of what it missed.
  const always = new Bridge(config("claude"), {
    runner: async () => ok(claudeStream({ permission_denials: DENIALS.slice(0, 1), result: "Working on it" })),
  });
  await assert.rejects(always.run({ prompt: "fix it" }, { expect: checks() }), (err: unknown) => {
    assert.ok(err instanceof UnmetExpectationError);
    assert.equal(err.reason, "permission");
    assert.equal(err.message, `${REFUSED_NPM_TEST} — and its work did not meet: the reply must match /^Fixed/, and it does not`);
    assert.deepEqual(err.misses, ["no tool call may be refused, and 1 was: Bash (npm test)", "the reply must match /^Fixed/, and it does not"]);
    return true;
  });
});

test("the whole stack: an agent whose CLI refused tool calls finishes — the calls on its event, record and view, said once in the log", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const flow = await runAgent({
      root,
      source: root,
      claude: true,
      adapter: { label: "Claude Code" },
      plan: [{ reply: "Fixed it.", denied: DENIALS.slice(0, 2) }],
    });
    assert.deepEqual(flow.result, { value: "Fixed it." });
    const denied = ["Bash (npm test)", "WebFetch (https://example.com/spec)"];
    assert.deepEqual(ofType(flow.events, "agent_finished")[0]!.denied, denied);
    assert.deepEqual(flow.store.readAgentResult(flow.id, 1)?.denied, denied);
    assert.deepEqual(detail(flow.store, flow.id).agents[0]!.denied, denied);
    const notes = ofType(flow.events, "log").filter((e) => Array.isArray(e.denied));
    assert.equal(notes.length, 1, "one log line for the agent");
    assert.equal(
      notes[0]!.message,
      "fixer:1: Claude Code refused 2 tool calls — Bash (npm test); WebFetch (https://example.com/spec); " +
        "its reply may rest on work it could not do (raise its tier with --permissions or allowlist the tool)",
    );
    assert.deepEqual(notes[0]!.denied, denied);

    // permissionDenials "fail" in the config fails the agent instead.
    const failed = await runAgent({
      root: root2,
      source: root2,
      claude: true,
      plan: [{ reply: "Fixed it.", denied: DENIALS.slice(0, 1) }],
      config: { permissionDenials: "fail" },
    });
    assert.match(String(failed.result.error), /was refused a permission it needed .*: denied: Bash \(npm test\)$/);
    assert.equal(ofType(failed.events, "agent_failed")[0]!.reason, "permission");
    assert.equal(ofType(failed.events, "log").filter((e) => Array.isArray(e.denied)).length, 0);
  } finally {
    cleanup(root, root2);
  }
});

test("the whole stack: with expect, a refusal is handed back to the agent once, then fails it with reason permission", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const fixed = await runAgent({
      root,
      source: root,
      claude: true,
      plan: [{ reply: "Fixed it.", denied: DENIALS.slice(0, 1) }, { reply: "Fixed it, without the shell." }],
      opts: { expect: { match: "^Fixed" } },
    });
    assert.deepEqual(fixed.result, { value: "Fixed it, without the shell." });
    assert.match(fixed.calls[1]!.feedback!, /^- no tool call may be refused, and 1 was: Bash \(npm test\)\. Those calls are not allowed here/m);
    assert.equal(ofType(fixed.events, "agent_finished")[0]!.denied, undefined);

    const refused = await runAgent({
      root: root2,
      source: root2,
      claude: true,
      plan: [{ reply: "Fixed it.", denied: DENIALS.slice(0, 1) }],
      opts: { expect: { match: "^Fixed" } },
    });
    const failed = ofType(refused.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "permission");
    assert.deepEqual(failed.misses, ["no tool call may be refused, and 1 was: Bash (npm test)"]);
    assert.equal(refused.calls.length, 2, "one retry, as for any miss");
  } finally {
    cleanup(root, root2);
  }
});

test("after a fallback, refused tool calls are said of the adapter that produced the reply, under its own permissionDenials", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const plan = [{ reply: QUOTA, exit: 1 }, { reply: "Fixed it.", denied: DENIALS.slice(0, 1) }];
    const flow = await runAgent({
      root,
      source: root,
      adapter: { label: "Primary CLI" },
      more: { backup: { claude: true, label: "Backup CLI" } },
      config: { fallback: { scripted: ["backup"] } },
      plan,
    });
    assert.deepEqual(flow.result, { value: "Fixed it." });
    const notes = ofType(flow.events, "log").filter((e) => Array.isArray(e.denied));
    assert.equal(notes.length, 1);
    assert.match(String(notes[0]!.message), /^fixer:1: Backup CLI refused 1 tool call — Bash \(npm test\); its reply may rest on/);
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.deepEqual([finished.adapter, finished.fellBackFrom, finished.denied], ["backup", ["scripted"], ["Bash (npm test)"]]);

    // The adapter it moved to fails refused calls: so does the call, there.
    const failed = await runAgent({
      root: root2,
      source: root2,
      more: { backup: { claude: true, permissionDenials: "fail" } },
      config: { fallback: { scripted: ["backup"] } },
      plan,
    });
    const event = ofType(failed.events, "agent_failed")[0]!;
    assert.deepEqual([event.reason, event.adapter, event.fellBackFrom], ["permission", "backup", ["scripted"]]);
    assert.match(String(failed.result.error), /adapter 'backup' was refused a permission it needed .*: denied: Bash \(npm test\)$/);
  } finally {
    cleanup(root, root2);
  }
});

// --- surfaces: logs, live view, resume, config ---------------------------------------------

test("odw logs and the live view show what a failed agent's work missed", async () => {
  const misses = ["a file must change, and none did", "`npm test` must exit 0, and it exited with code 1"];
  const failed: WorkflowEvent = {
    ts: 3,
    type: "agent_failed",
    agentId: 1,
    label: "fixer",
    phase: "Fix",
    error: `UnmetExpectationError: adapter 'claude' did not meet its expectations after 1 retry: ${misses.join("; ")}`,
    reason: "unmet_expectation",
    misses,
  };
  assert.equal(
    formatEvent(failed).replace(/^\[[^\]]*\] /, ""),
    "agent_failed    (Fix) fixer — [unmet_expectation] did not meet: a file must change, and none did; `npm test` must exit 0, and it exited with code 1",
  );
  assert.equal(
    formatEvent({ ...failed, reason: "empty_reply", misses: undefined, error: "AdapterExecutionError: adapter 'claude' replied with nothing" }).replace(/^\[[^\]]*\] /, ""),
    "agent_failed    (Fix) fixer — [empty_reply] AdapterExecutionError: adapter 'claude' replied with nothing",
  );
  // A finished agent whose CLI refused tool calls says which.
  const refused: WorkflowEvent = {
    ts: 3.5,
    type: "agent_finished",
    agentId: 2,
    label: "search",
    phase: "Fix",
    adapter: "claude",
    attempts: 1,
    denied: ["Bash (npm test)", "WebFetch (https://example.com/spec)"],
  };
  assert.equal(
    formatEvent(refused).replace(/^\[[^\]]*\] /, ""),
    "agent_finished  (Fix) search — refused: Bash (npm test); WebFetch (https://example.com/spec)",
  );

  const store = new RunStore(mkdtempSync(join(tmpdir(), "odw-expect-live-")));
  try {
    const runId = store.create({ script: "/tmp/never-read/wf.js", args: null, source: process.cwd(), workflowName: "fix" });
    store.updateStatus(runId, { state: "running", pid: process.pid, name: "fix" });
    for (const ev of [
      { ts: 1, type: "run_started", runId },
      { ts: 1, type: "phase_started", phase: "Fix" },
      { ts: 1, type: "agent_started", agentId: 1, label: "fixer", phase: "Fix", adapter: "claude" },
      { ts: 2, type: "command_started", commandId: 1, label: "fixer: expect", phase: "Fix", command: "npm test", forAgentId: 1 },
      { ts: 2.5, type: "command_failed", commandId: 1, label: "fixer: expect", phase: "Fix", command: "npm test", forAgentId: 1, exitCode: 1, durationMs: 500, error: "exited with code 1" },
      failed,
      { ts: 3, type: "agent_started", agentId: 2, label: "search", phase: "Fix", adapter: "claude" },
      refused,
      { ts: 4, type: "run_finished", runId },
    ]) {
      appendFileSync(store.eventsPath(runId), JSON.stringify(ev) + "\n");
    }
    store.writeResult(runId, null);
    store.updateStatus(runId, { state: "done" });
    const term = new FakeTerm(120);
    const out = { text: "", isTTY: false, write(s: string) { this.text += s; } };
    const env = { TERM: "xterm", LANG: "en_US.UTF-8" };
    assert.equal(await attachRun(store, runId, { out, err: term, live: true, pollMs: 10, signals: false, env }), 0);
    const screen = term.text();
    assert.match(screen, /✖ fixer\s+claude · expectations not met · 2\.0s\n\s+✖ a file must change, and none did\n\s+✖ `npm test` must exit 0, and it exited with code 1\n/);
    assert.doesNotMatch(screen, /UnmetExpectationError/, "the misses say it, one a line");
    assert.match(screen, /✔ search\s+claude · 0\.5s · 2 tool calls refused\n/);
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("the resume key covers expect and allowEmpty (true only), not expectRetries", () => {
  const base = resumeKey("p", {});
  assert.equal(resumeKey("p", { expectRetries: 3 }), base, "how often to retry decides nothing about the value");
  assert.equal(resumeKey("p", { allowEmpty: false }), base, "false keys like an absent option");
  assert.notEqual(resumeKey("p", { allowEmpty: true }), base);
  const checked = resumeKey("p", { expect: { command: "npm test" } });
  assert.notEqual(checked, base, "a value saved without checks was never held to them");
  assert.equal(resumeKey("p", { expect: { command: "npm test", timeout: undefined } }), checked);
  assert.notEqual(resumeKey("p", { expect: { command: "npm test", changes: true } }), checked);
});

test("expectRetries, permissionDenials and an output's deniedPath load, default, and reject malformed values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-expect-cfg-"));
  try {
    const load = (raw: Record<string, unknown>) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify(raw));
      return loadConfig(path, { quiet: true });
    };
    assert.equal(defaultConfig().settings.expectRetries, 1);
    assert.equal(load({ expectRetries: 3 }).settings.expectRetries, 3);
    assert.equal(load({ expectRetries: null }).settings.expectRetries, 1);
    assert.throws(() => load({ expectRetries: -1 }), /"expectRetries" must be a non-negative integer; got -1/);
    assert.throws(() => load({ expectRetries: "twice" }), /"expectRetries" must be a non-negative integer/);
    assert.deepEqual(collectConfigWarnings({ expectRetries: 2 }), []);

    assert.equal(defaultConfig().settings.permissionDenials, "warn");
    assert.equal(load({ permissionDenials: "fail" }).settings.permissionDenials, "fail");
    assert.equal(load({ permissionDenials: null }).settings.permissionDenials, "warn");
    assert.throws(() => load({ permissionDenials: "error" }), /"permissionDenials" must be "warn" or "fail"; got "error"/);
    assert.equal(load({ adapters: { claude: { permissionDenials: "fail" } } }).adapters.claude!.permissionDenials, "fail");
    assert.throws(
      () => load({ adapters: { claude: { permissionDenials: true } } }),
      /adapter 'claude' 'permissionDenials' must be "warn" or "fail"; got true/,
    );
    assert.deepEqual(collectConfigWarnings({ permissionDenials: "warn", adapters: { claude: { permissionDenials: "fail" } } }), []);

    const output = { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", deniedPath: ["permission_denials"] };
    assert.deepEqual(load({ adapters: { mine: { command: ["x"], output } } }).adapters.mine!.output, output);
    assert.deepEqual(collectConfigWarnings({ adapters: { mine: { command: ["x"], output } } }), []);
    assert.throws(
      () => load({ adapters: { mine: { command: ["x"], output: { ...output, deniedPath: "permission_denials" } } } }),
      /adapter 'mine' 'output\.deniedPath' must be a non-empty array of strings/,
    );
    const example = loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true });
    assert.equal(example.settings.expectRetries, 1);
    assert.equal(example.settings.permissionDenials, "warn");

    // Not even recording refusals: re-declare the built-in's output without deniedPath.
    const builtin = defaultConfig().adapters.claude!;
    const { deniedPath: _denied, ...lenient } = builtin.output as Extract<Adapter["output"], { format: "jsonl" }>;
    const adjusted = load({ adapters: { claude: { output: lenient } } }).adapters.claude!;
    assert.deepEqual(adjusted.output, lenient);
    assert.deepEqual(adjusted.command, builtin.command, "the rest of the built-in stays");
    const accepted = new Bridge(
      { ...defaultConfig(), adapters: { claude: adjusted }, settings: { ...defaultConfig().settings, defaultAdapter: "claude" } },
      { runner: async () => ok(claudeStream({ permission_denials: DENIALS })) },
    );
    const unread = await accepted.run({ prompt: "x" });
    assert.equal(unread.value, "Fixed the bug; the tests should pass now.");
    assert.equal(unread.denied, undefined);
  } finally {
    cleanup(dir);
  }
});
