import { test } from "node:test";
import assert from "node:assert/strict";

import { array, describeSchema, enumOf, extractJson, number, obj, string, validate } from "../src/schema.js";

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
