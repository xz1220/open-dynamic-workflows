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
 * Source: the built client SPA, `web/dist/index.html` (`npm run build:web`). There
 * is deliberately no fallback: embedding anything else would silently replace the
 * committed dashboard with a different one, so a missing build is an error. This
 * keeps the "one bundle, two hosts" promise — `odw serve` and the SEA binary both
 * embed the SAME artifact.
 *
 * Run by `npm run build` (after build:web, before tsc). Commit the generated file
 * so `npm test` (tsx, no build step) works without re-running; CI rebuilds it and
 * fails if the committed copy has drifted from web/.
 *
 * Usage: node scripts/embed-dashboard.mjs
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = `${root}web/dist/index.html`;
const out = `${root}src/dashboard.generated.ts`;

if (!existsSync(src)) {
  console.error(
    "embed-dashboard: web/dist/index.html not found — build the client first with `npm run build:web`\n" +
      "(`npm run build` does both); src/dashboard.generated.ts was left unchanged",
  );
  process.exit(1);
}

const html = readFileSync(src, "utf8");
const banner =
  "/**\n" +
  " * GENERATED FILE — do not edit by hand.\n" +
  " * Source: web/dist/index.html (client SPA) · regenerate: node scripts/embed-dashboard.mjs\n" +
  " */\n\n";

// The explicit `: string` keeps tsc from also emitting the whole page as a
// literal *type* into dist/dashboard.generated.d.ts (doubling it in the package).
writeFileSync(out, `${banner}export const DASHBOARD_HTML: string = ${JSON.stringify(html)};\n`, "utf8");
console.error(`embedded ${html.length} bytes from web/dist/index.html (client SPA) → src/dashboard.generated.ts`);
