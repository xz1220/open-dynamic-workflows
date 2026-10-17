/**
 * Programming primitives (L4): the verbs a workflow author composes with.
 *
 * In the Claude Code dialect these are *injected globals*, never imported, so
 * {@link createPrimitives} builds a fresh set bound to one run's context and the
 * loader injects them into the script's scope.
 *
 *   - agent     — run one coding agent on a subtask
 *   - parallel  — fan out a batch and wait for all of it (barrier)
 *   - pipeline  — stream items through stages independently (no barrier)
 *   - phase     — label the following work for progress display
 *   - log       — surface a progress message
 *   - budget    — the run's token budget: total, output tokens spent, remaining
 *   - workflow  — run another workflow inline (one level deep)
 *   - validate  — compile-check workflow source (ODW extension)
 *   - exec      — run a command without a model (ODW extension; see exec.ts)
 *   - checkpoint — wait for a person to approve or reject (ODW extension; see
 *                  checkpoint.ts)
 *
 * `args` is not here: it is run data injected alongside these globals.
 *
 * Every completed agent() is saved as it lands, and a resumed run replays the
 * calls it already completed instead of running them again (see ./journal).
 *
 * What each agent spent travels on its agent_finished (or agent_failed) event
 * as `usage` (an ODW extension, adapters/usage.ts): what its CLI reported, or
 * — where it reported no output tokens — chars/4 of its replies, `estimated`.
 *
 * What each agent's CLI printed is kept as it runs, as the agent's transcript
 * (an ODW extension; see ./transcript) — complete before its terminal event.
 *
 * Every agent_started event carries the agent's permission tier (an ODW
 * extension, adapters/permissions.ts); an adapter that runs another tier than
 * its agents ask for is logged once per run.
 *
 * An agent runs on its adapter's own concurrency cap when it has one, and its
 * rate limits lower that cap (ODW extensions; see ./scheduler); in a
 * parallel() or pipeline() call on a prompt-caching adapter, agents sharing a
 * long prompt prefix start staggered (an ODW extension; see ./throttle).
 *
 * A phase may give its agents an adapter and a model (`meta.phases`,
 * phase(title, opts)); an agent may name a list of adapters, and fall back
 * along it — or the `fallback` setting's chain — when its CLI's quota is
 * spent or its login refused, taking a slot on each adapter it moves to; and
 * `model: "@fast"` picks a tier's model for the adapter it runs on (ODW
 * extensions; see ./routing). Its agent_finished event names the adapter that
 * produced the value, and `fellBackFrom` the ones it left.
 *
 * An agent's work is checked, not taken at its word, when its call says what
 * must hold (`expect`, an ODW extension; see ./expect): a check's command is
 * an exec() step of the run carrying the agent's id (`forAgentId`), a retry is
 * logged, and an agent that still misses fails with reason
 * "unmet_expectation" and its `misses` on agent_failed. An empty reply fails
 * with reason "empty_reply" unless the call sets `allowEmpty`. Tool calls its
 * CLI refused under a reply that stood are logged once and kept as `denied`
 * on its agent_finished event and saved record.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { formatSeconds } from "./adapters/failures.js";
import { isPermissionTier } from "./adapters/permissions.js";
import { adapterDisplayName, type Adapter, type PermissionTier } from "./adapters/types.js";
import { addUsage, estimatedUsage, type Usage } from "./adapters/usage.js";
import type { AgentRequest } from "./bridge.js";
import { branchName, ChangeRecorder, type AgentChanges, type KeptChanges } from "./changes.js";
import { CheckpointTimeout, createCheckpoint, type CheckpointOptions, type CheckpointResult } from "./checkpoint.js";
import { spentTokens, type RunContext } from "./context.js";
import { AdapterExecutionError, UnmetExpectationError, WorkflowScriptError, isFatalError } from "./errors.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, LOG, PHASE_STARTED, event } from "./events.js";
import { ExecError, createExec, execStep, type ExecOptions, type ExecResult } from "./exec.js";
import { Expectations, planChecks, type AgentChecks, type ExpectOptions } from "./expect.js";
import { resumeKey, type AgentResultRecord } from "./journal.js";
// Value import of the loader is safe: loader.ts only type-imports from here, so
// the module cycle is erased at compile time and never exists at runtime.
import { loadWorkflowScript, scanDualCompat, type WorkflowMeta } from "./loader.js";
import { firstAdapter, phaseDefaultsOf, type AdapterChoice, type PhaseDefaults } from "./routing.js";
import type { JsonSchema } from "./schema.js";
import { FanOut } from "./throttle.js";
import { TranscriptRecorder } from "./transcript.js";
import { resolveWorkflow } from "./workflows/resolve.js";

export interface AgentOptions {
  /**
   * Which configured adapter/CLI to use; falls back to the phase's default
   * (ODW extension), then the run's. ODW extension: a list of adapters, in
   * order of preference — a fallback chain (see ./routing).
   */
  adapter?: AdapterChoice;
  /** When set, the reply is validated against it and returned as an object. */
  schema?: JsonSchema;
  /** Short label for progress display. */
  label?: string;
  /** Override the current phase for this one call (use inside parallel/pipeline). */
  phase?: string;
  /**
   * Select a model; routed to the adapter's declared model flag (else logged).
   * ODW extension: `"@<tier>"` picks the adapter's model of a `models` tier,
   * and a phase may give a default.
   */
  model?: string;
  /** Persona to take on; injected into the prompt so it works on every CLI. */
  agentType?: string;
  /** `"worktree"`: run this agent in a throwaway git worktree (as in Claude Code). */
  isolation?: "worktree";
  /**
   * ODW extension: also commit an isolated agent's change to a branch
   * `odw/<runId>/<agentId>-<label>` of the source repository; `false` opts
   * one agent out of the `keepBranches` setting. No effect without isolation.
   */
  keep?: boolean;
  /**
   * ODW extension: run this agent at a stricter permission tier than the
   * run's — `"read"` for research and review. It may only lower the tier
   * (read < edit < full): asking for more than the run allows fails the call.
   */
  permissions?: PermissionTier;
  /**
   * ODW extension: what must hold once the agent replied — files changed (or
   * not), files matching globs changed or created, a command exiting 0 in its
   * workspace, the reply matching a regular expression. See ./expect.
   */
  expect?: ExpectOptions;
  /** ODW extension: retries of work that missed `expect`, told what it missed (else the `expectRetries` setting). */
  expectRetries?: number;
  /** ODW extension: an empty reply is the answer, not an "empty_reply" failure. */
  allowEmpty?: boolean;
}

export interface Budget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export type Thunk<T> = () => Promise<T> | T;
export type Stage = (previous: unknown, item: unknown, index: number) => unknown;

/** What `validate(source)` reports about a candidate workflow script. */
export interface ValidationReport {
  /** True when the source compiles as a workflow (meta extracted, body wraps). */
  ok: boolean;
  /** The compiled meta, when ok. */
  meta?: WorkflowMeta;
  /** Compile errors (empty when ok). */
  errors: string[];
  /** Dual-compat advisories (Date.now etc.) — ODW runs them, Claude Code won't. */
  warnings: string[];
}

/** The surface injected into a workflow script (alongside `args`). */
export interface WorkflowGlobals {
  agent(prompt: string, opts?: AgentOptions): Promise<unknown>;
  parallel<T>(thunks: Array<Thunk<T>>): Promise<Array<T | null>>;
  pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]>;
  /** ODW extension: `opts` gives the phase's agents an adapter and a model (see ./routing). */
  phase(title: string, opts?: PhaseDefaults): void;
  log(message: unknown): void;
  budget: Budget;
  workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<unknown>;
  /**
   * Compile-check a candidate workflow source without executing it (ODW
   * extension; not part of Claude Code's Workflow tool surface). The seam that
   * lets a workflow generate and verify other workflows.
   */
  validate(source: string): ValidationReport;
  /**
   * Run a command without launching a model (ODW extension; not part of
   * Claude Code's Workflow tool surface): a string through the shell, an
   * array as argv. See exec.ts for the contract.
   */
  exec(command: string | string[], opts?: ExecOptions): Promise<ExecResult>;
  /**
   * Wait for a person to approve or reject before the run goes on (ODW
   * extension; not part of Claude Code's Workflow tool surface). See
   * checkpoint.ts for the contract.
   */
  checkpoint(title: string, opts?: CheckpointOptions): Promise<CheckpointResult>;
}

/**
 * Build the injected primitive set bound to a single run's context. `phases`
 * is the workflow's `meta.phases`: the defaults its entries give their
 * phases' agents (an ODW extension) hold from the start.
 */
export function createPrimitives(
  ctx: RunContext,
  internal: { depth?: number; phasePrefix?: string; phases?: WorkflowMeta["phases"] } = {},
): WorkflowGlobals {
  const depth = internal.depth ?? 0;
  const phasePrefix = internal.phasePrefix ?? "";
  // Adapters whose permissions note the run has logged: once per adapter per
  // run, shared with nested workflow()s (their contexts are copies of this one).
  const notedPermissions = (ctx.permissionNotes ??= new Set<string>());
  // Each phase's defaults for its agents (ODW extension), by its (prefixed)
  // title — shared with nested workflow()s like the notes above.
  const phaseDefaults = (ctx.phaseDefaults ??= new Map<string, PhaseDefaults>());
  for (const [i, entry] of (internal.phases ?? []).entries()) {
    if (entry === null || typeof entry !== "object" || typeof entry.title !== "string") continue;
    const defaults = phaseDefaultsOf(entry, `meta.phases[${i}]`);
    const title = phasePrefix + entry.title;
    if (defaults.adapter !== undefined || defaults.model !== undefined) phaseDefaults.set(title, defaults);
    else phaseDefaults.delete(title);
  }

  /**
   * Save a completed agent's record before its agent_finished event, so an
   * observer that sees the event can read the result, and a run that stalls
   * or dies later still has it. Events only reference results (`saved`),
   * never carry them. Saving never fails the agent: an error is logged.
   */
  const save = (rec: AgentResultRecord): boolean => {
    if (!ctx.saveAgentResult) return false;
    try {
      ctx.saveAgentResult(rec);
      return true;
    } catch (err) {
      ctx.emit(
        event(LOG, {
          message: `could not save the result of agent ${rec.agentId}: ${err instanceof Error ? err.message : String(err)}`,
          label: rec.label,
          phase: rec.phase,
        }),
      );
      return false;
    }
  };

  /**
   * `odw resume`: a call the resumed run already completed returns a copy of
   * its saved value at once. It takes no scheduler slot and adds nothing to
   * the dispatch count or the budget, but it shows like any agent — started
   * and finished events and a saved record, all marked `cached` — so a
   * resume of this run can replay it in turn.
   */
  const replay = async (
    agentId: number,
    key: string,
    recorded: AgentResultRecord,
    opts: AgentOptions,
    phase: string | null,
  ): Promise<unknown> => {
    // Once the run has ended, every later call fails with its reason.
    if (ctx.scheduler.fatalError !== undefined) throw ctx.scheduler.fatalError;
    const label = opts.label ?? firstAdapter(opts.adapter) ?? opts.agentType ?? recorded.label;
    const { adapter, attempts } = recorded;
    // Where the value came from, fallbacks included (ODW extension) — a replay walks no chain.
    const moved = fallbackField(recorded.fellBackFrom);
    const marks = {
      cached: true,
      // The run whose agent actually produced the value, across chained resumes.
      sourceRunId: recorded.cached && recorded.sourceRunId ? recorded.sourceRunId : ctx.replay!.sourceRunId,
    };
    // The tier the value was produced at, when the record says (ODW extension).
    const tier = permissionField(recorded.permissions);
    const startedEv = event(AGENT_STARTED, { agentId, label, phase, adapter, ...tier, ...marks });
    ctx.emit(startedEv);
    const kept = await carryChanges(recorded, agentId, (message) =>
      ctx.emit(event(LOG, { message: `${label}:${agentId}: ${message}`, agentId, label, phase })),
    );
    // What its CLI refused when the value was produced travels with it (ODW extension).
    const denied = deniedField(recorded.denied);
    const changed = changeFields(kept);
    const finished = event(AGENT_FINISHED, { agentId, label, phase, adapter, ...moved, attempts, ...marks, ...changed, ...denied });
    const startedAt = startedEv.ts;
    const finishedAt = finished.ts;
    const value = recorded.value;
    if (save({ agentId, key, label, phase, adapter, ...moved, attempts, startedAt, finishedAt, value, ...tier, ...marks, ...changed, ...denied })) {
      finished.saved = true;
    }
    ctx.emit(finished);
    return structuredClone(recorded.value);
  };

  /**
   * A replayed isolated call brings its kept change along (ODW extension): the
   * source run's diff is copied into this run, so `odw diff`, `odw apply` and
   * the dashboard find it here. Its branch, if it had one, is the source run's.
   */
  const carryChanges = async (
    recorded: AgentResultRecord,
    agentId: number,
    note: (message: string) => void,
  ): Promise<KeptChanges | null> => {
    const from = ctx.replay?.sourceDiffPath;
    if (!recorded.changes || !from || !ctx.agentDiffPath) return null;
    try {
      const to = ctx.agentDiffPath(agentId);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from(recorded.agentId), to);
      return { changes: recorded.changes, branch: recorded.branch ?? null };
    } catch (err) {
      note(`could not bring its kept change along: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  /**
   * What keeps an isolated agent's change (ODW extension; see ./changes) —
   * only in a persisted run, where its diff has somewhere to go. `keep`
   * (else the `keepBranches` setting) also commits it to a branch.
   */
  const changeRecorder = (
    agentId: number,
    label: string,
    opts: AgentOptions,
    signal: AbortSignal,
    note: (message: string) => void,
  ): ChangeRecorder | undefined => {
    if (opts.isolation !== "worktree" || !ctx.agentDiffPath) return undefined;
    const { keepBranches, maxDiffBytes } = ctx.config.settings;
    const runId = ctx.runId ?? "run";
    const keep = typeof opts.keep === "boolean" ? opts.keep : keepBranches;
    return new ChangeRecorder({
      path: ctx.agentDiffPath(agentId),
      maxDiffBytes,
      branch: keep ? branchName(runId, agentId, label) : null,
      message: `${label}\n\nodw run ${runId}, agent ${agentId}`,
      signal,
      onNote: note,
    });
  };

  /**
   * What keeps an agent's transcript as it runs (ODW extension; see
   * ./transcript) — only in a persisted run, and unless `maxTranscriptBytes`
   * is 0. A JSONL adapter's events are kept as they come; anything else as text.
   */
  const transcriptRecorder = (
    agentId: number,
    adapter: Adapter,
    note: (message: string) => void,
  ): TranscriptRecorder | undefined => {
    const maxBytes = ctx.config.settings.maxTranscriptBytes;
    if (!ctx.agentTranscriptPaths || !maxBytes) return undefined;
    return new TranscriptRecorder({
      ...ctx.agentTranscriptPaths(agentId),
      format: adapter.output?.format === "jsonl" ? "jsonl" : "text",
      maxBytes,
      onNote: note,
    });
  };

  /**
   * What checks a call's work against its `expect` (ODW extension; see
   * ./expect). Its command runs as an exec() step of the run — in the agent's
   * phase, carrying the agent's id — so it shows under the agent and a stop
   * kills it.
   */
  const expectations = (
    checks: AgentChecks,
    agentId: number,
    label: string,
    phase: string | null,
    signal: AbortSignal,
  ): Expectations | undefined => {
    if (!checks.expect) return undefined;
    const retries = checks.expectRetries ?? ctx.config.settings.expectRetries ?? 1;
    return new Expectations(checks.expect, retries, {
      signal,
      // ODW writes the run's directory while the agent works: never its change.
      ignore: ctx.runDir ? [ctx.runDir] : [],
      exec: (command, opts) =>
        execStep(
          ctx,
          command,
          { ...opts, label: `${label}: expect`, env: { ODW_AGENT_ID: String(agentId) } },
          // The agent's own phase (null included), whatever the script's is by now.
          { phase, forAgentId: agentId },
        ),
    });
  };

  /** Settle a call's kept change, or drop it when the run ended under the call. Never throws. */
  const keepChanges = async (
    recorder: ChangeRecorder | undefined,
    drop: boolean,
    note: (message: string) => void,
  ): Promise<KeptChanges | null> => {
    if (!recorder) return null;
    try {
      if (!drop) return await recorder.settle();
      await recorder.discard();
    } catch (err) {
      note(`could not keep what it changed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  };

  const dispatch = async (prompt: string, opts: AgentOptions): Promise<unknown> => {
    // The output checks a call asks for are checked before anything starts:
    // a misuse is a recoverable error that costs no dispatch (ODW extension).
    const checks = planChecks(opts);
    const activePhase = opts.phase !== undefined ? opts.phase : ctx.currentPhase;
    // Stable per-dispatch identity. Events for THIS dispatch all carry it, so
    // observers pair started/finished exactly even when several concurrent
    // agents share a label+phase (the pre-agentId pairing was heuristic).
    const agentId = ++ctx.seq.value;
    // What a resume matches this call by; saved with its result. The call's
    // own options only: a phase's defaults stay out of it (see ./journal).
    const key = resumeKey(prompt, opts);
    const recorded = ctx.replay?.take(key);
    if (recorded) return replay(agentId, key, recorded, opts, activePhase);
    // The adapter and model its phase gives a call that names neither (ODW extension).
    const defaults = activePhase !== null ? phaseDefaults.get(activePhase) : undefined;
    const adapterChoice = opts.adapter ?? defaults?.adapter;
    const model = opts.model ?? defaults?.model;
    // Adapter selection honours ONLY opts.adapter (or its phase's default).
    // agentType is a persona (it is forwarded to the bridge and injected into
    // the prompt), never an adapter name. Resolve it before asking for a slot:
    // an unknown or ambiguous adapter is a (fatal) config error that must not
    // consume a dispatch or show an agent that never ran as running. The call
    // starts on the first adapter of its chain (ODW extension) the run's
    // quota breaker has not taken out.
    const route = ctx.bridge.route(adapterChoice, opts.permissions);
    const adapter = route.chain[Math.max(0, route.start)]!;
    const display = opts.label ?? firstAdapter(opts.adapter) ?? opts.agentType ?? adapter.name;
    // The agent's permission tier, for its events and the run's log — its
    // first adapter's, which every fallback runs too. The bridge enforces it:
    // an agent that may not have its tier, or whose CLI cannot enforce it,
    // fails before it starts.
    const permissions = route.permissions;
    // A staggered fan-out (ODW extension): in a parallel() or pipeline() call,
    // an agent on a prompt-caching adapter whose prompt shares a long prefix
    // with an earlier one's — on the same model and persona, so the same
    // cache — waits, holding no slot, until that one has warmed the cache.
    const fanOut = adapter.promptCache && typeof prompt === "string" ? fanOutScope.getStore() : undefined;
    const cache = [adapter.name, model ?? "", opts.agentType ?? ""].join("\u0000");
    const turn = fanOut?.enter(adapter.name, cache, prompt);
    const request: AgentRequest = {
      prompt,
      adapter: adapterChoice,
      schema: opts.schema,
      label: opts.label,
      model,
      agentType: opts.agentType,
      isolation: opts.isolation,
      permissions: opts.permissions,
      ...(checks.allowEmpty ? { allowEmpty: true } : {}),
    };
    // The adapters it left down its chain, and the one it is on (ODW extension).
    const fellBackFrom: string[] = [];
    let onAdapter = adapter.name;
    /** A failed agent's `adapter` and `fellBackFrom` when it fell back: the adapter its last CLI ran on. */
    const movedFields = (): { adapter?: string; fellBackFrom?: string[] } =>
      fellBackFrom.length > 0 ? { adapter: onAdapter, fellBackFrom: [...fellBackFrom] } : {};
    // What this call spends, from every CLI run it makes: the usage the CLI
    // reported, plus the characters of replies it reported no output tokens for.
    let reported: Usage | undefined;
    let estimatedChars = 0;
    const spend = (usage: Usage | undefined, reply?: string): void => {
      reported = addUsage(reported, usage);
      // The run's budget tally: real output tokens when reported, else chars/4.
      if (usage?.outputTokens !== undefined) ctx.usage.outputTokens += usage.outputTokens;
      else if (reply !== undefined) {
        estimatedChars += reply.length;
        ctx.usage.outputChars += reply.length;
      }
    };
    /** This agent's `usage` event field: absent when it spent nothing anyone can tell. */
    const usageField = (): { usage?: Usage } => {
      const usage = estimatedChars > 0 ? addUsage(reported, estimatedUsage(estimatedChars)) : reported;
      return usage ? { usage } : {};
    };
    const failed = (err: unknown, kept: KeptChanges | null = null): void => {
      ctx.emit(
        event(AGENT_FAILED, {
          agentId,
          label: display,
          phase: activePhase,
          error: String(err),
          ...failureFields(err),
          ...movedFields(),
          ...usageField(),
          ...changeFields(kept),
        }),
      );
      if (typeof err === "object" && err !== null) surfaced.add(err);
    };
    let started = false;
    try {
      // Everything an agent records — its terminal event, its usage — happens
      // while it holds its slot: once runAgent settles, the agent is fully
      // accounted for (the run's drain relies on it), and the next queued
      // dispatch sees the updated budget.
      return await ctx.scheduler.runAgent(async (signal, slot) => {
        // Record the adapter only once the scheduler has handed out a real
        // dispatch slot, so queued work is not presented as running.
        started = true;
        turn?.started();
        const startedEv = event(AGENT_STARTED, {
          agentId,
          label: display,
          phase: activePhase,
          adapter: adapter.name,
          ...permissionField(permissions.tier ?? permissions.requested),
        });
        ctx.emit(startedEv);
        // An adapter that runs another tier than asked, or one ODW cannot
        // enforce on it, is said once per run — never silently. (The plan is
        // the chain's first adapter's: see ./routing.)
        const planned = route.chain[0]!.name;
        if (permissions.note && !notedPermissions.has(planned)) {
          notedPermissions.add(planned);
          ctx.emit(event(LOG, { message: permissions.note, adapter: planned, ...permissionField(permissions.tier) }));
        }
        // What preparing the call noted (no free port, a file .worktreeinclude
        // left out) and what keeping its change did not manage is logged against it.
        const note = (message: string): void =>
          ctx.emit(event(LOG, { message: `${display}:${agentId}: ${message}`, agentId, label: display, phase: activePhase }));
        if (opts.keep === true && opts.isolation !== "worktree") {
          note('keep: true has no effect without isolation: "worktree" — this agent works in the source tree');
        }
        const changes = changeRecorder(agentId, display, opts, signal, note);
        const transcript = transcriptRecorder(agentId, adapter, note);
        const expect = expectations(checks, agentId, display, activePhase, signal);
        let outcome;
        try {
          outcome = await ctx.bridge.run(request, {
            signal,
            // The agent process's ODW_AGENT_ID.
            agentId,
            onNote: note,
            // Feed the shared budget tally and this agent's usage from every
            // CLI run: replies (schema retries included), and runs that failed
            // or were retried but still reported what they spent.
            onReply: (text, usage) => spend(usage, text),
            onUsage: (usage) => spend(usage),
            // A retry is another CLI run: it passes the stop/budget guards first.
            beforeRetry: () => ctx.scheduler.recheck(),
            // The stall watchdog (opt-in) restarts a CLI that went quiet: say so.
            onStall: ({ quietSeconds, restart, maxRestarts }) =>
              ctx.emit(
                event(LOG, {
                  message: `${display}:${agentId} went quiet for ${quietSeconds}s — restarting (${restart}/${maxRestarts})`,
                  agentId,
                  label: display,
                  phase: activePhase,
                }),
              ),
            // A rate-limited CLI is retried after a backoff: say so, and for how long.
            onRateLimit: ({ adapter: name, waitSeconds, retry, maxRetries }) => {
              ctx.emit(
                event(LOG, {
                  message: `${display}:${agentId} hit a rate limit on ${name} — retrying in ${formatSeconds(waitSeconds)} (${retry}/${maxRetries})`,
                  agentId,
                  label: display,
                  phase: activePhase,
                }),
              );
              // Adaptive back-pressure (ODW extension): the limit lowers its adapter's cap.
              slot.rateLimited();
            },
            // A staggered fan-out's held agents go once this one's CLI answers (ODW extension).
            onOutput: turn?.output,
            // An adapter's quota or login failed several agents in a row: warn, once —
            // and say so when the run's quota breaker took it out (ODW extension).
            onAdapterWarning: ({ message, adapter: name, reason, tripped }) =>
              ctx.emit(
                event(LOG, {
                  message,
                  adapter: name,
                  reason,
                  ...(tripped ? { tripped: true } : {}),
                  agentId,
                  label: display,
                  phase: activePhase,
                }),
              ),
            // An isolated agent's change is kept as it lands (ODW extension).
            changes,
            // So is what its CLI prints (ODW extension).
            transcript,
            // Where it runs, as routed at dispatch: the adapter its slot is on (ODW extension).
            route,
            // A spent quota or a refused login moved it down its chain (ODW
            // extension): say so — the line also moves it, for every reader of
            // the run (runtime/runs-view) — and take a slot on the new adapter,
            // the old one's let go first.
            onFallback: async ({ from, reason, to }) => {
              fellBackFrom.push(from);
              onAdapter = to;
              ctx.emit(
                event(LOG, {
                  message: `${display}:${agentId} → ${to} after ${from} ${reason}`,
                  agentId,
                  label: display,
                  phase: activePhase,
                  adapter: to,
                  fellBackFrom: [...fellBackFrom],
                  reason,
                }),
              );
              await slot.moveTo(to);
            },
            // Its work is checked against its `expect` (ODW extension), and a
            // miss that earns a retry is logged with what it missed.
            expect,
            onExpectRetry: ({ misses, retry, maxRetries }) =>
              ctx.emit(
                event(LOG, {
                  message:
                    `${display}:${agentId} did not meet its expectations — running it again, told what it missed ` +
                    `(${retry}/${maxRetries}): ${misses.join("; ")}`,
                  misses,
                  agentId,
                  label: display,
                  phase: activePhase,
                }),
              ),
          });
        } catch (err) {
          // Out of rate-limit retries (or allowed none): that lowers its adapter's cap too.
          if (err instanceof AdapterExecutionError && err.reason === "rate_limit") slot.rateLimited();
          // A started agent always gets a terminal event, even when the error
          // is fatal (stop, budget, a config error raised inside the slot) —
          // else observers show it running forever. A failed agent's change
          // is kept too (the work of one that timed out); a stop keeps none.
          // Its transcript is kept either way, complete before the event.
          await transcript?.close();
          failed(err, await keepChanges(changes, isFatalError(err) || signal.aborted, note));
          throw err;
        }
        await transcript?.close();
        const kept = await keepChanges(changes, false, note);
        // No option is dropped silently: surface each routing note as a LOG event
        // (visible in `odw logs` and the dashboard).
        for (const routing of outcome.notes ?? []) {
          ctx.emit(event(LOG, { message: routing, label: display, phase: activePhase }));
        }
        // Tool calls its CLI refused under a reply that stands (ODW extension):
        // said once, and kept with the agent — its work may lack them.
        if (outcome.denied?.length) {
          ctx.emit(
            event(LOG, {
              message: refusedNote(`${display}:${agentId}`, adapterDisplayName(adapter), outcome.denied),
              denied: outcome.denied,
              agentId,
              label: display,
              phase: activePhase,
            }),
          );
        }
        const finished = event(AGENT_FINISHED, {
          agentId,
          label: display,
          phase: activePhase,
          adapter: outcome.adapter,
          ...fallbackField(outcome.fellBackFrom),
          attempts: outcome.attempts,
          ...usageField(),
          ...changeFields(kept),
          ...deniedField(outcome.denied),
        });
        const persisted = save({
          agentId,
          key,
          label: display,
          phase: activePhase,
          adapter: outcome.adapter,
          ...fallbackField(outcome.fellBackFrom),
          attempts: outcome.attempts,
          startedAt: startedEv.ts,
          finishedAt: finished.ts,
          value: outcome.value,
          ...permissionField(permissions.tier),
          ...changeFields(kept),
          ...deniedField(outcome.denied),
        });
        if (persisted) finished.saved = true;
        ctx.emit(finished);
        return outcome.value;
      }, { adapter: adapter.name, gate: turn?.gate });
    } catch (err) {
      // A fatal error before the start (stop or budget at dispatch) concerns
      // the run, not this agent; anything else is still this agent's failure.
      if (!started && !isFatalError(err)) failed(err);
      throw err;
    } finally {
      // However a leader of a staggered fan-out ended, the agents it held may go.
      turn?.settled();
    }
  };

  const agent = (prompt: string, opts: AgentOptions = {}): Promise<unknown> =>
    dispatch(prompt, opts).catch((err: unknown) => {
      // A fatal error ends the run wherever it arose — in the slot or before
      // it (an unknown adapter): the scheduler records it as the outcome and
      // aborts the agents still running.
      if (isFatalError(err)) ctx.scheduler.abort(err);
      throw err;
    });

  /**
   * gather turns a recoverable failure into a `null` slot; never let one vanish
   * silently. Agent failures already have their AGENT_FAILED event; anything
   * else (a TypeError in a stage, a misused primitive) gets a LOG event.
   */
  const noteSwallowed = (err: unknown, where: string): void => {
    if (isFatalError(err)) return; // propagates out of gather; nothing is swallowed
    if (typeof err === "object" && err !== null && surfaced.has(err)) return;
    if (err instanceof ExecError) return; // its command_failed event reported it
    if (err instanceof CheckpointTimeout) return; // its checkpoint_resolved event reported it
    ctx.emit(event(LOG, { message: `${where} failed and its result is null: ${describeError(err)}` }));
  };

  /**
   * One LOG event — a warning, never a block — when a single parallel() or
   * pipeline() call fans out wider than `fanOutWarn` (an ODW extension, after
   * Claude Code's warning before a large workflow): every one of those agents
   * spends tokens, and nothing else says how many are on their way.
   */
  const warnFanOut = (call: "parallel()" | "pipeline()", width: number, stages = 0): void => {
    const limit = ctx.config.settings.fanOutWarn;
    if (!limit || width <= limit) return;
    const what = call === "parallel()" ? `${width} tasks` : `${width} items through ${stages} stage${stages === 1 ? "" : "s"}`;
    ctx.emit(
      event(LOG, {
        message:
          `large fan-out: ${call} starts ${what} (over fanOutWarn: ${limit}) — each agent spends tokens; ` +
          "odw status shows what the run has spent, odw run --budget caps it",
        fanOut: width,
      }),
    );
  };

  /**
   * Run one parallel() or pipeline() call's batch as one fan-out, which every
   * agent() its thunks or stages call — through any await — belongs to: on a
   * prompt-caching adapter, its agents may start staggered (an ODW extension;
   * see ./throttle). A nested parallel() or pipeline() is a fan-out of its own.
   */
  const asFanOut = <T>(batch: () => Promise<T>): Promise<T> => {
    const stagger = ctx.config.settings.staggerFanOut;
    if (!stagger) return batch();
    const fanOut = new FanOut(stagger, ctx.scheduler.signal, (message, fields) =>
      ctx.emit(event(LOG, { message, ...fields })),
    );
    return fanOutScope.run(fanOut, batch);
  };

  const parallel = async <T>(thunks: Array<Thunk<T>>): Promise<Array<T | null>> => {
    if (!Array.isArray(thunks)) {
      throw new WorkflowScriptError(`parallel() takes an array of functions (thunks); got ${describeValue(thunks)}`);
    }
    thunks.forEach((thunk, i) => {
      if (typeof thunk !== "function") {
        throw new WorkflowScriptError(
          `parallel() takes functions (thunks), but element ${i} is ${describeValue(thunk)} — ` +
            "wrap each call as () => agent(...) so parallel() can schedule it",
        );
      }
    });
    warnFanOut("parallel()", thunks.length);
    return asFanOut(() => ctx.scheduler.gather(
      thunks.map((thunk, i) => async () => {
        try {
          return await thunk();
        } catch (err) {
          noteSwallowed(err, `parallel() thunk ${i}`);
          throw err;
        }
      }),
    ));
  };

  const pipeline = async (items: unknown[], ...stages: Stage[]): Promise<unknown[]> => {
    if (!Array.isArray(items)) {
      throw new WorkflowScriptError(
        `pipeline() takes an array of items, then stage functions; got ${describeValue(items)} as the items`,
      );
    }
    stages.forEach((stage, i) => {
      if (typeof stage !== "function") {
        throw new WorkflowScriptError(
          `pipeline() stages must be functions (previous, item, index) => …; stage ${i} is ${describeValue(stage)}`,
        );
      }
    });
    warnFanOut("pipeline()", items.length, stages.length);
    const chains = items.map((item, index) => async (): Promise<unknown> => {
      let value: unknown = item;
      let s = 0;
      try {
        for (; s < stages.length; s++) value = await stages[s]!(value, item, index);
      } catch (err) {
        noteSwallowed(err, `pipeline() item ${index} at stage ${s}`);
        throw err;
      }
      return value;
    });
    return asFanOut(() => ctx.scheduler.gather(chains) as Promise<unknown[]>);
  };

  const phase = (title: string, opts?: PhaseDefaults): void => {
    const labelled = phasePrefix + title;
    // Defaults for the phase's agents (ODW extension), in place of its
    // meta.phases entry's; phase(title) alone keeps whatever it has.
    if (opts != null) {
      phaseDefaults.set(labelled, phaseDefaultsOf(opts, `phase(${JSON.stringify(title)}) options`, { strict: true }));
    }
    ctx.currentPhase = labelled;
    ctx.emit(event(PHASE_STARTED, { phase: labelled }));
  };

  const log = (message: unknown): void => {
    ctx.emit(event(LOG, { message: String(message) }));
  };

  const budget: Budget = {
    total: ctx.budgetTotal,
    // Output tokens: reported by the CLI, else chars/4 of the reply — see RunContext.usage.
    spent: () => spentTokens(ctx.usage),
    remaining: () =>
      ctx.budgetTotal === null ? Infinity : Math.max(0, ctx.budgetTotal - spentTokens(ctx.usage)),
  };

  /**
   * Run another workflow inline as a sub-step (Claude Code parity, one level
   * deep). The child shares this run's scheduler (concurrency cap + agent
   * counter), control, budget tally, and event sink; its phases are labelled
   * `▸ <name> · <phase>` so its agents group as their own lanes in the DAG.
   */
  const workflow = async (
    nameOrRef: string | { scriptPath: string },
    childArgs?: unknown,
  ): Promise<unknown> => {
    if (depth >= 1) {
      throw new WorkflowScriptError(
        "workflow() inside a child workflow is not supported — nesting is one level deep",
      );
    }
    let scriptPath: string;
    if (typeof nameOrRef === "string") {
      scriptPath = resolveWorkflow(nameOrRef, { cwd: ctx.source, config: ctx.config }).scriptPath;
    } else if (nameOrRef && typeof nameOrRef.scriptPath === "string") {
      scriptPath = resolve(ctx.source, nameOrRef.scriptPath);
    } else {
      throw new WorkflowScriptError("workflow() expects a name or { scriptPath }");
    }
    let text: string;
    try {
      text = readFileSync(scriptPath, "utf8");
    } catch (err) {
      throw new WorkflowScriptError(
        `workflow(): cannot read ${scriptPath}: ${(err as Error).message}`,
      );
    }
    const loaded = loadWorkflowScript(text, scriptPath); // throws on a syntax error
    const name = loaded.meta.name;
    const entryLane = `▸ ${name}`;
    // The child gets its own phase cursor (so a concurrent parent agent keeps
    // its label) but shares everything that costs or controls: scheduler,
    // bridge, sink, control, and the usage tally.
    const childCtx: RunContext = { ...ctx, currentPhase: entryLane };
    const childGlobals = createPrimitives(childCtx, {
      depth: depth + 1,
      phasePrefix: `▸ ${name} · `,
      phases: loaded.meta.phases,
    });
    ctx.emit(event(LOG, { message: `▸ entering workflow ${name} (${scriptPath})` }));
    // Open the child's entry lane as a real phase, so a child that dispatches
    // agents BEFORE its first phase() call (phases are optional) renders them in
    // its own lane rather than inheriting the parent's current phase. A child
    // that does call phase() immediately just adds its named lanes after this.
    ctx.emit(event(PHASE_STARTED, { phase: entryLane }));
    const result = await loaded.run(childGlobals, childArgs ?? null);
    ctx.emit(event(LOG, { message: `▸ workflow ${name} returned` }));
    return result;
  };

  const validate = (source: string): ValidationReport => {
    if (typeof source !== "string") {
      return { ok: false, errors: ["validate() expects a string of workflow source"], warnings: [] };
    }
    try {
      const loaded = loadWorkflowScript(source, "candidate.js");
      return { ok: true, meta: loaded.meta, errors: [], warnings: scanDualCompat(source) };
    } catch (err) {
      return { ok: false, errors: [(err as Error).message], warnings: [] };
    }
  };

  // Bound to this context's phase cursor; a nested workflow()'s child builds
  // its own, sharing the scheduler and the command id sequence.
  const exec = createExec(ctx);

  // The same for checkpoint(), on the checkpoint id sequence. A stop noticed
  // before the question is asked is fatal like any other: it ends the run.
  const ask = createCheckpoint(ctx);
  const checkpoint = (title: string, opts?: CheckpointOptions): Promise<CheckpointResult> =>
    ask(title, opts).catch((err: unknown) => {
      if (isFatalError(err)) ctx.scheduler.abort(err);
      throw err;
    });

  return {
    agent: (prompt, opts) => handled(agent(prompt, opts)),
    parallel: (thunks) => handled(parallel(thunks)),
    pipeline: (items, ...stages) => handled(pipeline(items, ...stages)),
    phase,
    log,
    budget,
    workflow: (nameOrRef, childArgs) => handled(workflow(nameOrRef, childArgs)),
    validate,
    exec: (command, opts) => handled(exec(command, opts)),
    checkpoint: (title, opts) => handled(checkpoint(title, opts)),
  };
}

/**
 * Mark a primitive's promise as handled. Scripts start work early and await it
 * later — `const p = agent(a); await agent(b); await p` — and if `p` fails in
 * between, Node would report an unhandled rejection and kill the worker
 * mid-run, leaving the run "running" forever. Awaiting `p` still throws.
 */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * Errors an agent() call already reported as AGENT_FAILED, so parallel() and
 * pipeline() do not log them a second time. Module-wide because a nested
 * workflow()'s agents can fail inside the parent's parallel().
 */
const surfaced = new WeakSet<object>();

/** The `permissions` field an agent's start event and record carry: its tier, when it has one (ODW extension). */
function permissionField(tier: unknown): { permissions?: PermissionTier } {
  return isPermissionTier(tier) ? { permissions: tier } : {};
}

/**
 * The parallel() or pipeline() call an agent() runs in, if any: carried
 * through every await of its thunk or stage, so a staggered fan-out (an ODW
 * extension) knows its agents. Module-wide like `surfaced`, so a nested
 * workflow()'s agents belong to the fan-out that called it.
 */
const fanOutScope = new AsyncLocalStorage<FanOut>();

/** The `fellBackFrom` an agent's agent_finished event and record carry when it fell back (ODW extension). */
function fallbackField(fellBackFrom: string[] | undefined): { fellBackFrom?: string[] } {
  return Array.isArray(fellBackFrom) && fellBackFrom.length > 0 ? { fellBackFrom: [...fellBackFrom] } : {};
}

/** The `changes` and `branch` an agent's terminal event and record carry when it kept a change (ODW extension). */
function changeFields(kept: KeptChanges | null): { changes?: AgentChanges; branch?: string | null } {
  return kept ? { changes: kept.changes, branch: kept.branch } : {};
}

/** The `denied` an agent's agent_finished event and record carry: the tool calls its CLI refused, when any (ODW extension). */
function deniedField(denied: unknown): { denied?: string[] } {
  if (!Array.isArray(denied)) return {};
  const calls = denied.filter((call): call is string => typeof call === "string");
  return calls.length > 0 ? { denied: calls } : {};
}

/** Refused calls a log line names, at most; the event carries them all. */
const REFUSED_SHOWN = 5;

/**
 * The one line a run logs for an agent whose reply stood though its CLI
 * refused it tool calls (`permissionDenials: "warn"`; ODW extension).
 */
function refusedNote(who: string, cli: string, denied: string[]): string {
  const calls = denied.length === 1 ? "1 tool call" : `${denied.length} tool calls`;
  const shown = denied.slice(0, REFUSED_SHOWN).join("; ");
  const more = denied.length > REFUSED_SHOWN ? `; and ${denied.length - REFUSED_SHOWN} more` : "";
  return (
    `${who}: ${cli} refused ${calls} — ${shown}${more}; its reply may rest on work it could not do ` +
    "(raise its tier with --permissions or allowlist the tool)"
  );
}

/**
 * Why an agent CLI failed, for its agent_failed event: the failure class and,
 * when the CLI said, seconds until a retry may work — or, for work that missed
 * its `expect` checks, what it missed. Nothing for other errors (a schema that
 * never validated, a stop).
 */
function failureFields(err: unknown): { reason?: string; retryAfter?: number; misses?: string[] } {
  if (!(err instanceof AdapterExecutionError)) return {};
  if (err instanceof UnmetExpectationError) return { reason: err.reason, misses: [...err.misses] };
  if (err.retryAfter === undefined) return { reason: err.reason };
  return { reason: err.reason, retryAfter: Math.ceil(err.retryAfter) };
}

/** A short description of a misused argument, for error messages. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof (value as { then?: unknown }).then === "function") return "a promise (that call has already started)";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** The error plus where it was thrown — the frame that points into the script. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const frame = err.stack?.split("\n").find((line) => line.trimStart().startsWith("at "));
  return frame ? `${String(err)} (${frame.trim()})` : String(err);
}
