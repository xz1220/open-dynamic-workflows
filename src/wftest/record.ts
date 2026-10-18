/**
 * `odw run --record` (an ODW extension): a real run kept as a test case, so
 * `odw test` replays it at no cost — a regression fixture.
 *
 * Once the run has ended, its worker adds a case to the test file (made if
 * missing; a case of the same name is replaced; any other content is kept):
 *
 *   { "name": "recorded <run_id>", "args": <the run's input>,
 *     "replies": [{ "label", "phase"?, "reply" | "fail" | "empty" }, …],
 *     "expect": { "state", "error"?, "checks"?: [{ "path": "", "equals": <result> }],
 *                 "agents": { "count" } } }
 *
 * Each agent's actual reply is what the run saved for it (its schema value,
 * or its text); a failed agent's is its failure class (`fail`), or `empty`.
 * Agents sharing a label and phase whose replies differ get one entry each,
 * `once`, in the order they started; equal ones share one entry. What is kept
 * is redacted like the run's own records (the run's redactor, input
 * included), every string cut at {@link MAX_REPLY_CHARS} and the replies at
 * {@link MAX_REPLIES}; a result past {@link MAX_RESULT_CHARS} as JSON is not
 * compared, only the state.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED } from "../events.js";
import { stableJson } from "../journal.js";
import type { Redactor } from "../redact.js";
import { writeJsonAtomic } from "../runtime/fs-util.js";
import type { RunStore } from "../runtime/run-store.js";
import { FAIL_KINDS, type FailKind } from "./mock.js";
import type { ReplyEntry } from "./definition.js";

/** Characters of any one string a recorded reply keeps. */
export const MAX_REPLY_CHARS = 4000;
/** Reply entries a recorded case keeps. */
export const MAX_REPLIES = 500;
/** Characters of the result, as JSON, a recorded case still compares. */
export const MAX_RESULT_CHARS = 8000;

export interface RecordOptions {
  /** The test file (absolute). */
  file: string;
  /** What the file's `workflow` names, when the file is new. */
  workflow: string;
  /** The run's redactor; none: kept as the run store holds it. */
  redactor?: Redactor;
}

/** Add run `runId` to the test file as a case; returns the case's name. */
export function recordFixture(store: RunStore, runId: string, options: RecordOptions): string {
  const recorded = recordedCase(store, runId);
  const kept = options.redactor ? options.redactor.record({ c: recorded }).c : recorded;
  let doc: Record<string, unknown> = { workflow: options.workflow, cases: [] };
  if (existsSync(options.file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(options.file, "utf8"));
    } catch (err) {
      throw new Error(`${options.file} is not valid JSON (${(err as Error).message}); not overwriting it`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as Record<string, unknown>).cases)) {
      throw new Error(`${options.file} is not a test file (no "cases" array); not overwriting it`);
    }
    doc = parsed as Record<string, unknown>;
  }
  const cases = (doc.cases as unknown[]).filter((c) => !(c && typeof c === "object" && (c as { name?: unknown }).name === kept.name));
  doc.cases = [...cases, kept];
  mkdirSync(dirname(options.file), { recursive: true });
  writeJsonAtomic(options.file, doc, 2);
  return kept.name;
}

export interface RecordedCase {
  name: string;
  args: unknown;
  replies: ReplyEntry[];
  expect: Record<string, unknown>;
}

/** Run `runId` as a test case (see the module comment). */
export function recordedCase(store: RunStore, runId: string): RecordedCase {
  const meta = store.readMeta(runId);
  const status = store.readStatus(runId);
  const events = store.readEvents(runId);
  const agents = new Map<number, { label: string; phase: string | null; answer: Omit<ReplyEntry, "label" | "phase"> | null }>();
  for (const ev of events) {
    const id = ev.agentId;
    if (typeof id !== "number") continue;
    if (ev.type === AGENT_STARTED && !agents.has(id)) {
      const label = typeof ev.label === "string" ? ev.label : typeof ev.adapter === "string" ? ev.adapter : "agent";
      agents.set(id, { label, phase: typeof ev.phase === "string" ? ev.phase : null, answer: null });
    } else if (ev.type === AGENT_FINISHED) {
      const agent = agents.get(id);
      const saved = store.readAgentResult(runId, id);
      if (agent && saved) agent.answer = { reply: capStrings(saved.value) };
    } else if (ev.type === AGENT_FAILED) {
      const agent = agents.get(id);
      if (agent) agent.answer = failedAnswer(ev.reason);
    }
  }

  // Agents sharing a label and phase: one entry when their replies agree, else one each, `once`, in start order.
  const groups = new Map<string, Array<{ label: string; phase: string | null; answer: Omit<ReplyEntry, "label" | "phase"> }>>();
  for (const [, agent] of [...agents.entries()].sort((a, b) => a[0] - b[0])) {
    if (!agent.answer) continue; // still running when the run ended: nothing to replay
    const key = stableJson([agent.label, agent.phase]);
    const group = groups.get(key) ?? [];
    group.push({ label: agent.label, phase: agent.phase, answer: agent.answer });
    groups.set(key, group);
  }
  const replies: ReplyEntry[] = [];
  for (const group of groups.values()) {
    const same = group.every((a) => stableJson(a.answer) === stableJson(group[0]!.answer));
    for (const agent of same ? group.slice(0, 1) : group) {
      replies.push({ label: agent.label, ...(agent.phase !== null ? { phase: agent.phase } : {}), ...agent.answer, ...(same ? {} : { once: true as const }) });
    }
  }

  const state = String(status.state ?? "done");
  const expect: Record<string, unknown> = { state };
  if (state === "failed") {
    const error = store.readError(runId)?.error;
    if (typeof error === "string" && error.trim() !== "") expect.error = error.split("\n")[0]!.slice(0, 200);
  }
  if (state === "done" && store.hasResult(runId)) {
    const result = store.readResult(runId);
    const text = JSON.stringify(result ?? null);
    if (text.length <= MAX_RESULT_CHARS) expect.checks = [{ path: "", equals: result ?? null }];
  }
  expect.agents = { count: agents.size };
  return { name: `recorded ${runId}`, args: meta.args ?? null, replies: replies.slice(0, MAX_REPLIES), expect };
}

/** A failed agent's reply entry: its failure class, as a scripted failure. */
function failedAnswer(reason: unknown): Omit<ReplyEntry, "label" | "phase"> {
  if (reason === "empty_reply") return { empty: true };
  return { fail: (FAIL_KINDS as readonly unknown[]).includes(reason) ? (reason as FailKind) : "exit" };
}

/** `value` with every string cut at {@link MAX_REPLY_CHARS}. */
function capStrings(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_REPLY_CHARS ? `${value.slice(0, MAX_REPLY_CHARS)}…` : value;
  if (Array.isArray(value)) return value.map(capStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capStrings(v)]));
  return value;
}
