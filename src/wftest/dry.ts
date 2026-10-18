/**
 * What `odw run --dry` prints once its run has ended (an ODW extension): the
 * run's phase tree — each phase the workflow declared or started, in order,
 * with how many agents it started and their labels — then the agents that
 * ran outside any phase.
 */

import { AGENT_STARTED, PHASE_STARTED, type WorkflowEvent } from "../events.js";
import { sanitizeText } from "../tty.js";

export interface PhaseCount {
  /** null: agents outside any phase. */
  phase: string | null;
  agents: number;
  /** Each label and how many agents had it, in first-start order. */
  labels: Array<{ label: string; count: number }>;
}

/** The phases (declared first, then as started) and the agents each started. */
export function phaseCounts(events: WorkflowEvent[], declared: string[]): PhaseCount[] {
  const order: Array<string | null> = [...declared];
  const counts = new Map<string | null, PhaseCount>();
  const of = (phase: string | null): PhaseCount => {
    let entry = counts.get(phase);
    if (!entry) {
      entry = { phase, agents: 0, labels: [] };
      counts.set(phase, entry);
      if (!order.includes(phase)) order.push(phase);
    }
    return entry;
  };
  for (const phase of declared) of(phase);
  for (const ev of events) {
    if (ev.type === PHASE_STARTED && typeof ev.phase === "string") of(ev.phase);
    if (ev.type !== AGENT_STARTED) continue;
    const entry = of(typeof ev.phase === "string" ? ev.phase : null);
    entry.agents++;
    const label = typeof ev.label === "string" ? ev.label : "agent";
    const seen = entry.labels.find((l) => l.label === label);
    if (seen) seen.count++;
    else entry.labels.push({ label, count: 1 });
  }
  // Agents outside any phase come last.
  return [...order.filter((p) => p !== null), ...(counts.has(null) ? [null] : [])].map((p) => counts.get(p)!);
}

/** The tree as lines: a phase a line, its labels under it (box-drawing characters, or ASCII without `unicode`). */
export function formatPhaseTree(counts: PhaseCount[], unicode = true): string[] {
  const [mid, end, bar, times, dot] = unicode ? ["├─", "└─", "│  ", "×", "·"] : ["|-", "`-", "|  ", "x", "-"];
  const lines: string[] = [];
  counts.forEach((entry, i) => {
    const last = i === counts.length - 1;
    const name = entry.phase === null ? "(no phase)" : sanitizeText(entry.phase, 80);
    lines.push(`${last ? end : mid} ${name} ${dot} ${entry.agents} agent${entry.agents === 1 ? "" : "s"}`);
    entry.labels.forEach((l, j) => {
      lines.push(`${last ? "   " : bar}${j === entry.labels.length - 1 ? end : mid} ${sanitizeText(l.label, 80)}${l.count > 1 ? ` ${times}${l.count}` : ""}`);
    });
  });
  return lines;
}
