/**
 * The per-agent view behind `odw agents` and `odw result --agent` (L5).
 *
 * Every agent of a run — folded from its events, so running and failed ones
 * show too — joined with the results saved so far (`agents/<agentId>.json`).
 * Like every reader of the run directory it works on a live run: an agent's
 * result is there as soon as it finished, while its siblings still run, and it
 * stays there after the run stalls, is stopped, or its worker dies.
 */

import type { PermissionTier } from "../adapters/types.js";
import type { AgentChanges } from "../changes.js";
import type { AgentResultRecord } from "../journal.js";
import {
  displayWidth,
  fmtDuration,
  padEndWidth,
  palette,
  sanitizeText,
  truncateToWidth,
  type TermCaps,
} from "../tty.js";
import type { RunStore } from "./run-store.js";
import { detail, type AgentState } from "./runs-view.js";

export interface AgentRow {
  /** The engine's dispatch id (null only for pre-agentId event files). */
  agentId: number | null;
  state: AgentState;
  label: string;
  phase: string | null;
  adapter: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  /** Replayed from an earlier run by `odw resume`. */
  cached: boolean;
  error: string | null;
  /** The saved result, once the agent completed. */
  record: AgentResultRecord | null;
  /** What an isolated agent changed — its diff is agents/<agentId>.diff — and the branch it was kept on (ODW extension). */
  changes: AgentChanges | null;
  branch: string | null;
  /** The permission tier it runs at (ODW extension); null for runs from before tiers. */
  permissions: PermissionTier | null;
  /** The adapters it fell back from before `adapter` (ODW extension); null when it did not. */
  fellBackFrom: string[] | null;
}

/** A run's agents in call (agentId) order, each with its saved result if it has one. */
export function agentRows(store: RunStore, runId: string): AgentRow[] {
  const records = new Map(store.listAgentResults(runId).map((rec) => [rec.agentId, rec]));
  const rows: AgentRow[] = detail(store, runId).agents.map((a) => {
    const record = a.agentId !== null ? (records.get(a.agentId) ?? null) : null;
    if (a.agentId !== null) records.delete(a.agentId);
    return {
      agentId: a.agentId,
      // The record is written just before agent_finished: it already means done.
      state: record ? "done" : a.state,
      label: a.label,
      phase: a.phase,
      adapter: a.adapter ?? record?.adapter ?? null,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt ?? record?.finishedAt ?? null,
      durationMs: a.durationMs,
      cached: a.cached || record?.cached === true,
      error: a.error,
      record,
      changes: a.changes ?? record?.changes ?? null,
      branch: a.branch ?? record?.branch ?? null,
      permissions: a.permissions ?? record?.permissions ?? null,
      fellBackFrom: a.fellBackFrom ?? record?.fellBackFrom ?? null,
    };
  });
  // A saved result whose events were lost (a truncated log) is still listed.
  for (const rec of records.values()) rows.push(rowFromRecord(rec));
  // Stable: rows without an id (legacy events) keep their order, after the rest.
  return rows.sort((a, b) => (a.agentId ?? Infinity) - (b.agentId ?? Infinity));
}

function rowFromRecord(rec: AgentResultRecord): AgentRow {
  const { startedAt, finishedAt } = rec;
  return {
    agentId: rec.agentId,
    state: "done",
    label: rec.label,
    phase: rec.phase,
    adapter: rec.adapter,
    startedAt,
    finishedAt,
    durationMs: startedAt !== null && finishedAt !== null ? Math.max(0, Math.round((finishedAt - startedAt) * 1000)) : null,
    cached: rec.cached === true,
    error: null,
    record: rec,
    changes: rec.changes ?? null,
    branch: rec.branch ?? null,
    permissions: rec.permissions ?? null,
    fellBackFrom: rec.fellBackFrom ?? null,
  };
}

/** The agents `ref` names: the agent with that id (all digits), else every agent with that exact label. */
export function matchAgents(rows: AgentRow[], ref: string): AgentRow[] {
  if (/^\d+$/.test(ref)) {
    const byId = rows.filter((r) => r.agentId === Number(ref));
    if (byId.length > 0) return byId;
  }
  return rows.filter((r) => r.label === ref);
}

/** A value as one safe line: text as is, anything else as compact JSON, cut to `width` columns. */
export function previewValue(value: unknown, width: number): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  // Only the head can show; don't sanitize megabytes to print a line.
  return sanitizeText(text.slice(0, Math.max(256, width * 8)), width);
}

/** One `odw agents --json` row: the table's facts, the value only as a preview. */
export function agentRowJson(row: AgentRow): Record<string, unknown> {
  return {
    agentId: row.agentId,
    state: row.state,
    label: row.label,
    phase: row.phase,
    adapter: row.adapter,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    cached: row.cached,
    sourceRunId: row.record?.sourceRunId ?? null,
    // The tier it ran at (ODW extension), for runs that record one.
    ...(row.permissions ? { permissions: row.permissions } : {}),
    // The adapters it fell back from (ODW extension), when it did.
    ...(row.fellBackFrom ? { fellBackFrom: row.fellBackFrom } : {}),
    saved: row.record !== null,
    error: row.error,
    preview: row.record ? previewValue(row.record.value, 120) : null,
  };
}

/**
 * The `odw agents` table: ID, STATE (↺ when replayed), LABEL, PHASE, ADAPTER,
 * TIME (a running agent's age so far) and a one-line VALUE — the saved value,
 * or a failed agent's error — fitted to `width` columns.
 */
export function formatAgentTable(rows: AgentRow[], opts: { width: number; caps: TermCaps; nowMs?: number }): string[] {
  const p = palette(opts.caps);
  const replayed = opts.caps.unicode ? "↺" : "(r)";
  const nowSec = (opts.nowMs ?? Date.now()) / 1000;
  const time = (r: AgentRow): string => {
    if (r.state === "running" && r.startedAt !== null) return fmtDuration((nowSec - r.startedAt) * 1000);
    return r.durationMs === null ? "-" : fmtDuration(r.durationMs);
  };
  const cells = rows.map((r) => [
    r.agentId === null ? "-" : String(r.agentId),
    r.cached ? `${r.state} ${replayed}` : r.state,
    sanitizeText(r.label, 28),
    sanitizeText(r.phase ?? "-", 24),
    sanitizeText(r.adapter ?? "-", 16),
    time(r),
  ]);
  const header = ["ID", "STATE", "LABEL", "PHASE", "ADAPTER", "TIME"];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => displayWidth(c[i]!))));
  const valueWidth = Math.max(16, opts.width - widths.reduce((sum, w) => sum + w + 2, 0));
  const tint = (state: AgentState, s: string): string =>
    state === "done" ? p.ok(s) : state === "running" ? p.run(s) : state === "failed" ? p.err(s) : p.dim(s);
  const line = (c: string[], value: string, state?: AgentState): string => {
    // ID and TIME are right-aligned (both ASCII); the rest pad by display width.
    const padded = c.map((s, i) => (i === 0 || i === 5 ? s.padStart(widths[i]!) : padEndWidth(s, widths[i]!)));
    if (state) padded[1] = tint(state, padded[1]!);
    return truncateToWidth(`${padded.join("  ")}  ${value}`.trimEnd(), opts.width);
  };
  const out = [p.dim(line(header, "VALUE"))];
  rows.forEach((r, i) => {
    const value = r.record
      ? previewValue(r.record.value, valueWidth)
      : r.state === "failed"
        ? p.err(sanitizeText(r.error ?? "failed", valueWidth))
        : r.state === "done"
          ? p.dim("(not saved)")
          : "";
    out.push(line(cells[i]!, value, r.state));
  });
  return out;
}
