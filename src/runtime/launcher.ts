/**
 * Start runs in the background and wait on them (L5).
 *
 * `startRun` is fire-and-forget: it creates the run directory, spawns a detached
 * Node worker process, and returns the run id immediately. The caller polls the
 * run directory afterwards (what the CLI's status/logs/result do, and what
 * `waitFor` does for `--wait`).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveAdapter, resolveRunsRoot } from "../adapters/config.js";
import { loadWorkflowScript } from "../loader.js";
import { isSeaBinary } from "../sea.js";
import { resolveWorkflow } from "../workflows/resolve.js";
import { RunStore, TERMINAL_STATES } from "./run-store.js";

export interface StartRunOptions {
  args?: unknown;
  configPath?: string | null;
  runsRoot?: string | null;
  source?: string | null;
  budgetTotal?: number | null;
  /**
   * Run-level adapter override: becomes this run's default `agent()` adapter
   * (an explicit `agent(p, { adapter })` still wins). Validated against the
   * config up front so an unknown name fails here, not minutes later inside the
   * detached worker.
   */
  adapter?: string | null;
  /** Where the run was initiated from (e.g. "launch" for the GUI flow). */
  origin?: string | null;
}

/** Create a run and launch its worker process; return `{ runId, store }`. */
export function startRun(
  script: string,
  options: StartRunOptions = {},
): { runId: string; store: RunStore } {
  const config = loadConfig(options.configPath ?? null); // validates config & resolves defaults
  const source = options.source ? resolve(options.source) : process.cwd();
  if (options.adapter) resolveAdapter(config, options.adapter); // fail fast on unknown names
  // `script` may be a path (./wf.js) or a managed-directory name (deep-research);
  // resolve against `source` so --source steers both literal paths and name lookup.
  const { scriptPath } = resolveWorkflow(script, { cwd: source, config });

  // Read the workflow's identity (meta.name) up front so the run is bucketed by
  // its workflow even before — and whether or not — it ever starts running. This
  // only COMPILES the script (extracts meta + builds the body factory); it never
  // executes the body. A malformed script leaves the name unknown (the run still
  // gets created, then the worker records it as failed in the normal way).
  let workflowName: string | null = null;
  try {
    workflowName = loadWorkflowScript(readFileSync(scriptPath, "utf8"), scriptPath).meta.name;
  } catch {
    workflowName = null;
  }

  const store = new RunStore(options.runsRoot ?? resolveRunsRoot(config.settings.runsRoot));
  const runId = store.create({
    script: scriptPath,
    args: options.args,
    configPath: options.configPath ?? null,
    source,
    budgetTotal: options.budgetTotal ?? null,
    workflowName,
    adapter: options.adapter ?? null,
    origin: options.origin ?? null,
  });
  spawnWorker(store, runId, source);
  return { runId, store };
}

/**
 * Start a run from INLINE workflow source (no file on disk yet). The source is
 * written as `workflow.js` inside the run directory — a generated or one-off
 * script is archived with its run, rerunnable and inspectable later — and the
 * worker is spawned on it exactly like a path-based run.
 *
 * The source is compile-checked here so a caller (the HTTP API, a tool) can
 * reject a known-bad script before a worker ever spawns; pass
 * `allowInvalid: true` to skip that (the run is then created and recorded as
 * failed by the worker, the same as a malformed file-based script).
 */
export function startRunFromSource(
  sourceCode: string,
  options: StartRunOptions & { allowInvalid?: boolean } = {},
): { runId: string; store: RunStore } {
  const config = loadConfig(options.configPath ?? null);
  const source = options.source ? resolve(options.source) : process.cwd();
  if (options.adapter) resolveAdapter(config, options.adapter);

  let workflowName: string | null = null;
  try {
    workflowName = loadWorkflowScript(sourceCode, "workflow.js").meta.name;
  } catch (err) {
    if (!options.allowInvalid) throw err; // surface the compile error to the caller
  }

  const store = new RunStore(options.runsRoot ?? resolveRunsRoot(config.settings.runsRoot));
  const runId = store.create({
    script: "",
    inlineSource: sourceCode,
    args: options.args,
    configPath: options.configPath ?? null,
    source,
    budgetTotal: options.budgetTotal ?? null,
    workflowName,
    adapter: options.adapter ?? null,
    origin: options.origin ?? null,
  });
  spawnWorker(store, runId, source);
  return { runId, store };
}

function spawnWorker(store: RunStore, runId: string, source: string): void {
  // How the worker is launched depends on how *we* were launched. As a normal
  // Node process, `execPath` is `node` and we hand it `worker.js`. As a compiled
  // SEA binary there is no `node` and no `worker.js` on disk, so we re-exec the
  // binary itself (`execPath`) with the hidden `__worker` subcommand, which runs
  // the same `executeRun` from inside the bundle.
  const workerArgv = isSeaBinary()
    ? ["__worker", store.runDir(runId)]
    : nodeWorkerArgv(store.runDir(runId));
  const logFd = openSync(store.logPath(runId), "w");
  const child = spawn(execPath, workerArgv, {
    cwd: source,
    detached: true, // the run outlives this process
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd); // the child holds its own dup'd descriptors; don't leak ours
  child.unref();
}

function nodeWorkerArgv(runDir: string): string[] {
  const jsWorker = fileURLToPath(new URL("./worker.js", import.meta.url));
  if (existsSync(jsWorker)) return [jsWorker, runDir];

  const tsWorker = fileURLToPath(new URL("./worker.ts", import.meta.url));
  if (existsSync(tsWorker)) return [...tsxLoaderArgv(), tsWorker, runDir];

  return [jsWorker, runDir];
}

function tsxLoaderArgv(): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i]!;
    const next = process.execArgv[i + 1];
    if ((arg === "--import" || arg === "--require" || arg === "-r") && next?.includes("tsx")) {
      out.push(arg, next);
      i++;
    } else if (
      (arg.startsWith("--import=") || arg.startsWith("--require=") || arg.startsWith("-r")) &&
      arg.includes("tsx")
    ) {
      out.push(arg);
    }
  }
  return out;
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
