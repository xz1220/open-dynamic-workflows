/**
 * `exec()`: run a command from a workflow without launching a model.
 *
 * An ODW extension (Claude Code's Workflow tool has no such global) for the
 * deterministic steps around agents — run the test suite, a build, a linter —
 * so a workflow branches on real results instead of asking a model to run
 * them. It is asynchronous, so other agents keep running meanwhile, and every
 * axis is bounded:
 *
 *   - **arguments** — a string runs through the platform shell (`/bin/sh -c`
 *     on POSIX, `cmd.exe /d /s /c` on Windows); an array is an argv run
 *     directly, without a shell, so no element is ever interpreted.
 *   - **cwd** — the run's source directory (where agents run) by default; a
 *     relative `cwd` resolves against it.
 *   - **timeout** — 600 s by default. The command is killed together with every
 *     process it started (the runner's process-group kill), and the result says
 *     `timedOut`.
 *   - **output** — each stream keeps its first `maxOutputBytes` (8 MiB by
 *     default); the rest is read and dropped (`truncated`), never fatal.
 *   - **cancellation** — a stop, or any fatal error, aborts the run's signal:
 *     the command's process group is killed at once and exec() rejects with
 *     that fatal error.
 *
 * A non-zero exit is a result, not an error — unless `check: true`, which turns
 * it into an {@link ExecError}: recoverable, like a failed agent, so a
 * try/catch handles it and parallel()/pipeline() turn it into `null`.
 *
 * A command is not an agent. It takes no concurrency slot and counts toward
 * neither maxAgents nor the budget, but it waits at the pause/stop checkpoint
 * before it starts and the worker awaits (or kills) it like an agent the
 * script never awaited (see `Scheduler.runCommand`).
 *
 * Observers see `command_started`, then `command_finished` (exit 0) or
 * `command_failed` (a non-zero exit, a signal, a timeout, a launch failure, an
 * abort), keyed by a per-run `commandId`; the run views fold them into the
 * agent list as `kind: "command"` nodes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { killProcessTree, trackProcess } from "./adapters/runner.js";
import type { RunContext } from "./context.js";
import { DynamicWorkflowError, RunStopped, WorkflowScriptError } from "./errors.js";
import { COMMAND_FAILED, COMMAND_FINISHED, COMMAND_STARTED, event } from "./events.js";

export interface ExecOptions {
  /** Working directory; a relative path resolves against the run's source directory (the default). */
  cwd?: string;
  /** Extra environment variables, layered over the worker's environment and the run's `ODW_RUN_ID`. */
  env?: Record<string, string>;
  /** Seconds before the command and everything it started are killed (default 600). */
  timeout?: number;
  /** Text written to the command's stdin; without it, stdin is closed at once. */
  input?: string;
  /** Bytes kept per stream (stdout, stderr); the rest is dropped (default 8 MiB). */
  maxOutputBytes?: number;
  /** Short label for progress display; defaults to the first 40 characters of the command. */
  label?: string;
  /** Override the current phase for this one step (use inside parallel/pipeline). */
  phase?: string;
  /** Throw an {@link ExecError} when the command does not exit 0. */
  check?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** The exit status; null when a signal ended the command (a timeout kill included). */
  exitCode: number | null;
  /** The signal that ended the command (e.g. "SIGKILL" after a timeout), else null. */
  signal: string | null;
  timedOut: boolean;
  /** Output beyond `maxOutputBytes` was dropped from stdout or stderr. */
  truncated: boolean;
  durationMs: number;
}

/**
 * `exec(…, { check: true })` on a command that did not exit 0. Recoverable,
 * like an agent failure; it is thrown only after the step's `command_failed`
 * event, so the failure is already on record.
 */
export class ExecError extends DynamicWorkflowError {
  constructor(
    message: string,
    /** The command as it appears in events. */
    readonly command: string,
    /** What exec() would have returned without `check`. */
    readonly result: ExecResult,
  ) {
    super(message);
  }
}

export type ExecPrimitive = (command: string | string[], opts?: ExecOptions) => Promise<ExecResult>;

export const DEFAULT_EXEC_TIMEOUT = 600;
export const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Characters of the command an event carries, and of a default label. */
const EVENT_COMMAND_CHARS = 200;
const LABEL_CHARS = 40;

/**
 * As in the runner: after the command exits (or is killed), how long its output
 * may take to drain before the step settles anyway. Only a descendant still
 * holding the pipes makes it wait, and that straggler is killed.
 */
const STREAM_GRACE_MS = 2000;

/** setTimeout's ceiling (about 24.8 days): a longer timeout means none. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const IS_WINDOWS = process.platform === "win32";

/** Build the exec() primitive bound to one run's context. */
export function createExec(ctx: RunContext): ExecPrimitive {
  return (command, opts = {}) => execStep(ctx, command, opts);
}

/**
 * Run one command step in a run: what exec() does, and how an agent's
 * `expect.command` check runs (see ./expect), with `extra` on its events — the
 * agent it checks.
 */
export async function execStep(
  ctx: RunContext,
  command: string | string[],
  opts: ExecOptions = {},
  extra: Record<string, unknown> = {},
): Promise<ExecResult> {
  const step = planStep(command, opts, ctx.source, ctx.runId);
  const phase = opts.phase !== undefined ? opts.phase : ctx.currentPhase;
  // Ids follow call order, as agent ids do, on the run's command sequence.
  const commandId = ++ctx.commandSeq.value;
  const fields = { commandId, label: step.label, phase, command: clip(step.display, EVENT_COMMAND_CHARS), ...extra };
  return ctx.scheduler.runCommand(async (signal) => {
    // Emitted once past the checkpoint, so a paused step never shows as running.
    ctx.emit(event(COMMAND_STARTED, fields));
    const { result, failure, aborted } = await runStep(step, signal);
    const settled = { ...fields, exitCode: result.exitCode, durationMs: result.durationMs };
    ctx.emit(
      failure === null
        ? event(COMMAND_FINISHED, settled)
        : event(COMMAND_FAILED, { ...settled, error: failure }),
    );
    // Killed because the run is ending: report the run's reason (fatal), as an agent does.
    if (aborted) throw abortReason(signal);
    if (step.check && result.exitCode !== 0) {
      throw new ExecError(checkMessage(fields.command, failure ?? "failed", result), fields.command, result);
    }
    return result;
  });
}

// --- planning -------------------------------------------------------------------

/** A validated exec() call, ready to spawn. */
interface Step {
  file: string;
  args: string[];
  shell: boolean;
  /** The command on one line, for events and labels. */
  display: string;
  label: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Seconds, as given (for messages). */
  timeout: number;
  /** null: no timer at all. */
  timeoutMs: number | null;
  input: string | undefined;
  maxOutputBytes: number;
  check: boolean;
}

/** Check exec()'s arguments; a misuse is a (recoverable) WorkflowScriptError, before anything starts. */
function planStep(command: unknown, opts: ExecOptions, source: string, runId: string | undefined): Step {
  if (opts === null || typeof opts !== "object") {
    throw misuse(`options must be an object; got ${describeValue(opts)}`);
  }
  let argv: string[];
  let shell: boolean;
  if (typeof command === "string") {
    if (command.trim() === "") throw misuse("the command string is empty");
    // Node's shell mode is exactly `/bin/sh -c <command>` on POSIX and
    // `cmd.exe /d /s /c "<command>"` (verbatim arguments) on Windows.
    argv = [command];
    shell = true;
  } else if (Array.isArray(command)) {
    command.forEach((part, i) => {
      if (typeof part !== "string") {
        throw misuse(`argv element ${i} is ${describeValue(part)}; every element must be a string`);
      }
    });
    if (command.length === 0 || command[0] === "") throw misuse("the argv array needs a program to run");
    argv = command as string[];
    shell = false;
  } else {
    throw misuse(
      `takes a command string (run by the shell) or an argv array (run without one); got ${describeValue(command)}`,
    );
  }

  if (opts.cwd !== undefined && typeof opts.cwd !== "string") {
    throw misuse(`cwd must be a string; got ${describeValue(opts.cwd)}`);
  }
  const cwd = resolve(source, opts.cwd ?? ".");
  // Checked here: spawn would blame a missing cwd on the program ("spawn /bin/sh ENOENT").
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw misuse(`cwd ${cwd} does not exist`);
  }
  if (!isDirectory) throw misuse(`cwd ${cwd} is not a directory`);

  if (opts.env !== undefined && (opts.env === null || typeof opts.env !== "object" || Array.isArray(opts.env))) {
    throw misuse(`env must be an object of variables; got ${describeValue(opts.env)}`);
  }
  const timeout = opts.timeout ?? DEFAULT_EXEC_TIMEOUT;
  if (typeof timeout !== "number" || !(timeout > 0)) {
    throw misuse(`timeout must be a positive number of seconds; got ${describeValue(timeout)}`);
  }
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES;
  if (typeof maxOutputBytes !== "number" || !(maxOutputBytes >= 0)) {
    throw misuse(`maxOutputBytes must be a number of bytes, 0 or more; got ${describeValue(maxOutputBytes)}`);
  }
  if (opts.input !== undefined && typeof opts.input !== "string") {
    throw misuse(`input must be a string; got ${describeValue(opts.input)}`);
  }
  if (opts.label !== undefined && typeof opts.label !== "string") {
    throw misuse(`label must be a string; got ${describeValue(opts.label)}`);
  }

  const display = displayCommand(command as string | string[]);
  return {
    file: argv[0]!,
    args: argv.slice(1),
    shell,
    display,
    label: opts.label ?? clip(display, LABEL_CHARS),
    cwd,
    // The run's id, as its agents get it (a command is not an agent: no ODW_AGENT_ID, no ODW_PORT).
    env: { ...process.env, ...(runId === undefined ? {} : { ODW_RUN_ID: runId }), ...opts.env },
    timeout,
    timeoutMs: timeout * 1000 <= MAX_TIMER_MS ? timeout * 1000 : null,
    input: opts.input,
    maxOutputBytes: Math.floor(maxOutputBytes),
    check: opts.check === true,
  };
}

function misuse(message: string): WorkflowScriptError {
  return new WorkflowScriptError(`exec(): ${message}`);
}

/** A short description of a misused argument, for error messages. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return String(value);
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** The command on one line, as a person would type it: argv elements are shell-quoted. */
function displayCommand(command: string | string[]): string {
  const text = typeof command === "string" ? command : command.map(shellQuote).join(" ");
  return text.replace(/\s+/g, " ").trim();
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** At most `max` characters (code points), ending in an ellipsis when cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text.slice(0, max * 2));
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

// --- running --------------------------------------------------------------------

interface StepOutcome {
  result: ExecResult;
  /** Why the step failed — `command_failed`'s error — or null for exit 0. */
  failure: string | null;
  /** The command was killed because the run's signal fired. */
  aborted: boolean;
}

/**
 * Spawn the command and settle once it exited and its output drained (or the
 * grace period ran out). Never rejects: a launch failure, a timeout and an
 * abort all come back through the outcome, as the runner reports them.
 */
function runStep(step: Step, signal: AbortSignal): Promise<StepOutcome> {
  return new Promise<StepOutcome>((settle) => {
    const started = performance.now();
    const stdout = new CappedOutput(step.maxOutputBytes);
    const stderr = new CappedOutput(step.maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let untrack = (): void => {};
    let child: ChildProcess | undefined;

    const finish = (exitCode: number | null, exitSignal: string | null, launchFailure: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      untrack();
      const result: ExecResult = {
        stdout: stdout.text(),
        // A command that never started wrote nothing: say why instead.
        stderr: launchFailure ?? stderr.text(),
        exitCode,
        signal: exitSignal,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Math.round(performance.now() - started),
      };
      settle({ result, failure: failureOf(result, launchFailure, aborted ? signal : null, step), aborted });
    };

    function onAbort(): void {
      // A command that already exited is only draining: its result stands.
      if (!exited) aborted = true;
      if (child) terminate(child);
    }

    /** Stop listening to the pipes and settle with what was captured. */
    const abandon = (proc: ChildProcess, code: number | null, exitSignal: string | null): void => {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      finish(code, exitSignal, null);
    };

    const terminate = (proc: ChildProcess): void => {
      killProcessTree(proc);
      // SIGKILL is not always deliverable (a process stuck in the kernel):
      // never let an unkillable command stall the run.
      killTimer ??= setTimeout(() => abandon(proc, null, "SIGKILL"), STREAM_GRACE_MS * 2);
    };

    if (signal.aborted) {
      aborted = true;
      finish(null, null, null);
      return;
    }

    try {
      child = spawn(step.file, step.args, {
        cwd: step.cwd,
        env: step.env,
        shell: step.shell,
        windowsHide: true,
        // POSIX: lead a new process group, so a kill reaches everything the
        // command started (see killProcessTree).
        detached: !IS_WINDOWS,
      });
    } catch (err) {
      // Refused before any process existed (a NUL byte in an argument, a
      // Windows batch file without a shell).
      finish(126, null, launchMessage(step, err));
      return;
    }
    const proc = child;
    if (proc.pid !== undefined) untrack = trackProcess(proc);

    if (step.timeoutMs !== null) {
      timer = setTimeout(() => {
        if (exited) return; // it made the deadline; only its output is still draining
        timedOut = true;
        terminate(proc);
      }, step.timeoutMs);
    }
    signal.addEventListener("abort", onAbort, { once: true });

    proc.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));

    proc.on("error", (err) => {
      // After a successful spawn, 'error' only reports a failed kill; the real
      // outcome still arrives through 'exit'/'close'.
      if (proc.pid !== undefined) return;
      // Exit codes as a shell reports them: 127 not found, 126 not runnable.
      finish((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 126, null, launchMessage(step, err));
    });

    proc.on("exit", (code, exitSignal) => {
      exited = true;
      if (settled) return;
      // 'close' (all pipes drained) normally follows at once; a descendant that
      // outlived the command can hold the pipes open, so give it a grace
      // period, then kill what is left of the group and settle.
      drainTimer = setTimeout(() => {
        killProcessTree(proc);
        abandon(proc, code, exitSignal);
      }, STREAM_GRACE_MS);
    });

    proc.on("close", (code, exitSignal) => finish(code, exitSignal, null));

    // The command may exit without reading its input; an EPIPE on the write
    // must not crash the worker. The outcome arrives through the handlers above.
    proc.stdin!.on("error", () => {});
    proc.stdin!.end(step.input);
  });
}

/** Why the step failed, as `command_failed` and ExecError report it; null for a clean exit 0. */
function failureOf(
  result: ExecResult,
  launchFailure: string | null,
  abortedBy: AbortSignal | null,
  step: Step,
): string | null {
  if (abortedBy) return `aborted: ${abortReason(abortedBy).message}`;
  if (launchFailure) return launchFailure;
  if (result.timedOut) return `timed out after ${step.timeout}s`;
  if (result.exitCode === 0) return null;
  if (result.exitCode !== null) return `exited with code ${result.exitCode}`;
  return `killed by signal ${result.signal ?? "(unknown)"}`;
}

function launchMessage(step: Step, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // A string command only fails to launch when the shell itself does.
  if (step.shell) return `failed to launch the shell: ${message}`;
  // Windows runs batch files (npm, npx, …) only through cmd.exe, i.e. the string form.
  const code = (err as NodeJS.ErrnoException).code;
  const hint =
    IS_WINDOWS && (code === "EINVAL" || code === "ENOENT")
      ? " (a batch file such as npm.cmd runs only through cmd.exe: pass the command as a string)"
      : "";
  return `failed to launch '${step.file}': ${message}${hint}`;
}

/** The run's fatal error behind an aborted signal (the bridge's convention). */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new RunStopped("run was stopped");
}

/** The check failure's message, with both ends of the diagnostic output. */
function checkMessage(command: string, failure: string, result: ExecResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  const detail = text.length > 500 ? `${text.slice(0, 250)} … ${text.slice(-250)}` : text;
  return `command '${command}' ${failure}${detail ? `: ${detail}` : ""}`;
}

/** The first `limit` bytes of a stream; whatever follows is read and dropped. */
class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const room = this.limit - this.kept;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.kept += chunk.length;
      return;
    }
    this.truncated = true;
    if (room > 0) this.chunks.push(chunk.subarray(0, room));
  }

  text(): string {
    const bytes = Buffer.concat(this.chunks);
    // The cut may split a multi-byte character: drop its first bytes rather
    // than decode them to U+FFFD.
    return bytes.toString("utf8", 0, this.truncated ? completeUtf8Length(bytes) : bytes.length);
  }
}

/** The length of `bytes` without a trailing, incomplete UTF-8 sequence. */
function completeUtf8Length(bytes: Buffer): number {
  let lead = bytes.length - 1;
  // Back over continuation bytes (10xxxxxx) to the last character's first byte.
  while (lead >= 0 && bytes.length - lead < 4 && (bytes[lead]! & 0xc0) === 0x80) lead--;
  if (lead < 0) return bytes.length;
  const first = bytes[lead]!;
  const size = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return bytes.length - lead < size ? lead : bytes.length;
}
