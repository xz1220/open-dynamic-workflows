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
 *   - budget    — the run's token budget: total, estimated spend, remaining
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
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { formatSeconds } from "./adapters/failures.js";
import type { AgentRequest } from "./bridge.js";
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
  const replay = (
    agentId: number,
    key: string,
    recorded: AgentResultRecord,
    opts: AgentOptions,
    phase: string | null,
  ): unknown => {
    // Once the run has ended, every later call fails with its reason.
    if (ctx.scheduler.fatalError !== undefined) throw ctx.scheduler.fatalError;
    const label = opts.label ?? opts.adapter ?? opts.agentType ?? recorded.label;
    const { adapter, attempts } = recorded;
    const marks = {
      cached: true,
      // The run whose agent actually produced the value, across chained resumes.
      sourceRunId: recorded.cached && recorded.sourceRunId ? recorded.sourceRunId : ctx.replay!.sourceRunId,
    };
    const startedEv = event(AGENT_STARTED, { agentId, label, phase, adapter, ...marks });
    ctx.emit(startedEv);
    const finished = event(AGENT_FINISHED, { agentId, label, phase, adapter, attempts, ...marks });
    const startedAt = startedEv.ts;
    const finishedAt = finished.ts;
    if (save({ agentId, key, label, phase, adapter, attempts, startedAt, finishedAt, value: recorded.value, ...marks })) {
      finished.saved = true;
    }
    ctx.emit(finished);
    return structuredClone(recorded.value);
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
    const request: AgentRequest = {
      prompt,
      adapter: opts.adapter,
      schema: opts.schema,
      label: opts.label,
      model: opts.model,
      agentType: opts.agentType,
      isolation: opts.isolation,
    };
    const failed = (err: unknown): void => {
      ctx.emit(
        event(AGENT_FAILED, { agentId, label: display, phase: activePhase, error: String(err), ...failureFields(err) }),
      );
      if (typeof err === "object" && err !== null) surfaced.add(err);
    };
    let started = false;
    try {
      // Everything an agent records — its terminal event, its usage — happens
      // while it holds its slot: once runAgent settles, the agent is fully
      // accounted for (the run's drain relies on it), and the next queued
      // dispatch sees the updated budget.
      return await ctx.scheduler.runAgent(async (signal) => {
        // Record the adapter only once the scheduler has handed out a real
        // dispatch slot, so queued work is not presented as running.
        started = true;
        const startedEv = event(AGENT_STARTED, { agentId, label: display, phase: activePhase, adapter: adapter.name });
        ctx.emit(startedEv);
        let outcome;
        try {
          outcome = await ctx.bridge.run(request, {
            signal,
            // The agent process's ODW_AGENT_ID; what preparing it noted (no free
            // port, a file .worktreeinclude left out) is logged against it.
            agentId,
            onNote: (message) =>
              ctx.emit(
                event(LOG, { message: `${display}:${agentId}: ${message}`, agentId, label: display, phase: activePhase }),
              ),
            // Feed the shared budget tally from every attempt, schema retries
            // included (estimated tokens ≈ chars/4 of each reply).
            onReply: (text) => {
              ctx.usage.outputChars += text.length;
            },
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
            onRateLimit: ({ adapter: name, waitSeconds, retry, maxRetries }) =>
              ctx.emit(
                event(LOG, {
                  message: `${display}:${agentId} hit a rate limit on ${name} — retrying in ${formatSeconds(waitSeconds)} (${retry}/${maxRetries})`,
                  agentId,
                  label: display,
                  phase: activePhase,
                }),
              ),
            // An adapter's quota or login failed several agents in a row: warn, once.
            onAdapterWarning: ({ message, adapter: name, reason }) =>
              ctx.emit(event(LOG, { message, adapter: name, reason, agentId, label: display, phase: activePhase })),
          });
        } catch (err) {
          // A started agent always gets a terminal event, even when the error
          // is fatal (stop, budget, a config error raised inside the slot) —
          // else observers show it running forever.
          failed(err);
          throw err;
        }
        // No option is dropped silently: surface each routing note as a LOG event
        // (visible in `odw logs` and the dashboard).
        for (const note of outcome.notes ?? []) {
          ctx.emit(event(LOG, { message: note, label: display, phase: activePhase }));
        }
        const finished = event(AGENT_FINISHED, {
          agentId,
          label: display,
          phase: activePhase,
          adapter: outcome.adapter,
          attempts: outcome.attempts,
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
        });
        if (persisted) finished.saved = true;
        ctx.emit(finished);
        return outcome.value;
      });
    } catch (err) {
      // A fatal error before the start (stop or budget at dispatch) concerns
      // the run, not this agent; anything else is still this agent's failure.
      if (!started && !isFatalError(err)) failed(err);
      throw err;
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
    return ctx.scheduler.gather(
      thunks.map((thunk, i) => async () => {
        try {
          return await thunk();
        } catch (err) {
          noteSwallowed(err, `parallel() thunk ${i}`);
          throw err;
        }
      }),
    );
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
    return ctx.scheduler.gather(chains) as Promise<unknown[]>;
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
    // Estimated output tokens (chars/4 of every agent reply) — see RunContext.usage.
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
