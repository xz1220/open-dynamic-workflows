/**
 * The run directory: the file-backed seam between front and back — STUB (M4).
 *
 * A run is a directory under `runsRoot`. The background worker writes to it; the
 * CLI reads from it. They never talk directly, which lets a run outlive the
 * command that started it and be observed from anywhere.
 *
 * Layout of `<runsRoot>/<runId>/`:
 *   meta.json      immutable run description (script, args, source, config)
 *   status.json    mutable state (running/paused/done/failed/stopped, counters)
 *   events.jsonl   append-only progress stream
 *   result.json    final return value (on success)
 *   error.json     message + stack (on failure)
 *   control.json   pause/resume/stop request written by the CLI
 *   worker.log     the worker process's stdout/stderr
 */

import { notImplemented } from "../errors.js";

/** Terminal states: a run in one of these will not change again. */
export const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);

export class RunStore {
  constructor(private readonly root: string) {
    void this.root;
  }

  create(_options: {
    script: string;
    args: unknown;
    configPath?: string | null;
    source: string;
  }): string {
    throw notImplemented("run store (M4)");
  }

  readStatus(_runId: string): Record<string, unknown> {
    throw notImplemented("run store (M4)");
  }

  listRuns(): string[] {
    throw notImplemented("run store (M4)");
  }
}
