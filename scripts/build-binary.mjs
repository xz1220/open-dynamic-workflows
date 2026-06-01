#!/usr/bin/env node
/**
 * Build a self-contained `odw` binary — a Node.js Single Executable Application.
 *
 * The output is one file that embeds the Node runtime + our bundled code, so an
 * end user installs nothing (no Node, no npm, no PATH gymnastics): download,
 * `chmod +x`, run — the same shape as a Go/Rust binary. The five steps mirror
 * the standard SEA recipe:
 *
 *   1. bundle   dist/ (ESM, zero deps) → one CommonJS file        [esbuild]
 *   2. blob     generate the SEA blob from a config               [node --experimental-sea-config]
 *   3. inject   copy the node binary and graft the blob into it   [postject]
 *   4. sign     re-sign the patched Mach-O so macOS will run it   [codesign, ad-hoc]
 *   5. verify   launch it and check `--version`
 *
 * esbuild + postject are devDependencies (build-only); the shipped binary and the
 * npm package keep zero *runtime* dependencies.
 *
 * Usage:  node scripts/build-binary.mjs   (run `npm run build` first)
 */

import { build as esbuild } from "esbuild";
import { inject } from "postject";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execPath, platform } from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const buildDir = join(root, "build");
const bundle = join(buildDir, "odw.cjs");
const blob = join(buildDir, "odw.blob");
const seaConfig = join(buildDir, "sea-config.json");
const isWin = platform === "win32";
const isMac = platform === "darwin";
const out = join(buildDir, isWin ? "odw.exe" : "odw");

// The fuse + segment names Node looks for when reading its embedded SEA blob.
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const MACHO_SEGMENT = "NODE_SEA";

const step = (n, msg) => console.error(`\x1b[36m[${n}/5]\x1b[0m ${msg}`);

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

// 1. bundle dist/ → a single CommonJS file (SEA runs the main as CJS)
step(1, "bundling dist/ → build/odw.cjs (esbuild)");
await esbuild({
  entryPoints: [join(root, "dist/cli.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: bundle,
  logLevel: "error",
  // node builtins (node:*) stay external — they live in the embedded runtime
});

// 2. generate the SEA blob
step(2, "generating SEA blob (node --experimental-sea-config)");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
);
execFileSync(execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3. copy the node binary and inject the blob
step(3, `copying node runtime + injecting blob (postject) → ${out.replace(root + "/", "")}`);
copyFileSync(execPath, out);
if (isMac) {
  // strip the inherited signature so postject can rewrite the Mach-O, then we re-sign
  try {
    execFileSync("codesign", ["--remove-signature", out], { stdio: "ignore" });
  } catch {
    /* unsigned to begin with — fine */
  }
}
await inject(out, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: SENTINEL,
  ...(isMac ? { machoSegmentName: MACHO_SEGMENT } : {}),
});

// 4. re-sign (ad-hoc) so macOS Gatekeeper will let the patched binary run locally.
//    A release pipeline replaces "-" with a real Developer ID + notarization.
if (isMac) {
  step(4, "ad-hoc codesign");
  execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });
} else {
  step(4, "skip signing (not macOS)");
}
chmodSync(out, 0o755);

// 5. verify it launches
step(5, "verifying the binary runs");
const version = execFileSync(out, ["--version"], { encoding: "utf8" }).trim();
const sizeMB = (statSync(out).size / 1024 / 1024).toFixed(1);
console.error(`\x1b[32m✓\x1b[0m built ${out}  (${sizeMB} MB)  →  ${version}`);
