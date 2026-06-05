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
 *   odw result <run_id>
 *   odw pause|resume|stop <run_id>
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig, resolveRunsRoot } from "./adapters/config.js";
import type { WorkflowEvent } from "./events.js";
import { VERSION } from "./index.js";
import { startRun, waitFor } from "./runtime/launcher.js";
import { RunStore, TERMINAL_STATES } from "./runtime/run-store.js";
import { startServer } from "./runtime/server.js";
import { executeRun } from "./runtime/worker.js";
import { isSeaBinary } from "./sea.js";
import { listWorkflows, resolveWorkflow } from "./workflows/resolve.js";

export const COMMANDS = [
  "run",
  "rerun",
  "list",
  "status",
  "logs",
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
    "  odw run <script.js|name> [--args JSON|@file] [--wait]  start a workflow (background)",
    "  odw rerun <run_id>                                 start a fresh run with the same inputs",
    "  odw status <run_id>                                show a run's current state",
    "  odw logs <run_id|--workflow name> [--follow]       print a run's progress events",
    "  odw result <run_id>                                print a finished run's result",
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
    "  --wait              block until the run finishes and print the result",
    "  --port <n>          dashboard port (serve; default 4317)",
    "  --host <addr>       dashboard bind address (serve; default 127.0.0.1)",
    "  --open              open the dashboard in the default browser (serve)",
    "  -h, --help          show this help",
    "  -v, --version       show the version",
  ].join("\n");
}

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
      case "run":
        return await cmdRun(rest);
      case "rerun":
        return cmdRerun(rest);
      case "status":
        return cmdStatus(rest);
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
      case "resume":
      case "stop":
        return cmdControl(command, rest);
      default:
        process.stderr.write(`odw: unknown command '${command}'\n\n${helpText()}\n`);
        return 2;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    process.stderr.write(`odw: ${e.message}\n`);
    // A parseArgs usage error (unknown flag, missing value) is a usage error → 2.
    return typeof e.code === "string" && e.code.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  }
}

// --- commands ----------------------------------------------------------------

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

async function cmdRun(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      args: { type: "string" },
      config: { type: "string" },
      "runs-root": { type: "string" },
      source: { type: "string" },
      wait: { type: "boolean" },
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

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds < 0) {
      process.stderr.write("odw run: --timeout must be a non-negative number of seconds\n");
      return 2;
    }
    timeoutMs = seconds * 1000;
  }

  const { runId, store } = startRun(ref, {
    args: parseArgsValue(values.args),
    configPath: values.config ?? null,
    runsRoot: values["runs-root"] ?? null,
    source: values.source ?? null,
    budgetTotal,
  });

  if (!values.wait) {
    process.stdout.write(runId + "\n");
    process.stderr.write(`started run ${runId} (use 'odw status ${runId}')\n`);
    return 0;
  }

  process.stderr.write(`running ${runId} ...\n`);
  const status = await waitFor(store, runId, { timeoutMs });
  return reportTerminal(store, runId, status);
}

function cmdStatus(rest: string[]): number {
  const { store, runId } = storeAndRun(rest);
  if (!store) return runId ? 1 : 2;
  const status = store.readStatus(runId);
  const meta = store.readMeta(runId);
  const name = (status.name as string) || baseName(meta.script as string | undefined);
  process.stdout.write(`${runId}  [${status.state ?? "?"}]  ${name}\n`);
  if (status.description) process.stdout.write(`  ${status.description as string}\n`);
  process.stdout.write(`  dispatched: ${status.dispatched ?? 0} agent(s)\n`);
  return 0;
}

function cmdResult(rest: string[]): number {
  const { store, runId } = storeAndRun(rest);
  if (!store) return runId ? 1 : 2;
  return reportTerminal(store, runId, store.readStatus(runId));
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
  let seen = 0;
  for (;;) {
    const events = store.readEvents(runId);
    for (const ev of events.slice(seen)) process.stdout.write(formatEvent(ev) + "\n");
    seen = events.length;
    if (!values.follow) return 0;
    if (TERMINAL_STATES.has(store.readStatus(runId).state as string)) return 0;
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

/** `odw rerun <run_id>` — start a fresh run with the same inputs as an existing one. */
function cmdRerun(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw rerun: missing <run_id>\n");
    return 2;
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const meta = store.readMeta(runId);
  const script = meta.script as string | undefined;
  if (!script) {
    process.stderr.write(`run ${runId} has no script to rerun\n`);
    return 1;
  }
  const { runId: newId } = startRun(script, {
    args: meta.args,
    configPath: (meta.configPath as string | null) ?? null,
    runsRoot: values["runs-root"] ?? null,
    source: (meta.source as string | undefined) ?? null,
    budgetTotal: (meta.budgetTotal as number | null) ?? null,
  });
  process.stdout.write(newId + "\n");
  process.stderr.write(`re-running ${runId} as ${newId} (use 'odw status ${newId}')\n`);
  return 0;
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

  const handle = await startServer({ store, port, host });
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
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
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
    process.stderr.write("  add one by dropping a .js file in ./.odw/workflows (project) or ~/.odw/workflows (global)\n");
    return 0;
  }
  const width = Math.max(...entries.map((e) => e.name.length));
  for (const e of entries) {
    const shadow = e.shadowed ? "  ⚠ shadowed by project" : "";
    process.stdout.write(`${e.name.padEnd(width)}  (${e.origin.padEnd(7)})  ${e.path}${shadow}\n`);
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
    const { scriptPath, origin } = resolveWorkflow(name, { cwd: process.cwd(), config });
    process.stdout.write(`${scriptPath}  (${origin})\n`);
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
    process.stderr.write(`run failed: ${error.error ?? "unknown error"}\n`);
    return 1;
  }
  if (state === "stopped") {
    process.stderr.write("run was stopped before completion\n");
    return 1;
  }
  process.stderr.write(`run is still '${String(state)}'; not finished\n`);
  return 1;
}

function parseArgsValue(raw?: string): unknown {
  if (raw === undefined) return null;
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return JSON.parse(text);
  } catch {
    return text; // a plain string that isn't JSON, e.g. --args hello
  }
}

function formatEvent(ev: WorkflowEvent): string {
  const stamp = new Date(((ev.ts as number) ?? 0) * 1000).toLocaleTimeString();
  const type = String(ev.type ?? "?");
  const phase = ev.phase ? ` (${String(ev.phase)})` : "";
  let detail = "";
  if (type === "log") detail = String(ev.message ?? "");
  else if (type === "phase_started") detail = `phase: ${String(ev.phase ?? "")}`;
  else if (type.startsWith("agent_")) {
    detail = String(ev.label ?? "agent");
    if (type === "agent_failed") detail += ` — ${String(ev.error ?? "")}`;
  } else detail = String(ev.error ?? ev.runId ?? "");
  return `[${stamp}] ${type.padEnd(15)}${phase} ${detail}`.trimEnd();
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
