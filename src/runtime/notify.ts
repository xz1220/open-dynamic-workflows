/**
 * Run-completion hooks (L5) — an ODW extension: tell the outside world that a
 * run ended.
 *
 * Configured by the top-level `notify` key and fired by the worker once a run's
 * terminal state is on disk, so a hook can neither delay that write nor change
 * the outcome: each hook is bounded, and a failure is only written to the
 * worker's stderr (its worker.log) — never to events.jsonl, where an event
 * after the terminal one would confuse every reader that folds the stream.
 *
 *   command  an argv spawned WITHOUT a shell (30s limit) with the run in its
 *            environment: ODW_RUN_ID, ODW_RUN_STATE, ODW_WORKFLOW, ODW_RUN_DIR,
 *            ODW_RESULT_FILE (only when result.json exists), ODW_DURATION_SEC,
 *            ODW_AGENTS, ODW_FAILED_AGENTS.
 *   webhook  a JSON POST (10s limit): { runId, workflow, state, createdAt,
 *            finishedAt, durationSec, counts: { agents, done, failed }, error?,
 *            text, content } — `text` (Slack) and `content` (Discord) carry the
 *            same one-line summary, so chat incoming webhooks render it as is.
 *
 * With "waiting" in `notify.on` (opt-in), the same hooks also fire once per
 * checkpoint() that starts waiting for a person — while the run goes on
 * waiting, so they never hold it up: state "waiting", no finishedAt or
 * result, and the checkpoint (`ODW_CHECKPOINT_ID`, `ODW_CHECKPOINT_TITLE`; the
 * webhook's `checkpoint: { checkpointId, title, since }`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "../adapters/runner.js";
import { cliOk, type NotifySettings, type RunEndState } from "../adapters/types.js";
import type { WaitingCheckpoint } from "../checkpoint.js";
import type { RunStore } from "./run-store.js";
import { countAgents, foldAgents } from "./runs-view.js";

/** Seconds a notify command may run before it is killed. */
export const NOTIFY_COMMAND_TIMEOUT_S = 30;
/** Milliseconds a webhook POST may take, answer included. */
export const NOTIFY_WEBHOOK_TIMEOUT_MS = 10_000;

/** What the hooks are told about a run that ended. Times are Unix seconds. */
export interface RunEnd {
  runId: string;
  runDir: string;
  workflow: string;
  state: RunEndState;
  createdAt: number | null;
  finishedAt: number;
  /** Whole seconds from creation to the terminal write. */
  durationSec: number;
  counts: { agents: number; done: number; failed: number };
  /** Why a failed run failed, or what stopped a stopped one. */
  error?: string;
  /** result.json, when the run wrote one (successful runs only). */
  resultFile: string | null;
}

/** What the hooks are told about a run whose checkpoint() waits for a person ("waiting"). */
export interface RunWaiting {
  runId: string;
  runDir: string;
  workflow: string;
  state: "waiting";
  createdAt: number | null;
  /** Whole seconds from creation to the checkpoint. */
  durationSec: number;
  counts: { agents: number; done: number; failed: number };
  checkpoint: WaitingCheckpoint;
}

export interface NotifyOptions {
  /** Where hook failures go; defaults to the worker's stderr (its worker.log). */
  log?: (line: string) => void;
  /** The command's working directory: the run's source, when it still exists. */
  cwd?: string;
  /** Test seams for the time limits. */
  commandTimeoutSec?: number;
  webhookTimeoutMs?: number;
}

/**
 * Fire the hooks `notify` configures for a run whose terminal state is on
 * disk, when `notify.on` includes that state. Resolves once every hook has
 * finished or hit its time limit; never rejects.
 */
export async function notifyRunEnd(
  notify: NotifySettings | null,
  run: { store: RunStore; runId: string; state: RunEndState; error?: string },
  options: NotifyOptions = {},
): Promise<void> {
  if (!notify || !notify.on.includes(run.state) || (!notify.command && !notify.webhook)) return;
  const log = options.log ?? defaultLog;
  try {
    const end = describeRunEnd(run.store, run.runId, run.state, run.error);
    const hooks: Array<Promise<void>> = [];
    if (notify.command) hooks.push(runHookCommand(notify.command, notifyEnv(end), options, log));
    if (notify.webhook) hooks.push(postWebhook(notify.webhook, webhookPayload(end), options, log));
    await Promise.all(hooks);
  } catch (err) {
    log(`notify: hooks for run ${run.runId} failed: ${errorMessage(err)}`);
  }
}

/**
 * Fire the hooks for a checkpoint() that started waiting, when `notify.on`
 * includes "waiting" (opt-in). Resolves once every hook has finished or hit
 * its time limit; never rejects. The worker does not wait for it to go on.
 */
export async function notifyCheckpoint(
  notify: NotifySettings | null,
  run: { store: RunStore; runId: string; checkpoint: WaitingCheckpoint },
  options: NotifyOptions = {},
): Promise<void> {
  if (!notify || !notify.on.includes("waiting") || (!notify.command && !notify.webhook)) return;
  const log = options.log ?? defaultLog;
  try {
    const waiting = describeWaiting(run.store, run.runId, run.checkpoint);
    const hooks: Array<Promise<void>> = [];
    if (notify.command) hooks.push(runHookCommand(notify.command, waitingEnv(waiting), options, log));
    if (notify.webhook) hooks.push(postWebhook(notify.webhook, waitingPayload(waiting), options, log));
    await Promise.all(hooks);
  } catch (err) {
    log(`notify: hooks for checkpoint #${run.checkpoint.checkpointId} of run ${run.runId} failed: ${errorMessage(err)}`);
  }
}

/** Read what the hooks report about a run whose terminal state is on disk. */
export function describeRunEnd(store: RunStore, runId: string, state: RunEndState, error?: string): RunEnd {
  const runDir = store.runDir(runId);
  const meta = store.readMeta(runId);
  const status = store.readStatus(runId);
  const createdAt = seconds(meta.createdAt);
  // status.updatedAt is stamped by the terminal write itself.
  const finishedAt = seconds(status.updatedAt) ?? Date.now() / 1000;
  const { agents, done, failed } = countAgents(foldAgents(store.readEvents(runId)));
  return {
    runId,
    runDir,
    workflow: workflowName(runId, meta, status),
    state,
    createdAt,
    finishedAt,
    durationSec: createdAt === null ? 0 : Math.max(0, Math.round(finishedAt - createdAt)),
    counts: { agents, done, failed },
    ...(error !== undefined ? { error } : {}),
    resultFile: store.hasResult(runId) ? join(runDir, "result.json") : null,
  };
}

/** Read what the hooks report about a run whose checkpoint() just started waiting. */
export function describeWaiting(store: RunStore, runId: string, checkpoint: WaitingCheckpoint): RunWaiting {
  const meta = store.readMeta(runId);
  const status = store.readStatus(runId);
  const createdAt = seconds(meta.createdAt);
  const { agents, done, failed } = countAgents(foldAgents(store.readEvents(runId)));
  return {
    runId,
    runDir: store.runDir(runId),
    workflow: workflowName(runId, meta, status),
    state: "waiting",
    createdAt,
    durationSec: createdAt === null ? 0 : Math.max(0, Math.round(checkpoint.since - createdAt)),
    counts: { agents, done, failed },
    checkpoint: { ...checkpoint },
  };
}

/** The environment a notify command gets on top of the worker's own. */
export function notifyEnv(end: RunEnd): Record<string, string> {
  return {
    ODW_RUN_ID: end.runId,
    ODW_RUN_STATE: end.state,
    ODW_WORKFLOW: end.workflow,
    ODW_RUN_DIR: end.runDir,
    ...(end.resultFile ? { ODW_RESULT_FILE: end.resultFile } : {}),
    ODW_DURATION_SEC: String(end.durationSec),
    ODW_AGENTS: String(end.counts.agents),
    ODW_FAILED_AGENTS: String(end.counts.failed),
  };
}

/** The environment a notify command gets for a waiting checkpoint: the run so far, and the checkpoint. */
export function waitingEnv(waiting: RunWaiting): Record<string, string> {
  return {
    ODW_RUN_ID: waiting.runId,
    ODW_RUN_STATE: "waiting",
    ODW_WORKFLOW: waiting.workflow,
    ODW_RUN_DIR: waiting.runDir,
    ODW_DURATION_SEC: String(waiting.durationSec),
    ODW_AGENTS: String(waiting.counts.agents),
    ODW_FAILED_AGENTS: String(waiting.counts.failed),
    ODW_CHECKPOINT_ID: String(waiting.checkpoint.checkpointId),
    // An environment value cannot hold a NUL byte.
    ODW_CHECKPOINT_TITLE: waiting.checkpoint.title.replace(/\0/g, ""),
  };
}

/** The JSON body a webhook receives for a waiting checkpoint. */
export function waitingPayload(waiting: RunWaiting): Record<string, unknown> {
  const text = waitingLine(waiting);
  return {
    runId: waiting.runId,
    workflow: waiting.workflow,
    state: "waiting",
    createdAt: waiting.createdAt,
    durationSec: waiting.durationSec,
    counts: waiting.counts,
    checkpoint: waiting.checkpoint,
    text,
    content: text,
    allowed_mentions: { parse: [] },
  };
}

/**
 * The one-line human summary of a waiting checkpoint, with the command that
 * answers it, e.g. "odw · deploy waits for a decision: Ship it? · odw
 * approve|reject 20261017-041600-3fa2c1 --checkpoint 1".
 */
export function waitingLine(waiting: RunWaiting): string {
  const { checkpointId, title } = waiting.checkpoint;
  return (
    `odw · ${waiting.workflow} waits for a decision: ${title} · ` +
    `odw approve|reject ${waiting.runId} --checkpoint ${checkpointId}`
  );
}

/** The JSON body a webhook receives. */
export function webhookPayload(end: RunEnd): Record<string, unknown> {
  const text = summaryLine(end);
  return {
    runId: end.runId,
    workflow: end.workflow,
    state: end.state,
    createdAt: end.createdAt,
    finishedAt: end.finishedAt,
    durationSec: end.durationSec,
    counts: end.counts,
    ...(end.error !== undefined ? { error: end.error } : {}),
    text,
    content: text,
    // Discord: never ping anyone from a run's text (a generated workflow's
    // name could say "@everyone"). Slack ignores the field.
    allowed_mentions: { parse: [] },
  };
}

/**
 * The one-line human summary, e.g. "odw · deep-research finished in 4m12s ·
 * 12 agents, 1 failed". The error stays out of it — it can quote agent
 * output; the structured `error` field carries it.
 */
export function summaryLine(end: RunEnd): string {
  const verb = end.state === "done" ? "finished in" : end.state === "failed" ? "failed after" : "stopped after";
  const { agents, failed } = end.counts;
  const tally =
    (agents === 0 ? "no agents" : agents === 1 ? "1 agent" : `${agents} agents`) + (failed ? `, ${failed} failed` : "");
  return `odw · ${end.workflow} ${verb} ${formatDuration(end.durationSec)} · ${tally}`;
}

/** 45s · 4m12s · 1h02m */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
}

/**
 * A webhook URL reduced to scheme and host — what may be shown or logged. The
 * path and query of an incoming-webhook URL are its secret.
 */
export function webhookOrigin(url: string): string {
  try {
    const { protocol, host } = new URL(url);
    return `${protocol}//${host}`;
  } catch {
    return "(invalid URL)";
  }
}

// --- the hooks ----------------------------------------------------------------

/** The hook variables that are set only when they apply, whatever the worker itself inherited. */
const OPTIONAL_HOOK_VARS = ["ODW_RESULT_FILE", "ODW_CHECKPOINT_ID", "ODW_CHECKPOINT_TITLE"];

async function runHookCommand(
  command: string[],
  vars: Record<string, string>,
  options: NotifyOptions,
  log: (line: string) => void,
): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env, ...vars };
  for (const name of OPTIONAL_HOOK_VARS) if (!(name in vars)) delete env[name];
  const timeout = options.commandTimeoutSec ?? NOTIFY_COMMAND_TIMEOUT_S;
  const result = await runCommand(command, {
    env: env as Record<string, string>,
    cwd: options.cwd && existsSync(options.cwd) ? options.cwd : undefined,
    timeout,
    // A no-op consumer: keep just a diagnostic tail of whatever the hook prints.
    onStdout: () => {},
  });
  if (cliOk(result)) return;
  // argv[0] only: the arguments may carry a token.
  const why = result.timedOut ? `timed out after ${timeout}s` : `exited with code ${result.returncode}`;
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(-500);
  log(`notify: command '${command[0]}' ${why}${detail ? `: ${detail}` : ""}`);
}

async function postWebhook(
  url: string,
  body: Record<string, unknown>,
  options: NotifyOptions,
  log: (line: string) => void,
): Promise<void> {
  const where = webhookOrigin(url);
  const limit = options.webhookTimeoutMs ?? NOTIFY_WEBHOOK_TIMEOUT_MS;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(limit),
    });
    if (res.ok) {
      void res.body?.cancel().catch(() => {}); // nothing to read: free the connection
      return;
    }
    const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    const said = await firstChunk(res);
    log(`notify: webhook ${where} answered ${status}${said ? `: ${said}` : ""}`);
  } catch (err) {
    const why =
      err instanceof Error && err.name === "TimeoutError"
        ? `timed out after ${limit / 1000}s`
        : errorMessage(err instanceof Error && err.cause instanceof Error ? err.cause : err);
    // Never let the URL's secret path reach the log through an error message.
    log(`notify: webhook ${where} failed: ${why.split(url).join(where)}`);
  }
}

/** The start of an error answer (Slack says e.g. "no_service"), read boundedly. */
async function firstChunk(res: Response): Promise<string> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const { value } = await reader.read();
    void reader.cancel().catch(() => {});
    return value ? new TextDecoder().decode(value).trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The run's workflow as the hooks name it: its meta.name, else what it was started as. */
function workflowName(runId: string, meta: Record<string, unknown>, status: Record<string, unknown>): string {
  return (
    (typeof status.name === "string" && status.name) ||
    (typeof meta.workflowName === "string" && meta.workflowName) ||
    (typeof meta.script === "string" && stem(meta.script)) ||
    runId
  );
}

function defaultLog(line: string): void {
  process.stderr.write(`odw: ${line}\n`);
}

function stem(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
