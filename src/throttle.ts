/**
 * Per-adapter concurrency (an ODW extension): how a run paces its agents,
 * said in words.
 *
 * The slots — the run-wide cap, each adapter's own cap, and adaptive
 * back-pressure lowering an adapter's cap after a rate limit — are handed out
 * by the scheduler (./scheduler). What lives here sits above it:
 *
 *   - {@link describeConcurrency}: the caps in force, for the run's start
 *     banner and `odw doctor`; {@link capChangeMessage}: what the run's log
 *     says when adaptive back-pressure moves an adapter's cap.
 */

import { formatSeconds } from "./adapters/failures.js";
import { resolveAdapterConcurrency, resolveConcurrency } from "./adapters/config.js";
import type { Config } from "./adapters/types.js";
import type { AdapterCapChange } from "./scheduler.js";

/**
 * The run's agent caps in one line — "8 agents at once (auto) · per adapter:
 * codex 4, gemini 2" — the per-adapter ones at most the run-wide one. With
 * `details`, also what adaptive back-pressure does.
 */
export function describeConcurrency(config: Config, opts: { details?: boolean } = {}): string {
  const { settings } = config;
  const run = resolveConcurrency(settings.concurrency);
  const parts = [`${run} agent${run === 1 ? "" : "s"} at once${settings.concurrency === null ? " (auto)" : ""}`];
  const caps = Object.entries(resolveAdapterConcurrency(config)).map(([name, cap]) => `${name} ${cap}`);
  if (caps.length > 0) parts.push(`per adapter: ${caps.join(", ")}`);
  if (!opts.details) return parts.join(" · ");
  parts.push(settings.adaptiveConcurrency ? "a rate limit halves its adapter's cap" : "adaptive back-pressure off");
  return parts.join(" · ");
}

/**
 * The log line for an adapter's cap moving under adaptive back-pressure: a
 * cut, and the slot that brings it back to its full cap. Null for the slots
 * given back on the way (one a minute: the line that matters is the last).
 */
export function capChangeMessage(change: AdapterCapChange): string | null {
  const { adapter, limit, previous, max } = change;
  if (change.reason === "rate_limit") {
    return (
      `adaptive concurrency: ${adapter} hit a rate limit — at most ${limit} of its agents at once now ` +
      `(was ${previous}); one slot comes back for each minute without another`
    );
  }
  if (limit < max) return null;
  return `adaptive concurrency: no rate limit on ${adapter} for ${formatSeconds(change.quietMs / 1000)} — back to ${max} of its agents at once`;
}
