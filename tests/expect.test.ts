import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { decodeOutput } from "../src/adapters/output.js";
import type { Adapter, CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { AdapterExecutionError, AgentError } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { globToRegExp, planChecks } from "../src/expect.js";
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
}): Promise<Flow> {
  const log = join(opts.root, "calls.jsonl");
  const configPath = join(opts.root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "scripted",
      ...opts.config,
      adapters: { scripted: { command: [execPath, EXPECT_AGENT, log], stdin: "{prompt}" } },
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
    timeout: 30,
  });
  assert.equal(planChecks({}).expect, null);
  assert.equal(planChecks({ expect: {} }).expect, null, "no check, nothing to check");
  assert.equal(planChecks({ expect: { command: "npm test" } }).expect?.timeout, 600, "commands get 600 s by default");
  assert.equal(planChecks({}).allowEmpty, false);

  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ expect: "changes" }, /^agent\(\): expect must be an object of checks — \{ changes\?, files\?, command\?, match\?, timeout\? \}; got a string$/],
    [{ expect: [] }, /expect must be an object of checks .*got an empty array/],
    [{ expect: { change: true } }, /^agent\(\): expect has no check "change"; use changes, files, command, match, timeout$/],
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
    assert.equal(committed.calls[0]!.cwd, source);

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

test("a reply that claims success while the CLI refused tool calls fails with reason permission, saying which", async () => {
  let runs = 0;
  const bridge = new Bridge(config("claude"), {
    runner: async () => {
      runs++;
      return ok(claudeStream({ permission_denials: DENIALS }));
    },
  });
  await assert.rejects(
    bridge.run({ prompt: "fix the bug" }),
    (err: unknown) =>
      err instanceof AdapterExecutionError &&
      err.reason === "permission" &&
      err.message ===
        "adapter 'claude' was refused a permission it needed — allow it in the adapter's permissionArgs for its tier, or switch adapter with " +
          "--adapter <name>: denied: Bash (npm test); WebFetch (https://example.com/spec); mcp__github__create_issue",
  );
  assert.equal(runs, 1, "a refused permission is not retried");

  // No refusals: the reply stands.
  const fine = new Bridge(config("claude"), { runner: async () => ok(claudeStream({})) });
  assert.equal((await fine.run({ prompt: "x" })).value, "Fixed the bug; the tests should pass now.");

  // A failure the CLI reported itself is still that failure, whatever it refused on the way.
  const loggedOut = new Bridge(config("claude"), {
    runner: async () => ok(claudeStream({ is_error: true, result: "Not logged in · Please run /login", permission_denials: DENIALS })),
  });
  await assert.rejects(loggedOut.run({ prompt: "x" }), (err: unknown) => err instanceof AdapterExecutionError && err.reason === "auth");
});

test("the whole stack: permission denials fail the agent with reason permission", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-expect-run-"));
  try {
    const stream = claudeStream({ permission_denials: DENIALS.slice(0, 1) });
    const printer = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(stream)}))`;
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultAdapter: "fake_claude",
        adapters: {
          fake_claude: {
            command: [execPath, "-e", printer],
            stdin: "{prompt}",
            output: { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", errorPath: ["is_error"], deniedPath: ["permission_denials"] },
          },
        },
      }),
    );
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\ntry { return await agent('fix it') } catch (err) { return String(err) }\n");
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.match(String(store.readResult(id)), /was refused a permission it needed .*: denied: Bash \(npm test\)$/);
    const failed = ofType(store.readEvents(id), "agent_failed")[0]!;
    assert.equal(failed.reason, "permission");
  } finally {
    cleanup(root);
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

test("expectRetries and an output's deniedPath load, default, and reject malformed values", async () => {
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

    const output = { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", deniedPath: ["permission_denials"] };
    assert.deepEqual(load({ adapters: { mine: { command: ["x"], output } } }).adapters.mine!.output, output);
    assert.deepEqual(collectConfigWarnings({ adapters: { mine: { command: ["x"], output } } }), []);
    assert.throws(
      () => load({ adapters: { mine: { command: ["x"], output: { ...output, deniedPath: "permission_denials" } } } }),
      /adapter 'mine' 'output\.deniedPath' must be a non-empty array of strings/,
    );
    const example = loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true });
    assert.equal(example.settings.expectRetries, 1);

    // The way out of the denial check: re-declare the built-in's output without deniedPath.
    const builtin = defaultConfig().adapters.claude!;
    const { deniedPath: _denied, ...lenient } = builtin.output as Extract<Adapter["output"], { format: "jsonl" }>;
    const adjusted = load({ adapters: { claude: { output: lenient } } }).adapters.claude!;
    assert.deepEqual(adjusted.output, lenient);
    assert.deepEqual(adjusted.command, builtin.command, "the rest of the built-in stays");
    const accepted = new Bridge(
      { ...defaultConfig(), adapters: { claude: adjusted }, settings: { ...defaultConfig().settings, defaultAdapter: "claude" } },
      { runner: async () => ok(claudeStream({ permission_denials: DENIALS })) },
    );
    assert.equal((await accepted.run({ prompt: "x" })).value, "Fixed the bug; the tests should pass now.");
  } finally {
    cleanup(dir);
  }
});
