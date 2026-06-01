/**
 * Start runs in the background and wait on them (L5) — STUB (M4).
 *
 * `startRun` is fire-and-forget: it creates the run directory, spawns a detached
 * Node worker process, and returns the run id immediately. The caller polls the
 * run directory afterwards (what the CLI's status/logs/result do, and what
 * `waitFor` does for `--wait`).
 */

import { notImplemented } from "../errors.js";
import type { RunStore } from "./run-store.js";

export interface StartRunOptions {
  args?: unknown;
  configPath?: string | null;
  runsRoot?: string | null;
  source?: string | null;
}

export function startRun(
  _script: string,
  _options: StartRunOptions = {},
): { runId: string; store: RunStore } {
  throw notImplemented("launcher (M4)");
}

export async function waitFor(
  _store: RunStore,
  _runId: string,
  _options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<Record<string, unknown>> {
  throw notImplemented("launcher (M4)");
}
