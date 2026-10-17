import { test } from "node:test";
import assert from "node:assert/strict";

import {
  array,
  auditSchema,
  boolean,
  checkedSubset,
  describeSchema,
  enumOf,
  extractJson,
  isStrictSchema,
  pickJson,
  pickStructured,
  number,
  obj,
  string,
  validate,
  type JsonSchema,
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
});

test("pickJson: two different valid values are ambiguous — retried, never guessed", () => {
  // An example next to the answer: neither position is a safe tiebreak.
  const twoBlocks = 'Example:\n```json\n{"ok": false}\n```\nMine:\n```json\n{"ok": true}\n```';
  const pick = pickJson(twoBlocks, OK_SCHEMA);
  assert.equal(pick.value, undefined);
  assert.match(pick.problems[0]!, /2 different JSON values .* exactly one/);
  // The review's case: real findings first, then an inline illustration.
  const findings = { type: "object", required: ["issues"], properties: { issues: { type: "array" } } };
  const reply = 'Result: {"issues": ["race in retry"]} (a clean run would be {"issues": []})';
  assert.equal(pickJson(reply, findings).value, undefined);
  // The same value twice (a fence and its bare span) is not ambiguous.
  const same = 'Here:\n```json\n{"ok": true}\n```';
  assert.deepEqual(pickJson(same, OK_SCHEMA), { value: { ok: true }, problems: [] });
  // A json-tagged fence outranks bare spans in the prose around it.
  const tiered = 'Note {"ok": false} was wrong.\n```json\n{"ok": true}\n```';
  assert.deepEqual(pickJson(tiered, OK_SCHEMA).value, { ok: true });
});

test("pickJson: with nothing valid, the closest candidate's problems are reported", () => {
  const schema = { type: "object", required: ["answer", "confidence"], properties: { answer: { type: "string" }, confidence: { type: "number" } } };
  const pick = pickJson('{"answer": "42"} — see [1]', schema);
  assert.deepEqual(pick.value, { answer: "42" });
  assert.ok(pick.problems.some((p) => /confidence/.test(p)), pick.problems.join("; "));
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

// --- auditSchema: the boundary above, found before a call starts ----------------

/** Each issue as `<kind> <what> at <where>`. */
const issuesOf = (schema: unknown): string[] => auditSchema(schema).map((i) => `${i.kind} ${i.what} at ${i.at}`);

test("auditSchema: the supported subset and annotations pass clean", () => {
  const FINDINGS = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Findings",
    description: "What the review found.",
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        minItems: 0,
        description: "At most ten, the worst first.",
        items: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", examples: ["race in retry"], $comment: "one line" },
            severity: { type: "string", enum: ["low", "medium", "high"], default: "low" },
            line: { type: "integer" },
            fixed: { type: "boolean", deprecated: true },
            note: { type: "null" },
          },
        },
      },
    },
  };
  assert.deepEqual(auditSchema(FINDINGS), []);
  assert.deepEqual(auditSchema(obj({ a: string(), n: number(), tags: array(enumOf("x", "y"), 1) })), []);
  assert.deepEqual(auditSchema({ enum: [1, "a", null] }), [], "enum needs no type");
  assert.deepEqual(auditSchema({ additionalProperties: true }), [], "true is the default: nothing to check");
  assert.deepEqual(auditSchema({ type: "array", items: { type: "string" }, minItems: undefined }), [], "a key set to undefined is absent");
  assert.deepEqual(auditSchema({ type: "string", required: ["x"] }), [], "an object keyword under another type applies to no value");
});

// Every keyword the validator ignores, reported where it sits.
const UNCHECKED: Array<[string, unknown]> = [
  ['"const"', { type: "string", const: "approved" }],
  ['"$ref"', { $ref: "#/$defs/approved", $defs: { approved: { enum: ["approved"] } } }],
  ['"oneOf"', { oneOf: [{ enum: ["approved"] }, { enum: ["denied"] }] }],
  ['"anyOf"', { anyOf: [{ type: "string" }, { type: "null" }] }],
  ['"allOf"', { allOf: [{ type: "string" }] }],
  ['"not"', { not: { enum: ["x"] } }],
  ['"if"', { if: { type: "string" } }],
  ['"pattern"', { type: "string", pattern: "^[a-z]+$" }],
  ['"format"', { type: "string", format: "email" }],
  ['"minLength"', { type: "string", minLength: 1 }],
  ['"maxLength"', { type: "string", maxLength: 80 }],
  ['"minimum"', { type: "number", minimum: 0 }],
  ['"exclusiveMaximum"', { type: "integer", exclusiveMaximum: 10 }],
  ['"multipleOf"', { type: "integer", multipleOf: 5 }],
  ['"maxItems"', { type: "array", items: { type: "string" }, maxItems: 6 }],
  ['"uniqueItems"', { type: "array", uniqueItems: true }],
  ['"contains"', { type: "array", contains: { type: "string" } }],
  ['"patternProperties"', { type: "object", patternProperties: { "^x-": { type: "string" } } }],
  ['"propertyNames"', { type: "object", propertyNames: { pattern: "^[a-z]+$" } }],
  ['"minProperties"', { type: "object", minProperties: 1 }],
  ['"dependentRequired"', { type: "object", dependentRequired: { a: ["b"] } }],
  ['a type union ["string","null"]', { type: ["string", "null"] }],
  ['a schema-valued "additionalProperties"', { type: "object", additionalProperties: { type: "string" } }],
  ['"items" as a list (a tuple)', { type: "array", items: [{ type: "string" }, { type: "number" }] }],
  ["a boolean schema (true)", true],
  ["a boolean schema (false)", false],
  ['"required" without "type": "object"', { required: ["name"] }],
  ['"properties" without "type": "object"', { properties: { name: { type: "string" } } }],
  ['"additionalProperties" without "type": "object"', { additionalProperties: false }],
  ['"items" without "type": "array"', { items: { type: "string" } }],
  ['"minItems" without "type": "array"', { minItems: 2 }],
];
for (const [what, field] of UNCHECKED) {
  test(`auditSchema: ${what} is reported unchecked, where it sits`, () => {
    assert.deepEqual(issuesOf({ type: "object", properties: { field } }), [`unchecked ${what} at #/properties/field`]);
  });
}

test("auditSchema: inside something unchecked only a typo is reported again; under a type union all is", () => {
  // Removing the oneOf removes its branches, but a typo would go unchecked by any validator.
  assert.deepEqual(issuesOf({ oneOf: [{ const: "a" }, { type: "string", pattern: "x", requird: [] }] }), [
    'unchecked "oneOf" at #',
    'invalid unknown keyword "requird" (did you mean "required"?) at #/oneOf/1',
  ]);
  assert.deepEqual(issuesOf({ type: "array", items: [{ format: "uri" }] }), ['unchecked "items" as a list (a tuple) at #']);
  // A union's object keywords still apply once the union is a single type: what they hold is reported.
  assert.deepEqual(issuesOf({ type: ["object", "null"], properties: { id: { type: "string", pattern: "^x" } } }), [
    'unchecked a type union ["object","null"] at #',
    'unchecked "pattern" at #/properties/id',
  ]);
  // A pointer escapes "~" and "/" in property names.
  assert.deepEqual(issuesOf({ type: "object", properties: { "a/b~c": { const: 1 } } }), ['unchecked "const" at #/properties/a~1b~0c']);
});

test("auditSchema: what nothing could check is invalid — typos, unknown types, malformed keywords", () => {
  assert.deepEqual(
    issuesOf({
      type: "object",
      properties: { a: { type: "strin" }, b: { type: "int" }, c: { tpye: "string" }, d: "string", e: { nullable: true } },
      required: "a",
      requried: ["a"],
    }),
    [
      'invalid unknown type "strin" (did you mean "string"?) at #/properties/a',
      'invalid unknown type "int" (did you mean "integer"?) at #/properties/b',
      'invalid unknown keyword "tpye" (did you mean "type"?) at #/properties/c',
      "invalid a schema that is a string, not an object at #/properties/d",
      'invalid unknown keyword "nullable" at #/properties/e',
      'invalid "required" that is not a list of property names at #',
      'invalid unknown keyword "requried" (did you mean "required"?) at #',
    ],
  );
  assert.deepEqual(issuesOf({ enum: "a" }), ['invalid "enum" that is not a list at #']);
  assert.deepEqual(issuesOf({ type: "array", minItems: -1 }), ['invalid "minItems" that is not a whole number of 0 or more at #']);
  assert.deepEqual(issuesOf({ type: "object", properties: [] }), ['invalid "properties" that is not an object of schemas at #']);
  assert.deepEqual(issuesOf({ type: "array", items: "string" }), ['invalid "items" that is not a schema or a list of schemas at #']);
  assert.deepEqual(issuesOf({ type: ["string", "nul"] }), [
    'invalid "type" that is not one of object, array, string, integer, number, boolean, null (or a list of them) at #',
  ]);
  assert.deepEqual(issuesOf("string"), ["invalid a schema that is a string, not an object at #"]);
  // Names an object inherits are no keywords or types either.
  assert.deepEqual(issuesOf({ type: "constructor", toString: 1 }), [
    'invalid unknown type "constructor" at #',
    'invalid unknown keyword "toString" at #',
  ]);
  assert.deepEqual(issuesOf(JSON.parse('{"type": "object", "__proto__": {"const": 1}}')), ['invalid unknown keyword "__proto__" at #']);
});

test("checkedSubset keeps exactly what validate() checks, so a CLI can enforce the rest", () => {
  const schema = {
    type: "object",
    required: ["status", "n"],
    additionalProperties: false,
    properties: {
      status: { oneOf: [{ const: "open" }, { const: "closed" }], description: "d" },
      n: { type: ["integer", "null"] },
      tags: { type: "array", items: { type: "string", pattern: "^t" }, minItems: 1, maxItems: 3 },
      any: true,
    },
  };
  assert.deepEqual(checkedSubset(schema), {
    type: "object",
    required: ["status", "n"],
    additionalProperties: false,
    properties: { status: {}, n: {}, tags: { type: "array", items: { type: "string" }, minItems: 1 }, any: {} },
  });
  assert.deepEqual(auditSchema(checkedSubset(schema)), [], "the subset is all checked");
  // It validates what it can and never trips on the rest.
  assert.deepEqual(validate({ status: "zzz", n: null, tags: ["x"], any: 1 }, checkedSubset(schema)), []);
  const problems = validate({ status: "open", n: 1, tags: [], extra: 1 }, checkedSubset(schema));
  assert.deepEqual(problems, ["$.tags: expected at least 1 items, got 0", '$: unexpected properties ["extra"]']);
  // The whole schema would fail every reply on its type union.
  assert.ok(validate({ status: "open", n: null, tags: ["x"] }, schema as JsonSchema).some((p) => /unknown schema type/.test(p)));
});

test("isStrictSchema: an object at the root, every object closed and requiring all its properties", () => {
  const strict = {
    type: "object",
    additionalProperties: false,
    required: ["a", "b"],
    properties: {
      a: { type: "string" },
      b: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["c"], properties: { c: { type: ["number", "null"] } } },
      },
    },
  };
  assert.equal(isStrictSchema(strict), true);
  assert.equal(isStrictSchema({ ...strict, required: ["a"] }), false, "an optional property");
  assert.equal(isStrictSchema({ ...strict, additionalProperties: undefined }), false, "an open object");
  const openInside = structuredClone(strict) as { properties: { b: { items: Record<string, unknown> } } };
  delete openInside.properties.b.items.additionalProperties;
  assert.equal(isStrictSchema(openInside), false, "an open object inside");
  assert.equal(isStrictSchema({ type: "array", items: { type: "string" } }), false, "an array at the root");
  assert.equal(isStrictSchema({ type: "object", additionalProperties: false }), true, "a closed object with no properties");
  const branch = { anyOf: [{ type: "object", properties: { y: { type: "string" } } }, { type: "null" }] };
  assert.equal(isStrictSchema({ type: "object", additionalProperties: false, required: ["x"], properties: { x: branch } }), false);
});

test("pickStructured: the CLI's own value first, a JSON string read as a reply, the text last", () => {
  const schema = obj({ ok: boolean() });
  assert.deepEqual(pickStructured({ ok: true }, "prose without JSON", schema), { value: { ok: true }, problems: [] });
  assert.deepEqual(pickStructured('{"ok": true}', "prose", schema), { value: { ok: true }, problems: [] });
  assert.deepEqual(pickStructured(undefined, 'Sure: {"ok": false}', schema), { value: { ok: false }, problems: [] });
  assert.deepEqual(pickStructured("plain", "x", string()), { value: "plain", problems: [] }, "a string schema takes a string as is");
  // A value that fails the schema gives way to a valid one in the text.
  assert.deepEqual(pickStructured({ ok: "yes" }, '{"ok": true}', schema), { value: { ok: true }, problems: [] });
  // Nothing valid: the handed-over value is what the retry is about.
  const pick = pickStructured({ ok: "yes" }, "no json", schema);
  assert.deepEqual(pick, { value: { ok: "yes" }, problems: ["$.ok: expected boolean, got string"] });
  assert.deepEqual(pickStructured('{"ok": 1}', "", schema).problems, ["$.ok: expected boolean, got integer"]);
});
