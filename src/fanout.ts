/**
 * Fan-out health (an ODW extension): how a `parallel()` or `pipeline()` call
 * came out, so a fan-out that is mostly `null` is seen rather than carried on.
 *
 * Every call that settles writes one `fanout_done` event:
 *
 *   { type: "fanout_done", call: "parallel()" | "pipeline()", phase, total,
 *     ok, failed, null, reasons: { <reason>: n }, minOk?, belowMinOk? }
 *
 * `failed`: slots whose thunk (or a stage) threw — `reasons` counts them by
 * the agent failure reason (`rate_limit`, `timeout`, …; see
 * adapters/failures.ts) or else the error's name; `null`: slots whose thunk
 * returned `null` itself; `ok`: everything else (`undefined` included — a
 * thunk run for its effect). When over half of a fan-out is null either way,
 * the run logs it once. A fan-out a fatal error ended writes nothing: the run
 * fails with that error.
 *
 * `parallel(thunks, { minOk })` makes the shortfall an error: a whole number
 * of slots, a fraction of them (`0.8`: 80%, rounded up), or `"all"`. When
 * fewer come back ok, parallel() throws a {@link FanOutShortfall} with the
 * counts instead of resolving. Without `minOk` nothing changes: Claude Code's
 * dialect — failed slots are `null` and the script goes on — is kept.
 */

import { AdapterExecutionError, DynamicWorkflowError } from "./errors.js";
import { FANOUT_DONE, event, type WorkflowEvent } from "./events.js";

/** `parallel()`'s `minOk` option, as written. */
export type MinOk = number | "all";

/** How one slot of a fan-out came out. */
export type SlotOutcome = { kind: "ok" } | { kind: "null" } | { kind: "failed"; reason: string };

/** The counts a `fanout_done` event carries. */
export interface FanOutCounts {
  total: number;
  ok: number;
  failed: number;
  null: number;
  /** Failed slots by reason. */
  reasons: Record<string, number>;
}

/** A parallel() with fewer ok results than its `minOk` asked for. Recoverable: an outer parallel() makes it a null slot. */
export class FanOutShortfall extends DynamicWorkflowError {
  constructor(
    message: string,
    readonly counts: FanOutCounts,
    /** The ok results it needed. */
    readonly required: number,
  ) {
    super(message);
  }
}

/** Check a `minOk` option; returns it, or throws `fail(message)`. */
export function readMinOk(value: unknown, fail: (message: string) => Error): MinOk {
  if (value === "all") return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && (Number.isInteger(value) || value < 1)) return value;
  throw fail(
    `parallel(): minOk must be a whole number of results (3), a fraction of them (0.8) or "all"; got ${JSON.stringify(value) ?? String(value)}`,
  );
}

/** How many ok results `minOk` asks of a fan-out `total` wide. */
export function requiredOk(minOk: MinOk, total: number): number {
  if (minOk === "all") return total;
  if (Number.isInteger(minOk)) return minOk;
  return Math.ceil(minOk * total - 1e-9);
}

/** How a slot that threw counts: its agent failure reason, else the error's name. */
export function failedOutcome(err: unknown): SlotOutcome {
  if (err instanceof AdapterExecutionError) return { kind: "failed", reason: err.reason };
  if (err instanceof Error && err.name) return { kind: "failed", reason: err.name };
  return { kind: "failed", reason: "error" };
}

/** How a slot that returned `value` counts. */
export function returnedOutcome(value: unknown): SlotOutcome {
  return value === null ? { kind: "null" } : { kind: "ok" };
}

/** Count a fan-out's slots; one that never settled (it cannot, past gather) counts as failed. */
export function countOutcomes(outcomes: Array<SlotOutcome | undefined>): FanOutCounts {
  const counts: FanOutCounts = { total: outcomes.length, ok: 0, failed: 0, null: 0, reasons: {} };
  for (const outcome of outcomes) {
    const o = outcome ?? { kind: "failed", reason: "error" };
    if (o.kind === "ok") counts.ok++;
    else if (o.kind === "null") counts.null++;
    else {
      counts.failed++;
      counts.reasons[o.reason] = (counts.reasons[o.reason] ?? 0) + 1;
    }
  }
  return counts;
}

/** Over half of the fan-out came back null, failed or returned so. */
export function mostlyNull(counts: FanOutCounts): boolean {
  return counts.total > 0 && (counts.failed + counts.null) * 2 > counts.total;
}

/** `7 of 10 ok; 2 failed (rate_limit 2); 1 null` — a fan-out's counts in a line. */
export function countsText(counts: FanOutCounts): string {
  const parts = [`${counts.ok} of ${counts.total} ok`];
  if (counts.failed > 0) {
    const why = Object.entries(counts.reasons)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, n]) => `${reason} ${n}`)
      .join(", ");
    parts.push(`${counts.failed} failed (${why})`);
  }
  if (counts.null > 0) parts.push(`${counts.null} returned null`);
  return parts.join("; ");
}

/** What a fan-out's line names it by: `parallel() of 10 tasks`, `pipeline() of 4 items`. */
export function fanOutWhat(call: string, total: number): string {
  return call === "pipeline()" ? `pipeline() of ${total} item${total === 1 ? "" : "s"}` : `parallel() of ${total} task${total === 1 ? "" : "s"}`;
}

/** The `fanout_done` event of a settled fan-out. */
export function fanOutEvent(
  call: "parallel()" | "pipeline()",
  phase: string | null,
  counts: FanOutCounts,
  min?: { minOk: MinOk; required: number },
): WorkflowEvent {
  return event(FANOUT_DONE, {
    call,
    ...(phase !== null ? { phase } : {}),
    ...counts,
    reasons: { ...counts.reasons },
    ...(min ? { minOk: min.minOk, required: min.required, belowMinOk: counts.ok < min.required } : {}),
  });
}

/** A `fanout_done` event's line for `odw logs` and the live view. */
export function fanOutLine(ev: WorkflowEvent): string {
  const counts: FanOutCounts = {
    total: num(ev.total),
    ok: num(ev.ok),
    failed: num(ev.failed),
    null: num(ev.null),
    reasons: reasonsOf(ev.reasons),
  };
  const below = ev.belowMinOk === true ? ` — below minOk (${num(ev.required)} needed)` : "";
  return `${fanOutWhat(String(ev.call ?? "parallel()"), counts.total)}: ${countsText(counts)}${below}`;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function reasonsOf(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, n]) => typeof n === "number")) as Record<string, number>;
}
