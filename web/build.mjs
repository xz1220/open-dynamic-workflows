#!/usr/bin/env node
/**
 * Build the read-only client SPA into ONE self-contained index.html.
 *
 * esbuild (a build-only devDependency of the root package — resolved up the tree)
 * bundles the vanilla-TS app to a single IIFE; the CSS and JS are inlined into
 * the HTML shell so the output is a zero-dependency file the existing
 * `scripts/embed-dashboard.mjs` pipeline can inline into `odw serve` and the SEA
 * binary — same promise as the rest of the engine: no runtime deps, no CDN.
 *
 * Usage: node web/build.mjs   (run from anywhere; paths are module-relative)
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = `${root}dist`;
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [`${root}src/main.ts`],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  write: false,
});
const js = result.outputFiles[0].text;
const css = readFileSync(`${root}src/theme.css`, "utf8");
const tmpl = readFileSync(`${root}index.html`, "utf8");

// Function replacers so `$` sequences in the css/js are inserted verbatim.
const html = tmpl.replace("/*INLINE_CSS*/", () => css).replace("/*INLINE_JS*/", () => js);
writeFileSync(`${outDir}/index.html`, html, "utf8");
console.error(`built web client → ${outDir}/index.html (${html.length} bytes)`);
