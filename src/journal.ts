/**
 * The agent journal (L4): what a completed `agent()` call leaves behind, and
 * how `odw resume` replays it.
 *
 * Every successful agent() call is saved as an {@link AgentResultRecord} (the
 * worker writes it to the run directory's `agents/<agentId>.json`) before its
 * `agent_finished` event, so the work a run finished survives the run
 * stalling, being stopped, or its worker dying (issue #24). A resumed run
 * loads its source run's records into a {@link ReplayJournal}: an agent()
 * call whose {@link resumeKey} still has a record returns that saved value
 * instead of running the agent again.
 */

import { createHash } from "node:crypto";

import type { PermissionTier } from "./adapters/types.js";
import type { AgentChanges } from "./changes.js";
import type { AgentOptions } from "./primitives.js";

/**
 * One completed agent() call as saved. A wire contract: `odw result --agent`,
 * `GET /api/runs/:id/agents/:agentId` and the dashboard's agent drawer read it
 * as is.
 */
export interface AgentResultRecord {
  /** The call's per-run dispatch id — the `agentId` of its events. */
  agentId: number;
  /** The call's {@link resumeKey}: what a resume matches it by. */
  key: string;
  /** Display label, as in the call's events. */
  label: string;
  phase: string | null;
  /** The adapter that produced the value. */
  adapter: string | null;
  /** CLI runs it took (>1: schema retries). */
  attempts: number | null;
  /** Epoch seconds, like event `ts`. */
  startedAt: number | null;
  finishedAt: number | null;
  /** What agent() returned: the reply text, or the validated JSON value. */
  value: unknown;
  /** Replayed from an earlier run's record by `odw resume`; no agent ran. */
  cached?: boolean;
  /** For a replayed record: the run whose agent actually produced the value. */
  sourceRunId?: string | null;
  /**
   * What an isolated agent changed, when it changed anything (ODW extension):
   * the diffstat of its kept diff, `agents/<agentId>.diff`.
   */
  changes?: AgentChanges | null;
  /** The branch that change was committed to (`keep: true`, `keepBranches`), else null. */
  branch?: string | null;
  /** The permission tier its CLI ran at (ODW extension); absent in records from before tiers. */
  permissions?: PermissionTier;
}

/**
 * The resume key of an agent() call: sha256 (hex) of a stable JSON
 * serialization of the inputs that decide what the call produces. Each field
 * is in it for a reason:
 *
 *   - prompt     the task itself.
 *   - schema     the output contract: it is appended to the prompt and decides
 *                which replies validate, so an edited schema must run again.
 *   - adapter    the CLI AS REQUESTED (`opts.adapter`), not the resolved
 *                default: switching the run's default (`odw resume --adapter`,
 *                say after the first CLI stalled or ran out of quota) must
 *                still replay every call that did not name an adapter.
 *   - model      a different model is a different producer.
 *   - agentType  the persona is part of the effective prompt.
 *   - isolation  a worktree agent sees HEAD only and its edits stay in its
 *                kept diff; in place it sees, and edits, the working tree.
 *   - label      the author's name for the call: it tells otherwise identical
 *                calls apart (one prompt sampled as voter-1…voter-N), and a
 *                replayed record keeps the label `--agent <label>` looks up.
 *   - permissions the tier the call asked for (ODW extension): an agent held
 *                to read cannot make the change an edit one would. Like
 *                `adapter`, as requested — the run's tier is not in the key.
 *
 * `phase` is left out on purpose: it is display only (often ambient, from
 * phase(), and prefixed inside a nested workflow()), and regrouping progress
 * must not invalidate finished work. So is `keep`: it only decides whether an
 * isolated agent's change is also committed to a branch. An option left
 * undefined keys exactly like an absent one. Should this derivation ever
 * change, old records simply stop matching and their calls run again — the
 * safe direction.
 */
export function resumeKey(prompt: string, opts: AgentOptions): string {
  const inputs = {
    prompt,
    schema: opts.schema,
    adapter: opts.adapter,
    model: opts.model,
    agentType: opts.agentType,
    isolation: opts.isolation,
    label: opts.label,
    permissions: opts.permissions,
  };
  return createHash("sha256").update(stableJson(inputs)).digest("hex");
}

/**
 * JSON with every object's keys sorted, so equal values serialize identically
 * whatever order their keys were written in. Throws a TypeError on a circular
 * value (JSON has no representation for one either).
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, [])) ?? "null";
}

function sortKeys(value: unknown, path: object[]): unknown {
  if (value === null || typeof value !== "object") return value;
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === "function") return sortKeys(json.call(value), path);
  if (path.includes(value)) throw new TypeError("agent() options must be JSON data (found a circular reference)");
  path.push(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sortKeys(item, path));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key], path);
    }
    return out;
  } finally {
    path.pop();
  }
}

/**
 * The saved results of the run being resumed, queued per resume key in
 * agentId order (FIFO): the n-th call with a key gets the n-th record that key
 * produced, so a loop that asks the same thing several times replays each of
 * its answers once, in order. Calls past the queue (or with no queue) run.
 */
export class ReplayJournal {
  private readonly queues = new Map<string, AgentResultRecord[]>();
  private left = 0;

  constructor(
    /** The run being resumed (`meta.resumedFrom`). */
    readonly sourceRunId: string,
    records: Iterable<AgentResultRecord>,
    /** Where that run kept an agent's diff: a replayed isolated call brings it along. */
    readonly sourceDiffPath: ((agentId: number) => string) | null = null,
  ) {
    const usable = [...records].filter(isReplayable).sort((a, b) => a.agentId - b.agentId);
    for (const rec of usable) {
      const queue = this.queues.get(rec.key);
      if (queue) queue.push(rec);
      else this.queues.set(rec.key, [rec]);
    }
    this.left = usable.length;
  }

  /** Records not replayed (yet). */
  get size(): number {
    return this.left;
  }

  /** Take the next record saved under `key`, if one is left. */
  take(key: string): AgentResultRecord | undefined {
    const rec = this.queues.get(key)?.shift();
    if (rec) this.left--;
    return rec;
  }
}

/** A record a resume can trust: keyed, numbered, and carrying a value. */
function isReplayable(rec: AgentResultRecord): boolean {
  return (
    rec !== null &&
    typeof rec === "object" &&
    typeof rec.key === "string" &&
    Number.isSafeInteger(rec.agentId) &&
    "value" in rec
  );
}
