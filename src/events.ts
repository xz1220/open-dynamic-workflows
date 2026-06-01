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
