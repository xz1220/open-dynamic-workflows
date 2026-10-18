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

import { expandHome, loadConfig, resolveAdapter, resolveRunsRoot } from "../adapters/config.js";
import { isPermissionTier } from "../adapters/permissions.js";
import { withSandboxFlag, type SandboxFlag } from "../adapters/sandbox.js";
import type { Config, PermissionTier, TrustLevel } from "../adapters/types.js";
import { ConfigError } from "../errors.js";
import { loadWorkflowScript } from "../loader.js";
import { isSeaBinary } from "../sea.js";
import { resolveRunTrust } from "../untrusted.js";
import { resolveWorkflow, type ResolvedWorkflow } from "../workflows/resolve.js";
import { RunObserver } from "./run-liveness.js";
import { RunStore, type BreakSpec, type EvalRunTag, type ReplayLink, type ResolveLink } from "./run-store.js";

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
  /**
   * Run-level permission tier (an ODW extension): the run's tier for every
   * agent, in place of the config's `permissions`.
   */
  permissions?: PermissionTier | null;
  /**
   * Run untrusted (an ODW extension; `--untrusted`): each agent CLI in its
   * documented way of ignoring the repository's instructions and settings,
   * whatever the config's `trust` (see ../untrusted). Null or `"trusted"`: the config's.
   */
  trust?: TrustLevel | null;
  /**
   * Run every agent CLI in a container (an ODW extension; `--sandbox
   * container`, `--sandbox-image`): the config's container, or one of
   * `image`. Null: the config's sandbox.
   */
  sandbox?: SandboxFlag | null;
  /** Where the run was initiated from (e.g. "chat" for Chat Host runs, "eval" for `odw eval`'s). */
  origin?: string | null;
  /** The `odw eval` cell this run is one repeat of (ODW extension), kept in its meta. */
  eval?: EvalRunTag | null;
  /** The agent whose conflicts this run resolves for `odw apply --resolve` (ODW extension), kept in its meta. */
  applyResolve?: ResolveLink | null;
  /**
   * `odw resume`: the run (id + directory) whose saved agent results this run
   * replays — its agent() calls that are unchanged return those values
   * instead of running again.
   */
  resumedFrom?: { runId: string; dir: string } | null;
  /** `odw run --dry` (ODW extension): every agent gets a stub, no model is called. */
  dry?: boolean | null;
  /** `odw run --record` (ODW extension): keep the run as a case of this test file. */
  record?: { file: string; workflow: string } | null;
  /** Where a signed trigger's delivery came from (ODW extension; see ../triggers), kept in meta as `context`. */
  context?: Record<string, unknown> | null;
  /** `--deadline <seconds>` (ODW extension): the worker stops the run gracefully once they pass. */
  deadlineSeconds?: number | null;
  /** The agent this run dispatches again for `odw replay` (ODW extension; see ./replay), kept in its meta. */
  replayOf?: ReplayLink | null;
  /** `odw run --break`/`--step` (ODW extension; see ../breaks): where it stops for a person, kept in its meta. */
  breaks?: BreakSpec | null;
  /** The call a run of `odw replay` dispatches (ODW extension; see ./replay): kept as the run's call.json, its worker's args. */
  call?: Record<string, unknown> | null;
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
  if (options.permissions != null && !isPermissionTier(options.permissions)) {
    throw new ConfigError(`permissions must be "read", "edit" or "full"; got ${JSON.stringify(options.permissions)}`);
  }
  // Fail fast on `--sandbox container` with no image anywhere (ODW extension).
  // The worker reads the config from the run's source: so does this check.
  if (options.sandbox) withSandboxFlag(loadConfig(options.configPath ?? null, { quiet: true, cwd: source }).settings.sandbox, options.sandbox);
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
    permissions: options.permissions ?? null,
    trust: options.trust === "untrusted" ? "untrusted" : null,
    sandbox: options.sandbox ?? null,
    origin: options.origin ?? null,
    eval: options.eval ?? null,
    applyResolve: options.applyResolve ?? null,
    resumedFrom: options.resumedFrom ?? null,
    dry: options.dry ?? null,
    record: options.record ?? null,
    context: options.context ?? null,
    deadlineSeconds: options.deadlineSeconds ?? null,
    replayOf: options.replayOf ?? null,
    breaks: options.breaks ?? null,
    call: options.call ?? null,
  };
}

/**
 * Create a run and launch its worker process; return `{ runId, store }` and
 * how the workflow resolved (`workflow`: a plugin's, what its name noted).
 */
/**
 * `options` with `configPath` made absolute against where odw was started: the
 * worker runs in the run's source directory, and a relative path would name a
 * file there instead — the repository's own config, in an untrusted run.
 */
function absoluteConfig<T extends StartRunOptions>(options: T): T {
  return options.configPath ? { ...options, configPath: resolve(expandHome(options.configPath)) } : options;
}

export function startRun(
  script: string,
  given: StartRunOptions = {},
): { runId: string; store: RunStore; workflow: ResolvedWorkflow } {
  const options = absoluteConfig(given);
  const { config, source, store } = prepare(options);
  // `script` may be a path (./wf.js), a managed-directory name (deep-research)
  // or a Claude Code plugin's workflow (plugin:name, ODW extension); resolve
  // against `source` so --source steers literal paths and name lookup alike.
  // An untrusted run never resolves a name to the repository's own workflows.
  const trust = resolveRunTrust({ flag: options.trust ?? null, config, configPath: options.configPath ?? null, source, cwd: source }).trust;
  const workflow = resolveWorkflow(script, { cwd: source, config, trust });
  const { scriptPath } = workflow;

  // Read the workflow's identity (meta.name) up front so the run is bucketed by
  // its workflow even before — and whether or not — it ever starts running. This
  // only COMPILES the script (extracts meta + builds the body factory); it never
  // executes the body. A malformed script leaves the name unknown (the run still
  // gets created, then the worker records it as failed in the normal way). A
  // plugin's workflow is bucketed by its `<plugin>:<name>`.
  let workflowName: string | null = null;
  try {
    workflowName = loadWorkflowScript(readFileSync(scriptPath, "utf8"), scriptPath).meta.name;
  } catch {
    workflowName = null;
  }
  const plugin = workflow.plugin;
  if (plugin) workflowName = plugin.name;

  const runId = store.create({
    script: scriptPath,
    ...commonCreateInput(options, source, workflowName),
    ...(plugin ? { plugin: { name: plugin.name, id: plugin.id, version: plugin.version, scope: plugin.scope } } : {}),
    ...(workflow.notes ? { workflowNotes: workflow.notes } : {}),
  });
  spawnWorker(store, runId, source);
  return { runId, store, workflow };
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
  given: StartRunOptions & { allowInvalid?: boolean } = {},
): { runId: string; store: RunStore } {
  const options = absoluteConfig(given);
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

export function tsxLoaderArgv(): string[] {
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
