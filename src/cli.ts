#!/usr/bin/env node
/**
 * Command-line front end (L6).
 *
 * `odw` starts runs and observes them. It is a thin client over the run
 * directory: `run` launches a background worker; everything else reads or pokes
 * the run directory. Run state lives on disk, so the CLI and worker stay fully
 * decoupled.
 *
 *   odw run <script.js> [--args JSON|@file] [--wait]
 *   odw list
 *   odw status <run_id>
 *   odw logs <run_id> [--follow]
 *   odw agents <run_id> [--json]
 *   odw result <run_id> [--agent <id|label>]
 *   odw rerun|resume <run_id>
 *   odw pause|resume|stop <run_id>
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { listAdapters, loadConfig, locateConfig, resolveAdapter, resolveRunsRoot } from "./adapters/config.js";
import type { Config } from "./adapters/types.js";
import { runDoctor, type CheckStatus } from "./doctor.js";
import { AdapterNotFound } from "./errors.js";
import type { WorkflowEvent } from "./events.js";
import { VERSION } from "./index.js";
import { cmdInit } from "./init.js";
import { agentRowJson, agentRows, formatAgentTable, matchAgents } from "./runtime/agents-view.js";
import { startRun, startRunFromSource, waitFor } from "./runtime/launcher.js";
import { attachRun, formatEvent, resolveRunMode, type RunMode } from "./runtime/live-view.js";
import { isRunActive, RunObserver } from "./runtime/run-liveness.js";
import { RunStore, TERMINAL_STATES } from "./runtime/run-store.js";
import { startServer } from "./runtime/server.js";
import { executeRun } from "./runtime/worker.js";
import { isSeaBinary } from "./sea.js";
import { detectCaps, glyphs, palette } from "./tty.js";
import { listWorkflows, resolveWorkflow } from "./workflows/resolve.js";

export const COMMANDS = [
  "init",
  "doctor",
  "run",
  "attach",
  "rerun",
  "list",
  "status",
  "logs",
  "agents",
  "result",
  "serve",
  "workflows",
  "pause",
  "resume",
  "stop",
] as const;

export type Command = (typeof COMMANDS)[number];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function versionText(): string {
  return `open-dynamic-workflows ${VERSION}`;
}

export function helpText(): string {
  return [
    `odw — Open Dynamic Workflows (v${VERSION})`,
    "Run Claude Code-format dynamic-workflow scripts against any coding-agent CLI.",
    "",
    "Usage:",
    "  odw init [--adapter <name>] [--check]              pick the default agent CLI (first-time setup)",
    "  odw doctor [--smoke] [--adapter <name>|all]        check this machine is ready to run workflows",
    "  odw run <script.js|name> [--args JSON|@file]       start a workflow (see modes below)",
    "  odw attach <run_id>                                attach the live foreground view to a run",
    "  odw rerun <run_id>                                 start a fresh run with the same inputs",
    "  odw resume <run_id> [--force]                      unpause a paused run, or replay an ended one (below)",
    "  odw status <run_id>                                show a run's current state",
    "  odw logs <run_id|--workflow name> [--follow]       print a run's progress events",
    "  odw agents <run_id> [--json]                       list a run's agents with their saved results",
    "  odw result <run_id> [--agent <id|label>]           print a finished run's result, or one agent's (mid-run too)",
    "  odw list [--workflow <name>]                       list known runs",
    "  odw serve [--port N] [--host H] [--open]           open the live dashboard in a browser",
    "  odw workflows list [--project|--global|--all]      list workflows runnable by name",
    "  odw workflows where <name>                         show the file a name resolves to",
    "  odw pause|resume|stop <run_id>                     control a running workflow",
    "",
    "Options:",
    "  --args JSON|@file   workflow input (JSON, @file.json, or a raw string)",
    "  --config <path>     path to an odw.config.json",
    "  --runs-root <dir>   directory runs are stored under",
    "  --source <dir>      run's working dir; also anchors a relative script path & project-name lookup",
    "  --adapter <name>    default agent() adapter for this run (explicit agent(p,{adapter}) still wins)",
    "  --fg                run in the foreground: live progress on a TTY, plain event lines otherwise",
    "  -d, --detach        start in the background and print the run id",
    "  --wait              block until the run finishes, then print the result (one run-id line on stderr)",
    "  --timeout <s>       with --fg/--wait/attach: give up after s seconds, exit 124 (run continues)",
    "  --budget <tokens>   token target exposed to the script as budget.total",
    "  -h, --help          show this help",
    "  -v, --version       show the version",
    "",
    "Serve options (odw serve):",
    "  --port <n>          dashboard port (default 4317)",
    "  --host <addr>       dashboard bind address (default 127.0.0.1)",
    "  --open              open the dashboard in the default browser",
    "",
    "Run modes (odw run / rerun / resume):",
    "  interactive terminal        attaches in the foreground (Ctrl-C detaches; the run keeps going)",
    "  piped / captured / CI       detaches and prints the run id — `RUN=$(odw run wf.js)` stays correct",
    "  ODW_DETACH=1                forces detach; explicit --fg/--wait/--detach always win",
    "",
    "Resume (odw resume <run_id>) acts on the run's state:",
    "  paused, worker alive        continues it in place (as odw pause|resume|stop always did)",
    "  done / failed / stopped,    starts a NEW run with the same script, args and adapter: every agent()",
    "  or stale (worker gone)      call unchanged since (same prompt and options) replays its saved result",
    "                              instead of running again; edited and new calls run. Takes the run",
    "                              modes and --adapter/--config/--runs-root, like rerun",
    "  still running               refused (it would redo work in flight); --force starts the new run anyway",
  ].join("\n");
}

/** A command-line mistake: its message is printed as-is and the exit code is 2. */
class UsageError extends Error {}

/** Parse and dispatch a CLI invocation. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(helpText() + "\n");
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(versionText() + "\n");
    return 0;
  }

  try {
    switch (command) {
      case "__worker":
        // Hidden: the worker entrypoint a background run re-execs into. In a SEA
        // binary there is no separate worker.js, so the binary calls itself here.
        return await cmdWorker(rest);
      case "init":
        return await cmdInitCli(rest);
      case "doctor":
        return await cmdDoctor(rest);
      case "run":
        return await cmdRun(rest);
      case "attach":
        return await cmdAttach(rest);
      case "rerun":
        return await cmdRerun(rest);
      case "resume":
        return await cmdResume(rest);
      case "status":
        return cmdStatus(rest);
      case "agents":
        return cmdAgents(rest);
      case "result":
        return cmdResult(rest);
      case "logs":
        return await cmdLogs(rest);
      case "list":
        return cmdList(rest);
      case "serve":
        return await cmdServe(rest);
      case "workflows":
        return cmdWorkflows(rest);
      case "pause":
      case "stop":
        return cmdControl(command, rest);
      default:
        process.stderr.write(`odw: unknown command '${command}'\n\n${helpText()}\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    const e = err as NodeJS.ErrnoException;
    process.stderr.write(`odw: ${e.message}\n`);
    // A parseArgs usage error (unknown flag, missing value) is a usage error → 2.
    return typeof e.code === "string" && e.code.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  }
}

// --- commands ----------------------------------------------------------------

/**
 * `odw doctor` — a readiness checklist (see doctor.ts). `--smoke` also sends one
 * real prompt to the default adapter (or each `--adapter`, or `all` installed).
 * Exit 0 when nothing failed, 1 otherwise; `--json` for machines.
 */
async function cmdDoctor(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      smoke: { type: "boolean" },
      adapter: { type: "string", multiple: true },
      timeout: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const timeoutMs = parseTimeout("doctor", values.timeout);
  const cwd = process.cwd();
  let config: Config | Error;
  let configPath: string | null = null;
  try {
    configPath = locateConfig(values.config ?? null, cwd);
    config = loadConfig(values.config ?? null, { cwd, quiet: true });
  } catch (err) {
    config = err as Error;
  }
  let smoke: string[] = [];
  if (values.smoke && !(config instanceof Error)) {
    const wanted = values.adapter ?? [];
    if (wanted.includes("all")) smoke = listAdapters(config).filter((a) => a.installed).map((a) => a.name);
    else if (wanted.length) smoke = wanted;
    else if (config.settings.defaultAdapter) smoke = [config.settings.defaultAdapter];
  }
  const report = await runDoctor({
    config,
    configPath,
    cwd,
    smoke,
    smokeTimeout: timeoutMs !== undefined ? timeoutMs / 1000 : undefined,
  });
  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.ok ? 0 : 1;
  }
  const caps = detectCaps(process.stdout, process.env);
  const p = palette(caps);
  const g = glyphs(caps);
  const mark: Record<CheckStatus, string> = {
    ok: p.ok(g.ok),
    warn: p.run("!"),
    fail: p.err(g.fail),
    skip: p.dim(g.bullet),
  };
  const width = Math.max(...report.checks.map((c) => c.title.length));
  const lines = [p.bold(`odw doctor · v${VERSION}`), ""];
  for (const c of report.checks) {
    lines.push(`  ${mark[c.status]} ${c.title.padEnd(width)}  ${c.status === "skip" ? p.dim(c.detail) : c.detail}`);
    if (c.hint && c.status !== "ok") lines.push(`    ${" ".repeat(width)}  ${p.dim(`→ ${c.hint}`)}`);
  }
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    failed
      ? p.err(`${failed} check(s) failed`) + (warned ? p.dim(`, ${warned} warning(s)`) : "")
      : p.ok("ready") + (warned ? p.dim(` — ${warned} warning(s)`) : "") +
          (values.smoke ? "" : p.dim(" · add --smoke to send each adapter a real prompt")),
  );
  process.stdout.write(lines.join("\n") + "\n");
  return report.ok ? 0 : 1;
}

/** Hidden worker entrypoint: execute a run in this (SEA-re-exec'd) process. */
async function cmdWorker(rest: string[]): Promise<number> {
  const runDir = rest[0];
  if (!runDir) {
    process.stderr.write("odw __worker: missing <run_dir>\n");
    return 2;
  }
  const state = await executeRun(runDir);
  return state === "done" ? 0 : 1;
}

/** `odw init` — detect agent CLIs and set/inspect the default (see src/init.ts). */
async function cmdInitCli(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      adapter: { type: "string" },
      check: { type: "boolean" },
      config: { type: "string" },
    },
  });
  return cmdInit({
    ...(values.adapter !== undefined ? { adapter: values.adapter } : {}),
    check: values.check === true,
    config: values.config ?? null,
  });
}

async function cmdRun(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      args: { type: "string" },
      config: { type: "string" },
      "runs-root": { type: "string" },
      source: { type: "string" },
      adapter: { type: "string" },
      wait: { type: "boolean" },
      fg: { type: "boolean" },
      detach: { type: "boolean", short: "d" },
      timeout: { type: "string" },
      budget: { type: "string" },
    },
  });
  const ref = positionals[0];
  if (!ref) {
    process.stderr.write("odw run: missing <script.js|name>\n");
    return 2;
  }

  let budgetTotal: number | null = null;
  if (values.budget !== undefined) {
    budgetTotal = Number(values.budget);
    if (!Number.isFinite(budgetTotal) || budgetTotal <= 0) {
      process.stderr.write("odw run: --budget must be a positive number\n");
      return 2;
    }
  }

  const { mode, timeoutMs } = resolveStartMode("run", values);

  warnIfNoDefaultAdapter(values.adapter ?? null, values.config ?? null, values.source ?? null, "run");

  const { runId, store } = startRun(ref, {
    args: parseArgsValue(values.args),
    configPath: values.config ?? null,
    runsRoot: values["runs-root"] ?? null,
    source: values.source ?? null,
    adapter: values.adapter ?? null,
    budgetTotal,
  });

  return afterStart(store, runId, mode, { timeoutMs, hint: "started run" });
}

/** `--timeout <seconds>` as milliseconds (undefined when absent). */
function parseTimeout(cmd: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new UsageError(`odw ${cmd}: --timeout must be a non-negative number of seconds`);
  }
  return seconds * 1000;
}

/**
 * How `run`, `rerun` and `resume` present the run they start: the
 * --fg/--wait/--detach mode (or the TTY/CI default) and the --timeout that
 * bounds the viewer. One resolver, so the commands validate in the same order:
 * the --timeout value, then conflicting mode flags, then a --timeout a
 * detached start cannot honor.
 */
function resolveStartMode(
  cmd: "run" | "rerun" | "resume",
  flags: { fg?: boolean; detach?: boolean; wait?: boolean; timeout?: string },
): { mode: RunMode; timeoutMs: number | undefined } {
  const timeoutMs = parseTimeout(cmd, flags.timeout);
  const resolved = resolveRunMode(
    { fg: flags.fg === true, detach: flags.detach === true, wait: flags.wait === true },
    { stdoutTTY: process.stdout.isTTY === true, stderrTTY: process.stderr.isTTY === true },
    process.env,
  );
  if ("usageError" in resolved) throw new UsageError(`odw ${cmd}: ${resolved.usageError}`);
  if (timeoutMs !== undefined && resolved.mode === "detach") {
    throw new UsageError(
      `odw ${cmd}: --timeout needs --wait or --fg (a detached start returns immediately)`,
    );
  }
  return { mode: resolved.mode, timeoutMs };
}

/**
 * Launch-time preflight: a missing/ambiguous default adapter is knowable NOW,
 * but a detached start would defer it into the run — the launch prints a run id,
 * exits 0, and the failure is only visible in `odw status`. Surface it here.
 * A warning, not an error: workflows that name adapters per call never need a
 * default, so the launch must not be blocked. Quiet load — the launcher's own
 * loadConfig lints the same file right after. The worker runs with cwd =
 * --source, so the project-local config is resolved against source, not the
 * launcher's cwd — else this would warn about a config the run never reads
 * (and stay silent about the one it does). Exported for tests.
 */
export function warnIfNoDefaultAdapter(
  adapter: string | undefined | null,
  configPath: string | null,
  source: string | null,
  command: string,
): void {
  if (adapter != null) return;
  try {
    resolveAdapter(
      loadConfig(configPath, { quiet: true, ...(source ? { cwd: resolve(source) } : {}) }),
    );
  } catch (err) {
    if (!(err instanceof AdapterNotFound)) return; // a broken config file fails the launch itself
    process.stderr.write(
      `odw ${command}: warning: bare agent() calls in this run will fail — ${err.message}\n`,
    );
  }
}

/**
 * What run/rerun/resume do once the detached worker is spawned, per the
 * resolved mode. The run itself is identical in all three: only the viewer
 * differs.
 */
async function afterStart(
  store: RunStore,
  runId: string,
  mode: RunMode,
  opts: { timeoutMs?: number; hint: string },
): Promise<number> {
  if (mode === "detach") {
    process.stdout.write(runId + "\n");
    process.stderr.write(`${opts.hint} ${runId} (use 'odw status ${runId}')\n`);
    return 0;
  }
  if (mode === "wait") {
    process.stderr.write(`running ${runId} ...\n`);
    const status = await waitFor(store, runId, { timeoutMs: opts.timeoutMs });
    if (!TERMINAL_STATES.has(String(status.state))) {
      process.stderr.write(
        `timed out waiting for ${runId} — run continues (odw attach ${runId})\n`,
      );
      return 124;
    }
    return reportTerminal(store, runId, status);
  }
  return attachRun(store, runId, {
    out: process.stdout,
    err: process.stderr,
    timeoutMs: opts.timeoutMs,
  });
}

/** `odw attach <run_id>` — (re)attach the foreground view to an existing run. */
async function cmdAttach(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      timeout: { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw attach: missing <run_id>\n");
    return 2;
  }
  const timeoutMs = parseTimeout("attach", values.timeout);
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  return attachRun(store, runId, {
    out: process.stdout,
    err: process.stderr,
    timeoutMs,
  });
}

function cmdStatus(rest: string[]): number {
  const { store, runId } = storeAndRun(rest);
  if (!store) return runId ? 1 : 2;
  const status = store.readStatus(runId);
  const meta = store.readMeta(runId);
  const events = store.readEvents(runId);
  const name = (status.name as string) || baseName(meta.script as string | undefined);
  process.stdout.write(`${runId}  [${status.state ?? "?"}]  ${name}\n`);
  if (status.description) process.stdout.write(`  ${status.description as string}\n`);
  process.stdout.write(`  dispatched: ${dispatchedCount(events, status)} agent(s)\n`);
  if (typeof meta.resumedFrom === "string") {
    const replayed = events.filter((e) => e.type === "agent_finished" && e.cached === true).length;
    process.stdout.write(`  resumed from: ${meta.resumedFrom} (${replayed} agent result(s) replayed)\n`);
  }
  return 0;
}

/** Real dispatches: replayed agents (odw resume) never took one. */
function dispatchedCount(events: WorkflowEvent[], status: Record<string, unknown>): number {
  const recorded = typeof status.dispatched === "number" ? status.dispatched : 0;
  const observed = events.filter((e) => e.type === "agent_started" && e.cached !== true).length;
  return Math.max(recorded, observed);
}

/**
 * `odw result <run_id>` prints a finished run's result; with `--agent
 * <id|label>`, one agent's saved value — there as soon as that agent finished,
 * while the run is still going (or after it stalled, stopped or died).
 */
function cmdResult(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" }, agent: { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("missing <run_id>\n");
    return 2;
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  if (values.agent !== undefined) return reportAgent(store, runId, values.agent);
  return reportTerminal(store, runId, store.readStatus(runId));
}

/** One agent's saved value as JSON on stdout; an unknown, ambiguous or unfinished agent is an error. */
function reportAgent(store: RunStore, runId: string, ref: string): number {
  const matches = matchAgents(agentRows(store, runId), ref);
  if (matches.length === 0) {
    process.stderr.write(`run ${runId} has no agent '${ref}' (see odw agents ${runId})\n`);
    return 1;
  }
  if (matches.length > 1) {
    const ids = matches.map((r) => `${r.agentId ?? "?"} (${r.state})`).join(", ");
    process.stderr.write(
      `label '${ref}' matches ${matches.length} agents of run ${runId}: ${ids} — pick one: odw result ${runId} --agent <id>\n`,
    );
    return 1;
  }
  const row = matches[0]!;
  if (!row.record) {
    const why =
      row.state === "failed"
        ? `failed: ${row.error ?? "unknown error"}`
        : row.state === "done"
          ? "finished, but no result was saved for it (a run from before per-agent results, or the save failed — see odw logs)"
          : `is ${row.state}: no result yet`;
    process.stderr.write(`agent ${row.agentId ?? "?"} (${row.label}) ${why}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(row.record.value, null, 2) + "\n");
  return 0;
}

/**
 * `odw agents <run_id> [--json]` — every agent of a run (running and failed
 * ones too) with a one-line preview of its saved result. Works mid-run.
 */
function cmdAgents(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" }, json: { type: "boolean" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw agents: missing <run_id>\n");
    return 2;
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const rows = agentRows(store, runId);
  if (values.json) {
    process.stdout.write(JSON.stringify(rows.map(agentRowJson), null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stderr.write(`run ${runId} has no agents yet\n`);
    return 0;
  }
  const caps = detectCaps(process.stdout, process.env);
  const width = process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120;
  for (const line of formatAgentTable(rows, { width, caps })) process.stdout.write(line + "\n");
  const replayed = rows.some((r) => r.cached) ? `${caps.unicode ? "↺" : "(r)"} replayed by odw resume · ` : "";
  process.stderr.write(`${replayed}full value: odw result ${runId} --agent <id|label>\n`);
  return 0;
}

async function cmdLogs(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      follow: { type: "boolean" },
      workflow: { type: "string" },
    },
  });
  const store = storeFrom(values);
  let runId = positionals[0];
  // --workflow with no explicit id targets that workflow's most recent run,
  // reading only its bucket (no full scan).
  if (!runId && values.workflow) {
    const refs = store.listRunsForWorkflow(values.workflow);
    if (refs.length === 0) {
      process.stderr.write(`no runs found for workflow '${values.workflow}'\n`);
      return 1;
    }
    runId = refs[0]!.runId;
  }
  if (!runId) {
    process.stderr.write("missing <run_id> (or --workflow <name>)\n");
    return 2;
  }
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const observer = new RunObserver(store, runId);
  for (;;) {
    const observed = observer.read();
    for (const ev of observed.events) process.stdout.write(formatEvent(ev) + "\n");
    if (!values.follow) return 0;
    if (observed.note) process.stderr.write(observed.note + "\n");
    if (observed.error) {
      process.stderr.write(observed.error + "\n");
      return 1;
    }
    if (observed.terminal) {
      return observed.status.state === "done" ? 0 : reportTerminal(store, runId, observed.status);
    }
    await delay(300);
  }
}

function cmdList(rest: string[]): number {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      workflow: { type: "string" },
    },
  });
  const store = storeFrom(values);
  const runs = values.workflow ? store.listRunsForWorkflow(values.workflow) : store.listRuns();
  if (runs.length === 0) {
    process.stderr.write(
      values.workflow ? `no runs found for workflow '${values.workflow}'\n` : "no runs found\n",
    );
    return 0;
  }
  for (const ref of runs) {
    const status = store.readStatus(ref.runId);
    const name = (status.name as string) || ref.workflowName || "";
    process.stdout.write(`${ref.runId}  ${String(status.state ?? "?").padEnd(8)}  ${name}\n`);
  }
  return 0;
}

/**
 * The flags `odw rerun` and `odw resume` share: where to find the run, the
 * run-level adapter of the new run, and how to present it.
 */
const RELAUNCH_OPTIONS = {
  config: { type: "string" },
  "runs-root": { type: "string" },
  adapter: { type: "string" },
  wait: { type: "boolean" },
  fg: { type: "boolean" },
  detach: { type: "boolean", short: "d" },
  timeout: { type: "string" },
} as const;

/** `odw rerun <run_id>` — start a fresh run with the same inputs as an existing one. */
async function cmdRerun(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: RELAUNCH_OPTIONS });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw rerun: missing <run_id>\n");
    return 2;
  }
  const start = resolveStartMode("rerun", values);
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  return relaunch("rerun", store, runId, values, start);
}

/**
 * `odw resume <run_id>` — continue a run, the way its state allows:
 *
 *   - live and paused (or asked to pause): release it in place, as `odw
 *     pause|resume|stop` always did;
 *   - ended (done, failed, stopped — or stale: its worker is gone): start a
 *     NEW run with the same script, args and adapter whose unchanged agent()
 *     calls replay the old run's saved results, so only the rest runs;
 *   - live and not paused: refuse, since a replaying resume would redo the
 *     work it still has in flight. `--force` starts one anyway (the original
 *     keeps running).
 */
async function cmdResume(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ...RELAUNCH_OPTIONS, force: { type: "boolean" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw resume: missing <run_id>\n");
    return 2;
  }
  const start = resolveStartMode("resume", values);
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  if (!values.force && isRunActive(store, runId)) {
    const state = String(store.readStatus(runId).state ?? "pending");
    const control = store.readControl(runId);
    if (state === "paused" || control === "pause") {
      const given = values as Record<string, unknown>;
      const newRunFlag = ["adapter", "wait", "fg", "detach", "timeout"].find((f) => given[f] !== undefined);
      if (newRunFlag) {
        throw new UsageError(
          `odw resume: run ${runId} is paused, so resume continues it in place — ` +
            `--${newRunFlag} applies only when resume starts a new run`,
        );
      }
      store.writeControl(runId, "resume");
      process.stderr.write(`resume requested for ${runId}\n`);
      return 0;
    }
    process.stderr.write(
      `odw resume: run ${runId} is still ${control === "stop" ? "stopping" : state} — only a paused run continues in place.\n` +
        `  To replay its finished agents in a new run, let it end first (odw stop ${runId}), or pass --force.\n`,
    );
    return 1;
  }
  return relaunch("resume", store, runId, values, start);
}

/**
 * Start a new run from an existing run's recorded inputs — script, args,
 * source, config, budget and run-level adapter (`--adapter` overrides the
 * last) — and present it per the resolved mode. `rerun` starts over; `resume`
 * also records the source run, whose saved agent results the new run's worker
 * replays for every agent() call that is unchanged.
 */
async function relaunch(
  cmd: "rerun" | "resume",
  store: RunStore,
  runId: string,
  flags: { "runs-root"?: string; adapter?: string },
  start: { mode: RunMode; timeoutMs: number | undefined },
): Promise<number> {
  const meta = store.readMeta(runId);
  const script = meta.script as string | undefined;
  if (!script) {
    process.stderr.write(`run ${runId} has no script to ${cmd}\n`);
    return 1;
  }
  const opts = {
    args: meta.args,
    configPath: (meta.configPath as string | null) ?? null,
    runsRoot: flags["runs-root"] ?? null,
    source: (meta.source as string | undefined) ?? null,
    adapter: flags.adapter ?? (meta.adapter as string | null) ?? null,
    budgetTotal: (meta.budgetTotal as number | null) ?? null,
    // The worker reads the saved results from the source run's own directory.
    resumedFrom: cmd === "resume" ? { runId, dir: store.runDir(runId) } : null,
  };
  warnIfNoDefaultAdapter(opts.adapter, opts.configPath, opts.source, cmd);
  // An inline-launched run's script lives inside the OLD run dir. Re-archive its
  // source into the NEW run (via startRunFromSource) rather than pointing the new
  // run back at the old directory — so it stays self-contained and is correctly
  // flagged inline (no spurious run-by-name divergence note).
  //
  // Observe the NEW run through the store the launcher actually created it in
  // (the old run's configPath may point runsRoot somewhere the CLI-flag store
  // does not) — never through the store the OLD run was located with.
  let started: { runId: string; store: RunStore };
  if (meta.inline === true) {
    let sourceCode: string;
    try {
      sourceCode = readFileSync(script, "utf8");
    } catch {
      process.stderr.write(`run ${runId}: its archived script is gone, cannot ${cmd}\n`);
      return 1;
    }
    started = startRunFromSource(sourceCode, {
      ...opts,
      allowInvalid: true,
      origin: (meta.origin as string | null) ?? null,
    });
  } else {
    started = startRun(script, opts);
  }
  const saved = cmd === "resume" ? store.listAgentResults(runId).length : 0;
  return afterStart(started.store, started.runId, start.mode, {
    timeoutMs: start.timeoutMs,
    hint: cmd === "resume" ? `resuming ${runId} (${saved} saved agent result(s) to replay) as` : `re-running ${runId} as`,
  });
}

async function cmdServe(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      open: { type: "boolean" },
    },
  });

  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`odw serve: invalid --port '${values.port}'\n`);
    return 2;
  }
  const host = values.host ?? "127.0.0.1";
  const store = storeFrom(values);
  const config = loadConfig(values.config ?? null);

  const handle = await startServer({
    store,
    port,
    host,
    cwd: process.cwd(),
    config,
    configPath: values.config ?? null,
  });
  process.stdout.write(`odw dashboard → ${handle.url}\n`);
  process.stdout.write(`  watching ${store.root}\n`);
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    process.stderr.write(
      `  ⚠ bound to ${host}: every project's runs (prompts, results) are reachable off-localhost — use only on a trusted network\n`,
    );
  }
  process.stdout.write("  press Ctrl-C to stop\n");
  if (values.open) openBrowser(handle.url);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.stdout.write("\nshutting down…\n");
      handle.close().then(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return 0;
}

/** Best-effort: open `url` in the platform default browser; failures are silent. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    }).unref();
  } catch {
    /* no browser opener available — the URL is already printed */
  }
}

function cmdControl(action: Command, rest: string[]): number {
  const { store, runId } = storeAndRun(rest);
  if (!store) return runId ? 1 : 2;
  store.writeControl(runId, action);
  process.stderr.write(`${action} requested for ${runId}\n`);
  return 0;
}

/** `odw workflows <list|where>` — inspect the workflows runnable by name. */
function cmdWorkflows(rest: string[]): number {
  const [sub, ...subRest] = rest;
  if (sub === "list") return cmdWorkflowsList(subRest);
  if (sub === "where") return cmdWorkflowsWhere(subRest);
  process.stderr.write(`odw workflows: expected 'list' or 'where', got '${sub ?? ""}'\n`);
  return 2;
}

function cmdWorkflowsList(rest: string[]): number {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      project: { type: "boolean" },
      global: { type: "boolean" },
      all: { type: "boolean" },
    },
  });
  if (values.project && values.global) {
    process.stderr.write("odw workflows list: --project and --global are mutually exclusive\n");
    return 2;
  }
  const config = loadConfig(values.config ?? null);
  let entries = listWorkflows(process.cwd(), config);
  const scoped = Boolean(values.project || values.global);
  if (values.project) entries = entries.filter((e) => e.origin === "project");
  if (values.global) entries = entries.filter((e) => e.origin === "global");
  // The default (unscoped) view shows only the effective set; an explicit scope
  // or --all shows every entry, with shadowed ones still flagged.
  if (!values.all && !scoped) entries = entries.filter((e) => !e.shadowed);

  if (entries.length === 0) {
    process.stderr.write("no named workflows found\n");
    process.stderr.write(
      "  add one by dropping a .js file in ./.odw/workflows, ./.claude/workflows, ~/.odw/workflows, or ~/.claude/workflows\n",
    );
    return 0;
  }
  const width = Math.max(...entries.map((e) => e.name.length));
  for (const e of entries) {
    const scope = `${e.provider}:${e.origin}`;
    const shadow = e.shadowed ? "  shadowed by higher-precedence workflow" : "";
    process.stdout.write(`${e.name.padEnd(width)}  (${scope.padEnd(14)} ${e.rootLabel})  ${e.path}${shadow}\n`);
  }
  return 0;
}

function cmdWorkflowsWhere(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" } },
  });
  const name = positionals[0];
  if (!name) {
    process.stderr.write("odw workflows where: missing <name>\n");
    return 2;
  }
  const config = loadConfig(values.config ?? null);
  try {
    const { scriptPath, origin, provider, rootLabel } = resolveWorkflow(name, { cwd: process.cwd(), config });
    const source = provider ? `${provider}:${origin}${rootLabel ? ` ${rootLabel}` : ""}` : origin;
    process.stdout.write(`${scriptPath}  (${source})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

// --- helpers -----------------------------------------------------------------

interface StoreFlags {
  config?: string;
  "runs-root"?: string;
}

function storeFrom(values: StoreFlags): RunStore {
  if (values["runs-root"]) return new RunStore(values["runs-root"]);
  return new RunStore(resolveRunsRoot(loadConfig(values.config ?? null).settings.runsRoot));
}

/** Parse `<run_id>` + store flags; returns null store with a printed error on failure. */
function storeAndRun(rest: string[]): { store: RunStore | null; runId: string } {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("missing <run_id>\n");
    return { store: null, runId: "" };
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return { store: null, runId };
  }
  return { store, runId };
}

function reportTerminal(store: RunStore, runId: string, status: Record<string, unknown>): number {
  const state = status.state;
  if (state === "done") {
    process.stdout.write(JSON.stringify(store.readResult(runId), null, 2) + "\n");
    return 0;
  }
  if (state === "failed") {
    const error = store.readError(runId) ?? {};
    process.stderr.write(`run failed: ${status.error ?? error.error ?? "unknown error"}\n`);
    return 1;
  }
  if (state === "stopped") {
    process.stderr.write("run was stopped before completion\n");
    return 1;
  }
  process.stderr.write(`run is still '${String(state)}'; not finished\n`);
  return 1;
}

export function parseArgsValue(raw?: string): unknown {
  if (raw === undefined) return null;
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    // Input that *looks* like JSON but doesn't parse is almost always a typo'd
    // object, and silently passing it through as a string corrupts the run
    // (`args.foo` becomes undefined in every agent prompt). Fail loudly instead.
    const head = text.trimStart()[0];
    if (head === "{" || head === "[") {
      throw new Error(
        `--args looks like JSON but failed to parse: ${(err as Error).message}\n` +
          `  fix the JSON, or pass input that does not start with '{' or '[' to send a plain string`,
      );
    }
    return text; // a plain string that isn't JSON, e.g. --args hello
  }
}

function baseName(path: string | undefined): string {
  return path ? basename(path) : "";
}

export function isCliEntrypoint(argvEntry: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Run when invoked directly (`node dist/cli.js …`) or as the compiled SEA binary
// (where there is no script path on argv to match against this module).
if (isCliEntrypoint(process.argv[1]) || isSeaBinary()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
