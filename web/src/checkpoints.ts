/**
 * checkpoint() calls as graph nodes. The engine records them as events
 * (checkpoint_requested / checkpoint_resolved), not as agents, so the client
 * folds them into extra AgentView entries of kind "checkpoint" for the graph,
 * the timeline and the drawer: a run that waited for a person shows the gate
 * in its lane, and the bar shows how long it waited.
 *
 * The nodes are appended after the run's own agents, so an agent's index — the
 * graph's selection key — never shifts when a checkpoint appears.
 */
import type { AgentView, RunDetail, WorkflowEvent } from "./types";
import { TERMINAL } from "./util";

let memo: { run: RunDetail; events: WorkflowEvent[]; count: number; out: RunDetail } | null = null;

/** `run` with one node per checkpoint() its events mention (the same object when there are none). */
export function withCheckpoints(run: RunDetail, events: WorkflowEvent[]): RunDetail {
  if (memo && memo.run === run && memo.events === events && memo.count === events.length) return memo.out;
  const requested = new Map<number, WorkflowEvent>();
  const resolved = new Map<number, WorkflowEvent>();
  for (const e of events) {
    if (typeof e.checkpointId !== "number") continue;
    if (e.type === "checkpoint_requested") requested.set(e.checkpointId, e);
    else if (e.type === "checkpoint_resolved") resolved.set(e.checkpointId, e);
  }
  const ended = TERMINAL.has(run.state) || run.stale;
  const nodes: AgentView[] = [...requested.values()]
    .sort((a, b) => Number(a.checkpointId) - Number(b.checkpointId))
    .map((req) => {
      const id = Number(req.checkpointId);
      const res = resolved.get(id);
      const error = res && typeof res.error === "string" ? res.error : null;
      const state: AgentView["state"] = res
        ? error
          ? "failed"
          : res.approved
            ? "done"
            : "stopped"
        : ended
          ? "stopped"
          : "waiting";
      return {
        kind: "checkpoint",
        checkpointId: id,
        agentId: null,
        label: String(req.title ?? `checkpoint #${id}`),
        phase: req.phase != null ? String(req.phase) : null,
        state,
        adapter: null,
        attempts: null,
        error,
        startedAt: req.ts,
        finishedAt: res ? res.ts : null,
        durationMs: res ? Math.max(0, (res.ts - req.ts) * 1000) : null,
        payload: req.payload ?? null,
        decision:
          res && !error
            ? {
                approved: Boolean(res.approved),
                note: res.note != null ? String(res.note) : null,
                by: res.by != null ? String(res.by) : null,
                // Who answered, by name (ODW extension).
                who: typeof res.who === "string" && res.who !== "" ? res.who : null,
              }
            : null,
        // Approved with an edited payload (ODW extension): the event keeps what was approved.
        ...(res && !error && res.approved && res.edited === true ? { edited: true, approvedPayload: res.payload ?? null } : {}),
      };
    });
  const out = nodes.length ? { ...run, agents: [...run.agents, ...nodes] } : run;
  memo = { run, events, count: events.length, out };
  return out;
}
