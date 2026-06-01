/**
 * Error hierarchy for Open Dynamic Workflows.
 *
 * The split that matters most is *fatal* vs *recoverable*:
 *
 * - Recoverable errors (a single agent CLI failed, a schema never validated)
 *   are caught by the concurrency primitives and turned into a `null` slot, so
 *   one bad agent does not sink an entire `parallel` / `pipeline` batch.
 * - Fatal errors (the run-wide agent backstop is hit, or a stop was requested)
 *   must abort the whole run. They propagate through the primitives instead of
 *   being swallowed.
 *
 * `isFatalError` is the single source of truth the scheduler consults, so the
 * two categories never drift apart.
 */

export class DynamicWorkflowError extends Error {
  constructor(message?: string) {
    super(message);
    // Give each subclass its own name for readable stack traces.
    this.name = new.target.name;
  }
}

/** The adapter/run configuration could not be loaded or is invalid. */
export class ConfigError extends DynamicWorkflowError {}

/** A workflow referenced an adapter name that is not configured. */
export class AdapterNotFound extends ConfigError {}

/** An agent CLI failed: non-zero exit, timeout, or spawn failure. */
export class AdapterExecutionError extends DynamicWorkflowError {}

/** An agent never produced output matching the requested schema. */
export class SchemaValidationError extends DynamicWorkflowError {}

/** The run-wide cap on total agent dispatches was hit (a runaway guard). */
export class AgentLimitExceeded extends DynamicWorkflowError {}

/** A stop was requested; the run unwinds at the next safe point. */
export class RunStopped extends DynamicWorkflowError {}

/** The workflow script is malformed (bad `meta`, syntax error, no result). */
export class WorkflowScriptError extends DynamicWorkflowError {}

/**
 * Errors that must propagate through `parallel`/`pipeline` rather than becoming
 * a `null` result slot. Everything else is a recoverable per-item failure.
 */
export function isFatalError(error: unknown): boolean {
  return error instanceof AgentLimitExceeded || error instanceof RunStopped;
}

/** Uniform placeholder for layers still being built out, milestone by milestone. */
export function notImplemented(what: string): DynamicWorkflowError {
  return new DynamicWorkflowError(`not implemented yet: ${what}`);
}
