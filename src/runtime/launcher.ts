/**
 * Start runs in the background and wait on them (L5).
 *
 * `startRun` is fire-and-forget: it creates the run directory, spawns a detached
 * Node worker process, and returns the run id immediately. The caller polls the
 * run directory afterwards (what the CLI's status/logs/result do, and what
 * `waitFor` does for `--wait`).
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveRunsRoot } from "../adapters/config.js";
import { isSeaBinary } from "../sea.js";
import { resolveWorkflow } from "../workflows/resolve.js";
import { RunStore, TERMINAL_STATES } from "./run-store.js";

export interface StartRunOptions {
  args?: unknown;
  configPath?: string | null;
  runsRoot?: string | null;
  source?: string | null;
  budgetTotal?: number | null;
}

/** Create a run and launch its worker process; return `{ runId, store }`. */
export function startRun(
  script: string,
  options: StartRunOptions = {},
): { runId: string; store: RunStore } {
  const config = loadConfig(options.configPath ?? null); // validates config & resolves defaults
  const source = options.source ? resolve(options.source) : process.cwd();
  // `script` may be a path (./wf.js) or a managed-directory name (deep-research);
  // resolve against `source` so --source steers both literal paths and name lookup.
  const { scriptPath } = resolveWorkflow(script, { cwd: source, config });

  const root = options.runsRoot ?? resolveRunsRoot(config.settings.runsRoot);

  const store = new RunStore(root);
  const runId = store.create({
    script: scriptPath,
    args: options.args,
    configPath: options.configPath ?? null,
    source,
    budgetTotal: options.budgetTotal ?? null,
  });

  // How the worker is launched depends on how *we* were launched. As a normal
  // Node process, `execPath` is `node` and we hand it `worker.js`. As a compiled
  // SEA binary there is no `node` and no `worker.js` on disk, so we re-exec the
  // binary itself (`execPath`) with the hidden `__worker` subcommand, which runs
  // the same `executeRun` from inside the bundle.
  const workerArgv = isSeaBinary()
    ? ["__worker", store.runDir(runId)]
    : [fileURLToPath(new URL("./worker.js", import.meta.url)), store.runDir(runId)];
  const logFd = openSync(store.logPath(runId), "w");
  const child = spawn(execPath, workerArgv, {
    cwd: source,
    detached: true, // the run outlives this process
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd); // the child holds its own dup'd descriptors; don't leak ours
  child.unref();

  return { runId, store };
}

/** Block until the run reaches a terminal state (or times out); return status. */
export async function waitFor(
  store: RunStore,
  runId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<Record<string, unknown>> {
  const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : null;
  const poll = options.pollIntervalMs ?? 200;
  for (;;) {
    const status = store.readStatus(runId);
    if (TERMINAL_STATES.has(status.state as string)) return status;
    if (deadline !== null && Date.now() >= deadline) return status;
    await new Promise<void>((r) => setTimeout(r, poll));
  }
}
