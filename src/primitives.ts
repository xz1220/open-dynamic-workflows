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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentRequest } from "./bridge.js";
import { spentTokens, type RunContext } from "./context.js";
import { WorkflowScriptError, isFatalError } from "./errors.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, LOG, PHASE_STARTED, event } from "./events.js";
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
}

/** Build the injected primitive set bound to a single run's context. */
export function createPrimitives(
  ctx: RunContext,
  internal: { depth?: number; phasePrefix?: string } = {},
): WorkflowGlobals {
  const depth = internal.depth ?? 0;
  const phasePrefix = internal.phasePrefix ?? "";

  const agent = async (prompt: string, opts: AgentOptions = {}): Promise<unknown> => {
    const activePhase = opts.phase !== undefined ? opts.phase : ctx.currentPhase;
    // Adapter selection honours ONLY opts.adapter. agentType is a persona (it is
    // forwarded to the bridge and injected into the prompt), never an adapter name.
    const display =
      opts.label ?? opts.adapter ?? opts.agentType ?? ctx.config.settings.defaultAdapter ?? "agent";
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
      outcome = await ctx.scheduler.runAgent(async () => {
        // Record the adapter only once the scheduler has handed out a real
        // dispatch slot, so queued work is not presented as running.
        ctx.emit(
          event(AGENT_STARTED, {
            label: display,
            phase: activePhase,
            adapter: opts.adapter ?? ctx.config.settings.defaultAdapter ?? null,
          }),
        );
        return ctx.bridge.run(request);
      });
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
    // Feed the shared budget tally (estimated tokens ≈ chars/4 of the reply).
    ctx.usage.outputChars += outcome.text.length;
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
    // The child gets its own phase cursor (so a concurrent parent agent keeps
    // its label) but shares everything that costs or controls: scheduler,
    // bridge, sink, control, and the usage tally.
    const childCtx: RunContext = { ...ctx, currentPhase: `▸ ${name}` };
    const childGlobals = createPrimitives(childCtx, {
      depth: depth + 1,
      phasePrefix: `▸ ${name} · `,
    });
    ctx.emit(event(LOG, { message: `▸ entering workflow ${name} (${scriptPath})` }));
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

  return { agent, parallel, pipeline, phase, log, budget, workflow, validate };
}
