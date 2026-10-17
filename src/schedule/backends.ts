/**
 * The OS side of `odw schedule` (an ODW extension): what each scheduler is
 * given, and the one seam through which odw talks to it.
 *
 *   cron     a marker block in the user crontab, read with `crontab -l` and
 *            written back whole with `crontab -`; other lines are left as they are
 *   launchd  ~/Library/LaunchAgents/dev.odw.schedule.<name>.plist, loaded with
 *            `launchctl bootstrap gui/<uid>` and unloaded with `bootout`
 *   systemd  ~/.config/systemd/user/odw-<name>.service and .timer, started with
 *            `systemctl --user daemon-reload` and `enable --now`
 *
 * Every entry runs `odw schedule run <name>` with PATH set explicitly and its
 * output appended to the schedule's log. Only cron goes through a shell
 * (/bin/sh), so its line single-quotes every path; launchd and systemd get the
 * argument vector as is. The texts come from pure functions — tested byte for
 * byte — and `crontab`, `launchctl` and `systemctl` run through one
 * injectable {@link Executor}.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DynamicWorkflowError } from "../errors.js";
import {
  launchdIntervals,
  schtasksSchedule,
  systemdCalendars,
  type CalendarInterval,
  type CronSpec,
} from "./cron.js";

/** A schedule's OS entry or definition could not be read, written or loaded. */
export class ScheduleError extends DynamicWorkflowError {}

export type Backend = "cron" | "launchd" | "systemd";
export const BACKENDS: readonly Backend[] = ["cron", "launchd", "systemd"];

/** What one scheduler command did. */
export interface ExecResult {
  /** Its exit status; 127 when it could not be started at all (not installed). */
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `crontab`, `launchctl` and `systemctl`, with `input` on stdin: the one seam tests replace. */
export type Executor = (argv: string[], input?: string) => ExecResult;

/** Seconds a scheduler command may take: they answer at once, but a wedged one must not hang odw. */
const EXEC_TIMEOUT_MS = 60_000;

export const runExecutor: Executor = (argv, input) => {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    input: input ?? "",
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
    windowsHide: true,
    // Answers are told apart by their C-locale wording ("no crontab for …").
    env: { ...process.env, LC_ALL: "C" },
  });
  const output = { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  // A command that exits before reading its input (EPIPE) still ran: its own status and words count.
  if (result.status !== null) return { status: result.status, ...output };
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: code === "ENOENT" ? 127 : 1,
    stdout: output.stdout,
    stderr: result.error?.message ?? `${argv[0]} was killed by ${result.signal ?? "a signal"}`,
  };
};

/** Where the OS entries go and who for. */
export interface BackendEnv {
  exec: Executor;
  /** The home directory LaunchAgents and systemd user units live under. */
  home: string;
  /** The user id: launchd's `gui/<uid>` domain. */
  uid: number;
}

/** What an OS entry needs to call odw back for one schedule. */
export interface EntrySpec {
  name: string;
  /** The cron expression, as parseCron normalized it. */
  cron: string;
  /** How to call odw: the node binary and the CLI entry, or the odw binary. */
  odwCommand: string[];
  /** The PATH the entry runs with. */
  path: string;
  /** The schedule's log: the entry's stdout and stderr are appended to it. */
  log: string;
}

// --- names and places ----------------------------------------------------------

export function launchdLabel(name: string): string {
  return `dev.odw.schedule.${name}`;
}

export function launchdPlistPath(home: string, name: string): string {
  return join(home, "Library", "LaunchAgents", `${launchdLabel(name)}.plist`);
}

/** The systemd unit name, without its .service / .timer suffix. */
export function systemdUnit(name: string): string {
  return `odw-${name}`;
}

export function systemdUnitPaths(home: string, name: string): { service: string; timer: string } {
  const dir = join(home, ".config", "systemd", "user");
  return { service: join(dir, `${systemdUnit(name)}.service`), timer: join(dir, `${systemdUnit(name)}.timer`) };
}

/** The argument vector every OS entry runs. */
function entryArgv(entry: EntrySpec): string[] {
  return [...entry.odwCommand, "schedule", "run", entry.name].map((arg) => oneLine("the odw command", arg));
}

/** A value an entry holds on one line: a line break in it could not be written, or would split the entry. */
function oneLine(what: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new ScheduleError(`${what} holds a line break, which no scheduler entry can carry: ${JSON.stringify(value)}`);
  }
  return value;
}

// --- cron ----------------------------------------------------------------------

const CRON_BEGIN = "# odw:begin ";
const CRON_END = "# odw:end ";

/** A word for /bin/sh: single-quoted, each `'` in it written `'\''`. */
export function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The crontab block of one schedule: its markers around one entry that sets
 * PATH and appends the run's output to the log. cron hands the command to
 * /bin/sh, so every path is single-quoted, and turns an unescaped `%` into a
 * newline, so each one is written `\%`.
 */
export function cronBlock(entry: EntrySpec): string {
  const odw = entry.odwCommand.map((arg) => shQuote(oneLine("the odw command", arg)));
  const command =
    `PATH=${shQuote(oneLine("PATH", entry.path))} ${odw.join(" ")} schedule run ${entry.name}` +
    ` >> ${shQuote(oneLine("the log path", entry.log))} 2>&1`;
  return `${CRON_BEGIN}${entry.name}\n${entry.cron} ${command.replace(/%/g, "\\%")}\n${CRON_END}${entry.name}\n`;
}

/** Whether the crontab holds the block of schedule `name`. */
export function hasCronBlock(crontab: string, name: string): boolean {
  return crontab.split("\n").some((line) => line.trimEnd() === CRON_BEGIN + name);
}

/**
 * `crontab` without the block of schedule `name`, and with `block` (when
 * given) appended. Every other line stays exactly as it was. A block whose end
 * marker was edited away loses only its begin marker and odw's entry right
 * after it; an end marker left alone goes too.
 */
export function replaceCronBlock(crontab: string, name: string, block: string | null): string {
  const lines = crontab.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const begin = CRON_BEGIN + name;
  const end = CRON_END + name;
  const entry = ` schedule run ${name} >> `;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (line === begin) {
      let close = -1;
      for (let j = i + 1; j < lines.length && !lines[j]!.startsWith(CRON_BEGIN); j++) {
        if (lines[j]!.trimEnd() === end) {
          close = j;
          break;
        }
      }
      if (close !== -1) i = close;
      else if (lines[i + 1]?.includes(entry)) i++;
      continue;
    }
    if (line === end) continue;
    kept.push(lines[i]!);
  }
  if (block !== null) kept.push(...block.replace(/\n$/, "").split("\n"));
  return kept.length > 0 ? kept.join("\n") + "\n" : "";
}

/** The user crontab; "" when the user has none. Throws when `crontab` cannot be used. */
export function readCrontab(exec: Executor): string {
  return crontabText(exec(["crontab", "-l"]));
}

/** What a `crontab -l` answer says the crontab is. */
function crontabText(result: ExecResult): string {
  if (result.status === 0) return result.stdout;
  if (result.status === 127) {
    throw new ScheduleError(
      `crontab is not available here (${result.stderr.trim()}) — install cron, or pick another --backend`,
    );
  }
  // A user without a crontab: "no crontab for <user>" (cronie, Vixie, macOS, busybox).
  if (/no crontab|can't open/i.test(result.stderr)) return "";
  throw new ScheduleError(failure(["crontab", "-l"], result));
}

/** The user crontab, or null when it cannot be read (no cron installed, say): for reports that must not fail. */
export function tryReadCrontab(exec: Executor): string | null {
  try {
    return readCrontab(exec);
  } catch {
    return null;
  }
}

// --- launchd -------------------------------------------------------------------

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The LaunchAgent of one schedule: the argument vector (no shell), PATH, one
 * StartCalendarInterval entry per launchdIntervals() dictionary, and stdout
 * and stderr appended to the log.
 */
export function launchdPlist(entry: EntrySpec, intervals: CalendarInterval[]): string {
  const interval = (fields: CalendarInterval): string[] => {
    const keys = Object.entries(fields);
    if (keys.length === 0) return ["\t\t<dict/>"];
    return [
      "\t\t<dict>",
      ...keys.flatMap(([key, value]) => [`\t\t\t<key>${key}</key>`, `\t\t\t<integer>${value}</integer>`]),
      "\t\t</dict>",
    ];
  };
  const log = xml(oneLine("the log path", entry.log));
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t<string>${launchdLabel(entry.name)}</string>`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    ...entryArgv(entry).map((arg) => `\t\t<string>${xml(arg)}</string>`),
    `\t</array>`,
    `\t<key>EnvironmentVariables</key>`,
    `\t<dict>`,
    `\t\t<key>PATH</key>`,
    `\t\t<string>${xml(oneLine("PATH", entry.path))}</string>`,
    `\t</dict>`,
    `\t<key>StartCalendarInterval</key>`,
    `\t<array>`,
    ...intervals.flatMap(interval),
    `\t</array>`,
    `\t<key>StandardOutPath</key>`,
    `\t<string>${log}</string>`,
    `\t<key>StandardErrorPath</key>`,
    `\t<string>${log}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/**
 * Load a LaunchAgent. A job of the same label still loaded (a leftover) is
 * booted out first so the new plist takes effect; a bootstrap that fails
 * because launchd has the job anyway ("already loaded") is fine.
 */
function loadLaunchAgent(name: string, plist: string, env: BackendEnv): void {
  const domain = `gui/${env.uid}`;
  const service = `${domain}/${launchdLabel(name)}`;
  env.exec(["launchctl", "bootout", service]);
  const argv = ["launchctl", "bootstrap", domain, plist];
  const loaded = env.exec(argv);
  if (loaded.status === 0 || env.exec(["launchctl", "print", service]).status === 0) return;
  throw new ScheduleError(failure(argv, loaded));
}

// --- systemd -------------------------------------------------------------------

/** One ExecStart= word: `%` and `$` doubled (specifiers, variables), double-quoted when it holds anything special. */
function systemdWord(arg: string): string {
  const escaped = arg.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(arg) ? escaped : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** An Environment= assignment, double-quoted, `%` doubled (systemd expands specifiers there; not `$`). */
function systemdAssignment(name: string, value: string): string {
  return `"${`${name}=${value}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/** The service a schedule's timer starts: one `odw schedule run`, its output appended to the log. */
export function systemdService(entry: EntrySpec): string {
  const log = oneLine("the log path", entry.log).replace(/%/g, "%%");
  return [
    "[Unit]",
    `Description=odw schedule ${entry.name}`,
    "",
    "[Service]",
    "Type=oneshot",
    `Environment=${systemdAssignment("PATH", oneLine("PATH", entry.path))}`,
    `ExecStart=${entryArgv(entry).map(systemdWord).join(" ")}`,
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    "",
  ].join("\n");
}

/**
 * The timer of a schedule. `Persistent=true` runs a start missed while the
 * machine was off or asleep once it is back (cron skips those); AccuracySec
 * keeps it on the minute, where systemd would otherwise fire up to a minute late.
 */
export function systemdTimer(entry: EntrySpec, calendars: string[]): string {
  return [
    "[Unit]",
    `Description=odw schedule ${entry.name} (${entry.cron})`,
    "",
    "[Timer]",
    ...calendars.map((calendar) => `OnCalendar=${calendar}`),
    "AccuracySec=1s",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

// --- Windows -------------------------------------------------------------------

/** One argument as the Windows C runtime splits a command line: quoted when needed, `\` and `"` escaped. */
export function winQuote(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    out += ch === '"' ? "\\".repeat(slashes * 2 + 1) + '"' : "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

/**
 * The schtasks.exe line (for cmd.exe) that would create a Windows task running
 * `argv` on the expression's schedule — odw cannot install one itself yet.
 * `task` is the /TR command line, which schtasks caps at 261 characters.
 */
export function schtasksLine(
  name: string,
  spec: CronSpec,
  argv: string[],
): { line: string; task: string; exact: boolean } {
  const { args, exact } = schtasksSchedule(spec);
  const task = argv.map(winQuote).join(" ");
  const line = ["schtasks", "/Create", "/TN", winQuote(`odw-${name}`), ...args, "/TR", winQuote(task)].join(" ");
  return { line, task, exact };
}

// --- install and remove -----------------------------------------------------------

/** Everything installing a schedule's OS entry writes and runs: what `--dry-run` prints. */
export interface InstallPlan {
  backend: Backend;
  /** Files written whole: the LaunchAgent plist, the systemd units. */
  files: Array<{ path: string; content: string }>;
  /** cron: the block the user crontab gains (every other line stays as it is). */
  cronBlock?: string;
  /** The commands run once the files are written. */
  commands: string[][];
}

/** What installing `entry` through `backend` takes. Throws a CronError when launchd cannot express the schedule. */
export function planInstall(
  backend: Backend,
  entry: EntrySpec,
  spec: CronSpec,
  env: Pick<BackendEnv, "home" | "uid">,
): InstallPlan {
  if (backend === "cron") {
    return { backend, files: [], cronBlock: cronBlock(entry), commands: [["crontab", "-"]] };
  }
  if (backend === "launchd") {
    const path = launchdPlistPath(env.home, entry.name);
    return {
      backend,
      files: [{ path, content: launchdPlist(entry, launchdIntervals(spec)) }],
      commands: [["launchctl", "bootstrap", `gui/${env.uid}`, path]],
    };
  }
  const { service, timer } = systemdUnitPaths(env.home, entry.name);
  return {
    backend,
    files: [
      { path: service, content: systemdService(entry) },
      { path: timer, content: systemdTimer(entry, systemdCalendars(spec)) },
    ],
    commands: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${systemdUnit(entry.name)}.timer`],
    ],
  };
}

/** Carry out an install plan for schedule `name`; throws a ScheduleError saying which step failed. */
export function install(plan: InstallPlan, name: string, env: BackendEnv): void {
  if (plan.backend === "cron") {
    run(env.exec, ["crontab", "-"], replaceCronBlock(readCrontab(env.exec), name, plan.cronBlock!));
    return;
  }
  for (const file of plan.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  if (plan.backend === "launchd") {
    loadLaunchAgent(name, plan.files[0]!.path, env);
    return;
  }
  for (const argv of plan.commands) run(env.exec, argv);
}

/**
 * Remove schedule `name`'s OS entry; true when there was one to remove. An
 * entry edited away by hand, or never there, is no error — removing is
 * idempotent. Throws only when an entry exists and cannot be removed.
 */
export function uninstall(backend: Backend, name: string, env: BackendEnv): boolean {
  if (backend === "cron") {
    const listed = env.exec(["crontab", "-l"]);
    if (listed.status === 127) return false; // no cron here: no entry either
    const crontab = crontabText(listed);
    if (!hasCronBlock(crontab, name)) return false;
    run(env.exec, ["crontab", "-"], replaceCronBlock(crontab, name, null));
    return true;
  }
  if (backend === "launchd") {
    const plist = launchdPlistPath(env.home, name);
    // Not loaded (or no launchctl) is fine: there is nothing to boot out.
    const unloaded = env.exec(["launchctl", "bootout", `gui/${env.uid}/${launchdLabel(name)}`]).status === 0;
    const existed = existsSync(plist);
    rmSync(plist, { force: true });
    return unloaded || existed;
  }
  const { service, timer } = systemdUnitPaths(env.home, name);
  const existed = existsSync(service) || existsSync(timer);
  // A unit already gone (or never enabled) makes this fail: fine, it is not running either.
  const stopped = env.exec(["systemctl", "--user", "disable", "--now", `${systemdUnit(name)}.timer`]).status === 0;
  rmSync(service, { force: true });
  rmSync(timer, { force: true });
  if (existed) run(env.exec, ["systemctl", "--user", "daemon-reload"]);
  return existed || stopped;
}

/**
 * Whether schedule `name`'s OS entry is in place: its crontab block (`crontab`
 * read once by the caller), its plist, its timer unit. Null when that cannot
 * be told (crontab unreadable).
 */
export function isInstalled(backend: Backend, name: string, env: BackendEnv, crontab: string | null): boolean | null {
  if (backend === "cron") return crontab === null ? null : hasCronBlock(crontab, name);
  if (backend === "launchd") return existsSync(launchdPlistPath(env.home, name));
  return existsSync(systemdUnitPaths(env.home, name).timer);
}

function run(exec: Executor, argv: string[], input?: string): void {
  const result = exec(argv, input);
  if (result.status !== 0) throw new ScheduleError(failure(argv, result));
}

function failure(argv: string[], result: ExecResult): string {
  const said = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ");
  return `${argv.join(" ")} failed (exit ${result.status})${said ? `: ${said}` : ""}`;
}
