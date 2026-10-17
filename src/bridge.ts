/**
 * Execution bridge (L2): turn one `agent` call into one CLI invocation.
 *
 * Given an {@link AgentRequest} it: resolves the adapter, composes a
 * self-contained prompt (independence framing + optional schema instructions),
 * runs the adapter in its workspace (the source tree by default, a throwaway
 * git worktree when isolation is requested) with the agent's `ODW_RUN_ID`,
 * `ODW_AGENT_ID` and `ODW_PORT` in its environment, and — when a schema is requested —
 * extracts/validates the reply and retries with corrective feedback until it
 * conforms or the retry budget is spent. A CLI the stall watchdog killed for
 * going quiet is started again, up to `stallRestarts` times per call. Each
 * isolated CLI run's worktree is handed to the call's change sink before it is
 * removed, so what the agent changed can be kept (an ODW extension). What every
 * CLI run of the call prints goes to its transcript sink as it arrives, each
 * run after the first introduced with why it ran (an ODW extension).
 *
 * Every failed CLI run is classified (adapters/failures.ts). A rate-limited
 * one is ridden out: retried after an exponential backoff that honors the
 * retry-after it printed, up to `transientRetries` times per call. A spent
 * quota or a refused login is not retried; its error says what to do instead.
 * A run whose CLI reports its own failure in its output (`errorPath`: Claude
 * Code's `is_error` result, often with exit 0) is classified the same way; so
 * is one whose CLI refused the agent tool calls under a reply that claims
 * success (`deniedPath`: Claude Code's `permission_denials`) — a `permission`
 * failure. An empty reply fails the call with reason `empty_reply`, unless the
 * request allows one (ODW extensions).
 *
 * A call with `expect` checks (an ODW extension; see ./expect) has its work
 * checked once its reply satisfies the schema — an isolated run's worktree is
 * looked at before it goes. Work that missed is run again with what it missed
 * appended to the prompt, up to the checks' `retries`; then the call fails
 * with reason `unmet_expectation` and the list of misses.
 *
 * What each CLI run spent — the usage and cost its CLI reported, when its
 * adapter declares where (adapters/usage.ts) — is handed to the caller as the
 * run ends, schema retries, rate-limit retries and failed runs included.
 *
 * Every CLI run carries its permission tier's flags (an ODW extension; see
 * adapters/permissions.ts): an agent that may not have the tier it asked for,
 * or whose CLI cannot enforce it, fails with an AgentError before anything is
 * spawned. Under `agentEnv: "minimal"` the CLI starts with only the variables
 * adapters/agent-env.ts lets through.
 *
 * So does a malformed schema (an ODW extension; see adapters/native-schema.ts),
 * and — under `schemaKeywords: "strict"` — one with keywords ODW's validator
 * does not check, which otherwise the run logs once. A CLI that validates
 * schemas itself is handed the call's schema on every run — its own validated
 * value is the reply's — and ODW validates the reply all the same.
 *
 * A call may have a fallback chain (an ODW extension; see ./routing): an
 * adapter list of its own, or the `fallback` setting's for its adapter. A
 * spent quota or a refused login moves it to the next adapter that can run
 * its permission tier — a fresh prompt, the same options — and the run's
 * quota breaker takes an adapter whose quota failed `quotaBreaker` times in a
 * row out of the run, so later calls start past it.
 *
 * The command runner is injectable, so the bridge unit-tests with a fake runner
 * and no real agent account; so are the backoff's sleep, clock and jitter.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentBaseEnv } from "./adapters/agent-env.js";
import { isOnPath, resolveAdapter } from "./adapters/config.js";
import {
  backoffSeconds,
  classifyErrorReply,
  classifyFailure,
  formatSeconds,
  type FailureClass,
} from "./adapters/failures.js";
import { planPermissions, readCapableAdapter, runTier, spliceArgs, type PermissionPlan } from "./adapters/permissions.js";
import { nativeSchemaArgs, planSchema, type NativeSchemaArgs } from "./adapters/native-schema.js";
import { expand, expandAll, type PlaceholderContext } from "./adapters/placeholders.js";
import { AdapterOutputDecoder, decodeOutput, type DecodedOutput } from "./adapters/output.js";
import { runCommand, type CommandRunner } from "./adapters/runner.js";
import type { Usage } from "./adapters/usage.js";
import {
  adapterDisplayName,
  cliOk,
  type Adapter,
  type CliResult,
  type Config,
  type PermissionTier,
  type SchemaFlag,
} from "./adapters/types.js";
import {
  AdapterExecutionError,
  AgentError,
  ConfigError,
  RunStopped,
  SchemaValidationError,
  UnmetExpectationError,
  isFatalError,
} from "./errors.js";
import type { ExpectationSink } from "./expect.js";
import { PortPool } from "./ports.js";
import { LiteralRouter, type InvocationPlan, type OptionRouter } from "./router.js";
import { isAdapterChoice, type AdapterChoice } from "./routing.js";
import { describeSchema, pickStructured, type JsonSchema } from "./schema.js";
import type { AttemptReason } from "./transcript.js";
import { withWorkspace, type Workspace } from "./workspace.js";

export const INDEPENDENCE_PREAMBLE =
  "You are one agent in an automated multi-agent workflow. Work independently " +
  "on the task below. Do not ask clarifying questions and do not assume other " +
  "agents exist. Produce your result directly.";

export interface AgentRequest {
  prompt: string;
  /**
   * The adapter to run on, or — an ODW extension — a list of them in order of
   * preference: a fallback chain. Unset: the run's default (see {@link Bridge.route}).
   */
  adapter?: AdapterChoice;
  schema?: JsonSchema;
  label?: string;
  /** Select a model; routed to the adapter's declared model flag (or noted). */
  model?: string;
  /** Persona to take on; injected into the prompt (universal, every CLI). */
  agentType?: string;
  /** `"worktree"`: run this agent in a throwaway git worktree (as in Claude Code). */
  isolation?: "worktree";
  /**
   * ODW extension: run this agent at a stricter permission tier than the
   * run's (it may only lower it). Unvalidated: a bad value fails the call.
   */
  permissions?: PermissionTier;
  /** An empty reply is the answer; otherwise the call fails with reason "empty_reply" (ODW extension). */
  allowEmpty?: boolean;
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
  /**
   * The adapters the call left before `adapter`, in order, when it fell back
   * (an ODW extension): each one's quota was spent or its login refused.
   * Absent when the adapter it started on produced the value.
   */
  fellBackFrom?: string[];
  /** How many CLI calls it took on `adapter` (>1 means schema or expectation retries happened). */
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
  /** The run's id, given to every agent process (and worktree setup) as `ODW_RUN_ID`. */
  runId?: string;
  /**
   * Where a call writes the schema file of a CLI that reads its schema from
   * one (`flags.schema.mode: "file"`): the run directory's
   * `agents/<agentId>.schema.json`. Absent, it goes in a temp directory.
   */
  agentSchemaPath?: (agentId: number) => string;
}

/** What the scheduler hands one call; all optional, so a bare `run(request)` works. */
export interface RunOptions {
  /**
   * The run's abort signal. Aborting kills the CLI process (and everything it
   * started) and ends the call with the signal's reason — the run's fatal
   * error — so it propagates instead of becoming a null slot.
   */
  signal?: AbortSignal;
  /** The call's agent id (its events' `agentId`), given to its processes as `ODW_AGENT_ID`. */
  agentId?: number;
  /**
   * Called with a note on preparing the call — no port left for `ODW_PORT`, a
   * file `.worktreeinclude` left out — so the run can log it.
   */
  onNote?: (message: string) => void;
  /**
   * Called with every attempt's decoded reply as soon as it arrives — schema
   * retries included — so the run's usage tally counts all the output it paid
   * for, not just the reply that finally validated. `usage` is what that CLI
   * run reported spending, when its adapter reads usage and it reported some.
   */
  onReply?: (text: string, usage?: Usage) => void;
  /**
   * Called with what a CLI run that ended WITHOUT a reply reported spending —
   * a failed run, a rate-limited one about to be retried, a stalled one — so
   * that is counted too. Runs with a reply report theirs through `onReply`.
   */
  onUsage?: (usage: Usage) => void;
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
   * Called when a CLI run of the call starts answering, as its output
   * streams — a JSONL event past the CLI's start-up `system` events, any
   * other format's first output — so a staggered fan-out can let the agents
   * waiting on this one go (an ODW extension; see ./throttle).
   */
  onOutput?: () => void;
  /**
   * Called once when an adapter's quota or login has failed
   * {@link ADAPTER_WARNING_STREAK} calls in a row: its other agents will likely
   * fail the same way, though the run goes on (other adapters may be fine).
   */
  onAdapterWarning?: (warning: AdapterWarning) => void;
  /**
   * Keeps what an isolated agent changed (an ODW extension; see ./changes):
   * given each CLI run's worktree once the CLI has exited, before the
   * worktree is removed — not when the run was stopped — and told when each
   * attempt's last run is in.
   */
  changes?: ChangeSink;
  /**
   * Keeps what the call's CLI runs print (an ODW extension; see ./transcript):
   * told when each run starts — and why, after the first — fed its stdout and
   * stderr as they arrive, and given its result when it ends.
   */
  transcript?: TranscriptSink;
  /**
   * Where the call runs (an ODW extension): what {@link Bridge.route} decided
   * when it was dispatched — the adapter its slot and its events name.
   * Routed afresh when absent.
   */
  route?: AgentRoute;
  /**
   * Called when the call falls back to the next adapter of its chain (an ODW
   * extension) — its CLI's quota was spent or its login refused — before that
   * adapter's first CLI run, which waits until the returned promise settles:
   * the time to take a slot on the new adapter (see scheduler AgentSlot.moveTo).
   */
  onFallback?: (fallback: AdapterFallback) => void | Promise<void>;
  /**
   * Checks the call's work against its `expect` (an ODW extension; see
   * ./expect): told where the work happens before the first CLI run on each
   * adapter of its chain, given each isolated run that ended with a reply
   * before its worktree goes, and asked what the work missed once a reply
   * satisfies the schema. A miss is retried on the adapter that produced it;
   * a fallback hop to another adapter keeps the checks.
   */
  expect?: ExpectationSink;
  /** Called before work that missed its `expect` checks runs again, so the run can say so. */
  onExpectRetry?: (retry: ExpectRetry) => void;
}

/** Where the bridge reports an isolated call's worktrees: a ChangeRecorder (./changes). */
export interface ChangeSink {
  capture(ws: Workspace): Promise<void>;
  endAttempt(): Promise<void>;
  /** Keep nothing captured so far: a fallback starts the work over on another adapter. */
  discard(): Promise<void>;
  /** The next attempt starts the work over (an `expect` retry): its change supersedes the earlier ones. */
  redo?(): void;
}

/** Where the bridge reports what a call's CLI runs print: a TranscriptRecorder (./transcript). */
export interface TranscriptSink {
  /** A CLI run starts on `adapter` — after a fallback (an ODW extension), another one than before. */
  beginRun(reason?: AttemptReason, adapter?: Adapter): void;
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  endRun(cli: CliResult): void;
}

/** Where one agent() call runs (an ODW extension; see {@link Bridge.route}). */
export interface AgentRoute {
  /** The adapters it may run on, in order: its own (or the run's default) first, then its fallbacks. */
  chain: Adapter[];
  /** Its first adapter's permission plan: the tier the whole chain runs (an adapter that cannot is passed over). */
  permissions: PermissionPlan;
  /** Where in `chain` it starts: past the adapters the run's quota breaker took out; -1 when none is left. */
  start: number;
  /** Why adapters before `start` were passed over for their tier, for the run's log. */
  skipped: string[];
}

/** A call moving to the next adapter of its fallback chain (an ODW extension). */
export interface AdapterFallback {
  /** The adapter it leaves, and why: its quota is spent, or its login was refused. */
  from: string;
  reason: "quota" | "auth";
  /** The adapter it moves to. */
  to: string;
  /** Every adapter the call has left so far, in order (`from` last). */
  fellBackFrom: string[];
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

/** Work that missed its `expect` checks, about to run again with what it missed. */
export interface ExpectRetry {
  /** What it missed, one line each. */
  misses: string[];
  /** Which retry this is (1-based), and how many the call may make (`expectRetries`). */
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
  /** The run's quota breaker (an ODW extension) took the adapter out of the run: later calls skip it. */
  tripped?: boolean;
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
  private readonly runId: string | undefined;
  /** This run's agent ports: one per call in flight. */
  private readonly ports: PortPool;
  private autoPicked: Adapter | undefined;
  /** Per adapter: how many calls in a row its quota or login failed. */
  private readonly blockedStreaks = new Map<string, number>();
  private readonly agentSchemaPath: ((agentId: number) => string) | undefined;
  /** What this run has said about how schemas reach their CLIs: each note once. */
  private readonly schemaNotes = new Set<string>();
  /** Per adapter: its quota failures in a row — what the run's quota breaker counts (an ODW extension). */
  private readonly quotaStreaks = new Map<string, number>();
  /** Adapters the quota breaker took out of the run: later calls start past them. */
  private readonly tripped = new Set<string>();

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
    this.runId = options.runId;
    this.agentSchemaPath = options.agentSchemaPath;
    this.ports = new PortPool(...config.settings.portRange);
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

  /**
   * The tier an agent on `adapter` runs with, and its flags (ODW extension;
   * see adapters/permissions.ts): `option` is the call's own `permissions`.
   * A refusal's advice names an adapter that can run read-only, preferring
   * one whose CLI is installed.
   */
  permissionsFor(adapter: Adapter, option?: unknown): PermissionPlan {
    const run = runTier(this.config);
    const plan = planPermissions(adapter, run, option);
    if (!plan.error || plan.requested !== "read") return plan;
    const alternative = readCapableAdapter(this.config, adapter.name, (other) => isOnPath(other.command[0]!));
    return planPermissions(adapter, run, option, alternative);
  }

  /**
   * The adapters a call may run on, in order (an ODW extension): a list it
   * names, as it is; else the adapter it names (or the run's default) and the
   * `fallback` setting's chain for it. An adapter listed twice runs once.
   * Throws a ConfigError — fatal, like an unknown adapter — for a malformed list.
   */
  chainFor(choice?: AdapterChoice | null): Adapter[] {
    let chain: Adapter[];
    if (Array.isArray(choice)) {
      if (!isAdapterChoice(choice)) {
        throw new ConfigError(
          `agent() option adapter must be an adapter name or a non-empty list of them; got ${JSON.stringify(choice)}`,
        );
      }
      chain = choice.map((name) => resolveAdapter(this.config, name));
    } else {
      const first = this.adapterFor(choice);
      const fallback = this.config.settings.fallback ?? {};
      const next = Object.prototype.hasOwnProperty.call(fallback, first.name) ? fallback[first.name]! : [];
      chain = [first, ...next.map((name) => resolveAdapter(this.config, name))];
    }
    return chain.filter((adapter, i) => chain.findIndex((other) => other.name === adapter.name) === i);
  }

  /**
   * Where a call runs (an ODW extension): its chain (see {@link chainFor}),
   * and where in it it starts — the first adapter the run's quota breaker has
   * not taken out. Its first adapter's permission plan settles the tier the
   * whole chain runs: a later adapter that cannot run exactly that tier is
   * passed over with a note, never given another. A call its first adapter
   * may not run fails as it is (see {@link run}).
   */
  route(choice?: AdapterChoice | null, permissions?: unknown): AgentRoute {
    const chain = this.chainFor(choice);
    const plan = this.permissionsFor(chain[0]!, permissions);
    const skipped: string[] = [];
    const start = plan.error ? 0 : this.nextAdapter(chain, -1, plan.tier!, skipped);
    return { chain, permissions: plan, start, skipped };
  }

  /**
   * The first adapter of `chain` past `after` a call can move to: one the
   * quota breaker has not taken out (passed over silently: its warning said
   * so once) and — past the first — that runs `tier` exactly. Why one could
   * not goes to `skipped`. -1 when none is left.
   */
  private nextAdapter(chain: Adapter[], after: number, tier: PermissionTier, skipped: string[]): number {
    for (let i = after + 1; i < chain.length; i++) {
      const adapter = chain[i]!;
      if (this.tripped.has(adapter.name)) continue;
      if (i > 0) {
        const plan = planPermissions(adapter, runTier(this.config), tier);
        if (plan.error || plan.tier !== tier) {
          const runs = plan.tier ? ` (it would run "${plan.tier}")` : "";
          skipped.push(
            `skipped fallback '${adapter.name}': it cannot run this agent's permissions "${tier}"${runs} — ` +
              `a fallback never runs at another tier`,
          );
          continue;
        }
      }
      return i;
    }
    return -1;
  }

  async run(request: AgentRequest, options: RunOptions = {}): Promise<AgentOutcome> {
    // The agent's ids and port, the same for every CLI run (and worktree setup)
    // of the call; no other agent of the run gets the port until the call settles.
    const port = await this.ports.acquire();
    if (port === null) {
      const [first, last] = this.config.settings.portRange;
      options.onNote?.(
        `no ODW_PORT for this agent: every port of portRange [${first}, ${last}] is held by another running agent of this run`,
      );
    }
    const env: Record<string, string> = {};
    if (this.runId !== undefined) env.ODW_RUN_ID = this.runId;
    if (options.agentId !== undefined) env.ODW_AGENT_ID = String(options.agentId);
    if (port !== null) env.ODW_PORT = String(port);
    try {
      return await this.runCall(request, options, {
        env,
        onNote: options.onNote,
        changes: options.changes,
        transcript: options.transcript,
        onOutput: options.onOutput,
      });
    } finally {
      if (port !== null) this.ports.release(port);
    }
  }

  /**
   * Run the call down its route (see {@link route}): on its start adapter,
   * then — when that CLI's quota is spent or its login refused (a rate limit
   * was ridden out in place; any other failure is the call's) — on the next
   * adapter of its chain that can take it, with a fresh prompt and the same
   * options, until one produces the value or none is left. An adapter the
   * quota breaker took out while the call waited for its slot is left at
   * once, as if its quota had just failed it.
   */
  private async runCall(request: AgentRequest, options: RunOptions, call: CallEnv): Promise<AgentOutcome> {
    const route = options.route ?? this.route(request.adapter, request.permissions);
    for (const note of route.skipped) options.onNote?.(note);
    if (route.start < 0) throw this.outOfQuota(route);
    const fellBackFrom: string[] = [];
    for (let at = route.start; ; ) {
      const adapter = route.chain[at]!;
      let err: unknown = this.tripped.has(adapter.name) ? this.outOfQuota({ ...route, chain: [adapter] }) : undefined;
      if (err === undefined) {
        // A fallback runs the tier the call's first adapter settled, never another (see route()).
        const hop = at === 0 ? request : { ...request, permissions: route.permissions.tier };
        try {
          const outcome = await this.callOn(adapter, hop, options, call, fellBackFrom.length > 0 ? "fallback" : undefined);
          this.blockedStreaks.delete(adapter.name);
          this.quotaStreaks.delete(adapter.name);
          return fellBackFrom.length > 0 ? { ...outcome, fellBackFrom } : outcome;
        } catch (failure) {
          this.noteFailure(adapter, failure, options);
          err = failure;
        }
      }
      const reason = err instanceof AdapterExecutionError && !options.signal?.aborted ? err.reason : null;
      if (reason !== "quota" && reason !== "auth") throw err;
      const skipped: string[] = [];
      const next = this.nextAdapter(route.chain, at, route.permissions.tier!, skipped);
      for (const note of skipped) options.onNote?.(note);
      if (next < 0) throw err;
      fellBackFrom.push(adapter.name);
      // The next adapter starts the work over: what this one changed is not the agent's change.
      await call.changes?.discard();
      await options.onFallback?.({ from: adapter.name, reason, to: route.chain[next]!.name, fellBackFrom: [...fellBackFrom] });
      // Another CLI run: it passes the stop/budget guards first.
      await options.beforeRetry?.();
      at = next;
    }
  }

  /** Why a call cannot start: the quota breaker took out its adapters — and the rest of its chain cannot run its tier. */
  private outOfQuota(route: AgentRoute): AdapterExecutionError {
    const out = route.chain.filter((adapter) => this.tripped.has(adapter.name)).map((adapter) => `'${adapter.name}'`);
    const one = out.length === 1;
    const rest =
      out.length < route.chain.length ? `, and the rest of its chain cannot run its permissions "${route.permissions.tier}"` : "";
    return new AdapterExecutionError(
      `adapter${one ? "" : "s"} ${out.join(", ")} ${one ? "is" : "are"} out of usage quota for the rest of this run ` +
        `(the quota breaker skips ${one ? "it" : "them"})${rest} — wait for the quota window to reset and resume the run ` +
        `(odw resume), or switch adapter with --adapter <name>`,
      { reason: "quota" },
    );
  }

  private async callOn(
    adapter: Adapter,
    request: AgentRequest,
    options: RunOptions,
    shared: CallEnv,
    first?: AttemptReason,
  ): Promise<AgentOutcome> {
    const { signal } = options;
    const settings = this.config.settings;
    // The tier is settled before anything starts: an agent that may not have
    // it, or whose CLI cannot enforce it, never reaches a workspace or a process.
    const permissions = this.permissionsFor(adapter, request.permissions);
    if (permissions.error) throw new AgentError(permissions.error);
    // So is the schema (ODW extension; see adapters/native-schema.ts): a
    // malformed one never starts, nor, under "strict", one with keywords ODW
    // does not check (else logged once); a CLI that validates schemas itself
    // is handed it on every run of the call.
    const schema = request.schema ? planSchema(adapter, request.schema, settings) : undefined;
    if (schema?.error) throw new AgentError(schema.error);
    if (schema?.note && !this.schemaNotes.has(schema.note)) {
      this.schemaNotes.add(schema.note);
      shared.onNote?.(schema.note);
    }
    const schemaFile = options.agentId !== undefined ? this.agentSchemaPath?.(options.agentId) : undefined;
    const call: CallEnv = {
      ...shared,
      permissionArgs: permissions.args,
      schema: schema?.native ? { flag: schema.native, value: request.schema!, file: schemaFile } : undefined,
    };
    const limits: CliLimits = {
      timeout: adapter.timeout ?? settings.timeout ?? undefined,
      // An adapter's 0 opts it out of a run-wide stall timeout; null is off.
      stallTimeout: (adapter.stallTimeout ?? settings.stallTimeout) || undefined,
    };
    // Plan the invocation once: workspace mode, the model token/flag, and the
    // routing notes do not change across schema retries — only the prompt does.
    const plan = this.router.plan({ request, adapter, settings });
    const basePrompt = this.composePrompt(request, schema?.describe ?? false);
    const maxAttempts = request.schema ? settings.schemaRetries + 1 : 1;
    // The call's `expect` checks (ODW extension) learn where the work happens
    // before it starts; an isolated run's worktree is looked at before it goes.
    const expect = options.expect;
    if (expect) await unlessStopped(signal, () => expect.begin(plan.workspaceMode, this.source));
    const inspect =
      expect && plan.workspaceMode === "worktree"
        ? async (ws: Workspace, output: DecodedOutput): Promise<void> => {
            const empty = output.text.trim() === "" && output.structured === undefined;
            if (request.allowEmpty || !empty) await unlessStopped(signal, () => expect.inspect(ws));
          }
        : undefined;

    // Stall restarts and rate-limit retries re-run one attempt's prompt; each
    // is capped over the whole call, schema attempts included.
    const reruns: Reruns = { stalls: 0, rateLimits: 0 };
    let attempts = 0;
    // What the work missed last round, told to the next one.
    let missed = "";
    for (let round = 0; ; round++) {
      let problems: string[] = [];
      let previous = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        throwIfAborted(signal);
        if (++attempts > 1) await options.beforeRetry?.();
        const task = missed ? `${basePrompt}\n\n${missed}` : basePrompt;
        const prompt = attempt > 1 ? `${task}\n\n${retryFeedback(previous, problems)}` : task;
        // The first run on a fallback adapter says so; an `expect` retry stays on this one.
        const why = attempt > 1 ? "schema" : round > 0 ? "expect" : first;
        const { cli, output, failure } = await this.invokeUntilFinal(adapter, plan, prompt, limits, options, reruns, call, why, inspect);
        await call.changes?.endAttempt();
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

        // Stdout that did not match the adapter's declared format is the reply
        // as it stands — never a failed agent — and the run's log says why.
        if (output.fallback) call.onNote?.(output.fallback);
        const text = output.text;
        options.onReply?.(text, output.usage);
        // A CLI that exits cleanly with nothing to say did not do the task (ODW
        // extension) — unless it gave the value it validated natively.
        if (!request.allowEmpty && text.trim() === "" && output.structured === undefined) {
          throw new AdapterExecutionError(cliFailureMessage(adapter, cli, EMPTY_REPLY), { reason: "empty_reply" });
        }
        let value: unknown = text;
        if (schema) {
          // The schema steers extraction to the one candidate that satisfies it;
          // two different valid values are ambiguous and get retried, not guessed.
          // A value the CLI validated natively comes first, and is checked too.
          const pick = pickStructured(output.structured, text, schema.check);
          problems = pick.problems;
          if (problems.length > 0) {
            // A retry quotes what failed: the CLI's own value, when it gave one.
            const structured = output.structured;
            previous = structured === undefined ? text : typeof structured === "string" ? structured : JSON.stringify(structured);
            continue;
          }
          value = pick.value;
        }
        if (!expect) return { value, text, adapter: adapter.name, attempts, notes: plan.notes };

        // The work is checked, not taken at its word (ODW extension; see ./expect).
        const misses = await unlessStopped(signal, () => expect.check(text));
        if (misses.length === 0) return { value, text, adapter: adapter.name, attempts, notes: plan.notes };
        const lines = misses.map((miss) => miss.text);
        if (round >= expect.retries) {
          const after = round > 0 ? ` after ${round} ${round === 1 ? "retry" : "retries"}` : "";
          throw new UnmetExpectationError(
            `adapter '${adapter.name}' did not meet its expectations${after}: ${lines.join("; ")}`,
            lines,
          );
        }
        options.onExpectRetry?.({ misses: lines, retry: round + 1, maxRetries: expect.retries });
        // The next round starts the work over, told what this one missed.
        missed = expect.feedback(misses);
        expect.retry();
        call.changes?.redo?.();
        break;
      }
      if (problems.length > 0) {
        throw new SchemaValidationError(
          `adapter '${adapter.name}' did not satisfy the schema after ${maxAttempts} attempt(s); ` +
            `last problems: ${problems.join("; ")}`,
        );
      }
    }
  }

  /**
   * Run one prompt until its CLI run is final. A run the stall watchdog killed
   * is started again (`stallRestarts` per call); a rate-limited one is retried
   * after a backoff (`transientRetries` per call, each wait capped at
   * `maxBackoff`). Every extra run passes the stop/budget guards first, and a
   * stop during a backoff ends the wait at once. A failure that ends the loop
   * comes back classified — a clean exit whose reply is only the CLI's own
   * rate-limit, quota or login error included, as is a failure the CLI
   * reported in its output — so the caller need not read the output twice.
   * Every run decodes its output once, here; a run that ends without a reply
   * reports what it spent through `onUsage`. `why` is why the first of these
   * runs happens (a schema retry); each one after says why it ran again.
   * `inspect` is handed the workspace of a run that ended with a real reply,
   * before the workspace goes (an `expect` check; ODW extension).
   */
  private async invokeUntilFinal(
    adapter: Adapter,
    plan: InvocationPlan,
    prompt: string,
    limits: CliLimits,
    options: RunOptions,
    reruns: Reruns,
    call: CallEnv,
    why?: AttemptReason,
    inspect?: (ws: Workspace, output: DecodedOutput) => Promise<void>,
  ): Promise<{ cli: CliResult; output: DecodedOutput; failure?: FailureClass }> {
    const { signal } = options;
    const settings = this.config.settings;
    for (;;) {
      // How the run ended is judged while its workspace is still there.
      const { cli, output, failure } = await this.invoke(adapter, plan, prompt, limits, signal, call, why, async (ws, cli, decoder) => {
        // A runner that streams stdout fed the decoder and kept only a tail; an
        // injected runner that does not stream returns the whole stdout instead.
        const output = decoder?.received ? decoder.finish() : decodeOutput(adapter, cli.stdout);
        if (signal?.aborted || cli.stalled) return { cli, output };
        const failed = this.failureOf(adapter, cli, output, prompt);
        if (failed) return { cli: failed.cli, output, failure: failed.failure };
        await inspect?.(ws, output);
        return { cli, output };
      });
      if (signal?.aborted) return { cli, output };
      if (cli.stalled) {
        if (output.usage) options.onUsage?.(output.usage);
        if (reruns.stalls >= settings.stallRestarts) return { cli, output };
        reruns.stalls++;
        options.onStall?.({
          quietSeconds: limits.stallTimeout ?? 0,
          restart: reruns.stalls,
          maxRestarts: settings.stallRestarts,
        });
        why = "stall";
      } else {
        if (!failure) return { cli, output }; // a real reply
        if (output.usage) options.onUsage?.(output.usage);
        if (failure.reason !== "rate_limit" || reruns.rateLimits >= settings.transientRetries) {
          return { cli, output, failure };
        }
        const wait = backoffSeconds(reruns.rateLimits + 1, failure.retryAfter, settings.maxBackoff, this.random);
        if (wait === null) return { cli, output, failure }; // the CLI asked for longer than maxBackoff
        reruns.rateLimits++;
        options.onRateLimit?.({
          adapter: adapter.name,
          waitSeconds: wait,
          retry: reruns.rateLimits,
          maxRetries: settings.transientRetries,
        });
        await this.sleep(wait * 1000, signal);
        throwIfAborted(signal);
        why = "rate_limit";
      }
      await options.beforeRetry?.();
    }
  }

  /**
   * How a CLI run that was neither stopped nor stalled failed — its verdict,
   * and the result whose output is the evidence — or null for a real reply.
   */
  private failureOf(
    adapter: Adapter,
    cli: CliResult,
    output: DecodedOutput,
    prompt: string,
  ): { cli: CliResult; failure: FailureClass } | null {
    const classify = { patterns: adapter.failures, prompt, now: this.now() };
    // A failure the CLI reported in its output (Claude Code's `is_error`
    // result) is the verdict whatever the exit status, and its message is
    // the evidence: classified like any failure, so a rate limit is ridden
    // out and a spent quota or a login says what to do.
    if (output.error !== undefined) {
      const judged = { ...cli, stdout: output.error, stderr: "" };
      return { cli: judged, failure: classifyFailure(judged, classify) };
    }
    if (!cliOk(cli)) return { cli, failure: classifyFailure(cli, classify) };
    // A text reply — or a structured one that fell back to its raw stdout —
    // may be nothing but the CLI's own error, printed with exit 0 (Claude
    // Code's text mode does that); a decoded JSON reply is just its reply.
    const structured = (adapter.output?.format ?? "text") !== "text";
    const errorReply = !structured || output.fallback !== undefined ? classifyErrorReply(output.text, classify) : null;
    if (errorReply) return { cli, failure: errorReply };
    // A reply that claims success while the CLI refused the agent tool calls
    // (Claude Code's `permission_denials`) did the task without them.
    if (output.denied) {
      return { cli: { ...cli, stdout: `denied: ${output.denied.join("; ")}`, stderr: "" }, failure: { reason: "permission" } };
    }
    return null;
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
        return `was refused a permission it needed — allow it in the adapter's permissionArgs for its tier, ${switchAdapter}`;
      default:
        // An exit-0 run fails this way only when its CLI reported the failure in its output.
        return cli.returncode === 0 ? "reported an error" : `exited with code ${cli.returncode}`;
    }
  }

  /**
   * Count the calls an adapter's quota or login failed in a row. They are not
   * retried, and they do not end the run — other adapters may be fine — but the
   * streak reaching {@link ADAPTER_WARNING_STREAK} earns one warning: the rest
   * of that adapter's agents will likely fail the same way. Any other outcome
   * on the adapter ends the streak; a stop or a run-ending error says nothing.
   * The run's quota breaker (an ODW extension) counts quota failures alone:
   * `quotaBreaker` of them in a row take the adapter out of the run, and its
   * warning — the one — says so.
   */
  private noteFailure(adapter: Adapter, err: unknown, options: RunOptions): void {
    if (options.signal?.aborted || isFatalError(err)) return;
    const reason = err instanceof AdapterExecutionError ? err.reason : null;
    const quota = reason === "quota" ? (this.quotaStreaks.get(adapter.name) ?? 0) + 1 : 0;
    if (quota > 0) this.quotaStreaks.set(adapter.name, quota);
    else this.quotaStreaks.delete(adapter.name);
    if (reason !== "quota" && reason !== "auth") {
      this.blockedStreaks.delete(adapter.name);
      return;
    }
    const streak = (this.blockedStreaks.get(adapter.name) ?? 0) + 1;
    this.blockedStreaks.set(adapter.name, streak);
    if (this.tripQuotaBreaker(adapter, quota, options)) return;
    if (streak !== ADAPTER_WARNING_STREAK || this.tripped.has(adapter.name)) return;
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

  /**
   * The run's quota breaker (an ODW extension): the `quotaBreaker`-th quota
   * failure in a row on an adapter takes it out of the run — later calls
   * start past it in their chain, and a call with nowhere else to go fails at
   * once — and logs one warning. True when this failure tripped it.
   */
  private tripQuotaBreaker(adapter: Adapter, streak: number, options: RunOptions): boolean {
    const limit = this.config.settings.quotaBreaker;
    if (!limit || streak < limit || this.tripped.has(adapter.name)) return false;
    this.tripped.add(adapter.name);
    options.onAdapterWarning?.({
      adapter: adapter.name,
      reason: "quota",
      streak,
      tripped: true,
      message:
        `warning: ${streak} agents in a row failed on adapter '${adapter.name}' (usage quota) — the run's later agents ` +
        `skip it: each starts on the next adapter of its fallback chain, or fails at once without one. ` +
        `Wait for its quota window to reset and resume the run (odw resume), or switch adapter with --adapter <name>.`,
    });
    return true;
  }

  // --- internals -------------------------------------------------------------

  /** The call's prompt; `describe`: with its schema's description (not for a CLI handed the schema natively). */
  private composePrompt(request: AgentRequest, describe: boolean): string {
    const parts = [INDEPENDENCE_PREAMBLE];
    // Persona (agentType) is universal prompt text — it works on every CLI,
    // which native system-prompt flags do not. See LiteralRouter.noteAgentType.
    if (request.agentType) parts.push(personaPreamble(request.agentType));
    parts.push(request.prompt);
    if (request.schema && describe) parts.push(describeSchema(request.schema));
    return parts.join("\n\n");
  }

  private async invoke<T>(
    adapter: Adapter,
    plan: InvocationPlan,
    prompt: string,
    limits: CliLimits,
    signal: AbortSignal | undefined,
    call: CallEnv,
    why: AttemptReason | undefined,
    settle: (ws: Workspace, cli: CliResult, decoder: AdapterOutputDecoder | null) => Promise<T>,
  ): Promise<T> {
    // JSONL transcripts are decoded while they stream, so only the final text
    // is retained (and a verbose session is never cut off at the stdout cap);
    // text replies are buffered by the runner under its cap, as before.
    const decoder = adapter.output?.format === "jsonl" ? new AdapterOutputDecoder(adapter) : null;
    // Told once the CLI starts answering: a JSONL stream past its start-up
    // events, else its first output (see RunOptions.onOutput).
    let answering = false;
    const answered = (): void => {
      if (answering) return;
      answering = true;
      call.onOutput?.();
    };
    const onStdout = decoder
      ? (chunk: string, terminate: (reason: string) => void) => {
          decoder.write(chunk);
          if (decoder.overflow) terminate(decoder.overflow);
          if (decoder.answering) answered();
        }
      : undefined;
    const watch = !decoder && call.onOutput ? answered : undefined;
    const { worktreeSetup, worktreeSetupTimeout } = this.config.settings;
    const setup = {
      command: worktreeSetup,
      timeout: worktreeSetupTimeout,
      env: withAgentVars(process.env, call.env),
      signal,
      onNote: call.onNote,
    };
    return withWorkspace(this.source, plan.workspaceMode, async (ws) => {
      let promptFile = "";
      let cleanup: (() => Promise<void>) | undefined;
      if (usesPromptFile(adapter)) {
        const dir = await mkdtemp(join(tmpdir(), "odw-prompt-"));
        promptFile = join(dir, "prompt.txt");
        await writeFile(promptFile, prompt, "utf8");
        cleanup = () => rm(dir, { recursive: true, force: true });
      }
      let schema: NativeSchemaArgs | undefined;
      try {
        // A schema the CLI takes natively (ODW extension): inline, or in a
        // file written for this run and removed after it.
        if (call.schema) schema = await nativeSchemaArgs(call.schema.flag, call.schema.value, call.schema.file);
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
        // The tier's flags take the place of `{permission_args}`, then every
        // placeholder (theirs too) is expanded. The schema comes last, as is.
        const template = spliceArgs(adapter.command, call.permissionArgs ?? []);
        const command = [...expandAll(template, context), ...plan.extraArgs, ...(schema?.args ?? [])];
        const stdin = adapter.stdin ? expand(adapter.stdin, context) : undefined;
        const env = withAgentVars({ ...agentBaseEnv(process.env, this.config.settings), ...adapter.env }, call.env);
        // What the CLI prints is kept as it arrives (ODW extension; see ./transcript).
        const transcript = call.transcript;
        transcript?.beginRun(why, adapter);
        const cli = await this.runner(command, {
          stdin,
          cwd: ws.path,
          env,
          timeout: limits.timeout,
          stallTimeout: limits.stallTimeout,
          onStdout,
          observeStdout:
            transcript || watch
              ? (chunk) => {
                  transcript?.stdout(chunk);
                  watch?.();
                }
              : undefined,
          onStderr: transcript && ((chunk) => transcript.stderr(chunk)),
          signal,
        });
        transcript?.endRun(cli);
        // agent() returns the reply; what an isolated run changed is kept
        // beside it, before its worktree goes (ODW extension; see ./changes).
        if (call.changes && plan.workspaceMode === "worktree" && !signal?.aborted) await call.changes.capture(ws);
        // Then how the run ended is settled — while its worktree is still
        // there, for an `expect` check to look at (ODW extension; see ./expect).
        return await settle(ws, cli, decoder);
      } finally {
        if (cleanup) await cleanup();
        await schema?.cleanup();
      }
    }, setup);
  }
}

/**
 * What every CLI run of one agent call shares: its `ODW_*` variables, where
 * its notes go, what keeps its changes and its transcript, and its permission
 * tier's flags.
 */
interface CallEnv {
  env: Record<string, string>;
  onNote?: (message: string) => void;
  changes?: ChangeSink;
  transcript?: TranscriptSink;
  permissionArgs?: string[];
  /** Told when a CLI run starts answering (see RunOptions.onOutput). */
  onOutput?: () => void;
  /** The schema the CLI takes natively (ODW extension), and where its file goes in `file` mode. */
  schema?: { flag: SchemaFlag; value: JsonSchema; file?: string };
}

/** The variables an agent's processes get from ODW: only ever this call's, never inherited. */
const AGENT_VARS = ["ODW_RUN_ID", "ODW_AGENT_ID", "ODW_PORT"];

/**
 * `base` with the call's agent variables over it — and none of their values
 * from `base` (a worker started by another run's agent inherits that agent's),
 * so an agent without a port has no `ODW_PORT` rather than someone else's.
 */
function withAgentVars(base: Record<string, string | undefined>, vars: Record<string, string>): Record<string, string> {
  const env = { ...base };
  for (const name of AGENT_VARS) delete env[name];
  return { ...env, ...vars } as Record<string, string>;
}

/**
 * End an aborted call with the run's reason: a fatal error, so it propagates
 * through parallel/pipeline instead of becoming a null slot.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new RunStopped("run was stopped");
}

/**
 * Run `work`; when the run was stopped under it, end with the run's reason
 * rather than with whatever the abort made it throw (a git listing's AbortError).
 */
async function unlessStopped<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throwIfAborted(signal);
    throw err;
  }
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

/** How a call whose CLI exited cleanly with an empty reply failed. */
const EMPTY_REPLY =
  "replied with nothing — it did not answer (odw doctor --smoke checks a CLI headless); " +
  "pass allowEmpty: true if an empty reply is a valid answer";

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
