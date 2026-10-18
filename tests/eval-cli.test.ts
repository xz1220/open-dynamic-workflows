/**
 * `odw eval` end to end: real runs through the launcher and worker, on fake
 * agent CLIs (tests/fixtures/eval-agent.mjs behind a shell wrapper that also
 * answers `--version`) — no model calls. The fan-out over adapters × repeats
 * with its concurrency, the report, a baseline regression, the eval's
 * timeout, usage errors and Ctrl-C. GET /api/evals: evals-api.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import type { EvalReport } from "../src/eval/report.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { summarize } from "../src/runtime/runs-view.js";

const posix = { skip: process.platform === "win32" ? "the fake CLI is a /bin/sh wrapper" : false };
const AGENT = fileURLToPath(new URL("./fixtures/eval-agent.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SUB = "eval";

/** The workflow: one agent whose prompt the case's args steer (see eval-agent.mjs). */
const ECHO = `export const meta = { name: 'echo', description: 'echo a word back' }
const prompt = (args.sleep ? 'SLEEP ' + args.sleep + ' ' : '') + (args.fail ? 'FAIL ' : '') + 'WORD ' + args.word
return await agent(prompt, {
  label: 'echo',
  schema: { type: 'object', required: ['word'], properties: { word: { type: 'string' }, len: { type: 'number' }, adapter: { type: 'string' } } },
})
`;

interface Project {
  dir: string;
  runs: string;
  store: RunStore;
  writeEval(name: string, def: unknown): string;
}

/** A project: the echo workflow, adapters a and b on the fake CLI, a runs root inside. */
async function withProject(fn: (p: Project) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "odw-eval-cli-"));
  try {
    for (const sub of [".odw/workflows", ".odw/evals", "bin"]) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, ".odw", "workflows", "echo.js"), ECHO);
    // No extension, an absolute path: odw probes it with --version, like an installed CLI.
    const wrapper = join(dir, "bin", "evalcli");
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "evalcli 9.9.9"; exit 0; fi\nexec '${execPath}' '${AGENT}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const output = { format: "json", textPath: ["text"], usagePath: ["usage"], costPath: ["cost"] };
    const adapters = Object.fromEntries(["a", "b"].map((name) => [name, { command: [wrapper, name], stdin: "{prompt}", output }]));
    writeFileSync(join(dir, "odw.config.json"), JSON.stringify({ defaultAdapter: "a", adapters }));
    const runs = join(dir, "runs");
    const writeEval = (name: string, def: unknown) => {
      const file = join(dir, ".odw", "evals", `${name}.json`);
      writeFileSync(file, JSON.stringify(def, null, 2));
      return file;
    };
    await fn({ dir, runs, store: new RunStore(runs), writeEval });
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
  // Buffers are the test runner's own messages: let them through.
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

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/** Every run in the store, with its meta and status. */
function allRuns(store: RunStore) {
  return store.listRuns().map((ref) => ({ runId: ref.runId, meta: store.readMeta(ref.runId), status: store.readStatus(ref.runId) }));
}

/** When a run ended: its end event's time (epoch seconds). */
function endedAt(store: RunStore, runId: string): number {
  const end = store.readEvents(runId).find((ev) => ev.type === "run_finished" || ev.type === "run_failed" || ev.type === "run_stopped");
  assert.ok(end && typeof end.ts === "number", `run ${runId} has an end event`);
  return end.ts as number;
}

test("odw eval: cases × adapters × repeats as real eval runs, at most `concurrency` at once, and the JSON report", posix, () =>
  withProject(async ({ dir, runs, store, writeEval }) => {
    writeEval("echo", {
      workflow: "echo",
      adapters: ["a", "b"],
      repeats: 2,
      concurrency: 2,
      cases: [
        { name: "hello", args: { word: "hello", sleep: 300 }, checks: [{ path: "word", equals: "hello" }, { path: "len", equals: 5 }, { maxCostUsd: 0.05 }] },
        { name: "bye", args: { word: "bye", sleep: 300 } },
      ],
    });
    const outFile = join(dir, "report.json");
    const r = await odw(dir, [SUB, "echo", "--runs-root", runs, "--json", "--out", outFile]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^odw eval echo: 2 cases × 2 adapters × 2 repeats = 8 runs, 2 at once · workflow echo$/m);
    assert.equal(r.err.match(/^\[\d\/8\] ✔ /gm)?.length, 8, r.err);

    const report = JSON.parse(r.out) as EvalReport;
    assert.deepEqual(Object.keys(report), [
      "version", "name", "id", "file", "description", "evalHash", "definition", "workflow", "odwVersion",
      "cliVersions", "startedAt", "finishedAt", "wallMs", "totals", "cells", "runs", "baseline",
    ]);
    assert.equal(report.version, 1);
    assert.equal(report.name, "echo");
    assert.match(report.id, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
    assert.equal(report.file, join(dir, ".odw", "evals", "echo.json"));
    assert.match(report.evalHash, /^[0-9a-f]{64}$/);
    assert.equal(report.workflow.script, join(dir, ".odw", "workflows", "echo.js"));
    assert.equal(report.workflow.sourceHash?.length, 64);
    assert.deepEqual(report.cliVersions, { a: ["evalcli 9.9.9"], b: ["evalcli 9.9.9"] }, "from the runs' cli_version events");
    assert.deepEqual(report.totals, { runs: 8, passed: 8, failed: 0, passRate: 1, costUsd: report.totals.costUsd, inputTokens: 800, outputTokens: 160 });
    assert.ok(Math.abs(report.totals.costUsd! - 0.08) < 1e-9);
    assert.deepEqual(report.cells.map((c) => `${c.adapter}/${c.case} ${c.passed}/${c.runs}`), ["a/hello 2/2", "a/bye 2/2", "b/hello 2/2", "b/bye 2/2"]);
    for (const cell of report.cells) {
      assert.deepEqual(Object.keys(cell), ["case", "adapter", "runs", "passed", "passRate", "medianMs", "costUsd", "meanCostUsd", "meanTokens", "runIds"]);
      assert.equal(cell.meanTokens, 120);
      assert.ok(cell.medianMs! >= 300, "the agent slept 300ms");
    }
    assert.deepEqual(report.runs.map((x) => `${x.adapter}/${x.case}#${x.repeat}`), [
      "a/hello#1", "a/hello#2", "a/bye#1", "a/bye#2", "b/hello#1", "b/hello#2", "b/bye#1", "b/bye#2",
    ], "in job order, whatever order they finished in");
    assert.deepEqual(Object.keys(report.runs[0]!), [
      "runId", "case", "adapter", "repeat", "state", "passed", "timedOut", "wallMs", "inputTokens", "outputTokens",
      "costUsd", "estimated", "cliVersions", "error", "failures",
    ]);
    assert.equal(report.baseline, null);

    // Each one a real run, marked as the eval's, run with its cell's adapter as the default.
    const all = allRuns(store);
    assert.equal(all.length, 8);
    for (const row of report.runs) {
      const meta = store.readMeta(row.runId);
      assert.equal(meta.origin, "eval");
      assert.deepEqual(meta.eval, { name: "echo", case: row.case, adapter: row.adapter, repeat: row.repeat });
      assert.equal(meta.adapter, row.adapter);
      assert.deepEqual(meta.args, row.case === "hello" ? { word: "hello", sleep: 300 } : { word: "bye", sleep: 300 });
      assert.equal((store.readResult(row.runId) as { adapter: string }).adapter, row.adapter, "the fake CLI that answered");
    }

    // Never more than 2 at once: a run starts only once another has ended — and 2 did overlap.
    const spans = all.map((x) => ({ start: x.meta.createdAt as number, end: endedAt(store, x.runId) }));
    const most = Math.max(...spans.map((s) => spans.filter((o) => o.start <= s.start && s.start < o.end).length));
    assert.equal(most, 2, JSON.stringify(spans));

    // Kept under the runs root, and in --out, the same report.
    const kept = join(runs, "_evals", "echo", `${report.id}.json`);
    assert.deepEqual(JSON.parse(readFileSync(kept, "utf8")), report);
    assert.deepEqual(JSON.parse(readFileSync(outFile, "utf8")), report);
    assert.match(r.err, new RegExp(`report: ${kept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(and `));

    // odw list tells them apart.
    const list = await odw(dir, ["list", "--runs-root", runs]);
    assert.equal(list.code, 0);
    assert.equal(list.out.match(/\(eval echo · (hello|bye) · [ab] #[12]\)$/gm)?.length, 8, list.out);
  }));

test("odw eval: the table, failures with their check and run id, --adapter and --repeats overriding the file", posix, () =>
  withProject(async ({ dir, runs, writeEval }) => {
    writeEval("mixed", {
      workflow: "echo",
      adapters: ["a", "b"],
      repeats: 3,
      cases: [
        { name: "ok", args: { word: "fine" }, checks: [{ path: "word", equals: "fine" }] },
        { name: "boom", args: { word: "x", fail: true } },
      ],
    });
    const r = await odw(dir, [SUB, "mixed", "--runs-root", runs, "--adapter", "b", "--repeats", "1"]);
    assert.equal(r.code, 1, "a run failed and there is no baseline");
    const lines = r.out.trimEnd().split("\n");
    assert.match(lines[0]!, /^CASE\s+ADAPTER\s+PASS\s+MEDIAN TIME\s+COST\s+MEAN COST\s+MEAN TOKENS$/);
    assert.match(lines[1]!, /^ok\s+b\s+1\/1\s+\d+\.\ds\s+\$0\.010\s+\$0\.010\s+120$/);
    assert.match(lines[2]!, /^boom\s+b\s+0\/1\s+\d+\.\ds\s+-\s+-\s+-$/);
    assert.match(r.out, /^total {2}1\/2 passed \(50%\) · cost \$0\.010 · tokens 100 in, 20 out · .* wall$/m);
    const boom = /^ {2}boom · b · #1 {2}(\S+) {2}failed$/m.exec(r.out);
    assert.ok(boom, r.out);
    assert.match(r.out, /^ {4}✖ state done: the run ended failed: .*failing on purpose/m);
    assert.match(r.err, new RegExp(`\\[2/2\\] ✖ boom · b · #1 .*${boom[1]}.*state done: the run ended failed`));
  }));

test("odw eval --baseline: a cell whose pass rate fell regressed, exit 1; nothing regressed, exit 0 even with failures", posix, () =>
  withProject(async ({ dir, runs, writeEval }) => {
    const def = (word: string) => ({
      workflow: "echo",
      cases: [
        { name: "steady", args: { word: "same" }, checks: [{ path: "word", equals: "same" }] },
        { name: "flaky", args: { word }, checks: [{ path: "word", equals: "good" }] },
      ],
    });
    writeEval("base", def("good"));
    const base = join(dir, "base.json");
    const first = await odw(dir, [SUB, "base", "--runs-root", runs, "--out", base]);
    assert.equal(first.code, 0, first.err);

    writeEval("base", def("bad"));
    const second = await odw(dir, [SUB, "base", "--runs-root", runs, "--baseline", base, "--out", join(dir, "second.json")]);
    assert.equal(second.code, 1, "flaky regressed");
    assert.match(second.out, /^against baseline base\/\S+ {2}\(its eval definition differs\)$/m);
    assert.match(second.out, /^steady\s+a\s+100% → 100%\s+0\s+.*unchanged$/m);
    assert.match(second.out, /^flaky\s+a\s+100% → 0%\s+-100pp\s+.*regressed$/m);
    assert.match(second.out, /^regressed: flaky · a$/m);
    const report = JSON.parse(readFileSync(join(dir, "second.json"), "utf8")) as EvalReport;
    assert.deepEqual(report.baseline!.regressed, [{ case: "flaky", adapter: "a" }]);
    assert.equal(report.baseline!.file, base);
    assert.deepEqual(report.baseline!.cells.map((c) => c.status), ["unchanged", "regressed"]);

    // Against the second report, the same failure is no regression: exit 0.
    const third = await odw(dir, [SUB, "base", "--runs-root", runs, "--baseline", join(dir, "second.json"), "--json"]);
    assert.equal(third.code, 0, third.err);
    const again = JSON.parse(third.out) as EvalReport;
    assert.equal(again.totals.failed, 1);
    assert.equal(again.baseline!.sameDefinition, true);
    assert.deepEqual(again.baseline!.regressed, []);
  }));

test("odw eval: a run past the eval's timeout is stopped, and fails", posix, () =>
  withProject(async ({ dir, runs, store, writeEval }) => {
    writeEval("slow", { workflow: "echo", timeout: 1, cases: [{ name: "sleepy", args: { word: "zz", sleep: 60000 } }] });
    const r = await odw(dir, [SUB, "slow", "--runs-root", runs, "--json"]);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.out) as EvalReport;
    const run = report.runs[0]!;
    assert.equal(run.state, "stopped");
    assert.equal(run.timedOut, true);
    assert.deepEqual(run.failures.map((f) => f.check), ["timeout", "state done"]);
    assert.equal(store.readStatus(run.runId).state, "stopped");
  }));

test("odw eval: usage errors exit 2 before any run starts", posix, () =>
  withProject(async ({ dir, runs, writeEval }) => {
    writeEval("ok", { workflow: "echo", cases: [{ name: "one", args: { word: "x" } }] });
    writeEval("bad", { workflow: "echo", cases: [{ name: "one", checks: [{ state: "running" }] }] });
    writeEval("nowf", { workflow: "nope", cases: [{ name: "one" }] });
    writeFileSync(join(dir, ".odw", "workflows", "broken.js"), "export const meta = { name: 'broken' }\nreturn (\n");
    writeEval("broken", { workflow: "broken", cases: [{ name: "one" }] });
    writeFileSync(join(dir, "notreport.json"), JSON.stringify({ hello: 1 }));
    const cases: Array<[string[], RegExp]> = [
      [[], /^usage: odw eval <file\|name>/],
      [["ok", "extra"], /^usage: odw eval/],
      [["missing"], /no eval named 'missing': .*missing\.json does not exist/],
      [["bad"], /odw eval: eval file .*bad\.json: cases\[0\]\.checks\[0\]\.state: must be "done", "failed" or "stopped"/],
      [["./nowhere.json"], /eval file .*nowhere\.json: no such file/],
      [["ok", "--adapter", "zzz"], /odw eval: .*zzz/],
      [["ok", "--adapter", "a,a"], /odw eval: --adapter names 'a' twice/],
      [["ok", "--repeats", "0"], /--repeats must be a whole number from 1 to 1000; got '0'/],
      [["ok", "--repeats", "2x"], /--repeats must be a whole number/],
      [["nowf"], /odw eval: .*nope/],
      [["broken"], /odw eval: workflow .*broken\.js does not load/],
      [["ok", "--baseline", join(dir, "notreport.json")], /baseline .*notreport\.json: not an odw eval report \(version undefined, expected 1\)/],
    ];
    for (const [args, message] of cases) {
      const r = await odw(dir, [SUB, ...args, "--runs-root", runs]);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
      assert.match(r.err, message, args.join(" "));
    }
    assert.equal(existsSync(runs), false, "no run was created");
  }));

test("odw eval: Ctrl-C stops the runs it started, keeps no report, and ends by the signal", posix, () =>
  withProject(async ({ dir, runs, store, writeEval }) => {
    writeEval("long", {
      workflow: "echo",
      concurrency: 2,
      repeats: 2,
      cases: [{ name: "forever", args: { word: "zz", sleep: 120000 } }],
    });
    const child = spawn(execPath, [...process.execArgv, CLI, SUB, "long", "--runs-root", runs], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)));
    try {
      const going = await until(() => {
        const live = allRuns(store).filter((r) => r.status.state === "running");
        return live.length === 2 && live.every((r) => store.readEvents(r.runId).some((ev) => ev.type === "agent_started"));
      }, 30_000);
      assert.ok(going, `two runs with their agents going: ${err}`);
      child.kill("SIGINT");
      assert.equal(await exited, "SIGINT", `odw ends by the signal it got: ${err}`);
      const ended = allRuns(store);
      assert.equal(ended.length, 2, "no run started after Ctrl-C");
      for (const run of ended) assert.equal(run.status.state, "stopped", `${run.runId} was stopped`);
      assert.match(err, /odw eval: SIGINT — stopping 2 runs it started/);
      assert.match(err, /odw eval: stopped — 2 runs started, no report kept/);
      assert.equal(existsSync(join(runs, "_evals")), false, "no report kept");
    } finally {
      child.kill("SIGKILL");
      for (const run of allRuns(store)) if (!TERMINAL_STATES.has(String(run.status.state))) store.writeControl(run.runId, "stop");
    }
  }));

test("an eval run's summary carries its eval tag; other runs have none", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-eval-tag-"));
  try {
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf' }\nreturn 1\n");
    const store = new RunStore(join(root, "runs"));
    const tagged = store.create({ script, args: null, source: root, origin: "eval", eval: { name: "e", case: "c", adapter: "a", repeat: 2 } });
    const plain = store.create({ script, args: null, source: root });
    assert.deepEqual(store.readMeta(tagged).eval, { name: "e", case: "c", adapter: "a", repeat: 2 });
    assert.equal("eval" in store.readMeta(plain), false, "meta.json is unchanged for every other run");
    assert.deepEqual(summarize(store, tagged).eval, { name: "e", case: "c", adapter: "a", repeat: 2 });
    assert.equal("eval" in summarize(store, plain), false);
    assert.equal(readdirSync(join(root, "runs", "wf")).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
