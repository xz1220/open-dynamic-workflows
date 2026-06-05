#!/usr/bin/env node
/**
 * Stage the `odw` binary as a Tauri sidecar.
 *
 * Tauri requires an `externalBin` to be named with the Rust host target triple
 * (e.g. `odw-aarch64-apple-darwin`). This copies the single-file binary produced
 * by the runtime's `npm run build:binary` into `src-tauri/binaries/` under that
 * name, so `tauri build`/`tauri dev` can find and embed it.
 *
 * Build the runtime binary first (from the repo root):
 *     npm run build:binary        # → ./odw (or dist target — see scripts/build-binary.mjs)
 *
 * Then, from apps/desktop:
 *     node scripts/bundle-sidecar.mjs [path/to/odw]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

// Resolve the host target triple the way Tauri expects.
function hostTriple() {
  try {
    const out = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
    const m = out.match(/host:\s*(\S+)/);
    if (m) return m[1];
  } catch {
    /* rustc not on PATH — fall through to a platform guess */
  }
  // Best-effort fallback for common macOS dev machines.
  return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
}

const triple = hostTriple();
const src =
  process.argv[2] ??
  [join(repoRoot, "odw"), join(repoRoot, "dist", "odw"), join(repoRoot, "build", "odw")].find((p) =>
    existsSync(p),
  );

if (!src || !existsSync(src)) {
  console.error(
    "could not find the odw binary. Build it first from the repo root:\n" +
      "  npm run build:binary\n" +
      "then re-run, optionally passing the path: node scripts/bundle-sidecar.mjs <path/to/odw>",
  );
  process.exit(1);
}

const outDir = join(desktopRoot, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `odw-${triple}`);
copyFileSync(src, dest);
console.error(`staged sidecar: ${src} → ${dest}`);
