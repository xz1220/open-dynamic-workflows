/**
 * Breaks: `odw run <wf> --break <phase|label>[,…]` and `--step` (an ODW
 * extension) — a run that stops for a person before a phase, or before an
 * agent, without editing the workflow.
 *
 * A break is a checkpoint() the run asks by itself (./checkpoint), so
 * everything that answers a checkpoint answers it: `odw approve|reject`, the
 * dashboard's card, a signed approve link from a "waiting" notification. It
 * is titled "Break before phase <title>" (or "… agent <label>") and its
 * payload is the run so far:
 *
 *   { before: { phase } | { agent }, phasesDone: [titles], agents: { done,
 *     failed, running }, results: [{ agentId, label, phase, state, reply? |
 *     error? }] (the last 20, replies cut to 300 characters), args }
 *
 * Where it stops:
 *   - before a phase: phase(title) itself returns at once (it is not async
 *     in Claude Code's dialect), and the phase's work waits — every agent(),
 *     exec(), workflow() and checkpoint() the script calls from then on holds
 *     until the break is answered. Agents already running go on. `--step`
 *     breaks before every phase(); a name matches a phase's title, or its
 *     title inside a nested workflow() (`▸ child · title`).
 *   - before an agent: an agent() whose `label` a name matches holds until
 *     its break is answered; calls with that label made while it waits —
 *     a parallel() of them — share the one break.
 *
 * Answers:
 *   - approve: the run goes on.
 *   - reject: the run stops, as `odw stop` would stop it (state "stopped"),
 *     the break and its note named in the reason.
 *   - approve with an edited payload: only `args` is taken. The script got
 *     its `args` as an object when it started, and keeps that object; so
 *     when it is an object (or an array) and the edit keeps it one, the run
 *     changes that object in place — every read (`args.x`) made after the
 *     answer sees the edit. What the script read before keeps what it read:
 *     a value copied out at the top (`const { x } = args`), and — because
 *     phase() cannot wait — the arguments of the call the break holds (in
 *     `phase('Build'); await agent('fix ' + args.x)` the prompt is built
 *     before the break is answered; the next call reads the edit). That is
 *     the only safe way to change it: nothing is re-run, nothing already
 *     computed changes under the script. A string or number `args` cannot
 *     be changed in place, so such an edit is refused with a log line (the
 *     run goes on as it was). The edit lives in this run only: meta.json
 *     keeps the args the run started with, which `odw rerun` and `odw
 *     resume` start from.
 *
 * Names that never matched a phase or a label are said once the run is done.
 */

import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, PHASE_STARTED, type WorkflowEvent } from "./events.js";
import type { AgentResultRecord } from "./journal.js";
import { deepEqual } from "./schema.js";
import type { BreakSpec } from "./runtime/run-store.js";

/** The run so far, as a break's payload shows it (without `before` and `args`). */
export interface RunSoFar {
  phasesDone: string[];
  agents: { done: number; failed: number; running: number };
  results: Array<{ agentId: number; label: string; phase: string | null; state: "done" | "failed"; reply?: string; error?: string }>;
}

/** Results a break's payload lists, the latest; and characters of each reply. */
export const BREAK_RESULTS = 20;
export const BREAK_REPLY_CHARS = 300;

/**
 * The run so far from its events and saved results: the phases started
 * before the current one (the last started), how many agents finished,
 * failed and still run, and the latest results — a reply as text, cut.
 */
export function runSoFar(events: WorkflowEvent[], records: AgentResultRecord[]): RunSoFar {
  const phases: string[] = [];
  const started = new Set<number>();
  const ended: RunSoFar["results"] = [];
  const saved = new Map(records.map((rec) => [rec.agentId, rec]));
  for (const ev of events) {
    if (ev.type === PHASE_STARTED && typeof ev.phase === "string" && !phases.includes(ev.phase)) phases.push(ev.phase);
    if (typeof ev.agentId !== "number") continue;
    const agentId = ev.agentId;
    const who = { agentId, label: typeof ev.label === "string" ? ev.label : String(agentId), phase: typeof ev.phase === "string" ? ev.phase : null };
    if (ev.type === AGENT_STARTED) started.add(agentId);
    else if (ev.type === AGENT_FINISHED) ended.push({ ...who, state: "done", reply: preview(saved.get(agentId)?.value) });
    else if (ev.type === AGENT_FAILED) ended.push({ ...who, state: "failed", error: clip(String(ev.error ?? "failed")) });
  }
  const done = ended.filter((r) => r.state === "done").length;
  const failed = ended.length - done;
  return {
    phasesDone: phases.slice(0, -1),
    agents: { done, failed, running: Math.max(0, started.size - ended.length) },
    results: ended.slice(-BREAK_RESULTS),
  };
}

/** A saved reply as text, cut to BREAK_REPLY_CHARS. */
function preview(value: unknown): string {
  if (value === undefined) return "";
  return clip(typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));
}

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length <= BREAK_REPLY_CHARS ? text : chars.slice(0, BREAK_REPLY_CHARS - 1).join("") + "…";
}

/** The well-formed `breaks` of a run's meta.json, or null for a run without any. */
export function breakSpecOf(raw: unknown): BreakSpec | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const at = Array.isArray(r.at) ? r.at.filter((name): name is string => typeof name === "string" && name !== "") : [];
  const step = r.step === true;
  return at.length > 0 || step ? { at, step } : null;
}

/**
 * The names of `--break a,b` (repeatable): split on commas, trimmed, empty
 * ones dropped; a usage error (thrown) when none is left.
 */
export function parseBreakNames(values: string[]): string[] {
  const names = values.flatMap((value) => value.split(",")).map((name) => name.trim()).filter((name) => name !== "");
  if (names.length === 0) throw new Error("--break needs a phase title or an agent label (several: a,b)");
  return [...new Set(names)];
}

/**
 * One run's breaks: which phases and labels stop it, the break the run's
 * work waits for now, and the names that matched. Shared by a run's
 * primitives and its nested workflow()'s, like the run's agent ids.
 */
export class Breaks {
  /** What the run's work waits for: the breaks asked so far, chained; null before the first. */
  private gate: Promise<void> | null = null;
  /** The break each label's calls wait for while it is asked. */
  private readonly labels = new Map<string, Promise<void>>();
  private readonly names: Set<string>;
  private readonly matched = new Set<string>();

  constructor(
    readonly spec: BreakSpec,
    /** The run so far, for a break's payload; absent: the payload says only where it stopped, and the args. */
    readonly soFar?: () => RunSoFar,
  ) {
    this.names = new Set(spec.at);
  }

  /** What `--break`/`--step` asks of this run, for its log as it starts. */
  describe(): string {
    const named = this.spec.at.map((name) => JSON.stringify(name)).join(", ");
    if (this.spec.step && named) return `--step: the run stops for a decision before every phase, and before the agents labelled ${named}`;
    if (this.spec.step) return "--step: the run stops for a decision before every phase";
    return `--break: the run stops for a decision before the phases titled, and the agents labelled, ${named}`;
  }

  /** Whether phase `title` (`labelled` inside a nested workflow()) breaks; noted as matched when it does by name. */
  atPhase(title: string, labelled: string): boolean {
    let hit = false;
    for (const name of [title, labelled]) {
      if (this.names.has(name)) {
        this.matched.add(name);
        hit = true;
      }
    }
    return hit || this.spec.step;
  }

  /** Whether an agent() labelled `label` breaks. */
  atLabel(label: string | undefined): boolean {
    if (label === undefined || !this.names.has(label)) return false;
    this.matched.add(label);
    return true;
  }

  /** Add a break to the chain the run's work waits for: `ask` is called once every earlier break is answered. */
  hold(ask: () => Promise<void>): void {
    const next = (this.gate ?? Promise.resolve()).then(ask);
    next.catch(() => {}); // whoever waits on it sees the rejection; none goes unhandled
    this.gate = next;
  }

  /**
   * What a call must wait for before it starts: the pending breaks, and —
   * for an agent() whose label breaks — its label's break (one per label
   * while it is asked). Null when nothing holds it, so a call with no break
   * in its way starts exactly as it would without any.
   */
  before(label: string | undefined, askLabel: () => Promise<void>): Promise<void> | null {
    let wait = this.gate;
    if (this.atLabel(label)) {
      let pending = this.labels.get(label!);
      if (!pending) {
        pending = (this.gate ?? Promise.resolve()).then(askLabel);
        pending.catch(() => {});
        const settled = pending;
        this.labels.set(label!, settled);
        const forget = (): void => {
          if (this.labels.get(label!) === settled) this.labels.delete(label!);
        };
        settled.then(forget, forget);
      }
      wait = pending;
    }
    return wait;
  }

  /** The names no phase and no label matched. */
  unmatched(): string[] {
    return this.spec.at.filter((name) => !this.matched.has(name));
  }
}

/**
 * Take the `args` of an approved break's edited payload into the run's own
 * `args` object, in place (see the module comment). Returns the keys (or
 * indexes) that changed — none when the edit left `args` alone — or why the
 * edit cannot be taken.
 */
export function applyArgsEdit(args: unknown, edited: unknown): { changed: string[] } | { refused: string } {
  if (edited === null || typeof edited !== "object" || Array.isArray(edited) || !("args" in edited)) {
    return { refused: "the edited payload has no args" };
  }
  const next = (edited as { args: unknown }).args;
  if (deepEqual(next, args)) return { changed: [] };
  if (Array.isArray(args) && Array.isArray(next)) {
    const changed = indexes(Math.max(args.length, next.length)).filter((i) => !deepEqual(args[Number(i)], next[Number(i)]));
    args.splice(0, args.length, ...next);
    return { changed };
  }
  if (isPlainObject(args) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(args), ...Object.keys(next)]);
    const changed = [...keys].filter((key) => !deepEqual(args[key], next[key]));
    for (const key of changed) {
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        Object.defineProperty(args, key, { value: next[key], writable: true, enumerable: true, configurable: true });
      } else delete args[key];
    }
    return { changed };
  }
  const kind = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`);
  return {
    refused:
      `the run's args is ${kind(args)} and the edit makes it ${kind(next)} — only an object or an array, kept one, ` +
      "can be changed in place for the rest of the run",
  };
}

function indexes(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(i));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  // A strict script context's args are a plain object of its own realm (see ./script-context).
  return proto === null || Object.getPrototypeOf(proto) === null;
}
