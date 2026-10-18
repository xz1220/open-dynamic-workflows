/**
 * Error hierarchy for Open Dynamic Workflows.
 *
 * The split that matters most is *fatal* vs *recoverable*:
 *
 * - Recoverable errors (a single agent CLI failed, a schema never validated)
 *   are caught by the concurrency primitives and turned into a `null` slot, so
 *   one bad agent does not sink an entire `parallel` / `pipeline` batch.
 * - Fatal errors (a stop was requested, the budget or the dispatch backstop was
 *   hit, the configuration is unusable) must abort the whole run. They
 *   propagate through the primitives instead of being swallowed; the scheduler
 *   records the first one, aborts the agents still running, and the worker
 *   records it as the run's outcome even if the script catches it.
 *
 * `isFatalError` is the single source of truth the scheduler consults, so the
 * two categories never drift apart.
 */

import type { FailureReason } from "./adapters/failures.js";
import type { LimitHit } from "./limits.js";

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

/** An agent CLI failed: non-zero exit, timeout, stall, or spawn failure. */
export class AdapterExecutionError extends DynamicWorkflowError {
  /** Why it failed (see adapters/failures.ts); "exit" when nothing more specific is known. */
  readonly reason: FailureReason;
  /** Seconds until the CLI said it may be retried, or its quota resets, when its output said so. */
  declare readonly retryAfter?: number;

  constructor(message?: string, failure: { reason: FailureReason; retryAfter?: number } = { reason: "exit" }) {
    super(message);
    this.reason = failure.reason;
    if (failure.retryAfter !== undefined) this.retryAfter = failure.retryAfter;
  }
}

/**
 * An agent's work missed its `expect` checks, retries included (an ODW
 * extension; see ./expect): reason "unmet_expectation" — or "permission" when
 * its CLI refused it tool calls, which count as a miss; "orphaned_background"
 * when it left background work running, which does too — and what it missed.
 * Without `expect`, "out_of_scope" is the failure of an agent that wrote
 * outside its declared scope under `scopePolicy: "fail"` (see ./scope).
 */
export class UnmetExpectationError extends AdapterExecutionError {
  /** Each check the last attempt did not meet, in one line. */
  readonly misses: string[];

  constructor(
    message: string,
    misses: string[],
    reason: "unmet_expectation" | "permission" | "orphaned_background" | "out_of_scope" = "unmet_expectation",
  ) {
    super(message, { reason });
    this.misses = misses;
  }
}

/**
 * An agent ran into one of its `limits` (an ODW extension; see ./limits): its
 * CLI was killed, reason "runaway", and `hit` names the limit and the evidence.
 * Not retried — not by `transientRetries`, not as an `expect` miss.
 */
export class RunawayError extends AdapterExecutionError {
  readonly hit: LimitHit;

  constructor(message: string, hit: LimitHit) {
    super(message, { reason: "runaway" });
    this.hit = hit;
  }
}

/** An agent never produced output matching the requested schema. */
export class SchemaValidationError extends DynamicWorkflowError {}

/**
 * An agent() call cannot run as asked — an option it may not use, an adapter
 * that cannot honour it — so it fails before its CLI starts. Recoverable: it
 * concerns that one agent, which `parallel`/`pipeline` turn into a `null` slot.
 */
export class AgentError extends DynamicWorkflowError {}

/** The run-wide cap on total agent dispatches was hit (a runaway guard). */
export class AgentLimitExceeded extends DynamicWorkflowError {}

/**
 * The run's token budget (`--budget`, `budget.total`) was reached. A hard
 * ceiling, not advisory: once `spent() >= total` — output tokens, as the CLI
 * reported them or else estimated as chars/4 of the reply, over every attempt
 * — no further agent dispatches and no schema retry starts.
 */
export class BudgetExhausted extends DynamicWorkflowError {}

/** A stop was requested: running agents are killed and the run unwinds. */
export class RunStopped extends DynamicWorkflowError {}

/** The workflow script is malformed (bad `meta`, syntax error, no result). */
export class WorkflowScriptError extends DynamicWorkflowError {}

/**
 * Errors that must propagate through `parallel`/`pipeline` rather than becoming
 * a `null` result slot. Everything else is a recoverable per-item failure.
 *
 * Configuration errors (including a missing/ambiguous adapter) are fatal: they
 * fail every agent identically, so swallowing them would turn a fixable setup
 * problem into an exit-0 run full of silent null slots.
 */
export function isFatalError(error: unknown): boolean {
  return (
    error instanceof AgentLimitExceeded ||
    error instanceof RunStopped ||
    error instanceof BudgetExhausted ||
    error instanceof ConfigError
  );
}
