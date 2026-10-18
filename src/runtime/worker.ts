/**
 * Workflow worker (L5): load one script and run it to completion.
 *
 * The back end. It runs in its own Node process (started by the launcher), so
 * the workflow holds its entire plan in local variables; what is written back
 * to the run directory is each completed agent's result (as it lands) and the
 * final return value. A resumed run (meta.resumedFrom) first loads its source
 * run's saved results, so unchanged agent() calls replay instead of running.
 * Exactly one run executes per worker process.
 *
 * `executeRun` is also callable in-process (that is how tests exercise the full
 * stack without spawning a subprocess).
 */

import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../adapters/config.js";
import { isPermissionTier } from "../adapters/permissions.js";
import { killAllAgentProcesses } from "../adapters/runner.js";
import type { RunEndState } from "../adapters/types.js";
import type { WaitingCheckpoint } from "../checkpoint.js";
import { buildContext, spentTokens, type RunContext } from "../context.js";
import { PAUSED, RUNNING, type CheckpointRequest } from "../control.js";
import { RunStopped, WorkflowScriptError, isFatalError } from "../errors.js";
import { LOG, RUN_FAILED, RUN_FINISHED, RUN_STARTED, RUN_STOPPED, event } from "../events.js";
import { ReplayJournal } from "../journal.js";
import { loadWorkflowScript } from "../loader.js";
import { createPrimitives } from "../primitives.js";
import { CliVersions, runSetup } from "../provenance.js";
import type { QuotaPause } from "../quota-wait.js";
import { redactorFor, type Redactor } from "../redact.js";
import type { Scheduler } from "../scheduler.js";
import { FileControl } from "./file-control.js";
import { notifyCheckpoint, notifyQuotaPause, notifyRunEnd } from "./notify.js";
import { JsonlSink, RunStore } from "./run-store.js";

/**
 * Once a run has failed or stopped, how long its remaining agents get to die
 * and remove their worktrees before the worker kills what is left and moves on.
 */
const ABORT_DRAIN_MS = 10_000;

/** Signals that would otherwise kill the worker on the spot. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * After a stop signal, how long the run gets to end on its own — agents
 * killed, worktrees removed, the outcome recorded, the hooks run — before the
 * worker kills what is left and exits.
 */
const SIGNAL_GRACE_MS = 10_000;

/**
 * Run the workflow described by `runDir`; return its terminal state.
 *
 * While the run executes, a stray rejection or exception from the workflow (a
 * promise nobody handles, a throw inside a timer callback) fails the run
 * instead of killing the process and leaving the run "running" forever. The
 * listeners are process-wide, which is fine for the one run a worker executes.
 *
 * Agents still running when the run ends are aborted (or, after a normal
 * return, awaited) before the outcome is recorded, and a process 'exit'
 * listener kills any that remain while the run executes — an agent must never
 * outlive its worker and keep editing the repository unsupervised.
 *
 * SIGTERM, SIGINT and SIGHUP are handled for the same reason: agents lead
 * their own process groups, so a worker killed outright would orphan them. The
 * first such signal stops the run like `odw stop`; a second one, or the run
 * not ending within SIGNAL_GRACE_MS, kills every agent process, records the
 * run stopped if it was not yet, and exits the process.
 *
 * Once the outcome is on disk, the configured run-end hooks (`notify`) fire;
 * they are bounded and never throw, so they cannot change the returned state.
 *
 * What the run writes down has its likely secrets redacted (an ODW extension;
 * see ../redact): its events, each saved agent result, its error, a webhook's
 * payload — and its result, but there only the token shapes, never the values
 * of variables: a workflow's return value is the user's data.
 *
 * A checkpoint() waiting for a person is shown in status.json as `waiting`
 * (the oldest one, which `odw approve` answers by default) and, when
 * `notify.on` lists "waiting", fires the hooks at once — the run waits on.
 *
 * While agents wait for an adapter's spent quota to reset (an ODW extension:
 * quotaWait), status.json shows the run `paused`, with `pausedFor: { reason:
 * "quota", adapter, resumeAt }` — the soonest reset — and, when `notify.on`
 * lists "paused", each pause fires the hooks once. The wait lives in this
 * process: a worker that dies leaves the run stale, and `odw resume` replays
 * it. A new `odw resume` ends the wait at once.
 */
export async function executeRun(runDir: string): Promise<string> {
  const store = new RunStore(dirname(runDir));
  const runId = basename(runDir);

  const meta = store.readMeta(runId);
  const script = meta.script as string | undefined;
  if (!script) throw new Error(`no run metadata found at ${runDir}`);

  const sink = new JsonlSink(store.eventsPath(runId));
  const args = meta.args;
  // ctx is created inside the try so that a config or context-build failure is
  // still recorded as a failed run rather than leaving it stuck in "pending".
  let ctx: RunContext | undefined;
  // Built once the config is loaded: what the run writes down goes through it.
  let redactor: Redactor | undefined;
  const redact = <T extends object>(record: T): T => redactor?.record(record) ?? record;
  const dispatched = () => ctx?.scheduler.dispatched ?? 0;
  const spent = () => (ctx ? spentTokens(ctx.usage) : 0);

  // Set right after the terminal state is written; the run then only has its hooks left.
  let end: { state: RunEndState; error?: string } | undefined;
  // "waiting" hooks of checkpoints, awaited (they are bounded) before the worker returns.
  const checkpointHooks: Array<Promise<void>> = [];
  // …and "paused" hooks of quota pauses (ODW extension: quotaWait).
  const pauseHooks: Array<Promise<void>> = [];
  // Records each adapter CLI's version beside its first agent (ODW extension;
  // see ../provenance); closed before the terminal event, which nothing follows.
  let versions: CliVersions | undefined;
  const crashes = watchProcessCrashes();
  const signals = watchStopSignals({
    stop: (signal) => {
      if (end) return; // only the hooks are left; the grace period bounds them
      const reason = new RunStopped(`worker received ${signal}`);
      sink.emit(event(LOG, { message: `${reason.message} — stopping the run` }));
      ctx?.scheduler.abort(reason);
    },
    force: (signal, why) => {
      killAllAgentProcesses();
      if (!end) {
        sink.emit(event(LOG, { message: `${why} — killing the agents and exiting` }));
        versions?.close();
        sink.emit(event(RUN_STOPPED, { runId }));
        // No checkpoint (nor quota pause) gets to withdraw itself here: nothing waits any more.
        store.updateStatus(runId, { state: "stopped", dispatched: dispatched(), spentTokens: spent(), waiting: null, pausedFor: null });
      } else {
        // Nothing may follow the terminal event in events.jsonl: say it in worker.log.
        process.stderr.write(`odw: ${why} — exiting before the run-end hooks finished\n`);
      }
      process.exit(128 + constants.signals[signal]);
    },
  });
  process.on("exit", killAllAgentProcesses);
  try {
    const baseConfig = loadConfig((meta.configPath as string | null) ?? null);
    // Run-level adapter override (meta.adapter): becomes this run's default for
    // every `agent()` call that does not name one explicitly. Priority chain:
    // agent(p, { adapter }) > meta.adapter > config defaultAdapter > auto-pick.
    const adapterOverride =
      typeof meta.adapter === "string" && meta.adapter.length > 0 ? meta.adapter : null;
    // Run-level permission tier (meta.permissions: `--permissions` on run,
    // rerun or resume; ODW extension): the run's tier in place of the config's.
    const permissionsOverride = isPermissionTier(meta.permissions) ? meta.permissions : null;
    const config = {
      ...baseConfig,
      settings: {
        ...baseConfig.settings,
        ...(adapterOverride ? { defaultAdapter: adapterOverride } : {}),
        ...(permissionsOverride ? { permissions: permissionsOverride } : {}),
      },
    };
    const runRedactor = redactorFor(config);
    redactor = runRedactor;
    sink.redactor = runRedactor;
    // The state status.json shows: the control's (odw pause|resume|stop) —
    // and "paused" while agents wait for a spent quota to reset (ODW
    // extension: quotaWait), whose soonest reset is the run's `pausedFor`.
    let controlState = RUNNING;
    const quotaPauses = new Map<string, QuotaPause>();
    const shownState = (): string => (controlState === RUNNING && quotaPauses.size > 0 ? PAUSED : controlState);
    const control = new FileControl({
      readAction: () => store.readControl(runId),
      // A new `odw resume` — not one already there — ends a quota pause at once.
      readRequest: () => store.readControlRequest(runId),
      // checkpoint() answers from `odw approve|reject` and the dashboard.
      readDecisions: () => store.readCheckpointRequests(runId),
      onUnmatchedDecision: (request) => sink.emit(event(LOG, { message: unmatchedDecision(request) })),
      onState: (state) => {
        controlState = state;
        store.updateStatus(runId, { state: shownState(), dispatched: dispatched(), spentTokens: spent() });
      },
    });
    const replay = replayJournal(meta);
    const waiting = new Map<number, WaitingCheckpoint>();
    if (config.settings.recordVersions) {
      versions = new CliVersions({
        emit: (ev) => sink.emit(ev),
        settings: config.settings,
        cwd: typeof meta.source === "string" ? meta.source : undefined,
      });
    }
    const cliVersions = versions;
    ctx = buildContext(config, {
      source: meta.source as string | undefined,
      runId,
      runDir: store.runDir(runId),
      args,
      sink,
      control,
      budgetTotal: (meta.budgetTotal as number | null) ?? null,
      // Each completed agent's result lands in agents/<agentId>.json at once,
      // so a run that stalls, is stopped, or dies keeps its finished work —
      // its likely secrets redacted (ODW extension).
      saveAgentResult: (rec) => store.writeAgentResult(runId, runRedactor.record(rec)),
      redactor: runRedactor,
      // What an isolated agent changed is kept beside it, as agents/<agentId>.diff.
      agentDiffPath: (agentId) => store.agentDiffPath(runId, agentId),
      // What each agent's CLI prints, as agents/<agentId>.transcript.jsonl and .stderr.txt.
      agentTranscriptPaths: (agentId) => store.agentTranscriptPaths(runId, agentId),
      // A schema handed to a CLI as a file, as agents/<agentId>.schema.json while it runs.
      agentSchemaPath: (agentId) => store.agentSchemaPath(runId, agentId),
      replay,
      onCliRun: cliVersions && ((adapter) => cliVersions.note(adapter)),
      onCheckpoint: (cp, isWaiting) => {
        if (isWaiting) {
          waiting.set(cp.checkpointId, cp);
          const hooks = notifyCheckpoint(config.settings.notify, { store, runId, checkpoint: cp }, {
            cwd: typeof meta.source === "string" ? meta.source : undefined,
            redactor: runRedactor,
          });
          checkpointHooks.push(hooks);
        } else {
          waiting.delete(cp.checkpointId);
        }
        // The oldest question still open: the one `odw approve <run>` answers.
        const oldest = [...waiting.values()].sort((a, b) => a.checkpointId - b.checkpointId)[0];
        store.updateStatus(runId, { waiting: oldest ? { ...oldest, title: runRedactor.text(oldest.title) } : null });
      },
      onQuotaPause: ({ pause, change }) => {
        if (change === "started" || change === "extended") quotaPauses.set(pause.adapter, pause);
        else quotaPauses.delete(pause.adapter);
        if (change === "started") {
          pauseHooks.push(
            notifyQuotaPause(config.settings.notify, { store, runId, pause }, {
              cwd: typeof meta.source === "string" ? meta.source : undefined,
              redactor: runRedactor,
            }),
          );
        }
        // The soonest reset: when the run goes on. A run ending under its
        // pause only drops it — its final state comes next.
        const soonest = [...quotaPauses.values()].sort((a, b) => a.resumeAt - b.resumeAt)[0];
        const pausedFor = soonest ? { reason: "quota", ...soonest } : null;
        store.updateStatus(runId, change === "withdrawn" ? { pausedFor } : { state: shownState(), pausedFor });
      },
    });

    store.updateStatus(runId, { state: "running", pid: process.pid });
    // What the run starts with — the settings that change behaviour, and each
    // adapter's fingerprint — for `odw compare` (ODW extension; see ../provenance).
    sink.emit(event(RUN_STARTED, { runId, setup: runSetup(config) }));
    if (replay) {
      sink.emit(
        event(LOG, {
          message: `resuming ${replay.sourceRunId}: unchanged agent() calls replay its ${replay.size} saved result(s)`,
        }),
      );
    }

    const source = readFileSync(script, "utf8");
    const loaded = loadWorkflowScript(source, script);
    // The run-by-name lookup keys on the filename stem, not meta.name. Flag a
    // divergence (through the event stream, so it shows in `odw logs` and the
    // dashboard) so the author knows which token actually invokes this file.
    // Inline-source runs are exempt: their workflow.js lives inside the run
    // directory and is not name-addressable, so the note would only mislead.
    const stem = basename(script).replace(/\.[^.]*$/, "");
    // Inline-launched runs (meta.inline) carry their script inside the run dir
    // and are not name-addressable, so the divergence note would only mislead.
    const isInline = meta.inline === true;
    if (!isInline && loaded.meta.name !== stem) {
      sink.emit(
        event(LOG, {
          message:
            `workflow file '${basename(script)}' declares meta.name '${loaded.meta.name}'; ` +
            `run it by name as '${stem}'`,
        }),
      );
    }
    store.updateStatus(runId, {
      name: loaded.meta.name,
      description: loaded.meta.description,
      phases: loaded.meta.phases,
    });
    // Its meta.phases may give their agents an adapter and a model (ODW extension).
    const primitives = createPrimitives(ctx, { phases: loaded.meta.phases });
    const result = await crashes.race(loaded.run(primitives, args));
    // Agents the script started but never awaited are still this run's work:
    // let them finish (and clean up their worktrees) before recording it.
    await crashes.race(ctx.scheduler.drain());
    // A fatal error (stop, budget, dispatch cap, config) decides the outcome
    // even when the script caught it and returned anyway — a stopped run must
    // not read "done". The return value is not kept: result.json is written
    // for successful runs only.
    const fatal = ctx.scheduler.fatalError;
    if (fatal !== undefined) {
      sink.emit(
        event(LOG, {
          message: `the workflow returned after the run ended (${errorMessage(fatal)}); its return value is discarded`,
        }),
      );
      throw fatal;
    }

    // The workflow's own value: token shapes are redacted, the values of variables are not (ODW extension).
    const kept = runRedactor.shapes.record({ value: result });
    store.writeResult(runId, kept.value, "redacted" in kept);
    versions?.close();
    sink.emit(event(RUN_FINISHED, { runId }));
    store.updateStatus(runId, { state: "done", dispatched: dispatched(), spentTokens: spent() });
    end = { state: "done" };
  } catch (err) {
    // The first fatal error is the root cause, even when the script swallowed
    // it and later failed for another reason (still worth a log line).
    const outcome = ctx?.scheduler.fatalError ?? err;
    if (outcome !== err) {
      sink.emit(event(LOG, { message: `after the run ended, the workflow also failed: ${errorMessage(err)}` }));
    }
    if (ctx) await stopAgents(ctx.scheduler, outcome);
    versions?.close();
    if (outcome instanceof RunStopped) {
      sink.emit(event(RUN_STOPPED, { runId }));
      store.updateStatus(runId, { state: "stopped", dispatched: dispatched(), spentTokens: spent() });
      end = { state: "stopped", error: outcome.message };
    } else {
      // A script may throw anything — `throw null` included — so never read
      // properties off the outcome without checking what it is. What it says
      // may quote an agent's or a command's output: redacted (ODW extension).
      const failure = redact({ error: errorMessage(outcome), stack: outcome instanceof Error ? (outcome.stack ?? null) : null });
      const message = failure.error;
      sink.emit(event(RUN_FAILED, { runId, error: message }));
      store.writeError(runId, failure);
      store.updateStatus(runId, { state: "failed", dispatched: dispatched(), spentTokens: spent() });
      end = { state: "failed", error: message };
    }
  } finally {
    process.off("exit", killAllAgentProcesses);
    crashes.dispose();
    if (!end) signals.dispose(); // the run itself threw: no hooks follow
  }
  // The outcome is on disk; only now do the run-end hooks fire.
  try {
    await notifyRunEnd(ctx?.config.settings.notify ?? null, { store, runId, ...end }, {
      cwd: typeof meta.source === "string" ? meta.source : undefined,
      redactor,
    });
    // A checkpoint's hooks may still be on their way (a quick answer): let them finish.
    await Promise.all(checkpointHooks);
    await Promise.all(pauseHooks);
  } finally {
    signals.dispose();
  }
  return end.state;
}

/** The log line for a checkpoint answer that found nothing waiting for it. */
function unmatchedDecision(request: CheckpointRequest): string {
  const which = request.checkpointId !== undefined ? `checkpoint #${request.checkpointId}` : "a checkpoint";
  const from = request.by === "dashboard" ? "the dashboard" : "the cli";
  return `ignored "${request.action}" for ${which} from ${from}: no such checkpoint is waiting for an answer`;
}

/**
 * The run is over, but agents may still be in flight (siblings of the failure,
 * agents the script never awaited). Abort them, give their worktree cleanup a
 * bounded moment, then kill whatever is left.
 */
async function stopAgents(scheduler: Scheduler, err: unknown): Promise<void> {
  scheduler.abort(isFatalError(err) ? err : new RunStopped(`the workflow failed: ${errorMessage(err)}`));
  if (!(await scheduler.drain(ABORT_DRAIN_MS))) killAllAgentProcesses();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The saved agent results of the run this one resumes (meta.resumedFrom), read
 * from that run's own directory; undefined for a run that resumes nothing.
 */
function replayJournal(meta: Record<string, unknown>): ReplayJournal | undefined {
  if (typeof meta.resumedFrom !== "string" || meta.resumedFrom === "") return undefined;
  const dir = typeof meta.resumedFromDir === "string" ? meta.resumedFromDir : null;
  if (!dir) return new ReplayJournal(meta.resumedFrom, []);
  const source = new RunStore(dirname(dir));
  const sourceId = basename(dir);
  return new ReplayJournal(meta.resumedFrom, source.listAgentResults(sourceId), (agentId) =>
    source.agentDiffPath(sourceId, agentId),
  );
}

/**
 * Route process-level failures (unhandled rejections, uncaught exceptions) into
 * a rejection the run can record: `race` settles with the first of `work` and
 * a crash. Listening stops at `dispose`.
 */
function watchProcessCrashes(): { race<T>(work: Promise<T>): Promise<T>; dispose(): void } {
  let fail!: (err: unknown) => void;
  const crashed = new Promise<never>((_, reject) => (fail = reject));
  crashed.catch(() => {}); // observed only through race()
  const onRejection = (reason: unknown): void => fail(crashError("an unhandled promise rejection", reason));
  const onException = (error: unknown): void => fail(crashError("an uncaught exception", error));
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return {
    race: (work) => Promise.race([work, crashed]),
    dispose: () => {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    },
  };
}

/**
 * Handle the stop signals while a run executes (see executeRun): `stop` on the
 * first; `force` on a second, or once SIGNAL_GRACE_MS have passed since the
 * first. Listening ends at `dispose`.
 */
function watchStopSignals(handlers: {
  stop(signal: NodeJS.Signals): void;
  force(signal: NodeJS.Signals, why: string): void;
}): { dispose(): void } {
  let first: NodeJS.Signals | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (first) {
      return handlers.force(signal, `worker received ${signal} ${signal === first ? "again" : `after ${first}`}`);
    }
    first = signal;
    deadline = setTimeout(
      () => handlers.force(signal, `the run did not stop within ${SIGNAL_GRACE_MS / 1000}s of ${signal}`),
      SIGNAL_GRACE_MS,
    );
    handlers.stop(signal);
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  return {
    dispose: () => {
      clearTimeout(deadline);
      for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
    },
  };
}

function crashError(kind: string, cause: unknown): WorkflowScriptError {
  const error = new WorkflowScriptError(`the workflow crashed with ${kind}: ${errorMessage(cause)}`);
  if (cause instanceof Error && cause.stack) error.stack = cause.stack;
  return error;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length !== 1) {
    process.stderr.write("usage: node runtime/worker.js <run_dir>\n");
    return 2;
  }
  await executeRun(argv[0]!);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
