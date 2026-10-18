#!/usr/bin/env node
/**
 * Embed the `odw new` templates into a TypeScript module.
 *
 * Like the dashboard (./embed-dashboard.mjs), the templates must work from the
 * SEA binary and the npm package, neither of which has the repository's
 * examples/ or templates/ on disk — so each template's workflow, starter test
 * and (for some) eval skeleton is inlined as a string in
 * `src/templates.generated.ts`, which tsc emits into dist/ and esbuild bundles.
 *
 * Source: `templates/index.json`, a list of { name, description, workflow,
 * test, eval? } whose file fields are paths from the repository root — a
 * workflow is usually the example of the same name, so the two never drift. A
 * missing or malformed source is an error, never a silent fallback.
 *
 * Run by `npm run build` (the `embed` step). Commit the generated file; CI
 * rebuilds it and fails if the committed copy has drifted from its sources.
 *
 * Usage: node scripts/embed-templates.mjs
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const index = `${root}templates/index.json`;
const out = `${root}src/templates.generated.ts`;

function fail(message) {
  console.error(`embed-templates: ${message}; src/templates.generated.ts was left unchanged`);
  process.exit(1);
}

if (!existsSync(index)) fail("templates/index.json not found");
let list;
try {
  list = JSON.parse(readFileSync(index, "utf8"));
} catch (err) {
  fail(`templates/index.json: ${err.message}`);
}
if (!Array.isArray(list) || list.length === 0) fail("templates/index.json must be a non-empty array");

const read = (name, field, rel) => {
  if (typeof rel !== "string" || rel === "") fail(`template '${name}': '${field}' must be a path`);
  const file = `${root}${rel}`;
  if (!existsSync(file)) fail(`template '${name}': ${field} ${rel} not found`);
  return readFileSync(file, "utf8");
};

const seen = new Set();
const templates = list.map((t) => {
  if (!t || typeof t.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(t.name)) fail(`bad template name ${JSON.stringify(t?.name)}`);
  if (seen.has(t.name)) fail(`template '${t.name}' is listed twice`);
  seen.add(t.name);
  if (typeof t.description !== "string" || t.description === "") fail(`template '${t.name}': no description`);
  for (const key of Object.keys(t)) {
    if (!["name", "description", "workflow", "test", "eval"].includes(key)) fail(`template '${t.name}': unknown key '${key}'`);
  }
  return {
    name: t.name,
    description: t.description,
    workflow: read(t.name, "workflow", t.workflow),
    test: read(t.name, "test", t.test),
    eval: t.eval === undefined ? null : read(t.name, "eval", t.eval),
  };
});

const banner =
  "/**\n" +
  " * GENERATED FILE — do not edit by hand.\n" +
  " * Source: templates/index.json (+ the files it names) · regenerate: node scripts/embed-templates.mjs\n" +
  " */\n\n";
// The explicit type keeps tsc from emitting every file as a literal type into the .d.ts.
const body =
  "export interface EmbeddedTemplate {\n" +
  "  name: string;\n" +
  "  description: string;\n" +
  "  workflow: string;\n" +
  "  test: string;\n" +
  "  eval: string | null;\n" +
  "}\n\n" +
  `export const TEMPLATES: readonly EmbeddedTemplate[] = ${JSON.stringify(templates, null, 2)};\n`;
writeFileSync(out, banner + body, "utf8");
console.error(`embedded ${templates.length} templates from templates/index.json → src/templates.generated.ts`);
