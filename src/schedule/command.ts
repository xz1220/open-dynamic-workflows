/**
 * `odw schedule` — recurring runs through the operating system's own
 * scheduler (an ODW extension). odw runs no daemon: `add` writes a cron line, a
 * launchd agent or a systemd timer that calls `odw schedule run <name>` back.
 *
 *   odw schedule add <name> <workflow> --cron EXPR [--args JSON|@file] [--adapter X]
 *                    [--config P] [--cwd DIR] [--backend cron|launchd|systemd] [--dry-run]
 *   odw schedule list [--json]
 *   odw schedule remove <name>
 *   odw schedule run <name>
 *
 * `run` is what the OS entry calls, and a manual trigger. It holds the
 * schedule's lock — while a previous run still goes on, the new one is skipped
 * — then runs the workflow like `odw run --wait` (through the launcher, not a
 * second odw process), logs one line per outcome, records the run as the
 * schedule's last, and exits non-zero unless the run finished `done`. A failed
 * run fires the configured `notify` hooks like any other: the worker does that.
 */

import { existsSync, fstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  CONFIG_ENV_VAR,
  homeDir,
  loadConfig,
  locateConfig,
  resolveAdapter,
  resolveRunsRoot,
} from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { isCheckpointId } from "../control.js";
import { AdapterNotFound, DynamicWorkflowError } from "../errors.js";
import { loadWorkflowScript } from "../loader.js";
import { startRun, tsxLoaderArgv, waitFor } from "../runtime/launcher.js";
import { checkpointCommands } from "../runtime/live-view.js";
import { formatDuration } from "../runtime/notify.js";
import { isRunActive } from "../runtime/run-liveness.js";
import { RunStore, TERMINAL_STATES } from "../runtime/run-store.js";
import { isSeaBinary } from "../sea.js";
import { sanitizeText } from "../tty.js";
import { resolveWorkflow } from "../workflows/resolve.js";
import {
  BACKENDS,
  install,
  isInstalled,
  planInstall,
  runExecutor,
  schtasksLine,
  shQuote,
  tryReadCrontab,
  uninstall,
  type Backend,
  type BackendEnv,
  type EntrySpec,
  type Executor,
  type InstallPlan,
} from "./backends.js";
import { CronError, launchdIntervals, nextFire, parseCron, type CronSpec } from "./cron.js";
import {
  SCHEDULE_NAME_RE,
  acquireLock,
  appendLog,
  checkDefinition,
  entryName,
  lastRunPath,
  localIso,
  localMinute,
  lockPath,
  logPath,
  readLastRun,
  readScheduleFile,
  schedulePaths,
  writeLastRun,
  writeScheduleFile,
  type LastRun,
  type LockHolder,
  type ScheduleDefinition,
} from "./store.js";

export interface ScheduleDeps {
  /** Reads `--args` exactly as `odw run` does: cli.ts passes its own parser. */
  parseArgsValue: (raw?: string) => unknown;
  /** Runs crontab, launchctl and systemctl. */
  exec?: Executor;
  /** Decides the default backend (launchd on darwin, cron elsewhere) and Windows' message. */
  platform?: NodeJS.Platform;
  now?: () => Date;
}

/** A finished command with its exit code: the message goes to stderr as is. */
class ScheduleExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const usage = (message: string) => new ScheduleExit(2, message);

/** `odw schedule <add|list|remove|run> …`; returns the exit code. */
export async function cmdSchedule(rest: string[], deps: ScheduleDeps): Promise<number> {
  const [sub, ...args] = rest;
  try {
    switch (sub) {
      case "add":
        return scheduleAdd(args, deps);
      case "list":
        return scheduleList(args, deps);
      case "remove":
        return scheduleRemove(args, deps);
      case "run":
        return await scheduleRun(args, deps);
      default:
        throw usage(`odw schedule: expected add, list, remove or run, got '${sub ?? ""}' (see odw --help)`);
    }
  } catch (err) {
    if (err instanceof ScheduleExit) {
      process.stderr.write(`${err.message}\n`);
      return err.code;
    }
    // A bad expression is a command-line mistake; a config, workflow or scheduler problem is a failure.
    if (err instanceof CronError) {
      process.stderr.write(`odw schedule ${sub}: ${err.message}\n`);
      return 2;
    }
    if (err instanceof DynamicWorkflowError) {
      process.stderr.write(`odw schedule ${sub}: ${err.message}\n`);
      return 1;
    }
    throw err; // parseArgs usage errors and the unexpected: cli.ts reports them
  }
}

// --- add -------------------------------------------------------------------------

function scheduleAdd(rest: string[], deps: ScheduleDeps): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      cron: { type: "string" },
      args: { type: "string" },
      adapter: { type: "string" },
      config: { type: "string" },
      cwd: { type: "string" },
      backend: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const [name, workflow, extra] = positionals;
  if (!name || !workflow || extra !== undefined) {
    throw usage(
      `odw schedule add: expected <name> <workflow> --cron "<minute hour day-of-month month day-of-week>"` +
        (extra !== undefined ? `, got an extra '${extra}'` : ""),
    );
  }
  checkName("add", name);
  if (values.cron === undefined) {
    throw usage(`odw schedule add: missing --cron "<minute hour day-of-month month day-of-week>", e.g. --cron "0 8 * * *"`);
  }
  const spec = parseCron(values.cron);
  const platform = deps.platform ?? process.platform;
  const backend = pickBackend(values.backend, platform);
  if (backend === "launchd" && platform !== "win32") launchdIntervals(spec); // refuses what launchd cannot express, now

  const cwd = resolve(values.cwd ?? process.cwd());
  if (!isDirectory(cwd)) throw usage(`odw schedule add: --cwd ${cwd} is not a directory`);
  // Pin the config this shell would use: --config, else $ODW_CONFIG (the OS runs the entry without
  // this shell's environment). Without either, each run finds one from cwd, as `odw run` would.
  const pinned = values.config ?? process.env[CONFIG_ENV_VAR] ?? null;
  const configPath = pinned ? resolve(locateConfig(pinned, cwd)!) : undefined;
  const config = loadConfig(configPath ?? null, { cwd });
  if (values.adapter !== undefined) resolveAdapter(config, values.adapter);
  // Fail fast: the workflow must resolve and load now, not at the first 3 a.m. run.
  const { scriptPath, origin } = resolveWorkflow(workflow, { cwd, config });
  try {
    loadWorkflowScript(readFileSync(scriptPath, "utf8"), scriptPath);
  } catch (err) {
    throw new ScheduleExit(1, `odw schedule add: workflow ${scriptPath} does not load: ${(err as Error).message}`);
  }

  const def: ScheduleDefinition = {
    name,
    // A name is looked up from cwd at each run (so it follows edits); a path is pinned absolute.
    workflow: origin === "path" ? scriptPath : workflow,
    cron: spec.expr,
    args: deps.parseArgsValue(values.args),
    ...(values.adapter !== undefined ? { adapter: values.adapter } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    cwd,
    backend,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    odwCommand: odwInvocation(),
    path: entryPath(),
  };
  if (platform === "win32") return windowsHelp(def, spec, values["dry-run"] === true);

  const paths = schedulePaths();
  const entries = readScheduleFile(paths.definitions);
  if (entries.some((entry) => entryName(entry) === name)) {
    throw new ScheduleExit(1, `odw schedule add: a schedule named '${name}' already exists — remove it first: odw schedule remove ${name}`);
  }
  warnAbout(def, config);
  const env = backendEnv(deps);
  const log = logPath(paths.stateDir, name);
  const entry: EntrySpec = { name, cron: spec.expr, odwCommand: def.odwCommand, path: def.path, log };
  const plan = planInstall(backend, entry, spec, env);
  const next = nextFire(spec, deps.now?.() ?? new Date());
  if (values["dry-run"]) {
    process.stdout.write(dryRun(def, plan, paths.definitions, next));
    return 0;
  }

  mkdirSync(paths.stateDir, { recursive: true }); // the entry appends to the log from its first run
  writeScheduleFile(paths.definitions, [...entries, def]);
  try {
    install(plan, name, env);
  } catch (err) {
    // No definition without its OS entry: undo both, as far as they got.
    writeScheduleFile(paths.definitions, entries);
    try {
      uninstall(backend, name, env);
    } catch {
      /* the install error is the one to report */
    }
    throw new ScheduleExit(1, `odw schedule add: could not install the ${backend} entry: ${(err as Error).message}`);
  }
  process.stderr.write(
    `added schedule '${name}': ${def.workflow} at "${spec.expr}" through ${backend}\n` +
      `  next run  ${next ? `${localMinute(next)} (local time)` : "never"}\n` +
      `  log       ${log}\n` +
      `  run now   odw schedule run ${name}\n` +
      (backend === "systemd"
        ? `  systemd runs user timers only while you are logged in; to keep them running when you are not: loginctl enable-linger\n`
        : ""),
  );
  return 0;
}

/** The backend: --backend, else launchd on macOS and cron elsewhere. */
function pickBackend(flag: string | undefined, platform: NodeJS.Platform): Backend {
  if (flag === undefined) return platform === "darwin" ? "launchd" : "cron";
  if (!(BACKENDS as readonly string[]).includes(flag)) {
    throw usage(`odw schedule add: --backend must be one of ${BACKENDS.join(", ")}, got '${flag}'`);
  }
  return flag as Backend;
}

function checkName(sub: string, name: string): void {
  if (!SCHEDULE_NAME_RE.test(name)) {
    throw usage(
      `odw schedule ${sub}: invalid schedule name '${name}' — use up to 63 lowercase letters, digits, '-' and '_', ` +
        `starting with a letter or digit`,
    );
  }
}

/** How the OS entry calls this odw back: the binary itself, or node and the CLI entry (tsx's loader too, in a checkout). */
export function odwInvocation(): string[] {
  if (isSeaBinary()) return [process.execPath];
  const js = fileURLToPath(new URL("../cli.js", import.meta.url));
  if (existsSync(js)) return [process.execPath, js];
  const ts = fileURLToPath(new URL("../cli.ts", import.meta.url));
  if (existsSync(ts)) return [process.execPath, ...tsxLoaderArgv(), ts];
  return [process.execPath, js];
}

/**
 * The PATH the OS entry sets: this shell's, so agent CLIs resolve as they do
 * here (cron's own is /usr/bin:/bin), with the directory of the running node
 * (or odw binary) in it — CLIs installed by npm start with `#!/usr/bin/env node`.
 */
function entryPath(): string {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const own = dirname(process.execPath);
  if (!dirs.includes(own)) dirs.unshift(own);
  return dirs.join(delimiter);
}

/** Warnings about a schedule that would add fine but fail later. */
function warnAbout(def: ScheduleDefinition, config: Config): void {
  if (def.adapter === undefined) {
    try {
      resolveAdapter(config);
    } catch (err) {
      if (err instanceof AdapterNotFound) {
        process.stderr.write(`odw schedule add: warning: bare agent() calls in each scheduled run will fail — ${err.message}\n`);
      }
    }
  }
  if (def.odwCommand.some((part) => /[\\/]_npx[\\/]/.test(part))) {
    process.stderr.write(
      `odw schedule add: warning: this odw runs from npx's cache, which npm may clear — the schedule would then stop ` +
        `working. Install odw (npm i -g odw, or the binary) and add the schedule again.\n`,
    );
  }
}

/** What `add --dry-run` prints: everything the real add would write, nothing written. */
function dryRun(def: ScheduleDefinition, plan: InstallPlan, definitions: string, next: Date | null): string {
  const out = [`# odw schedule add --dry-run: nothing was written`, ``, `# ${definitions} gains:`, JSON.stringify(def, null, 2)];
  if (plan.cronBlock !== undefined) {
    out.push(``, `# the user crontab gains this block (written with crontab -; every other line stays as it is):`);
    out.push(plan.cronBlock.trimEnd());
  }
  for (const file of plan.files) out.push(``, `# ${file.path}:`, file.content.trimEnd());
  if (plan.backend !== "cron") out.push(``, `# then:`, ...plan.commands.map(showCommand));
  out.push(``, `# next run: ${next ? `${localMinute(next)} (local time)` : "never"}`);
  return out.join("\n") + "\n";
}

function showCommand(argv: string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : shQuote(arg))).join(" ");
}

/**
 * Windows: odw cannot install a Task Scheduler entry yet. Print a schtasks
 * line that does the same with `odw run --wait` — Task Scheduler itself skips
 * a start while the previous run goes on — and write nothing.
 */
function windowsHelp(def: ScheduleDefinition, spec: CronSpec, dryRunOnly: boolean): number {
  const argv = [
    ...def.odwCommand,
    "run",
    def.workflow,
    "--wait",
    "--source",
    def.cwd,
    ...(def.adapter !== undefined ? ["--adapter", def.adapter] : []),
    ...(def.configPath !== undefined ? ["--config", def.configPath] : []),
    ...(def.args !== null && def.args !== undefined ? ["--args", JSON.stringify(def.args)] : []),
  ];
  const { line, task, exact } = schtasksLine(def.name, spec, argv);
  process.stderr.write(
    `odw schedule add: scheduling on Windows is not supported yet — no task was created and nothing was saved.\n` +
      `  This schtasks line (for cmd.exe) creates a task that runs the workflow with odw run --wait:\n`,
  );
  process.stdout.write(`${line}\n`);
  process.stderr.write(
    (exact ? "" : `  schtasks has no exact equivalent of "${spec.expr}": adjust /SC, /MO and /ST (schtasks /Create /?).\n`) +
      (task.length > 261
        ? `  Its /TR command is ${task.length} characters, more than the 261 schtasks takes: put it in a .cmd file and give /TR that file.\n`
        : "") +
      `  Task Scheduler skips a start while the previous run is still going, and records each run's exit code.\n` +
      `  Remove it with: schtasks /Delete /TN odw-${def.name} /F\n`,
  );
  return dryRunOnly ? 0 : 1;
}

// --- list ------------------------------------------------------------------------

export interface ScheduleRow {
  def: ScheduleDefinition;
  /** The OS entry is in place; null when that cannot be told. */
  installed: boolean | null;
  lastRun: { runId: string | null; state: string; at: string } | null;
  nextRun: Date | null;
  log: string;
}

/**
 * Every schedule with whether its OS entry is in place, its last run and its
 * next fire time — what `odw schedule list` prints and `GET /api/schedules`
 * serves. A definition that no longer checks out is reported to `onSkip`.
 */
export function listSchedules(
  deps: Pick<ScheduleDeps, "exec" | "now"> = {},
  onSkip: (message: string) => void = () => {},
): ScheduleRow[] {
  const paths = schedulePaths();
  const now = deps.now?.() ?? new Date();
  const env = backendEnv(deps);
  const rows: ScheduleRow[] = [];
  let crontab: string | null | undefined; // read once, for every cron schedule
  for (const [i, entry] of readScheduleFile(paths.definitions).entries()) {
    const def = checkDefinition(entry);
    if (typeof def === "string") {
      onSkip(`skipped schedule #${i + 1} of ${paths.definitions}: ${def}`);
      continue;
    }
    if (def.backend === "cron" && crontab === undefined) crontab = tryReadCrontab(env.exec);
    let next: Date | null = null;
    try {
      next = nextFire(parseCron(def.cron), now);
    } catch {
      /* a hand-edited expression that no longer parses: no next run */
    }
    rows.push({
      def,
      installed: isInstalled(def.backend, def.name, env, crontab ?? null),
      lastRun: lastRunView(readLastRun(lastRunPath(paths.stateDir, def.name))),
      nextRun: next,
      log: logPath(paths.stateDir, def.name),
    });
  }
  return rows;
}

/** A schedule row as JSON: the definition plus `installed`, `lastRun`, `nextRun` (local ISO time) and `log`. */
export function scheduleJson(row: ScheduleRow): Record<string, unknown> {
  return {
    ...row.def,
    installed: row.installed,
    lastRun: row.lastRun,
    nextRun: row.nextRun ? localIso(row.nextRun) : null,
    log: row.log,
  };
}

function scheduleList(rest: string[], deps: ScheduleDeps): number {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" } } });
  if (positionals.length > 0) throw usage(`odw schedule list: unexpected argument '${positionals[0]}'`);
  const rows = listSchedules(deps, (message) => process.stderr.write(`odw schedule list: ${message}\n`));
  if (values.json) {
    process.stdout.write(JSON.stringify(rows.map(scheduleJson), null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stderr.write(`no schedules — add one: odw schedule add <name> <workflow> --cron "0 8 * * *"\n`);
    return 0;
  }
  const table = [
    ["NAME", "CRON", "BACKEND", "WORKFLOW", "LAST RUN", "NEXT RUN"],
    ...rows.map((row) => [
      row.def.name,
      row.def.cron,
      row.def.backend + (row.installed === false ? " (entry missing)" : ""),
      sanitizeText(row.def.workflow, 60),
      row.lastRun ? `${row.lastRun.state} ${showTime(row.lastRun.at)}${row.lastRun.runId ? ` ${row.lastRun.runId}` : ""}` : "-",
      row.nextRun ? localMinute(row.nextRun) : "never",
    ]),
  ];
  const widths = table[0]!.map((_, c) => Math.max(...table.map((cells) => cells[c]!.length)));
  for (const cells of table) {
    process.stdout.write(cells.map((cell, c) => (c === cells.length - 1 ? cell : cell.padEnd(widths[c]!))).join("  ") + "\n");
  }
  if (rows.some((row) => row.installed === false)) {
    process.stderr.write(`an OS entry is missing (edited away?) — odw schedule remove <name>, then add it again\n`);
  }
  return 0;
}

/**
 * The last run as `list` shows it. While `schedule run` waits, the run itself
 * says how it is doing — and also when that process died and left "running"
 * behind, since the run goes on in its own worker.
 */
function lastRunView(last: LastRun | null): ScheduleRow["lastRun"] {
  if (!last) return null;
  let state = last.state;
  let at = last.finishedAt ?? last.startedAt;
  if (state === "running" && last.runId && last.runsRoot) {
    const store = new RunStore(last.runsRoot);
    if (store.exists(last.runId)) {
      const status = store.readStatus(last.runId);
      const current = String(status.state ?? "");
      if (TERMINAL_STATES.has(current)) {
        state = current;
        if (typeof status.updatedAt === "number") at = localIso(new Date(status.updatedAt * 1000));
      } else if (!isRunActive(store, last.runId)) {
        state = "stale";
      } else if (status.waiting) {
        state = "waiting";
      }
    }
  }
  return { runId: last.runId, state, at };
}

function showTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : localMinute(at);
}

// --- remove ----------------------------------------------------------------------

function scheduleRemove(rest: string[], deps: ScheduleDeps): number {
  const name = oneName("remove", rest);
  const paths = schedulePaths();
  const entries = readScheduleFile(paths.definitions);
  const index = entries.findIndex((entry) => entryName(entry) === name);
  const def = index === -1 ? null : checkDefinition(entries[index]);
  // Without a usable definition, clear whatever OS entry a schedule of this name left behind.
  const backends: readonly Backend[] = def !== null && typeof def !== "string" ? [def.backend] : BACKENDS;
  const env = backendEnv(deps);
  const removed: Backend[] = [];
  for (const backend of backends) {
    try {
      if (uninstall(backend, name, env)) removed.push(backend);
    } catch (err) {
      throw new ScheduleExit(
        1,
        `odw schedule remove: could not remove the ${backend} entry of '${name}': ${(err as Error).message}` +
          (index !== -1 ? ` — the definition is kept, so you can retry` : ""),
      );
    }
  }
  if (index !== -1) writeScheduleFile(paths.definitions, entries.filter((_, i) => i !== index));
  rmSync(lastRunPath(paths.stateDir, name), { force: true });
  const log = logPath(paths.stateDir, name);
  const osEntries = (of: readonly Backend[]) => `${of.join(" and ")} ${of.length > 1 ? "entries" : "entry"}`;
  if (index === -1) {
    process.stderr.write(
      removed.length > 0
        ? `removed the ${osEntries(removed)} of '${name}', which had no definition left\n`
        : `odw schedule remove: no schedule named '${name}' — nothing to remove\n`,
    );
    return 0;
  }
  const what = removed.length > 0 ? `and its ${osEntries(removed)}` : `(its ${backends.join("/")} entry was already gone)`;
  process.stderr.write(`removed schedule '${name}' ${what}${existsSync(log) ? `; its log stays at ${log}` : ""}\n`);
  return 0;
}

function oneName(sub: string, rest: string[]): string {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  const [name, extra] = positionals;
  if (!name || extra !== undefined) throw usage(`odw schedule ${sub}: expected one <name>`);
  checkName(sub, name);
  return name;
}

// --- run -------------------------------------------------------------------------

/**
 * `odw schedule run <name>` — one scheduled run. Exit 0 when it finished done
 * or was skipped because the previous run still goes on; 1 when it failed,
 * stopped, or could not start.
 */
async function scheduleRun(rest: string[], deps: ScheduleDeps): Promise<number> {
  const name = oneName("run", rest);
  const now = deps.now ?? (() => new Date());
  const paths = schedulePaths();
  const entry = readScheduleFile(paths.definitions).find((e) => entryName(e) === name);
  // No log line for these: under the OS, stderr is the log already.
  if (entry === undefined) throw new ScheduleExit(1, `odw schedule run: no schedule named '${name}' in ${paths.definitions}`);
  const def = checkDefinition(entry);
  if (typeof def === "string") {
    throw new ScheduleExit(1, `odw schedule run: schedule '${name}' in ${paths.definitions} is invalid: ${def}`);
  }

  mkdirSync(paths.stateDir, { recursive: true });
  const log = logPath(paths.stateDir, name);
  // The OS entry sends stderr to the log already: echo there only for a run started by hand.
  const echo = !sameFile(process.stderr, log);
  const say = (text: string): void => {
    const line = appendLog(log, text, now());
    if (echo) process.stderr.write(`odw schedule run ${name}: ${line.slice(line.indexOf(" ") + 1)}`);
  };

  const attempt = acquireLock(lockPath(paths.stateDir, name), { runActive: holderRunActive, now });
  if (!attempt.acquired) {
    say(`skipped: the previous run is still going (${describeHolder(attempt.holder)})`);
    return 0;
  }
  const last = lastRunPath(paths.stateDir, name);
  const startedAt = now();
  const notStarted = (why: string): number => {
    say(`failed to start: ${why}`);
    writeLastRun(last, {
      runId: null,
      state: "failed",
      startedAt: localIso(startedAt),
      finishedAt: localIso(now()),
      error: why,
    });
    return 1;
  };
  try {
    if (!isDirectory(def.cwd)) return notStarted(`its directory ${def.cwd} no longer exists`);
    let started: { runId: string; store: RunStore };
    try {
      started = startRun(def.workflow, {
        args: def.args,
        // The file `odw run` would find from the schedule's directory (or the pinned one), so the
        // launcher here and the worker there read the same config.
        configPath: locateConfig(def.configPath ?? null, def.cwd),
        source: def.cwd,
        adapter: def.adapter ?? null,
      });
    } catch (err) {
      return notStarted(sanitizeText((err as Error).message, 500));
    }
    const { runId, store } = started;
    attempt.lock.record({ runId, runsRoot: store.root });
    writeLastRun(last, { runId, state: "running", startedAt: localIso(startedAt), runsRoot: store.root });
    say(`started ${runId} (${sanitizeText(def.workflow, 200)})`);

    const told = new Set<number>();
    const status = await waitFor(store, runId, {
      onStatus: ({ waiting }) => {
        const cp = waiting as { checkpointId?: unknown; title?: unknown } | null | undefined;
        if (!cp || !isCheckpointId(cp.checkpointId) || told.has(cp.checkpointId)) return;
        told.add(cp.checkpointId);
        const { approve } = checkpointCommands(runId, cp.checkpointId, runsRootFlags(store));
        say(
          `waiting for a decision at checkpoint #${cp.checkpointId}: ${sanitizeText(cp.title, 200)} — ` +
            `${approve.replace("odw approve", "odw approve|reject")}`,
        );
      },
    });
    const state = String(status.state ?? "failed");
    const took = formatDuration((now().getTime() - startedAt.getTime()) / 1000);
    const error =
      state === "failed" ? sanitizeText(status.error ?? store.readError(runId)?.error ?? "unknown error", 500) : undefined;
    say(
      state === "done"
        ? `done ${runId} in ${took}`
        : state === "stopped"
          ? `stopped ${runId} after ${took}`
          : `failed ${runId} after ${took}: ${error}`,
    );
    writeLastRun(last, {
      runId,
      state,
      startedAt: localIso(startedAt),
      finishedAt: localIso(now()),
      ...(error !== undefined ? { error } : {}),
      runsRoot: store.root,
    });
    return state === "done" ? 0 : 1;
  } finally {
    attempt.lock.release();
  }
}

/** A dead lock holder's run still going on keeps the schedule's lock (its worker outlives it). */
function holderRunActive(holder: LockHolder): boolean {
  if (!holder.runId || !holder.runsRoot) return false;
  const store = new RunStore(holder.runsRoot);
  return store.exists(holder.runId) && isRunActive(store, holder.runId);
}

function describeHolder(holder: LockHolder | null): string {
  if (!holder) return "its lock is being taken";
  const run = holder.runId ? `run ${holder.runId}, ` : "";
  return `${run}pid ${holder.pid}, since ${holder.startedAt}`;
}

/** What a printed `odw approve` needs to find a run in `store`: --runs-root unless it is the default one. */
function runsRootFlags(store: RunStore): string[] {
  try {
    if (resolve(resolveRunsRoot(loadConfig(null, { quiet: true }).settings.runsRoot)) === resolve(store.root)) return [];
  } catch {
    // An unreadable default config: name the runs root outright.
  }
  return ["--runs-root", resolve(store.root)];
}

// --- helpers ---------------------------------------------------------------------

function backendEnv(deps: Pick<ScheduleDeps, "exec">): BackendEnv {
  return { exec: deps.exec ?? runExecutor, home: homeDir(), uid: process.getuid?.() ?? 0 };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `stream` writes into the file at `path` (the OS entry's redirect). */
function sameFile(stream: NodeJS.WriteStream, path: string): boolean {
  const fd = (stream as { fd?: unknown }).fd;
  if (typeof fd !== "number") return false;
  try {
    const a = fstatSync(fd);
    const b = statSync(path);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}
