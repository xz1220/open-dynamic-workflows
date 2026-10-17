#!/usr/bin/env node
/**
 * A mock CLI that takes a JSON Schema natively, the two ways the built-ins do:
 * `--json-schema <json>` (inline, as Claude Code) answered as stream-json whose
 * result event carries `structured_output`, and `--output-schema <file>` (a
 * file, as Codex) answered as the JSON text alone. It reads its prompt on
 * stdin and answers with a minimal value valid against the schema.
 *
 * It fails when the prompt also describes the schema (a CLI handed the schema
 * natively is not told twice) or when it was handed none. With `--report` it
 * prints, on stderr, the path it read a schema file from. Used only by the
 * test suite.
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const inline = valueOf("--json-schema");
const file = valueOf("--output-schema");

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (prompt.includes("JSON Schema:")) fail("the prompt describes a schema this CLI was handed natively");
  if (inline !== undefined) {
    const value = generate(JSON.parse(inline));
    const events = [
      { type: "system", subtype: "init", session_id: "mock" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done: the answer is in structured_output.",
        structured_output: value,
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.001,
        session_id: "mock",
      },
    ];
    process.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  } else if (file !== undefined) {
    if (args.includes("--report")) process.stderr.write(`schema file: ${file}\n`);
    process.stdout.write(JSON.stringify(generate(JSON.parse(readFileSync(file, "utf8")))));
  } else {
    fail("no schema was handed over");
  }
});

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(3);
}

/** A minimal instance of the schema: the first of each choice, every property, the fewest items. */
function generate(schema) {
  if (schema === true || schema === false || schema === null || typeof schema !== "object") return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(schema[key]) && schema[key].length) return generate(schema[key][0]);
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out = {};
      for (const [key, sub] of Object.entries(schema.properties || {})) out[key] = generate(sub);
      return out;
    }
    case "array":
      return Array.from({ length: schema.minItems || 1 }, () => generate(schema.items || { type: "string" }));
    case "number":
      return 0.5;
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return "mock";
  }
}
