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
 * as a thrown error, so the caller has one uniform thing to inspect.
 *
 * Agent CLIs start processes of their own (shells, test runners, language
 * servers). On POSIX each agent therefore leads its own process group, and a
 * kill (timeout, output overrun) takes down the whole group; on Windows
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
  /** Combined stdout+stderr bytes to retain before killing; omit for a safe default. */
  maxOutputBytes?: number;
}

/** The injectable contract for executing a command. */
export type CommandRunner = (command: string[], options?: RunCommandOptions) => Promise<CliResult>;

export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * After the agent exits (or is killed), how long its stdout/stderr may take to
 * drain before the result settles anyway. 'close' normally follows 'exit' at
 * once; only a descendant that outlived the agent and still holds the pipes
 * makes it wait, and such a straggler is killed when the grace period ends.
 */
const STREAM_GRACE_MS = 2000;

const IS_WINDOWS = process.platform === "win32";

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

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputBytes = 0;
    let outputExceeded = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (result: CliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      resolve(result);
    };

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      // A process killed by a signal reports code===null. Distinguish our own
      // timeout kill (already flagged) from an external/crash signal (SIGSEGV,
      // OOM SIGKILL, …) so a crash is never mistaken for a clean exit (0).
      let returncode: number;
      if (outputExceeded) returncode = 1;
      else if (timedOut) returncode = -1;
      else if (code !== null) returncode = code;
      else returncode = signal ? 128 : 1;
      const note = signal && !timedOut ? `\n[process terminated by signal ${signal}]` : "";
      const outputNote = outputExceeded
        ? `\n[process output exceeded ${maxOutputBytes} bytes; terminated]`
        : "";
      finish({ returncode, stdout, stderr: stderr + note + outputNote, timedOut, duration: elapsed() });
    };

    /** Stop listening to the pipes and settle with what was captured. */
    const abandonStreams = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.stdout.destroy();
      child.stderr.destroy();
      settle(code, signal);
    };

    const terminate = (): void => {
      killProcessTree(child);
      // SIGKILL is not always deliverable (a setuid descendant, a process stuck
      // in the kernel): never let an unkillable process stall the run.
      killTimer ??= setTimeout(() => abandonStreams(null, "SIGKILL"), STREAM_GRACE_MS * 2);
    };

    if (options.timeout != null) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeout * 1000);
    }

    const appendLimited = (stream: "stdout" | "stderr", d: string): void => {
      if (outputExceeded) return;
      if (!hasOutputLimit) {
        if (stream === "stdout") stdout += d;
        else stderr += d;
        return;
      }
      const bytes = Buffer.byteLength(d);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const chunk = bytes <= remaining ? d : Buffer.from(d).subarray(0, remaining).toString("utf8");
        if (stream === "stdout") stdout += chunk;
        else stderr += chunk;
      }
      outputBytes += bytes;
      if (bytes > remaining) {
        outputExceeded = true;
        terminate();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      appendLimited("stdout", d);
    });
    child.stderr.on("data", (d: string) => {
      appendLimited("stderr", d);
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

/**
 * Kill an agent and every process it started. Best-effort and idempotent: any
 * of them may already be gone.
 *
 * POSIX: the agent was spawned `detached`, so it leads a process group that its
 * descendants inherit; signalling the negative pid reaches all of them (even
 * after the leader itself has exited). Windows has no process groups to
 * signal; `taskkill /T` kills the tree rooted at the agent instead.
 */
function killProcessTree(child: ChildProcess): void {
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
