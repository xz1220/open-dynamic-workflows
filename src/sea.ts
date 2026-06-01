/**
 * Single Executable Application (SEA) detection.
 *
 * When `odw` ships as a compiled binary (Node.js SEA + postject), there is no
 * `node` on PATH and no `.js` files on disk: the runtime and our bundled code
 * live *inside* the executable. Two things must adapt to that — the entrypoint
 * guard in `cli.ts` and the detached-worker spawn in `runtime/launcher.ts` — so
 * both ask this helper which world they are in.
 *
 * `node:sea` only carries meaning inside a SEA; elsewhere `isSea()` is `false`.
 * We resolve it via `createRequire(execPath)` rather than `import.meta.url` so it
 * works identically whether this module runs as ESM (dev / tests) or as the CJS
 * bundle baked into the binary, where `import.meta.url` is not a real path.
 */

import { createRequire } from "node:module";
import { execPath } from "node:process";

let cached: boolean | undefined;

export function isSeaBinary(): boolean {
  if (cached !== undefined) return cached;
  try {
    const sea = createRequire(execPath)("node:sea") as { isSea(): boolean };
    cached = sea.isSea();
  } catch {
    cached = false;
  }
  return cached;
}
