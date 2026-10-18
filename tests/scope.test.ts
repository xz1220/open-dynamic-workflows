import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/adapters/config.js";
import { AgentError } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { resumeKey } from "../src/journal.js";
import { readNotes } from "../src/notes.js";
import { BEHAVIOUR_SETTINGS, runSetup } from "../src/provenance.js";
import { agentRowJson, agentRows, formatAgentTable } from "../src/runtime/agents-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { expandBraces, globsOverlap, outsideScope, planScope, ScopeLocks, scopesOverlap, waitNote } from "../src/scope.js";

// Declared scopes (ODW extension): the overlap rules between globs, the
// claims that serialize overlapping calls, and the whole stack — overlapping
// calls in a fan-out run one after the other while disjoint ones run
// together, and writes outside a scope are recorded, logged, posted to the
// notes board, failed under scopePolicy "fail" and a miss with expect — in
// place and isolated.

const SCOPE_AGENT = fileURLToPath(new URL("./fixtures/scope-agent.mjs", import.meta.url));
const EXPECT_AGENT = fileURLToPath(new URL("./fixtures/expect-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo(committed: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-scope-src-"));
  git(dir, "init", "-q");
  for (const [path, text] of Object.entries(committed)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return dir;
}

interface Flow {
  id: string;
  state: string;
  store: RunStore;
  result: unknown;
  events: WorkflowEvent[];
  /** The scope agent's log lines ("start a", "end a"), or the expect agent's calls. */
  log: string[];
}

/** Run `body` as a workflow over `source`, its default adapter the scope agent (or, with `expectAgent`, the scripted expect agent). */
async function runFlow(opts: {
  root: string;
  source: string;
  body: string;
  args?: unknown;
  config?: Record<string, unknown>;
  expectAgent?: boolean;
}): Promise<Flow> {
  const log = join(opts.root, "agent.log");
  const configPath = join(opts.root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "scripted",
      concurrency: 4,
      ...opts.config,
      adapters: { scripted: { command: [execPath, opts.expectAgent ? EXPECT_AGENT : SCOPE_AGENT, log], stdin: "{prompt}" } },
    }),
  );
  const script = join(opts.root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${opts.body}`);
  const store = new RunStore(join(opts.root, "runs"));
  const id = store.create({ script, args: opts.args ?? null, source: opts.source, configPath });
  const state = await executeRun(store.runDir(id));
  return {
    id,
    state,
    store,
    result: store.readResult(id),
    events: store.readEvents(id),
    log: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  };
}

function ofType(events: WorkflowEvent[], type: string): WorkflowEvent[] {
  return events.filter((e) => e.type === type);
}

/** The index of the first event of `type` for agent `label`. */
function at(events: WorkflowEvent[], type: string, label: string): number {
  const i = events.findIndex((e) => e.type === type && e.label === label);
  assert.notEqual(i, -1, `${label} has a ${type} event`);
  return i;
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

/** One agent() call with the expect agent: `plan` its steps, `opts` its options; returns { value } or { error }. */
function oneCall(plan: unknown[], opts: Record<string, unknown>): { body: string; args: unknown } {
  return {
    body:
      "try { return { value: await agent('Fix the bug. PLAN: ' + JSON.stringify(args.plan), args.opts) } }\n" +
      "catch (err) { return { error: String(err) } }\n",
    args: { plan, opts: { label: "fixer", ...opts } },
  };
}

// --- the overlap rules ------------------------------------------------------------

test("overlap: two literal paths overlap only when they are the same path", () => {
  assert.equal(globsOverlap("docs/parser.md", "docs/parser.md"), true);
  assert.equal(globsOverlap("./docs/parser.md", "docs/parser.md"), true, "a leading ./ is dropped");
  assert.equal(globsOverlap("docs/parser.md", "docs/lexer.md"), false);
  assert.equal(globsOverlap("src/auth", "src/auth/login.ts"), false, "a literal path is one file, as in expect");
});

test("overlap: a literal path and a glob overlap when the glob matches the path", () => {
  assert.equal(globsOverlap("src/auth/**", "src/auth/login.ts"), true);
  assert.equal(globsOverlap("src/auth/login.ts", "src/auth/**"), true, "either way round");
  assert.equal(globsOverlap("src/*.ts", "src/auth/login.ts"), false, "* does not cross a /");
  assert.equal(globsOverlap("**/login.ts", "src/auth/login.ts"), true);
  assert.equal(globsOverlap("**/login.ts", "src/auth/logout.ts"), false);
  assert.equal(globsOverlap("src/auth/login.[jt]s", "src/auth/login.ts"), true);
  assert.equal(globsOverlap("src/auth/\\*.ts", "src/auth/*.ts"), true, "an escaped * is literal");
});

test("overlap: two globs overlap when one's literal prefix starts with the other's — conservatively", () => {
  assert.equal(globsOverlap("src/auth/**", "src/auth/**"), true);
  assert.equal(globsOverlap("src/**", "src/auth/*.ts"), true);
  assert.equal(globsOverlap("src/auth/**", "src/db/**"), false);
  assert.equal(globsOverlap("src/auth/**", "src/authz/**"), false, "prefixes compare whole text, so a sibling with a longer name is apart");
  assert.equal(globsOverlap("src/auth*", "src/authz/**"), true, "when in doubt, they overlap");
  assert.equal(globsOverlap("src/*.ts", "src/*.md"), true, "the suffix is not compared: conservative");
  assert.equal(globsOverlap("**", "docs/**"), true, "** overlaps everything");
  assert.equal(globsOverlap("**/*.ts", "docs/x.md"), false, "but a literal path is still matched exactly");
});

test("overlap: {a,b} alternatives are expanded, each compared", () => {
  assert.deepEqual(expandBraces("src/{auth,db}/**"), ["src/auth/**", "src/db/**"]);
  assert.deepEqual(expandBraces("{a,b{c,d}}.ts"), ["a.ts", "bc.ts", "bd.ts"]);
  assert.deepEqual(expandBraces("x\\{a,b}.ts"), ["x\\{a,b}.ts"], "an escaped brace is no alternative");
  assert.equal(globsOverlap("src/{auth,db}/**", "src/db/schema.ts"), true);
  assert.equal(globsOverlap("src/{auth,db}/**", "src/api/**"), false);
  assert.equal(globsOverlap("{docs,src/parser}/**", "src/parser/x.ts"), true);
  assert.equal(globsOverlap("{docs,src/parser}/**", "src/lexer/**"), false);
});

test("scopesOverlap names the first overlapping pair; waitNote says it in one line", () => {
  assert.deepEqual(scopesOverlap(["docs/**", "src/auth/**"], ["src/auth/login.ts"]), ["src/auth/**", "src/auth/login.ts"]);
  assert.equal(scopesOverlap(["docs/**"], ["src/**"]), null);
  assert.equal(waitNote("fix-auth", "refactor-login", ["src/auth/**", "src/auth/**"]), "fix-auth waits for refactor-login: both declare src/auth/**");
  assert.equal(
    waitNote("fix-auth", "refactor-login", ["src/auth/login.ts", "src/auth/**"]),
    "fix-auth waits for refactor-login: fix-auth declares src/auth/login.ts, refactor-login src/auth/**",
  );
  const scope = planScope({ scope: ["src/auth/**", "docs/auth.md"] })!;
  assert.deepEqual(outsideScope(["src/auth/a.ts", "docs/auth.md", "src/db/b.ts"], scope.globs), ["src/db/b.ts"]);
});

test("scope and scopePolicy are checked when agent() is called: a misuse is a recoverable error", () => {
  assert.equal(planScope({}), null);
  assert.deepEqual(planScope({ scope: ["a/**"] })!.policy, "warn");
  assert.deepEqual(planScope({ scope: ["a/**"] }, "fail")!.policy, "fail", "the setting is the default");
  assert.deepEqual(planScope({ scope: ["a/**"], scopePolicy: "warn" }, "fail")!.policy, "warn", "the call's own wins");
  assert.deepEqual(planScope({ scope: ["a/**", "a/**"] })!.globs.map((g) => g.glob), ["a/**"]);
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ scope: "src/**" }, /scope must be a non-empty array of globs/],
    [{ scope: [] }, /scope must be a non-empty array of globs \(non-empty strings\); got an empty array/],
    [{ scope: ["src/**", ""] }, /scope must be a non-empty array/],
    [{ scope: ["/etc/**"] }, /relative to the agent's workspace/],
    [{ scope: ["src/[a"] }, /invalid glob "src\/\[a": an unclosed \[/],
    [{ scope: ["a"], scopePolicy: "block" }, /scopePolicy must be "warn" or "fail"; got "block"/],
    [{ scopePolicy: "fail" }, /scopePolicy has no effect without a scope/],
  ];
  for (const [opts, message] of bad) {
    assert.throws(() => planScope(opts), (err: unknown) => err instanceof AgentError && message.test(err.message), JSON.stringify(opts));
  }
});

// --- the claims ----------------------------------------------------------------------

test("claims: a call waits only for earlier open calls whose scope overlaps, each said once, until they release", async () => {
  const locks = new ScopeLocks();
  const signal = new AbortController().signal;
  const a = locks.claim({ agentId: 1, label: "a" }, ["src/auth/**"]);
  const b = locks.claim({ agentId: 2, label: "b" }, ["docs/**"]);
  const c = locks.claim({ agentId: 3, label: "c" }, ["src/auth/login.ts", "docs/auth.md"]);
  assert.equal(a.blocked, false);
  assert.equal(b.blocked, false, "disjoint from a");
  assert.equal(c.blocked, true);
  const order: string[] = [];
  const waited = c.wait(signal, (holder, pair) => order.push(`waits for ${holder.label}: ${pair.join(" ~ ")}`)).then(() => order.push("c goes"));
  await Promise.resolve();
  a.release();
  order.push("a released");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["waits for a: src/auth/login.ts ~ src/auth/**", "a released", "waits for b: docs/auth.md ~ docs/**"]);
  b.release();
  await waited;
  assert.deepEqual(order.slice(-1), ["c goes"]);
  // A later claim never waits for a released one.
  assert.equal(locks.claim({ agentId: 4, label: "d" }, ["src/auth/**"]).blocked, true, "c is still open");
  c.release();
  assert.equal(locks.claim({ agentId: 5, label: "e" }, ["docs/**"]).blocked, false);
});

test("claims: a stop ends a wait with its reason; the scopes that ran beside a call are its neighbours", async () => {
  const locks = new ScopeLocks();
  const stop = new AbortController();
  const a = locks.claim({ agentId: 1, label: "a" }, ["src/a/**"]);
  const b = locks.claim({ agentId: 2, label: "b" }, ["src/a/x.ts"]);
  const waiting = b.wait(stop.signal, () => {});
  stop.abort(new Error("stopped"));
  await assert.rejects(waiting, /stopped/);

  const c = locks.claim({ agentId: 3, label: "c" }, ["src/c/**"]);
  a.start();
  c.start();
  assert.deepEqual(a.neighbours().map(String), [String(/^src\/c\/.*$/)]);
  assert.deepEqual(c.neighbours().map(String), [String(/^src\/a\/.*$/)]);
  a.release();
  c.release();
  b.release();
});

// --- the whole stack: scheduling --------------------------------------------------

test("in a parallel(): overlapping scopes run one after the other, disjoint ones together, and the wait is said once", async () => {
  const src = makeRepo({ "README.md": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    const flow = await runFlow({
      root,
      source: src,
      body: `
        const task = (t) => 'Do it. TASK: ' + JSON.stringify(t)
        return await parallel([
          () => agent(task({ name: 'refactor-login', write: { 'src/auth/login.ts': 'a' }, barrier: 2 }), { label: 'refactor-login', scope: ['src/auth/**'] }),
          () => agent(task({ name: 'fix-auth', write: { 'src/auth/login.ts': 'b' } }), { label: 'fix-auth', scope: ['src/auth/**'] }),
          () => agent(task({ name: 'docs', write: { 'docs/auth.md': 'c' }, barrier: 2 }), { label: 'docs', scope: ['docs/**'] }),
        ])`,
    });
    assert.equal(flow.state, "done");
    // The two disjoint calls met at the barrier: they ran at the same time.
    assert.deepEqual(flow.result, ["together", "done", "together"]);
    const ev = flow.events;
    // The overlapping one started only once the earlier had settled.
    assert.ok(at(ev, "agent_started", "fix-auth") > at(ev, "agent_finished", "refactor-login"));
    assert.ok(at(ev, "agent_started", "docs") < at(ev, "agent_finished", "refactor-login"));
    assert.deepEqual(flow.log.slice(-2), ["start fix-auth", "end fix-auth"]);
    // One line for the wait, structured too, before the waiting agent started.
    const waits = ofType(ev, "log").filter((e) => e.scopeWait);
    assert.equal(waits.length, 1);
    assert.equal(waits[0]!.message, "fix-auth waits for refactor-login: both declare src/auth/**");
    assert.deepEqual(waits[0]!.scopeWait, { for: 1, globs: ["src/auth/**", "src/auth/**"] });
    assert.equal(waits[0]!.agentId, 2);
    assert.ok(ev.indexOf(waits[0]!) < at(ev, "agent_started", "fix-auth"));
    // The scope is on each agent's start event, and in the views.
    assert.deepEqual(ev[at(ev, "agent_started", "docs")]!.scope, ["docs/**"]);
    const docs = detail(flow.store, flow.id).agents.find((a) => a.label === "docs")!;
    assert.deepEqual(docs.scope, ["docs/**"]);
    // Writing inside its own scope is no out-of-scope write.
    assert.equal(ofType(ev, "agent_finished").some((e) => "outOfScope" in e), false);
  } finally {
    cleanup(src, root);
  }
});

test("a call without scope overlaps nothing: it runs beside a scoped one, as before", async () => {
  const src = makeRepo({ "README.md": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    const flow = await runFlow({
      root,
      source: src,
      body: `
        const task = (t) => 'Do it. TASK: ' + JSON.stringify(t)
        return await pipeline(['a', 'b'], (item) => agent(task({ name: item, barrier: 2 }), item === 'a' ? { label: item, scope: ['**'] } : { label: item }))`,
    });
    assert.equal(flow.state, "done");
    assert.deepEqual(flow.result, ["together", "together"]);
    assert.equal(ofType(flow.events, "log").some((e) => e.scopeWait), false);
  } finally {
    cleanup(src, root);
  }
});

test("in place, beside another scoped call: what changed in its scope is not counted against this one; a file in nobody's is", async () => {
  const src = makeRepo({ "README.md": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    const flow = await runFlow({
      root,
      source: src,
      body: `
        const task = (t) => 'Do it. TASK: ' + JSON.stringify(t)
        return await parallel([
          () => agent(task({ name: 'a', write: { 'src/a/x.ts': '1', 'stray.txt': '1' }, barrier: 2 }), { label: 'a', scope: ['src/a/**'] }),
          () => agent(task({ name: 'b', write: { 'src/b/y.ts': '2' }, barrier: 2 }), { label: 'b', scope: ['src/b/**'] }),
        ])`,
    });
    assert.equal(flow.state, "done");
    assert.deepEqual(flow.result, ["together", "together"]);
    const finished = ofType(flow.events, "agent_finished");
    assert.deepEqual(finished.find((e) => e.label === "a")!.outOfScope, ["stray.txt"]);
    // b's view depends on when its snapshot was taken, but a's scope is never counted against it.
    const b = finished.find((e) => e.label === "b")!;
    assert.ok(!("outOfScope" in b) || JSON.stringify(b.outOfScope) === JSON.stringify(["stray.txt"]), JSON.stringify(b.outOfScope));
  } finally {
    cleanup(src, root);
  }
});

// --- the whole stack: out-of-scope writes ------------------------------------------

test("warn (default), in place: the reply stands; the files are on the agent's event, record, views and log; notes get a note", async () => {
  const src = makeRepo({ "src/auth/login.ts": "x\n", "src/db/schema.ts": "y\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    const call = oneCall([{ write: { "src/auth/login.ts": "fixed\n", "src/db/schema.ts": "changed\n" }, reply: "fixed" }], {
      scope: ["src/auth/**"],
      notes: true,
    });
    const flow = await runFlow({ root, source: src, expectAgent: true, ...call });
    assert.equal(flow.state, "done");
    assert.deepEqual(flow.result, { value: "fixed" });
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.deepEqual(finished.outOfScope, ["src/db/schema.ts"]);
    assert.deepEqual(ofType(flow.events, "agent_started")[0]!.scope, ["src/auth/**"]);
    const line = ofType(flow.events, "log").find((e) => Array.isArray(e.outOfScope))!;
    assert.equal(
      line.message,
      'fixer:1: wrote 1 file outside its scope (src/auth/**) — src/db/schema.ts (scopePolicy: "fail" fails such an agent)',
    );
    // The saved record, the run view and odw agents.
    assert.deepEqual(flow.store.listAgentResults(flow.id)[0]!.outOfScope, ["src/db/schema.ts"]);
    assert.deepEqual(detail(flow.store, flow.id).agents[0]!.outOfScope, ["src/db/schema.ts"]);
    const rows = agentRows(flow.store, flow.id);
    const json = agentRowJson(rows[0]!);
    assert.deepEqual(json.scope, ["src/auth/**"]);
    assert.deepEqual(json.outOfScope, ["src/db/schema.ts"]);
    const table = formatAgentTable(rows, { width: 160, caps: { color: false, unicode: true } as never });
    assert.match(table[1]!, /\[outside scope: src\/db\/schema\.ts\] fixed/);
    // The notes board has it, by the agent, before it is seen to finish.
    const notes = readNotes(flow.store.runDir(flow.id));
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.kind, "scope");
    assert.deepEqual(notes[0]!.by, { agentId: 1, label: "fixer" });
    assert.equal(notes[0]!.text, "Changed 1 file outside its declared scope (src/auth/**): src/db/schema.ts");
    const added = flow.events.findIndex((e) => e.type === "note_added");
    assert.ok(added !== -1 && added < flow.events.indexOf(finished));
  } finally {
    cleanup(src, root);
  }
});

test("without notes on, no note is posted; with nothing outside its scope, nothing is said", async () => {
  const src = makeRepo({ "src/auth/login.ts": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    const flow = await runFlow({
      root,
      source: src,
      expectAgent: true,
      body: `
        const out = await agent('A. PLAN: ' + JSON.stringify([{ write: { 'other.txt': '1' } }]), { label: 'a', scope: ['src/**'] })
        const fine = await agent('B. PLAN: ' + JSON.stringify([{ write: { 'src/x.ts': '1' } }]), { label: 'b', scope: ['src/**', 'other.txt'] })
        return [out, fine]`,
    });
    assert.equal(flow.state, "done");
    assert.deepEqual(readNotes(flow.store.runDir(flow.id)), []);
    const finished = ofType(flow.events, "agent_finished");
    assert.deepEqual(finished[0]!.outOfScope, ["other.txt"]);
    assert.equal("outOfScope" in finished[1]!, false);
    assert.equal(ofType(flow.events, "log").filter((e) => Array.isArray(e.outOfScope)).length, 1);
  } finally {
    cleanup(src, root);
  }
});

test("fail: the agent fails with reason out_of_scope and the files, not retried — per call or by the setting", async () => {
  const src = makeRepo({ "src/auth/login.ts": "x\n" });
  for (const how of [{ opts: { scopePolicy: "fail" } }, { config: { scopePolicy: "fail" } }] as Array<{ opts?: Record<string, unknown>; config?: Record<string, unknown> }>) {
    const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
    try {
      git(src, "checkout", "-q", "--", ".");
      git(src, "clean", "-fdq");
      const call = oneCall([{ write: { "src/auth/login.ts": "y\n", "package.json": "{}\n" }, reply: "fixed" }], { scope: ["src/auth/**"], ...how.opts });
      const flow = await runFlow({ root, source: src, expectAgent: true, config: how.config, ...call });
      assert.equal(flow.state, "done");
      const result = flow.result as { error: string };
      assert.match(result.error, /wrote outside its scope: no file outside its scope \(src\/auth\/\*\*\) may change, and 1 did: package\.json/);
      assert.equal(flow.log.length, 1, "never retried");
      const failed = ofType(flow.events, "agent_failed")[0]!;
      assert.equal(failed.reason, "out_of_scope");
      assert.deepEqual(failed.outOfScope, ["package.json"]);
      assert.equal(detail(flow.store, flow.id).agents[0]!.failureReason, "out_of_scope");
      assert.deepEqual(detail(flow.store, flow.id).agents[0]!.outOfScope, ["package.json"]);
    } finally {
      cleanup(root);
    }
  }
  cleanup(src);
});

test("with expect: a write outside the scope is a miss — retried, told what it missed, and it passes once restored", async () => {
  const src = makeRepo({ "src/auth/login.ts": "x\n", "package.json": "{}\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    const call = oneCall(
      [
        { write: { "src/auth/login.ts": "y\n", "package.json": "{\"x\":1}\n" }, reply: "fixed" },
        { write: { "package.json": "{}\n" }, reply: "fixed in scope" },
      ],
      { scope: ["src/auth/**"], expect: { changes: true } },
    );
    const flow = await runFlow({ root, source: src, expectAgent: true, ...call });
    assert.equal(flow.state, "done");
    assert.deepEqual(flow.result, { value: "fixed in scope" });
    const calls = flow.log.map((line) => JSON.parse(line) as { feedback: string | null });
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.feedback!, /- no file outside its scope \(src\/auth\/\*\*\) may change, and 1 did: package\.json\. Those files are outside the scope you were given/);
    assert.equal("outOfScope" in ofType(flow.events, "agent_finished")[0]!, false, "the work that stands kept to its scope");
  } finally {
    cleanup(src, root);
  }
});

test("with expect: still outside its scope after the retries, it fails with unmet_expectation and the miss, warn or not", async () => {
  const src = makeRepo({ "src/auth/login.ts": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    const call = oneCall([{ write: { "src/auth/login.ts": "y\n", "notes.txt": "1\n" } }], {
      scope: ["src/auth/**"],
      scopePolicy: "warn",
      expect: { changes: true },
      expectRetries: 1,
    });
    const flow = await runFlow({ root, source: src, expectAgent: true, ...call });
    const failed = ofType(flow.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "unmet_expectation");
    assert.deepEqual(failed.misses, ["no file outside its scope (src/auth/**) may change, and 1 did: notes.txt"]);
    assert.deepEqual(failed.outOfScope, ["notes.txt"]);
    assert.equal(flow.log.length, 2);
  } finally {
    cleanup(src, root);
  }
});

test("isolated: what its worktree changed is compared with its scope — the source tree's own edits never count", async () => {
  const src = makeRepo({ "src/auth/login.ts": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    // The user's own edit outside the scope, in the source tree: not the agent's.
    writeFileSync(join(src, "wip.txt"), "draft\n");
    const call = oneCall([{ write: { "src/auth/login.ts": "y\n", "src/db/x.ts": "1\n" }, commit: "work" }], {
      scope: ["src/auth/**"],
      isolation: "worktree",
    });
    const flow = await runFlow({ root, source: src, expectAgent: true, ...call });
    assert.equal(flow.state, "done");
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.deepEqual(finished.outOfScope, ["src/db/x.ts"]);
    assert.ok(finished.changes, "its change is kept as ever");
    const failing = oneCall([{ write: { "src/db/x.ts": "1\n" } }], { scope: ["src/auth/**"], isolation: "worktree", scopePolicy: "fail" });
    const flow2 = await runFlow({ root: root2, source: src, expectAgent: true, ...failing });
    assert.equal(ofType(flow2.events, "agent_failed")[0]!.reason, "out_of_scope");
  } finally {
    cleanup(src, root, root2);
  }
});

test("outside a git repository a scope is not read: the agent runs, and the run says so", async () => {
  const src = mkdtempSync(join(tmpdir(), "odw-scope-nogit-"));
  const root = mkdtempSync(join(tmpdir(), "odw-scope-run-"));
  try {
    const call = oneCall([{ write: { "anything.txt": "1\n" }, reply: "ok" }], { scope: ["src/**"], scopePolicy: "fail" });
    const flow = await runFlow({ root, source: src, expectAgent: true, ...call });
    assert.deepEqual(flow.result, { value: "ok" });
    assert.ok(ofType(flow.events, "log").some((e) => /its writes are not checked against its scope/.test(String(e.message))));
    assert.equal("outOfScope" in ofType(flow.events, "agent_finished")[0]!, false);
  } finally {
    cleanup(src, root);
  }
});

// --- settings and provenance --------------------------------------------------------

test("scopePolicy loads, defaults to warn, rejects other values, and is in a run's recorded setup", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-scope-cfg-"));
  try {
    const file = join(dir, "odw.config.json");
    writeFileSync(file, JSON.stringify({}));
    assert.equal(loadConfig(file).settings.scopePolicy, "warn");
    writeFileSync(file, JSON.stringify({ scopePolicy: "fail" }));
    const config = loadConfig(file);
    assert.equal(config.settings.scopePolicy, "fail");
    assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("scopePolicy"));
    assert.equal(runSetup(config).settings.scopePolicy, "fail");
    writeFileSync(file, JSON.stringify({ scopePolicy: "block" }));
    assert.throws(() => loadConfig(file), /scopePolicy/);
  } finally {
    cleanup(dir);
  }
});

test("the resume key leaves scope and scopePolicy out: they schedule and judge the call, not what it was asked", () => {
  assert.equal(resumeKey("p", { label: "x" }), resumeKey("p", { label: "x", scope: ["src/**"], scopePolicy: "fail" }));
});
