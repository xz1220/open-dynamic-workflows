import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";
import { WorkflowScriptError } from "../src/errors.js";
import { checkInput, describeInput, InputSchemaError, inputProblems } from "../src/input-schema.js";
import { loadWorkflowScript } from "../src/loader.js";
import { startRun, startRunFromSource, waitFor } from "../src/runtime/launcher.js";

// meta.input (ODW extension; src/input-schema.ts): a workflow's args checked
// against its schema before the run exists — every path at fault named, an
// array or object that arrived as a string of JSON called out as encoded
// twice (anthropics/claude-code#69206) and never decoded quietly.

const INPUT = {
  type: "object",
  properties: {
    repos: { type: "array", items: { type: "string" }, minItems: 1, description: "owner/name of each" },
    mode: { enum: ["fast", "deep"], default: "fast" },
    depth: { type: "integer" },
  },
  required: ["repos"],
  additionalProperties: false,
};
const WF = `export const meta = { name: 'triage', description: 'triage some repos', input: ${JSON.stringify(INPUT)} }\nreturn args.repos.length\n`;

test("args are checked against meta.input: each path at fault, and a string of JSON is said to look encoded twice", () => {
  assert.deepEqual(inputProblems(INPUT, { repos: ["a/b"], mode: "deep" }), []);
  assert.deepEqual(inputProblems(INPUT, { repos: '["a/b","c/d"]' }), [
    "$.repos: expected array, got string — it looks encoded twice: the string holds JSON (an array); pass the array itself, not a string of it",
  ]);
  assert.deepEqual(inputProblems(INPUT, JSON.stringify({ repos: ["a/b"] })), [
    "$: expected object, got string — it looks encoded twice: the string holds JSON (an object); pass the object itself, not a string of it",
  ]);
  assert.deepEqual(inputProblems(INPUT, { repos: [], mode: "slow", depth: 1.5, extra: 1 }), [
    "$.repos: expected at least 1 items, got 0",
    '$.mode: "slow" is not one of ["fast","deep"]',
    "$.depth: expected integer, got number",
    '$: unexpected properties ["extra"]',
  ]);
  assert.deepEqual(inputProblems(INPUT, null), ["$: expected object, got null (no --args given?)"]);
  assert.deepEqual(inputProblems(INPUT, { repos: "a/b" }), ["$.repos: expected array, got string"], "a plain string is no double encoding");

  assert.doesNotThrow(() => checkInput(undefined, "anything", "wf"), "no meta.input: nothing is checked");
  assert.throws(
    () => checkInput(INPUT, { repos: 3 }, "triage"),
    (err: unknown) => {
      assert.ok(err instanceof InputSchemaError);
      assert.equal(err.message, "triage: its args do not match its meta.input:\n  $.repos: expected array, got integer\n  odw run triage --help lists what it takes");
      assert.deepEqual(err.problems, ["$.repos: expected array, got integer"]);
      return true;
    },
  );
});

test("the loader refuses a meta.input the validator would not check in full, or that is no schema", () => {
  const load = (input: string) => loadWorkflowScript(`export const meta = { name: 'x', description: 'y', input: ${input} }\nreturn 1\n`, "wf.js");
  assert.deepEqual(load(JSON.stringify(INPUT)).meta.input, INPUT);
  const refused = (input: string): string => {
    try {
      load(input);
    } catch (err) {
      assert.ok(err instanceof WorkflowScriptError);
      assert.deepEqual(err.location, { line: 1, column: 1 });
      return err.message;
    }
    assert.fail("it loaded");
  };
  assert.match(
    refused("{ type: 'object', properties: { n: { type: 'integer', minimum: 1 } } }"),
    /^workflow wf\.js: meta\.input #\/properties\/n: "minimum" is not checked — meta\.input takes the subset agent\(\) schemas are checked with/,
  );
  assert.match(refused("{ type: 'obect' }"), /meta\.input #: unknown type "obect" \(did you mean "object"\?\)/);
  assert.match(refused("{ type: 'object', requird: ['a'] }"), /unknown keyword "requird" \(did you mean "required"\?\)/);
  assert.match(refused("'object'"), /meta\.input must be a JSON Schema object/);
});

test("odw run <wf> --help prints what it takes from meta.input; a workflow without one says its args go unchecked", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-input-help-"));
  try {
    const wf = join(root, "triage.js");
    writeFileSync(wf, WF);
    let r = await cli(["run", wf, "--help"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(
      r.out,
      [
        `usage: odw run ${wf} [--args JSON|@file] [run options — odw --help]`,
        "",
        "triage — triage some repos",
        "",
        "args (meta.input, checked before the run starts):",
        "  args  object",
        "    repos  array of string  (required)  at least 1  — owner/name of each",
        '    mode  any  one of "fast", "deep"  default "fast"',
        "    depth  integer",
        "    (no other properties)",
        "",
      ].join("\n"),
    );
    const bare = join(root, "bare.js");
    writeFileSync(bare, "export const meta = { name: 'bare', description: 'd' }\nreturn 1\n");
    r = await cli(["run", bare, "-h"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /args: not declared \(no meta\.input\) — whatever --args holds reaches the script unchecked/);
    assert.deepEqual(describeInput({ type: "array", items: { type: "string" } }), ["args  array of string"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw run refuses args that miss meta.input before a run exists; matching args run", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-input-run-"));
  try {
    const wf = join(root, "triage.js");
    writeFileSync(wf, WF);
    const runsRoot = join(root, "runs");
    const r = await cli(["run", wf, "--runs-root", runsRoot, "--args", JSON.stringify({ repos: JSON.stringify(["a/b"]) }), "--detach"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /its args do not match its meta\.input:\n {2}\$\.repos: expected array, got string — it looks encoded twice/);
    assert.ok(!existsSync(runsRoot) || readdirSync(runsRoot).filter((name) => /^\d{8}-/.test(name)).length === 0, "no run was created");

    assert.throws(() => startRunFromSource(WF, { runsRoot, args: {} }), /\$\.repos: required property is missing/);
    const { runId, store } = startRun(wf, { runsRoot, args: { repos: ["a/b", "c/d"] } });
    const status = await waitFor(store, runId, { timeoutMs: 10_000 });
    assert.equal(status.state, "done", String(status.error));
    assert.equal(store.readResult(runId), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose parallel() falls short of its minOk fails with the counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-minok-run-"));
  try {
    const { runId, store } = startRunFromSource(
      "export const meta = { name: 'short', description: 'x' }\n" +
        "const out = await parallel([() => 1, () => null, () => { throw new Error('boom') }], { minOk: 'all' })\nreturn out\n",
      { runsRoot: root },
    );
    const status = await waitFor(store, runId, { timeoutMs: 10_000 });
    assert.equal(status.state, "failed");
    assert.match(String(status.error ?? store.readError(runId)?.error), /parallel\(\) of 3 tasks: 1 of 3 ok; 1 failed \(Error 1\); 1 returned null — minOk "all" needs 3 ok/);
    const done = store.readEvents(runId).filter((e) => e.type === "fanout_done");
    assert.equal(done.length, 1);
    assert.equal(done[0]!.belowMinOk, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw schedule add refuses args that miss meta.input, before anything is installed", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-input-schedule-"));
  try {
    const wf = join(root, "triage.js");
    writeFileSync(wf, WF);
    const r = await cli(["schedule", "add", "nightly", wf, "--cron", "0 3 * * *", "--args", '{"repos":"a/b"}', "--cwd", root, "--dry-run"]);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /odw schedule add: .*its args do not match its meta\.input:\n {2}\$\.repos: expected array, got string/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  try {
    return { code: await main(argv), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}
