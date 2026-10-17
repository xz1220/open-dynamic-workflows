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
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { formatSeconds } from "./adapters/failures.js";
import { isPermissionTier, planPermissions, runTier } from "./adapters/permissions.js";
import type { Adapter, PermissionTier } from "./adapters/types.js";
import { addUsage, estimatedUsage, type Usage } from "./adapters/usage.js";
import type { AgentRequest } from "./bridge.js";
import { branchName, ChangeRecorder, type AgentChanges, type KeptChanges } from "./changes.js";
import { CheckpointTimeout, createCheckpoint, type CheckpointOptions, type CheckpointResult } from "./checkpoint.js";
import { spentTokens, type RunContext } from "./context.js";
import { AdapterExecutionError, WorkflowScriptError, isFatalError } from "./errors.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, LOG, PHASE_STARTED, event } from "./events.js";
import { ExecError, createExec, type ExecOptions, type ExecResult } from "./exec.js";
import { resumeKey, type AgentResultRecord } from "./journal.js";
// Value import of the loader is safe: loader.ts only type-imports from here, so
// the module cycle is erased at compile time and never exists at runtime.
import { loadWorkflowScript, scanDualCompat, type WorkflowMeta } from "./loader.js";
import type { JsonSchema } from "./schema.js";
import { FanOut } from "./throttle.js";
import { TranscriptRecorder } from "./transcript.js";
import { resolveWorkflow } from "./workflows/resolve.js";

export interface AgentOptions {
  /** Which configured adapter/CLI to use; falls back to the default. */
  adapter?: string;
  /** When set, the reply is validated against it and returned as an object. */
  schema?: JsonSchema;
  /** Short label for progress display. */
  label?: string;
  /** Override the current phase for this one call (use inside parallel/pipeline). */
  phase?: string;
  /** Select a model; routed to the adapter's declared model flag (else logged). */
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
  phase(title: string): void;
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

/** Build the injected primitive set bound to a single run's context. */
export function createPrimitives(
  ctx: RunContext,
  internal: { depth?: number; phasePrefix?: string } = {},
): WorkflowGlobals {
  const depth = internal.depth ?? 0;
  const phasePrefix = internal.phasePrefix ?? "";
  // Adapters whose permissions note the run has logged: once per adapter per
  // run, shared with nested workflow()s (their contexts are copies of this one).
  const notedPermissions = (ctx.permissionNotes ??= new Set<string>());

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
    const label = opts.label ?? opts.adapter ?? opts.agentType ?? recorded.label;
    const { adapter, attempts } = recorded;
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
    const finished = event(AGENT_FINISHED, { agentId, label, phase, adapter, attempts, ...marks, ...changeFields(kept) });
    const startedAt = startedEv.ts;
    const finishedAt = finished.ts;
    const value = recorded.value;
    if (save({ agentId, key, label, phase, adapter, attempts, startedAt, finishedAt, value, ...tier, ...marks, ...changeFields(kept) })) {
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
    const activePhase = opts.phase !== undefined ? opts.phase : ctx.currentPhase;
    // Stable per-dispatch identity. Events for THIS dispatch all carry it, so
    // observers pair started/finished exactly even when several concurrent
    // agents share a label+phase (the pre-agentId pairing was heuristic).
    const agentId = ++ctx.seq.value;
    // What a resume matches this call by; saved with its result.
    const key = resumeKey(prompt, opts);
    const recorded = ctx.replay?.take(key);
    if (recorded) return replay(agentId, key, recorded, opts, activePhase);
    // Adapter selection honours ONLY opts.adapter. agentType is a persona (it is
    // forwarded to the bridge and injected into the prompt), never an adapter name.
    // Resolve it before asking for a slot: an unknown or ambiguous adapter is a
    // (fatal) config error that must not consume a dispatch or show an agent
    // that never ran as running.
    const adapter = ctx.bridge.adapterFor(opts.adapter);
    const display = opts.label ?? opts.adapter ?? opts.agentType ?? adapter.name;
    // The agent's permission tier, for its events and the run's log. The
    // bridge reaches the same decision and enforces it: an agent that may not
    // have its tier, or whose CLI cannot enforce it, fails before it starts.
    const permissions = planPermissions(adapter, runTier(ctx.config), opts.permissions);
    // A staggered fan-out (ODW extension): in a parallel() or pipeline() call,
    // an agent on a prompt-caching adapter whose prompt shares a long prefix
    // with an earlier one's — on the same model and persona, so the same
    // cache — waits, holding no slot, until that one has warmed the cache.
    const fanOut = adapter.promptCache && typeof prompt === "string" ? fanOutScope.getStore() : undefined;
    const cache = [adapter.name, opts.model ?? "", opts.agentType ?? ""].join("\u0000");
    const turn = fanOut?.enter(adapter.name, cache, prompt);
    const request: AgentRequest = {
      prompt,
      adapter: opts.adapter,
      schema: opts.schema,
      label: opts.label,
      model: opts.model,
      agentType: opts.agentType,
      isolation: opts.isolation,
      permissions: opts.permissions,
    };
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
        // enforce on it, is said once per run — never silently.
        if (permissions.note && !notedPermissions.has(adapter.name)) {
          notedPermissions.add(adapter.name);
          ctx.emit(event(LOG, { message: permissions.note, adapter: adapter.name, ...permissionField(permissions.tier) }));
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
            // An adapter's quota or login failed several agents in a row: warn, once.
            onAdapterWarning: ({ message, adapter: name, reason }) =>
              ctx.emit(event(LOG, { message, adapter: name, reason, agentId, label: display, phase: activePhase })),
            // An isolated agent's change is kept as it lands (ODW extension).
            changes,
            // So is what its CLI prints (ODW extension).
            transcript,
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
        const finished = event(AGENT_FINISHED, {
          agentId,
          label: display,
          phase: activePhase,
          adapter: outcome.adapter,
          attempts: outcome.attempts,
          ...usageField(),
          ...changeFields(kept),
        });
        const persisted = save({
          agentId,
          key,
          label: display,
          phase: activePhase,
          adapter: outcome.adapter,
          attempts: outcome.attempts,
          startedAt: startedEv.ts,
          finishedAt: finished.ts,
          value: outcome.value,
          ...permissionField(permissions.tier),
          ...changeFields(kept),
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

  const phase = (title: string): void => {
    const labelled = phasePrefix + title;
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

/** The `changes` and `branch` an agent's terminal event and record carry when it kept a change (ODW extension). */
function changeFields(kept: KeptChanges | null): { changes?: AgentChanges; branch?: string | null } {
  return kept ? { changes: kept.changes, branch: kept.branch } : {};
}

/**
 * Why an agent CLI failed, for its agent_failed event: the failure class and,
 * when the CLI said, seconds until a retry may work. Nothing for other errors
 * (a schema that never validated, a stop).
 */
function failureFields(err: unknown): { reason?: string; retryAfter?: number } {
  if (!(err instanceof AdapterExecutionError)) return {};
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
