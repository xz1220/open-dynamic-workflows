import { test } from "node:test";
import assert from "node:assert/strict";

import { expand, expandAll } from "../src/adapters/placeholders.js";

test("expands a known token from context", () => {
  assert.equal(expand("--cd {workspace} -", { workspace: "/tmp/ws" }), "--cd /tmp/ws -");
});

test("a known token missing from context expands to empty", () => {
  assert.equal(expand("{prompt}", {}), "");
});

test("an unknown token is left untouched", () => {
  assert.equal(expand("keep {weird} literal", {}), "keep {weird} literal");
});

test("expandAll maps over a command vector", () => {
  assert.deepEqual(expandAll(["{adapter}", "exec", "{workspace}"], { adapter: "codex", workspace: "/w" }), [
    "codex",
    "exec",
    "/w",
  ]);
});
