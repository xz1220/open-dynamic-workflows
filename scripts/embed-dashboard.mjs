#!/usr/bin/env node
/**
 * Embed the dashboard HTML into a TypeScript string constant.
 *
 * The SEA binary has no files on disk and the npm package ships only `dist/`, so
 * the dashboard cannot be `readFileSync`'d at runtime. Instead we inline it as a
 * plain string in `src/dashboard.generated.ts`: `tsc` emits it into `dist/`, and
 * esbuild bundles it straight into the single-file binary. JSON.stringify gives
 * a normal double-quoted literal, so the HTML's own backticks/`${}` are inert.
 *
 * Source preference: the built read-only client SPA (`web/dist/index.html`) when
 * present, else the legacy single-file `src/dashboard.html`. This keeps the
 * "one bundle, two hosts" promise — `odw serve` and the SEA binary both embed the
 * SAME artifact — while letting a checkout without a web build still serve.
 *
 * Run by `npm run build` (before tsc). Commit the generated file so `npm test`
 * (tsx, no build step) and a plain `dist/` build both work without re-running.
 *
 * Usage: node scripts/embed-dashboard.mjs
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const spa = `${root}web/dist/index.html`;
const legacy = `${root}src/dashboard.html`;
const src = existsSync(spa) ? spa : legacy;
const sourceLabel = src === spa ? "web/dist/index.html (read-only client SPA)" : "src/dashboard.html";
const out = `${root}src/dashboard.generated.ts`;

const html = readFileSync(src, "utf8");
const banner =
  "/**\n" +
  " * GENERATED FILE — do not edit by hand.\n" +
  ` * Source: ${sourceLabel} · regenerate: node scripts/embed-dashboard.mjs\n` +
  " */\n\n";

writeFileSync(out, `${banner}export const DASHBOARD_HTML = ${JSON.stringify(html)};\n`, "utf8");
console.error(`embedded ${html.length} bytes from ${sourceLabel} → src/dashboard.generated.ts`);
