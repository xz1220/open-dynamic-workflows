/**
 * The smallest value a JSON Schema accepts (an ODW extension): what a dry
 * run's agents answer a schema call with (`odw run --dry`, a test's
 * `{ "dry": true }` reply), so the workflow goes on past every agent() as if
 * it had been answered — with nothing in it.
 *
 * Minimal means: an object with its required properties only, an array of
 * `minItems` items, an empty string (or `minLength` of "x"), the lowest number
 * the bounds allow, false, null. `const` and `enum` give their (first) value;
 * `anyOf`/`oneOf` their first branch, `allOf` its branches merged; a local
 * `$ref` (`#/definitions/…`, `#/$defs/…`) is followed. A `pattern` or `format`
 * is not solved for: a string under one is "", unless the format is one this
 * knows a sample of (date-time, date, email, uri, uuid, …).
 */

import type { JsonSchema } from "../schema.js";

/** How deep a self-referencing schema is followed before it is cut short with null. */
const MAX_DEPTH = 32;

/** The smallest value `schema` accepts (see the module comment). */
export function placeholderFor(schema: unknown): unknown {
  return place(schema, isRecord(schema) ? schema : {}, 0);
}

function place(raw: unknown, root: JsonSchema, depth: number): unknown {
  if (!isRecord(raw) || depth > MAX_DEPTH) return null;
  let schema: JsonSchema = raw;
  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref);
    return target ? place(target, root, depth + 1) : null;
  }
  if ("const" in schema) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) schema = mergeAll(schema, root, depth);
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      const rest = { ...schema };
      delete rest[key];
      return place({ ...rest, ...(branches[0] as JsonSchema) }, root, depth + 1);
    }
  }
  const type = typeOf(schema);
  switch (type) {
    case "object":
      return placeObject(schema, root, depth);
    case "array": {
      const n = Math.max(0, intOf(schema.minItems) ?? 0);
      const items = Array.isArray(schema.prefixItems) ? schema.prefixItems : null;
      return Array.from({ length: Math.max(n, 0) }, (_, i) => place(items?.[i] ?? schema.items ?? {}, root, depth + 1));
    }
    case "string":
      return placeString(schema);
    case "integer":
    case "number":
      return placeNumber(schema, type === "integer");
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

function placeObject(schema: JsonSchema, root: JsonSchema, depth: number): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const out: Record<string, unknown> = {};
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
  for (const key of required) out[key] = place(properties[key] ?? {}, root, depth + 1);
  // minProperties past the required ones: the declared properties next, in order.
  const min = intOf(schema.minProperties) ?? 0;
  for (const key of Object.keys(properties)) {
    if (Object.keys(out).length >= min) break;
    if (!(key in out)) out[key] = place(properties[key], root, depth + 1);
  }
  return out;
}

/** Samples of the formats a string schema may name. */
const FORMAT_SAMPLES: Record<string, string> = {
  "date-time": "1970-01-01T00:00:00Z",
  date: "1970-01-01",
  time: "00:00:00Z",
  email: "dry-run@example.com",
  "idn-email": "dry-run@example.com",
  uri: "https://example.com/",
  "uri-reference": "https://example.com/",
  iri: "https://example.com/",
  url: "https://example.com/",
  hostname: "example.com",
  "idn-hostname": "example.com",
  ipv4: "127.0.0.1",
  ipv6: "::1",
  uuid: "00000000-0000-0000-0000-000000000000",
  duration: "PT0S",
};

function placeString(schema: JsonSchema): string {
  const sample = typeof schema.format === "string" ? FORMAT_SAMPLES[schema.format] : undefined;
  if (sample !== undefined) return sample;
  const min = intOf(schema.minLength) ?? 0;
  return "x".repeat(Math.max(0, min));
}

function placeNumber(schema: JsonSchema, integer: boolean): number {
  const min = num(schema.minimum);
  const exMin = num(schema.exclusiveMinimum);
  const max = num(schema.maximum);
  const exMax = num(schema.exclusiveMaximum);
  const step = num(schema.multipleOf);
  let value = 0;
  if (min !== null && value < min) value = min;
  if (exMin !== null && value <= exMin) value = integer ? Math.floor(exMin) + 1 : exMin + (step ?? 1);
  if (max !== null && value > max) value = max;
  if (exMax !== null && value >= exMax) value = integer ? Math.ceil(exMax) - 1 : exMax - (step ?? 1);
  if (integer) value = Math.ceil(value);
  if (step !== null && step > 0 && value % step !== 0) value = Math.ceil(value / step) * step;
  return value;
}

/** The schema's type: its `type` (the first non-null one of a list), else what its keywords imply. */
function typeOf(schema: JsonSchema): string | null {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const named = type.filter((t): t is string => typeof t === "string");
    return named.find((t) => t !== "null") ?? named[0] ?? null;
  }
  if (isRecord(schema.properties) || Array.isArray(schema.required)) return "object";
  if (schema.items !== undefined || schema.minItems !== undefined) return "array";
  if (schema.minLength !== undefined || schema.pattern !== undefined || schema.format !== undefined) return "string";
  if (schema.minimum !== undefined || schema.maximum !== undefined) return "number";
  return null;
}

/** `allOf` folded into one schema: properties merged, required lists joined, the rest the last branch's. */
function mergeAll(schema: JsonSchema, root: JsonSchema, depth: number): JsonSchema {
  const merged: JsonSchema = { ...schema };
  delete merged.allOf;
  const properties: Record<string, unknown> = isRecord(schema.properties) ? { ...schema.properties } : {};
  const required = new Set<string>(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  for (const raw of schema.allOf as unknown[]) {
    let branch = raw;
    if (isRecord(branch) && typeof branch.$ref === "string" && depth < MAX_DEPTH) branch = resolveRef(root, branch.$ref) ?? {};
    if (!isRecord(branch)) continue;
    const { properties: p, required: r, ...rest } = branch;
    Object.assign(merged, rest);
    if (isRecord(p)) Object.assign(properties, p);
    if (Array.isArray(r)) for (const key of r) if (typeof key === "string") required.add(key);
  }
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

/** A local `$ref` (`#`, `#/definitions/x`, `#/$defs/x`, any `#/a/b` pointer); null when it leads nowhere. */
function resolveRef(root: JsonSchema, ref: string): JsonSchema | null {
  if (!ref.startsWith("#")) return null;
  let at: unknown = root;
  for (const raw of ref.slice(1).split("/").filter((s) => s !== "")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(at) || !(key in at)) return null;
    at = at[key];
  }
  return isRecord(at) ? at : null;
}

function intOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
