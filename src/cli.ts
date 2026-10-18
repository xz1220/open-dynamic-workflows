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
 *   odw logs <run_id> --agent <id|label> [--raw] [--follow]
 *   odw agents <run_id> [--json]
 *   odw result <run_id> [--agent <id|label>]
 *   odw diff <run_id> [--agent <id|label>] [--stat]
 *   odw apply <run_id> --agent <id|label>|--all [--check] [--force] [--verify CMD|--no-verify]
 *   odw rerun|resume <run_id>
 *   odw pause|resume|stop <run_id>
 *   odw approve|reject <run_id> [--note TEXT] [--checkpoint N]
 *   odw schedule add|list|remove|run …   (recurring runs via the OS scheduler, src/schedule/)
 *   odw compare <runA> <runB> [--json] [--agent <label|id>]   (what changed; runtime/compare)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isOnPath, listAdapters, loadConfig, locateConfig, resolveAdapter, resolveRunsRoot } from "./adapters/config.js";
import { isPermissionTier, permissionsBanner } from "./adapters/permissions.js";
import type { Config, PermissionTier } from "./adapters/types.js";
import { killAllAgentProcesses } from "./adapters/runner.js";
import { CHECKPOINT_NOTE_MAX, isCheckpointId } from "./control.js";
import { runDoctor, type CheckStatus } from "./doctor.js";
import { AdapterNotFound } from "./errors.js";
import type { WorkflowEvent } from "./events.js";
import { VERSION } from "./index.js";
import { cmdInit } from "./init.js";
import type { AgentChanges } from "./changes.js";
import { agentRowJson, agentRows, formatAgentTable, matchAgents, type AgentRow } from "./runtime/agents-view.js";
import { applyAgents, type AgentDiff } from "./runtime/apply.js";
import {
  changedAgents,
  colorDiff,
  countChanges,
  diffFiles,
  formatChangeTable,
  formatFileList,
  truncationNoteOf,
} from "./runtime/changes-view.js";
import { compareRuns, findComparedAgents, formatAgentComparison, formatComparison, readCompareRun } from "./runtime/compare.js";
import { startRun, startRunFromSource, waitFor } from "./runtime/launcher.js";
import { attachRun, bannerLines, checkpointCommands, fallbackLines, formatEvent, formatUsage, resolveRunMode, type RunMode } from "./runtime/live-view.js";
import { isRunActive, RunObserver } from "./runtime/run-liveness.js";
import { RunStore, TERMINAL_STATES } from "./runtime/run-store.js";
import { detail, type RunDetail } from "./runtime/runs-view.js";
import { startServer } from "./runtime/server.js";
import { printAgentLogs } from "./runtime/transcript-view.js";
import { executeRun } from "./runtime/worker.js";
import { pausedForOf, pausedText } from "./quota-wait.js";
import { cmdSchedule } from "./schedule/command.js";
import { isSeaBinary } from "./sea.js";
import { describeConcurrency } from "./throttle.js";
import { detectCaps, glyphs, palette, sanitizeText } from "./tty.js";
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
  "approve",
  "reject",
  "diff",
  "apply",
  "schedule",
  "compare",
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
    "  odw status <run_id>                                show a run's current state, tokens and cost",
    "  odw logs <run_id|--workflow name> [--follow]       print a run's progress events",
    "  odw logs <run_id> --agent <id|label> [--raw]       one agent's transcript: its tool calls, results, text (--follow)",
    "  odw agents <run_id> [--json]                       list a run's agents with their saved results",
    "  odw result <run_id> [--agent <id|label>]           print a finished run's result, or one agent's (mid-run too)",
    "  odw diff <run_id> [--agent <id|label>] [--stat]    print what isolated agents changed (their kept diffs)",
    "  odw apply <run_id> --agent <id|label>|--all        preview, then apply kept diffs to this working tree (--force)",
    "                                                     --check previews only; --verify CMD rolls an apply back if CMD fails",
    "  odw compare <runA> <runB> [--json]                 what changed: setup, time, cost, failures, replies",
    "                                                     --agent <label|id> shows one agent's whole reply diff",
    "  odw list [--workflow <name>]                       list known runs",
    "  odw serve [--port N] [--host H] [--open]           open the live dashboard in a browser",
    "  odw workflows list [--project|--global|--all]      list workflows runnable by name",
    "  odw workflows where <name>                         show the file a name resolves to",
    "  odw pause|resume|stop <run_id>                     control a running workflow",
    "  odw approve|reject <run_id> [--checkpoint N]       answer a checkpoint() the run waits at (--note TEXT)",
    "  odw schedule add <name> <workflow> --cron EXPR     run a workflow on a timer via cron/launchd/systemd (below)",
    "  odw schedule list [--json] | remove|run <name>     list schedules; delete one; run one now",
    "",
    "Options:",
    "  --args JSON|@file   workflow input (JSON, @file.json, or a raw string)",
    "  --config <path>     path to an odw.config.json",
    "  --runs-root <dir>   directory runs are stored under",
    "  --source <dir>      run's working dir; also anchors a relative script path & project-name lookup",
    "  --adapter <name>    default agent() adapter for this run (explicit agent(p,{adapter}) still wins)",
    "  --permissions <t>   read | edit | full: what this run's agents may do (default edit; ODW extension)",
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
    "                              modes and --adapter/--permissions/--config/--runs-root, like rerun",
    "  still running               refused (it would redo work in flight); --force starts the new run anyway",
    "",
    "Schedules (odw schedule, ODW extension — no daemon: cron, launchd or a systemd timer calls odw back):",
    "  add <name> <workflow> --cron \"0 8 * * *\" [--args JSON|@file] [--adapter X] [--config P] [--cwd DIR]",
    "      [--backend cron|launchd|systemd] [--dry-run]     default: launchd on macOS, cron elsewhere",
    "  list [--json]               each schedule's backend, last run and next run (local time)",
    "  remove <name>               delete its OS entry and its definition (fine if the entry is gone already)",
    "  run <name>                  what the OS entry calls: runs it like run --wait, skipped while the previous",
    "                              run still goes on; a line per run in ~/.local/state/odw/schedules/<name>.log;",
    "                              exit 0 when done or skipped, 1 otherwise",
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
      case "approve":
      case "reject":
        return cmdDecide(command, rest);
      case "diff":
        return await cmdDiff(rest);
      case "apply":
        return await cmdApply(rest);
      case "schedule":
        return await cmdSchedule(rest, { parseArgsValue });
      case "compare":
        return cmdCompare(rest);
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
  // Smoke agents lead their own process groups, out of the terminal's reach:
  // on Ctrl-C (or a kill) take them down first, then die by the same signal.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals) => {
    killAllAgentProcesses();
    for (const s of signals) process.off(s, onSignal);
    process.kill(process.pid, signal);
  };
  for (const s of signals) process.on(s, onSignal);
  let report;
  try {
    report = await runDoctor({
      config,
      configPath,
      cwd,
      smoke,
      smokeTimeout: timeoutMs !== undefined ? timeoutMs / 1000 : undefined,
    });
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
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
      permissions: { type: "string" },
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
  const permissions = parsePermissions("run", values.permissions);

  warnIfNoDefaultAdapter(values.adapter ?? null, values.config ?? null, values.source ?? null, "run");

  const { runId, store } = startRun(ref, {
    args: parseArgsValue(values.args),
    configPath: values.config ?? null,
    runsRoot: values["runs-root"] ?? null,
    source: values.source ?? null,
    adapter: values.adapter ?? null,
    permissions,
    budgetTotal,
  });

  return afterStart(store, runId, mode, {
    timeoutMs,
    hint: "started run",
    banner: startBanner(values.config ?? null, values.source ?? null, permissions),
  });
}

/** `--permissions <tier>` (ODW extension), validated; null when absent. */
function parsePermissions(cmd: string, raw: string | undefined): PermissionTier | null {
  if (raw === undefined) return null;
  if (isPermissionTier(raw)) return raw;
  throw new UsageError(`odw ${cmd}: --permissions must be read, edit or full; got '${raw}'`);
}

/**
 * The start banner (ODW extensions), a line each: the permissions line — the
 * run's tier and what each installed adapter runs with — and the concurrency
 * line, the caps the run's agents get (per adapter too). Both from the config
 * the worker will load, which resolves a project-local file against --source
 * (see warnIfNoDefaultAdapter). Undefined when that config cannot be read:
 * the launch itself reports that.
 */
function startBanner(configPath: string | null, source: string | null, permissions: PermissionTier | null): string | undefined {
  try {
    const config = loadConfig(configPath, { quiet: true, ...(source ? { cwd: resolve(source) } : {}) });
    if (permissions) config.settings.permissions = permissions;
    return [
      permissionsBanner(config, (adapter) => isOnPath(adapter.command[0]!)),
      `concurrency: ${describeConcurrency(config)}`,
    ].join("\n");
  } catch {
    return undefined;
  }
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
  opts: { timeoutMs?: number; hint: string; banner?: string },
): Promise<number> {
  // The start banner (permissions, concurrency) goes to stderr in every mode
  // — under the live view's header when attached.
  const banner = bannerLines(opts.banner)
    .map((line) => `${line}\n`)
    .join("");
  if (mode === "detach") {
    process.stdout.write(runId + "\n");
    process.stderr.write(`${opts.hint} ${runId} (use 'odw status ${runId}')\n${banner}`);
    return 0;
  }
  if (mode === "wait") {
    process.stderr.write(`running ${runId} ...\n${banner}`);
    // A checkpoint() holds the run until someone answers it: say so, and how, once each.
    const told = new Set<number>();
    // A pause for a spent quota (ODW extension: quotaWait) ends by itself: say until when, once each.
    const toldPauses = new Set<string>();
    let flags: string[] | undefined;
    const status = await waitFor(store, runId, {
      timeoutMs: opts.timeoutMs,
      onStatus: ({ waiting, state, pausedFor }) => {
        const pause = state === "paused" ? pausedForOf(pausedFor) : null;
        if (pause && !toldPauses.has(`${pause.adapter}@${pause.resumeAt}`)) {
          toldPauses.add(`${pause.adapter}@${pause.resumeAt}`);
          process.stderr.write(`${sanitizeText(pausedText(pause), 120)} — odw resume ${runId} goes on now\n`);
        }
        const cp = waiting as { checkpointId?: unknown; title?: unknown } | null | undefined;
        if (!cp || !isCheckpointId(cp.checkpointId) || told.has(cp.checkpointId)) return;
        told.add(cp.checkpointId);
        const { approve, reject } = checkpointCommands(runId, cp.checkpointId, (flags ??= storeFlagsFor(store)));
        process.stderr.write(
          `waiting for a decision — checkpoint #${cp.checkpointId}: ${sanitizeText(cp.title, 200)}\n` +
            `  approve: ${approve}\n  reject:  ${reject}\n`,
        );
      },
    });
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
    commandFlags: storeFlagsFor(store),
    banner: opts.banner,
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
    commandFlags: storeFlagsFor(store),
  });
}

function cmdStatus(rest: string[]): number {
  const { store, runId } = storeAndRun(rest);
  if (!store) return runId ? 1 : 2;
  const status = store.readStatus(runId);
  const meta = store.readMeta(runId);
  const events = store.readEvents(runId);
  const name = (status.name as string) || baseName(meta.script as string | undefined);
  // What waits for a person (checkpoint(), ODW extension): only a live run can be answered.
  const run = detail(store, runId);
  const pending = run.pendingCheckpoints ?? [];
  process.stdout.write(`${runId}  [${run.state === "waiting" ? "waiting" : (status.state ?? "?")}]  ${name}\n`);
  if (status.description) process.stdout.write(`  ${status.description as string}\n`);
  // What a run paused for a spent quota waits for (ODW extension: quotaWait).
  if (run.pausedFor) {
    process.stdout.write(`  ${sanitizeText(pausedText(run.pausedFor), 120)} — its agents go on then; odw resume ${runId} goes on now\n`);
  }
  process.stdout.write(`  dispatched: ${dispatchedCount(events, status)} agent(s)\n`);
  // What its agents spent (ODW extension): as their CLIs reported it, or chars/4 estimates.
  if (run.usage) process.stdout.write(`  usage: ${formatUsage(run.usage)}${estimateNote(run)}\n`);
  // Each adapter CLI's version, as the run recorded it (ODW extension; see provenance.ts).
  const clis = Object.entries(run.cliVersions ?? {}).map(([name, cli]) => `${name} ${cli.version ?? `unknown (${cli.error ?? "?"})`}`);
  if (clis.length > 0) process.stdout.write(`  CLIs: ${sanitizeText(clis.join(" · "), 300)}\n`);
  // Agents that fell back to another adapter, and adapters the quota breaker took out (ODW extensions).
  for (const line of fallbackLines(run.agents, events)) process.stdout.write(`  ${line}\n`);
  if (typeof meta.resumedFrom === "string") {
    const replayed = events.filter((e) => e.type === "agent_finished" && e.cached === true).length;
    process.stdout.write(`  resumed from: ${meta.resumedFrom} (${replayed} agent result(s) replayed)\n`);
  }
  const flags = pending.length > 0 ? storeFlagsFor(store) : [];
  for (const cp of pending) {
    const since = new Date(cp.since * 1000).toLocaleTimeString();
    const { approve, reject } = checkpointCommands(runId, cp.checkpointId, flags);
    process.stdout.write(`  waiting for a decision since ${since} — checkpoint #${cp.checkpointId}: ${sanitizeText(cp.title, 200)}\n`);
    for (const line of payloadPreview(cp.payload)) process.stdout.write(`    ${line}\n`);
    process.stdout.write(`    approve: ${approve}\n    reject:  ${reject}\n`);
  }
  if (pending.length > 0) process.stdout.write("    (--note TEXT tells the workflow why)\n");
  return 0;
}

/** Lines of a checkpoint's payload a terminal shows: the start of it; the dashboard has it whole. */
function payloadPreview(payload: unknown, maxLines = 20): string[] {
  if (payload === null || payload === undefined) return [];
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  // Workflow-controlled text: sanitized, but keeping its indentation (the JSON's nesting).
  const lines = text.split("\n").map((line) => /^ */.exec(line)![0] + sanitizeText(line, 160));
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more line(s): the dashboard (odw serve) shows it all`);
  return ["payload:", ...shown.map((line) => `  ${line}`)];
}

/** Why a run's usage reads `~`: how many of its agents' CLIs reported no output tokens. */
function estimateNote(run: RunDetail): string {
  if (!run.usage?.estimated) return "";
  const counted = run.agents.filter((a) => a.usage);
  const estimated = counted.filter((a) => a.usage!.estimated).length;
  return estimated === counted.length
    ? " (estimated: chars/4 of the replies — the adapter reports no usage)"
    : ` (estimated in part: ${estimated} of ${counted.length} agents reported no output tokens)`;
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

/**
 * `odw diff <run_id> [--agent <id|label>] [--stat]` (ODW extension) — what the
 * run's isolated agents changed, as the diffs kept in its directory: every
 * agent that kept one, each under a `# odw: agent …` line, or `--agent`'s
 * alone, verbatim. `--stat` prints a table instead (and `--agent`'s files).
 */
async function cmdDiff(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      agent: { type: "string" },
      stat: { type: "boolean" },
    },
  });
  const runId = positionals[0];
  if (!runId) throw new UsageError("odw diff: missing <run_id>");
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const rows = agentRows(store, runId);
  let agents = changedAgents(store, runId, rows);
  if (values.agent !== undefined) {
    const row = findAgent(rows, runId, values.agent, "diff");
    if (!row) return 1;
    agents = agents.filter((a) => a.row.agentId === row.agentId);
    if (agents.length === 0) {
      process.stderr.write(`agent ${row.agentId} (${sanitizeText(row.label, 80)}) kept no diff: ${noDiffReason(row)}\n`);
      return 0;
    }
  } else if (agents.length === 0) {
    process.stderr.write(
      `run ${runId} kept no changes: agents that run with isolation: "worktree" keep a diff of what they changed\n`,
    );
    return 0;
  }
  const caps = detectCaps(process.stdout, process.env);
  const width = process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120;
  if (values.stat) {
    const counted: Array<{ row: AgentRow; changes: AgentChanges; text?: string }> = [];
    for (const { row, file } of agents) {
      // The event's counts describe the whole change; the diff's own, a kept diff whose event is gone.
      const text = row.changes && values.agent === undefined ? undefined : await readFile(file, "utf8");
      counted.push({ row, changes: row.changes ?? countChanges(text!), text });
    }
    for (const line of formatChangeTable(counted, { width, caps })) process.stdout.write(line + "\n");
    const one = counted.length === 1 && values.agent !== undefined ? counted[0]! : undefined;
    if (one?.text !== undefined) {
      for (const line of formatFileList(diffFiles(one.text), { width, caps })) process.stdout.write(line + "\n");
      const cut = truncationNoteOf(one.text);
      if (cut) process.stdout.write(`  ${sanitizeText(cut, width)}\n`);
    }
    process.stderr.write(`full diff: odw diff ${runId} --agent <id|label> · apply one: odw apply ${runId} --agent <id|label>\n`);
    return 0;
  }
  // Colour only for a terminal: a diff piped or saved stays a patch git can read.
  const paint = process.stdout.isTTY === true && caps.color;
  for (const { row, file } of agents) {
    const text = await readFile(file, "utf8");
    if (values.agent === undefined) {
      const c = row.changes ?? countChanges(text);
      const kept = row.branch ? ` · branch ${row.branch}` : "";
      const head = `# odw: agent ${row.agentId} · ${sanitizeText(row.label, 80)} · ${c.files} file(s) +${c.insertions} -${c.deletions}${kept}`;
      process.stdout.write((paint ? colorDiff(head, caps) : head) + "\n");
    }
    process.stdout.write(paint ? colorDiff(text, caps) : text);
  }
  return 0;
}

/**
 * `odw apply <run_id> (--agent <id|label> | --all) [--check] [--force]
 * [--verify CMD | --no-verify]` (ODW extension) — preview, then apply, what
 * isolated agents changed to the git working tree you are in (see
 * runtime/apply): one agent's kept diff, or every finished agent's in agentId
 * order up to the first that would conflict. `--check` previews only;
 * `--verify` (else the `applyVerify` setting) runs a command after each apply
 * and rolls the apply back when it fails. Exit 0 when everything applied
 * cleanly (and passed), 1 otherwise. A signal during a verify rolls its apply
 * back, then ends odw by that signal.
 */
async function cmdApply(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      agent: { type: "string" },
      all: { type: "boolean" },
      check: { type: "boolean" },
      force: { type: "boolean" },
      verify: { type: "string" },
      "no-verify": { type: "boolean" },
    },
  });
  const runId = positionals[0];
  if (!runId) throw new UsageError("odw apply: missing <run_id>");
  if (values.agent === undefined && !values.all) {
    throw new UsageError(
      `odw apply: --agent <id|label> or --all is required — which agent's change to apply (odw diff ${runId} --stat lists them)`,
    );
  }
  if (values.agent !== undefined && values.all) throw new UsageError("odw apply: --agent and --all exclude each other");
  if (values.verify !== undefined && values["no-verify"]) throw new UsageError("odw apply: --verify and --no-verify exclude each other");
  if (values.verify !== undefined && values.verify.trim() === "") {
    throw new UsageError('odw apply: --verify needs a command to run, e.g. --verify "npm test"');
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const rows = agentRows(store, runId);
  let agents: AgentDiff[];
  if (values.all) {
    agents = changedAgents(store, runId, rows);
    if (agents.length === 0) {
      process.stderr.write(`run ${runId} kept no changes: agents that run with isolation: "worktree" keep a diff of what they changed\n`);
      return 0;
    }
  } else {
    const row = findAgent(rows, runId, values.agent!, "apply");
    if (!row) return 1;
    const file = store.agentDiffPath(runId, row.agentId);
    if (!existsSync(file)) {
      process.stderr.write(`odw apply: agent ${row.agentId} (${sanitizeText(row.label, 80)}) of run ${runId} kept no diff: ${noDiffReason(row)}\n`);
      return 1;
    }
    agents = [{ row, file }];
  }
  const check = values.check === true;
  // --check applies nothing, so it verifies nothing; --no-verify skips the applyVerify setting once.
  const settings = check || values["no-verify"] ? null : loadConfig(values.config ?? null, { quiet: true }).settings;
  const verify = settings ? (values.verify ?? settings.applyVerify) : null;
  const source = store.readMeta(runId).source;
  // A signal while an apply is verified stops the command; the apply is rolled back before odw ends by it.
  const interrupt = new AbortController();
  let caught: NodeJS.Signals | null = null;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals): void => {
    caught ??= signal;
    interrupt.abort();
  };
  if (verify) for (const s of signals) process.on(s, onSignal);
  // A pipe or terminal that goes away (EPIPE, EIO) must not end odw between an apply and its rollback.
  const unheard = (): void => {};
  process.stdout.on("error", unheard);
  process.stderr.on("error", unheard);
  try {
    return await applyAgents({
      cwd: process.cwd(),
      runId,
      agents,
      all: values.all === true,
      check,
      force: values.force === true,
      verify,
      timeout: settings?.timeout ?? null,
      interrupt: interrupt.signal,
      source: typeof source === "string" ? source : undefined,
      out: process.stdout,
      err: process.stderr,
      caps: detectCaps(process.stdout, process.env),
      width: process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120,
    });
  } finally {
    process.stdout.off("error", unheard);
    process.stderr.off("error", unheard);
    for (const s of signals) process.off(s, onSignal);
    if (caught) process.kill(process.pid, caught);
  }
}

/**
 * `odw compare <runA> <runB> [--json] [--agent <label|id>]` (ODW extension) —
 * what changed from run A to run B (see runtime/compare): the setup each ran
 * with, time, tokens, cost, which agents failed, whether their replies
 * differ. `--json` prints the comparison; `--agent` one agent's row and its
 * whole reply diff (with `--json`, that row). A run still going is compared
 * as it stands. Exit 0 once compared, 1 for a missing run or agent.
 */
function cmdCompare(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      json: { type: "boolean" },
      agent: { type: "string" },
    },
  });
  const [runA, runB, extra] = positionals;
  if (!runA || !runB || extra !== undefined) throw new UsageError("usage: odw compare <runA> <runB> [--json] [--agent <label|id>]");
  const store = storeFrom(values);
  for (const id of [runA, runB]) {
    if (!store.exists(id)) {
      process.stderr.write(`no such run: ${id}\n`);
      return 1;
    }
  }
  const a = readCompareRun(store, runA);
  const b = readCompareRun(store, runB);
  const caps = detectCaps(process.stdout, process.env);
  const width = Math.min(100, process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 100);
  if (values.agent !== undefined) {
    const bounded = compareRuns(a, b).agents;
    const rows = findComparedAgents(bounded, values.agent);
    if (rows.length === 0) {
      process.stderr.write(`neither run has an agent '${values.agent}' (see odw compare ${runA} ${runB})\n`);
      return 1;
    }
    if (rows.length > 1) {
      const which = rows.map((r) => `A#${r.a?.agentId ?? "-"}↔B#${r.b?.agentId ?? "-"}`).join(", ");
      process.stderr.write(
        `'${values.agent}' matches ${rows.length} agents: ${which} — pick one by its id in A (else B): --agent <id>\n`,
      );
      return 1;
    }
    // The whole reply diff: the comparison again, its bounds lifted — the same rows, in the same order.
    const full = compareRuns(a, b, { diffLines: Infinity, jsonPaths: Infinity, chars: Infinity });
    const row = full.agents[bounded.indexOf(rows[0]!)]!;
    if (values.json) {
      process.stdout.write(JSON.stringify(row, null, 2) + "\n");
      return 0;
    }
    for (const line of formatAgentComparison(row, full, { width, caps })) process.stdout.write(line + "\n");
    return 0;
  }
  const comparison = compareRuns(a, b);
  if (values.json) {
    process.stdout.write(JSON.stringify(comparison, null, 2) + "\n");
    return 0;
  }
  for (const line of formatComparison(comparison, { width, caps })) process.stdout.write(line + "\n");
  process.stderr.write(`one agent's whole reply diff: odw compare ${runA} ${runB} --agent <label|id> · all of it as JSON: --json\n`);
  return 0;
}

/** The one agent `ref` names (an id or a label), or null once the reason it is none is printed. */
function findAgent(rows: AgentRow[], runId: string, ref: string, cmd: string): (AgentRow & { agentId: number }) | null {
  const matches = matchAgents(rows, ref);
  if (matches.length === 0) {
    process.stderr.write(`run ${runId} has no agent '${ref}' (see odw agents ${runId})\n`);
    return null;
  }
  if (matches.length > 1) {
    const ids = matches.map((r) => `${r.agentId ?? "?"} (${r.state})`).join(", ");
    process.stderr.write(
      `label '${ref}' matches ${matches.length} agents of run ${runId}: ${ids} — pick one: odw ${cmd} ${runId} --agent <id>\n`,
    );
    return null;
  }
  const row = matches[0]!;
  if (row.agentId === null) {
    const kept = cmd === "logs" ? "transcript" : "diff";
    process.stderr.write(`that agent of run ${runId} has no id (a run from before agent ids): it kept no ${kept}\n`);
    return null;
  }
  return row as AgentRow & { agentId: number };
}

/** Why an agent has no kept diff. */
function noDiffReason(row: AgentRow): string {
  if (row.state === "running") return "it is still running";
  return 'it changed nothing, or it did not run with isolation: "worktree"';
}

/**
 * `odw logs <run_id> [--follow]` prints a run's progress events; with `--agent
 * <id|label>` one agent's transcript instead — what its CLI printed (ODW
 * extension; see runtime/transcript-view): readable, or its lines as kept
 * with `--raw`, and with `--follow` until that agent settles.
 */
async function cmdLogs(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      follow: { type: "boolean" },
      workflow: { type: "string" },
      agent: { type: "string" },
      raw: { type: "boolean" },
    },
  });
  if (values.raw && values.agent === undefined) {
    throw new UsageError("odw logs: --raw prints an agent's transcript as kept — name the agent with --agent <id|label>");
  }
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
  if (values.agent !== undefined) {
    const row = findAgent(agentRows(store, runId), runId, values.agent, "logs");
    if (!row) return 1;
    const caps = detectCaps(process.stdout, process.env);
    const width = process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120;
    return printAgentLogs(store, runId, row, {
      raw: values.raw === true,
      follow: values.follow === true,
      out: process.stdout,
      err: process.stderr,
      caps,
      width,
    });
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
    // status.json names the checkpoint() a running run waits at (ODW extension).
    const state = status.state === "running" && status.waiting ? "waiting" : String(status.state ?? "?");
    // …and what a run paused for a spent quota waits for (ODW extension: quotaWait).
    const pausedFor = status.state === "paused" ? pausedForOf(status.pausedFor) : null;
    const until = pausedFor ? `  ${sanitizeText(pausedText(pausedFor), 120)}` : "";
    process.stdout.write(`${ref.runId}  ${state.padEnd(8)}  ${name}${until}\n`);
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
  permissions: { type: "string" },
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
  const permissions = parsePermissions("rerun", values.permissions);
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  return relaunch("rerun", store, runId, { ...values, permissions }, start);
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
  const permissions = parsePermissions("resume", values.permissions);
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
      const newRunFlag = ["adapter", "permissions", "wait", "fg", "detach", "timeout"].find((f) => given[f] !== undefined);
      if (newRunFlag) {
        throw new UsageError(
          `odw resume: run ${runId} is paused, so resume continues it in place — ` +
            `--${newRunFlag} applies only when resume starts a new run`,
        );
      }
      store.writeControl(runId, "resume");
      // A pause for a spent quota (ODW extension: quotaWait) ends at once: its agents retry now.
      const pausedFor = pausedForOf(store.readStatus(runId).pausedFor);
      const quota = pausedFor ? ` — it was ${sanitizeText(pausedText(pausedFor), 120)}; its agents go on now` : "";
      process.stderr.write(`resume requested for ${runId}${quota}\n`);
      return 0;
    }
    // A run waiting at a checkpoint() goes on once someone answers it, not by resume.
    const waiting = store.readStatus(runId).waiting as { checkpointId?: unknown } | null | undefined;
    const answer =
      waiting && isCheckpointId(waiting.checkpointId)
        ? `  It waits for a decision at checkpoint #${waiting.checkpointId}: odw approve|reject ${runId} (see odw status ${runId}).\n`
        : "";
    process.stderr.write(
      `odw resume: run ${runId} is still ${control === "stop" ? "stopping" : state} — only a paused run continues in place.\n` +
        answer +
        `  To replay its finished agents in a new run, let it end first (odw stop ${runId}), or pass --force.\n`,
    );
    return 1;
  }
  return relaunch("resume", store, runId, { ...values, permissions }, start);
}

/**
 * Start a new run from an existing run's recorded inputs — script, args,
 * source, config, budget, run-level adapter and permission tier (`--adapter`
 * and `--permissions` override the last two) — and present it per the
 * resolved mode. `rerun` starts over; `resume` also records the source run,
 * whose saved agent results the new run's worker replays for every agent()
 * call that is unchanged.
 */
async function relaunch(
  cmd: "rerun" | "resume",
  store: RunStore,
  runId: string,
  flags: { "runs-root"?: string; adapter?: string; permissions: PermissionTier | null },
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
    permissions: flags.permissions ?? (isPermissionTier(meta.permissions) ? meta.permissions : null),
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
    banner: startBanner(opts.configPath, opts.source, opts.permissions),
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

/**
 * `odw approve|reject <run_id> [--note TEXT] [--checkpoint N]` — answer a
 * checkpoint() the run waits at (ODW extension): checkpoint N, else the
 * oldest one waiting. The answer always names the checkpoint the person saw,
 * so it can never land on a question asked after they decided; the run picks
 * it up from its decision log within a fraction of a second.
 */
function cmdDecide(action: "approve" | "reject", rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      note: { type: "string" },
      checkpoint: { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId) throw new UsageError(`odw ${action}: missing <run_id>`);
  let checkpointId: number | undefined;
  if (values.checkpoint !== undefined) {
    checkpointId = /^\d+$/.test(values.checkpoint) ? Number(values.checkpoint) : NaN;
    if (!isCheckpointId(checkpointId)) {
      throw new UsageError(`odw ${action}: --checkpoint must be a checkpoint number (1, 2, …)`);
    }
  }
  const note = values.note;
  if (note !== undefined && note.length > CHECKPOINT_NOTE_MAX) {
    throw new UsageError(`odw ${action}: --note must be at most ${CHECKPOINT_NOTE_MAX} characters`);
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const run = detail(store, runId);
  const pending = run.pendingCheckpoints ?? [];
  const target = checkpointId === undefined ? pending[0] : pending.find((cp) => cp.checkpointId === checkpointId);
  if (!target) {
    const open = pending.map((cp) => `#${cp.checkpointId} ${JSON.stringify(sanitizeText(cp.title, 80))}`).join(", ");
    process.stderr.write(
      pending.length === 0
        ? `run ${runId} has no checkpoint waiting for a decision (it is ${run.state})\n`
        : `checkpoint #${checkpointId} of run ${runId} is not waiting for a decision; waiting: ${open}\n`,
    );
    return 1;
  }
  store.requestCheckpointDecision(runId, {
    action,
    checkpointId: target.checkpointId,
    ...(note !== undefined && note.trim() !== "" ? { note } : {}),
    by: "cli",
  });
  process.stderr.write(
    `${action} requested for checkpoint #${target.checkpointId} ${JSON.stringify(sanitizeText(target.title, 120))} of ${runId}\n`,
  );
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

/**
 * What a printed `odw …` command needs to find a run in `store` from here:
 * `--runs-root` unless the store is the one a bare command resolves to.
 */
function storeFlagsFor(store: RunStore): string[] {
  try {
    if (resolve(resolveRunsRoot(loadConfig(null, { quiet: true }).settings.runsRoot)) === resolve(store.root)) {
      return [];
    }
  } catch {
    // An unreadable default config: name the runs root outright.
  }
  return ["--runs-root", resolve(store.root)];
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
