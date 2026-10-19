#!/usr/bin/env node
/**
 * Embed the workflow dialect's declarations into a TypeScript module.
 *
 * Like the templates (./embed-templates.mjs), `odw types` must work from the
 * SEA binary, which has no types/ directory on disk — so `types/workflow.d.ts`
 * is inlined as a string in `src/types.generated.ts`, which tsc emits into
 * dist/ and esbuild bundles. A missing or empty source is an error, never a
 * silent fallback.
 *
 * Run by `npm run build` (the `embed` step). Commit the generated file; CI
 * rebuilds it and fails if the committed copy has drifted from its source.
 *
 * Usage: node scripts/embed-types.mjs
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = `${root}types/workflow.d.ts`;
const out = `${root}src/types.generated.ts`;

function fail(message) {
  console.error(`embed-types: ${message}; src/types.generated.ts was left unchanged`);
  process.exit(1);
}

if (!existsSync(source)) fail("types/workflow.d.ts not found");
const text = readFileSync(source, "utf8");
if (text.trim() === "") fail("types/workflow.d.ts is empty");
if (!text.includes("declare global")) fail("types/workflow.d.ts declares no globals");

const banner =
  "/**\n" +
  " * GENERATED FILE — do not edit by hand.\n" +
  " * Source: types/workflow.d.ts · regenerate: node scripts/embed-types.mjs\n" +
  " */\n\n";
const body = `export const WORKFLOW_DTS: string = ${JSON.stringify(text)};\n`;
writeFileSync(out, banner + body, "utf8");
console.error("embedded types/workflow.d.ts → src/types.generated.ts");
