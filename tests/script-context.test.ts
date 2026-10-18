/**
 * The strict script context (ODW extension; src/script-context.ts): a body
 * compiled in a fresh vm context with only the primitives and the standard
 * built-ins, the membrane values cross it through, the readable errors for
 * what is not there, which runs default to it, and `odw check --capabilities`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { applyArgsEdit } from "../src/breaks.js";
import { AdapterExecutionError, WorkflowScriptError } from "../src/errors.js";
import { loadWorkflowScript } from "../src/loader.js";
import type { WorkflowGlobals } from "../src/primitives.js";
import { mockCommand } from "../src/conformance/suite.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { readableStrictMessage, resolveScriptContext, scanCapabilities } from "../src/script-context.js";

const SUITE = fileURLToPath(new URL("../conformance/", import.meta.url));

function fakeGlobals(overrides: Partial<WorkflowGlobals> = {}): WorkflowGlobals {
  return {
    agent: async (prompt: string) => ({ reply: `AG:${prompt}`, list: [1, 2] }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())) as Promise<never[]>,
    pipeline: async (items) => items,
    phase: () => {},
    log: () => {},
    budget: { total: 100, spent: () => 7, remaining: () => 93 },
    workflow: Object.assign(async () => null, { input: { untrusted: false, args: [], why: null, quote: (t: unknown) => `<<${String(t)}>>` } }),
    ...overrides,
  };
}

const META = "export const meta = { name: 'x', description: 'd' }\n";

function strict(body: string) {
  return loadWorkflowScript(META + body, "x.js", { context: "strict" });
}

test("strict: no process, require, fetch, timers or console — typeof says undefined, a use says why", async () => {
  const out = await strict(
    "return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof console, typeof globalThis.process, (() => { try { return typeof this.constructor.constructor('return process')() } catch (e) { return e.name } })()]",
  ).run(fakeGlobals(), null);
  assert.deepEqual(Array.from(out as unknown[]), ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "EvalError"]);

  for (const [use, name] of [["process.env.HOME", "process"], ["require('node:fs')", "require"], ["console.log(1)", "console"], ["fetch('x')", "fetch"]] as const) {
    await assert.rejects(strict(`return ${use}`).run(fakeGlobals(), null), (err: Error) => {
      assert.ok(err instanceof ReferenceError, "a ReferenceError of the worker's own realm");
      assert.match(err.message, new RegExp(`^${name} is not defined: a strict script context \\(scriptContext: "strict"\\) has only the workflow primitives`));
      assert.match(err.stack ?? "", /at .*x\.js:2:/, "the script's own frame stays");
      return true;
    });
  }
  // eval and new Function compile no code from strings there.
  for (const use of ["eval('1')", "new Function('return 1')()", "agent.constructor('return process')()"]) {
    await assert.rejects(strict(`return ${use}`).run(fakeGlobals(), null), /eval\(\) and new Function\(\) are not available: a strict script context/);
  }
  // The same body runs in the host context as before.
  assert.equal(await loadWorkflowScript(META + "return typeof process", "x.js").run(fakeGlobals(), null), "object");
});

test("strict: an import() — even inside a template's interpolation — is refused when the body compiles, with where", () => {
  assert.throws(
    () => strict("const t = `${import('node:fs')}`\nreturn t"),
    (err: unknown) =>
      err instanceof WorkflowScriptError && /import\(\) is not available: a strict script context/.test(err.message) && err.location?.line === 2,
  );
});

test("strict: what a primitive returns is a copy in the script's realm; budget, workflow.input and callbacks still work", async () => {
  const seen: unknown[] = [];
  const out = await strict(
    [
      "const r = await agent('hi')",
      "const all = await parallel([() => agent('a'), () => 'plain'])",
      "const piped = await pipeline([1, 2], (prev, item, i) => prev * 10 + i)",
      "return {",
      "  reply: r.reply, own: Object.getPrototypeOf(r) === Object.prototype, isArray: r.list instanceof Array,",
      "  all: all.map((x) => (typeof x === 'string' ? x : x.reply)), piped,",
      "  budget: [budget.total, budget.spent(), budget.remaining()],",
      "  quoted: workflow.input.quote('t'), untrusted: workflow.input.untrusted,",
      "  fnRealm: agent instanceof Function,",
      "}",
    ].join("\n"),
  ).run(
    fakeGlobals({
      pipeline: async (items, ...stages) => {
        const results: unknown[] = [];
        for (const [i, item] of items.entries()) {
          let v: unknown = item;
          for (const stage of stages) v = await stage(v, item, i);
          results.push(v);
        }
        seen.push(results);
        return results;
      },
    }),
    null,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    reply: "AG:hi",
    own: true,
    isArray: true,
    all: ["AG:a", "plain"],
    piped: [10, 21],
    budget: [100, 7, 93],
    quoted: "<<t>>",
    untrusted: false,
    fnRealm: true,
  });
  assert.deepEqual(seen, [[10, 21]]);
});

test("strict: a primitive's error reaches the script as an Error of its realm with its fields, and leaves the run as the same object", async () => {
  const failure = new AdapterExecutionError("the CLI broke", { reason: "quota" });
  const caught = await strict(
    "try { await agent('x') } catch (e) { return [e instanceof Error, e.name, e.message, e.reason] }",
  ).run(fakeGlobals({ agent: async () => Promise.reject(failure) }), null);
  assert.deepEqual(Array.from(caught as unknown[]), [true, "AdapterExecutionError", "the CLI broke", "quota"]);

  await assert.rejects(
    strict("await agent('x')").run(fakeGlobals({ agent: async () => Promise.reject(failure) }), null),
    (err: unknown) => err === failure,
  );
  // The script's own throw comes out as the worker's Error, message and frame kept.
  await assert.rejects(strict("\nthrow new TypeError('boom')").run(fakeGlobals(), null), (err: Error) => {
    assert.ok(err instanceof TypeError);
    assert.equal(err.message, "boom");
    assert.match(err.stack ?? "", /x\.js:3:/);
    return true;
  });
  // A thunk's throw reaches parallel() — the worker — as its Error too.
  let thunkError: unknown;
  await strict("await parallel([() => { throw new Error('in a thunk') }])").run(
    fakeGlobals({
      parallel: async (thunks) => {
        try {
          await thunks[0]!();
        } catch (err) {
          thunkError = err;
        }
        return [null];
      },
    }),
    null,
  );
  assert.ok(thunkError instanceof Error);
  assert.equal((thunkError as Error).message, "in a thunk");
});

test("strict: adoptArgs gets the script's own args, so an edit to it is what the script reads", async () => {
  let held: Record<string, unknown> | undefined;
  const out = await strict("await agent('x')\nreturn args.topic").run(
    fakeGlobals({
      agent: async () => {
        held!.topic = "edited";
        return "ok";
      },
    }),
    { topic: "original" },
    (inScript) => (held = inScript as Record<string, unknown>),
  );
  assert.equal(out, "edited");
});

test("strict: a break's edit enters args through the membrane — no worker object, no worker Function, no script method called", async () => {
  let held: unknown;
  let importValue: ((value: unknown) => unknown) | undefined;
  const adopt = (inScript: unknown, toScript?: (value: unknown) => unknown): void => {
    held = inScript;
    importValue = toScript;
  };
  const out = (await strict(
    [
      "await agent('x')",
      "let reached",
      "try { reached = typeof args.cfg.constructor.constructor('return process')() } catch (e) { reached = e.name }",
      "return { x: args.cfg.x, reached, own: args.cfg.constructor.constructor === Function && args.cfg instanceof Object }",
    ].join("\n"),
  ).run(
    fakeGlobals({
      agent: async () => {
        assert.deepEqual(applyArgsEdit(held, { args: { cfg: { x: 1 } } }, importValue), { changed: ["cfg"] });
        assert.notEqual((held as { cfg: { constructor: unknown } }).cfg.constructor, Object, "not the worker's Object");
        return "ok";
      },
    }),
    { cfg: null },
    adopt,
  )) as Record<string, unknown>;
  assert.deepEqual({ ...out }, { x: 1, reached: "EvalError", own: true });

  // An array whose splice the script replaced is still changed, without calling it.
  const list = (await strict(
    [
      "args.splice = () => { throw new Error('the script ran') }",
      "await agent('x')",
      "return [args.length, args[0].n, args[1].n, args[0] instanceof Object]",
    ].join("\n"),
  ).run(
    fakeGlobals({
      agent: async () => {
        assert.deepEqual(applyArgsEdit(held, { args: [{ n: 1 }, { n: 2 }] }, importValue), { changed: ["0", "1", "2"] });
        return "ok";
      },
    }),
    [{ n: 0 }, { n: 0 }, { n: 0 }],
    adopt,
  )) as unknown[];
  assert.deepEqual([...list], [2, 1, 2, true]);
});

test("which runs are strict: the config's choice, else triggered, plugin and untrusted runs", () => {
  const run = { plugin: false, untrustedInput: false, untrustedRepo: false };
  assert.equal(resolveScriptContext(null, run).context, "host");
  assert.equal(resolveScriptContext(null, { ...run, origin: "trigger" }).context, "strict");
  assert.equal(resolveScriptContext(null, { ...run, plugin: true }).context, "strict");
  assert.equal(resolveScriptContext(null, { ...run, untrustedInput: true }).context, "strict");
  assert.equal(resolveScriptContext(null, { ...run, untrustedRepo: true }).context, "strict");
  assert.equal(resolveScriptContext("host", { ...run, origin: "trigger" }).context, "host");
  assert.equal(resolveScriptContext("strict", run).context, "strict");
  assert.equal(readableStrictMessage("ReferenceError", "x is not defined"), null, "a script's own typo stays as it was");
});

test("scanCapabilities: names outside the dialect, where first and how often; extensions called; strings, comments, keys and own bindings skipped", () => {
  const report = scanCapabilities(
    [
      META.trimEnd(),
      "// process in a comment",
      "const s = 'require in a string'",
      "const o = { process: 1, fetch: 2 }",
      "log(process.env.A + process.env.B + `${globalThis.x}`)",
      "eval('1'); new Function('return 1')",
      "const setTimeout = () => {}",
      "setTimeout()",
      "await exec('ls'); re.exec('x')",
      "log(workflow.input.untrusted)",
    ].join("\n"),
  );
  assert.deepEqual(report.outOfDialect, [
    { name: "process", line: 5, column: 5, count: 2, strict: false },
    { name: "globalThis", line: 5, column: 40, count: 1, strict: true },
    { name: "eval", line: 6, column: 1, count: 1, strict: false },
    { name: "Function(", line: 6, column: 16, count: 1, strict: false },
  ]);
  assert.deepEqual(report.extensions, ["exec", "workflow.input"]);
});

/** `odw <argv>` in-process, its stdout and stderr captured. */
async function odw(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
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

test("odw check --capabilities: the text lists each name with its line and the extensions; --json carries the report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-capabilities-"));
  try {
    const file = join(dir, "wf.js");
    writeFileSync(file, META + "const fs = require('node:fs')\nawait checkpoint('ok?')\nreturn 1\n");
    const text = await odw(["check", file, "--capabilities"]);
    assert.equal(text.code, 0);
    assert.match(text.out, /wf\.js:2:12: capability: require — outside the dialect; not in a strict context/);
    assert.match(text.out, /ODW extensions: checkpoint/);
    const json = await odw(["check", file, "--capabilities", "--json"]);
    const report = JSON.parse(json.out) as { ok: boolean; capabilities: { outOfDialect: Array<{ name: string }>; extensions: string[] } };
    assert.equal(report.ok, true);
    assert.deepEqual(report.capabilities.outOfDialect.map((u) => u.name), ["require"]);
    assert.deepEqual(report.capabilities.extensions, ["checkpoint"]);
    // Without the flag, no capabilities.
    assert.equal("capabilities" in (JSON.parse((await odw(["check", file, "--json"])).out) as object), false);
    writeFileSync(file, META + "return 1\n");
    assert.match((await odw(["check", file, "--capabilities"])).out, /capabilities: nothing outside the dialect\n.*ODW extensions: none/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A run of `body` on the conformance mock agent; `config` merged into its odw config. */
async function runWorkflow(
  body: string,
  opts: { origin?: string; config?: Record<string, unknown>; files?: Record<string, string> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "odw-strict-run-"));
  try {
    const table = join(dir, "mock.json");
    writeFileSync(table, JSON.stringify([{ when: "say hi", reply: "hi" }]));
    const configPath = join(dir, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ defaultAdapter: "mock", recordVersions: false, adapters: { mock: { command: [...mockCommand(SUITE), table], stdin: "{prompt}" } }, ...opts.config }),
    );
    for (const [name, text] of Object.entries(opts.files ?? {})) writeFileSync(join(dir, name), text);
    const script = join(dir, "wf.js");
    writeFileSync(script, META + body);
    const store = new RunStore(join(dir, "runs"));
    const runId = store.create({ script, args: null, source: dir, configPath, origin: opts.origin ?? null });
    const state = await executeRun(store.runDir(runId));
    const events = store.readEvents(runId);
    return {
      state,
      result: state === "done" ? store.readResult(runId) : null,
      error: store.readError(runId),
      logs: events.filter((e) => e.type === "log").map((e) => String(e.message)),
      setup: (events.find((e) => e.type === "run_started") as { setup?: { settings?: Record<string, unknown> } } | undefined)?.setup,
      status: store.readStatus(runId) as Record<string, unknown>,
      shown: detail(store, runId).scriptContext,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a triggered run is strict: said before the body runs, with the names it lacks; a use fails readably; the config's host wins", async () => {
  const body = "const r = await agent('say hi')\nreturn r + ' ' + process.platform\n";
  const triggered = await runWorkflow(body, { origin: "trigger" });
  assert.equal(triggered.state, "failed");
  assert.match(String(triggered.error?.error), /process is not defined: a strict script context/);
  const said = triggered.logs.find((l) => l.includes("strict script context"));
  assert.match(said ?? "", /a trigger started this run: only the primitives and standard JavaScript built-ins \(not a security boundary\); it names process \(line 3\)/);
  assert.equal(triggered.status.scriptContext, "strict");
  assert.equal(triggered.setup?.settings?.scriptContext, "strict");
  assert.equal(triggered.shown, "strict", "the run's detail carries it to the dashboard");

  const local = await runWorkflow(body);
  assert.equal(local.state, "done");
  assert.equal(local.result, `hi ${process.platform}`);
  assert.equal(local.setup?.settings?.scriptContext, "host");
  assert.equal(local.logs.some((l) => l.includes("strict script context")), false);
  assert.equal(local.shown, undefined);

  const overridden = await runWorkflow(body, { origin: "trigger", config: { scriptContext: "host" } });
  assert.equal(overridden.state, "done");
});

test("a strict run's nested workflow() is strict too", async () => {
  const child = "export const meta = { name: 'child', description: 'd' }\nreturn typeof process\n";
  const out = await runWorkflow("return await workflow({ scriptPath: 'child.js' })\n", { config: { scriptContext: "strict" }, files: { "child.js": child } });
  assert.equal(out.state, "done", JSON.stringify(out.error));
  assert.equal(out.result, "undefined");
});

test('config: scriptContext is "host" or "strict"', async () => {
  const out = await runWorkflow("return 1\n", { config: { scriptContext: "sandbox" } });
  assert.equal(out.state, "failed");
  assert.match(String(out.error?.error), /"scriptContext" must be "host" or "strict"; got "sandbox"/);
});
