/**
 * The dialect conformance suite (conformance/): `odw conformance` runs every
 * shipped case green on this ODW — which is how CI runs the suite — and the
 * runner around it: --case, --json, a wrong expectation failing with what it
 * missed (exit 1), a suite that breaks the format (exit 2), the judge's
 * matching rules, the mock agent, and that every case script stays in Claude
 * Code's dialect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import type { ConformanceReport } from "../src/conformance/command.js";
import { judgeCase, loadCase, loadSuite, outcomeOf, type CaseOutcome, type ConformanceCase } from "../src/conformance/suite.js";
import { checkMeta } from "../src/dual-compat.js";
import { readMetaLiteral, scanDualCompat } from "../src/loader.js";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const SUITE = join(REPO, "conformance");
const CASES = join(SUITE, "cases");
const MOCK = join(SUITE, "mock-agent.mjs");

/** `odw <argv>` in-process, its stdout and stderr captured. */
async function odw(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  // Buffers are the test runner's own messages: let them through.
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** A scratch copy of the suite to break on purpose. */
function withSuiteCopy(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "odw-conformance-suite-"));
  cpSync(SUITE, dir, { recursive: true });
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function editExpected(dir: string, name: string, edit: (raw: Record<string, unknown>) => void): void {
  const file = join(dir, "cases", name, "expected.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(raw);
  writeFileSync(file, JSON.stringify(raw, null, 2));
}

const caseNames = readdirSync(CASES).sort();

test("every shipped case passes on this ODW (odw conformance --json, exit 0)", async () => {
  const { code, out, err } = await odw(["conformance", "--json"]);
  const report = JSON.parse(out) as ConformanceReport;
  const failing = report.cases.filter((c) => !c.passed).map((c) => `${c.case}: ${c.failures.join("; ")}`);
  assert.deepEqual(failing, [], err);
  assert.equal(code, 0);
  assert.equal(report.version, 1);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.cases.map((c) => c.case), caseNames);
  assert.equal(report.passed, caseNames.length);
  // Both kinds are present, and each case says which it is.
  assert.ok(report.cases.some((c) => c.claudeCode === "documented"));
  assert.ok(report.cases.some((c) => c.claudeCode === "unspecified"));
});

test("--case picks cases by number or by name; the text report has a line per case and a total", async () => {
  const { code, out } = await odw(["conformance", "--case", "3", "--case", "01-agent-text", "--case", "03"]);
  assert.equal(code, 0);
  assert.match(out, /2 cases from /);
  assert.match(out, /01-agent-text {2}agent\(\) without a schema/);
  assert.match(out, /03-agent-failure-caught/);
  assert.doesNotMatch(out, /02-agent-schema/);
  assert.match(out, /2 passed, 0 failed\n$/);

  const unspecified = await odw(["conformance", "--case", "16"]);
  assert.equal(unspecified.code, 0);
  assert.match(unspecified.out, /16-budget-no-target \(unspecified\)/);
});

test("a case whose expectations do not hold fails with each one it missed, and the run exits 1", async () => {
  await withSuiteCopy(async (dir) => {
    editExpected(dir, "01-agent-text", (raw) => {
      raw.result = { reply: "not alpha", type: "string" };
    });
    editExpected(dir, "14-log", (raw) => {
      raw.logs = ["got gamma", "starting"]; // the right lines, the wrong order
    });
    editExpected(dir, "13-phase-names", (raw) => {
      (raw.agents as Array<Record<string, unknown>>)[3]!.phase = "Draft";
      raw.phases = ["Review", "Draft"];
    });
    editExpected(dir, "29-script-throws", (raw) => {
      raw.error = "a different message";
    });
    editExpected(dir, "04-agent-failure-uncaught", (raw) => {
      raw.state = "done";
      raw.result = "unreachable";
    });
    const { code, out } = await odw(["conformance", "--json", "--dir", dir, "--case", "1", "--case", "4", "--case", "13", "--case", "14", "--case", "29", "--case", "6"]);
    assert.equal(code, 1);
    const report = JSON.parse(out) as ConformanceReport;
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 5);
    const failures = Object.fromEntries(report.cases.map((c) => [c.case, c.failures]));
    assert.deepEqual(failures["06-parallel-order"], []);
    assert.deepEqual(failures["01-agent-text"], [
      'result: expected {"reply":"not alpha","type":"string"}, got {"reply":"alpha","type":"string"}',
    ]);
    assert.match(failures["14-log"]!.join("\n"), /^logs: expected \["got gamma","starting"\] in this order, got /);
    assert.equal(failures["13-phase-names"]!.length, 2);
    assert.match(failures["13-phase-names"]![0]!, /^phases: /);
    assert.match(failures["13-phase-names"]![1]!, /^agents: /);
    assert.match(failures["29-script-throws"]!.join("\n"), /^error: expected it to contain "a different message", got .*conformance: boom after epsilon/);
    assert.match(failures["04-agent-failure-uncaught"]!.join("\n"), /^state: expected done, got failed \(/);

    // The text report says the same, under each failing case.
    const text = await odw(["conformance", "--dir", dir, "--case", "1"]);
    assert.equal(text.code, 1);
    assert.match(text.out, /01-agent-text.*\n {6}result: expected /);
    assert.match(text.out, /0 passed, 1 failed\n$/);
  });
});

test("a reply the case's table does not hold fails its agent: a case never passes on a reply nobody wrote", async () => {
  await withSuiteCopy(async (dir) => {
    editExpected(dir, "01-agent-text", (raw) => {
      raw.mock = [{ when: "a prompt this case never sends", reply: "alpha" }];
    });
    const { code, out } = await odw(["conformance", "--json", "--dir", dir, "--case", "1"]);
    assert.equal(code, 1);
    const [only] = (JSON.parse(out) as ConformanceReport).cases;
    assert.match(only!.failures[0]!, /^state: expected done, got failed/);
  });
});

test("a suite or case that breaks the format is a usage error: exit 2, nothing runs", async () => {
  await withSuiteCopy(async (dir) => {
    const unknownCase = await odw(["conformance", "--dir", dir, "--case", "99"]);
    assert.equal(unknownCase.code, 2);
    assert.match(unknownCase.err, /no conformance case "99"/);

    editExpected(dir, "01-agent-text", (raw) => {
      raw.expectedResult = raw.result;
    });
    const unknownKey = await odw(["conformance", "--dir", dir]);
    assert.equal(unknownKey.code, 2);
    assert.match(unknownKey.err, /case 01-agent-text: expected\.json: unknown key "expectedResult"/);
    assert.equal(unknownKey.out, "");
  });
  await withSuiteCopy(async (dir) => {
    editExpected(dir, "16-budget-no-target", (raw) => {
      delete raw.notes;
    });
    const noNotes = await odw(["conformance", "--dir", dir, "--case", "1"]);
    assert.equal(noNotes.code, 2);
    assert.match(noNotes.err, /16-budget-no-target: expected\.json: an unspecified case says why in notes/);
  });
  const missing = await odw(["conformance", "--dir", join(tmpdir(), "odw-no-such-suite")]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no conformance suite at /);
  assert.equal((await odw(["conformance", "extra"])).code, 2);
});

test("expected.json validation: each field's shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-conformance-case-"));
  try {
    writeFileSync(join(dir, "x.js"), "export const meta = { name: 'x', description: 'd' }\nreturn 1\n");
    const base = { title: "t", claudeCode: "documented", sources: ["s"], mock: [], state: "done", result: 1 };
    const load = (raw: unknown) => {
      writeFileSync(join(dir, "expected.json"), JSON.stringify(raw));
      return loadCase(dir, "07-x");
    };
    assert.equal(load(base).number, 7);
    assert.equal(load(base).hasArgs, false);
    assert.equal(load({ ...base, args: null }).hasArgs, true);
    const bad: Array<[unknown, RegExp]> = [
      [{ ...base, claudeCode: "maybe" }, /claudeCode must be/],
      [{ ...base, sources: [] }, /sources must be/],
      [{ ...base, state: "stopped" }, /state must be/],
      [{ ...base, result: undefined }, /a "done" case gives its result/],
      [{ ...base, state: "failed" }, /a "failed" case has no result/],
      [{ ...base, error: "x" }, /error is a string, for a "failed" case/],
      [{ ...base, budget: 0 }, /budget must be a positive integer/],
      [{ ...base, logs: [1] }, /logs must be a list of strings/],
      [{ ...base, mock: [{ when: "a" }] }, /mock\[0\]: give exactly one of reply and fail/],
      [{ ...base, mock: [{ when: "a", fail: { exit: 0 } }] }, /mock\[0\]: fail is true or/],
      [{ ...base, mock: [{ when: "", reply: "x" }] }, /mock\[0\]: when must be a non-empty string/],
      [{ ...base, agents: [{ outcome: "skipped" }] }, /agents\[0\]: outcome must be/],
      [{ ...base, agents: [{ id: 1 }] }, /agents\[0\]: unknown key "id"/],
    ];
    for (const [raw, message] of bad) assert.throws(() => load(raw), message, JSON.stringify(raw));
    assert.throws(() => loadCase(dir, "x"), /name it NN-slug/);
    assert.throws(() => loadCase(dir, "07-y"), /no workflow script y\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the judge: logs and phases are ordered subsequences; agents match exactly, in any order, on the keys given", () => {
  const c = (over: Partial<ConformanceCase>): ConformanceCase => ({
    name: "01-x", number: 1, dir: "/", script: "/x.js", title: "t", claudeCode: "documented", sources: ["s"], notes: null,
    hasArgs: false, args: null, budget: null, mock: [], state: "done", result: { a: 1, b: [1, 2] }, error: null,
    logs: null, phases: null, agents: null, ...over,
  });
  const out: CaseOutcome = {
    state: "done",
    result: { b: [1, 2], a: 1 }, // key order aside
    error: null,
    logs: ["▸ runtime line", "one", "another runtime line", "two"],
    phases: ["A", "B"],
    agents: [
      { label: "x", phase: "A", outcome: "finished" },
      { label: "y", phase: "B", outcome: "failed" },
    ],
  };
  assert.deepEqual(judgeCase(c({}), out), []);
  assert.deepEqual(judgeCase(c({ logs: ["one", "two"], phases: ["B"] }), out), []);
  assert.equal(judgeCase(c({ logs: ["two", "one"] }), out).length, 1);
  assert.equal(judgeCase(c({ result: { a: 1, b: [2, 1] } }), out).length, 1);
  // Any order; an entry with fewer keys must not take the agent a more specific one needs.
  assert.deepEqual(judgeCase(c({ agents: [{}, { label: "x", phase: "A" }] }), out), []);
  assert.deepEqual(judgeCase(c({ agents: [{ outcome: "failed" }, { label: "x" }] }), out), []);
  // Exactly: one too few, one too many, or one that matches none.
  assert.equal(judgeCase(c({ agents: [{ label: "x" }] }), out).length, 1);
  assert.equal(judgeCase(c({ agents: [{}, {}, {}] }), out).length, 1);
  assert.equal(judgeCase(c({ agents: [{ label: "x" }, { label: "y", outcome: "finished" }] }), out).length, 1);
  assert.equal(judgeCase(c({ agents: [] }), { ...out, agents: [] }).length, 0);
  // A failed case is not judged on a result; its error by substring.
  const failed: CaseOutcome = { ...out, state: "failed", result: null, error: "Error: boom at line 3" };
  assert.deepEqual(judgeCase(c({ state: "failed", result: undefined, error: "boom" }), failed), []);
  assert.equal(judgeCase(c({ state: "failed", result: undefined, error: "bang" }), failed).length, 1);
});

test("outcomeOf pairs each agent's start with its end by agentId", () => {
  const out = outcomeOf(
    "done",
    [
      { ts: 1, type: "phase_started", phase: "P" },
      { ts: 1, type: "agent_started", agentId: 1, label: "a", phase: "P" },
      { ts: 1, type: "agent_started", agentId: 2, label: "b", phase: null },
      { ts: 2, type: "agent_failed", agentId: 2 },
      { ts: 2, type: "log", message: "hi" },
      { ts: 3, type: "agent_finished", agentId: 1 },
      { ts: 3, type: "agent_started", agentId: 3, label: "c", phase: "P" },
    ],
    42,
    null,
  );
  assert.deepEqual(out, {
    state: "done",
    result: 42,
    error: null,
    logs: ["hi"],
    phases: ["P"],
    agents: [
      { label: "a", phase: "P", outcome: "finished" },
      { label: "b", phase: null, outcome: "failed" },
      { label: "c", phase: "P", outcome: "running" },
    ],
  });
});

test("the mock agent answers from its table: the first entry whose `when` occurs, a failure, or exit 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-conformance-mock-"));
  try {
    const table = join(dir, "table.json");
    writeFileSync(
      table,
      JSON.stringify([
        { when: "word alpha", reply: "alpha" },
        { when: "alpha", reply: "never: an earlier entry matched" },
        { when: "object", reply: { n: 1 } },
        { when: "broken", fail: { exit: 7, stderr: "it broke" } },
        { when: "simply", fail: true },
      ]),
    );
    const ask = (prompt: string) => spawnSync(execPath, [MOCK, table], { input: prompt, encoding: "utf8" });
    assert.deepEqual([ask("say the word alpha please").stdout, ask("say the word alpha please").status], ["alpha", 0]);
    assert.equal(ask("an object, please").stdout, '{"n":1}');
    const broken = ask("this is broken");
    assert.deepEqual([broken.status, broken.stderr.trim()], [7, "it broke"]);
    assert.equal(ask("simply fail").status, 1);
    const none = ask("nothing matches this");
    assert.equal(none.status, 3);
    assert.match(none.stderr, /no table entry matches the prompt: "nothing matches this"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every case is Claude Code dialect only: no ODW extension, a pure meta wherever the case loads, sources that exist", () => {
  const cases = loadSuite(SUITE);
  assert.equal(cases.length, caseNames.length);
  // agent() options and phase() options that only ODW reads.
  const odwOnly = /\b(adapter|keep|permissions|expect|expectRetries|allowEmpty)\s*:/;
  for (const c of cases) {
    for (const file of readdirSync(c.dir).filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(join(c.dir, file), "utf8");
      const where = `${c.name}/${file}`;
      assert.deepEqual(scanDualCompat(source), [], `${where}: not portable to Claude Code`);
      assert.doesNotMatch(source, odwOnly, `${where}: uses an ODW-only option`);
      assert.doesNotMatch(source, /(?<![\w$.])(exec|checkpoint|validate)\s*\(/, `${where}: calls an ODW-only global`);
      assert.doesNotMatch(source, /\bphase\([^()]*,/, `${where}: phase() options are an ODW extension`);
      // A case that loads has a pure meta whose phases name titles only.
      if (c.state === "done") {
        const meta = checkMeta(source);
        assert.ok(meta.pure, `${where}: ${meta.reason}`);
        const phases = (readMetaLiteral(source)?.phases ?? []) as Array<Record<string, unknown>>;
        for (const p of phases) assert.deepEqual(Object.keys(p).filter((k) => k !== "title" && k !== "detail"), [], where);
      }
    }
    for (const source of c.sources) {
      assert.ok(existsSync(join(REPO, source.split(/[#\s]/)[0]!)), `${c.name}: source ${source} does not exist`);
    }
  }
});

test("the suite's README lists every case with its title and status", () => {
  const readme = readFileSync(join(SUITE, "README.md"), "utf8");
  for (const c of loadSuite(SUITE)) {
    assert.ok(readme.includes(`| [${c.name}](cases/${c.name}/) | ${c.title} | ${c.claudeCode} |`), `README.md: no row for ${c.name}`);
  }
});
