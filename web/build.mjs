#!/usr/bin/env node
/**
 * Build the client SPA into ONE self-contained web/dist/index.html (see
 * bundle.mjs). `scripts/embed-dashboard.mjs` then inlines it into `odw serve`
 * and the SEA binary.
 *
 * Usage: node web/build.mjs   (run from anywhere; paths are module-relative)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { bundleHtml, webRoot } from "./bundle.mjs";

const outDir = `${webRoot}dist`;
mkdirSync(outDir, { recursive: true });
const html = await bundleHtml({ minify: true });
writeFileSync(`${outDir}/index.html`, html, "utf8");
console.error(`built web client → ${outDir}/index.html (${html.length} bytes)`);
