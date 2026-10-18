import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkWorkflow, codeFrame, formatCheck } from "../src/check.js";
import { main } from "../src/cli.js";
import { WorkflowScriptError } from "../src/errors.js";
import { loadWorkflowScript } from "../src/loader.js";

// `odw check <wf>` (ODW extension): the loader's checks from the command line,
// with line, column and a code frame — and the loader's parse errors told as
// they are, a hint only where it fits (anthropics/claude-code#63540 blamed
// TypeScript for every parse error).

const META = "export const meta = { name: 'x', description: 'y' }\n";

function loadError(source: string): WorkflowScriptError {
  try {
    loadWorkflowScript(source, "wf.js");
  } catch (err) {
    assert.ok(err instanceof WorkflowScriptError);
    return err;
  }
  assert.fail("it loaded");
}

test("a syntax error says where, with the compiler's own message — no TypeScript blame for a quoting bug", () => {
  const err = loadError(META + "const s = 'this string ends early\\\\' and the rest is garbage'\nlog(s)\n");
  assert.equal(err.message, "failed to compile workflow wf.js: Unexpected identifier 'and' (line 2:38)");
  assert.deepEqual(err.location, { line: 2, column: 38 });
  assert.doesNotMatch(err.message, /TypeScript/);
});

test("hints come only where they fit: TypeScript tokens, await in a callback that is not async, a script that ends early", () => {
  const ts = /this is TypeScript syntax; workflow scripts are plain JavaScript, so remove the types$/;
  assert.match(loadError(META + "const x: string[] = []\n").message, ts);
  assert.match(loadError(META + "function f(a: number) {}\n").message, ts);
  assert.match(loadError(META + "interface Foo { a: string }\n").message, ts);
  assert.match(loadError(META + "const y = x as Foo\n").message, ts);
  const awaitErr = loadError(META + "const r = await Promise.all(items.map(x => await agent(x)))\n");
  assert.match(awaitErr.message, /\(line 2:44\) — `await` inside a function that is not async; mark that callback async/);
  const early = loadError(META + "if (args) {\n  log('x')\n\n");
  assert.match(early.message, /\(line 3:11\) — the script ends before a bracket, brace, parenthesis or template literal it opened is closed$/);
  // A plain-JS error gets no hint at all.
  assert.match(loadError(META + "const a = 1\nconst a = 2\n").message, /Identifier 'a' has already been declared \(line 3:7\)$/);
});

test("meta problems carry their location too", () => {
  assert.deepEqual(loadError("export const meta = { name: 'x', description: NAME }\n").location, { line: 1, column: 47 });
  const unexported = loadError("\nconst meta = { name: 'x', description: 'd' }\n");
  assert.match(unexported.message, /must 'export const meta = \{ \.\.\. \}'; found 'const meta'$/);
  assert.deepEqual(unexported.location, { line: 2, column: 1 });
  assert.deepEqual(loadError("// c\nexport const meta = { name: '', description: 'd' }\n").location, { line: 2, column: 1 });
  assert.deepEqual(loadError(META + "import fs from 'node:fs'\n").location, { line: 2, column: 1 });
});

test("codeFrame: numbered lines around the fault, a caret under the column, tabs kept aligned, long lines cut", () => {
  const src = "one\ntwo\n\tthree x\nfour\nfive\nsix\n";
  assert.equal(
    codeFrame(src, 3, 8),
    ["  1 | one", "  2 | two", ">  3 |  three x".replace(">  3", "> 3"), "    |        ^", "  4 | four", "  5 | five"].join("\n"),
  );
  const long = "x".repeat(500) + "BAD" + "y".repeat(500);
  const frame = codeFrame(long, 1, 501).split("\n");
  assert.ok(frame[0]!.length < 200);
  assert.equal(frame[1]!.indexOf("^") - frame[1]!.indexOf("|"), frame[0]!.indexOf("BAD") - frame[0]!.indexOf("|"));
});

test("checkWorkflow / formatCheck: a good script is ok with its meta and warnings; a bad one gets file:line:col and a frame", () => {
  const good = checkWorkflow(
    "export const meta = { name: 'g', description: 'd', phases: ['A', { title: 'B' }] }\nreturn Date.now()\n",
    "g.js",
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.meta, { name: "g", description: "d", phases: ["A", "B"] });
  assert.equal(good.warnings.length, 1);
  assert.deepEqual(formatCheck(good), [
    "g.js: warning: Date.now() is banned in Claude Code workflows — pass timestamps in via args",
    "g.js: ok — workflow 'g', 2 phases",
  ]);
  const bad = checkWorkflow(META + "const s = 'end\\\\' oops'\n", "b.js");
  assert.equal(bad.ok, false);
  assert.deepEqual(formatCheck(bad), [
    "b.js:2:19: error: Unexpected identifier 'oops'",
    "  1 | export const meta = { name: 'x', description: 'y' }\n> 2 | const s = 'end\\\\' oops'\n    |                   ^\n  3 |",
  ]);
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

test("odw check exits 0 for a script that loads, 1 with a code frame for one that does not, 2 for a usage mistake", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-check-"));
  try {
    const good = join(root, "good.js");
    writeFileSync(good, META + "return 1\n");
    const bad = join(root, "bad.js");
    writeFileSync(bad, "export const meta = { name: 'x', description: `d${1}` }\nreturn 1\n");
    let r = await cli(["check", good]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /good\.js: ok — workflow 'x'\n$/);
    r = await cli(["check", bad]);
    assert.equal(r.code, 1);
    assert.match(r.err, /bad\.js:1:49: error: meta must be a pure literal \(found template interpolation '\$\{' at line 1:49\)\n/);
    assert.match(r.err, /> 1 \| export const meta/);
    r = await cli(["check", bad, "--json"]);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.out);
    assert.equal(report.ok, false);
    assert.equal(report.errors[0].line, 1);
    assert.equal(report.errors[0].column, 49);
    assert.match(report.errors[0].frame, /\^/);
    assert.equal((await cli(["check"])).code, 2);
    r = await cli(["check", join(root, "missing.js")]);
    assert.equal(r.code, 1);
    assert.match(r.err, /^odw check: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
