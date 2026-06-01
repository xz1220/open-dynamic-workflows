import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWorkflowScript } from "../src/loader.js";
import { WorkflowScriptError } from "../src/errors.js";
import type { WorkflowGlobals } from "../src/primitives.js";

function fakeGlobals(overrides: Partial<WorkflowGlobals> = {}): WorkflowGlobals {
  return {
    agent: async (prompt: string) => `AG:${prompt}`,
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())) as Promise<never[]>,
    pipeline: async (items) => items,
    phase: () => {},
    log: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    workflow: async () => {
      throw new Error("nope");
    },
    ...overrides,
  };
}

test("extracts meta and runs the body's top-level await + return", async () => {
  const src = [
    "export const meta = { name: 'demo', description: 'd', phases: [{ title: 'P' }] }",
    "phase('P')",
    "const r = await agent('hi')",
    "return { r, q: args.q }",
  ].join("\n");
  const loaded = loadWorkflowScript(src, "demo.js");
  assert.equal(loaded.meta.name, "demo");
  assert.equal(loaded.meta.phases?.[0]?.title, "P");

  const phases: string[] = [];
  const out = await loaded.run(fakeGlobals({ phase: (t) => phases.push(t) }), { q: 42 });
  assert.deepEqual(out, { r: "AG:hi", q: 42 });
  assert.deepEqual(phases, ["P"]);
});

test("a script with no top-level return resolves to undefined", async () => {
  const loaded = loadWorkflowScript(
    "export const meta = { name: 'x', description: 'd' }\nlog('hi')",
    "x.js",
  );
  const out = await loaded.run(fakeGlobals(), null);
  assert.equal(out, undefined);
});

test("a missing meta export is a WorkflowScriptError", () => {
  assert.throws(() => loadWorkflowScript("const x = 1\nreturn x", "x.js"), WorkflowScriptError);
});

test("meta with a non-string name is rejected", () => {
  assert.throws(
    () => loadWorkflowScript("export const meta = { name: 123, description: 'd' }\n", "x.js"),
    WorkflowScriptError,
  );
});

test("balanced-brace scan handles braces and quotes inside meta strings", () => {
  const src =
    "export const meta = { name: 'n', description: 'has } brace and {curly}', phases: [{ title: 'A' }, { title: 'B' }] }\nreturn 1";
  const loaded = loadWorkflowScript(src, "x.js");
  assert.equal(loaded.meta.description, "has } brace and {curly}");
  assert.equal(loaded.meta.phases?.length, 2);
});
