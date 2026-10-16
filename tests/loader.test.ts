import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadWorkflowScript, MetaLiteralError, readMetaLiteral } from "../src/loader.js";
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

// --- meta is parsed, never evaluated --------------------------------------------
// Listing workflows reads the meta of every file it finds, so evaluating meta
// would run code from any of them. These probes prove nothing in meta executes.

test("the hostname example is rejected without executing anything", () => {
  const src =
    'export const meta = { name: "x", description: String(process.getBuiltinModule("node:os").hostname()) }\nreturn 1';
  const proc = process as unknown as Record<string, unknown>;
  const had = Object.hasOwn(proc, "getBuiltinModule");
  const original = proc.getBuiltinModule as ((id: string) => unknown) | undefined;
  let calls = 0;
  proc.getBuiltinModule = (id: string) => {
    calls++;
    return original?.call(process, id);
  };
  try {
    assert.throws(() => loadWorkflowScript(src, "evil.js"), {
      name: "WorkflowScriptError",
      message: "workflow evil.js: meta must be a pure literal (found identifier 'String' at line 1:47)",
    });
    assert.throws(() => readMetaLiteral(src), MetaLiteralError);
  } finally {
    if (had) proc.getBuiltinModule = original;
    else delete proc.getBuiltinModule;
  }
  assert.equal(calls, 0, "process.getBuiltinModule must never be called");
});

test("identifiers, calls, keys, spreads, accessors and interpolations in meta never run", () => {
  let hits = 0;
  Object.defineProperty(globalThis, "__odwMetaProbe", {
    configurable: true,
    get() {
      hits++;
      return () => {
        hits++;
        return "x";
      };
    },
  });
  const payloads = [
    "{ name: 'x', description: __odwMetaProbe }",
    "{ name: 'x', description: __odwMetaProbe() }",
    "{ name: 'x', description: `${__odwMetaProbe()}` }",
    "{ [__odwMetaProbe()]: 1, name: 'x', description: 'd' }",
    "{ ...__odwMetaProbe(), name: 'x', description: 'd' }",
    "{ name: 'x', get description() { return __odwMetaProbe() } }",
    "{ name: 'x', description: (0, __odwMetaProbe)() }",
    "{ name: 'x', description: 'd' + __odwMetaProbe() }",
  ];
  try {
    // Control: evaluating such a literal (what the loader used to do) fires the probe.
    new Function(`return (${payloads[1]});`)();
    assert.equal(hits, 2, "the probe works");
    hits = 0;
    for (const literal of payloads) {
      const src = `export const meta = ${literal}\nreturn 1`;
      assert.throws(() => loadWorkflowScript(src, "probe.js"), WorkflowScriptError, literal);
      assert.throws(() => readMetaLiteral(src), MetaLiteralError, literal);
    }
  } finally {
    delete (globalThis as Record<string, unknown>).__odwMetaProbe;
  }
  assert.equal(hits, 0, "no meta payload may execute");
});

test("the accepted grammar parses to exactly what JavaScript evaluates", async () => {
  // The fixture's body is `return meta`, so running it yields V8's own value of
  // the same literal: the parser must agree with the language on every construct.
  const src = readFileSync(new URL("./fixtures/dual-compat/good-grammar.js", import.meta.url), "utf8");
  const loaded = loadWorkflowScript(src, "good-grammar.js");
  const evaluated = await loaded.run(fakeGlobals(), null);
  assert.deepStrictEqual(loaded.meta, evaluated);
  assert.deepStrictEqual(readMetaLiteral(src), evaluated);

  const m = loaded.meta as unknown as Record<string, unknown>;
  assert.deepStrictEqual(
    m.numbers,
    [0, -1, 2, 1.25, 0.5, 5, 1000, 0.02, 100, -31, 15, 5, 1_000_000, 0.0001, -3, -0],
  );
  for (const key of ["42", "1.5", "16", "1000", "default", "single-quoted key", "ünïcödé"]) {
    assert.ok(Object.hasOwn(m, key), `key ${key}`);
  }
  assert.equal(m.template, "no interpolation: $5, ${literal}, `ticks` and {braces}");
  assert.equal(m.multiline, "line one\nline two");
  assert.equal(m.continued, "one two");
});

test("non-literal meta is rejected with what was found and where", () => {
  const cases: Array<[string, string]> = [
    ["{ name }", "found shorthand property 'name' at line 1:23"],
    ["{ name: 'x', run() {} }", "found method or accessor 'run' at line 1:34"],
    ["{ name: 'x', get description() { return 'd' } }", "found method or accessor 'get' at line 1:34"],
    ["{ [key]: 1 }", "found computed key '[' at line 1:23"],
    ["{ ...base }", "found spread '...' at line 1:23"],
    ["{ description: undefined }", "found identifier 'undefined' at line 1:36"],
    ["{ n: NaN }", "found identifier 'NaN' at line 1:26"],
    ["{ n: -Infinity }", "found identifier 'Infinity' after '-' at line 1:27"],
    ["{ n: 10n }", "found unsupported number '10n' at line 1:26"],
    ["{ n: 017 }", "found unsupported number '017' at line 1:26"],
    ["{ s: '\\1' }", "found legacy octal escape '\\1' at line 1:27"],
    ["{ s: 'a' + 'b' }", "expected ',' or '}' but found '+' at line 1:30"],
    ["{ a: [1,,2] }", "found array hole ',' at line 1:29"],
    ["{ r: /x/ }", "found '/' at line 1:26"],
    ["{ f: () => 1 }", "found '(' at line 1:26"],
    ["{ d: new Date() }", "found identifier 'new' at line 1:26"],
    ["{ t: `a${b}` }", "found template interpolation '${' at line 1:28"],
    ["{ name: 'x' description: 'd' }", "expected ',' or '}' but found identifier 'description' at line 1:33"],
    ["{ name: 'x }", "unterminated string at line 1:29"],
    ["{ /* name: 'x' }", "unterminated comment at line 1:23"],
    ["makeMeta()", "found identifier 'makeMeta' at line 1:21"],
    ["{\r\n  name: NAME,\r\n}", "found identifier 'NAME' at line 2:9"],
    // The declaration must BE the literal: nothing may continue the expression.
    ["{ name: 'x', description: 'd' }.constructor", "found '.' after the literal at line 1:52"],
    ["{ name: 'x', description: 'd' }\n(function () {})()", "found '(' after the literal at line 2:1"],
    ["{ name: 'x', description: 'd' }, extra = 1", "found ',' after the literal at line 1:52"],
  ];
  for (const [literal, detail] of cases) {
    assert.throws(
      () => loadWorkflowScript(`export const meta = ${literal}\nreturn 1`, "x.js"),
      { name: "WorkflowScriptError", message: `workflow x.js: meta must be a pure literal (${detail})` },
      literal,
    );
  }
  for (const [literal, found] of [["'just a string'", "string"], ["[{ name: 'x' }]", "'['"]]) {
    assert.throws(
      () => loadWorkflowScript(`export const meta = ${literal}\nreturn 1`, "x.js"),
      { message: `workflow x.js: meta must be an object literal (found ${found} at line 1:21)` },
    );
  }
});

test("the literal may end at ';', a comment, or a line break before the next statement", () => {
  const meta = "export const meta = { name: 'x', description: 'd' }";
  for (const tail of ["", ";", "; log('a')", " // note\nlog('a')", "\nlog('a')", " /* c */\n\n++n"]) {
    assert.equal(loadWorkflowScript(meta + tail + "\nreturn 1", "x.js").meta.name, "x", JSON.stringify(tail));
  }
});

test("a __proto__ key is an own property (as JSON.parse makes it), never a prototype swap", () => {
  const meta = readMetaLiteral(
    "export const meta = { name: 'x', description: 'd', __proto__: { polluted: true } }",
  )!;
  assert.equal(Object.getPrototypeOf(meta), Object.prototype);
  assert.ok(Object.hasOwn(meta, "__proto__"));
  assert.equal(meta.polluted, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), JSON.parse('{"name":"x","description":"d","__proto__":{"polluted":true}}'));
});

test("duplicate keys: the last one wins, as in JavaScript", () => {
  assert.equal(
    loadWorkflowScript("export const meta = { name: 'a', description: 'd', name: 'b' }", "x.js").meta.name,
    "b",
  );
});

test("pathological nesting is a clear error, not a stack overflow", () => {
  const deep = "[".repeat(5000) + "]".repeat(5000);
  assert.throws(
    () => readMetaLiteral(`export const meta = { name: 'x', description: 'd', deep: ${deep} }`),
    /meta must be a pure literal \(found nesting deeper than 100 at line 1:\d+\)/,
  );
});

test("readMetaLiteral ignores declarations in comments and strings", () => {
  assert.equal(readMetaLiteral("// export const meta = { name: 'c' }\nreturn 1"), null);
  assert.equal(readMetaLiteral("const s = 'export const meta = { name: 1 }'\nreturn s"), null);
  assert.deepEqual(
    readMetaLiteral("/* export const meta = NOPE */\nexport const meta = { name: 'real' }"),
    { name: "real" },
  );
});
