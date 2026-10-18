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

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

import { defaultConfig, loadConfig } from "../adapters/config.js";
import { isPermissionTier } from "../adapters/permissions.js";
import { sandboxFlagOf, withSandboxFlag } from "../adapters/sandbox.js";
import { killAllAgentProcesses } from "../adapters/runner.js";
import type { RunEndState } from "../adapters/types.js";
import type { WaitingCheckpoint } from "../checkpoint.js";
import type { CostHistory } from "../forecast.js";
import { buildContext, spentTokens, type RunContext } from "../context.js";
import { deciderText, PAUSED, RUNNING, STOPPED, type CheckpointRequest } from "../control.js";
import { ConfigError, DeadlinePassed, RunStopped, WorkflowScriptError, isFatalError } from "../errors.js";
import { AGENT_STARTED, LOG, RUN_FAILED, RUN_FINISHED, RUN_STARTED, RUN_STOPPED, event } from "../events.js";
import { Breaks, breakSpecOf, runSoFar } from "../breaks.js";
import { DriftWatch, driftEvalArgs, driftEvalOf, previousRun } from "../drift.js";
import { ReplayJournal } from "../journal.js";
import { loadWorkflowScript, scanDualCompat } from "../loader.js";
import { RunMemory } from "../memory.js";
import { NotesBoard } from "../notes.js";
import { createPrimitives } from "../primitives.js";
import { CliVersions, runSetup } from "../provenance.js";
import type { QuotaPause } from "../quota-wait.js";
import { redactorFor, type Redactor } from "../redact.js";
import type { Scheduler } from "../scheduler.js";
import { applyRunTrust, resolveRunTrust, untrustedConfigSwap } from "../untrusted.js";
import { requireSandboxRefusal, sandboxGap, sandboxWarning, untrustedInputNote, untrustedInputOf, untrustedTier } from "../untrusted-input.js";
import { isCommitId } from "../workspace.js";
import { pluginOrigin } from "../workflows/plugins.js";
import { odwInvocation } from "../schedule/command.js";
import { dryResponder, mockConfig, mockRunner, noSleep, type MockResponder } from "../wftest/mock.js";
import { recordFixture } from "../wftest/record.js";
import { FileControl } from "./file-control.js";
import { notifyCheckpoint, notifyQuotaPause, notifyRunEnd } from "./notify.js";
import { mintCheckpointLinks, runsRootsOf } from "./approve-links.js";
import { exportRunEnd } from "./otel-export.js";
import { loadCostHistory } from "./estimate.js";
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
 * So is the run's OpenTelemetry trace, posted once when the config has `otel`
 * (an ODW extension; see ./otel-export).
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
 *
 * Run as the run's worker process (`options.worker`), whose stdout and stderr
 * are the run's worker.log, what it prints — a workflow's console.log of an
 * agent's reply, a hook's failure — is redacted like the run's events, from
 * the moment its redactor is built until the process exits (ODW extension).
 */
export async function executeRun(runDir: string, options: ExecuteRunOptions = {}): Promise<string> {
  const store = new RunStore(dirname(runDir));
  const runId = basename(runDir);

  const meta = store.readMeta(runId);
  const script = meta.script as string | undefined;
  if (!script) throw new Error(`no run metadata found at ${runDir}`);

  const sink = new JsonlSink(store.eventsPath(runId));
  // A run of `odw replay` (ODW extension; see ./replay) takes its call — the prompt — from
  // call.json, kept out of meta.json; a replay from before that has it in meta.args.
  const args = (meta.origin === "replay" ? store.readRunCall(runId) : null) ?? meta.args;
  // The name its earlier runs go by: meta.workflowName, else — once loaded — the script's meta.name.
  let historyName: string | null = typeof meta.workflowName === "string" ? meta.workflowName : null;
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
  // Compares what the run records with the workflow's previous run (ODW extension; see ../drift).
  let drift: DriftWatch | undefined;
  const crashes = watchProcessCrashes();
  // Undoes the redaction of this process's own output, once the run is over.
  let unredactOutput = (): void => {};
  const signals = watchStopSignals({
    stop: (why, deadline) => {
      if (end) return; // only the hooks are left; the grace period bounds them
      // The deadline's stop keeps what the agents it kills had changed (see DeadlinePassed).
      const reason = deadline ? new DeadlinePassed(why) : new RunStopped(why);
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
  // `--deadline` (ODW extension): stops the run like a stop signal once it passes — armed once the run can be stopped.
  let deadline: { dispose(): void } | undefined;
  try {
    let baseConfig = loadConfig((meta.configPath as string | null) ?? null);
    // Run-level adapter override (meta.adapter): becomes this run's default for
    // every `agent()` call that does not name one explicitly. Priority chain:
    // agent(p, { adapter }) > meta.adapter > config defaultAdapter > auto-pick.
    const adapterOverride =
      typeof meta.adapter === "string" && meta.adapter.length > 0 ? meta.adapter : null;
    // Run-level permission tier (meta.permissions: `--permissions` on run,
    // rerun or resume; ODW extension): the run's tier in place of the config's.
    // Untrusted input (ODW extension; see ../untrusted-input): read-only
    // agents unless the run's permissions were given, and a minimal agent
    // environment whatever the config says.
    const input = untrustedInputOf(meta);
    const givenPermissions = isPermissionTier(meta.permissions) ? meta.permissions : null;
    const permissionsOverride = input ? untrustedTier(givenPermissions) : givenPermissions;
    // Run-level container sandbox (meta.sandbox: `--sandbox container` on run,
    // rerun or resume; ODW extension): the config's container, or one of
    // `--sandbox-image` — a ConfigError when neither names an image.
    const sandboxFlag = sandboxFlagOf(meta.sandbox);
    const withOverrides = (base: typeof baseConfig) => ({
      ...base,
      settings: {
        ...base.settings,
        ...(adapterOverride ? { defaultAdapter: adapterOverride } : {}),
        ...(permissionsOverride ? { permissions: permissionsOverride } : {}),
        ...(sandboxFlag ? { sandbox: withSandboxFlag(base.settings.sandbox, sandboxFlag) } : {}),
        ...(input ? { agentEnv: "minimal" as const } : {}),
      },
    });
    let overridden = withOverrides(baseConfig);
    // The run's trust (ODW extension; see ../untrusted): `--untrusted` on run,
    // rerun or resume (meta.trust), else the config's — and an untrusted run
    // drops the worktreeSetup the repository's own config set.
    const trustSource = typeof meta.source === "string" ? meta.source : process.cwd();
    const configPath = (meta.configPath as string | null) ?? null;
    let runTrust = resolveRunTrust({ flag: meta.trust === "untrusted" ? "untrusted" : null, config: overridden, configPath, source: trustSource });
    // ... and never reads a config ODW found by itself inside the repository:
    // its adapter commands would be the repository's code to run.
    const swap = runTrust.trust === "untrusted" ? untrustedConfigSwap(configPath, trustSource) : undefined;
    const swapNote = swap
      ? `untrusted run: not reading the repository's own config (${swap.dropped}) — using ${swap.path ?? "the built-in defaults"}; ` +
        `pass --config to choose one`
      : null;
    if (swap) {
      baseConfig = swap.path ? loadConfig(swap.path) : defaultConfig();
      overridden = withOverrides(baseConfig);
      runTrust = { ...runTrust, repositoryConfig: null };
    }
    const trusted = applyRunTrust(overridden, runTrust);
    if (swapNote) trusted.notes.push(swapNote);
    // No model is called (ODW extension; see ../wftest/mock): `odw test`'s
    // scripted replies, or a dry run's stubs, answer every agent in-process.
    const mock: MockResponder | undefined = options.mock ?? (meta.dry === true ? dryResponder : undefined);
    const config = mock ? mockConfig(trusted.config) : trusted.config;
    const runRedactor = redactorFor(config);
    redactor = runRedactor;
    sink.redactor = runRedactor;
    // worker.log too, when this process is the run's worker (ODW extension).
    if (options.worker) unredactOutput = redactOutput(runRedactor);
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
        // Who paused or resumed it, by name (ODW extension; see ../identity); a stop says so on run_stopped.
        const who = state === STOPPED ? undefined : store.readControlRequest(runId)?.who;
        if (who) sink.emit(event(LOG, { message: `${state === PAUSED ? "paused" : "resumed"} by ${who}`, control: state, who }));
      },
    });
    const replay = replayJournal(meta);
    // `odw run --break`/`--step` (ODW extension; see ../breaks): where the run stops for a person.
    const breakSpec = breakSpecOf(meta.breaks);
    const breaks = breakSpec
      ? new Breaks(breakSpec, () => runSoFar(store.readEvents(runId), store.listAgentResults(runId)))
      : undefined;
    // A run of `odw replay` (ODW extension; see ./replay): its agent starts where the original did.
    const replayOf = replayLinkOf(meta);
    const waiting = new Map<number, WaitingCheckpoint>();
    if (config.settings.recordVersions) {
      versions = new CliVersions({
        emit: (ev) => sink.emit(ev),
        settings: config.settings,
        cwd: typeof meta.source === "string" ? meta.source : undefined,
      });
    }
    const cliVersions = versions;
    // The workflow's earlier runs, for fan-out forecasts and cost gates (ODW
    // extension; see ../forecast): read from its bucket of the runs root on
    // the first fan-out that asks, this run left out.
    let history: CostHistory | null | undefined;
    const costHistory = (): CostHistory | null => {
      if (history !== undefined) return history;
      history = null; // read once, even when reading fails
      if (historyName === null) return null;
      history = loadCostHistory(new RunStore(dirname(dirname(runDir))), {
        workflow: historyName,
        sourceHash: typeof meta.sourceHash === "string" ? meta.sourceHash : null,
        exclude: runId,
      });
      return history;
    };
    // The workflow's memory (ODW extension; see ../memory): recalled for agents
    // with memory on; what the run learns is kept once it ends — not by a run no model answers.
    const memory = new RunMemory({
      source: typeof meta.source === "string" ? meta.source : process.cwd(),
      dir: config.settings.memoryDir ?? null,
      // A memoryDir the repository's own config sets is never the user's (see ../untrusted).
      dirFromRepository: runTrust.repositoryConfig !== null,
      runId,
      workflow: () => historyName,
      trust: config.settings.trust,
      redactor: runRedactor,
      emit: (ev) => sink.emit(ev),
      write: !mock,
    });
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
      // The run's notes board (ODW extension): notes.jsonl, for agents with notes on.
      // A note posted with --keep becomes workflow memory when the run ends.
      notes: new NotesBoard({
        runDir: store.runDir(runId),
        redactor: runRedactor,
        emit: (ev) => sink.emit(ev),
        onKeep: (note) => memory.record({ kind: "note", text: note.text, paths: note.paths ?? [], agent: note.by.label }),
      }),
      memory,
      // Untrusted input (ODW extension): workflow.input, the write checkpoint, and the secrets agents do not get.
      input,
      // What an isolated agent changed is kept beside it, as agents/<agentId>.diff.
      agentDiffPath: (agentId) => store.agentDiffPath(runId, agentId),
      // What each agent's CLI prints, as agents/<agentId>.transcript.jsonl and .stderr.txt.
      agentTranscriptPaths: (agentId) => store.agentTranscriptPaths(runId, agentId),
      // The brief of a fallback that handed an agent's work over, as agents/<agentId>.handoff.md.
      agentHandoffPath: (agentId) => store.agentHandoffPath(runId, agentId),
      // A schema handed to a CLI as a file, as agents/<agentId>.schema.json while it runs.
      agentSchemaPath: (agentId) => store.agentSchemaPath(runId, agentId),
      replay,
      costHistory,
      // What each agent() call was asked, as agents/<agentId>.call.json, for `odw replay` (ODW extension).
      saveAgentCall: (call) => store.writeAgentCall(runId, call),
      ...(replayOf?.base ? { worktreeBase: replayOf.base } : {}),
      breaks,
      onCliRun: cliVersions && ((adapter) => cliVersions.note(adapter)),
      // Each mocked agent is answered knowing its label and phase, from its agent_started event.
      ...(mock ? { bridge: { runner: mockRunner(mock, (agentId) => startedAgent(store, runId, agentId)), sleep: noSleep } } : {}),
      onCheckpoint: (cp, isWaiting) => {
        if (isWaiting) {
          waiting.set(cp.checkpointId, cp);
          // Its signed approve links (ODW extension), minted only when a hook fires and an `odw serve --public-url` answers them.
          const links = () => mintCheckpointLinks(runsRootsOf(runDir), runId, cp.checkpointId, config.settings.approveLinks.ttl);
          const hooks = notifyCheckpoint(config.settings.notify, { store, runId, checkpoint: cp, links }, {
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

    deadline = watchDeadline(meta.deadline, (seconds) => {
      if (end) return;
      store.updateStatus(runId, { stopReason: "deadline" });
      signals.stopNow(`the run's deadline (--deadline ${seconds}) passed`);
    });
    store.updateStatus(runId, { state: "running", pid: process.pid });
    // What the run starts with — the settings that change behaviour, and each
    // adapter's fingerprint — for `odw compare` (ODW extension; see ../provenance).
    // Untrusted input (ODW extension): what the run gave up, said with its start —
    // loudly without a sandbox, and refused under untrustedInput.requireSandbox.
    const inputGap = input ? sandboxGap(config.settings) : null;
    const inputProfile = input
      ? { ...input, permissions: config.settings.permissions, agentEnv: config.settings.agentEnv, sandboxed: inputGap === null, ...(inputGap ? { warning: sandboxWarning(inputGap) } : {}) }
      : null;
    sink.emit(event(RUN_STARTED, { runId, setup: runSetup(config), ...(inputProfile ? { untrustedInput: inputProfile } : {}) }));
    if (input) {
      store.updateStatus(runId, { untrustedInput: inputProfile });
      sink.emit(event(LOG, { message: untrustedInputNote(input, config.settings.permissions), untrustedInput: true }));
      if (inputGap && config.settings.untrustedInput.requireSandbox) throw new ConfigError(requireSandboxRefusal(inputGap));
      if (inputGap) sink.emit(event(LOG, { message: sandboxWarning(inputGap), untrustedInput: true }));
    }
    // A container sandbox that cannot run here — no engine, no image — fails
    // the run before any agent starts (ODW extension; see ../adapters/sandbox).
    await ctx.bridge.checkSandbox();
    if (mock) {
      const how = meta.dry === true ? "a dry run: every agent gets a stub reply" : "a test run: every agent gets its scripted reply";
      sink.emit(event(LOG, { message: `${how}, no model is called (ODW extension)` }));
    }
    // An untrusted run says so, and what of the repository's config it refused (ODW extension).
    for (const message of trusted.notes) sink.emit(event(LOG, { message, trust: "untrusted" }));
    if (breaks) sink.emit(event(LOG, { message: breaks.describe() }));
    if (replayOf) {
      sink.emit(
        event(LOG, {
          message:
            `replaying agent ${replayOf.agentId} (${replayOf.label}) of run ${replayOf.runId}` +
            (replayOf.base ? ` — an isolated agent, at the commit it started from, ${replayOf.base.slice(0, 12)}` : ""),
        }),
      );
    }
    if (replay) {
      sink.emit(
        event(LOG, {
          message: `resuming ${replay.sourceRunId}: unchanged agent() calls replay its ${replay.size} saved result(s)`,
        }),
      );
    }

    // How the workflow's name resolved, and — for a Claude Code plugin's
    // workflow (ODW extension) — where it came from, and what of it is not
    // Claude Code's dialect: said before it runs, in every run.
    const plugin = pluginOfMeta(meta.plugin);
    for (const message of Array.isArray(meta.workflowNotes) ? meta.workflowNotes : []) {
      if (typeof message === "string") sink.emit(event(LOG, { message }));
    }
    const source = readFileSync(script, "utf8");
    if (plugin) {
      const allowed = config.settings.trust === "untrusted" ? "; allowed in an untrusted run: you installed it" : "";
      sink.emit(
        event(LOG, {
          message: `workflow ${plugin.name} comes from ${pluginOrigin(plugin)}, run in place from ${script} (read, never modified)${allowed}`,
          plugin: plugin.id,
        }),
      );
      for (const warning of scanDualCompat(source)) {
        sink.emit(event(LOG, { message: `workflow ${plugin.name}: ${warning}`, plugin: plugin.id }));
      }
    }
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
    // A plugin's workflow runs by `<plugin>:<meta.name>`, never by its file's stem.
    if (!isInline && !plugin && loaded.meta.name !== stem) {
      sink.emit(
        event(LOG, {
          message:
            `workflow file '${basename(script)}' declares meta.name '${loaded.meta.name}'; ` +
            `run it by name as '${stem}'`,
        }),
      );
    }
    historyName ??= loaded.meta.name;
    // Drift watch (ODW extension; see ../drift): what this run records — CLI
    // versions, requested models — against the workflow's previous run. Not
    // for a run no model answers.
    if (!mock) {
      try {
        const runsRoot = dirname(dirname(runDir));
        const baseline = previousRun(store, runId, {
          workflow: historyName,
          sourceHash: typeof meta.sourceHash === "string" ? meta.sourceHash : null,
        });
        if (baseline) {
          const watch = new DriftWatch({
            workflow: historyName,
            baseline,
            tiers: config.settings.models,
            emit: (ev) => sink.emit(ev),
            evalOf: driftEvalOf(typeof meta.source === "string" ? meta.source : null, historyName, runsRoot),
            // A run `odw eval` started never starts another.
            autoEval: config.settings.driftEval && meta.origin !== "eval",
          });
          drift = watch;
          sink.onEmit = (ev) => watch.observe(ev);
        }
      } catch {
        // Watching for drift never fails the run.
      }
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
    // A sandbox's egress proxies and networks go, after a last read of their denials (ODW extension).
    await ctx.bridge.closeEgress();
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

    // A --break name nothing matched is said, once the run is done (ODW extension).
    for (const name of breaks?.unmatched() ?? []) {
      sink.emit(event(LOG, { message: `--break ${JSON.stringify(name)}: no phase title and no agent label of this run matched it` }));
    }
    // The workflow's own value: token shapes are redacted, the values of variables are not (ODW extension).
    const kept = runRedactor.shapes.record({ value: result });
    store.writeResult(runId, kept.value, "redacted" in kept);
    versions?.close();
    ctx.notes?.close();
    // What the run learned is kept, before its terminal event (ODW extension).
    ctx.memory?.flush();
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
    await ctx?.bridge.closeEgress().catch(() => undefined);
    versions?.close();
    ctx?.notes?.close();
    // A failed or stopped run keeps what it learned too: a correction is no less true.
    ctx?.memory?.flush();
    if (outcome instanceof RunStopped) {
      // Who stopped it, by name (ODW extension; see ../identity), when `odw stop` or the dashboard did.
      const control = store.readControlRequest(runId);
      const who = control?.action === "stop" ? control.who : undefined;
      sink.emit(event(RUN_STOPPED, { runId, ...(who ? { who } : {}) }));
      store.updateStatus(runId, { state: "stopped", dispatched: dispatched(), spentTokens: spent(), ...(who ? { stoppedBy: who } : {}) });
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
    deadline?.dispose();
    process.off("exit", killAllAgentProcesses);
    crashes.dispose();
    if (!end) signals.dispose(); // the run itself threw: no hooks follow
  }
  // The outcome is on disk; only now do the run-end hooks fire — and its trace
  // go out, with `otel` in the config (ODW extension), beside them.
  const exported = exportRunEnd(ctx?.config ?? null, { store, runId });
  try {
    await notifyRunEnd(ctx?.config.settings.notify ?? null, { store, runId, ...end }, {
      cwd: typeof meta.source === "string" ? meta.source : undefined,
      redactor,
    });
    // A checkpoint's hooks may still be on their way (a quick answer): let them finish.
    await Promise.all(checkpointHooks);
    await Promise.all(pauseHooks);
    await exported;
  } finally {
    signals.dispose();
    unredactOutput();
  }
  // `odw run --record` (ODW extension): the run, its replies included, kept as a test case.
  const record = meta.record as { file?: unknown; workflow?: unknown } | null | undefined;
  if (record && typeof record.file === "string" && typeof record.workflow === "string") {
    try {
      recordFixture(store, runId, { file: record.file, workflow: record.workflow, redactor });
    } catch (err) {
      process.stderr.write(`odw: could not record ${runId} to ${record.file}: ${errorMessage(err)}\n`);
    }
  }
  // `driftEval: true` (ODW extension; see ../drift): the run drifted, and its
  // workflow has an eval — it starts now, detached, unless the run was stopped.
  const pendingEval = drift?.pendingEval;
  if (pendingEval && end.state !== "stopped" && typeof meta.source === "string") {
    const configPath = typeof meta.configPath === "string" ? meta.configPath : null;
    const launch: DriftEvalLaunch = {
      args: [...driftEvalArgs(pendingEval), "--runs-root", dirname(dirname(runDir)), ...(configPath ? ["--config", configPath] : [])],
      cwd: meta.source,
      log: join(store.runDir(runId), "drift-eval.log"),
    };
    try {
      (options.startDriftEval ?? launchDriftEval)(launch);
      process.stderr.write(`odw: drift: started odw ${launch.args.join(" ")} — its output in ${launch.log}\n`);
    } catch (err) {
      process.stderr.write(`odw: drift: could not start odw eval: ${errorMessage(err)}\n`);
    }
  }
  return end.state;
}

/** An agent's label and phase, as the run's agent_started event for it names them; null before it has one. */
function startedAgent(store: RunStore, runId: string, agentId: number): { label: string | null; phase: string | null } | null {
  for (const ev of store.readEvents(runId)) {
    if (ev.type === AGENT_STARTED && ev.agentId === agentId) {
      return { label: typeof ev.label === "string" ? ev.label : null, phase: typeof ev.phase === "string" ? ev.phase : null };
    }
  }
  return null;
}

export interface ExecuteRunOptions {
  /**
   * This process is the run's worker, its stdout and stderr the run's
   * worker.log: what it prints is redacted too (see executeRun).
   */
  worker?: boolean;
  /**
   * Answer every agent in-process instead of running its CLI (ODW extension;
   * `odw test`, see ../wftest): the config's adapters, each pointed at the
   * mock. A run whose meta says `dry` gets the dry run's stubs without it.
   */
  mock?: MockResponder;
  /** Starts the eval drift watch asks for under `driftEval` (ODW extension; see ../drift); a test seam. */
  startDriftEval?: (launch: DriftEvalLaunch) => void;
}

/** An `odw eval` drift watch starts once the run ends (ODW extension; see ../drift). */
export interface DriftEvalLaunch {
  /** odw's arguments: `eval <name> [--baseline <report>] --runs-root <root> [--config <path>]`. */
  args: string[];
  /** Where it runs: the run's source directory, where `.odw/evals/<name>.json` is. */
  cwd: string;
  /** Where its output goes: the run directory's drift-eval.log. */
  log: string;
}

/** Start `odw <args>` detached, its output appended to `log`; it outlives the worker. */
function launchDriftEval(launch: DriftEvalLaunch): void {
  const [command, ...pre] = odwInvocation();
  const fd = openSync(launch.log, "a");
  try {
    writeSync(fd, `odw ${launch.args.join(" ")}\n`);
    const child = spawn(command!, [...pre, ...launch.args], {
      cwd: launch.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", (err) => process.stderr.write(`odw: drift: could not start odw eval: ${err.message}\n`));
    child.unref();
  } finally {
    closeSync(fd);
  }
}

/**
 * Redact what this process writes to its stdout and stderr, as it writes it
 * (ODW extension; see ../redact): each stream through a RedactStream, so a
 * secret split across two writes is still caught; what one holds back of a
 * line still arriving is written when it is undone, or when the process
 * exits. Returns what undoes it. A redactor that redacts nothing changes nothing.
 */
function redactOutput(redactor: Redactor): () => void {
  if (!redactor.active) return () => {};
  const undo = [process.stdout, process.stderr].map((stream) => {
    const write = stream.write;
    const held = redactor.stream();
    const decoder = new StringDecoder("utf8");
    const flush = (): void => {
      const rest = held.write(decoder.end()) + held.end();
      if (rest) write.call(stream, rest);
    };
    stream.write = function (chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
      const done = typeof encoding === "function" ? encoding : typeof callback === "function" ? callback : undefined;
      const text =
        typeof chunk === "string"
          ? typeof encoding === "string" && encoding !== "utf8" && encoding !== "utf-8"
            ? Buffer.from(chunk, encoding as BufferEncoding).toString("utf8")
            : chunk
          : decoder.write(Buffer.from(chunk as Uint8Array));
      return write.call(stream, held.write(text), "utf8", done as ((err?: Error | null) => void) | undefined);
    } as typeof stream.write;
    process.on("exit", flush);
    return (): void => {
      process.off("exit", flush);
      stream.write = write;
      flush();
    };
  });
  return () => undo.forEach((fn) => fn());
}

/** The log line for a checkpoint answer that found nothing waiting for it. */
function unmatchedDecision(request: CheckpointRequest): string {
  const which = request.checkpointId !== undefined ? `checkpoint #${request.checkpointId}` : "a checkpoint";
  const from = deciderText(request.by, request.who);
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

/** The agent a run of `odw replay` dispatches again (meta.replayOf, ODW extension), well-formed; null for any other run. */
function replayLinkOf(meta: Record<string, unknown>): { runId: string; agentId: number; label: string; base?: string } | null {
  const r = meta.replayOf as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object" || typeof r.runId !== "string" || typeof r.agentId !== "number") return null;
  const label = typeof r.label === "string" ? r.label : String(r.agentId);
  return { runId: r.runId, agentId: r.agentId, label, ...(isCommitId(r.base) ? { base: r.base } : {}) };
}

/** The Claude Code plugin a run's workflow came from (meta.plugin, ODW extension); null for any other run. */
function pluginOfMeta(raw: unknown): { name: string; id: string; version: string | null; scope: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== "string" || typeof p.id !== "string") return null;
  return {
    name: p.name,
    id: p.id,
    version: typeof p.version === "string" ? p.version : null,
    scope: typeof p.scope === "string" ? p.scope : "user",
  };
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
 * first. `stopNow` stops the run the same way for a reason of the run's own
 * (its `--deadline`; `stop` is told so): a signal after it forces. Listening ends at `dispose`.
 */
function watchStopSignals(handlers: {
  stop(why: string, deadline: boolean): void;
  force(signal: NodeJS.Signals, why: string): void;
}): { dispose(): void; stopNow(why: string): void } {
  let first: { signal: NodeJS.Signals | null; why: string } | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const begin = (signal: NodeJS.Signals | null, why: string): void => {
    first = { signal, why };
    deadline = setTimeout(
      () => handlers.force(signal ?? "SIGTERM", `the run did not stop within ${SIGNAL_GRACE_MS / 1000}s of ${signal ?? why}`),
      SIGNAL_GRACE_MS,
    );
    handlers.stop(why, signal === null);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (first) {
      const after = first.signal === signal ? "again" : `after ${first.signal ?? first.why}`;
      return handlers.force(signal, `worker received ${signal} ${after}`);
    }
    begin(signal, `worker received ${signal}`);
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  return {
    dispose: () => {
      clearTimeout(deadline);
      for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
    },
    stopNow: (why) => {
      if (!first) begin(null, why);
    },
  };
}

/** The longest a timer waits in one go: setTimeout fires at once past 2^31-1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Call `onPassed(seconds)` once the run's `meta.deadline` (`{ seconds, at }`,
 * `at` in Unix seconds; ODW extension: `--deadline`) passes — at once when it
 * already has. A far deadline is waited for in steps a timer can take.
 */
function watchDeadline(raw: unknown, onPassed: (seconds: number) => void): { dispose(): void } {
  const spec = raw as { seconds?: unknown; at?: unknown } | null | undefined;
  if (!spec || typeof spec.at !== "number" || !Number.isFinite(spec.at)) return { dispose: () => {} };
  const at = spec.at * 1000;
  const seconds = typeof spec.seconds === "number" ? spec.seconds : Math.round(spec.at - Date.now() / 1000);
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    const left = at - Date.now();
    if (left <= 0) return onPassed(seconds);
    timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
  };
  arm();
  return { dispose: () => clearTimeout(timer) };
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
  await executeRun(argv[0]!, { worker: true });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
