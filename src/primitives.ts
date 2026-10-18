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
 * (an ODW extension; see ./transcript) — complete before its terminal event —
 * with its likely secrets redacted, like its saved result (an ODW extension;
 * see ./redact); a resume replays a redacted result as saved, and says so.
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
 * produced the value, and `fellBackFrom` the ones it left. With handoff on
 * (`fallback.handoff`, or the call's `handoff`; an ODW extension, see
 * ./handoff) the next adapter carries the work on in the same worktree, its
 * prompt starting with a brief — kept as `agents/<id>.handoff.md` and told
 * by a `handoff` event {from, to, reason, bytes}. Under `quotaWait`
 * (an ODW extension; see ./quota-wait) an agent whose chain is out of quota
 * waits for the reset instead of failing — holding no slot, and before it is
 * dispatched when no adapter of its chain has quota left.
 *
 * An agent's work is checked, not taken at its word, when its call says what
 * must hold (`expect`, an ODW extension; see ./expect): a check's command is
 * an exec() step of the run carrying the agent's id (`forAgentId`), a retry is
 * logged, and an agent that still misses fails with reason
 * "unmet_expectation" and its `misses` on agent_failed. An empty reply fails
 * with reason "empty_reply" unless the call sets `allowEmpty`. Tool calls its
 * CLI refused under a reply that stood are logged once and kept as `denied`
 * on its agent_finished event and saved record. The MCP servers its CLI
 * started it without (Claude Code's init event) are kept as `mcp` on its
 * terminal event and saved record, and logged once per run for each server
 * and status. Background work its CLI left running under a reply that stood
 * (`orphanedBackground: "warn"`) is logged once and kept as `orphaned` on its
 * agent_finished event and saved record.
 *
 * An agent with notes on — `notes: true` on its call or its parallel(), or
 * the `notes` setting (an ODW extension; see ./notes) — finds the run's notes
 * board in its prompt and `ODW_NOTES` in its environment, and an isolated one
 * that kept a change has a note of its interface changes posted for it before
 * its agent_finished event, so the agents the script starts next see it.
 *
 * An agent with memory on — `memory: true` on its call, or the `memory`
 * setting (an ODW extension; see ./memory) — finds what earlier runs of the
 * workflow learned that still applies ahead of its task, and an `expect` miss
 * a retry of it met is kept as a lesson once the run ends.
 *
 * An agent runs under its limits (an ODW extension; see ./limits) — the
 * call's `limits` over its adapter's and the run's `agentLimits` — carried as
 * `limits` on its agent_started event; one that runs into a limit is killed
 * and fails with reason "runaway" and `limitHit` (the limit, what it reached,
 * the evidence) on agent_failed.
 *
 * An agent may declare the files it means to change (`scope`, an ODW
 * extension; see ./scope): a scoped call made while an earlier one whose
 * scope overlaps has not settled waits for it, holding no slot, and the run
 * says so once per wait; its scope is carried as `scope` on its agent_started
 * event. What it changed outside its scope is kept as `outOfScope` on its
 * terminal event and saved record, logged, and — with notes on — posted to
 * the notes board; `scopePolicy: "fail"` fails it with reason "out_of_scope",
 * and with `expect` it is a miss.
 *
 * Before a parallel() or pipeline() at least `fanOutWarn` wide, or one a
 * `costGate` covers — the setting, or its parallel()'s option — the run
 * forecasts what it will cost from the workflow's earlier runs and logs it;
 * a forecast over the gate waits at a checkpoint for a person's go, and a
 * rejection throws a recoverable CostGateRejected (ODW extensions; see
 * ./forecast). An agent()'s `costGate` does the same for that one agent.
 *
 * What each agent() call was asked — its prompt, its options, the adapter it
 * started on, the model it asked for — is saved as it starts, for `odw
 * replay` (an ODW extension; see ./runtime/replay), and an isolated agent's
 * agent_started event names the commit its worktree checks out (`base`).
 * Under `odw run --break`/`--step` (an ODW extension; see ./breaks) the
 * script's calls wait at the run's breaks before they start.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { formatSeconds } from "./adapters/failures.js";
import { isPermissionTier } from "./adapters/permissions.js";
import type { McpServer } from "./adapters/output.js";
import { planTrust, runTrust } from "./adapters/trust.js";
import { sandboxView, type SandboxView } from "./adapters/sandbox.js";
import { adapterDisplayName, type Adapter, type PermissionTier, type TrustLevel } from "./adapters/types.js";
import { addUsage, estimatedUsage, type Usage } from "./adapters/usage.js";
import type { AgentRequest, TranscriptSink } from "./bridge.js";
import { applyArgsEdit } from "./breaks.js";
import { branchName, ChangeRecorder, type AgentChanges, type KeptChanges } from "./changes.js";
import { CheckpointTimeout, createCheckpoint, type CheckpointOptions, type CheckpointResult } from "./checkpoint.js";
import { spentTokens, type RunContext } from "./context.js";
import { AdapterExecutionError, AgentError, NeedsInputError, RunStopped, RunawayError, UnmetExpectationError, WorkflowScriptError, isDeadlineStop, isFatalError } from "./errors.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, DESTRUCTIVE_GIT, HANDOFF, LOG, PHASE_STARTED, event } from "./events.js";
import { DestructiveGitWatch } from "./destructive-git.js";
import { ExecError, createExec, execStep, type ExecOptions, type ExecResult } from "./exec.js";
import { CostGateRejected, costGateTitle, readCostGate, type CostGate, type CostHistory } from "./forecast.js";
import { Expectations, planChecks, scopeOnlyPlan, type AgentChecks, type ExpectOptions } from "./expect.js";
import { resumeKey, type AgentCallRecord, type AgentResultRecord } from "./journal.js";
import { hasLimits, readLimits, type AgentLimits, type LimitHit, type LimitSpec } from "./limits.js";
// Value import of the loader is safe: loader.ts only type-imports from here, so
// the module cycle is erased at compile time and never exists at runtime.
import { loadWorkflowScript, scanDualCompat, type WorkflowMeta } from "./loader.js";
import { interfaceSummary, type AgentNotes } from "./notes.js";
import { answerOf, isQuestionPolicy, MAX_QUESTION_ROUNDS, questionLine, questionTitle, type QuestionPolicy } from "./questions.js";
import { firstAdapter, phaseDefaultsOf, type AdapterChoice, type PhaseDefaults } from "./routing.js";
import type { JsonSchema } from "./schema.js";
import { planScope, ScopeLocks, waitNote, type ScopeClaim, type ScopePlan, type ScopePolicy } from "./scope.js";
import { FanOut } from "./throttle.js";
import { fmtUsd } from "./tty.js";
import { TranscriptRecorder } from "./transcript.js";
import { UntrustedInputRejected, workflowInput, writes, type WorkflowInput } from "./untrusted-input.js";
import { resolveWorkflow } from "./workflows/resolve.js";
import { headCommit } from "./workspace.js";

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
  /**
   * ODW extension: run this agent in a container, or a stricter one than the
   * run's — `"container"`, or `{ network: "none" | { allow: [...] }, memory,
   * cpus, pids, cliConfig: "none", image }` (`image` only where nothing else
   * sets one; an `allow` list narrows the sandbox's to the hosts both allow).
   * It may only tighten the sandbox; asking for less fails the call (see
   * adapters/sandbox.ts).
   */
  sandbox?: "none" | "container" | Record<string, unknown>;
  /**
   * ODW extension: what this agent may do before it is killed as a runaway —
   * `{ toolCalls, costUsd, outputTokens, seconds, repeat }`, over its
   * adapter's and the run's `agentLimits` key by key (`null` lifts one). A
   * breach fails it with reason "runaway" (see ./limits).
   */
  limits?: LimitSpec;
  /**
   * ODW extension: the run's notes board for this agent (see ./notes) — the
   * notes so far in its prompt, `ODW_NOTES` to post and read them, and, for
   * an isolated agent that kept a change, a note of its interface changes.
   * `false` opts one agent out of its parallel()'s or the `notes` setting.
   */
  notes?: boolean;
  /**
   * ODW extension: workflow memory for this agent (see ./memory) — what
   * earlier runs learned that still applies, ahead of its task; and an
   * `expect` miss a retry of it then met, kept as a lesson once the run
   * ends. Unset: the `memory` setting.
   */
  memory?: boolean;
  /**
   * ODW extension: when a fallback moves this agent to the next adapter of its
   * chain, hand the work over instead of starting it over — the next adapter
   * goes on in the same worktree, its prompt starting with a brief of what the
   * last one did (see ./handoff). Unset: the `fallback.handoff` setting.
   */
  handoff?: boolean;
  /**
   * ODW extension: the files this agent means to change — globs relative to
   * its workspace, with the `expect` glob rules (see ./scope). A scoped call
   * whose scope overlaps an earlier one's still in flight waits for it; what
   * it changes outside its scope is recorded as `outOfScope` and logged.
   */
  scope?: string[];
  /**
   * ODW extension: what a write outside `scope` does — `"warn"` records and
   * logs it, `"fail"` fails the agent with reason "out_of_scope". Unset: the
   * `scopePolicy` setting ("warn" by default). With `expect` it is a miss.
   */
  scopePolicy?: ScopePolicy;
  /**
   * ODW extension: `{ usd }` — when this agent is forecast, from the
   * workflow's earlier runs, to cost more than `usd` dollars, it waits at a
   * checkpoint for a person's go first; a rejection throws a
   * CostGateRejected (see ./forecast). Unset: no gate (the `costGate`
   * setting covers fan-outs, not single agents).
   */
  costGate?: CostGate | null;
  /**
   * ODW extension: what a question this agent stops to ask the user does (see
   * ./questions) — `"checkpoint"` asks a person and runs it again with the
   * answer, `"fail"` fails it with reason "needs_input", `"deny"` takes its
   * question tool away and tells it to assume. Unset: its adapter's, else the
   * `questions` setting ("checkpoint" by default).
   */
  questions?: QuestionPolicy;
}

/** ODW extension: what parallel() takes after its thunks. */
export interface ParallelOptions {
  /** Every agent its thunks start has notes on (see AgentOptions.notes), unless one says `notes: false`. */
  notes?: boolean;
  /**
   * `{ usd }`: a forecast over `usd` dollars waits at a checkpoint for a
   * person's go (see ./forecast); `null` lifts the `costGate` setting for
   * this call. Unset: the setting.
   */
  costGate?: CostGate | null;
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
  /** ODW extension: `opts.notes` turns the notes board on for its agents. */
  parallel<T>(thunks: Array<Thunk<T>>, opts?: ParallelOptions): Promise<Array<T | null>>;
  pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]>;
  /** ODW extension: `opts` gives the phase's agents an adapter and a model (see ./routing). */
  phase(title: string, opts?: PhaseDefaults): void;
  log(message: unknown): void;
  budget: Budget;
  /** `workflow.input` is an ODW extension (see ./untrusted-input): whether the run's args came from outside. */
  workflow: ((nameOrRef: string | { scriptPath: string }, args?: unknown) => Promise<unknown>) & { readonly input?: WorkflowInput };
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
  // Each MCP server, with its status, the run has said was not connected:
  // once per run, shared with nested workflow()s like the notes above (ODW extension).
  const notedMcp = (ctx.mcpNotes ??= new Set<string>());
  // Each phase's defaults for its agents (ODW extension), by its (prefixed)
  // title — shared with nested workflow()s like the notes above.
  const phaseDefaults = (ctx.phaseDefaults ??= new Map<string, PhaseDefaults>());
  // The scoped calls not settled yet (ODW extension; see ./scope) — shared with
  // nested workflow()s like the notes above, so their agents wait for each other too.
  const scopeLocks = (ctx.scopeLocks ??= new ScopeLocks());
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
   * Save what a call was asked as it starts (ODW extension; see ./journal
   * AgentCallRecord) — never failing the agent: an error is logged.
   */
  const saveCall = (call: Omit<AgentCallRecord, "options">, opts: AgentOptions): void => {
    if (!ctx.saveAgentCall) return;
    try {
      const options = JSON.parse(JSON.stringify(opts ?? {}) ?? "{}") as Record<string, unknown>;
      ctx.saveAgentCall({ ...call, options });
    } catch (err) {
      ctx.emit(
        event(LOG, {
          message: `could not save what agent ${call.agentId} was asked (odw replay cannot run it again): ${err instanceof Error ? err.message : String(err)}`,
          label: call.label,
          phase: call.phase,
        }),
      );
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
    prompt: string,
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
    // The scope the call declares (ODW extension): a replay waits for nobody, but shows it.
    const scoped = Array.isArray(opts.scope) && opts.scope.length > 0 ? { scope: [...opts.scope] } : {};
    const startedEv = event(AGENT_STARTED, { agentId, label, phase, adapter, key, ...tier, ...marks, ...scoped });
    ctx.emit(startedEv);
    saveCall({ agentId, label, phase, prompt, adapter, model: opts.model ?? null }, opts);
    const kept = await carryChanges(recorded, agentId, (message) =>
      ctx.emit(event(LOG, { message: `${label}:${agentId}: ${message}`, agentId, label, phase })),
    );
    // What its CLI refused when the value was produced travels with it (ODW extension).
    const denied = deniedField(recorded.denied);
    const mcp = mcpField(recorded.mcp);
    const orphaned = orphanedField(recorded.orphaned);
    const outside = outOfScopeField(recorded.outOfScope);
    const changed = changeFields(kept);
    // A value saved with its secrets redacted replays as saved, and says so (ODW extension; see ./redact).
    const redacted = recorded.redacted === true ? { redacted: true } : {};
    if (recorded.redacted === true) {
      ctx.emit(
        event(LOG, {
          message: `${label}:${agentId}: replays a saved result whose secrets were redacted when it was kept — the workflow gets it redacted`,
          agentId,
          label,
          phase,
        }),
      );
    }
    const finished = event(AGENT_FINISHED, { agentId, label, phase, adapter, ...moved, attempts, ...marks, ...changed, ...denied, ...mcp, ...orphaned, ...outside });
    const startedAt = startedEv.ts;
    const finishedAt = finished.ts;
    const value = recorded.value;
    if (save({ agentId, key, label, phase, adapter, ...moved, attempts, startedAt, finishedAt, value, ...tier, ...marks, ...changed, ...denied, ...mcp, ...orphaned, ...outside, ...redacted })) {
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
      // Likely secrets are kept redacted (ODW extension; see ./redact).
      redactor: ctx.redactor,
    });
  };

  /**
   * What watches an agent's CLI runs for destructive git commands (ODW
   * extension; see ./destructive-git): each one it runs is a
   * `destructive_git` event as soon as it shows — with `odw restore` named
   * when the run has a snapshot to put back.
   */
  const destructiveGitWatch = (agentId: number, label: string, phase: string | null, isolated: boolean): DestructiveGitWatch =>
    new DestructiveGitWatch((hit) => {
      const policy = ctx.config.settings.destructiveGit;
      const snapshot = ctx.safety?.info;
      const restore = snapshot && ctx.runId ? ` — odw restore ${ctx.runId} puts back the working tree as it was before the run's first in-place agent` : "";
      ctx.emit(
        event(DESTRUCTIVE_GIT, {
          message: `${label}:${agentId} ran a destructive git command (${hit.what}): ${hit.command}${restore}`,
          agentId,
          label,
          phase,
          command: hit.command,
          what: hit.what,
          policy,
          ...(snapshot ? { snapshot: snapshot.ref } : {}),
        }),
      );
    }, isolated);

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
    scope?: { plan: ScopePlan; claim: ScopeClaim; note: (message: string) => void },
  ): Expectations | undefined => {
    if (!checks.expect) return undefined;
    const retries = checks.expectRetries ?? ctx.config.settings.expectRetries ?? 1;
    // A declared scope is judged with the checks, a write outside it a miss (ODW extension; see ./scope).
    const plan = scope ? { ...checks.expect, scope: scope.plan.globs, scopeMiss: true } : checks.expect;
    return new Expectations(plan, retries, {
      signal,
      // ODW writes the run's directory while the agent works: never its change.
      ignore: ctx.runDir ? [ctx.runDir] : [],
      ...(scope ? { neighbours: () => scope.claim.neighbours(), onNote: scope.note } : {}),
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

  /**
   * What reads a scoped call's change when it has no `expect` (ODW extension;
   * see ./scope): its writes outside the scope are recorded — a miss that
   * fails it under `scopePolicy: "fail"`, never retried.
   */
  const scopeWatch = (plan: ScopePlan, claim: ScopeClaim, signal: AbortSignal, note: (message: string) => void): Expectations =>
    new Expectations(scopeOnlyPlan(plan.globs, plan.policy === "fail"), 0, {
      signal,
      ignore: ctx.runDir ? [ctx.runDir] : [],
      neighbours: () => claim.neighbours(),
      onNote: note,
      exec: () => Promise.reject(new Error("a scope runs no command")),
    });

  /**
   * Say what an agent wrote outside its declared scope (ODW extension; see
   * ./scope): a line in the run's log and, with notes on, a note on the board
   * — so the agents that work there next know. Its `outOfScope` field.
   */
  const reportOutOfScope = (
    outside: string[] | null | undefined,
    plan: ScopePlan,
    who: { agentId: number; label: string; phase: string | null },
    notesOn: boolean,
    note: (message: string) => void,
  ): { outOfScope?: string[] } => {
    if (!outside || outside.length === 0) return {};
    const globs = plan.globs.map(({ glob }) => glob).join(", ");
    const files = outside.length === 1 ? "1 file" : `${outside.length} files`;
    const shown = outside.slice(0, REFUSED_SHOWN).join(", ") + (outside.length > REFUSED_SHOWN ? ` and ${outside.length - REFUSED_SHOWN} more` : "");
    ctx.emit(
      event(LOG, {
        message:
          `${who.label}:${who.agentId}: wrote ${files} outside its scope (${globs}) — ${shown}` +
          (plan.policy === "warn" ? ' (scopePolicy: "fail" fails such an agent)' : ""),
        outOfScope: [...outside],
        agentId: who.agentId,
        label: who.label,
        phase: who.phase,
      }),
    );
    if (notesOn && ctx.notes) {
      try {
        ctx.notes.post(
          { agentId: who.agentId, label: who.label },
          `Changed ${files} outside its declared scope (${globs}): ${outside.join(", ")}`,
          "scope",
        );
      } catch (err) {
        note(`could not post its out-of-scope writes to the notes board: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { outOfScope: [...outside] };
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

  /**
   * Set an agent up on the run's notes board (ODW extension; see ./notes),
   * told of `--keep` when its workflow memory is on —
   * none in a run that is not persisted, which says so once.
   */
  const openNotes = (agentId: number, label: string, keep: boolean): AgentNotes | undefined => {
    if (ctx.notes) return ctx.notes.openAgent(agentId, label, { keep });
    if (!notesUnavailable.has(ctx.seq)) {
      notesUnavailable.add(ctx.seq);
      ctx.emit(event(LOG, { message: "notes: this run is not persisted, so it has no notes board — its agents run without one" }));
    }
    return undefined;
  };

  /**
   * The workflow's memory for an agent's prompt (ODW extension; see ./memory):
   * "" when nothing applies — and in a run that is not persisted, which says so once.
   */
  const recallMemory = (): string => {
    if (ctx.memory) return ctx.memory.recall();
    if (!memoryUnavailable.has(ctx.seq)) {
      memoryUnavailable.add(ctx.seq);
      ctx.emit(event(LOG, { message: "memory: this run is not persisted, so it has no workflow memory — its agents run without one" }));
    }
    return "";
  };

  /**
   * Keep what an agent's `expect` retries were told it missed, met by the
   * attempt that stood, as a lesson (ODW extension; see ./memory): what was
   * missing and what fixed it, from the checks themselves — no model.
   */
  const learnLesson = (label: string, missed: string[], attempts: number, kept: KeptChanges | null): void => {
    const change = kept?.changes;
    const how = change
      ? `, which changed ${change.files} file${change.files === 1 ? "" : "s"} (+${change.insertions} -${change.deletions})`
      : "";
    ctx.memory?.record({
      kind: "lesson",
      text: `"${label}": ${missed.join("; ")} — it was fixed by a retry told what was missing (${attempts} attempts in all)${how}`,
      agent: label,
    });
  };

  /** Post the note of an isolated agent's kept change: its diff stat and the interface lines it touched (ODW extension). */
  const broadcast = async (agentId: number, label: string, kept: KeptChanges, note: (message: string) => void): Promise<void> => {
    if (!ctx.notes || !ctx.agentDiffPath) return;
    try {
      const summary = interfaceSummary(await readFile(ctx.agentDiffPath(agentId), "utf8"), kept.changes, (text) => ctx.notes!.redact(text));
      if (summary) ctx.notes.post({ agentId, label }, summary, "interface");
    } catch (err) {
      note(`could not post its interface changes to the notes board: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const dispatch = async (prompt: string, opts: AgentOptions): Promise<unknown> => {
    // The output checks a call asks for are checked before anything starts:
    // a misuse is a recoverable error that costs no dispatch (ODW extension).
    const checks = planChecks(opts);
    if (opts.notes !== undefined && typeof opts.notes !== "boolean") {
      throw new AgentError(`agent(): notes must be true or false; got ${describeValue(opts.notes)}`);
    }
    if (opts.handoff !== undefined && typeof opts.handoff !== "boolean") {
      throw new AgentError(`agent(): handoff must be true or false; got ${describeValue(opts.handoff)}`);
    }
    if (opts.memory !== undefined && typeof opts.memory !== "boolean") {
      throw new AgentError(`agent(): memory must be true or false; got ${describeValue(opts.memory)}`);
    }
    if (opts.questions !== undefined && !isQuestionPolicy(opts.questions)) {
      const got = typeof opts.questions === "string" ? JSON.stringify(opts.questions) : describeValue(opts.questions);
      throw new AgentError(`agent(): questions must be "checkpoint", "fail" or "deny"; got ${got}`);
    }
    // The run's notes board (ODW extension): its call's say, else its parallel()'s, else the setting.
    const notesOn = opts.notes ?? notesScope.getStore() ?? ctx.config.settings.notes === true;
    // Workflow memory (ODW extension; see ./memory): its call's say, else the setting.
    const memoryOn = opts.memory ?? ctx.config.settings.memory === true;
    // So are its limits (ODW extension; see ./limits).
    const ownLimits = opts.limits === undefined ? undefined : readLimits(opts.limits, "agent(): limits", (m) => new AgentError(m));
    // And its declared scope (ODW extension; see ./scope).
    const scope = planScope(opts, ctx.config.settings.scopePolicy ?? "warn");
    const activePhase = opts.phase !== undefined ? opts.phase : ctx.currentPhase;
    // Stable per-dispatch identity. Events for THIS dispatch all carry it, so
    // observers pair started/finished exactly even when several concurrent
    // agents share a label+phase (the pre-agentId pairing was heuristic).
    const agentId = ++ctx.seq.value;
    // What a resume matches this call by; saved with its result. The call's
    // own options only: a phase's defaults stay out of it (see ./journal).
    const key = resumeKey(prompt, opts);
    const recorded = ctx.replay?.take(key);
    if (recorded) return replay(agentId, key, recorded, prompt, opts, activePhase);
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
    // quota breaker has not taken out — nor, under quotaWait, whose quota is
    // spent until a reset its CLI named.
    let route = ctx.bridge.route(adapterChoice, opts.permissions);
    let adapter = route.chain[Math.max(0, route.start)]!;
    const display = opts.label ?? firstAdapter(opts.adapter) ?? opts.agentType ?? adapter.name;
    // The agent's permission tier, for its events and the run's log — its
    // first adapter's, which every fallback runs too. The bridge enforces it:
    // an agent that may not have its tier, or whose CLI cannot enforce it,
    // fails before it starts.
    const permissions = route.permissions;
    // Untrusted input (ODW extension; see ./untrusted-input): the first agent
    // that may write waits for a person's go, once per run, holding no slot.
    if (writes(permissions.tier) && ctx.input?.meta.approve) {
      try {
        await writeGate(display, permissions.tier!);
      } catch (err) {
        ctx.bridge.releaseRoute?.(route);
        throw err;
      }
    }
    // Whether its CLI runs untrusted (ODW extension; see adapters/trust.ts):
    // the run's level, or its first adapter's own. The bridge adds the flags.
    const trust = planTrust(route.chain[0]!, runTrust(ctx.config)).trust;
    // The container its CLI runs in, if any (ODW extension; see adapters/sandbox.ts):
    // its first adapter's, for its events. The bridge enforces it, and refuses a looser one.
    const sandbox = ctx.bridge.sandboxFor?.(route.chain[0]!, opts.sandbox).box ?? null;
    // A staggered fan-out (ODW extension): in a parallel() or pipeline() call,
    // an agent on a prompt-caching adapter whose prompt shares a long prefix
    // with an earlier one's — on the same model and persona, so the same
    // cache — waits, holding no slot, until that one has warmed the cache.
    const fanOut = adapter.promptCache && typeof prompt === "string" ? fanOutScope.getStore() : undefined;
    const cache = [adapter.name, model ?? "", opts.agentType ?? ""].join("\u0000");
    // A scoped call claims its scope as it is made (ODW extension; see ./scope):
    // it waits, holding no slot, for each earlier call in flight whose scope overlaps.
    const claim = scope ? scopeLocks.claim({ agentId, label: display }, scope.globs.map(({ glob }) => glob)) : undefined;
    const turn = fanOut?.enter(adapter.name, cache, prompt);
    // A call none of whose adapters has quota left waits for the first reset
    // before it is dispatched (ODW extension: quotaWait) — holding no slot,
    // showing no agent — and is routed again once it can run.
    const ready = async (signal: AbortSignal): Promise<void> => {
      await claim?.wait(signal, (holder, pair) =>
        ctx.emit(
          event(LOG, {
            message: waitNote(display, holder.label, pair),
            agentId,
            label: display,
            phase: activePhase,
            // Structured for the run's readers: whom it waits for, and why.
            scopeWait: { for: holder.agentId, globs: [...pair] },
          }),
        ),
      );
      while (await ctx.bridge.awaitQuota(route, signal)) {
        // Routed again: the old route no longer counts on its account (ODW extension: accounts).
        ctx.bridge.releaseRoute?.(route);
        route = ctx.bridge.route(adapterChoice, opts.permissions);
      }
      await turn?.gate?.(signal);
    };
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
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(ownLimits !== undefined ? { limits: ownLimits } : {}),
      ...(opts.handoff !== undefined ? { handoff: opts.handoff } : {}),
      ...(opts.questions !== undefined ? { questions: opts.questions } : {}),
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
    // The MCP servers its latest CLI run started it without (ODW extension): what a failed agent keeps.
    let mcpSeen: McpServer[] = [];
    const failed = (err: unknown, kept: KeptChanges | null = null, outside: { outOfScope?: string[]; partial?: true } = {}): void => {
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
          ...mcpField(mcpSeen),
          ...outside,
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
        // Routed again after a wait for a spent quota, a call may start on
        // another adapter of its chain: its slot goes there first.
        const start = route.chain[Math.max(0, route.start)]!;
        if (start.name !== adapter.name) {
          await slot.moveTo(start.name);
          adapter = start;
          onAdapter = start.name;
        }
        // Record the adapter only once the scheduler has handed out a real
        // dispatch slot, so queued work is not presented as running.
        started = true;
        turn?.started();
        // From now on, what it changes in place beside another scoped call may be that call's.
        claim?.start();
        // The commit an isolated agent's worktree checks out (ODW extension):
        // the run's pinned one (`odw replay`), else HEAD as it starts.
        const base = opts.isolation === "worktree" ? (ctx.worktreeBase ?? (await headCommit(ctx.source))) : null;
        // The run's first in-place agent that may change the user's tree has it
        // snapshot first; any other one starting meanwhile waits for that (ODW extension; see ./safety).
        const inPlace = opts.isolation !== "worktree";
        if (inPlace && (permissions.tier === "edit" || permissions.tier === "full")) await ctx.safety?.before();
        const startedEv = event(AGENT_STARTED, {
          agentId,
          label: display,
          phase: activePhase,
          adapter: adapter.name,
          ...permissionField(permissions.tier ?? permissions.requested),
          ...trustField(trust),
          ...sandboxField(sandbox && sandboxView(sandbox)),
          // The limits it runs under on this adapter, if any (ODW extension; see ./limits).
          ...limitsField(ctx.bridge.limitsFor?.(adapter, ownLimits)),
          // The files it declared it means to change (ODW extension; see ./scope).
          ...(scope ? { scope: scope.globs.map(({ glob }) => glob) } : {}),
          // What `odw compare` matches and shows it by (ODW extension): its
          // resume key, and the model it asked for (a tier keeps its @ name).
          key,
          ...(model !== undefined ? { model } : {}),
          ...(base ? { base } : {}),
        });
        ctx.emit(startedEv);
        // What it was asked, for `odw replay` (ODW extension).
        saveCall({ agentId, label: display, phase: activePhase, prompt, adapter: adapter.name, model: model ?? null, ...(base ? { base } : {}) }, opts);
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
        // The destructive git commands its CLI runs are said as they show (ODW extension; see ./destructive-git).
        const gitWatch = destructiveGitWatch(agentId, display, activePhase, !inPlace);
        const scoping = scope && claim ? { plan: scope, claim, note } : undefined;
        const expect = expectations(checks, agentId, display, activePhase, signal, scoping);
        // Without `expect`, its scope has a reader of its own (ODW extension; see ./scope).
        const watch = scoping && !expect ? scopeWatch(scope!, claim!, signal, note) : undefined;
        const judged = expect ?? watch;
        const outsideOf = (): { outOfScope?: string[] } =>
          scope ? reportOutOfScope(judged?.outOfScope, scope, { agentId, label: display, phase: activePhase }, notesOn, note) : {};
        // The run's notes board (ODW extension): the notes so far go in its
        // prompt as it starts; what it posts is taken until it ends.
        const notes = notesOn ? openNotes(agentId, display, memoryOn) : undefined;
        // What earlier runs of the workflow learned goes ahead of its task (ODW extension; see ./memory).
        const recalled = memoryOn ? recallMemory() : "";
        // The misses its `expect` retries were told of: met by the attempt that stood, they are a lesson.
        const missed: string[] = [];
        let outcome;
        try {
          const pinned: AgentRequest = base ? { ...request, base } : request;
          const told = recalled ? { ...pinned, memory: recalled } : pinned;
          outcome = await ctx.bridge.run(notes ? { ...told, notes: notes.prompt } : told, {
            signal,
            // The agent process's ODW_AGENT_ID.
            agentId,
            ...(notes ? { notes: { env: notes.env, mounts: notes.mounts } } : {}),
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
                  // Structured for the run's readers: a span event of its OpenTelemetry trace (../otel).
                  retry: { reason: "stall", n: restart, of: maxRestarts },
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
                  retry: { reason: "rate_limit", n: retry, of: maxRetries, waitSeconds },
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
            // So is what its CLI prints (ODW extension), read for destructive git commands as it goes.
            transcript: teeTranscript(transcript, gitWatch),
            // Where it runs, as routed at dispatch: the adapter its slot is on (ODW extension).
            route,
            // A spent quota, a refused login or a model that is not there moved it down its chain (ODW
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
            // ...and with handoff on, it hands the work over (ODW extension;
            // see ./handoff): the brief is kept beside its transcript, and said.
            onHandoff: async ({ from, reason, to, brief, bytes }) => {
              let file: string | undefined;
              if (ctx.agentHandoffPath) {
                try {
                  file = ctx.agentHandoffPath(agentId);
                  await mkdir(dirname(file), { recursive: true });
                  await writeFile(file, brief.endsWith("\n") ? brief : `${brief}\n`, "utf8");
                } catch (err) {
                  file = undefined;
                  note(`could not keep its handoff brief: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              ctx.emit(
                event(HANDOFF, {
                  agentId,
                  label: display,
                  phase: activePhase,
                  from,
                  to,
                  reason,
                  bytes,
                  ...(file ? { saved: true } : {}),
                }),
              );
            },
            // Its chain out of quota, it waits for a reset (ODW extension:
            // quotaWait) holding no slot — and says so — then takes a slot
            // again on the adapter it starts over on; a line that names the
            // adapters it left moves it, for every reader of the run.
            onQuotaWait: ({ adapter: name, resumeAt }) => {
              ctx.emit(
                event(LOG, {
                  message: `${display}:${agentId} waits for ${name}'s quota to reset (quotaWait)`,
                  agentId,
                  label: display,
                  phase: activePhase,
                  adapter: name,
                  reason: "quota",
                  // Structured for the run's views: this agent waits, holding no slot, until then.
                  quotaWait: "start",
                  resumeAt,
                }),
              );
              slot.release();
            },
            onQuotaResume: async ({ adapter: name, fellBackFrom: left }) => {
              fellBackFrom.splice(0, fellBackFrom.length, ...left);
              onAdapter = name;
              ctx.emit(
                event(LOG, {
                  message: `${display}:${agentId} goes on after the quota wait, on ${name}`,
                  agentId,
                  label: display,
                  phase: activePhase,
                  adapter: name,
                  quotaWait: "end",
                  ...(left.length > 0 ? { fellBackFrom: [...left] } : {}),
                }),
              );
              await slot.moveTo(name);
            },
            // Its work is checked against its `expect` (ODW extension), and a
            // miss that earns a retry is logged with what it missed.
            expect,
            ...(watch ? { scopeWatch: watch } : {}),
            onExpectRetry: ({ misses, retry, maxRetries }) => {
              for (const miss of misses) if (!missed.includes(miss)) missed.push(miss);
              ctx.emit(
                event(LOG, {
                  message:
                    `${display}:${agentId} did not meet its expectations — running it again, told what it missed ` +
                    `(${retry}/${maxRetries}): ${misses.join("; ")}`,
                  misses,
                  agentId,
                  label: display,
                  phase: activePhase,
                  retry: { reason: "expect", n: retry, of: maxRetries },
                }),
              );
            },
            // A question it stopped to ask (ODW extension; see ./questions) is put
            // to a person as a checkpoint — holding no slot while it waits —
            // and their answer runs it again, said in the log.
            onQuestion: async ({ adapter: name, questions, round }) => {
              if (!ctx.control.awaitDecision) return { declined: "this run has no way to ask anyone (no decision channel)" };
              slot.release();
              let result: CheckpointResult;
              try {
                result = await ask(
                  questionTitle(display, questions),
                  { payload: { agent: display, agentId, adapter: name, questions, answer: "" }, memory: false },
                  { agentId, label: display, adapter: name, questions },
                );
              } finally {
                // Its slot back, on the adapter it asked on, before its CLI runs again.
                await slot.moveTo(name);
              }
              const by = result.who ? ` by ${result.who}` : "";
              if (!result.approved) {
                return { declined: `the question was declined${by}${result.note?.trim() ? `: ${result.note.trim()}` : ""}` };
              }
              const answer = answerOf(result);
              ctx.emit(
                event(LOG, {
                  message:
                    `${display}:${agentId} was answered${by} — running it again, told the answer` +
                    (answer === null ? " (none given: it is told to assume)" : ""),
                  agentId,
                  label: display,
                  phase: activePhase,
                  // Structured for the run's readers: a span event of its OpenTelemetry trace (../otel).
                  retry: { reason: "question", n: round, of: MAX_QUESTION_ROUNDS },
                }),
              );
              return { answer };
            },
            // The MCP servers a CLI run started it without (ODW extension): kept
            // for its record, and each server and status said once per run.
            onMcp: ({ adapter: name, servers }) => {
              mcpSeen = servers;
              for (const server of servers) {
                const key = `${server.name}\u0000${server.status}`;
                if (notedMcp.has(key)) continue;
                notedMcp.add(key);
                ctx.emit(
                  event(LOG, {
                    message: mcpNote(server, name, display),
                    mcp: [{ ...server }],
                    agentId,
                    label: display,
                    phase: activePhase,
                    adapter: name,
                  }),
                );
              }
            },
          });
          // Under destructiveGit: "fail", a destructive git command fails it once its CLI is done (ODW extension).
          if (gitWatch.hits.length > 0 && ctx.config.settings.destructiveGit === "fail") throw destructiveGitError(gitWatch);
        } catch (err) {
          // Out of rate-limit retries (or allowed none): that lowers its adapter's cap too.
          if (err instanceof AdapterExecutionError && err.reason === "rate_limit") slot.rateLimited();
          // A started agent always gets a terminal event, even when the error
          // is fatal (stop, budget, a config error raised inside the slot) —
          // else observers show it running forever. A failed agent's change
          // is kept too (the work of one that timed out); a person's stop
          // keeps none. The run's deadline keeps what an agent it killed had
          // changed so far, marked `partial` (ODW extension: `--deadline`).
          // Its transcript is kept either way, complete before the event.
          await transcript?.close();
          notes?.close();
          const deadline = isDeadlineStop(err) || (signal.aborted && isDeadlineStop(signal.reason));
          const stopped = isFatalError(err) || signal.aborted;
          const kept = await keepChanges(changes, stopped && !deadline, note);
          failed(err, kept, stopped ? (deadline && kept ? { partial: true } : {}) : outsideOf());
          throw err;
        }
        await transcript?.close();
        notes?.close();
        const kept = await keepChanges(changes, false, note);
        // Its interface changes go on the board before it is seen to finish (ODW extension).
        if (notes && kept) await broadcast(agentId, display, kept, note);
        // What a retry met that an earlier attempt missed is a lesson for later runs (ODW extension; see ./memory).
        if (memoryOn && missed.length > 0) learnLesson(display, missed, outcome.attempts, kept);
        // So do its writes outside its declared scope, said in the log too (ODW extension).
        const outside = outsideOf();
        // No option is dropped silently: surface each routing note as a LOG event
        // (visible in `odw logs` and the dashboard).
        for (const routing of outcome.notes ?? []) {
          ctx.emit(event(LOG, { message: routing, label: display, phase: activePhase }));
        }
        // Tool calls its CLI refused under a reply that stands (ODW extension):
        // said once, and kept with the agent — its work may lack them. The CLI
        // named is the one that produced the reply, after any fallback.
        if (outcome.denied?.length) {
          const producer = ctx.config.adapters[outcome.adapter] ?? adapter;
          ctx.emit(
            event(LOG, {
              message: refusedNote(`${display}:${agentId}`, adapterDisplayName(producer), outcome.denied),
              denied: outcome.denied,
              agentId,
              label: display,
              phase: activePhase,
            }),
          );
        }
        // Background work its CLI left running when it replied (ODW extension):
        // said once, and kept with the agent — it died unfinished.
        if (outcome.orphaned?.length) {
          const producer = ctx.config.adapters[outcome.adapter] ?? adapter;
          ctx.emit(
            event(LOG, {
              message: orphanedNote(`${display}:${agentId}`, adapterDisplayName(producer), outcome.orphaned),
              orphaned: outcome.orphaned,
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
          ...mcpField(outcome.mcp),
          ...orphanedField(outcome.orphaned),
          ...outside,
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
          ...trustField(trust),
          ...changeFields(kept),
          ...deniedField(outcome.denied),
          ...mcpField(outcome.mcp),
          ...orphanedField(outcome.orphaned),
          ...outside,
        });
        if (persisted) finished.saved = true;
        ctx.emit(finished);
        return outcome.value;
      }, { adapter: adapter.name, gate: route.start < 0 || turn?.gate || claim?.blocked ? ready : undefined });
    } catch (err) {
      // A fatal error before the start (stop or budget at dispatch) concerns
      // the run, not this agent; anything else is still this agent's failure.
      if (!started && !isFatalError(err)) failed(err);
      throw err;
    } finally {
      // However a leader of a staggered fan-out ended, the agents it held may go.
      turn?.settled();
      // So may the calls waiting for its scope (ODW extension).
      claim?.release();
      // A call routed across accounts that never ran no longer counts on one (ODW extension: accounts).
      ctx.bridge.releaseRoute?.(route);
    }
  };

  /**
   * An agent() with a `costGate` (ODW extension): its forecast, and its gate,
   * before it is dispatched — unless a resume replays it, which costs nothing.
   */
  const agentGate = async (prompt: string, opts: AgentOptions): Promise<void> => {
    const gate = readCostGate(opts.costGate, "agent(): costGate", (m) => new AgentError(m));
    if (!gate) return;
    if (ctx.replay && ctx.replay.has(resumeKey(prompt, opts))) return;
    const phase = opts.phase !== undefined ? opts.phase : ctx.currentPhase;
    await forecastFanOut("agent()", 1, 1, gate, phase, opts.label ?? null);
  };

  const agent = (prompt: string, opts: AgentOptions = {}): Promise<unknown> =>
    held(opts?.label, () => (opts?.costGate === undefined ? dispatch(prompt, opts) : agentGate(prompt, opts).then(() => dispatch(prompt, opts)))).catch((err: unknown) => {
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
   * What a fan-out is forecast to cost, before it starts (ODW extension; see
   * ./forecast): logged when it is at least `fanOutWarn` wide or a cost gate
   * covers it — `option` (null lifts it), else the `costGate` setting for a
   * parallel() or pipeline(). A forecast over the gate asks a person first,
   * as a checkpoint(); a rejection throws a CostGateRejected. Without
   * history the gate lets it through, and says so once per run. Undefined —
   * synchronously, so the fan-out starts as it always did — when there is
   * nothing to forecast.
   */
  const forecastFanOut = (
    call: "parallel()" | "pipeline()" | "agent()",
    width: number,
    agents: number,
    option: CostGate | null | undefined,
    phase: string | null,
    label: string | null = null,
  ): Promise<void> | undefined => {
    const gate = option !== undefined ? option : call === "agent()" ? null : (ctx.config.settings.costGate ?? null);
    const limit = ctx.config.settings.fanOutWarn;
    if (width === 0 || (!gate && !(call !== "agent()" && limit && width >= limit))) return undefined;
    return forecastAndGate(call, width, agents, gate, phase, label);
  };

  const forecastAndGate = async (
    call: "parallel()" | "pipeline()" | "agent()",
    width: number,
    agents: number,
    gate: CostGate | null,
    phase: string | null,
    label: string | null,
  ): Promise<void> => {
    const once = (key: string, message: string): void => {
      const said = (ctx.costNotes ??= new Set<string>());
      if (said.has(key)) return;
      said.add(key);
      ctx.emit(event(LOG, { message, ...(gate ? { costGate: gate.usd } : {}) }));
    };
    let history: CostHistory | null = null;
    try {
      history = ctx.costHistory?.() ?? null;
    } catch (err) {
      once("unreadable", `could not read this workflow's earlier runs for a cost forecast: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!history) {
      if (gate) once("history", "costGate: no forecast — no finished runs of this workflow yet, so the gate lets fan-outs through");
      return;
    }
    const forecast = history.forecast(call, width, agents, phase, label);
    if (!forecast) {
      if (gate) {
        once(
          `phase:${phase ?? ""}`,
          `costGate: no forecast for phase ${phase === null ? "(none)" : JSON.stringify(phase)} — no agent of it in earlier runs reported a cost, so the gate lets it through`,
        );
      }
      return;
    }
    const what =
      call === "agent()" ? "agent()" : call === "parallel()" ? `parallel() of ${width} tasks` : `pipeline() of ${width} items (${agents} agents)`;
    const from = forecast.basis === "label" ? `agents labelled ${JSON.stringify(forecast.label)}` : "agents";
    const where = phase === null ? "" : ` in phase ${JSON.stringify(phase)}`;
    ctx.emit(
      event(LOG, {
        message:
          `cost forecast: ${what}${where} ~${fmtUsd(forecast.usd)} (p90 ${fmtUsd(forecast.p90Usd)}) — ${agents} × ${fmtUsd(forecast.perAgentUsd.p50)} ` +
          `per agent, the median of ${forecast.perAgentUsd.n} ${from} of ${forecast.runs} earlier run${forecast.runs === 1 ? "" : "s"}` +
          `${forecast.match === "name" ? " (of another source)" : ""}; it assumes they cost what those did`,
        forecast,
        ...(gate ? { costGate: gate.usd } : {}),
      }),
    );
    if (!gate || forecast.usd <= gate.usd) return;
    const title = costGateTitle(forecast);
    if (!ctx.control.awaitDecision) {
      throw new CostGateRejected(`${title} — nobody can be asked in this run (no decision channel), so it did not start`, forecast, null);
    }
    const answer = await checkpoint(title, { payload: { width, forecast }, memory: false });
    if (answer.approved) return;
    throw new CostGateRejected(
      `${what}: its cost gate (${fmtUsd(gate.usd)}) was rejected${answer.note ? ` — ${answer.note}` : ""}; it did not start`,
      forecast,
      answer.note,
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

  const parallel = async <T>(thunks: Array<Thunk<T>>, opts?: ParallelOptions): Promise<Array<T | null>> => {
    if (!Array.isArray(thunks)) {
      throw new WorkflowScriptError(`parallel() takes an array of functions (thunks); got ${describeValue(thunks)}`);
    }
    // ODW extension: options after the thunks — `notes` (see ./notes) and `costGate` (see ./forecast).
    if (opts !== undefined && (opts === null || typeof opts !== "object" || Array.isArray(opts))) {
      throw new WorkflowScriptError(`parallel()'s options must be an object — { notes?: boolean, costGate?: { usd } }; got ${describeValue(opts)}`);
    }
    for (const key of Object.keys(opts ?? {})) {
      if (key !== "notes" && key !== "costGate") throw new WorkflowScriptError(`parallel() has no option "${key}"; use notes or costGate`);
    }
    if (opts?.notes !== undefined && typeof opts.notes !== "boolean") {
      throw new WorkflowScriptError(`parallel(): notes must be true or false; got ${describeValue(opts.notes)}`);
    }
    const gate =
      opts?.costGate === undefined ? undefined : readCostGate(opts.costGate, "parallel(): costGate", (m) => new WorkflowScriptError(m));
    thunks.forEach((thunk, i) => {
      if (typeof thunk !== "function") {
        throw new WorkflowScriptError(
          `parallel() takes functions (thunks), but element ${i} is ${describeValue(thunk)} — ` +
            "wrap each call as () => agent(...) so parallel() can schedule it",
        );
      }
    });
    warnFanOut("parallel()", thunks.length);
    const forecasting = forecastFanOut("parallel()", thunks.length, thunks.length, gate, ctx.currentPhase);
    if (forecasting) await forecasting;
    const batch = (): Promise<Array<T | null>> =>
      asFanOut(() => ctx.scheduler.gather(
        thunks.map((thunk, i) => async () => {
          try {
            return await thunk();
          } catch (err) {
            noteSwallowed(err, `parallel() thunk ${i}`);
            throw err;
          }
        }),
      ));
    // Every agent its thunks start — through any await — has notes on or off as it says.
    return opts?.notes === undefined ? batch() : notesScope.run(opts.notes, batch);
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
    // A pipeline() takes no options: the `costGate` setting covers it.
    const forecasting = forecastFanOut("pipeline()", items.length, items.length * Math.max(1, stages.length), undefined, ctx.currentPhase);
    if (forecasting) await forecasting;
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
    // `--break`/`--step` (ODW extension; see ./breaks): the phase's work waits for a decision.
    if (ctx.breaks?.atPhase(title, labelled)) {
      const breaks = ctx.breaks;
      breaks.hold(() => atPhase(labelled, () => askBreak(`Break before phase ${labelled}`, { phase: labelled })));
    }
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
    // In the run's script context (ODW extension; see ./script-context): a strict run's child is strict too.
    const loaded = loadWorkflowScript(text, scriptPath, { context: ctx.config.settings.scriptContext ?? "host" }); // throws on a syntax error
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
  // An agent's question (ODW extension; see ./questions) asks through it too, with who asked.
  const ask = createCheckpoint(ctx);
  const checkpoint = (title: string, opts?: CheckpointOptions): Promise<CheckpointResult> =>
    ask(title, opts).catch((err: unknown) => {
      if (isFatalError(err)) ctx.scheduler.abort(err);
      throw err;
    });

  /**
   * The checkpoint a run with untrusted input asks before its first agent that
   * may write (ODW extension; see ./untrusted-input): asked once per run, and
   * its answer stands for every later such agent. A refusal — or a run with
   * nobody to ask — fails those agents with UntrustedInputRejected (recoverable).
   */
  const writeGate = (label: string, tier: PermissionTier): Promise<void> => {
    const input = ctx.input!;
    input.writeGate ??= (async () => {
      const { why, args } = input.meta;
      const title = `Untrusted input (${why}): let agents that may write (${tier}) run?`;
      if (!ctx.control.awaitDecision) {
        throw new UntrustedInputRejected(`${title} — nobody can be asked in this run (no decision channel), so no agent that may write starts`);
      }
      const answer = await checkpoint(title, { payload: { untrustedInput: { why, args }, agent: label, permissions: tier }, memory: false });
      if (!answer.approved) {
        throw new UntrustedInputRejected(
          `untrusted input (${why}): agents that may write were refused${answer.note ? ` — ${answer.note}` : ""}; this one did not start`,
        );
      }
    })();
    return input.writeGate;
  };

  /** Run `fn` with the phase cursor at `phase`: what a call reads as it starts. */
  const atPhase = <T>(phase: string | null, fn: () => T): T => {
    const saved = ctx.currentPhase;
    ctx.currentPhase = phase;
    try {
      return fn();
    } finally {
      ctx.currentPhase = saved;
    }
  };

  /**
   * Start a call — at once when no break holds it, else once the breaks in
   * its way are answered (ODW extension; see ./breaks), in the phase it was
   * called in. `label`: an agent()'s, which may have a break of its own.
   */
  function held<T>(label: string | undefined, fn: () => Promise<T>): Promise<T> {
    const wait = ctx.breaks?.before(label, () => askBreak(`Break before agent ${label}`, { agent: label! }));
    if (!wait) return fn();
    const phase = ctx.currentPhase;
    return wait.then(() => atPhase(phase, fn));
  }

  /**
   * Ask a break's checkpoint (ODW extension; see ./breaks): the run so far as
   * its payload; a rejection stops the run, an approval with edited `args`
   * changes the run's args in place.
   */
  const askBreak = async (title: string, before: { phase: string } | { agent: string }): Promise<void> => {
    const payload = { before, ...breakState(), args: ctx.args };
    const result = await checkpoint(title, { payload, memory: false });
    if (!result.approved) {
      const stop = new RunStopped(`rejected at the ${title.charAt(0).toLowerCase()}${title.slice(1)}${result.note ? `: ${result.note}` : ""}`);
      ctx.scheduler.abort(stop);
      throw stop;
    }
    if (!result.edited) return;
    const taken = applyArgsEdit(ctx.args, result.payload);
    const message =
      "refused" in taken
        ? `${title}: approved with an edit, but its args were not taken — ${taken.refused}; the run goes on with the args it had`
        : taken.changed.length === 0
          ? `${title}: approved with an edit that leaves args as they were (only args are taken from it)`
          : `${title}: approved with edited args — what the script reads from now on sees ${taken.changed.map((key) => `args.${key}`).join(", ")} changed ` +
            "(what it read before the answer, such as the prompt of a call the break held, keeps the old value; odw rerun and resume start from the original args)";
    ctx.emit(event(LOG, { message, ...("refused" in taken ? {} : { argsEdited: taken.changed }) }));
  };

  /** The run so far, for a break's payload. */
  const breakState = (): Record<string, unknown> => {
    try {
      return { ...(ctx.breaks?.soFar?.() ?? {}) };
    } catch (err) {
      return { soFar: `[could not be read: ${err instanceof Error ? err.message : String(err)}]` };
    }
  };

  return {
    agent: (prompt, opts) => handled(agent(prompt, opts)),
    parallel: (thunks, opts) => handled(parallel(thunks, opts)),
    pipeline: (items, ...stages) => handled(pipeline(items, ...stages)),
    phase,
    log,
    budget,
    // `workflow.input` (ODW extension; see ./untrusted-input): whether the run's args came from outside.
    workflow: Object.assign((nameOrRef: string | { scriptPath: string }, childArgs?: unknown) => handled(held(undefined, () => workflow(nameOrRef, childArgs))), {
      input: workflowInput(ctx.input?.meta ?? null),
    }),
    validate,
    exec: (command, opts) => handled(held(undefined, () => exec(command, opts))),
    checkpoint: (title, opts) => handled(held(undefined, () => checkpoint(title, opts))),
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

/** The `sandbox` field an agent's start event carries when its CLI runs in a container (ODW extension; absent: on the host). */
function sandboxField(view: SandboxView | null): { sandbox?: SandboxView } {
  return view ? { sandbox: view } : {};
}

/** The `limits` field an agent's start event carries when it runs under any (ODW extension; see ./limits). */
function limitsField(limits: AgentLimits | undefined): { limits?: AgentLimits } {
  return hasLimits(limits) ? { limits: { ...limits } } : {};
}

/** The `trust` field an agent's start event and record carry when its CLI runs untrusted (ODW extension; absent: trusted). */
function trustField(trust: TrustLevel): { trust?: TrustLevel } {
  return trust === "untrusted" ? { trust } : {};
}

/**
 * The parallel() or pipeline() call an agent() runs in, if any: carried
 * through every await of its thunk or stage, so a staggered fan-out (an ODW
 * extension) knows its agents. Module-wide like `surfaced`, so a nested
 * workflow()'s agents belong to the fan-out that called it.
 */
const fanOutScope = new AsyncLocalStorage<FanOut>();

/**
 * Whether a parallel() call turned the notes board on (or off) for its
 * agents (an ODW extension; see ./notes), carried like `fanOutScope`.
 */
const notesScope = new AsyncLocalStorage<boolean>();

/** Runs (by their shared `seq`) that said they have no notes board, so it is said once. */
const notesUnavailable = new WeakSet<object>();

/** Runs (by their shared `seq`) that said they have no workflow memory, so it is said once (ODW extension). */
const memoryUnavailable = new WeakSet<object>();

/** The `fellBackFrom` an agent's agent_finished event and record carry when it fell back (ODW extension). */
function fallbackField(fellBackFrom: string[] | undefined): { fellBackFrom?: string[] } {
  return Array.isArray(fellBackFrom) && fellBackFrom.length > 0 ? { fellBackFrom: [...fellBackFrom] } : {};
}

/** The `outOfScope` an agent's terminal event and record carry: what it changed outside its declared scope, when anything (ODW extension). */
function outOfScopeField(outside: unknown): { outOfScope?: string[] } {
  if (!Array.isArray(outside)) return {};
  const paths = outside.filter((path): path is string => typeof path === "string");
  return paths.length > 0 ? { outOfScope: paths } : {};
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

/** The `mcp` an agent's terminal event and record carry: the MCP servers its CLI started it without, when any (ODW extension). */
function mcpField(servers: unknown): { mcp?: McpServer[] } {
  if (!Array.isArray(servers)) return {};
  const down = servers
    .filter((s): s is McpServer => typeof s?.name === "string" && typeof s?.status === "string")
    .map(({ name, status }) => ({ name, status }));
  return down.length > 0 ? { mcp: down } : {};
}

/**
 * The one line a run logs, once, for an MCP server an agent's CLI started it
 * without (ODW extension): "MCP server github failed to start (claude agent
 * `fix-auth`): its tools were unavailable".
 */
function mcpNote(server: McpServer, adapter: string, label: string): string {
  const who = `(${adapter} agent \`${label}\`)`;
  switch (server.status) {
    case "failed":
      return `MCP server ${server.name} failed to start ${who}: its tools were unavailable`;
    case "needs-auth":
      return `MCP server ${server.name} needs authentication ${who}: its tools were unavailable — sign in to it (/mcp in claude)`;
    case "disabled":
      return `MCP server ${server.name} is disabled ${who}: its tools were unavailable`;
    case "pending":
      return `MCP server ${server.name} was still connecting when the agent started ${who}: its tools came only once it connected, if it did`;
    default:
      return `MCP server ${server.name} was ${JSON.stringify(server.status)}, not connected ${who}: its tools may have been unavailable`;
  }
}

/** The `orphaned` an agent's agent_finished event and record carry: the background work its CLI left running, when any (ODW extension). */
function orphanedField(orphaned: unknown): { orphaned?: string[] } {
  if (!Array.isArray(orphaned)) return {};
  const work = orphaned.filter((line): line is string => typeof line === "string");
  return work.length > 0 ? { orphaned: work } : {};
}

/**
 * The one line a run logs for an agent whose reply stood though its CLI left
 * background work running (`orphanedBackground: "warn"`; ODW extension).
 */
function orphanedNote(who: string, cli: string, orphaned: string[]): string {
  const work = orphaned.length === 1 ? "1 background task" : `${orphaned.length} background tasks`;
  const shown = orphaned.slice(0, REFUSED_SHOWN).join("; ");
  const more = orphaned.length > REFUSED_SHOWN ? `; and ${orphaned.length - REFUSED_SHOWN} more` : "";
  return (
    `${who}: ${cli} ended its turn with ${work} still running — ${shown}${more}; it died when the CLI exited, ` +
    "so its reply may rest on work that never finished (orphanedBackground: \"fail\" fails such an agent)"
  );
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
/**
 * One transcript sink for the bridge from two (ODW extension): an agent's
 * transcript, kept when the run keeps them, and its destructive-git watch.
 */
function teeTranscript(transcript: TranscriptRecorder | undefined, watch: DestructiveGitWatch): TranscriptSink {
  if (!transcript) return watch;
  return {
    beginRun: (reason, adapter) => {
      transcript.beginRun(reason, adapter);
      watch.beginRun(reason, adapter);
    },
    stdout: (chunk) => {
      transcript.stdout(chunk);
      watch.stdout(chunk);
    },
    stderr: (chunk) => transcript.stderr(chunk),
    endRun: (cli) => {
      transcript.endRun(cli);
      watch.endRun(cli);
    },
    handoff: (handoff) => transcript.handoff(handoff),
  };
}

/** How an agent that ran a destructive git command fails under `destructiveGit: "fail"` (ODW extension). */
function destructiveGitError(watch: DestructiveGitWatch): AdapterExecutionError {
  const more = watch.more > 0 ? `, and ${watch.more} more` : "";
  const commands = watch.hits.map((hit) => hit.command).join("; ");
  return new AdapterExecutionError(
    `it ran a destructive git command (${watch.summary()}): ${commands}${more} — destructiveGit: "fail" fails such an agent`,
    { reason: "destructive_git" },
  );
}

function failureFields(err: unknown): { reason?: string; retryAfter?: number; misses?: string[]; limitHit?: LimitHit; questions?: string[] } {
  if (!(err instanceof AdapterExecutionError)) return {};
  // The questions it asked nobody answered, one line each (ODW extension; see ./questions).
  if (err instanceof NeedsInputError) return { reason: err.reason, questions: err.questions.map(questionLine) };
  if (err instanceof UnmetExpectationError) return { reason: err.reason, misses: [...err.misses] };
  // The limit a runaway ran into, and the evidence (ODW extension; see ./limits).
  if (err instanceof RunawayError) return { reason: err.reason, limitHit: { ...err.hit } };
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
