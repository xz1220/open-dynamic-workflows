import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkMeta, workflowStem } from "../src/dual-compat.js";

// The audit that keeps every workflow's `meta` portable back to Claude Code:
// it must be a PURE literal (no variables, calls, spreads, interpolation), and
// (R4) its meta.name must equal the filename stem that runs it by name.

const examplesDir = fileURLToPath(new URL("../examples/", import.meta.url));
const fixturesDir = fileURLToPath(new URL("./fixtures/dual-compat/", import.meta.url));
const examples = readdirSync(examplesDir).filter((f) => f.endsWith(".js"));

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

test("T7: every example workflow has a pure-literal meta", () => {
  assert.ok(examples.length >= 8, `expected the example workflows, found ${examples.length}`);
  for (const file of examples) {
    const c = checkMeta(read(examplesDir, file));
    assert.ok(c.found, `${file}: meta declaration not found`);
    assert.ok(c.pure, `${file}: meta is not a pure literal — ${c.reason}`);
  }
});

test("R4: every example's meta.name matches its filename stem", () => {
  for (const file of examples) {
    const c = checkMeta(read(examplesDir, file));
    assert.equal(c.name, workflowStem(file), `${file}: meta.name '${c.name}' must equal its stem`);
  }
});

test("T7: known-good fixtures pass (comments, nesting, negatives, booleans, null)", () => {
  for (const file of ["good-comments.js", "good-nested.js"]) {
    const c = checkMeta(read(fixturesDir, file));
    assert.ok(c.pure, `${file}: expected pure — ${c.reason}`);
    assert.equal(c.name, workflowStem(file));
  }
});

test("T7: known-bad fixtures fail (variable, call, spread, interpolation, concatenation)", () => {
  const bad = ["bad-variable.js", "bad-call.js", "bad-spread.js", "bad-template.js", "bad-concat.js"];
  for (const file of bad) {
    const c = checkMeta(read(fixturesDir, file));
    assert.equal(c.pure, false, `${file}: expected impure, but the audit passed it`);
    assert.ok(c.reason, `${file}: a failing audit must explain why`);
  }
});

test("R4: a pure literal whose meta.name != filename stem is caught", () => {
  const file = "stem-mismatch.js";
  const c = checkMeta(read(fixturesDir, file));
  assert.ok(c.pure, "the fixture is a pure literal");
  assert.equal(c.name, "a-different-name");
  assert.notEqual(c.name, workflowStem(file));
});

test("a source with no meta declaration is reported not-found", () => {
  const c = checkMeta("const x = 1\nreturn x");
  assert.equal(c.found, false);
  assert.equal(c.pure, false);
});
