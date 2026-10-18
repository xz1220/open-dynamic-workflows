/**
 * `odw test`, `odw run --record` and `odw run --dry` (ODW extensions; src/wftest/):
 * real runs — worker, scheduler, bridge, run store — whose agents are answered
 * by the built-in mock, never a model. Every reply kind, unscripted agents,
 * the checks, recording a real run (on a fake CLI) and replaying it, a dry run
 * with schemas (its placeholders valid), and the exit codes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED } from "../src/events.js";
import { RunStore } from "../src/runtime/run-store.js";
import { summarize } from "../src/runtime/runs-view.js";
import { validate, type JsonSchema } from "../src/schema.js";
import { parseTestFile } from "../src/wftest/definition.js";
import { DRY_REPLY } from "../src/wftest/mock.js";
import { placeholderFor } from "../src/wftest/placeholder.js";
import { scriptedResponder } from "../src/wftest/run.js";
import type { TestReport } from "../src/wftest/command.js";

const posix = { skip: process.platform === "win32" ? "the fake CLI is a node script run with POSIX paths" : false };

interface Project {
  dir: string;
  runs: string;
  store: RunStore;
  workflow(name: string, source: string): void;
  tests(name: string, def: unknown): string;
}

/** A project: .odw/workflows, .odw/tests, a config whose only adapter is a fake CLI, a runs root inside. */
async function withProject(fn: (p: Project) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-wftest-")));
  try {
    for (const sub of [".odw/workflows", ".odw/tests"]) mkdirSync(join(dir, sub), { recursive: true });
    // The fake CLI a recorded run uses: `REPLY <json>` in the prompt is its reply; `FAIL` exits 1.
    const fake = join(dir, "fake-agent.mjs");
    writeFileSync(
      fake,
      `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  if (/\\bFAIL\\b/.test(input)) { process.stderr.write("failing on purpose\\n"); process.exit(1); }
  const m = input.match(/REPLY (.*)/);
  process.stdout.write(m ? m[1] : "plain text");
});
`,
    );
    writeFileSync(join(dir, "odw.config.json"), JSON.stringify({ defaultAdapter: "fake", recordVersions: false, concurrency: 4, adapters: { fake: { command: [execPath, fake], stdin: "{prompt}" } } }));
    const runs = join(dir, "runs");
    await fn({
      dir,
      runs,
      store: new RunStore(runs),
      workflow: (name, source) => writeFileSync(join(dir, ".odw", "workflows", `${name}.js`), source),
      tests: (name, def) => {
        const file = join(dir, ".odw", "tests", `${name}.json`);
        writeFileSync(file, typeof def === "string" ? def : JSON.stringify(def, null, 2));
        return file;
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `odw <argv>` in-process from `cwd`, its stdout and stderr captured. */
async function odw(cwd: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  const was = process.cwd();
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  process.chdir(cwd);
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.chdir(was);
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** Each agent of a run: label, outcome, failure reason, attempts, finish order. */
function agentsOf(store: RunStore, runId: string) {
  const agents = new Map<number, { label: string; outcome: string; reason?: string; attempts?: number; order?: number }>();
  let finished = 0;
  for (const ev of store.readEvents(runId)) {
    const id = ev.agentId as number;
    if (ev.type === AGENT_STARTED) agents.set(id, { label: String(ev.label), outcome: "running" });
    if (ev.type === AGENT_FINISHED) Object.assign(agents.get(id)!, { outcome: "finished", attempts: ev.attempts, order: ++finished });
    if (ev.type === AGENT_FAILED) Object.assign(agents.get(id)!, { outcome: "failed", reason: ev.reason, order: ++finished });
  }
  return [...agents.values()];
}

const OK_SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };

/** A workflow that runs one agent per reply kind, each caught, and returns what each gave. */
const KINDS = `export const meta = { name: 'kinds', description: 'one agent per reply kind' }
const S = ${JSON.stringify(OK_SCHEMA)}
const one = async (label, opts = {}) => { try { return await agent('task for ' + label, { label, ...opts }) } catch (e) { return 'failed' } }
phase('Text')
const text = await one('text')
const json = await one('json', { schema: S })
const missed = await one('missed', { schema: S })
const dry = await one('dry', { schema: S })
const plain = await one('plain-dry')
phase('Fail')
const fails = {}
for (const kind of ['rate_limit', 'quota', 'auth', 'permission', 'timeout', 'not_found', 'exit']) fails[kind] = await one('fail:' + kind)
const empty = await one('empty')
phase('Slow')
const order = []
await parallel([
  async () => { await one('slow'); order.push('slow') },
  async () => { await one('fast'); order.push('fast') },
])
log('kinds done')
return { text, json, missed, dry, plain, fails, empty, order }
`;

test("odw test: every reply kind, answered by the mock in a real run", posix, () =>
  withProject(async ({ dir, runs, store, workflow, tests }) => {
    workflow("kinds", KINDS);
    tests("kinds", {
      cases: [
        {
          name: "kinds",
          replies: [
            { label: "text", reply: "hello" },
            { label: "json", reply: { ok: true } },
            { label: "missed", reply: { ok: true }, schemaMiss: 1 },
            { label: "dry", dry: true },
            { label: "plain-dry", dry: true },
            ...["rate_limit", "quota", "auth", "permission", "timeout", "not_found", "exit"].map((kind) => ({ label: `fail:${kind}`, fail: kind })),
            { label: "empty", empty: true },
            { label: "slow", reply: "s", delayMs: 300 },
            { label: "fast", reply: "f" },
          ],
          expect: {
            checks: [
              { path: "text", equals: "hello" },
              { path: "json", equals: { ok: true } },
              { path: "missed", equals: { ok: true } },
              { path: "dry", equals: { ok: false } },
              { path: "plain", equals: DRY_REPLY },
              { path: "fails.quota", equals: "failed" },
              { path: "empty", equals: "failed" },
              { path: "order", equals: ["fast", "slow"] },
              { maxCostUsd: 0 },
            ],
            agents: { count: 15 },
            logs: ["a test run", "kinds done"],
          },
        },
      ],
    });
    const r = await odw(dir, ["test", "kinds", "--runs-root", runs]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /✔ kinds {2}15 agents/);
    assert.match(r.out, /1 passed · no model called, \$0/);

    const [ref] = store.listRuns();
    const agents = agentsOf(store, ref!.runId);
    const by = (label: string) => agents.find((a) => a.label === label)!;
    assert.equal(by("missed").attempts, 2, "the schema miss was retried once");
    for (const kind of ["rate_limit", "quota", "auth", "permission", "timeout", "not_found"]) assert.equal(by(`fail:${kind}`).reason, kind, kind);
    assert.equal(by("fail:exit").reason, "exit");
    assert.equal(by("empty").reason, "empty_reply");
    assert.ok(by("fast").order! < by("slow").order!, "the delayed reply finished last");
    assert.equal(store.readMeta(ref!.runId).origin, "test");
  }));

test("odw test: an unscripted agent fails the case — unless a default answers it", posix, () =>
  withProject(async ({ dir, workflow, tests }) => {
    workflow("two", `export const meta = { name: 'two', description: 'two agents' }
phase('Work')
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return a + b
`);
    tests("two", {
      cases: [
        { name: "b unscripted", replies: [{ label: "a", reply: "A" }], expect: { state: "failed" } },
        { name: "default answers b", replies: [{ label: "a", reply: "A" }], default: { reply: "B" }, expect: { checks: [{ path: "", equals: "AB" }] } },
      ],
    });
    const r = await odw(dir, ["test", "two"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✖ b unscripted/);
    assert.match(r.out, /replies: unscripted agent `b` \(agent #2, phase Work\)/);
    assert.match(r.out, /✔ default answers b/);
    assert.match(r.out, /1 passed, 1 failed/);

    // A file-level default answers every case's unscripted agents.
    tests("two", { default: { reply: "Z" }, cases: [{ name: "all default", expect: { checks: [{ path: "", equals: "ZZ" }] } }] });
    assert.equal((await odw(dir, ["test", "two"])).code, 0);
  }));

test("odw test: checks, agents, logs and errors that miss fail the case, each named; --case and --json", posix, () =>
  withProject(async ({ dir, workflow, tests }) => {
    workflow("echo", `export const meta = { name: 'echo', description: 'echo' }
const r = await agent('say something', { label: 'speaker', schema: { type: 'object', required: ['word'], properties: { word: { type: 'string' } } } })
log('said ' + r.word)
if (args?.boom) throw new Error('boom: ' + r.word)
return { word: r.word, words: [r.word] }
`);
    tests("echo", {
      cases: [
        {
          name: "passes",
          replies: [{ label: "speak*", reply: { word: "hi" } }],
          expect: {
            checks: [{ path: "word", equals: "hi" }, { path: "words", contains: "hi" }, { path: "word", matches: "^h" }, { path: "nope", exists: false }, { state: "done" }],
            agents: { count: 1, labels: ["speaker"] },
            logs: ["said hi"],
          },
        },
        {
          name: "misses",
          replies: [{ prompt: "say some", reply: { word: "yo" } }],
          expect: { checks: [{ path: "word", equals: "hi" }], agents: { count: 2, labels: ["other"] }, logs: ["said hi"] },
        },
        { name: "fails as expected", args: { boom: true }, replies: [{ phase: "*", reply: { word: "x" } }, { adapter: "fake", reply: { word: "x" } }], expect: { state: "failed", error: "boom: x" } },
      ],
    });
    const r = await odw(dir, ["test", "echo"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✔ passes/);
    assert.match(r.out, /✖ misses/);
    assert.match(r.out, /word equals "hi": word is "yo"/);
    assert.match(r.out, /agents count 2: 1 agent started/);
    assert.match(r.out, /agents labels \["other"\]: the agents were \["speaker"\]/);
    assert.match(r.out, /logs \["said hi"\]: no log line \(in order\) contains "said hi"/);
    assert.match(r.out, /✔ fails as expected/);

    const one = await odw(dir, ["test", "echo", "--case", "1", "--case", "fails as expected", "--json"]);
    assert.equal(one.code, 0, one.out + one.err);
    const report = JSON.parse(one.out) as TestReport;
    assert.equal(report.version, 1);
    assert.deepEqual(report.cases.map((c) => [c.case, c.passed, c.state]), [["passes", true, "done"], ["fails as expected", true, "failed"]]);
    assert.equal(report.runsRoot, null, "the scratch runs are gone");
  }));

test("odw test: exit 2 for usage errors — nothing runs", () =>
  withProject(async ({ dir, workflow, tests }) => {
    assert.match((await odw(dir, ["test"])).err, /no tests to run/);
    assert.equal((await odw(dir, ["test"])).code, 2);
    assert.equal((await odw(dir, ["test", "nothing"])).code, 2);
    assert.equal((await odw(dir, ["test", "missing.json"])).code, 2);
    assert.equal((await odw(dir, ["test", "a", "b"])).code, 2);
    assert.equal((await odw(dir, ["test", "--bogus"])).code, 2);
    tests("bad", "{ not json");
    assert.match((await odw(dir, ["test", "bad"])).err, /not valid JSON/);
    workflow("ok", `export const meta = { name: 'ok', description: 'ok' }\nreturn 1\n`);
    tests("ok", { cases: [{ name: "c", replies: [{ label: "x", reply: 1, fail: "exit" }] }] });
    const two = await odw(dir, ["test", "ok"]);
    assert.equal(two.code, 2);
    assert.match(two.err, /cases\[0\]\.replies\[0\]: gives reply and fail/);
    tests("ok", { cases: [{ name: "c" }] });
    assert.equal((await odw(dir, ["test", "ok", "--case", "9"])).code, 2);
    assert.equal((await odw(dir, ["test", "ok"])).code, 0);
    tests("ok", { workflow: "no-such-workflow", cases: [{ name: "c" }] });
    assert.equal((await odw(dir, ["test", "ok"])).code, 2);
  }));

test("the test file is validated strictly, each problem named where it is", () => {
  const bad = (raw: unknown, pattern: RegExp) => assert.throws(() => parseTestFile(raw, "/x/wf.json"), pattern);
  bad({ cases: [] }, /cases: must be a non-empty array/);
  bad({ cases: [{ name: "a" }], extra: 1 }, /unknown key 'extra'/);
  bad({ cases: [{ name: "a" }, { name: "a" }] }, /'a' names two cases/);
  bad({ cases: [{ name: "a", replies: [{ reply: 1 }] }] }, /names no agent/);
  bad({ cases: [{ name: "a", replies: [{ label: "x" }] }] }, /says no reply/);
  bad({ cases: [{ name: "a", replies: [{ label: "x", fail: "nope" }] }] }, /fail: must be one of rate_limit, quota/);
  bad({ cases: [{ name: "a", replies: [{ label: "x", fail: "exit", schemaMiss: 1 }] }] }, /schemaMiss: goes with reply or dry/);
  bad({ cases: [{ name: "a", replies: [{ label: "x", empty: false }] }] }, /empty: must be true/);
  bad({ default: { label: "x", reply: 1 }, cases: [{ name: "a" }] }, /default: unknown key 'label'/);
  bad({ cases: [{ name: "a", expect: { state: "ok" } }] }, /expect\.state: must be "done", "failed" or "stopped"/);
  bad({ cases: [{ name: "a", expect: { checks: [{ path: "x" }] } }] }, /checks\[0\]: names no check/);
  bad({ cases: [{ name: "a", expect: { agents: { count: -1 } } }] }, /agents\.count: must be a whole number/);
  bad({ cases: [{ name: "a", checkpoints: "maybe" }] }, /checkpoints: must be "approve" or "reject"/);
  const ok = parseTestFile({ cases: [{ name: "a", args: { x: 1 } }] }, "/x/wf.json");
  assert.equal(ok.workflow, "wf");
  assert.deepEqual(ok.cases[0]!.expect, { state: "done", error: null, checks: [], agents: null, logs: null });
  assert.equal(ok.cases[0]!.timeout, 120);
});

test("scripted replies: first match wins; globs; once entries answer one agent each, all its attempts", () => {
  const unscripted: string[] = [];
  const respond = scriptedResponder(
    {
      replies: [
        { label: "verify:*", phase: "Verify", reply: "v1", once: true },
        { label: "verify:*", phase: "Verify", reply: "v2", once: true },
        { label: "review:?", reply: { n: 1 } },
        { prompt: "needle", reply: "found" },
      ],
      default: null,
    },
    unscripted,
  );
  const call = (agentId: number, label: string, phase: string | null, prompt = "p", attempt = 1) =>
    respond({ agentId, label, phase, adapter: "mock", model: null, prompt, schema: null, attempt });
  assert.deepEqual(call(1, "verify:a", "Verify"), { text: "v1" });
  assert.deepEqual(call(1, "verify:a", "Verify", "p", 2), { text: "v1" }, "a retry keeps its entry");
  assert.deepEqual(call(2, "verify:b", "Verify"), { text: "v2" });
  assert.ok("unscripted" in call(3, "verify:c", "Verify"), "both once entries are used up");
  assert.ok("unscripted" in call(4, "verify:a", "Review"), "the phase must match too");
  assert.deepEqual(call(5, "review:x", null), { text: '{"n":1}' });
  assert.ok("unscripted" in call(6, "review:xy", null), "? is one character");
  assert.deepEqual(call(7, "other", null, "a needle here"), { text: "found" });
  assert.deepEqual(unscripted, ["unscripted agent `verify:c` (agent #3, phase Verify)", "unscripted agent `verify:a` (agent #4, phase Review)", "unscripted agent `review:xy` (agent #6)"]);
});

test("placeholders: the smallest value each schema accepts, valid against it", () => {
  const schemas: Array<[JsonSchema, unknown]> = [
    [{ type: "string" }, ""],
    [{ type: "string", minLength: 3 }, "xxx"],
    [{ type: "string", format: "date-time" }, "1970-01-01T00:00:00Z"],
    [{ type: "integer", minimum: 5 }, 5],
    [{ type: "number", exclusiveMinimum: 0 }, 1],
    [{ type: "integer", exclusiveMinimum: 2.5, multipleOf: 2 }, 4],
    [{ type: "number", maximum: -3 }, -3],
    [{ type: "boolean" }, false],
    [{ type: "null" }, null],
    [{ type: ["null", "string"] }, ""],
    [{ enum: ["high", "low"] }, "high"],
    [{ const: { a: 1 } }, { a: 1 }],
    [{ type: "array", items: { type: "number" }, minItems: 2 }, [0, 0]],
    [{ type: "array", items: { type: "string" } }, []],
    [
      { type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "array", items: { type: "object", required: ["c"], properties: { c: { enum: [1, 2] } } }, minItems: 1 }, opt: { type: "string" } } },
      { a: "", b: [{ c: 1 }] },
    ],
    [{ anyOf: [{ type: "number" }, { type: "string" }] }, 0],
    [{ allOf: [{ type: "object", required: ["x"], properties: { x: { type: "string" } } }, { required: ["y"], properties: { y: { type: "integer", minimum: 1 } } }] }, { x: "", y: 1 }],
    [{ type: "object", required: ["node"], properties: { node: { $ref: "#/$defs/node" } }, $defs: { node: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } }, { node: { id: "" } }],
  ];
  for (const [schema, expected] of schemas) {
    const value = placeholderFor(schema);
    assert.deepEqual(value, expected, JSON.stringify(schema));
    if (typeof schema.type === "string" || schema.enum) assert.deepEqual(validate(value, schema), [], JSON.stringify(schema));
  }
});

/** A workflow whose agents the fake CLI answers from their prompts: two reviewers share a label. */
const RECORDABLE = `export const meta = { name: 'recordable', description: 'record me', phases: [{ title: 'Plan' }, { title: 'Review' }] }
const S = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'string' } } } }
phase('Plan')
const plan = await agent('plan it. REPLY {"items":["a","b"]}', { label: 'plan', schema: S })
phase('Review')
const reviews = await parallel(plan.items.map((item) => () => agent('review ' + item + '. REPLY verdict-' + item, { label: 'review' })))
let failed = 'no'
try { await agent('FAIL now', { label: 'flaky' }) } catch { failed = 'yes' }
log('reviewed ' + reviews.join(','))
return { plan, reviews, failed }
`;

test("odw run --record keeps a real run as a test case, and odw test replays it for $0", posix, () =>
  withProject(async ({ dir, runs, store, workflow }) => {
    workflow("recordable", RECORDABLE);
    // A secret the run's environment holds is redacted from what is recorded (here: its input).
    process.env.ODW_WFTEST_API_KEY = "placeholder-not-a-real-value-0123";
    const r = await odw(dir, ["run", "recordable", "--record", "--wait", "--runs-root", runs, "--args", '{"x":1,"key":"placeholder-not-a-real-value-0123"}']).finally(
      () => delete process.env.ODW_WFTEST_API_KEY,
    );
    assert.equal(r.code, 0, r.err);
    const file = join(dir, ".odw", "tests", "recordable.json");
    assert.match(r.err, /recording: once \S+ ends, it is a case of .*recordable\.json/);
    const [ref] = store.listRuns();
    // The worker writes the fixture once the run is on disk; --wait returns when the state is terminal.
    const deadline = Date.now() + 10_000;
    while (!existsSync(file) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(fixture.workflow, "recordable");
    const c = fixture.cases[0];
    assert.equal(c.name, `recorded ${ref!.runId}`);
    assert.equal(c.args.x, 1);
    assert.doesNotMatch(JSON.stringify(fixture), /placeholder-not-a-real-value-0123/);
    assert.match(c.args.key, /redacted/);
    assert.deepEqual(c.replies, [
      { label: "plan", phase: "Plan", reply: { items: ["a", "b"] } },
      { label: "review", phase: "Review", reply: "verdict-a", once: true },
      { label: "review", phase: "Review", reply: "verdict-b", once: true },
      { label: "flaky", phase: "Review", fail: "exit" },
    ]);
    assert.deepEqual(c.expect, {
      state: "done",
      checks: [{ path: "", equals: { plan: { items: ["a", "b"] }, reviews: ["verdict-a", "verdict-b"], failed: "yes" } }],
      agents: { count: 4 },
    });

    // The fake CLI is gone: the replay calls no CLI at all.
    rmSync(join(dir, "fake-agent.mjs"));
    const replay = await odw(dir, ["test", "recordable"]);
    assert.equal(replay.code, 0, replay.out + replay.err);
    assert.match(replay.out, /✔ recorded \S+ {2}4 agents/);

    // --record-to another file; recording the same file again appends a case.
    const other = join(dir, "fixtures", "r.json");
    writeFileSync(join(dir, "fake-agent.mjs"), `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write('{"items":[]}'));`);
    const again = await odw(dir, ["run", "recordable", "--record", "--record-to", other, "--wait", "--runs-root", runs]);
    assert.equal(again.code, 0, again.err);
    const until = Date.now() + 10_000;
    while (!existsSync(other) && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
    assert.equal(JSON.parse(readFileSync(other, "utf8")).cases.length, 1);
  }));

test("odw run --dry: stub replies (schema placeholders), the phase tree, dry: true in meta and summary — no CLI runs", posix, () =>
  withProject(async ({ dir, runs, store, workflow }) => {
    workflow("recordable", RECORDABLE);
    // No adapter could run: the fake CLI is gone.
    rmSync(join(dir, "fake-agent.mjs"));
    const r = await odw(dir, ["run", "recordable", "--dry", "--wait", "--runs-root", runs]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { plan: { items: [] }, reviews: [], failed: "no" });
    assert.match(r.err, /dry run \S+ done: 2 agents started, no model called \(\$0\)/);
    assert.match(r.err, /├─ Plan · 1 agent\n {2}│ {2}└─ plan\n {2}└─ Review · 1 agent\n {5}└─ flaky/);
    const [ref] = store.listRuns();
    assert.equal(store.readMeta(ref!.runId).dry, true);
    assert.equal(summarize(store, ref!.runId).dry, true);
    for (const agent of agentsOf(store, ref!.runId)) assert.equal(agent.outcome, "finished", agent.label);

    assert.equal((await odw(dir, ["run", "recordable", "--dry", "--detach"])).code, 2);
    assert.equal((await odw(dir, ["run", "recordable", "--dry", "--record"])).code, 2);
    assert.equal((await odw(dir, ["run", "recordable", "--record-to", "x.json"])).code, 2);
  }));

test("examples/tests/review-swarm.json passes against examples/review-swarm.js", () =>
  withProject(async ({ dir, runs }) => {
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const r = await odw(repo, ["test", "examples/tests/review-swarm.json", "--runs-root", runs, "--config", join(dir, "odw.config.json")]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.doesNotMatch(r.out, /✖/);
  }));
