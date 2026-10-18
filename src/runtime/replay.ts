/**
 * `odw replay <run> --agent <id|label>` (an ODW extension): one agent of an
 * earlier run, dispatched again on its own — to see what an edited prompt,
 * another adapter or another model does to that one step, without running
 * (or editing) the whole workflow.
 *
 * Every agent() call's inputs are saved as it starts (`agents/<id>.call.json`,
 * ../journal AgentCallRecord): its prompt and options as the script gave
 * them, the adapter it started on, the model it asked for and — isolated —
 * the commit its worktree checked out (also on its agent_started event, as
 * `base`). A replay is a small new run: an inline workflow of that one call,
 *
 *   return await agent(args.prompt, args.options)
 *
 * with `args.options` the saved options, its `label` and `phase` the
 * original's (so `odw compare` matches the two by label), its `adapter` the
 * one the original asked for — else the one it started on — and its `model`
 * likewise; `--prompt`, `--adapter` and `--model` replace them. It runs in the
 * original's source directory, with its config, permission tier, trust,
 * untrusted input and sandbox — and, the original triggered, strict. An isolated agent's worktree checks out the original's base
 * commit, whatever HEAD is now (the run's `worktreeBase`), so the replay sees
 * the code the original saw.
 *
 * The run's meta.json says what it replays: `origin: "replay"` and
 * `replayOf: { runId, agentId, label, base? }`. The call itself — the prompt
 * and options, `args` to the workflow above — is kept in the run directory as
 * `call.json`, which its worker reads and nothing serves; meta.json's `args`
 * are `{ replayOf }` only, since a run's args are served (with token-shape
 * redaction alone) and a prompt is the user's whole input. It is a run like any other —
 * `odw status`, `logs --agent`, `diff`, `apply` and the dashboard work on it —
 * and `odw compare <source> <replay> --agent <label>` puts the two side by side.
 */

import { readFileSync } from "node:fs";

import { loadConfig, resolveAdapter } from "../adapters/config.js";
import { isPermissionTier } from "../adapters/permissions.js";
import { sandboxFlagOf } from "../adapters/sandbox.js";
import type { PermissionTier, TrustLevel } from "../adapters/types.js";
import type { AgentCallRecord } from "../journal.js";
import { untrustedInputOf } from "../untrusted-input.js";
import { isCommitId } from "../workspace.js";
import { startRunFromSource, type StartRunOptions } from "./launcher.js";
import type { ReplayLink, RunStore } from "./run-store.js";

/** The replay's workflow: the one saved call, with the options it is given. */
export const REPLAY_WORKFLOW = `export const meta = {
  name: 'replay',
  description: 'odw replay: one agent of an earlier run, dispatched again (ODW extension)',
}
return await agent(args.prompt, args.options)
`;

/** A replay that cannot start: the message says why (the CLI prints it, exit 1). */
export class ReplayError extends Error {}

/** What `--prompt`, `--adapter` and `--model` replace; absent: the original's. */
export interface ReplayOverrides {
  prompt?: string;
  adapter?: string;
  model?: string;
  /** `--config`: the replay's config in place of the original run's. */
  configPath?: string;
}

/** A replay, planned: what the new run starts with, and what the CLI says about it. */
export interface PlannedReplay {
  args: { prompt: string; options: Record<string, unknown> };
  link: ReplayLink;
  start: StartRunOptions;
  /** One line each: what differs from the original, and what could not be kept. */
  notes: string[];
}

/**
 * Plan the replay of agent `agentId` of run `runId`: its saved call with the
 * overrides, and the run it starts as. Throws a {@link ReplayError} when the
 * agent saved no call (a run from before odw 0.7, or the save failed).
 */
export function planReplay(store: RunStore, runId: string, agentId: number, overrides: ReplayOverrides = {}): PlannedReplay {
  const call: AgentCallRecord | null = store.readAgentCall(runId, agentId);
  if (!call) {
    throw new ReplayError(
      `agent ${agentId} of run ${runId} has no saved call to replay (a run from before odw 0.7, or the save failed — see odw logs ${runId}); ` +
        `odw rerun ${runId} runs the whole workflow again`,
    );
  }
  const meta = store.readMeta(runId);
  const notes: string[] = [];
  const options: Record<string, unknown> = { ...call.options, label: call.label };
  if (call.phase !== null) options.phase = call.phase;
  else delete options.phase;
  // The adapter it asked for (a fallback chain stays one) — else the one it started on.
  const adapter = overrides.adapter ?? (options.adapter !== undefined ? options.adapter : call.adapter);
  if (adapter !== undefined && adapter !== null) options.adapter = adapter;
  if (overrides.adapter !== undefined) notes.push(`adapter: ${overrides.adapter} (the original ran on ${call.adapter ?? "the default"})`);
  const model = overrides.model ?? (options.model !== undefined ? options.model : call.model);
  if (model !== undefined && model !== null) options.model = model;
  if (overrides.model !== undefined) notes.push(`model: ${overrides.model} (the original asked for ${call.model ?? "the adapter's default"})`);
  const prompt = overrides.prompt ?? call.prompt;
  if (overrides.prompt !== undefined) notes.push(`prompt: replaced (${overrides.prompt.length} characters; the original had ${call.prompt.length})`);
  const link: ReplayLink = { runId, agentId, label: call.label };
  if (options.isolation === "worktree") {
    if (isCommitId(call.base)) {
      link.base = call.base;
      notes.push(`worktree: at the commit the original started from, ${call.base.slice(0, 12)}`);
    } else {
      notes.push("worktree: the original's base commit was not recorded — the replay starts from HEAD");
    }
  }
  const configPath = overrides.configPath ?? (typeof meta.configPath === "string" ? meta.configPath : null);
  const start: StartRunOptions = {
    // The prompt stays out of meta.json (served): the worker reads it from call.json.
    args: { replayOf: link },
    call: { prompt, options },
    configPath,
    runsRoot: store.root,
    source: typeof meta.source === "string" ? meta.source : null,
    // The run-level default the original had, or the override — checked against the config before anything starts.
    adapter: overrides.adapter ?? (typeof meta.adapter === "string" && meta.adapter !== "" ? meta.adapter : null),
    permissions: isPermissionTier(meta.permissions) ? (meta.permissions as PermissionTier) : null,
    trust: (meta.trust === "untrusted" ? "untrusted" : null) as TrustLevel | null,
    sandbox: sandboxFlagOf(meta.sandbox),
    budgetTotal: null,
    origin: "replay",
    replayOf: link,
    // Untrusted input stays untrusted on a replay, as on a rerun (ODW extension): nothing loosens it…
    untrustedInput: untrustedInputOf(meta),
    // …and a triggered run's replay keeps its strict script context.
    sourceOrigin: meta.origin === "trigger" || meta.sourceOrigin === "trigger" ? "trigger" : null,
  };
  return { args: { prompt, options }, link, start, notes };
}

/** Start a planned replay; returns the new run and the store it is in. */
export function startReplay(plan: PlannedReplay): { runId: string; store: RunStore } {
  // An adapter named for the call, not only the run's: fail fast on a name the config lacks.
  const named = plan.args.options.adapter;
  if (typeof named === "string") resolveAdapter(loadConfig(plan.start.configPath ?? null, { quiet: true }), named);
  return startRunFromSource(REPLAY_WORKFLOW, plan.start);
}

/** `--prompt`'s value: `@file` reads that file, anything else is the prompt itself. */
export function readPromptOption(value: string): string {
  if (!value.startsWith("@")) return value;
  try {
    return readFileSync(value.slice(1), "utf8");
  } catch (err) {
    throw new ReplayError(`--prompt ${value}: cannot read it: ${(err as Error).message}`);
  }
}
