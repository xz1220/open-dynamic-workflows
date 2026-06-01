/**
 * Workflow worker (L5) — STUB (M5).
 *
 * The back end. It runs in its own Node process (started by the launcher), so
 * the workflow holds its entire plan in local variables while only the final
 * return value is written back to the run directory. Exactly one run executes
 * per worker process.
 *
 * It loads the script source, hands it to the loader/transform, builds the run
 * context, injects the primitives, runs the transformed body to its `return`,
 * and persists the result (or the failure).
 */

import { pathToFileURL } from "node:url";
import { notImplemented } from "../errors.js";

export async function executeRun(_runDir: string): Promise<string> {
  throw notImplemented("worker (M5)");
}

async function main(argv: string[]): Promise<number> {
  if (argv.length !== 1) {
    process.stderr.write("usage: node dist/runtime/worker.js <run_dir>\n");
    return 2;
  }
  await executeRun(argv[0]!);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
