/**
 * The resolver runs of `odw apply --resolve` (an ODW extension; ./apply does
 * the git side: the temporary worktree, the checks, the verify, the apply).
 *
 * A resolver is a real run: an inline workflow of one isolated agent, started
 * in the temporary worktree like any background run, with `origin:
 * "apply-resolve"` and `applyResolve: { runId, agentId }` — the run and agent
 * whose conflicts it resolves — in its meta.json. So it is in `odw list` and
 * the dashboard, and `odw diff`, `odw logs --agent`, `odw compare` work on it:
 * the change it makes is the diff its agent keeps. The run being applied gets
 * the link back: `resolvedBy` in its meta.json, and an `apply_resolved` event
 * — `{ agentId, resolverRunId, outcome, why }`, outcome "applied", "refused",
 * "declined" or "interrupted" — once the resolution is applied or not.
 *
 * Its agent runs on the run-level adapter `--adapter` names, else the
 * config's default. Stopping odw (Ctrl-C) stops the resolver run too.
 */

import { APPLY_RESOLVED, event } from "../events.js";
import type { ResolveOptions, ResolverRun, ResolveRequest } from "./apply.js";
import { changedAgents } from "./changes-view.js";
import { startRunFromSource } from "./launcher.js";
import { RunObserver } from "./run-liveness.js";
import { JsonlSink, type RunStore } from "./run-store.js";

/** The resolver's workflow: one isolated agent, given the prompt ./apply wrote. */
export const RESOLVE_WORKFLOW = `export const meta = {
  name: 'apply-resolve',
  description: 'odw apply --resolve: resolve the conflicts of one agent\\'s change, in a temporary worktree (ODW extension)',
}
return await agent(args.prompt, { label: args.label, isolation: 'worktree' })
`;

/** How long a stopped resolver run is waited for before odw gives up on it. */
const STOP_WAIT_MS = 30_000;
const POLL_MS = 200;

export interface ResolverOptions {
  store: RunStore;
  /** The run being applied. */
  runId: string;
  configPath: string | null;
  /** `--adapter`: the resolver's adapter; null for the config's default. */
  adapter: string | null;
}

/** The dispatch and the bookkeeping of `--resolve`'s resolver runs, for ./apply's ResolveOptions. */
export function resolverRuns(o: ResolverOptions): Pick<ResolveOptions, "dispatch" | "settled"> {
  return {
    dispatch: (request) => dispatch(o, request),
    settled: ({ agentId, resolverRunId, outcome, why }) => {
      new JsonlSink(o.store.eventsPath(o.runId)).emit(event(APPLY_RESOLVED, { agentId, resolverRunId, outcome, why }));
    },
  };
}

async function dispatch(o: ResolverOptions, request: ResolveRequest): Promise<ResolverRun> {
  const { runId } = startRunFromSource(RESOLVE_WORKFLOW, {
    args: { prompt: request.prompt, label: `resolve:${request.label}` },
    configPath: o.configPath,
    runsRoot: o.store.root,
    source: request.source,
    adapter: o.adapter,
    origin: "apply-resolve",
    applyResolve: { runId: o.runId, agentId: request.agentId },
  });
  o.store.addResolvedBy(o.runId, { runId, agentId: request.agentId });
  request.started(runId);
  const status = await settle(o.store, runId, request.signal);
  const error = typeof status.error === "string" ? status.error : ((o.store.readError(runId)?.error as string | undefined) ?? null);
  const kept = changedAgents(o.store, runId)[0];
  return { runId, state: String(status.state ?? "unknown"), error, diff: kept?.file ?? null };
}

/** Wait until run `runId` ends; once `signal` fires, ask it to stop and wait a little longer. */
async function settle(store: RunStore, runId: string, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  const observer = new RunObserver(store, runId);
  let deadline: number | null = null;
  for (;;) {
    const observed = observer.read();
    if (observed.terminal) return observed.status;
    if (observed.error) return { ...observed.status, state: "failed", error: observed.error };
    if (signal?.aborted && deadline === null) {
      store.writeControl(runId, "stop");
      deadline = Date.now() + STOP_WAIT_MS;
    }
    if (deadline !== null && Date.now() >= deadline) return { ...observed.status, state: "stopping" };
    await new Promise<void>((done) => setTimeout(done, POLL_MS));
  }
}
