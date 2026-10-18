/**
 * Token usage and cost (L1; an ODW extension), normalized across agent CLIs.
 *
 * A CLI that reports what a run spent has it read through its adapter's
 * `usagePath` / `costPath` (adapters/output.ts) into one {@link Usage} shape —
 * Claude Code's stream-json `result` event, for one, carries `usage` and
 * `total_cost_usd`. Where a CLI reports no output tokens, ODW estimates them
 * from the reply (chars/4) and marks the figure `estimated`.
 *
 * The CLIs count cached input differently: Anthropic's `input_tokens` leaves
 * out what was read from or written to the prompt cache (they come as
 * `cache_read_input_tokens` / `cache_creation_input_tokens`), while OpenAI's
 * (and Codex's `cached_input_tokens`) include it. Normalized, `inputTokens` is
 * every input token the model read, cached or not, and the two cache fields
 * say how many of those the cache served or stored.
 */

export interface Usage {
  /** Every input token the model read, whether or not the prompt cache served it. */
  inputTokens?: number;
  /** Tokens the model generated. */
  outputTokens?: number;
  /** How many of `inputTokens` were read from the prompt cache. */
  cacheReadTokens?: number;
  /** How many of `inputTokens` were written to the prompt cache. */
  cacheWriteTokens?: number;
  /** What it cost in US dollars, as the CLI computed it. */
  costUsd?: number;
  /**
   * `outputTokens` is, at least in part, ODW's estimate — chars/4 of a reply
   * whose CLI reported no output tokens — rather than a count.
   */
  estimated?: boolean;
}

/** The numeric fields of a {@link Usage}. */
export const USAGE_COUNTS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;

type Count = (typeof USAGE_COUNTS)[number];

/**
 * Read the usage object a CLI reported (and, apart, its cost) into a
 * {@link Usage}; undefined when neither holds a number ODW recognizes.
 * Understood field names: Anthropic's (`input_tokens`, `output_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens`, and Claude Code's
 * camel-case `cacheReadInputTokens` / `cacheCreationInputTokens`), OpenAI's
 * (`prompt_tokens`, `completion_tokens`, `*_tokens_details.cached_tokens`),
 * Codex's `cached_input_tokens` and `cache_write_input_tokens` (both part of
 * its `input_tokens`, as its reasoning_output_tokens are of its
 * `output_tokens`), cost as `total_cost_usd` / `cost_usd` /
 * `costUSD`, and ODW's own field names. `cost` — what `costPath` points at —
 * wins over a cost inside the usage object.
 */
export function normalizeUsage(raw: unknown, cost?: unknown): Usage | undefined {
  const usage: Usage = {};
  if (isRecord(raw)) {
    const first = (...keys: string[]): number | undefined => {
      for (const key of keys) {
        const value = amount(raw[key]);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    const cachedDetail = (key: string): number | undefined => {
      const details = raw[key];
      return isRecord(details) ? amount(details.cached_tokens) : undefined;
    };
    // Anthropic counts the cache apart from input_tokens: add it back in...
    const cacheRead = first("cache_read_input_tokens", "cacheReadInputTokens");
    const cacheWrite = first("cache_creation_input_tokens", "cacheCreationInputTokens");
    let input = first("inputTokens", "input_tokens", "prompt_tokens", "promptTokens");
    if (cacheRead !== undefined || cacheWrite !== undefined) input = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    set(usage, "inputTokens", input);
    set(usage, "outputTokens", first("outputTokens", "output_tokens", "completion_tokens", "completionTokens"));
    // ...OpenAI, Codex and ODW's own shape already count it inside the input.
    set(
      usage,
      "cacheReadTokens",
      cacheRead ??
        first("cacheReadTokens", "cached_input_tokens") ??
        cachedDetail("input_tokens_details") ??
        cachedDetail("prompt_tokens_details"),
    );
    set(usage, "cacheWriteTokens", cacheWrite ?? first("cacheWriteTokens", "cache_write_input_tokens"));
    set(usage, "costUsd", first("costUsd", "cost_usd", "total_cost_usd", "costUSD"));
  }
  set(usage, "costUsd", amount(cost) ?? usage.costUsd);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * `a + b`, field by field. A field only one side has is carried over; one
 * neither has stays absent, so a total never claims a count nobody reported.
 */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a || !b) {
    const only = a ?? b;
    return only ? { ...only } : undefined;
  }
  const sum: Usage = {};
  for (const key of USAGE_COUNTS) {
    if (a[key] === undefined && b[key] === undefined) continue;
    const total = (a[key] ?? 0) + (b[key] ?? 0);
    // Cents add up in binary floating point: keep a total's dollars tidy.
    sum[key] = key === "costUsd" ? Math.round(total * 1e9) / 1e9 : total;
  }
  if (a.estimated || b.estimated) sum.estimated = true;
  return sum;
}

/** ODW's estimate for a reply whose CLI reported no output tokens: chars/4, rounded up. */
export function estimatedUsage(chars: number): Usage {
  return { outputTokens: Math.ceil(chars / 4), estimated: true };
}

/**
 * A usage object read back from an event (untrusted JSON): only finite,
 * non-negative numbers survive, and `estimated` only as `true`; undefined
 * when nothing does.
 */
export function readUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Usage = {};
  for (const key of USAGE_COUNTS) set(usage, key, amount(value[key]));
  if (Object.keys(usage).length === 0) return undefined;
  if (value.estimated === true) usage.estimated = true;
  return usage;
}

function set(usage: Usage, key: Count, value: number | undefined): void {
  if (value !== undefined) usage[key] = value;
}

/** A count or an amount: a finite number that is not negative. */
function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
