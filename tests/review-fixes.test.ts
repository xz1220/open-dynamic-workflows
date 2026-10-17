// Regression guards for the 15 bugs the adversarial review confirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig } from "../src/adapters/config.js";
import { runCommand } from "../src/adapters/runner.js";
import { Bridge } from "../src/bridge.js";
import { main } from "../src/cli.js";
import { WorkflowScriptError } from "../src/errors.js";
import { loadWorkflowScript } from "../src/loader.js";
import { extractJson, validate } from "../src/schema.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// --- loader (findings 1, 2, 6, 7) -------------------------------------------

test("loader: a line comment with an apostrophe and a brace in meta", () => {
  const src = "export const meta = {\n name: 'n', // it's a name with } brace\n description: 'd'\n}\nreturn 1";
  assert.equal(loadWorkflowScript(src, "x.js").meta.name, "n");
});

test("loader: a block comment with a brace inside meta", () => {
  const src = "export const meta = { name: 'n', /* don't break } */ description: 'd' }\nreturn 1";
  assert.equal(loadWorkflowScript(src, "x.js").meta.name, "n");
});

test("loader: a regex literal in a meta value is rejected as non-literal, not mis-scanned", () => {
  // meta is parsed, never evaluated, so a regex (and `.source`) is not a pure literal.
  const src = "export const meta = { name: 'n', description: 'd', x: /it's }/.source }\nreturn 1";
  assert.throws(
    () => loadWorkflowScript(src, "x.js"),
    (err: Error) =>
      err instanceof WorkflowScriptError &&
      err.message === "workflow x.js: meta must be a pure literal (found '/' at line 1:55)",
  );
});

test("loader: a regex literal with a quote and a brace in the body does not derail the scan", () => {
  const meta = "export const meta = { name: 'n', description: 'd' }\n";
  assert.equal(loadWorkflowScript(meta + "const re = /it's }/\nreturn re.source", "x.js").meta.name, "n");
  // ...so a stray export after it is still found (the regex was not read as a string).
  assert.throws(
    () => loadWorkflowScript(meta + "const re = /it's }/\nexport const x = 1\nreturn 1", "x.js"),
    /may only 'export const meta'/,
  );
});

test("loader: 'export const meta' inside a string is ignored, real one wins", () => {
  const src =
    'log("docs: export const meta = { name: \\"BOGUS\\", description: \\"x\\" }")\n' +
    "export const meta = { name: 'real', description: 'd' }\nreturn 1";
  assert.equal(loadWorkflowScript(src, "x.js").meta.name, "real");
});

test("loader: a stray second top-level export is rejected clearly", () => {
  const src = "export const meta = { name: 'n', description: 'd' }\nexport const x = 1\nreturn 1";
  assert.throws(() => loadWorkflowScript(src, "x.js"), WorkflowScriptError);
});

// --- schema (findings 5, 10, 13) --------------------------------------------

test("schema: enum with object members uses structural equality", () => {
  const s = { enum: [{ a: 1 }, { b: 2 }] };
  assert.deepEqual(validate({ a: 1 }, s), []);
  assert.equal(validate({ a: 9 }, s).length, 1);
});

test("schema: enum and type are both enforced", () => {
  const s = { type: "string", enum: ["x", "y"] };
  assert.ok(validate(5, s).length >= 1, "a number is neither a string nor in the enum");
  assert.deepEqual(validate("x", s), []);
});

test("schema: extractJson skips an inline fence and finds the real JSON block", () => {
  const reply = "Example: ```\nnot json\n```\nAnswer:\n```json\n{\"a\":1}\n```";
  assert.deepEqual(extractJson(reply), { a: 1 });
});

test("bridge: a parsed JSON null is accepted by a nullable schema (not 'no JSON')", async () => {
  const c = defaultConfig();
  c.settings.defaultAdapter = "claude";
  const bridge = new Bridge(c, {
    runner: async () => ({ returncode: 0, stdout: "null", stderr: "", timedOut: false, duration: 0 }),
  });
  const out = await bridge.run({ prompt: "p", schema: { type: "null" } });
  assert.equal(out.value, null);
});

// --- runner (findings 3, 4) -------------------------------------------------

test("runner: a signal-killed child reports a non-zero returncode (not 0)", async () => {
  const r = await runCommand([execPath, "-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.notEqual(r.returncode, 0);
});

// --- workspace (finding 9) --------------------------------------------------

// --- cli (findings 11, 12, 15) ----------------------------------------------

async function exitCode(argv: string[]): Promise<number> {
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = () => true;
  (process.stderr as { write: unknown }).write = () => true;
  try {
    return await main(argv);
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("cli: an invalid --timeout exits 2", async () => {
  assert.equal(await exitCode(["run", "wf.js", "--wait", "--timeout", "abc"]), 2);
});

test("cli: an invalid --budget exits 2", async () => {
  assert.equal(await exitCode(["run", "wf.js", "--budget", "abc"]), 2);
});

test("cli: an unknown flag exits 2 (usage error)", async () => {
  assert.equal(await exitCode(["list", "--bogus"]), 2);
});

// --- worker (self-found: config error must not strand the run) --------------

test("worker: a bad config fails the run instead of leaving it pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-badcfg-"));
  try {
    const store = new RunStore(root);
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 't', description: 'd' }\nreturn 1");
    const id = store.create({
      script,
      args: null,
      source: root,
      configPath: join(root, "does-not-exist.json"),
    });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "failed");
    assert.equal(store.readStatus(id).state, "failed");
    assert.ok(store.readError(id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
