/**
 * What a fan-out is forecast to cost, before it starts (an ODW extension).
 *
 * "I find out only at the end whether a task cost $0.50 or $15": a run that
 * has history — finished runs of the same workflow (see runtime/estimate) —
 * can say before a parallel() or pipeline() starts what it will likely cost:
 * its width × the median cost of the agents with the same label prefix in
 * that phase in those runs (else of the phase's agents), with the 90th
 * percentile beside it. The forecast is logged before a fan-out at least
 * `fanOutWarn` wide, and before any fan-out a `costGate` covers.
 *
 * `costGate: { usd }` — the setting, or a parallel()'s or an agent()'s option
 * — turns a forecast over the gate into an automatic checkpoint():
 *
 *   "This fan-out is forecast to cost ~$X (p90 $Y) — go?"  payload { width, forecast }
 *
 * answered like any other (odw approve|reject, the dashboard, a signed
 * approve link). A rejection throws {@link CostGateRejected} — recoverable,
 * like a failed agent: the script may catch it and go on without the
 * fan-out. Without history the gate lets everything through, and says so
 * once per run.
 */

import { DynamicWorkflowError } from "./errors.js";
import { fmtUsd } from "./tty.js";

/** The median and 90th percentile of some samples, and how many there were. */
export interface Spread {
  p50: number;
  p90: number;
  n: number;
}

/**
 * The p50 and p90 of `values` by nearest rank (the smallest value with at
 * least that share of the samples at or below it); null for no samples.
 */
export function spread(values: readonly number[]): Spread | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: rank(0.5), p90: rank(0.9), n: sorted.length };
}

/**
 * What a fan-out's agents' labels share: the label without a trailing index —
 * `review-3`, `review 3`, `review#3`, `review:3`, `review_3` → `review`. A
 * label that is all index stays as it is.
 */
export function labelPrefix(label: string): string {
  const stripped = label.replace(/[\s:#._/-]*\d+$/, "");
  return stripped.length > 0 ? stripped : label;
}

/** One settled agent of an earlier run, as the forecast reads it. */
export interface CostSample {
  runId: string;
  phase: string | null;
  label: string;
  /** What it cost, when its CLI said. */
  costUsd?: number;
  /** Its output tokens, when known. */
  outputTokens?: number;
}

/** A fan-out's forecast: what its agents are likely to cost, from earlier runs. */
export interface FanOutForecast {
  /** "parallel()", "pipeline()" or "agent()". */
  call: string;
  /** Its thunks, its items, or 1 for an agent(). */
  width: number;
  /** The agents it is forecast to start: its width, × the stages of a pipeline(). */
  agents: number;
  phase: string | null;
  /** The label prefix the samples share, for an agent() whose label matched; null when they are the phase's. */
  label: string | null;
  /** "label": agents with its label prefix in its phase; "phase": every agent of its phase. */
  basis: "label" | "phase";
  /** What one agent cost: p50, p90 and how many agents that is from. */
  perAgentUsd: Spread;
  /** agents × the per-agent p50, and × the p90, in US dollars. */
  usd: number;
  p90Usd: number;
  /** One agent's output tokens (p50, p90), when the samples say; else null. */
  perAgentOutputTokens: Spread | null;
  /** How many earlier runs the samples come from, and how they were matched (see runtime/estimate). */
  runs: number;
  match: "sourceHash" | "name";
}

/** A workflow's history, as a run consults it before each fan-out. */
export class CostHistory {
  constructor(
    private readonly samples: readonly CostSample[],
    /** How the runs were matched: the same source, or only the same name. */
    readonly match: "sourceHash" | "name",
  ) {}

  /** How many earlier runs the samples come from. */
  get runs(): number {
    return new Set(this.samples.map((s) => s.runId)).size;
  }

  /**
   * The forecast for `agents` agents of `phase` — from the agents of that
   * phase whose label prefix is `label`'s, else from all of the phase's —
   * or null when none of them reported a cost.
   */
  forecast(call: string, width: number, agents: number, phase: string | null, label?: string | null): FanOutForecast | null {
    const inPhase = this.samples.filter((s) => s.phase === phase && s.costUsd !== undefined);
    const prefix = label ? labelPrefix(label) : null;
    const labelled = prefix ? inPhase.filter((s) => labelPrefix(s.label) === prefix) : [];
    const basis = labelled.length > 0 ? "label" : "phase";
    const used = basis === "label" ? labelled : inPhase;
    const perAgentUsd = spread(used.map((s) => s.costUsd!));
    if (!perAgentUsd) return null;
    const tokens = spread(used.filter((s) => s.outputTokens !== undefined).map((s) => s.outputTokens!));
    return {
      call,
      width,
      agents,
      phase,
      label: basis === "label" ? prefix : null,
      basis,
      perAgentUsd,
      usd: dollars(perAgentUsd.p50 * agents),
      p90Usd: dollars(perAgentUsd.p90 * agents),
      perAgentOutputTokens: tokens,
      runs: new Set(used.map((s) => s.runId)).size,
      match: this.match,
    };
  }
}

/** A cost gate: a fan-out forecast to cost more than `usd` dollars waits for a person's go. */
export interface CostGate {
  usd: number;
}

/**
 * A `costGate` as a config or a call gives it: `{ usd: <dollars> }`, the
 * dollars a positive number. `null` means none (an option's way to lift the
 * setting's); anything else is a mistake, thrown as `fail(message)`.
 */
export function readCostGate(raw: unknown, where: string, fail: (message: string) => Error): CostGate | null {
  if (raw === null) return null;
  const expected = `${where} must be { usd: <dollars> } (a positive number), or null for none`;
  if (typeof raw !== "object" || Array.isArray(raw)) throw fail(`${expected}; got ${JSON.stringify(raw) ?? typeof raw}`);
  const keys = Object.keys(raw as object);
  const extra = keys.filter((k) => k !== "usd");
  if (extra.length > 0) throw fail(`${expected}; it has no "${extra[0]}"`);
  const usd = (raw as { usd?: unknown }).usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) throw fail(`${expected}; got usd ${JSON.stringify(usd) ?? "undefined"}`);
  return { usd };
}

/** The title of a gate's checkpoint. */
export function costGateTitle(forecast: FanOutForecast): string {
  return `This fan-out is forecast to cost ~${fmtUsd(forecast.usd)} (p90 ${fmtUsd(forecast.p90Usd)}) — go?`;
}

/**
 * Someone rejected a fan-out its cost gate stopped (ODW extension).
 * Recoverable, like a failed agent: the script may catch it — its `name` is
 * "CostGateRejected" — and go on without that fan-out.
 */
export class CostGateRejected extends DynamicWorkflowError {
  constructor(
    message: string,
    readonly forecast: FanOutForecast,
    readonly note: string | null,
  ) {
    super(message);
  }
}

/** Dollars rounded to a millionth: sums of cents stay tidy. */
function dollars(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
