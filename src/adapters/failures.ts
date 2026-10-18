/**
 * Failure classes (L1): why an agent CLI run failed.
 *
 * Every failed CLI run is put in one {@link FailureReason}, from the runner's
 * flags (a stall, a timeout), its exit status, and the end of its output. The
 * class decides what happens next — a rate limit is ridden out (the bridge
 * waits, see {@link backoffSeconds}, and runs the CLI again), while a spent
 * quota or a refused login is never retried but reported with what the user
 * can do about it — and it travels with the failure: `reason` on agent_failed
 * events, `failureReason` on the dashboard's agents.
 *
 * The wording each CLI is known to print lives in one table,
 * {@link FAILURE_PATTERNS}. An adapter can add its own wording for the classes
 * that change what ODW does (`failures` in its config); those patterns are
 * matched first, so they can also re-class a message the table reads otherwise.
 *
 * Two classes are not read from a failed run but from one that "succeeded"
 * without the evidence (ODW extensions): an empty reply (`empty_reply`), and
 * work that missed the call's `expect` checks after its retries
 * (`unmet_expectation`, see ../expect). A run whose CLI refused the agent a
 * tool call while it reported success (Claude Code's `permission_denials`)
 * is a `permission` failure when `permissionDenials` is "fail", or when the
 * call's `expect` still misses because of it; by default it stands. So does
 * one whose CLI started it without an MCP server that failed or needs
 * authentication — `mcp_unavailable` when `mcpFailures` is "fail" — and one
 * whose CLI exited with background work still running (`output.background`)
 * — `orphaned_background` when `orphanedBackground` is "fail", or when the
 * call's `expect` still misses because of it.
 *
 * The HTTP status alone does not decide a class: providers send a spent quota
 * as 429, 401 or 403, and a per-minute limit under the word "quota". So the
 * table reads the words, quota first, and a "quota" that refills within a
 * minute counts as the rate limit it is.
 */

import type { AdapterFailures, CliResult } from "./types.js";

export type FailureReason =
  /** Throttled or overloaded for now: retried after a backoff. */
  | "rate_limit"
  /** A usage window, credit balance or plan limit is spent: wait for the reset. */
  | "quota"
  /** Not logged in, or the credentials were refused. */
  | "auth"
  /** Killed at the timeout. */
  | "timeout"
  /** Killed by the stall watchdog. */
  | "stalled"
  /** The CLI could not be started (exit 127, a missing executable). */
  | "not_found"
  /** A tool call or approval the agent needed was refused. */
  | "permission"
  /** Any other non-zero exit. */
  | "exit"
  /** A clean exit with an empty or whitespace-only reply (ODW extension; `allowEmpty: true` accepts one). */
  | "empty_reply"
  /** The agent's work missed its `expect` checks, retries included (ODW extension). */
  | "unmet_expectation"
  /** An MCP server the CLI started the agent with failed or needs authentication, under `mcpFailures: "fail"` (ODW extension). */
  | "mcp_unavailable"
  /** The agent ran into one of its `limits` — a loop, too many tool calls, too much spend — and was killed (ODW extension). */
  | "runaway"
  /**
   * The CLI ended the agent's turn and exited with background work still
   * running, which died with it, under `orphanedBackground: "fail"` — or
   * among what its `expect` checks still missed (ODW extension).
   */
  | "orphaned_background";

/** The classes an adapter's `failures` config may add patterns to. */
export const CONFIGURABLE_REASONS = ["rate_limit", "quota", "auth"] as const;

/** The classes read from output text. */
type TextReason = "quota" | "auth" | "rate_limit" | "permission";

// Precedence, first match wins. Quota before rate_limit: a spent quota usually
// arrives as an HTTP 429 that also says "rate limit" or "too many requests".
// Quota before auth: a spent quota also arrives as a 401 or 403.
const TEXT_ORDER: readonly TextReason[] = ["quota", "auth", "rate_limit", "permission"];

/**
 * The wording that marks each class, per CLI (and the model APIs they relay),
 * gathered from the CLIs' sources and their issue trackers (tests/failures.test.ts
 * holds a verbatim sample of each, with where it came from). Matched against
 * the end of a failed run's stderr, then of its stdout, case-insensitively,
 * with color codes removed and typographic apostrophes made plain. Specific on
 * purpose: a coding agent's own transcript (a repo's code, a compiler error, a
 * test hitting an API) lands in the same streams.
 */
export const FAILURE_PATTERNS: Readonly<Record<TextReason, readonly RegExp[]>> = {
  quota: [
    // OpenAI's insufficient_quota (codex prints it as "Quota exceeded. Check
    // your plan and billing details."); Moonshot (kimi); Gemini; Qwen.
    /\binsufficient_quota\b|\bexceeded_current_quota/i,
    /\bexceeded (?:your )?current quota\b/i,
    /\bquota (?:exceeded|exhausted)\b|\ballocated quota exceeded\b/i,
    /\bbilling_hard_limit|\bplans? (?:&|and) billing\b|\bbilling (?:account|limit|has not been enabled|is not enabled)\b/i,
    // Subscription usage windows: Claude Code ("Claude AI usage limit
    // reached|<epoch>", "5-hour limit reached ∙ resets 12pm", "You've hit your
    // session limit · resets 10:40pm (Asia/Tokyo)"), Codex and Cursor ("You've
    // hit your usage limit"), Kimi Code ("You've reached your 5-hour usage limit").
    /\busage[ _]limits? (?:reached|exceeded|hit)\b|\busage_limit_exceeded\b|\busage limits? will reset\b/i,
    /\b(?:hit|reached|exceeded) your (?:(?:\d+-hour|five-hour|session|daily|weekly|monthly|usage|plan|spending|credit|free) ){0,2}limit\b/i,
    /\b(?:\d+-hour|five-hour|session|daily|weekly|monthly) (?:usage )?limit (?:reached|exceeded|hit|exhausted)\b/i,
    // Credits: Anthropic API, Codex workspaces, OpenCode Zen, Kilo, OpenRouter.
    /\bcredit balance is too low\b|\binsufficient (?:credits?|balance|funds)\b|\bpayment required\b/i,
    /\b(?:is )?out of credits\b|\badd credits to continue\b|\b(?:requires|needs) more credits\b/i,
    /\bCreditsError\b|\bFreeUsageLimitError\b|\bFREE_USER_USAGE_LIMIT\b|\bUSAGE_PRICING_REQUIRED\b|\bPROMOTION_MODEL_LIMIT_REACHED\b/,
    /\bfree usage (?:exceeded|limit)\b|\bfree tier has been discontinued\b|\baccount budget exceeded\b/i,
    // Codex: a workspace's spend cap; a ChatGPT plan without Codex.
    /\bhit your spend cap\b|\bincrease your spend cap\b|\bwith your ChatGPT plan, upgrade to\b/i,
    // Daily quotas (Gemini: "You have exhausted your daily quota on this model").
    /\bdaily\b[^\n]{0,60}\bquota\b|\bquota\b[^\n]{0,200}\bper ?day\b|\bPerDay\b|\bTerminalQuotaError\b/i,
    /\bexhausted your (?:capacity|quota)\b/i,
  ],
  auth: [
    /\bnot logged in\b|\bnot authenticated\b|\bfailed to authenticate\b/i,
    // Claude Code "Please run /login"; Qwen "Please use '/auth' to re-authenticate".
    /\brun \/login\b|\buse '\/auth'|\bre-?authenticate\b/i,
    // Codex "Please log out and sign in again"; Kilo "Please sign in again".
    /\b(?:log|sign) ?(?:in|out)(?: and sign in)? again\b/i,
    // Cursor "Authentication required. Please run 'agent login' first".
    /\b(?:login|authentication|auth) (?:is )?required\b|\bPAID_MODEL_AUTH_REQUIRED\b/i,
    /\b(?:invalid|incorrect) (?:api[ _-]?key|x-api-key|authentication|credentials|bearer token|access token|token)\b/i,
    /\binvalid_authentication|\bauthentication[_ ](?:error|failed)\b|\bmissing bearer\b/i,
    /\bapi[ _-]?key (?:is )?(?:not valid|invalid|missing|expired|revoked)\b|\bapi[ _-]?key appears to be invalid\b/i,
    /\btoken (?:has )?(?:expired|been revoked|was revoked|is invalid|could not be refreshed)\b/i,
    /\b(?:status(?:[ _]?code)?|code|error|http)\W{0,3}(?:401|403)\b|\b(?:401|403)\W{0,3}(?:unauthori[sz]ed|forbidden)\b/i,
    /\berror\W{0,3}unauthori[sz]ed\b/i,
    // Gemini, Qwen and Kimi with nothing configured; Google IAM.
    /\bset an auth method\b|\bno auth type is selected\b|\bLLM not set\b|\bcaller does not have permission\b/i,
    // OpenCode.
    /\bProviderAuthError\b/,
  ],
  rate_limit: [
    // "rate limited", "Rate limit reached", "rate_limit_error", "RateLimitError",
    // "rate_limit_reached_error", "PRO_USER_RATE_LIMIT_EXCEEDED" ...
    /(?<![a-z])rate[ _-]?limit(?:ed\b|[ _-]?(?:error|exceeded|reached|hit))/i,
    // ... "would exceed the rate limit", "Your API key has hit its rate limit", "Error: rate limit"
    /\b(?:exceed(?:ed|s)?|hit|over|reached) (?:the |your |its |a |our )?rate[ _-]?limit|\berror\W{0,3}rate[ _-]?limit\b/i,
    /\btoo many requests\b/i,
    /\b(?:status(?:[ _]?code)?|code|error|http)\W{0,3}(?:429|529)\b|\((?:429|529)\)|\b(?:429|529)\W{0,3}(?:too many|rate|overloaded)/i,
    // Anthropic 529 overloaded_error; Gemini 503 "The model is overloaded";
    // Moonshot engine_overloaded_error; Codex "Selected model is at capacity".
    /(?<![a-z])overloaded_error|\b(?:model|server|service|api|engine|system)s? (?:is |are )?(?:currently |temporarily )?overloaded\b/i,
    /\b(?:503|529)\b[^\n]{0,80}\boverloaded\b|\berror\W{0,3}overloaded\b/i,
    /\bis at capacity\b|\btemporary capacity issue\b|\btemporarily limiting requests\b/i,
    // Codex: the Flex tier out of capacity; "We're currently experiencing high demand".
    /\bflex capacity unavailable\b|\bexperiencing high demand\b/i,
    // Gemini/Vertex 429 RESOURCE_EXHAUSTED; Cursor "[resource_exhausted]".
    /\bresource (?:has been )?exhausted\b|\bRESOURCE_EXHAUSTED\b|\bRetryableQuotaError\b/i,
    /\bmax (?:RPM|TPM|RPS)\b|\bquota\b[^\n]{0,200}\bper ?minute\b/i,
    // AWS Bedrock; Kilo's gateway while a top-up settles.
    /\bThrottlingException\b|\btop-up is processing\b/i,
  ],
  permission: [
    // Codex: an MCP tool call that needed an approval exec mode cannot give.
    /\buser cancell?ed MCP tool call\b|\bMCP tool call cancell?ed\b|\binteractive approval is unavailable\b/i,
    // Claude Code: permission_denials in JSON output; text mode's refusal.
    /"permission_denials"\s*:\s*\[\s*\{/,
    /\brequested permissions? to\b[^\n]{0,160}\bhaven't granted\b/i,
    // Gemini, Qwen: a tool that needs a confirmation non-interactive mode cannot ask for.
    /\b(?:approval|tool (?:call|use|execution)) (?:was |is )?(?:denied|rejected|refused|declined)\b/i,
    /\bpermission was declined\b|\brequires user (?:approval|confirmation)\b|\bcannot prompt for confirmation\b/i,
    // Codex "exec command rejected by user"; OpenCode, Kilo, Cursor.
    /\b(?:rejected|denied|declined|cancell?ed) by (?:the )?user\b|\buser rejected (?:the operation|permission)\b/i,
    /\bauto-reject(?:ed|ing)\b|\bblocked by permissions configuration\b|\bworkspace trust required\b/i,
  ],
};

/**
 * A "quota" that refills within a minute is a rate limit: waiting it out works.
 * Gemini's free tier sends its per-minute limit as "You exceeded your current
 * quota" with a `...PerMinute...` quota id and "Please retry in 15s".
 */
const PER_MINUTE = /\bper[ _-]?minute\b|PerMinute|\b(?:RPM|TPM|RPS)\b|\b(?:tokens|requests) per min\b/i;
const SHORT_RESET_SECONDS = 60;

/** The verdict on one failed CLI run. */
export interface FailureClass {
  reason: FailureReason;
  /** Seconds until the CLI said it may be retried (rate limit) or its quota resets, when its output said so. */
  retryAfter?: number;
}

/** A wrapper that could not start the CLI it runs (the runner itself reports exit 127). */
const SPAWN_FAILED = /\bspawn\s+\S+\s+ENOENT\b/;

export interface ClassifyOptions {
  /** The adapter's own `failures` patterns, matched before the built-in table. */
  patterns?: AdapterFailures;
  /**
   * The prompt the CLI was given. Output lines that only echo it (codex prints
   * the prompt before its session) are no evidence: a task about rate limits
   * must not make every failure of its agent look like one.
   */
  prompt?: string;
  /** What a printed reset time ("resets at 7pm") is read against, in ms; defaults to now. */
  now?: number;
}

/**
 * Classify a failed CLI run: the runner's flags first (a stall, a timeout),
 * then a CLI that could not start (exit 127), then the output — the adapter's
 * own `failures` patterns, then {@link FAILURE_PATTERNS}. The very end of each
 * stream is read before the rest, so the final error outweighs a transcript
 * printed before it.
 */
export function classifyFailure(cli: CliResult, options: ClassifyOptions = {}): FailureClass {
  if (cli.stalled) return { reason: "stalled" };
  if (cli.timedOut) return { reason: "timeout" };
  if (cli.returncode === 127) return { reason: "not_found" };
  const now = options.now ?? Date.now();
  const echo = echoedLines(options.prompt);
  const stderr = withoutEcho(plain(cli.stderr), echo);
  const stdout = withoutEcho(plain(cli.stdout), echo);
  const regions = [tail(stderr, 2000), tail(stdout, 2000), headAndTail(stderr, 2000, 8000), tail(stdout, 8000)];
  const ownPatterns = compileOwn(options.patterns);
  for (const table of ownPatterns ? [ownPatterns, FAILURE_PATTERNS] : [FAILURE_PATTERNS]) {
    for (const [i, region] of regions.entries()) {
      // A retry is a whole new agent run: a rate limit counts only in the final
      // lines, where a CLI's last error lands — not in a transcript before them.
      const reasons = i < 2 ? TEXT_ORDER : TEXT_ORDER.filter((r) => r !== "rate_limit");
      let reason = reasons.find((r) => table[r]?.some((pattern) => pattern.test(region)));
      if (!reason) continue;
      if (reason !== "rate_limit" && reason !== "quota") return { reason };
      // When to come back: from the message that matched, else from anywhere.
      const retryAfter = parseRetryAfter(region, now) ?? parseRetryAfter(regions.join("\n"), now);
      if (reason === "quota" && (PER_MINUTE.test(region) || (retryAfter ?? Infinity) <= SHORT_RESET_SECONDS)) {
        reason = "rate_limit";
      }
      return retryAfter === undefined ? { reason } : { reason, retryAfter };
    }
  }
  if (SPAWN_FAILED.test(regions[0]!)) return { reason: "not_found" };
  return { reason: "exit" };
}

/**
 * Claude Code's text mode prints some API errors as its reply and exits 0
 * (anthropics/claude-code#79500: "API Error: Rate limit reached"). A short
 * reply that is nothing but such a message is a failed run, not an answer.
 */
const ERROR_REPLY =
  /^(?:API Error\b|Claude AI usage limit reached\b|(?:\d+-hour|session|(?:opus |sonnet )?weekly) limit reached\b|You've (?:hit|reached) your (?:[\w-]+ ){0,2}limit\b|Credit balance is too low\b|Not logged in\b|Invalid API key\b|Failed to authenticate\b|OAuth token has expired\b)/i;
const ERROR_REPLY_MAX_CHARS = 1000;

/**
 * A clean exit whose whole reply is the CLI's own rate-limit, quota or login
 * error — classified like a failure — or null for a real reply. Anchored at the
 * start and short, so an answer that merely discusses such errors stays one.
 */
export function classifyErrorReply(reply: string, options: ClassifyOptions = {}): FailureClass | null {
  const text = plain(reply).trim();
  if (text === "" || text.length > ERROR_REPLY_MAX_CHARS || !ERROR_REPLY.test(text)) return null;
  const verdict = classifyFailure({ returncode: 1, stdout: text, stderr: "", timedOut: false, duration: 0 }, options);
  return verdict.reason === "rate_limit" || verdict.reason === "quota" || verdict.reason === "auth" ? verdict : null;
}

function compileOwn(own: AdapterFailures | undefined): Partial<Record<TextReason, RegExp[]>> | undefined {
  if (!own) return undefined;
  const out: Partial<Record<TextReason, RegExp[]>> = {};
  for (const reason of CONFIGURABLE_REASONS) {
    const patterns: RegExp[] = [];
    for (const source of own[reason] ?? []) {
      try {
        patterns.push(new RegExp(source, "i"));
      } catch {
        // loadConfig rejects a bad pattern; one built by hand is just skipped.
      }
    }
    if (patterns.length) out[reason] = patterns;
  }
  return out;
}

// CSI sequences (colors, cursor moves) and OSC strings (titles, links).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Output as the patterns read it: no color codes, plain apostrophes ("You’ve" is "You've"). */
function plain(text: string): string {
  return text.replace(ANSI, "").replace(/[‘’]/g, "'");
}

/** The prompt's lines that are specific enough to recognize when a CLI prints them back. */
function echoedLines(prompt: string | undefined): Set<string> | undefined {
  if (!prompt) return undefined;
  const lines = new Set<string>();
  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length >= 12) lines.add(trimmed);
  }
  return lines.size ? lines : undefined;
}

function withoutEcho(text: string, echo: Set<string> | undefined): string {
  if (!echo || !text) return text;
  return text
    .split("\n")
    .filter((line) => !echo.has(line.trim()))
    .join("\n");
}

function tail(text: string, chars: number): string {
  return text.length > chars ? text.slice(-chars) : text;
}

function headAndTail(text: string, head: number, rest: number): string {
  return text.length > head + rest ? `${text.slice(0, head)}\n${text.slice(-rest)}` : text;
}

// --- retry-after ---------------------------------------------------------------

/** One `<number> <unit>` of a duration: "2 minutes", "1.5s", the "6m" of "6m0s". */
const DURATION_PART = String.raw`\d+(?:\.\d+)?[ \t]*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])`;
const DURATION = String.raw`${DURATION_PART}(?:[ \t]*(?:,|and)?[ \t]*${DURATION_PART})*`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Retry hints, each read as seconds from `now`; when several match, the last one in the text wins. */
const RETRY_HINTS: Array<{ pattern: RegExp; seconds: (m: RegExpMatchArray, now: number) => number | undefined }> = [
  // "try again in 2 minutes", "Please retry in 41.5s", "Suggested retry after
  // 60s.", "please try again after 1 seconds", "try again in 4 days 6 hours 37 minutes"
  {
    pattern: new RegExp(String.raw`\b(?:try again|retry)\s+(?:in|after)\s+(?:about\s+|approximately\s+|~\s*)?(${DURATION})`, "gi"),
    seconds: (m) => durationSeconds(m[1]!),
  },
  // "resets in 3h 22m", "Your quota will reset after 19h14m47s."
  {
    pattern: new RegExp(String.raw`\bresets?\s+(?:in|after)\s+(${DURATION})`, "gi"),
    seconds: (m) => durationSeconds(m[1]!),
  },
  // An HTTP header: "Retry-After: 30", "retry-after": "30"
  { pattern: /\bretry-after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)(?![\d.])/gi, seconds: (m) => Number(m[1]) },
  // ... or its HTTP-date form: "Retry-After: Wed, 21 Oct 2026 07:28:00 GMT"
  {
    pattern: /\bretry-after["']?\s*[:=]\s*["']?([a-z]{3},\s+\d{1,2}\s+[a-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/gi,
    seconds: (m, now) => untilTime(Date.parse(m[1]!), now),
  },
  // Google RetryInfo: "retryDelay": "41s"
  { pattern: /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/gi, seconds: (m) => Number(m[1]) },
  // Claude Code: "Claude AI usage limit reached|1751911200" (epoch seconds)
  {
    pattern: /\blimit reached\|(\d{10}|\d{13})\b/gi,
    seconds: (m, now) => untilTime(m[1]!.length === 13 ? Number(m[1]) : Number(m[1]) * 1000, now),
  },
  // "resets at 2026-10-17T19:10:00Z"; Qwen "Your limit will reset at 2026-10-13 23:52:51"
  {
    pattern: /\b(?:resets?|try again|retry)\s+(?:at|after)\s+(\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)/gi,
    seconds: (m, now) => untilTime(Date.parse(m[1]!.toUpperCase().replace(" ", "T")), now),
  },
  // A clock time, maybe with a date and a zone: "resets at 7:10pm", "resets 4pm
  // (Asia/Kuala_Lumpur)", "resets Oct 20, 5pm", "try again at Apr 17th, 2026 3:29 PM"
  {
    pattern: new RegExp(
      String.raw`\b(?:resets?|try again|retry)\s+(?:at\s+|on\s+)?` +
        String.raw`(?:(?<mon>${MONTHS.join("|")})[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?<year>\d{4}))?,?\s+(?:at\s+)?)?` +
        String.raw`(?:(?<h12>\d{1,2})(?::(?<m12>[0-5]\d))?\s*(?<ampm>[ap])\.?\s?m\b\.?` +
        String.raw`|(?<h24>[01]?\d|2[0-3]):(?<m24>[0-5]\d)(?::[0-5]\d)?(?![\d:]|\s*[ap]\.?\s?m\b))` +
        String.raw`(?:\s*\((?<zone>[^)\n]{1,40})\))?`,
      "gi",
    ),
    seconds: (m, now) => untilClock(m.groups!, now),
  },
];

/**
 * Read when a CLI says it may be retried — or when its quota resets — from its
 * output, as seconds from `now` (ms); undefined when it does not say. Durations
 * ("try again in 2 minutes", "Retry-After: 30", "retryDelay": "41s"), reset
 * times ("resets at 7:10pm", with a date or an IANA zone in parentheses when
 * given; a clock time with no zone is local) and epoch stamps are understood.
 * A time already past is 0.
 */
export function parseRetryAfter(text: string, now: number = Date.now()): number | undefined {
  let found: { at: number; seconds: number } | undefined;
  for (const { pattern, seconds } of RETRY_HINTS) {
    for (const match of text.matchAll(pattern)) {
      const value = seconds(match, now);
      if (value === undefined || !Number.isFinite(value)) continue;
      if (!found || match.index! >= found.at) found = { at: match.index!, seconds: Math.max(0, value) };
    }
  }
  return found?.seconds;
}

function durationSeconds(text: string): number {
  let total = 0;
  for (const [, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)[ \t]*([a-z]+)/gi)) {
    const u = unit!.toLowerCase();
    const scale = u === "ms" || u.startsWith("milli") ? 0.001 : ({ s: 1, m: 60, h: 3600, d: 86400 }[u[0]!] ?? 0);
    total += Number(value) * scale;
  }
  return total;
}

function untilTime(at: number, now: number): number | undefined {
  return Number.isNaN(at) ? undefined : (at - now) / 1000;
}

/** A reset printed a moment before it is read has just happened; it is not tomorrow's. */
const JUST_PASSED_MS = 2 * 60 * 1000;

/** Seconds until a clock time (and optional date) in a zone, or locally. */
function untilClock(g: Record<string, string | undefined>, now: number): number | undefined {
  if (g.h12 !== undefined && (Number(g.h12) < 1 || Number(g.h12) > 12)) return undefined;
  const hour = g.h12 !== undefined ? (Number(g.h12) % 12) + (g.ampm!.toLowerCase() === "p" ? 12 : 0) : Number(g.h24);
  const minute = Number(g.m12 ?? g.m24 ?? 0);
  const zone = g.zone ? validZone(g.zone.trim()) : undefined;
  const today = wallClock(now, zone);
  const date = {
    year: g.year ? Number(g.year) : today.year,
    month: g.mon ? MONTHS.indexOf(g.mon.slice(0, 3).toLowerCase()) + 1 : today.month,
    day: g.day ? Number(g.day) : today.day,
  };
  let at = fromWallClock({ ...date, hour, minute }, zone);
  // A bare clock time is its next occurrence; a date without a year, the next such date.
  if (at < now - JUST_PASSED_MS && !g.year) {
    at = g.mon
      ? fromWallClock({ ...date, year: date.year + 1, hour, minute }, zone)
      : fromWallClock({ ...date, day: date.day + 1, hour, minute }, zone);
  }
  return untilTime(at, now);
}

function validZone(name: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return undefined; // not an IANA zone ("PT", a remark): read the time locally
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

/** What a clock in `zone` (local when undefined) shows at `ms`. */
function wallClock(ms: number, zone: string | undefined): WallClock {
  if (!zone) {
    const d = new Date(ms);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(ms);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** The instant a clock in `zone` (local when undefined) shows `t`; days past a month's end roll over. */
function fromWallClock(t: WallClock, zone: string | undefined): number {
  if (!zone) return new Date(t.year, t.month - 1, t.day, t.hour, t.minute).getTime();
  const guess = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
  const shown = wallClock(guess, zone);
  const offset = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second ?? 0) - guess;
  return guess - offset;
}

// --- backoff ---------------------------------------------------------------------

/** The first wait before retrying a rate limit that named no retry-after, in seconds; it doubles per retry. */
export const BACKOFF_BASE_SECONDS = 15;

/**
 * Random spread on top of every wait, as a fraction of it, so a fanned-out
 * batch that hit one limit together does not come back in lockstep.
 */
const JITTER = 0.2;

/**
 * How long to wait before rate-limit retry number `retry` (1-based), in
 * seconds: the CLI's own retry-after when it gave one, else
 * {@link BACKOFF_BASE_SECONDS} doubling per retry — plus up to 20% jitter,
 * capped at `maxBackoff`. Null when the CLI asked for longer than
 * `maxBackoff`: a retry before then would only be refused again.
 */
export function backoffSeconds(
  retry: number,
  retryAfter: number | undefined,
  maxBackoff: number,
  random: () => number = Math.random,
): number | null {
  if (retryAfter !== undefined && retryAfter > maxBackoff) return null;
  const base = retryAfter ?? BACKOFF_BASE_SECONDS * 2 ** (retry - 1);
  return Math.min(maxBackoff, base * (1 + JITTER * random()));
}

/** A wait or a reset for people: "0.1s", "45s", "2m 5s", "3h 22m", "4d 2h". */
export function formatSeconds(seconds: number): string {
  if (seconds < 10) return `${Math.ceil(Math.max(0, seconds) * 10) / 10}s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const [big, bigUnit, small, smallUnit] =
    s < 3600
      ? [Math.floor(s / 60), "m", s % 60, "s"]
      : s < 86400
        ? [Math.floor(s / 3600), "h", Math.floor((s % 3600) / 60), "m"]
        : [Math.floor(s / 86400), "d", Math.floor((s % 86400) / 3600), "h"];
  return small ? `${big}${bigUnit} ${small}${smallUnit}` : `${big}${bigUnit}`;
}
