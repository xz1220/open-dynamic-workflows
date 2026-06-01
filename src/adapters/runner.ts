/**
 * The thin subprocess boundary (L1) — STUB (M1).
 *
 * The only place that actually spawns an external process. Everything above it
 * is expressed in terms of {@link CliResult}, which keeps the higher layers
 * testable without real agent accounts — a test injects a fake runner with the
 * same signature.
 */

import { notImplemented } from "../errors.js";
import type { CliResult } from "./types.js";

export interface RunCommandOptions {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Seconds before the process is killed; omit for no timeout. */
  timeout?: number;
}

/** The injectable contract for executing a command. */
export type CommandRunner = (command: string[], options?: RunCommandOptions) => Promise<CliResult>;

export const runCommand: CommandRunner = async (_command, _options) => {
  // Will spawn via node:child_process, capture stdout/stderr/exit/timeout, and
  // report failures through the result rather than by throwing.
  throw notImplemented("command runner (M1)");
};
