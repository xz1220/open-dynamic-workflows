#!/usr/bin/env node
/**
 * Schema-satisfying mock agent.
 *
 * Reads a prompt from stdin. When the bridge has appended a JSON Schema (the
 * structured-output contract), this extracts it and prints a minimal *valid*
 * instance — so any schema-driven workflow (e.g. deep-research.js) runs
 * end-to-end without real model or web calls. With no schema it echoes a stub
 * reply. Used only by the test suite.
 */

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const schema = extractSchema(input);
  const value = schema ? generate(schema) : "mock reply";
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
});

function extractSchema(text) {
  const marker = "JSON Schema:";
  const at = text.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = text.slice(at + marker.length);
  const start = rest.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(rest.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

let counter = 0;
function token() {
  const n = counter++;
  return n.toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
}

function generate(schema) {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case "object": {
      const out = {};
      for (const [key, sub] of Object.entries(schema.properties || {})) out[key] = generate(sub);
      return out;
    }
    case "array": {
      const count = Math.max(schema.minItems || 0, 2);
      const items = schema.items || { type: "string" };
      return Array.from({ length: count }, () => generate(items));
    }
    case "number":
      return 0.5;
    case "integer":
      return 1;
    case "boolean":
      return false;
    case "string":
    default:
      return "mock-" + token();
  }
}
