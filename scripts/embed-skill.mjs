#!/usr/bin/env node
/**
 * Embed the workflow-dialect doc (skill/SKILL.md) into a TypeScript constant.
 *
 * The built-in generate-workflow needs the authoritative dialect documentation
 * as prompt context (`args.dialectDoc`), and the SEA binary has no repo files
 * to read at runtime — same constraint and same answer as the dashboard:
 * inline it as a string in `src/skill.generated.ts` at build time, keeping
 * skill/SKILL.md the single source of truth.
 *
 * Run by `npm run embed` (with embed-dashboard). Commit the generated file so
 * `npm test` (tsx, no build step) works without re-running.
 *
 * Usage: node scripts/embed-skill.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = `${root}skill/SKILL.md`;
const out = `${root}src/skill.generated.ts`;

const md = readFileSync(src, "utf8");
const banner =
  "/**\n" +
  " * GENERATED FILE — do not edit by hand.\n" +
  " * Source: skill/SKILL.md · regenerate: node scripts/embed-skill.mjs\n" +
  " */\n\n";

writeFileSync(out, `${banner}export const SKILL_MD = ${JSON.stringify(md)};\n`, "utf8");
console.error(`embedded ${md.length} bytes from skill/SKILL.md → src/skill.generated.ts`);
