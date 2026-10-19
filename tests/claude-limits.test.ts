import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkWorkflow } from "../src/check.js";
import { CLAUDE_CODE_FANOUT_CAP } from "../src/claude-limits.js";
import { main } from "../src/cli.js";
import { scanDualCompat } from "../src/loader.js";

// odw check's "Claude Code limits" (Claude Code dialect): a parallel() or
// pipeline() the source settles at more than 4,096 items, which Claude Code's
// runtime rejects, and a meta that is not a pure literal. Warnings only:
// ODW runs such a fan-out.

const META = "export const meta = { name: 'x', description: 'y' }\n";
const capWarnings = (body: string) => scanDualCompat(META + body).filter((w) => /4,096/.test(w));

test("a fan-out whose length the source settles above 4,096 is named, with its line and count", () => {
  const [w] = capWarnings("const a = 1\nreturn await parallel(Array.from({ length: 5000 }, (_, i) => () => agent(`file ${i}`)))\n");
  assert.equal(
    w,
    "parallel() on line 3 is given 5,000 items — Claude Code's Workflow tool rejects a parallel() or pipeline() of more than " +
      "4,096 with an error (ODW runs it): split the list into batches to run it there",
  );
  assert.equal(CLAUDE_CODE_FANOUT_CAP, 4096);
});

test("each literal shape is counted: Array(n), new Array(n), [...Array(n)], a separator, length-keeping calls", () => {
  assert.equal(capWarnings("await parallel(Array(4097).fill(0).map((_, i) => () => i))").length, 1);
  assert.equal(capWarnings("await parallel(new Array(10_000).fill(null).map(() => () => 1))").length, 1);
  assert.equal(capWarnings("await pipeline([...Array(5000).keys()], (p, x) => x)").length, 1);
  assert.equal(capWarnings("await pipeline([...Array(5000).keys(), 1], (p, x) => x)").length, 0, "a spread beside other elements: not settled");
  assert.equal(capWarnings("await pipeline([...Array(5000)].map((_, i) => i), (p, x) => x)").length, 1);
  assert.match(capWarnings("await pipeline(Array.from({ length: 4097 }), (p, x) => x)")[0]!, /^pipeline\(\) on line 2 is given 4,097 items/);
});

test("an array literal is counted by its elements, strings and nesting aside", () => {
  const items = (n: number, trailing = "") => `[${Array.from({ length: n }, (_, i) => `'a,${i}'`).join(", ")}${trailing}]`;
  assert.equal(capWarnings(`await pipeline(${items(4097)}, (p, x) => x)`).length, 1);
  assert.equal(capWarnings(`await pipeline(${items(4096, ",")}, (p, x) => x)`).length, 0, "4,096 with a trailing comma is at the cap");
  assert.equal(capWarnings(`await pipeline([${"[1, 2, 3], ".repeat(4000)}], (p, x) => x)`).length, 0, "commas inside elements do not count");
});

test("what the source does not settle is never guessed: variables, filters, spreads, computed lengths", () => {
  for (const body of [
    "const xs = Array.from({ length: 5000 }, () => () => 1)\nawait parallel(xs)",
    "await parallel(Array.from({ length: 5000 }).filter(Boolean))",
    "await parallel(Array.from({ length: 5000 * 2 }))",
    "await parallel([...more, () => 1])",
    "await parallel(Array.from({ length: n }))",
    "await helpers.parallel(Array(5000))",
    "const parallel = (xs) => xs\nawait parallel(Array(5000))",
    "// await parallel(Array(5000))\nreturn 1",
    "const s = 'parallel(Array(5000))'",
  ]) {
    assert.deepEqual(capWarnings(body), [], body);
  }
  assert.deepEqual(capWarnings("await parallel(Array.from({ length: 4096 }, () => () => 1))"), [], "the cap itself is allowed");
});

test("odw check prints the warning and still exits 0 — ODW runs it; --json carries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cc-limits-"));
  const file = join(dir, "wide.js");
  writeFileSync(file, META + "return await parallel(Array.from({ length: 5000 }, (_, i) => () => i))\n");
  const out: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: unknown) => (out.push(String(s)), true);
  try {
    assert.equal(await main(["check", file]), 0);
  } finally {
    process.stdout.write = so;
  }
  try {
    const text = out.join("");
    assert.match(text, /warning: parallel\(\) on line 2 is given 5,000 items — Claude Code's Workflow tool rejects/);
    assert.match(text, /ok — workflow 'x'/);
    const report = checkWorkflow(META + "return await parallel(Array(5000).fill(() => 1))\n", "wf.js");
    assert.equal(report.ok, true);
    assert.equal(report.warnings.filter((w) => /4,096/.test(w)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a meta that is not a pure literal adds the Claude Code warning to the error", () => {
  const report = checkWorkflow("const N = 'x'\nexport const meta = { name: N, description: 'y' }\nreturn 1\n", "wf.js");
  assert.equal(report.ok, false);
  assert.match(report.errors[0]!.message, /meta must be a pure literal/);
  assert.deepEqual(report.warnings, [
    "meta is not a pure literal — Claude Code reads it without running the script, so it drops the workflow from its completions; ODW refuses to run it",
  ]);
  // Any other failure says nothing about meta.
  assert.deepEqual(checkWorkflow(META + "return (\n", "wf.js").warnings, []);
});
