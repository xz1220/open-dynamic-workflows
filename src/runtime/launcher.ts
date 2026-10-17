/**
 * Start runs in the background and wait on them (L5).
 *
 * `startRun` is fire-and-forget: it creates the run directory, spawns a detached
 * Node worker process, and returns the run id immediately. The caller polls the
 * run directory afterwards (what the CLI's status/logs/result do, and what
 * `waitFor` does for `--wait`).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveAdapter, resolveRunsRoot } from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { loadWorkflowScript } from "../loader.js";
import { isSeaBinary } from "../sea.js";
import { resolveWorkflow } from "../workflows/resolve.js";
import { RunObserver } from "./run-liveness.js";
import { RunStore } from "./run-store.js";

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
  /** Where the run was initiated from (e.g. "chat" for Chat Host runs). */
  origin?: string | null;
  /**
   * `odw resume`: the run (id + directory) whose saved agent results this run
   * replays — its agent() calls that are unchanged return those values
   * instead of running again.
   */
  resumedFrom?: { runId: string; dir: string } | null;
}

/**
 * The prelude both entry points share: load + validate config, resolve the run
 * source, fail-fast on an unknown adapter, and open the run store. Keeping it in
 * one place means a new StartRunOption or validation rule lands for path-based
 * AND inline launches at once.
 */
function prepare(options: StartRunOptions): { config: Config; source: string; store: RunStore } {
  const config = loadConfig(options.configPath ?? null); // validates config & resolves defaults
  const source = options.source ? resolve(options.source) : process.cwd();
  if (options.adapter) resolveAdapter(config, options.adapter); // fail fast on unknown names
  const store = new RunStore(options.runsRoot ?? resolveRunsRoot(config.settings.runsRoot));
  return { config, source, store };
}

/** The CreateRunInput fields every launch shares, given its resolved source. */
function commonCreateInput(options: StartRunOptions, source: string, workflowName: string | null) {
  return {
    args: options.args,
    configPath: options.configPath ?? null,
    source,
    budgetTotal: options.budgetTotal ?? null,
    workflowName,
    adapter: options.adapter ?? null,
    origin: options.origin ?? null,
    resumedFrom: options.resumedFrom ?? null,
  };
}

/** Create a run and launch its worker process; return `{ runId, store }`. */
export function startRun(
  script: string,
  options: StartRunOptions = {},
): { runId: string; store: RunStore } {
  const { config, source, store } = prepare(options);
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

  const runId = store.create({ script: scriptPath, ...commonCreateInput(options, source, workflowName) });
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
  const { source, store } = prepare(options);

  let workflowName: string | null = null;
  try {
    workflowName = loadWorkflowScript(sourceCode, "workflow.js").meta.name;
  } catch (err) {
    if (!options.allowInvalid) throw err; // surface the compile error to the caller
  }

  const runId = store.create({
    script: "",
    inlineSource: sourceCode,
    ...commonCreateInput(options, source, workflowName),
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
  const failed = (err: Error) => {
    store.writeError(runId, { error: `worker failed to start: ${err.message}` });
    store.updateStatus(runId, { state: "failed" });
  };
  let child;
  try {
    child = spawn(execPath, workerArgv, {
      cwd: source,
      detached: true, // the run outlives this process
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
  } catch (err) {
    failed(err as Error);
    throw err;
  } finally {
    closeSync(logFd); // the child holds its own dup'd descriptors; don't leak ours
  }
  child.once("error", failed);
  child.unref();
  // A separate, write-once file avoids racing the worker's status updates,
  // and identifies slow-starting workers before their first status write.
  if (child.pid !== undefined) {
    writeFileSync(join(store.runDir(runId), "worker.pid"), String(child.pid));
  }
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
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    /** Sees the run's status on every poll while it is not finished (e.g. a checkpoint it waits at). */
    onStatus?: (status: Record<string, unknown>) => void;
  } = {},
): Promise<Record<string, unknown>> {
  // `!== undefined` (not truthiness): `--timeout 0` means "time out immediately",
  // never "wait forever".
  const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : null;
  const poll = options.pollIntervalMs ?? 200;
  const observer = new RunObserver(store, runId);
  for (;;) {
    const observed = observer.read();
    if (observed.terminal) return observed.status;
    if (observed.error) return { ...observed.status, state: "failed", error: observed.error };
    options.onStatus?.(observed.status);
    if (deadline !== null && Date.now() >= deadline) return observed.status;
    await new Promise<void>((r) => setTimeout(r, poll));
  }
}
