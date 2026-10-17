/**
 * The thin subprocess boundary (L1).
 *
 * The only place that actually spawns an external process. Everything above it
 * is expressed in terms of {@link CliResult}, which keeps the higher layers
 * testable without real agent accounts — a test injects a fake runner with the
 * same signature.
 *
 * A timeout or a missing executable is reported *through the result*
 * (`timedOut` / a non-zero `returncode` with the reason on stderr) rather than
 * as a thrown error, so the caller has one uniform thing to inspect. So is a
 * stall: with a stall timeout, a process that writes nothing to stdout or
 * stderr for that long is killed like a timeout and reported `stalled`.
 *
 * Agent CLIs start processes of their own (shells, test runners, language
 * servers). On POSIX each agent therefore leads its own process group, and a
 * kill (timeout, output overrun, abort) takes down the whole group; on Windows
 * `taskkill /T` walks the process tree instead. The result settles when the
 * agent exits, after a short grace period for its output to drain — a
 * descendant still holding the pipes cannot stall the run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

import type { CliResult } from "./types.js";
import { resolveExecutable } from "./executable.js";

export interface RunCommandOptions {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Seconds before the process is killed; omit for no timeout. */
  timeout?: number;
  /**
   * Seconds the process may go without writing a byte to stdout or stderr
   * before it is killed (like a timeout, reported as `stalled`); omit for no
   * stall watchdog. Silence after the process exited does not count.
   */
  stallTimeout?: number;
  /**
   * Stdout bytes to retain before killing; omit for a safe default. Stderr is
   * diagnostic only: just its last {@link TAIL_CHARS} characters are kept, and
   * it never counts toward this cap.
   */
  maxOutputBytes?: number;
  /**
   * Stream stdout to a consumer instead of buffering it. The result's `stdout`
   * then holds only a diagnostic tail, and `maxOutputBytes` does not apply: the
   * consumer bounds its own memory, and calls `terminate(reason)` to kill the
   * process if the output becomes unusable (reported like an output overrun).
   */
  onStdout?: (chunk: string, terminate: (reason: string) => void) => void;
  /**
   * Abort the run: the process (and everything it started) is killed and the
   * result settles at once. The caller owns the signal, so it knows why; the
   * result just carries an "aborted" note.
   */
  signal?: AbortSignal;
}

/** The injectable contract for executing a command. */
export type CommandRunner = (command: string[], options?: RunCommandOptions) => Promise<CliResult>;

export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Characters of stderr (and of streamed stdout) kept for diagnostics. */
export const TAIL_CHARS = 64 * 1024;

/**
 * After the agent exits (or is killed), how long its stdout/stderr may take to
 * drain before the result settles anyway. 'close' normally follows 'exit' at
 * once; only a descendant that outlived the agent and still holds the pipes
 * makes it wait, and such a straggler is killed when the grace period ends.
 */
const STREAM_GRACE_MS = 2000;

/** How long a terminated agent gets (after SIGTERM) before its group is SIGKILLed. */
const TERM_GRACE_MS = 1500;

const IS_WINDOWS = process.platform === "win32";

/** Agent processes spawned here that have not settled yet. */
const live = new Set<ChildProcess>();

/**
 * Kill every agent process still running, with everything it started. The
 * worker's backstop when a run ends while agents are in flight: they must not
 * outlive it and keep editing the repository unsupervised. Synchronous, so it
 * is safe in a process 'exit' handler.
 */
export function killAllAgentProcesses(): void {
  for (const child of live) killProcessTree(child);
}

/**
 * Count a process spawned outside {@link runCommand} — an exec() command — as
 * live until the returned function is called, so the backstop above kills it
 * too.
 */
export function trackProcess(child: ChildProcess): () => void {
  live.add(child);
  return () => {
    live.delete(child);
  };
}

export const runCommand: CommandRunner = (command, options = {}) => {
  const started = Date.now();
  const elapsed = (): number => (Date.now() - started) / 1000;
  const [cmd, ...args] = command;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const hasOutputLimit = Number.isFinite(maxOutputBytes);

  return new Promise<CliResult>((resolve) => {
    if (!cmd) {
      resolve({ returncode: 127, stdout: "", stderr: "empty command", timedOut: false, duration: 0 });
      return;
    }
    if (options.signal?.aborted) {
      resolve({ returncode: -1, stdout: "", stderr: "[aborted before start]", timedOut: false, duration: 0 });
      return;
    }

    let executable = cmd;
    let spawnArgs = args;
    const env = options.env ?? process.env;
    if (process.platform === "win32") {
      const resolved = resolveExecutable(cmd, env, "win32");
      const extension = resolved ? extname(resolved).toLowerCase() : "";
      if (extension === ".cmd" || extension === ".bat") {
        const script = resolved!.slice(0, -extension.length) + ".ps1";
        if (!existsSync(script)) {
          resolve({
            returncode: 127,
            stdout: "",
            stderr:
              `failed to launch '${cmd}': Windows batch shim '${resolved}' has no companion PowerShell script; ` +
              "configure the adapter with a directly executable command",
            timedOut: false,
            duration: elapsed(),
          });
          return;
        }
        const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
        executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        spawnArgs = [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          ...args,
        ];
      } else if (resolved) {
        executable = resolved;
      }
    }


    const child = spawn(executable, spawnArgs, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      // POSIX: lead a new process group so a kill reaches every process the
      // agent started, not just the direct child (see killProcessTree).
      detached: !IS_WINDOWS,
    });

    if (child.pid !== undefined) live.add(child);

    let stdout = "";
    const stderr = new Tail(TAIL_CHARS);
    const streamedTail = options.onStdout ? new Tail(TAIL_CHARS) : null;
    let timedOut = false;
    let stalled = false;
    let aborted = false;
    let outputBytes = 0;
    /** When the process last wrote to stdout or stderr (or started). */
    let lastOutputAt = Date.now();
    /** Why the output was refused (the stdout cap, or the stream consumer). */
    let overrun: string | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let termTimer: NodeJS.Timeout | undefined;

    const finish = (result: CliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stallTimer);
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      clearTimeout(termTimer);
      options.signal?.removeEventListener("abort", onAbort);
      live.delete(child);
      resolve(result);
    };

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      // A process killed by a signal reports code===null. Distinguish our own
      // timeout kill (already flagged) from an external/crash signal (SIGSEGV,
      // OOM SIGKILL, …) so a crash is never mistaken for a clean exit (0).
      let returncode: number;
      if (overrun) returncode = 1;
      else if (timedOut || stalled || aborted) returncode = -1;
      else if (code !== null) returncode = code;
      else returncode = signal ? 128 : 1;
      const note = aborted
        ? "\n[aborted; process terminated]"
        : signal && !timedOut && !stalled
          ? `\n[process terminated by signal ${signal}]`
          : "";
      const outputNote = overrun ? `\n[${overrun}; terminated]` : "";
      finish({
        returncode,
        stdout: streamedTail ? streamedTail.toString() : stdout,
        stderr: stderr.toString() + note + outputNote,
        timedOut,
        stalled,
        duration: elapsed(),
      });
    };

    /** Stop listening to the pipes and settle with what was captured. */
    const abandonStreams = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.stdout.destroy();
      child.stderr.destroy();
      settle(code, signal);
    };

    const terminate = (): void => {
      if (termTimer || killTimer) return; // already on its way down
      // SIGTERM first: an agent CLI gets a moment to stop the tools it started
      // in process groups of their own (out of reach of our group kill), then
      // the whole group is SIGKILLed.
      signalProcessTree(child, "SIGTERM");
      termTimer = setTimeout(() => killProcessTree(child), TERM_GRACE_MS);
      // SIGKILL is not always deliverable (a setuid descendant, a process stuck
      // in the kernel): never let an unkillable process stall the run.
      killTimer = setTimeout(() => abandonStreams(null, "SIGKILL"), TERM_GRACE_MS + STREAM_GRACE_MS * 2);
    };

    if (options.timeout != null) {
      timer = setTimeout(() => {
        timedOut = true;
        clearTimeout(stallTimer); // one kill, one reason
        terminate();
      }, Math.min(options.timeout * 1000, 2 ** 31 - 1)); // setTimeout fires at once past 2^31-1 ms
    }

    // The stall watchdog wakes when the silence could first reach the limit
    // and re-arms from the latest output, instead of resetting on every chunk.
    const stallMs = (options.stallTimeout ?? 0) * 1000;
    const watchStall = (delay: number): void => {
      // setTimeout fires at once past 2^31-1 ms; a shorter wake just re-arms.
      stallTimer = setTimeout(() => {
        if (killTimer) return; // already being killed (abort, output overrun)
        const quiet = Date.now() - lastOutputAt;
        if (quiet < stallMs) return watchStall(stallMs - quiet);
        stalled = true;
        clearTimeout(timer);
        terminate();
      }, Math.min(delay, 2 ** 31 - 1));
    };
    if (stallMs > 0) watchStall(stallMs);

    function onAbort(): void {
      aborted = true;
      terminate();
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const refuseOutput = (reason: string): void => {
      if (overrun) return;
      overrun = reason;
      terminate();
    };

    const appendStdout = (d: string): void => {
      lastOutputAt = Date.now();
      if (overrun) return;
      if (options.onStdout) {
        streamedTail!.push(d);
        options.onStdout(d, refuseOutput);
        return;
      }
      if (!hasOutputLimit) {
        stdout += d;
        return;
      }
      const bytes = Buffer.byteLength(d);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        stdout += bytes <= remaining ? d : Buffer.from(d).subarray(0, remaining).toString("utf8");
      }
      outputBytes += bytes;
      if (bytes > remaining) refuseOutput(`process output exceeded ${maxOutputBytes} bytes`);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", appendStdout);
    // Chatty stderr (progress, debug logs) must neither exhaust memory nor
    // count as runaway output: keep the tail, where the final error lands. It
    // is still a sign of life to the stall watchdog.
    child.stderr.on("data", (d: string) => {
      lastOutputAt = Date.now();
      stderr.push(d);
    });

    child.on("error", (err) => {
      // After a successful spawn, 'error' only reports a failed kill; the real
      // outcome still arrives through 'exit'/'close'.
      if (child.pid !== undefined) return;
      finish({
        returncode: 127,
        stdout: "",
        stderr: `failed to launch '${cmd}': ${err.message}`,
        timedOut: false,
        duration: elapsed(),
      });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      // The agent is gone; silence while its pipes drain is not a stall.
      clearTimeout(stallTimer);
      // 'close' (all pipes drained) normally follows at once. A descendant that
      // outlived the agent can hold the pipes open indefinitely: give it a
      // grace period, then kill what is left of the agent's group and settle.
      drainTimer = setTimeout(() => {
        killProcessTree(child);
        abandonStreams(code, signal);
      }, STREAM_GRACE_MS);
    });

    child.on("close", settle);

    // The child may close stdin before consuming all input; an unhandled EPIPE
    // on the write would otherwise crash the whole process. Swallow it — the
    // real outcome arrives via the 'exit'/'close'/'error' handlers above.
    child.stdin.on("error", () => {});
    if (options.stdin != null) child.stdin.write(options.stdin);
    child.stdin.end();
  });
};

/** The last `limit` characters of a stream, with a marker when earlier text was dropped. */
class Tail {
  private text = "";
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.text += chunk;
    // Trim lazily (at twice the limit) so a stream of small chunks stays linear.
    if (this.text.length > this.limit * 2) this.trim();
  }

  toString(): string {
    this.trim();
    return this.dropped ? `[… ${this.dropped} earlier characters omitted]\n${this.text}` : this.text;
  }

  private trim(): void {
    const excess = this.text.length - this.limit;
    if (excess <= 0) return;
    this.dropped += excess;
    this.text = this.text.slice(excess);
  }
}

/**
 * Ask an agent and its process group to stop (POSIX `SIGTERM` to the group).
 * Windows has no group signal or graceful console stop, so it kills the tree.
 */
function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) return killProcessTree(child);
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal); // ESRCH: the group is gone; make sure the agent is too
  }
}

/**
 * Kill an agent and every process it started. Best-effort and idempotent: any
 * of them may already be gone.
 *
 * POSIX: the agent was spawned `detached`, so it leads a process group that its
 * descendants inherit; signalling the negative pid reaches all of them (even
 * after the leader itself has exited). Windows has no process groups to
 * signal; `taskkill /T` kills the tree rooted at the agent instead.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    try {
      const killer = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      // taskkill needs the root alive to find the tree; if it cannot do its
      // job, at least terminate the direct child.
      killer.once("error", () => child.kill("SIGKILL"));
      killer.once("exit", (code) => {
        if (code !== 0) child.kill("SIGKILL");
      });
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: the whole group is gone already. Make sure the agent is, too.
    child.kill("SIGKILL");
  }
}
