/**
 * Programming primitives (L4): the verbs a workflow author composes with.
 *
 * In the Claude Code dialect these are *injected globals*, never imported, so
 * {@link createPrimitives} builds a fresh set bound to one run's context and the
 * loader injects them into the script's scope.
 *
 *   - agent     — run one coding agent on a subtask (the only verb that works)
 *   - parallel  — fan out a batch and wait for all of it (barrier)
 *   - pipeline  — stream items through stages independently (no barrier)
 *   - phase     — label the following work for progress display
 *   - log       — surface a progress message
 *   - budget    — token/agent budget exposed to the script (stub in v1)
 *   - workflow  — run another workflow inline (deferred; throws clearly for now)
 *
 * `args` is not here: it is run data injected alongside these globals.
 */

import type { AgentRequest } from "./bridge.js";
import type { RunContext } from "./context.js";
import { isFatalError, notImplemented } from "./errors.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, LOG, PHASE_STARTED, event } from "./events.js";
import type { JsonSchema } from "./schema.js";

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
  /** `"worktree"` requests isolation; satisfied by a copy-isolated workspace. */
  isolation?: "worktree";
}

export interface Budget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export type Thunk<T> = () => Promise<T> | T;
export type Stage = (previous: unknown, item: unknown, index: number) => unknown;

/** The surface injected into a workflow script (alongside `args`). */
export interface WorkflowGlobals {
  agent(prompt: string, opts?: AgentOptions): Promise<unknown>;
  parallel<T>(thunks: Array<Thunk<T>>): Promise<Array<T | null>>;
  pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]>;
  phase(title: string): void;
  log(message: unknown): void;
  budget: Budget;
  workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<unknown>;
}

/** Build the injected primitive set bound to a single run's context. */
export function createPrimitives(ctx: RunContext): WorkflowGlobals {
  const agent = async (prompt: string, opts: AgentOptions = {}): Promise<unknown> => {
    const activePhase = opts.phase !== undefined ? opts.phase : ctx.currentPhase;
    // Adapter selection honours ONLY opts.adapter. agentType is a persona (it is
    // forwarded to the bridge and injected into the prompt), never an adapter name.
    const display =
      opts.label ?? opts.adapter ?? opts.agentType ?? ctx.config.settings.defaultAdapter ?? "agent";
    ctx.emit(event(AGENT_STARTED, { label: display, phase: activePhase }));

    const request: AgentRequest = {
      prompt,
      adapter: opts.adapter,
      schema: opts.schema,
      label: opts.label,
      model: opts.model,
      agentType: opts.agentType,
      isolation: opts.isolation,
    };
    let outcome;
    try {
      outcome = await ctx.scheduler.runAgent(() => ctx.bridge.run(request));
    } catch (err) {
      if (isFatalError(err)) throw err; // budget exhausted / stop: abort the run
      ctx.emit(event(AGENT_FAILED, { label: display, phase: activePhase, error: String(err) }));
      throw err;
    }
    // No option is dropped silently: surface each routing note as a LOG event
    // (visible in `odw logs` and the dashboard).
    for (const note of outcome.notes ?? []) {
      ctx.emit(event(LOG, { message: note, label: display, phase: activePhase }));
    }
    ctx.emit(
      event(AGENT_FINISHED, {
        label: display,
        phase: activePhase,
        adapter: outcome.adapter,
        attempts: outcome.attempts,
      }),
    );
    return outcome.value;
  };

  const parallel = <T>(thunks: Array<Thunk<T>>): Promise<Array<T | null>> =>
    ctx.scheduler.gather(thunks.map((t) => async () => t()));

  const pipeline = (items: unknown[], ...stages: Stage[]): Promise<unknown[]> => {
    const chains = items.map((item, index) => async (): Promise<unknown> => {
      let value: unknown = item;
      for (const stage of stages) {
        value = await stage(value, item, index);
      }
      return value;
    });
    return ctx.scheduler.gather(chains) as Promise<unknown[]>;
  };

  const phase = (title: string): void => {
    ctx.currentPhase = title;
    ctx.emit(event(PHASE_STARTED, { phase: title }));
  };

  const log = (message: unknown): void => {
    ctx.emit(event(LOG, { message: String(message) }));
  };

  const budget: Budget = {
    total: ctx.budgetTotal,
    spent: () => 0, // best-effort in v1; real token accounting is v1.5+
    remaining: () => (ctx.budgetTotal === null ? Infinity : Math.max(0, ctx.budgetTotal)),
  };

  const workflow = async (): Promise<unknown> => {
    throw notImplemented("nested workflow() — deferred to v2");
  };

  return { agent, parallel, pipeline, phase, log, budget, workflow };
}
