/**
 * Execution bridge (L2): turn one `agent` call into one CLI invocation.
 *
 * Given an {@link AgentRequest} it: resolves the adapter, composes a
 * self-contained prompt (independence framing + optional schema instructions),
 * runs the adapter in its workspace (the source tree by default, a throwaway
 * git worktree when isolation is requested), and — when a schema is requested —
 * extracts/validates the reply and retries with corrective feedback until it
 * conforms or the retry budget is spent. A CLI the stall watchdog killed for
 * going quiet is started again, up to `stallRestarts` times per call.
 *
 * Every failed CLI run is classified (adapters/failures.ts). A rate-limited
 * one is ridden out: retried after an exponential backoff that honors the
 * retry-after it printed, up to `transientRetries` times per call. A spent
 * quota or a refused login is not retried; its error says what to do instead.
 *
 * The command runner is injectable, so the bridge unit-tests with a fake runner
 * and no real agent account; so are the backoff's sleep, clock and jitter.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAdapter } from "./adapters/config.js";
import {
  backoffSeconds,
  classifyErrorReply,
  classifyFailure,
  formatSeconds,
  type FailureClass,
} from "./adapters/failures.js";
import { expand, expandAll, type PlaceholderContext } from "./adapters/placeholders.js";
import { AdapterOutputDecoder, decodeAdapterOutput } from "./adapters/output.js";
import { runCommand, type CommandRunner } from "./adapters/runner.js";
import {
  adapterDisplayName,
  cliOk,
  type Adapter,
  type CliResult,
  type Config,
} from "./adapters/types.js";
import { AdapterExecutionError, RunStopped, SchemaValidationError, isFatalError } from "./errors.js";
import { LiteralRouter, type InvocationPlan, type OptionRouter } from "./router.js";
import { describeSchema, pickJson, type JsonSchema } from "./schema.js";
import { withWorkspace } from "./workspace.js";

export const INDEPENDENCE_PREAMBLE =
  "You are one agent in an automated multi-agent workflow. Work independently " +
  "on the task below. Do not ask clarifying questions and do not assume other " +
  "agents exist. Produce your result directly.";

export interface AgentRequest {
  prompt: string;
  adapter?: string;
  schema?: JsonSchema;
  label?: string;
  /** Select a model; routed to the adapter's declared model flag (or noted). */
  model?: string;
  /** Persona to take on; injected into the prompt (universal, every CLI). */
  agentType?: string;
  /** `"worktree"`: run this agent in a throwaway git worktree (as in Claude Code). */
  isolation?: "worktree";
}

/** The persona framing injected for `agentType`, on top of the independence preamble. */
export function personaPreamble(agentType: string): string {
  return (
    `Take on the role of the "${agentType}" agent for this task. Bring the ` +
    `expertise, priorities, and conventions that role implies to the work below.`
  );
}

export interface AgentOutcome {
  /** Validated structured object, or the raw text when no schema. */
  value: unknown;
  /** The raw final reply. */
  text: string;
  /** Adapter name actually used. */
  adapter: string;
  /** How many CLI calls it took (>1 means schema retries happened). */
  attempts: number;
  /**
   * Notes from option routing: options accepted but not honoured natively, and
   * what was done instead. The caller surfaces these as LOG events so no option
   * is dropped silently. Empty when every set option mapped cleanly.
   */
  notes: string[];
}

export interface BridgeOptions {
  source?: string;
  runner?: CommandRunner;
  /** How `agent` options map to a CLI invocation; defaults to {@link LiteralRouter}. */
  router?: OptionRouter;
  /**
   * How a rate-limited call waits before its retry. It must end early when the
   * signal aborts; defaults to a timer that does.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The clock a printed reset time ("resets at 7pm") is read against, in ms; defaults to Date.now. */
  now?: () => number;
  /** Where backoff jitter comes from, in [0, 1); defaults to Math.random. */
  random?: () => number;
}

/** What the scheduler hands one call; all optional, so a bare `run(request)` works. */
export interface RunOptions {
  /**
   * The run's abort signal. Aborting kills the CLI process (and everything it
   * started) and ends the call with the signal's reason — the run's fatal
   * error — so it propagates instead of becoming a null slot.
   */
  signal?: AbortSignal;
  /**
   * Called with every attempt's decoded reply as soon as it arrives — schema
   * retries included — so the run's usage tally counts all the output it paid
   * for, not just the reply that finally validated.
   */
  onReply?: (text: string) => void;
  /**
   * Run before each extra CLI run of the call — a schema retry or a stall
   * restart — so it passes the same stop/budget guards as a dispatch. Throw to
   * abandon the call.
   */
  beforeRetry?: () => void | Promise<void>;
  /** Called before a stalled CLI is restarted, so the run can say so. */
  onStall?: (stall: StallRestart) => void;
  /** Called before the backoff wait of a rate-limited CLI, so the run can say how long it waits. */
  onRateLimit?: (retry: RateLimitRetry) => void;
  /**
   * Called once when an adapter's quota or login has failed
   * {@link ADAPTER_WARNING_STREAK} calls in a row: its other agents will likely
   * fail the same way, though the run goes on (other adapters may be fine).
   */
  onAdapterWarning?: (warning: AdapterWarning) => void;
}

/** A CLI the stall watchdog killed, about to be started again. */
export interface StallRestart {
  /** The stall timeout it hit: seconds without a byte on stdout or stderr. */
  quietSeconds: number;
  /** Which restart this is (1-based), and how many the call may make (`stallRestarts`). */
  restart: number;
  maxRestarts: number;
}

/** A rate-limited CLI, about to be run again after a backoff. */
export interface RateLimitRetry {
  /** The adapter that hit the limit. */
  adapter: string;
  /** How long the call waits before the retry, in seconds. */
  waitSeconds: number;
  /** Which retry this is (1-based), and how many the call may make (`transientRetries`). */
  retry: number;
  maxRetries: number;
}

/** An adapter whose quota or login failed several calls in a row. */
export interface AdapterWarning {
  adapter: string;
  reason: "quota" | "auth";
  /** How many calls in a row it failed. */
  streak: number;
  /** What happened and what the user can do, ready to log. */
  message: string;
}

/** Calls in a row an adapter's quota or login may fail before the run warns about it. */
export const ADAPTER_WARNING_STREAK = 3;

export class Bridge {
  private readonly source: string;
  private readonly runner: CommandRunner;
  private readonly router: OptionRouter;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private autoPicked: Adapter | undefined;
  /** Per adapter: how many calls in a row its quota or login failed. */
  private readonly blockedStreaks = new Map<string, number>();

  constructor(
    private readonly config: Config,
    options: BridgeOptions = {},
  ) {
    this.source = options.source ?? process.cwd();
    this.runner = options.runner ?? runCommand;
    this.router = options.router ?? new LiteralRouter();
    this.sleep = options.sleep ?? sleepUnlessAborted;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * The adapter a call runs on: the named one, else the configured default,
   * else the zero-config auto-pick; throws AdapterNotFound (a ConfigError). The
   * auto-pick scans PATH, so it happens once per bridge (one run) and is then
   * reused: every agent of a run gets the same CLI, even if PATH changes.
   */
  adapterFor(name?: string | null): Adapter {
    if (name || this.config.settings.defaultAdapter) return resolveAdapter(this.config, name);
    return (this.autoPicked ??= resolveAdapter(this.config, null));
  }

  async run(request: AgentRequest, options: RunOptions = {}): Promise<AgentOutcome> {
    const adapter = this.adapterFor(request.adapter);
    try {
      const outcome = await this.call(adapter, request, options);
      this.blockedStreaks.delete(adapter.name);
      return outcome;
    } catch (err) {
      this.noteFailure(adapter, err, options);
      throw err;
    }
  }

  private async call(adapter: Adapter, request: AgentRequest, options: RunOptions): Promise<AgentOutcome> {
    const { signal } = options;
    const settings = this.config.settings;
    const limits: CliLimits = {
      timeout: adapter.timeout ?? settings.timeout ?? undefined,
      // An adapter's 0 opts it out of a run-wide stall timeout; null is off.
      stallTimeout: (adapter.stallTimeout ?? settings.stallTimeout) || undefined,
    };
    // Plan the invocation once: workspace mode, the model token/flag, and the
    // routing notes do not change across schema retries — only the prompt does.
    const plan = this.router.plan({ request, adapter, settings });
    const basePrompt = this.composePrompt(request);
    const maxAttempts = request.schema ? settings.schemaRetries + 1 : 1;

    let problems: string[] = [];
    let previous = "";
    // Stall restarts and rate-limit retries re-run one attempt's prompt; each
    // is capped over the whole call, schema attempts included.
    const reruns: Reruns = { stalls: 0, rateLimits: 0 };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(signal);
      if (attempt > 1) await options.beforeRetry?.();
      const prompt = attempt > 1 ? `${basePrompt}\n\n${retryFeedback(previous, problems)}` : basePrompt;
      const { cli, decoder, failure } = await this.invokeUntilFinal(adapter, plan, prompt, limits, options, reruns);
      // Killed by a stop (or by a fatal error elsewhere in the run): report
      // the run's reason, not a misleading CLI failure.
      throwIfAborted(signal);
      if (failure || !cliOk(cli)) {
        const verdict = failure ?? classifyFailure(cli, { patterns: adapter.failures, prompt, now: this.now() });
        throw new AdapterExecutionError(
          cliFailureMessage(adapter, cli, this.whatFailed(adapter, cli, verdict, limits, reruns)),
          verdict,
        );
      }

      // A runner that streams stdout fed the decoder and kept only a tail; an
      // injected runner that does not stream returns the whole stdout instead.
      const text = decoder?.received ? decoder.finish() : decodeAdapterOutput(adapter, cli.stdout);
      options.onReply?.(text);
      if (!request.schema) {
        return { value: text, text, adapter: adapter.name, attempts: attempt, notes: plan.notes };
      }

      // The schema steers extraction to the one candidate that satisfies it;
      // two different valid values are ambiguous and get retried, not guessed.
      const pick = pickJson(text, request.schema);
      const value = pick.value;
      problems = pick.problems;
      if (problems.length === 0) {
        return { value, text, adapter: adapter.name, attempts: attempt, notes: plan.notes };
      }
      previous = text;
    }

    throw new SchemaValidationError(
      `adapter '${adapter.name}' did not satisfy the schema after ${maxAttempts} attempt(s); ` +
        `last problems: ${problems.join("; ")}`,
    );
  }

  /**
   * Run one prompt until its CLI run is final. A run the stall watchdog killed
   * is started again (`stallRestarts` per call); a rate-limited one is retried
   * after a backoff (`transientRetries` per call, each wait capped at
   * `maxBackoff`). Every extra run passes the stop/budget guards first, and a
   * stop during a backoff ends the wait at once. A failure that ends the loop
   * comes back classified — a clean exit whose reply is only the CLI's own
   * rate-limit, quota or login error included — so the caller need not read
   * the output twice.
   */
  private async invokeUntilFinal(
    adapter: Adapter,
    plan: InvocationPlan,
    prompt: string,
    limits: CliLimits,
    options: RunOptions,
    reruns: Reruns,
  ): Promise<{ cli: CliResult; decoder: AdapterOutputDecoder | null; failure?: FailureClass }> {
    const { signal } = options;
    const settings = this.config.settings;
    const classify = { patterns: adapter.failures, prompt };
    for (;;) {
      const invoked = await this.invoke(adapter, plan, prompt, limits, signal);
      const { cli } = invoked;
      if (signal?.aborted) return invoked;
      if (cli.stalled) {
        if (reruns.stalls >= settings.stallRestarts) return invoked;
        reruns.stalls++;
        options.onStall?.({
          quietSeconds: limits.stallTimeout ?? 0,
          restart: reruns.stalls,
          maxRestarts: settings.stallRestarts,
        });
      } else {
        // Claude Code's text mode prints some API errors as its reply and exits
        // 0; JSONL adapters report theirs as events, with a non-zero exit.
        const failure = !cliOk(cli)
          ? classifyFailure(cli, { ...classify, now: this.now() })
          : adapter.output?.format === "jsonl"
            ? null
            : classifyErrorReply(cli.stdout, { ...classify, now: this.now() });
        if (!failure) return invoked; // a real reply
        if (failure.reason !== "rate_limit" || reruns.rateLimits >= settings.transientRetries) {
          return { ...invoked, failure };
        }
        const wait = backoffSeconds(reruns.rateLimits + 1, failure.retryAfter, settings.maxBackoff, this.random);
        if (wait === null) return { ...invoked, failure }; // the CLI asked for longer than maxBackoff
        reruns.rateLimits++;
        options.onRateLimit?.({
          adapter: adapter.name,
          waitSeconds: wait,
          retry: reruns.rateLimits,
          maxRetries: settings.transientRetries,
        });
        await this.sleep(wait * 1000, signal);
        throwIfAborted(signal);
      }
      await options.beforeRetry?.();
    }
  }

  /** How a failed CLI run is summed up in its error: what happened and, when the user can act, what to do. */
  private whatFailed(adapter: Adapter, cli: CliResult, failure: FailureClass, limits: CliLimits, reruns: Reruns): string {
    const settings = this.config.settings;
    const switchAdapter = "or switch adapter with --adapter <name>";
    switch (failure.reason) {
      case "stalled":
        return stallReason(limits.stallTimeout, reruns.stalls);
      case "timeout":
        return "timed out";
      case "not_found":
        return "could not start its CLI — install it or fix the adapter's command (odw doctor checks both)";
      case "rate_limit":
        // The retries ran out, or the CLI asked for a longer wait than maxBackoff allows.
        if (reruns.rateLimits >= settings.transientRetries) {
          return reruns.rateLimits
            ? `hit a rate limit and was still limited after ${reruns.rateLimits} ${reruns.rateLimits === 1 ? "retry" : "retries"}`
            : "hit a rate limit";
        }
        return (
          `hit a rate limit and asked to wait ${formatSeconds(failure.retryAfter ?? 0)}, ` +
          `longer than maxBackoff (${settings.maxBackoff}s) — retry later, or raise maxBackoff`
        );
      case "quota": {
        const reset = failure.retryAfter !== undefined ? ` (in ${formatSeconds(failure.retryAfter)})` : "";
        return `ran out of usage quota — wait for the window to reset${reset} and resume the run, ${switchAdapter}`;
      }
      case "auth":
        return `could not authenticate — log in to ${adapterDisplayName(adapter)} and resume the run, ${switchAdapter}`;
      case "permission":
        return `was refused a permission it needed — allow it in the adapter's command flags, ${switchAdapter}`;
      default:
        return `exited with code ${cli.returncode}`;
    }
  }

  /**
   * Count the calls an adapter's quota or login failed in a row. They are not
   * retried, and they do not end the run — other adapters may be fine — but the
   * streak reaching {@link ADAPTER_WARNING_STREAK} earns one warning: the rest
   * of that adapter's agents will likely fail the same way. Any other outcome
   * on the adapter ends the streak; a stop or a run-ending error says nothing.
   */
  private noteFailure(adapter: Adapter, err: unknown, options: RunOptions): void {
    if (options.signal?.aborted || isFatalError(err)) return;
    const reason = err instanceof AdapterExecutionError ? err.reason : null;
    if (reason !== "quota" && reason !== "auth") {
      this.blockedStreaks.delete(adapter.name);
      return;
    }
    const streak = (this.blockedStreaks.get(adapter.name) ?? 0) + 1;
    this.blockedStreaks.set(adapter.name, streak);
    if (streak !== ADAPTER_WARNING_STREAK) return;
    const fix =
      reason === "quota"
        ? "Wait for its quota window to reset and resume the run (odw resume)"
        : `Log in to ${adapterDisplayName(adapter)} and resume the run (odw resume)`;
    options.onAdapterWarning?.({
      adapter: adapter.name,
      reason,
      streak,
      message:
        `warning: ${streak} agents in a row failed on adapter '${adapter.name}' ` +
        `(${reason === "quota" ? "usage quota" : "not logged in"}) — its other agents in this run will likely fail too. ` +
        `${fix}, or switch adapter with --adapter <name>.`,
    });
  }

  // --- internals -------------------------------------------------------------

  private composePrompt(request: AgentRequest): string {
    const parts = [INDEPENDENCE_PREAMBLE];
    // Persona (agentType) is universal prompt text — it works on every CLI,
    // which native system-prompt flags do not. See LiteralRouter.noteAgentType.
    if (request.agentType) parts.push(personaPreamble(request.agentType));
    parts.push(request.prompt);
    if (request.schema) parts.push(describeSchema(request.schema));
    return parts.join("\n\n");
  }

  private async invoke(
    adapter: Adapter,
    plan: InvocationPlan,
    prompt: string,
    limits: CliLimits,
    signal: AbortSignal | undefined,
  ): Promise<{ cli: CliResult; decoder: AdapterOutputDecoder | null }> {
    // JSONL transcripts are decoded while they stream, so only the final text
    // is retained (and a verbose session is never cut off at the stdout cap);
    // text replies are buffered by the runner under its cap, as before.
    const decoder = adapter.output?.format === "jsonl" ? new AdapterOutputDecoder(adapter) : null;
    const onStdout = decoder
      ? (chunk: string, terminate: (reason: string) => void) => {
          decoder.write(chunk);
          if (decoder.overflow) terminate(decoder.overflow);
        }
      : undefined;
    return withWorkspace(this.source, plan.workspaceMode, async (ws) => {
      let promptFile = "";
      let cleanup: (() => Promise<void>) | undefined;
      if (usesPromptFile(adapter)) {
        const dir = await mkdtemp(join(tmpdir(), "odw-prompt-"));
        promptFile = join(dir, "prompt.txt");
        await writeFile(promptFile, prompt, "utf8");
        cleanup = () => rm(dir, { recursive: true, force: true });
      }
      try {
        const context: PlaceholderContext = {
          prompt,
          prompt_file: promptFile,
          workspace: ws.path,
          source: ws.source,
          adapter: adapter.name,
          role: adapterDisplayName(adapter),
          // Option-derived tokens (the model token this phase) win over the base.
          ...plan.context,
        };
        const command = [...expandAll(adapter.command, context), ...plan.extraArgs];
        const stdin = adapter.stdin ? expand(adapter.stdin, context) : undefined;
        const env = adapter.env
          ? ({ ...process.env, ...adapter.env } as Record<string, string>)
          : undefined;
        // No ws.diff() here: agent() returns the reply, never a diff, so
        // computing one per worktree attempt was pure overhead.
        const cli = await this.runner(command, {
          stdin,
          cwd: ws.path,
          env,
          timeout: limits.timeout,
          stallTimeout: limits.stallTimeout,
          onStdout,
          signal,
        });
        return { cli, decoder };
      } finally {
        if (cleanup) await cleanup();
      }
    });
  }
}

/**
 * End an aborted call with the run's reason: a fatal error, so it propagates
 * through parallel/pipeline instead of becoming a null slot.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new RunStopped("run was stopped");
}

/** The kill limits of one CLI run, in seconds (undefined: none). */
interface CliLimits {
  timeout?: number;
  stallTimeout?: number;
}

/** The extra CLI runs a call has made so far: stall restarts and rate-limit retries. */
interface Reruns {
  stalls: number;
  rateLimits: number;
}

/**
 * Wait `ms`, or until `signal` aborts — the caller then sees the abort, so a
 * stop during a backoff ends the call at once. Not unref'd: a run waiting out
 * a rate limit is still a run in progress.
 */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    // setTimeout fires at once past 2^31-1 ms.
    const timer = setTimeout(done, Math.min(ms, 2 ** 31 - 1));
    signal?.addEventListener("abort", done, { once: true });
  });
}

function usesPromptFile(adapter: Adapter): boolean {
  const token = "{prompt_file}";
  return adapter.command.some((part) => part.includes(token)) || (adapter.stdin?.includes(token) ?? false);
}

/** Characters of the previous reply quoted back in a schema-retry prompt. */
const RETRY_EXCERPT_CHARS = 4000;

/**
 * The correction appended to a retry prompt. Each attempt is a fresh CLI run
 * with no memory of the last one, so the reply that failed is quoted back
 * (head and tail when long) along with what was wrong with it, and the agent
 * is asked to reformat it rather than redo the whole task.
 */
function retryFeedback(previous: string, problems: string[]): string {
  const listed = problems
    .slice(0, 10)
    .map((p) => `- ${p}`)
    .join("\n");
  const half = RETRY_EXCERPT_CHARS / 2;
  const quoted =
    previous.length > RETRY_EXCERPT_CHARS
      ? `${previous.slice(0, half)}\n[… ${previous.length - 2 * half} characters omitted …]\n${previous.slice(-half)}`
      : previous;
  return (
    "Your previous reply did not satisfy the required schema:\n" +
    `${listed}\n\n` +
    "Your previous reply was:\n" +
    `<<<\n${quoted}\n>>>\n\n` +
    "Reformat only: do not redo the work. Express the answer from that reply as JSON " +
    "that satisfies the schema, and return only that JSON, with no surrounding text."
  );
}

/** How a call whose CLI kept stalling failed, after `restarts` restarts. */
function stallReason(stallTimeout: number | undefined, restarts: number): string {
  const quiet = stallTimeout ? `no output for ${stallTimeout}s` : "no output";
  const again = restarts ? `, and again after ${restarts} restart${restarts === 1 ? "" : "s"}` : "";
  return `stalled — ${quiet}${again}`;
}

/** `adapter '<name>' <what happened>: <the CLI's own diagnostic>`. */
function cliFailureMessage(adapter: Adapter, cli: CliResult, what: string): string {
  const text = cli.stderr.trim() || cli.stdout.trim();
  // Keep both ends of a long diagnostic: the head usually names the error, the
  // tail holds the final message and the runner's own notes (kill reasons).
  const detail = text.length > 500 ? `${text.slice(0, 250)} … ${text.slice(-250)}` : text;
  const suffix = detail ? `: ${detail}` : "";
  return `adapter '${adapter.name}' ${what}${suffix}`;
}
