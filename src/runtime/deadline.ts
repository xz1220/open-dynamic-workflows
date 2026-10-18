/**
 * `odw run --deadline <seconds>` (an ODW extension): the run is STOPPED
 * gracefully once its deadline passes — status `stopped` with `stopReason:
 * "deadline"`, every finished agent's saved result kept, and every isolated
 * agent's diff kept: a finished one's, and what one the deadline killed had
 * changed so far — its `agent_failed` event carries `partial: true` beside
 * `changes` (a stop by a person keeps no killed agent's change) — unlike
 * `--timeout`, which only stops waiting and leaves the run going. The worker
 * enforces it (see ./worker), so it holds in every run mode, detached included.
 *
 * What `--wait` and `--fg` print for such a run is what it finished: on
 * stdout, `{ state: "stopped", reason: "deadline", deadline, finished: [{
 * agentId, label, phase, value }] }`, and they exit {@link DEADLINE_EXIT_CODE}
 * — apart from 0 (done), 1 (failed, or stopped by a person) and 124
 * (`--timeout`: gave up waiting, run continues).
 */

import type { RunStore } from "./run-store.js";

/** The exit code of `--wait`/`--fg` for a run its deadline stopped. */
export const DEADLINE_EXIT_CODE = 3;

/** Whether a terminal status is a stop by the run's own deadline. */
export function stoppedByDeadline(status: Record<string, unknown>): boolean {
  return status.state === "stopped" && status.stopReason === "deadline";
}

/** `--deadline <seconds>`: a positive number of seconds, or null when the text is not one. */
export function parseDeadline(raw: string): number | null {
  const seconds = Number(raw);
  return raw.trim() !== "" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** What a run its deadline stopped had finished: printed on stdout by `--wait` and `--fg`. */
export function deadlineReport(store: RunStore, runId: string): Record<string, unknown> {
  const meta = store.readMeta(runId);
  const deadline = meta.deadline as { seconds?: unknown } | undefined;
  return {
    state: "stopped",
    reason: "deadline",
    deadline: typeof deadline?.seconds === "number" ? deadline.seconds : null,
    finished: store.listAgentResults(runId).map((rec) => ({
      agentId: rec.agentId,
      label: rec.label,
      phase: rec.phase ?? null,
      value: rec.value,
    })),
  };
}
