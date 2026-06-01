import { test } from "node:test";
import assert from "node:assert/strict";

import { unifiedDiff } from "../src/diff.js";

test("identical text produces an empty diff", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "a", "b"), "");
});

test("a changed line shows both - and + with context", () => {
  const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "a/f", "b/f");
  assert.match(d, /--- a\/f/);
  assert.match(d, /\+\+\+ b\/f/);
  assert.match(d, /^-b$/m);
  assert.match(d, /^\+B$/m);
  assert.match(d, /^ a$/m);
});

test("a pure insertion is rendered", () => {
  const d = unifiedDiff("a\n", "a\nb\n", "a", "b");
  assert.match(d, /^\+b$/m);
});

test("a pure deletion is rendered", () => {
  const d = unifiedDiff("a\nb\n", "a\n", "a", "b");
  assert.match(d, /^-b$/m);
});
