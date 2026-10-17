import { test } from "node:test";
import assert from "node:assert/strict";

import {
  array,
  boolean,
  describeSchema,
  enumOf,
  extractJson,
  number,
  obj,
  string,
  validate,
} from "../src/schema.js";

test("extractJson: a fenced ```json block", () => {
  assert.deepEqual(extractJson('here:\n```json\n{"a":1}\n```\ndone'), { a: 1 });
});

test("extractJson: a balanced span amid prose", () => {
  assert.deepEqual(extractJson('sure, {"a": {"b": 2}} ok'), { a: { b: 2 } });
});

test("extractJson: the whole reply", () => {
  assert.deepEqual(extractJson("[1,2,3]"), [1, 2, 3]);
});

test("extractJson: no JSON -> undefined", () => {
  assert.equal(extractJson("no json here"), undefined);
});

test("extractJson: braces inside strings don't break the span", () => {
  assert.deepEqual(extractJson('prefix {"s": "a } b { c"} suffix'), { s: "a } b { c" });
});

const OK_SCHEMA = obj({ ok: boolean() });

test("extractJson: an inline {mention} ahead of the answer does not mask it", () => {
  const reply = 'I edited `{config}` and `[section]` as asked. Result: {"ok": true}';
  assert.deepEqual(extractJson(reply, OK_SCHEMA), { ok: true });
  assert.deepEqual(extractJson(reply), { ok: true }, "every top-level span is a candidate, not just the first");
});

test("extractJson: a json-tagged block beats an earlier plain block", () => {
  const reply = 'Count:\n```\n42\n```\nAnswer:\n```json\n{"ok": true}\n```';
  assert.deepEqual(extractJson(reply, OK_SCHEMA), { ok: true });
  assert.deepEqual(extractJson(reply), { ok: true });
});

test("extractJson: the first candidate that satisfies the schema wins, whatever its position", () => {
  // The later span parses but is not the answer; the earlier one validates.
  const reply = 'Answer: {"ok": false}. (Earlier I had sent {"draft": 1}.)';
  assert.deepEqual(extractJson(reply, OK_SCHEMA), { ok: false });
  // Among blocks that all validate, the later one (the answer, not the example) wins.
  const twoBlocks = 'Example:\n```json\n{"ok": false}\n```\nMine:\n```json\n{"ok": true}\n```';
  assert.deepEqual(extractJson(twoBlocks, OK_SCHEMA), { ok: true });
});

test("extractJson: with nothing valid, the best parsed candidate comes back for error reporting", () => {
  assert.deepEqual(extractJson('Here: {"ok": "yes"}', OK_SCHEMA), { ok: "yes" });
  assert.equal(extractJson("no json at all", OK_SCHEMA), undefined);
});

test("extractJson: pathological unclosed brackets stay cheap", () => {
  const started = Date.now();
  assert.equal(extractJson("{".repeat(500_000), OK_SCHEMA), undefined);
  assert.deepEqual(extractJson("{}".repeat(100_000) + '{"ok": true}', OK_SCHEMA), { ok: true });
  assert.ok(Date.now() - started < 2000, `extraction took ${Date.now() - started}ms`);
});

test("validate: object required + nested array of strings", () => {
  const schema = obj({ name: string(), tags: array(string()) });
  assert.deepEqual(validate({ name: "x", tags: ["a"] }, schema), []);
  assert.ok(validate({ tags: ["a"] }, schema).some((p) => /name.*missing/.test(p)));
  assert.ok(validate({ name: "x", tags: [1] }, schema).some((p) => /expected string/.test(p)));
});

test("validate: enum membership", () => {
  const s = enumOf("low", "high");
  assert.deepEqual(validate("low", s), []);
  assert.equal(validate("mid", s).length, 1);
});

test("validate: array minItems", () => {
  const s = array(string(), 2);
  assert.equal(validate(["a"], s).length, 1);
  assert.deepEqual(validate(["a", "b"], s), []);
});

test("validate: scalar type mismatches", () => {
  assert.equal(validate(5, string()).length, 1);
  assert.equal(validate("5", { type: "integer" }).length, 1);
  assert.deepEqual(validate(5, { type: "integer" }), []);
  assert.equal(validate(5.5, { type: "integer" }).length, 1);
});

test("describeSchema mentions JSON and embeds the schema", () => {
  const text = describeSchema(obj({ a: string() }));
  assert.match(text, /JSON/);
  assert.match(text, /"type": "object"/);
});

// These cases document the current portability boundary, not full JSON Schema
// conformance. An ignored constraint must not be mistaken for a validated one.
for (const [keyword, constraint] of Object.entries({
  const: { const: "approved" },
  $ref: { $ref: "#/$defs/approved", $defs: { approved: { enum: ["approved"] } } },
  oneOf: { oneOf: [{ enum: ["approved"] }, { enum: ["denied"] }] },
})) {
  test(`validate: unsupported ${keyword} is ignored while a string type still applies`, () => {
    const schema = { type: "string", ...constraint };
    assert.deepEqual(validate("neither", schema), [], `${keyword} is not enforced`);
    assert.ok(validate(42, schema).some((problem) => /expected string/.test(problem)));
  });
}

test("validate: type union arrays are outside the supported single-type subset", () => {
  assert.ok(validate(null, { type: ["string", "null"] }).some((problem) => /unknown schema type/.test(problem)));
  assert.deepEqual(validate(null, { type: "null" }), []);
});

test("validate: object and array constraints require their explicit type", () => {
  const objectConstraints = { required: ["name"] };
  assert.deepEqual(validate({}, objectConstraints), []);
  assert.ok(validate({}, { type: "object", ...objectConstraints }).some((problem) => /name.*missing/.test(problem)));

  const arrayConstraints = { items: { type: "string" }, minItems: 2 };
  assert.deepEqual(validate([1], arrayConstraints), []);
  const problems = validate([1], { type: "array", ...arrayConstraints });
  assert.ok(problems.some((problem) => /expected string/.test(problem)));
  assert.ok(problems.some((problem) => /at least 2/.test(problem)));
});

test("validate: additionalProperties false is enforced but a schema value is not", () => {
  assert.deepEqual(validate({ extra: 42 }, { type: "object", additionalProperties: { type: "string" } }), []);
  assert.ok(validate({ extra: 42 }, { type: "object", additionalProperties: false })
    .some((problem) => /unexpected properties/.test(problem)));
});
