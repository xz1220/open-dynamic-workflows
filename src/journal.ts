/**
 * The agent journal (L4): what a completed `agent()` call leaves behind.
 *
 * Every successful agent() call is saved as an {@link AgentResultRecord} (the
 * worker writes it to the run directory's `agents/<agentId>.json`) before its
 * `agent_finished` event, so the work a run finished survives the run
 * stalling, being stopped, or its worker dying (issue #24). Each record
 * carries the call's {@link resumeKey}.
 */

import { createHash } from "node:crypto";

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
 *   - isolation  a worktree agent sees HEAD only and its edits are discarded;
 *                in place it sees, and edits, the working tree.
 *   - label      the author's name for the call: it tells otherwise identical
 *                calls apart (one prompt sampled as voter-1…voter-N), and a
 *                replayed record keeps the label `--agent <label>` looks up.
 *
 * `phase` is left out on purpose: it is display only (often ambient, from
 * phase(), and prefixed inside a nested workflow()), and regrouping progress
 * must not invalidate finished work. An option left undefined keys exactly
 * like an absent one. Should this derivation ever change, old records simply
 * stop matching and their calls run again — the safe direction.
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
