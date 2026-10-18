/**
 * `odw eval`'s pieces, without runs: the eval file's validation, dot/bracket
 * paths, each check kind, the cells, the baseline comparison and the table.
 * The end-to-end side (real runs on fake CLIs) is eval-cli.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError } from "../src/errors.js";
import {
  evalHash,
  loadEvalFile,
  lookupPath,
  parseEvalDefinition,
  parsePath,
  type EvalCheck,
  type EvalDefinition,
} from "../src/eval/definition.js";
import { describeCheck, judgeRun, type RunOutcome } from "../src/eval/judge.js";
import {
  cellsOf,
  compareToBaseline,
  formatReport,
  median,
  readReportFile,
  totalsOf,
  type EvalReport,
  type EvalRunRecord,
} from "../src/eval/report.js";
import { displayWidth } from "../src/tty.js";

const FILE = "/proj/.odw/evals/review.json";
const parse = (raw: unknown) => parseEvalDefinition(raw, FILE, "review");
const minimal = { workflow: "review", cases: [{ name: "one" }] };

// --- the eval file -------------------------------------------------------------------

test("a minimal eval file gets its defaults: one repeat, one at a time, the default adapter, { state: done }", () => {
  assert.deepEqual(parse(minimal), {
    name: "review",
    description: null,
    workflow: "review",
    cases: [{ name: "one", args: null, checks: [{ state: "done" }] }],
    adapters: null,
    repeats: 1,
    concurrency: 1,
    budget: null,
    timeout: null,
  });
});

test("a full eval file keeps every field it gave", () => {
  const def = parse({
    name: "review-v2",
    description: "the review workflow on two CLIs",
    workflow: "./wf/review.js",
    adapters: ["claude", "codex"],
    repeats: 3,
    concurrency: 2,
    budget: 50000,
    timeout: 600,
    cases: [
      {
        name: "small diff",
        args: { diff: "x" },
        checks: [
          { path: "verdict", equals: "pass" },
          { path: "findings", contains: "x" },
          { path: "summary", matches: "^ok", flags: "i" },
          { path: "findings[0].file", exists: true },
          { command: "test -s \"$ODW_RESULT\"", timeout: 10 },
          { state: "failed" },
          { maxCostUsd: 0.5 },
          { maxSeconds: 120 },
        ],
      },
    ],
  });
  assert.equal(def.name, "review-v2");
  assert.deepEqual(def.adapters, ["claude", "codex"]);
  assert.equal(def.cases[0]!.checks.length, 8);
  assert.deepEqual(def.cases[0]!.checks[2], { path: "summary", matches: "^ok", flags: "i" });
  assert.deepEqual(def.cases[0]!.checks[4], { command: "test -s \"$ODW_RESULT\"", timeout: 10 });
});

test("the eval file is validated strictly, each problem a ConfigError saying where", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /must be a JSON object; got \[\]/],
    [{ ...minimal, extra: 1 }, /unknown key 'extra' \(allowed: name, description, workflow, cases/],
    [{ cases: minimal.cases }, /workflow: must name the workflow to run/],
    [{ ...minimal, workflow: "" }, /workflow: must name/],
    [{ ...minimal, name: "a/b" }, /name: must be up to 128 letters/],
    [{ ...minimal, name: ".." }, /name: must be up to 128 letters/],
    [{ workflow: "w" }, /cases: must be a non-empty array/],
    [{ workflow: "w", cases: [] }, /cases: must be a non-empty array/],
    [{ workflow: "w", cases: ["x"] }, /cases\[0\]: must be an object/],
    [{ workflow: "w", cases: [{ name: "a", arg: 1 }] }, /cases\[0\]: unknown key 'arg' \(allowed: name, args, checks\)/],
    [{ workflow: "w", cases: [{}] }, /cases\[0\]\.name: must be a non-empty string/],
    [{ workflow: "w", cases: [{ name: "a" }, { name: "a" }] }, /cases\[1\]\.name: 'a' names two cases/],
    [{ workflow: "w", cases: [{ name: "a", checks: [] }] }, /cases\[0\]\.checks: must be a non-empty array of checks/],
    [{ ...minimal, adapters: [] }, /adapters: must be a non-empty array of adapter names/],
    [{ ...minimal, adapters: ["a", "a"] }, /adapters: names 'a' twice/],
    [{ ...minimal, adapters: ["a", 1] }, /adapters: must hold adapter names/],
    [{ ...minimal, repeats: 0 }, /repeats: must be a whole number from 1 to 1000; got 0/],
    [{ ...minimal, repeats: 1.5 }, /repeats: must be a whole number/],
    [{ ...minimal, concurrency: 65 }, /concurrency: must be a whole number from 1 to 64/],
    [{ ...minimal, budget: -1 }, /budget: must be a positive number of tokens/],
    [{ ...minimal, timeout: "10" }, /timeout: must be a positive number of seconds; got "10"/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parse(raw), (err: unknown) => err instanceof ConfigError && message.test(err.message) && err.message.startsWith(`eval file ${FILE}: `), JSON.stringify(raw));
  }
});

test("each check is validated: exactly one kind, its own keys, a valid path, regex and values", () => {
  const check = (c: unknown) => parse({ workflow: "w", cases: [{ name: "a", checks: [c] }] });
  const bad: Array<[unknown, RegExp]> = [
    ["state", /cases\[0\]\.checks\[0\]: must be a check object/],
    [{}, /names no check: give it one of equals, contains, matches, exists, command, state, maxCostUsd, maxSeconds/],
    [{ path: "a", equals: 1, contains: 1 }, /names equals and contains: a check is one of them — split it into 2 checks/],
    [{ path: "a", equals: 1, flags: "i" }, /unknown key 'flags' \(allowed: path, equals\)/],
    [{ equals: 1 }, /checks\[0\]\.path: must be a dot\/bracket path/],
    [{ path: "a..b", equals: 1 }, /checks\[0\]\.path: invalid path "a\.\.b": an empty key/],
    [{ path: "a[x]", equals: 1 }, /takes an index or a quoted key/],
    [{ path: "a[0", equals: 1 }, /an unclosed '\['/],
    [{ path: "a.", equals: 1 }, /cannot end with '\.'/],
    [{ path: "a", matches: "(" }, /checks\[0\]\.matches: is not a valid regular expression/],
    [{ path: "a", matches: 1 }, /matches: must be a regular expression, as a string/],
    [{ path: "a", matches: "x", flags: "g" }, /flags: must be regex flags out of i, m, s, u/],
    [{ path: "a", exists: "yes" }, /exists: must be true or false/],
    [{ command: "" }, /command: must be a shell command/],
    [{ command: "true", timeout: 0 }, /timeout: must be a positive number of seconds/],
    [{ state: "running" }, /state: must be "done", "failed" or "stopped"; got "running"/],
    [{ maxCostUsd: -0.1 }, /maxCostUsd: must be a non-negative number of dollars/],
    [{ maxSeconds: 0 }, /maxSeconds: must be a positive number of seconds/],
  ];
  for (const [raw, message] of bad) {
    assert.throws(() => check(raw), (err: unknown) => err instanceof ConfigError && message.test(err.message), JSON.stringify(raw));
  }
  assert.deepEqual(check({ path: "", equals: null }).cases[0]!.checks, [{ path: "", equals: null }], "\"\" is the whole result");
});

test("loadEvalFile: a missing file, bad JSON, and a file name that cannot name the eval", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-eval-file-"));
  try {
    assert.throws(() => loadEvalFile(join(dir, "none.json")), /eval file .*none\.json: no such file/);
    writeFileSync(join(dir, "bad.json"), "{ workflow: x }");
    assert.throws(() => loadEvalFile(join(dir, "bad.json")), /eval file .*bad\.json: not valid JSON/);
    writeFileSync(join(dir, "my eval.json"), JSON.stringify(minimal));
    assert.throws(() => loadEvalFile(join(dir, "my eval.json")), /its file name 'my eval' cannot name the eval .*: add a "name"/);
    writeFileSync(join(dir, "my eval.json"), JSON.stringify({ ...minimal, name: "mine" }));
    assert.equal(loadEvalFile(join(dir, "my eval.json")).name, "mine");
    writeFileSync(join(dir, "smoke.json"), JSON.stringify(minimal));
    assert.equal(loadEvalFile(join(dir, "smoke.json")).name, "smoke", "the file's name without .json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evalHash: the same definition hashes the same, whatever its key order; any change changes it", () => {
  const a = parse({ workflow: "w", repeats: 2, cases: [{ name: "x", args: { b: 1, a: 2 } }] });
  const b = parse({ cases: [{ args: { a: 2, b: 1 }, name: "x" }], repeats: 2, workflow: "w" });
  assert.match(evalHash(a), /^[0-9a-f]{64}$/);
  assert.equal(evalHash(a), evalHash(b));
  assert.notEqual(evalHash(a), evalHash({ ...a, repeats: 3 }));
});

test("the example eval (examples/evals/routing.json) is valid, and its workflow is there", () => {
  const file = fileURLToPath(new URL("../examples/evals/routing.json", import.meta.url));
  const def = loadEvalFile(file);
  assert.equal(def.name, "routing");
  assert.deepEqual(def.adapters, ["claude", "codex"]);
  assert.deepEqual(def.cases.map((c) => c.name), ["crash-is-a-bug", "export-is-a-feature", "comparison-is-a-question"]);
  const kinds = new Set(def.cases.flatMap((c) => c.checks.map((check) => describeCheck(check).split(" ")[0])));
  assert.ok(kinds.has("command") && kinds.has("maxCostUsd") && kinds.has("maxSeconds"), [...kinds].join(", "));
  assert.equal(existsSync(fileURLToPath(new URL(`../${def.workflow}`, import.meta.url))), true, "resolved from the repository root");
});

// --- paths ---------------------------------------------------------------------------

test("dot/bracket paths: keys, indexes, quoted keys, digits on arrays", () => {
  assert.deepEqual(parsePath(""), []);
  assert.deepEqual(parsePath("a.b"), ["a", "b"]);
  assert.deepEqual(parsePath("a[0].b"), ["a", 0, "b"]);
  assert.deepEqual(parsePath("[1][2]"), [1, 2]);
  assert.deepEqual(parsePath('a["x.y"].z'), ["a", "x.y", "z"]);
  assert.deepEqual(parsePath("a['odd key']"), ["a", "odd key"]);
  assert.deepEqual(parsePath('["say \\"hi\\""]'), ['say "hi"']);
  const value = { a: { b: [10, { c: null }] }, "x.y": 1 };
  assert.deepEqual(lookupPath(value, parsePath("a.b[1].c")), { found: true, value: null });
  assert.deepEqual(lookupPath(value, parsePath("a.b.0")), { found: true, value: 10 }, "a digit key indexes an array");
  assert.deepEqual(lookupPath(value, parsePath('["x.y"]')), { found: true, value: 1 });
  assert.deepEqual(lookupPath(value, parsePath("a.b[2]")), { found: false });
  assert.deepEqual(lookupPath(value, parsePath("a.toString")), { found: false }, "own keys only");
  assert.deepEqual(lookupPath("text", parsePath("length")), { found: false }, "no keys of a string");
  assert.deepEqual(lookupPath(value, []), { found: true, value });
});

// --- each check kind ---------------------------------------------------------------------

const done = (result: unknown, extra: Partial<RunOutcome> = {}): RunOutcome => ({
  runId: "20261018-120000-abcdef",
  state: "done",
  result,
  error: null,
  wallMs: 4000,
  costUsd: 0.2,
  timedOut: null,
  ...extra,
});
const ctx = { cwd: tmpdir() };
const judge = (check: EvalCheck, outcome: RunOutcome) => judgeRun([check], outcome, ctx);

test("{ path, equals }: deep equality, key order aside", async () => {
  const result = { verdict: "pass", score: { a: 1, b: [1, 2] } };
  assert.deepEqual(await judge({ path: "verdict", equals: "pass" }, done(result)), []);
  assert.deepEqual(await judge({ path: "score", equals: { b: [1, 2], a: 1 } }, done(result)), []);
  assert.deepEqual(await judge({ path: "verdict", equals: "fail" }, done(result)), [{ check: 'verdict equals "fail"', message: 'verdict is "pass"' }]);
  assert.deepEqual(await judge({ path: "missing", equals: 1 }, done(result)), [{ check: "missing equals 1", message: "missing is not in the result" }]);
  assert.deepEqual(await judge({ path: "", equals: result }, done(result)), [], '"" is the whole result');
});

test("{ path, contains }: a substring of a string, an element of an array", async () => {
  const result = { text: "all tests pass", tags: ["a", { k: 1 }] };
  assert.deepEqual(await judge({ path: "text", contains: "tests" }, done(result)), []);
  assert.deepEqual(await judge({ path: "tags", contains: { k: 1 } }, done(result)), []);
  assert.equal((await judge({ path: "text", contains: "fail" }, done(result)))[0]!.message, 'text is "all tests pass"');
  assert.match((await judge({ path: "tags", contains: "b" }, done(result)))[0]!.message, /^tags has no such element/);
  assert.match((await judge({ path: "text", contains: 1 }, done(result)))[0]!.message, /contains needs a string/);
  assert.match((await judge({ path: "tags.1", contains: "k" }, done(result)))[0]!.message, /neither a string nor an array/);
});

test("{ path, matches }: a regex over a string, or over another value's JSON", async () => {
  const result = { summary: "OK: 3 fixed", n: 42 };
  assert.deepEqual(await judge({ path: "summary", matches: "^ok", flags: "i" }, done(result)), []);
  assert.deepEqual(await judge({ path: "n", matches: "^4\\d$" }, done(result)), []);
  assert.deepEqual(await judge({ path: "summary", matches: "^ok" }, done(result)), [{ check: "summary matches /^ok/", message: 'summary is "OK: 3 fixed"' }]);
});

test("{ path, exists }: there (null counts), or — false — not there", async () => {
  const result = { a: null, list: [] };
  assert.deepEqual(await judge({ path: "a", exists: true }, done(result)), []);
  assert.deepEqual(await judge({ path: "b", exists: false }, done(result)), []);
  assert.deepEqual(await judge({ path: "list[0]", exists: true }, done(result)), [{ check: "list[0] exists", message: "list[0] is not in the result" }]);
  assert.deepEqual(await judge({ path: "a", exists: false }, done(result)), [{ check: "a does not exist", message: "a is there: null" }]);
  const failed = done(null, { state: "failed", error: "boom" });
  assert.equal((await judge({ path: "a", exists: true }, failed))[0]!.message, "a is not in the result (the run ended failed, with no result)");
});

test("{ state }: how the run ended, with its error when it failed", async () => {
  assert.deepEqual(await judge({ state: "done" }, done(1)), []);
  assert.deepEqual(await judge({ state: "failed" }, done(null, { state: "failed", error: "x" })), []);
  assert.deepEqual(await judge({ state: "done" }, done(null, { state: "failed", error: "agent crashed" })), [
    { check: "state done", message: "the run ended failed: agent crashed" },
  ]);
  assert.deepEqual(await judge({ state: "done" }, done(null, { state: "stopped" })), [{ check: "state done", message: "the run ended stopped" }]);
});

test("{ maxCostUsd } and { maxSeconds }: bounds on what the run reported; unknown fails", async () => {
  assert.deepEqual(await judge({ maxCostUsd: 0.2 }, done(1)), [], "at the bound passes");
  assert.deepEqual(await judge({ maxCostUsd: 0.1 }, done(1)), [{ check: "maxCostUsd 0.1", message: "it cost $0.2" }]);
  assert.deepEqual(await judge({ maxCostUsd: 1 }, done(1, { costUsd: null })), [
    { check: "maxCostUsd 1", message: "its cost is unknown: no agent's CLI reported one" },
  ]);
  assert.deepEqual(await judge({ maxSeconds: 4 }, done(1)), []);
  assert.deepEqual(await judge({ maxSeconds: 3 }, done(1)), [{ check: "maxSeconds 3", message: "it took 4s" }]);
  assert.deepEqual(await judge({ maxSeconds: 3 }, done(1, { wallMs: null })), [{ check: "maxSeconds 3", message: "its wall time is unknown" }]);
});

test("{ command }: exits 0 in the project directory, with ODW_RESULT (the result as JSON) and ODW_RUN_ID", { skip: process.platform === "win32" ? "POSIX shell commands" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-eval-cmd-"));
  try {
    writeFileSync(join(dir, "marker.txt"), "here");
    const outcome = done({ verdict: "pass" });
    const run = (command: string, extra: Partial<RunOutcome> = {}, timeout?: number) =>
      judgeRun([{ command, ...(timeout !== undefined ? { timeout } : {}) }], { ...outcome, ...extra }, { cwd: dir, env: { ODW_EVAL_CASE: "c1" } });
    assert.deepEqual(await run(`test -f marker.txt && grep -q '"verdict": "pass"' "$ODW_RESULT" && test "$ODW_RUN_ID" = ${outcome.runId} && test "$ODW_EVAL_CASE" = c1`), []);
    const failed = await run("echo first; echo 'why it failed' >&2; exit 3");
    assert.equal(failed.length, 1);
    assert.match(failed[0]!.check, /^command "echo first; echo/);
    assert.equal(failed[0]!.message, "exited with code 3: first | why it failed");
    assert.deepEqual(await run(`test "$(cat "$ODW_RESULT")" = null`, { state: "failed", result: null }), [], "no result: the file holds null");
    assert.deepEqual(await run("sleep 5", {}, 0.3), [{ check: 'command "sleep 5"', message: "timed out after 0.3s" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every check is judged, and a timed-out run fails besides", async () => {
  const failures = await judgeRun(
    [{ state: "done" }, { path: "x", exists: true }, { maxSeconds: 100 }],
    done(null, { state: "stopped", timedOut: 30 }),
    ctx,
  );
  assert.deepEqual(failures.map((f) => f.check), ["timeout", "state done", "x exists"]);
  assert.equal(failures[0]!.message, "still going after 30s, the eval's timeout: stopped");
  assert.equal(describeCheck({ path: "", equals: 1 }), "(result) equals 1");
});

// --- cells, totals, baseline, table -------------------------------------------------------

function record(caseName: string, adapter: string, repeat: number, passed: boolean, extra: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    runId: `20261018-1200${String(repeat).padStart(2, "0")}-${caseName.slice(0, 3).padEnd(3, "x")}${adapter.slice(0, 3).padEnd(3, "x")}`,
    case: caseName,
    adapter,
    repeat,
    state: passed ? "done" : "failed",
    passed,
    timedOut: false,
    wallMs: 1000 * repeat,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.01,
    estimated: false,
    cliVersions: { [adapter]: `${adapter} 1.0` },
    error: passed ? null : "boom",
    failures: passed ? [] : [{ check: "state done", message: "the run ended failed: boom" }],
    ...extra,
  };
}

function reportOf(runs: EvalRunRecord[], cases: string[], adapters: string[]): EvalReport {
  const def: EvalDefinition = {
    name: "review",
    description: null,
    workflow: "review",
    cases: cases.map((name) => ({ name, args: null, checks: [{ state: "done" }] })),
    adapters,
    repeats: 2,
    concurrency: 1,
    budget: null,
    timeout: null,
  };
  const { name, description, ...definition } = def;
  return {
    version: 1,
    name,
    id: "20261018-120000-aaaaaa",
    file: FILE,
    description,
    evalHash: evalHash(def),
    definition,
    workflow: { ref: "review", script: "/proj/.odw/workflows/review.js", sourceHash: "f".repeat(64) },
    odwVersion: "0.5.0",
    cliVersions: {},
    startedAt: "2026-10-18T12:00:00.000Z",
    finishedAt: "2026-10-18T12:01:00.000Z",
    wallMs: 60000,
    totals: totalsOf(runs),
    cells: cellsOf(runs, cases, adapters),
    runs,
    baseline: null,
  };
}

test("cells: pass k/n, median wall time, total and mean cost, mean tokens, in adapter then case order", () => {
  const runs = [
    record("big", "codex", 1, true, { costUsd: null, inputTokens: null, outputTokens: null }),
    record("small", "claude", 2, false, { wallMs: 5000, costUsd: 0.03 }),
    record("small", "claude", 1, true),
    record("small", "claude", 3, true, { wallMs: 2000 }),
  ];
  const cells = cellsOf(runs, ["small", "big"], ["claude", "codex"]);
  assert.deepEqual(cells.map((c) => `${c.adapter}/${c.case}`), ["claude/small", "claude/big", "codex/small", "codex/big"]);
  const small = cells[0]!;
  assert.equal(small.runs, 3);
  assert.equal(small.passed, 2);
  assert.equal(small.passRate, 2 / 3);
  assert.equal(small.medianMs, 2000);
  assert.ok(Math.abs(small.costUsd! - 0.05) < 1e-9);
  assert.ok(Math.abs(small.meanCostUsd! - 0.05 / 3) < 1e-9);
  assert.equal(small.meanTokens, 120);
  assert.deepEqual(small.runIds, [runs[2]!.runId, runs[1]!.runId, runs[3]!.runId], "in repeat order");
  const big = cells[3]!;
  assert.equal(big.costUsd, null, "no run reported a cost");
  assert.equal(big.meanTokens, null);
  assert.equal(cells[1]!.runs, 0);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.deepEqual(totalsOf(runs), { runs: 4, passed: 3, failed: 1, passRate: 0.75, costUsd: 0.05, inputTokens: 300, outputTokens: 60 });
});

test("the baseline: per-cell deltas, B − A; a fallen pass rate regressed, new and missing cells did not", () => {
  const before = reportOf(
    [record("a", "x", 1, true), record("a", "x", 2, true), record("b", "x", 1, false), record("gone", "x", 1, true)],
    ["a", "b", "gone"],
    ["x"],
  );
  const now = reportOf(
    [record("a", "x", 1, true), record("a", "x", 2, false, { costUsd: 0.05 }), record("b", "x", 1, true), record("new", "x", 1, false)],
    ["a", "b", "new"],
    ["x"],
  );
  const cmp = compareToBaseline(now.cells, now.evalHash, before, "/tmp/base.json");
  assert.equal(cmp.sameDefinition, false);
  assert.deepEqual(cmp.cells.map((c) => [c.case, c.status]), [["a", "regressed"], ["b", "improved"], ["new", "new"], ["gone", "missing"]]);
  assert.deepEqual(cmp.cells[0]!.passRate, { a: 1, b: 0.5, delta: -0.5 });
  assert.ok(Math.abs(cmp.cells[0]!.meanCostUsd.delta! - 0.02) < 1e-9);
  assert.deepEqual(cmp.cells[0]!.medianMs, { a: 1500, b: 1500, delta: 0 });
  assert.deepEqual(cmp.cells[3]!.passRate, { a: 1, b: null, delta: null });
  assert.deepEqual(cmp.regressed, [{ case: "a", adapter: "x" }]);
  assert.equal(compareToBaseline(before.cells, before.evalHash, before, "/b").sameDefinition, true);
});

test("readReportFile refuses what is not a version-1 report", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-eval-base-"));
  try {
    const file = join(dir, "base.json");
    assert.throws(() => readReportFile(file), /baseline .*base\.json: no such file/);
    writeFileSync(file, "nope");
    assert.throws(() => readReportFile(file), /not valid JSON/);
    writeFileSync(file, JSON.stringify({ version: 2 }));
    assert.throws(() => readReportFile(file), /not an odw eval report \(version 2, expected 1\)/);
    writeFileSync(file, JSON.stringify({ version: 1, name: "n", id: "i", evalHash: "h", cells: [{ case: "a" }] }));
    assert.throws(() => readReportFile(file), /a cell without case, adapter and passRate/);
    const good = reportOf([record("a", "x", 1, true)], ["a"], ["x"]);
    writeFileSync(file, JSON.stringify(good));
    assert.deepEqual(readReportFile(file), good);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const plainCaps = { color: false, unicode: true, trueColor: false } as const;
const colorCaps = { color: true, unicode: true, trueColor: false } as const;

test("the table: a row per cell, then totals, then each failure with its check and run id", () => {
  const runs = [
    record("small-diff", "claude", 1, true, { costUsd: 0.04, inputTokens: 3000, outputTokens: 1200, wallMs: 12400 }),
    record("small-diff", "claude", 2, true, { costUsd: 0.05, inputTokens: 3000, outputTokens: 1200, wallMs: 14000 }),
    record("small-diff", "codex", 1, false, { costUsd: null, inputTokens: 5000, outputTokens: 900, wallMs: 20000 }),
    record("small-diff", "codex", 2, true, { costUsd: null, inputTokens: 5000, outputTokens: 900, wallMs: 18000 }),
  ];
  const report = reportOf(runs, ["small-diff"], ["claude", "codex"]);
  const lines = formatReport(report, { caps: plainCaps as never, width: 100 });
  assert.deepEqual(lines.slice(0, 3), [
    "CASE        ADAPTER  PASS  MEDIAN TIME  COST    MEAN COST  MEAN TOKENS",
    "small-diff  claude   2/2   13.2s        $0.090  $0.045     4.2k",
    "small-diff  codex    1/2   19.0s        -       -          5.9k",
  ]);
  assert.equal(lines[4], "total  3/4 passed (75%) · cost $0.090 · tokens 16k in, 4.2k out · 1:00 wall");
  assert.deepEqual(lines.slice(6), [
    "failures",
    `  small-diff · codex · #1  ${runs[2]!.runId}  failed`,
    "    ✖ state done: the run ended failed: boom",
  ]);
  const colored = formatReport(report, { caps: colorCaps as never, width: 100 });
  assert.match(colored[1]!, /\x1b\[[0-9;]*m2\/2/, "a cell that passed every run is colored");
  for (const line of formatReport(report, { caps: plainCaps as never, width: 40 })) {
    assert.ok(displayWidth(line) <= 72, `the case column gives way on a narrow terminal: ${line}`);
  }
});

test("the table with a baseline: each cell's deltas and the cells that regressed", () => {
  const before = reportOf([record("a", "x", 1, true, { wallMs: 2000 }), record("a", "x", 2, true, { wallMs: 2000 })], ["a"], ["x"]);
  const now = reportOf([record("a", "x", 1, true, { wallMs: 3000 }), record("a", "x", 2, false, { wallMs: 3000, costUsd: 0.02 })], ["a"], ["x"]);
  now.baseline = compareToBaseline(now.cells, now.evalHash, before, "/b.json");
  const lines = formatReport(now, { caps: plainCaps as never, width: 100 });
  const at = lines.indexOf("against baseline review/20261018-120000-aaaaaa");
  assert.ok(at > 0, lines.join("\n"));
  assert.deepEqual(lines.slice(at + 1), [
    "CASE  ADAPTER  PASS RATE   Δ PASS  Δ MEAN COST  Δ MEDIAN TIME",
    "a     x        100% → 50%  -50pp   +$0.0050     +1.0s          regressed",
    "",
    "regressed: a · x",
  ]);
});
