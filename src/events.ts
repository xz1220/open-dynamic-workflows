/**
 * Progress events and the sink abstraction.
 *
 * Events are the one-way channel from a running workflow to whoever is watching
 * it (the CLI, the run directory, a test). The shape is a plain object so it
 * round-trips through JSON unchanged — the run directory persists events as
 * JSONL and the CLI reads them back without any custom decoding.
 */

export const RUN_STARTED = "run_started";
export const RUN_FINISHED = "run_finished";
export const RUN_FAILED = "run_failed";
export const RUN_STOPPED = "run_stopped";
export const PHASE_STARTED = "phase_started";
export const LOG = "log";
export const AGENT_STARTED = "agent_started";
export const AGENT_FINISHED = "agent_finished";
export const AGENT_FAILED = "agent_failed";
// exec() command steps (ODW extension): finished means exit 0, failed anything else.
export const COMMAND_STARTED = "command_started";
export const COMMAND_FINISHED = "command_finished";
export const COMMAND_FAILED = "command_failed";
// checkpoint() waits for a person (ODW extension): every request gets one resolution.
export const CHECKPOINT_REQUESTED = "checkpoint_requested";
export const CHECKPOINT_RESOLVED = "checkpoint_resolved";
// An adapter CLI's version, recorded once per run on its first dispatch (ODW extension; see provenance.ts).
export const CLI_VERSION = "cli_version";
// A note on the run's notes board (ODW extension; see notes.ts).
export const NOTE_ADDED = "note_added";
// `odw apply --resolve` ran a resolver for one of the run's agents, and how that ended (ODW extension; see runtime/apply-resolve.ts).
export const APPLY_RESOLVED = "apply_resolved";
// A fallback handed an agent's work over to the next adapter, with a brief of what the last one did (ODW extension; see handoff.ts).
export const HANDOFF = "handoff";
// A sandbox's egress proxy refused a request: { host, port, method, agent | commandId } (ODW extension; see adapters/egress-run.ts).
export const EGRESS_DENIED = "egress_denied";
// The working tree was snapshot before the run's first in-place agent: { ref, commit, head, stash?, tracked, untracked, skipped?, message } (ODW extension; see safety.ts).
export const SAFETY_SNAPSHOT = "safety_snapshot";
// An agent ran a destructive git command: { agentId, label, phase, command, what, policy, message } (ODW extension; see destructive-git.ts).
export const DESTRUCTIVE_GIT = "destructive_git";
// An agent's CLI said another model served it than the one asked for: { agentId, label, phase, adapter, requested, served, policy, message } (ODW extension; see served-model.ts).
export const MODEL_SUBSTITUTED = "model_substituted";
// A parallel() or pipeline() call settled: { call, phase?, total, ok, failed, null, reasons, minOk?, required?, belowMinOk? } (ODW extension; see fanout.ts).
export const FANOUT_DONE = "fanout_done";

export interface WorkflowEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

/**
 * Build a timestamped event record. Timestamps come from the wall clock on
 * purpose: events describe *when* something happened for an observer and never
 * feed back into workflow control flow, so they do not threaten determinism.
 */
export function event(type: string, fields: Record<string, unknown> = {}): WorkflowEvent {
  return { ts: Date.now() / 1000, type, ...fields };
}

/** Anything that can receive progress events. */
export interface EventSink {
  emit(ev: WorkflowEvent): void;
}

/** Drops every event. The default when nobody is watching. */
export class NullSink implements EventSink {
  emit(_ev: WorkflowEvent): void {
    // intentionally empty
  }
}

/** Collects events in memory. Used by in-process tests and `--wait` mode. */
export class MemorySink implements EventSink {
  readonly events: WorkflowEvent[] = [];

  emit(ev: WorkflowEvent): void {
    this.events.push(ev);
  }

  ofType(type: string): WorkflowEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}
