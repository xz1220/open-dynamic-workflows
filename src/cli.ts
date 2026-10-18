#!/usr/bin/env node
/**
 * Command-line front end (L6).
 *
 * `odw` starts runs and observes them. It is a thin client over the run
 * directory: `run` launches a background worker; everything else reads or pokes
 * the run directory. Run state lives on disk, so the CLI and worker stay fully
 * decoupled.
 *
 *   odw run <script.js> [--args JSON|@file] [--wait]
 *   odw list
 *   odw status <run_id>
 *   odw logs <run_id> [--follow]
 *   odw logs <run_id> --agent <id|label> [--raw] [--follow]
 *   odw agents <run_id> [--json]
 *   odw result <run_id> [--agent <id|label>]
 *   odw diff <run_id> [--agent <id|label>] [--stat]
 *   odw apply <run_id> --agent <id|label>|--all [--check] [--force] [--verify CMD|--no-verify]
 *             [--resolve [--adapter A] [--confirm]]   (a resolver run for a conflict; runtime/apply-resolve)
 *             [--pr [--base B] [--remote R] [--ready] [--title T]]   (a branch, pushed, and a draft PR; runtime/apply-pr)
 *   odw rerun|resume <run_id>
 *   odw pause|resume|stop <run_id>
 *   odw approve|reject <run_id> [--note TEXT] [--checkpoint N]
 *   odw approve <run_id> [--checkpoint N] (--payload JSON|@file | --edit)
 *   odw schedule add|list|remove|run …   (recurring runs via the OS scheduler, src/schedule/)
 *   odw compare <runA> <runB> [--json] [--agent <label|id>]   (what changed; runtime/compare)
 *   odw export <run_id> --otlp [--out FILE | --send]   (OpenTelemetry traces, runtime/otel-export.ts)
 *   odw bundle <run_id> [--out FILE] [--no-transcripts] [--max-bytes N]   (a shareable run, runtime/bundle.ts)
 *   odw serve FILE.odwrun | odw view FILE   (a bundle, read-only); odw serve --token [VALUE] (runtime/serve-auth.ts)
 *   odw eval <file|name> [--adapter a,b] [--repeats N] [--json] [--out F] [--baseline F]   (src/eval/)
 *   odw conformance [--json] [--case N] [--dir DIR]   (the dialect conformance suite, src/conformance/)
 *   odw test [<wf|file>] [--case N] [--json] [--keep]   (scripted replies, no model; src/wftest/)
 *   odw run <wf> --dry | --record [--record-to FILE]    (stub replies; a run kept as a test case)
 *   odw note <text…> | odw notes [<run_id>] [--json]   (the run's notes board, runtime/notes-view.ts)
 *   odw memory list|add|prune …   (workflow memory in .odw/memory, runtime/memory-cli.ts)
 *   odw estimate <wf> [--args JSON|@file] [--json]; odw run --estimate [--yes]   (from earlier runs, runtime/estimate-cli.ts)
 *   odw replay <run_id> --agent <id|label> [--prompt @file|TEXT] [--adapter A] [--model M]   (runtime/replay.ts)
 *   odw run <wf> --break <phase|label>[,…] | --step   (a checkpoint before them; src/breaks.ts)
 *   odw check <script.js|name> [--json]   (the loader's checks, with a code frame; src/check.ts)
 *   odw new [<template>] [--name N] [--force] [--yes]   (a workflow + starter test from an embedded template; src/new.ts)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { expandHome, isOnPath, listAdapters, loadConfig, locateConfig, resolveAdapter, resolveRunsRoot } from "./adapters/config.js";
import { isPermissionTier, permissionsBanner } from "./adapters/permissions.js";
import { trustBanner } from "./adapters/trust.js";
import { startEgressProxy, type EgressProxyConfig } from "./adapters/egress.js";
import { sandboxBanner, sandboxFlagOf, withSandboxFlag, type SandboxFlag } from "./adapters/sandbox.js";
import type { Adapter, Config, PermissionTier, TrustLevel } from "./adapters/types.js";
import { killAllAgentProcesses } from "./adapters/runner.js";
import { parseBreakNames } from "./breaks.js";
import { cmdCheck } from "./check.js";
import { checkEdit } from "./checkpoint.js";
import { CHECKPOINT_NOTE_MAX, isCheckpointId } from "./control.js";
import { cliActor, localLauncher } from "./identity.js";
import { runDoctor, type CheckStatus } from "./doctor.js";
import { AdapterNotFound } from "./errors.js";
import type { WorkflowEvent } from "./events.js";
import { VERSION } from "./index.js";
import { cmdInit } from "./init.js";
import { cmdNew } from "./new.js";
import { loadWorkflowScript } from "./loader.js";
import type { AgentChanges } from "./changes.js";
import { agentRowJson, agentRows, formatAgentTable, matchAgents, type AgentRow } from "./runtime/agents-view.js";
import { applyAgents, type AgentDiff } from "./runtime/apply.js";
import { resolverRuns } from "./runtime/apply-resolve.js";
import { applyPr } from "./runtime/apply-pr.js";
import {
  changedAgents,
  colorDiff,
  countChanges,
  diffFiles,
  formatChangeTable,
  formatFileList,
  truncationNoteOf,
} from "./runtime/changes-view.js";
import { compareRuns, findComparedAgents, formatAgentComparison, formatComparison, readCompareRun } from "./runtime/compare.js";
import { editBlocker, editorCommand, editPayload, readPayloadOption } from "./runtime/checkpoint-edit.js";
import { startRun, startRunFromSource, waitFor } from "./runtime/launcher.js";
import { attachRun, bannerLines, checkpointCommands, fallbackLines, formatEvent, formatUsage, resolveRunMode, runawayLines, shellArg, type RunMode } from "./runtime/live-view.js";
import { accountLines } from "./runtime/live-view.js";
import { isRunActive, RunObserver } from "./runtime/run-liveness.js";
import { RunStore, TERMINAL_STATES, type ReplayLink } from "./runtime/run-store.js";
import { detail, evalTagOf, summarize, type RunDetail } from "./runtime/runs-view.js";
import { spendLines } from "./runtime/spend-view.js";
import { DEADLINE_EXIT_CODE, deadlineReport, parseDeadline, stoppedByDeadline } from "./runtime/deadline.js";
import { exportRun, exportTimeout, otlpTarget, OTEL_SEND_TIMEOUT_MS, postTrace, spanCount } from "./runtime/otel-export.js";
import { startServer } from "./runtime/server.js";
import { triggerLines } from "./runtime/trigger-route.js";
import { BUNDLE_EXT, BundleError, bundleRedactor, createBundle, DEFAULT_BUNDLE_MAX_BYTES, isBundleRunId, openBundle, type OpenedBundle } from "./runtime/bundle.js";
import { generateToken, isValidToken } from "./runtime/serve-auth.js";
import { cmdToken, readTokens, TokenFileError, type NamedToken } from "./runtime/serve-tokens.js";
import { parsePublicUrl, publicUrlHasPath } from "./runtime/approve-links.js";
import { planReplay, readPromptOption, ReplayError, startReplay } from "./runtime/replay.js";
import { printAgentLogs } from "./runtime/transcript-view.js";
import { cmdNote, cmdNotes } from "./runtime/notes-view.js";
import { cmdMemory } from "./runtime/memory-cli.js";
import { cmdEstimate, estimateBeforeRun } from "./runtime/estimate-cli.js";
import { executeRun } from "./runtime/worker.js";
import {
  parseSshTarget,
  PASS_THROUGH,
  passThrough,
  type PassThroughCommand,
  printRunDir,
  pulledRunRefusal,
  pullRun,
  remoteRun,
  RemoteUsageError,
  takeOnFlag,
} from "./runtime/remote.js";
import { pausedForOf, pausedText } from "./quota-wait.js";
import { cmdSchedule } from "./schedule/command.js";
import { cmdEval } from "./eval/command.js";
import { cmdConformance } from "./conformance/command.js";
import { cmdTest } from "./wftest/command.js";
import { formatPhaseTree, phaseCounts } from "./wftest/dry.js";
import { isSeaBinary } from "./sea.js";
import { describeConcurrency } from "./throttle.js";
import { detectCaps, fmtUsd, glyphs, palette, sanitizeText } from "./tty.js";
import { resolveRunTrust } from "./untrusted.js";
import { pluginOrigin } from "./workflows/plugins.js";
import { listWorkflows, resolveWorkflow, type ResolvedWorkflow } from "./workflows/resolve.js";

export const COMMANDS = [
  "init",
  "doctor",
  "run",
  "attach",
  "rerun",
  "list",
  "status",
  "logs",
  "agents",
  "result",
  "serve",
  "workflows",
  "pause",
  "resume",
  "stop",
  "approve",
  "reject",
  "diff",
  "apply",
  "schedule",
  "compare",
  "export",
  "bundle",
  "view",
  "eval",
  "conformance",
  "pull",
  "test",
  "estimate",
  "replay",
  "check",
  "new",
  "token",
] as const;

export type Command = (typeof COMMANDS)[number];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function versionText(): string {
  return `open-dynamic-workflows ${VERSION}`;
}

export function helpText(): string {
  return [
    `odw — Open Dynamic Workflows (v${VERSION})`,
    "Run Claude Code-format dynamic-workflow scripts against any coding-agent CLI.",
    "",
    "Usage:",
    "  odw init [--adapter <name>] [--check]              pick the default agent CLI (first-time setup)",
    "  odw doctor [--smoke] [--adapter <name>|all]        check this machine is ready to run workflows",
    "  odw doctor --models                                send each configured adapter/model pair one tiny prompt",
    "  odw run <script.js|name> [--args JSON|@file]       start a workflow (see modes below)",
    "  odw attach <run_id>                                attach the live foreground view to a run",
    "  odw rerun <run_id>                                 start a fresh run with the same inputs",
    "  odw resume <run_id> [--force]                      unpause a paused run, or replay an ended one (below)",
    "  odw status <run_id>                                show a run's current state, tokens and cost",
    "  odw logs <run_id|--workflow name> [--follow]       print a run's progress events",
    "  odw logs <run_id> --agent <id|label> [--raw]       one agent's transcript: its tool calls, results, text (--follow)",
    "  odw agents <run_id> [--json]                       list a run's agents with their saved results",
    "  odw result <run_id> [--agent <id|label>]           print a finished run's result, or one agent's (mid-run too)",
    "  odw diff <run_id> [--agent <id|label>] [--stat]    print what isolated agents changed (their kept diffs)",
    "  odw apply <run_id> --agent <id|label>|--all        preview, then apply kept diffs to this working tree (--force)",
    "                                                     --check previews only; --verify CMD rolls an apply back if CMD fails",
    "                                                     --resolve [--adapter A] [--confirm]: an agent resolves a conflict, verified first",
    "                                                     --pr [--base B] [--ready] [--title T]: a branch, pushed, and a draft PR (gh); never merges",
    "  odw compare <runA> <runB> [--json]                 what changed: setup, time, cost, failures, replies",
    "                                                     --agent <label|id> shows one agent's whole reply diff",
    "  odw estimate <wf> [--args JSON|@file] [--json]     p50/p90 time, cost, tokens and agents, from its earlier runs (ODW extension)",
    "  odw list [--workflow <name>] [--by <name|me>]      list known runs; --by: the ones that name launched (ODW extension)",
    "  odw serve [--port N] [--host H] [--open]           open the live dashboard in a browser",
    "  odw token add <name> [--scope approve] --file F    a named token for odw serve --tokens F: printed once, its hash kept",
    "  odw token list|remove [<name>] --file F            the named tokens in F; withdraw one (ODW extension)",
    "  odw workflows list [--project|--global|--plugins|--all]  list workflows runnable by name,",
    "                                                     Claude Code plugins' as <plugin>:<name> (ODW extension)",
    "  odw workflows where <name>                         show the file a name resolves to",
    "  odw pause|resume|stop <run_id>                     control a running workflow",
    "  odw approve|reject <run_id> [--checkpoint N]       answer a checkpoint() the run waits at (--note TEXT)",
    "  odw approve <run_id> --edit | --payload JSON|@file approve it with an edited payload ($VISUAL/$EDITOR for --edit)",
    "  odw schedule add <name> <workflow> --cron EXPR     run a workflow on a timer via cron/launchd/systemd (below)",
    "  odw schedule list [--json] | remove|run <name>     list schedules; delete one; run one now",
    "  odw export <run_id> --otlp [--out FILE|--send]     the run as OpenTelemetry traces (OTLP/JSON; ODW extension)",
    "  odw bundle <run_id> [--out FILE] [--no-transcripts] one redacted file to share: <run_id>.odwrun (ODW extension)",
    "  odw view FILE.odwrun                               show a bundle read-only (odw serve --open FILE.odwrun)",
    "  odw eval <file|name> [--adapter a,b] [--repeats N] cases × adapters × repeats: pass rate, cost, time (ODW extension)",
    "                                                     --json, --out report.json, --baseline report.json (exit 1: regressed)",
    "  odw test [<wf|file>] [--case N] [--json] [--keep]  run .odw/tests/<wf>.json: scripted replies, checks; no model, $0 (ODW extension)",
    "  odw run <wf> --dry                                 every agent gets a stub (a schema's smallest value): the phase tree, $0",
    "  odw run <wf> --record [--record-to FILE]           keep the run as a test case (default .odw/tests/<wf>.json)",
    "  odw notes <run_id> [--json]                        a run's notes board: what its agents told each other (ODW extension)",
    '  odw note "<text>"                                  inside an agent with notes on: post a note for the run\'s other agents',
    '  odw note --keep [--paths G,…] "<text>"             …and keep it as workflow memory once the run ends (ODW extension)',
    "  odw memory list [<wf>] [--stale] [--json]          workflow memory in .odw/memory: what earlier runs learned (ODW extension)",
    '  odw memory add <wf> "<text>" [--paths G,…]         keep an entry by hand (--kind note|correction|lesson)',
    "  odw memory prune [<wf>] --stale | <wf> --id N      drop the stale entries, or one entry",
    "  odw run <wf> --on ssh://[user@]host[:port][/dir]   run it on your own server, detached; prints its run id (ODW extension)",
    "                                                     --sync git (default: HEAD + a patch of uncommitted changes) | rsync",
    "  odw status|logs|attach <run_id> --on ssh://host    the same command, run by the odw over there",
    "  odw approve|reject|pause|stop|resume <run_id> --on ssh://host   the same, there (a pulled copy is never answered here)",
    "  odw pull <run_id> --from ssh://host[/dir]          copy a remote run here (again while it runs): diff, apply, compare",
    "  odw replay <run_id> --agent <id|label>             run that one agent again as a new run, at the commit it saw (ODW extension)",
    "                                                     --prompt @file|TEXT, --adapter A, --model M replace its own; then odw compare",
    "  odw run <wf> --break <phase|label>[,…] | --step    stop for a decision before those phases/agents, or every phase (ODW extension)",
    "  odw check <script.js|name> [--json]                check a workflow loads: errors with line, column and a code frame",
    "  odw new [<template>] [--name N] [--force] [--yes]  a workflow + starter test in .odw/ from a built-in template; no args lists them",
    "",
    "Options:",
    "  --args JSON|@file   workflow input (JSON, @file.json, or a raw string)",
    "  --config <path>     path to an odw.config.json",
    "  --runs-root <dir>   directory runs are stored under",
    "  --source <dir>      run's working dir; also anchors a relative script path & project-name lookup",
    "  --adapter <name>    default agent() adapter for this run (explicit agent(p,{adapter}) still wins)",
    "  --permissions <t>   read | edit | full: what this run's agents may do (default edit; ODW extension)",
    "  --untrusted         keep the repository's CLAUDE.md, hooks, MCP servers and settings from agents where",
    "                      each CLI allows (claude --safe-mode), say where one cannot (ODW extension)",
    "  --sandbox container run each agent CLI (and exec() step) in a Docker/Podman container (ODW extension)",
    "  --sandbox-image <i> the image it runs in (else the config's sandbox.image); never pulled",
    "  --fg                run in the foreground: live progress on a TTY, plain event lines otherwise",
    "  -d, --detach        start in the background and print the run id",
    "  --wait              block until the run finishes, then print the result (one run-id line on stderr)",
    "  --timeout <s>       with --fg/--wait/attach: give up after s seconds, exit 124 (run continues)",
    "  --deadline <s>      odw run: STOP the run s seconds after it starts (stopped, diffs and finished agents kept);",
    "                      --wait/--fg then print what finished and exit 3 (ODW extension)",
    "  --budget <tokens>   token target exposed to the script as budget.total",
    "  --estimate          odw run: print the estimate from earlier runs first, then ask y/N (--yes: just print)",
    "  -h, --help          show this help",
    "  -v, --version       show the version",
    "",
    "Serve options (odw serve):",
    "  --port <n>          dashboard port (default 4317)",
    "  --host <addr>       dashboard bind address (default 127.0.0.1)",
    "  --open              open the dashboard in the default browser",
    "  --token [VALUE]     reads need a token (remote read-only access); no VALUE: a random one, printed once",
    "  --token-scope S     read (default), or approve: the token also answers checkpoints, nothing else",
    "  --tokens FILE       named tokens, each with its scope; what each does is attributed to its name",
    "                      (odw token add <name> [--scope approve] --file FILE | list | remove; ODW extension)",
    "  --public-url URL    answer signed one-time approve/reject links at URL (sent by \"waiting\" notify hooks)",
    "  --rotate-approve-secret  replace the approve-link secret: every link sent before stops working",
    "  (config \"triggers\")  answer signed GitHub/Linear/Slack/HMAC webhooks at POST /api/triggers/<name>,",
    "                      each starting its workflow untrusted (ODW extension; off loopback too)",
    "  FILE.odwrun         show that bundle alone, read-only (--max-bytes N raises the 32 MiB cap)",
    "",
    "Run modes (odw run / rerun / resume):",
    "  interactive terminal        attaches in the foreground (Ctrl-C detaches; the run keeps going)",
    "  piped / captured / CI       detaches and prints the run id — `RUN=$(odw run wf.js)` stays correct",
    "  ODW_DETACH=1                forces detach; explicit --fg/--wait/--detach always win",
    "",
    "Resume (odw resume <run_id>) acts on the run's state:",
    "  paused, worker alive        continues it in place (as odw pause|resume|stop always did)",
    "  done / failed / stopped,    starts a NEW run with the same script, args and adapter: every agent()",
    "  or stale (worker gone)      call unchanged since (same prompt and options) replays its saved result",
    "                              instead of running again; edited and new calls run. Takes the run",
    "                              modes and --adapter/--permissions/--untrusted/--sandbox/--config/--runs-root, like rerun",
    "  still running               refused (it would redo work in flight); --force starts the new run anyway",
    "",
    "Schedules (odw schedule, ODW extension — no daemon: cron, launchd or a systemd timer calls odw back):",
    "  add <name> <workflow> --cron \"0 8 * * *\" [--args JSON|@file] [--adapter X] [--config P] [--cwd DIR]",
    "      [--backend cron|launchd|systemd] [--dry-run]     default: launchd on macOS, cron elsewhere",
    "  list [--json]               each schedule's backend, last run and next run (local time)",
    "  remove <name>               delete its OS entry and its definition (fine if the entry is gone already)",
    "  run <name>                  what the OS entry calls: runs it like run --wait, skipped while the previous",
    "                              run still goes on; a line per run in ~/.local/state/odw/schedules/<name>.log;",
    "                              exit 0 when done or skipped, 1 otherwise",
  ].join("\n");
}

/** A command-line mistake: its message is printed as-is and the exit code is 2. */
class UsageError extends Error {}

/** Parse and dispatch a CLI invocation. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(helpText() + "\n");
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(versionText() + "\n");
    return 0;
  }

  try {
    // `--on ssh://host` (ODW extension): status, logs, attach — and approve, reject, pause, stop, resume — run on the remote odw instead.
    if ((PASS_THROUGH as readonly string[]).includes(command)) {
      const { url, rest: remoteArgs } = takeOnFlag(rest);
      if (url !== null) return await passThrough(command as PassThroughCommand, remoteArgs, parseSshTarget(url), process.cwd());
    }
    switch (command) {
      case "__run-dir":
        // Hidden: what `odw pull` asks a remote odw — the run's absolute directory (runtime/remote.ts).
        return cmdRunDir(rest);
      case "pull":
        return await cmdPull(rest);
      case "__worker":
        // Hidden: the worker entrypoint a background run re-execs into. In a SEA
        // binary there is no separate worker.js, so the binary calls itself here.
        return await cmdWorker(rest);
      case "__egress-proxy":
        // Hidden: a sandbox's egress proxy (ODW extension; see adapters/egress.ts), run until killed.
        return await cmdEgressProxy(rest);
      case "init":
        return await cmdInitCli(rest);
      case "new":
        return await cmdNewCli(rest);
      case "doctor":
        return await cmdDoctor(rest);
      case "run":
        return await cmdRun(rest);
      case "attach":
        return await cmdAttach(rest);
      case "rerun":
        return await cmdRerun(rest);
      case "resume":
        return await cmdResume(rest);
      case "status":
        return cmdStatus(rest);
      case "agents":
        return cmdAgents(rest);
      case "result":
        return cmdResult(rest);
      case "logs":
        return await cmdLogs(rest);
      case "list":
        return cmdList(rest);
      case "serve":
        return await cmdServe(rest);
      case "workflows":
        return cmdWorkflows(rest);
      case "pause":
      case "stop":
        return cmdControl(command, rest);
      case "approve":
      case "reject":
        return await cmdDecide(command, rest);
      case "diff":
        return await cmdDiff(rest);
      case "apply":
        return await cmdApply(rest);
      case "schedule":
        return await cmdSchedule(rest, { parseArgsValue });
      case "compare":
        return cmdCompare(rest);
      case "export":
        return await cmdExport(rest);
      case "bundle":
        return cmdBundle(rest);
      case "view":
        return await cmdServe(["--open", ...rest], "view");
      case "eval":
        return await cmdEval(rest);
      case "note":
        return cmdNote(rest, storeFrom);
      case "notes":
        return cmdNotes(rest, storeFrom);
      case "memory":
        return cmdMemory(rest);
      case "conformance":
        return await cmdConformance(rest);
      case "test":
        return await cmdTest(rest);
      case "estimate":
        return cmdEstimate(rest, parseArgsValue);
      case "replay":
        return await cmdReplay(rest);
      case "check":
        return cmdCheck(rest);
      case "token":
        return cmdToken(rest);
      default:
        process.stderr.write(`odw: unknown command '${command}'\n\n${helpText()}\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof RemoteUsageError) {
      const named = err instanceof RemoteUsageError && !err.message.startsWith("odw ") ? `odw ${command}: ` : "";
      process.stderr.write(`${named}${err.message}\n`);
      return 2;
    }
    const e = err as NodeJS.ErrnoException;
    process.stderr.write(`odw: ${e.message}\n`);
    // A parseArgs usage error (unknown flag, missing value) is a usage error → 2.
    return typeof e.code === "string" && e.code.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  }
}

// --- commands ----------------------------------------------------------------

/**
 * `odw doctor` — a readiness checklist (see doctor.ts). `--smoke` also sends one
 * real prompt to the default adapter (or each `--adapter`, or `all` installed);
 * `--models` (ODW extension) one to each adapter/model pair the config and
 * `.odw/workflows` name. Exit 0 when nothing failed, 1 otherwise; `--json` for machines.
 */
async function cmdDoctor(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      smoke: { type: "boolean" },
      models: { type: "boolean" },
      adapter: { type: "string", multiple: true },
      timeout: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const timeoutMs = parseTimeout("doctor", values.timeout);
  const cwd = process.cwd();
  let config: Config | Error;
  let configPath: string | null = null;
  try {
    configPath = locateConfig(values.config ?? null, cwd);
    config = loadConfig(values.config ?? null, { cwd, quiet: true });
  } catch (err) {
    config = err as Error;
  }
  let smoke: string[] = [];
  if (values.smoke && !(config instanceof Error)) {
    const wanted = values.adapter ?? [];
    if (wanted.includes("all")) smoke = listAdapters(config).filter((a) => a.installed).map((a) => a.name);
    else if (wanted.length) smoke = wanted;
    else if (config.settings.defaultAdapter) smoke = [config.settings.defaultAdapter];
  }
  // Smoke agents lead their own process groups, out of the terminal's reach:
  // on Ctrl-C (or a kill) take them down first, then die by the same signal.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals) => {
    killAllAgentProcesses();
    for (const s of signals) process.off(s, onSignal);
    process.kill(process.pid, signal);
  };
  for (const s of signals) process.on(s, onSignal);
  let report;
  try {
    report = await runDoctor({
      config,
      configPath,
      cwd,
      smoke,
      smokeTimeout: timeoutMs !== undefined ? timeoutMs / 1000 : undefined,
      models: values.models === true,
    });
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.ok ? 0 : 1;
  }
  const caps = detectCaps(process.stdout, process.env);
  const p = palette(caps);
  const g = glyphs(caps);
  const mark: Record<CheckStatus, string> = {
    ok: p.ok(g.ok),
    warn: p.run("!"),
    fail: p.err(g.fail),
    skip: p.dim(g.bullet),
  };
  const width = Math.max(...report.checks.map((c) => c.title.length));
  const lines = [p.bold(`odw doctor · v${VERSION}`), ""];
  for (const c of report.checks) {
    lines.push(`  ${mark[c.status]} ${c.title.padEnd(width)}  ${c.status === "skip" ? p.dim(c.detail) : c.detail}`);
    if (c.hint && c.status !== "ok") lines.push(`    ${" ".repeat(width)}  ${p.dim(`→ ${c.hint}`)}`);
  }
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    failed
      ? p.err(`${failed} check(s) failed`) + (warned ? p.dim(`, ${warned} warning(s)`) : "")
      : p.ok("ready") + (warned ? p.dim(` — ${warned} warning(s)`) : "") +
          (values.smoke || values.models ? "" : p.dim(" · add --smoke to send each adapter a real prompt")),
  );
  process.stdout.write(lines.join("\n") + "\n");
  return report.ok ? 0 : 1;
}

/** Hidden worker entrypoint: execute a run in this (SEA-re-exec'd) process. */
async function cmdWorker(rest: string[]): Promise<number> {
  const runDir = rest[0];
  if (!runDir) {
    process.stderr.write("odw __worker: missing <run_dir>\n");
    return 2;
  }
  const state = await executeRun(runDir, { worker: true });
  return state === "done" ? 0 : 1;
}

/** Hidden: `odw __egress-proxy <config.json>` — the egress proxy a sandbox's sidecar runs as a script of its own. */
async function cmdEgressProxy(rest: string[]): Promise<number> {
  const file = rest[0];
  if (!file) {
    process.stderr.write("odw __egress-proxy: missing <config.json> ({ allow, port, log, ready? })\n");
    return 2;
  }
  const server = startEgressProxy(JSON.parse(readFileSync(file, "utf8")) as EgressProxyConfig);
  await new Promise<void>((done) => {
    server.on("close", done);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
  });
  return 0;
}

/** `odw init` — detect agent CLIs and set/inspect the default (see src/init.ts). */
async function cmdInitCli(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      adapter: { type: "string" },
      check: { type: "boolean" },
      config: { type: "string" },
    },
  });
  return cmdInit(
    {
      ...(values.adapter !== undefined ? { adapter: values.adapter } : {}),
      check: values.check === true,
      config: values.config ?? null,
    },
    // The $0 first run it offers: `odw run hello --dry`, here, with its live view.
    { runDry: (argv) => cmdRun(argv.slice(1)) },
  );
}

/** `odw new` — a workflow and its starter test from an embedded template (see src/new.ts). */
async function cmdNewCli(rest: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        name: { type: "string" },
        force: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
      },
    });
  } catch (err) {
    throw new UsageError(`odw new: ${(err as Error).message}\nusage: odw new [<template>] [--name N] [--force] [--yes]`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new UsageError("usage: odw new [<template>] [--name N] [--force] [--yes]");
  return cmdNew({
    ...(positionals[0] !== undefined ? { template: positionals[0] } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    force: values.force === true,
    yes: values.yes === true,
  });
}

async function cmdRun(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      args: { type: "string" },
      config: { type: "string" },
      "runs-root": { type: "string" },
      source: { type: "string" },
      adapter: { type: "string" },
      permissions: { type: "string" },
      untrusted: { type: "boolean" },
      sandbox: { type: "string" },
      "sandbox-image": { type: "string" },
      wait: { type: "boolean" },
      fg: { type: "boolean" },
      detach: { type: "boolean", short: "d" },
      timeout: { type: "string" },
      deadline: { type: "string" },
      budget: { type: "string" },
      on: { type: "string" },
      sync: { type: "string" },
      dry: { type: "boolean" },
      record: { type: "boolean" },
      "record-to": { type: "string" },
      estimate: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      break: { type: "string", multiple: true },
      step: { type: "boolean" },
    },
  });
  const ref = positionals[0];
  if (!ref) {
    process.stderr.write("odw run: missing <script.js|name>\n");
    return 2;
  }
  // --dry and --record (ODW extensions; see wftest/): a run for $0, and a run kept as a test case.
  if ((values.dry || values.record || values["record-to"] !== undefined) && (values.on !== undefined || values.sync !== undefined)) {
    throw new UsageError("odw run: --dry and --record run here, not with --on");
  }
  if (values.dry && (values.record || values["record-to"] !== undefined)) throw new UsageError("odw run: --dry calls no model: there is nothing to --record");
  if (values["record-to"] !== undefined && !values.record) throw new UsageError("odw run: --record-to goes with --record");
  if (values.dry && values.detach) throw new UsageError("odw run: --dry waits for its run to print its phase tree; leave out --detach");
  // --estimate (ODW extension): what earlier runs of it cost, before this one starts.
  if (values.yes !== undefined && values.estimate === undefined) throw new UsageError("odw run: --yes goes with --estimate");
  if (values.estimate && (values.on !== undefined || values.sync !== undefined)) {
    throw new UsageError("odw run: --estimate reads this machine's runs; with --on, run odw estimate there");
  }
  if (values.on !== undefined || values.sync !== undefined) {
    if (values.break !== undefined || values.step !== undefined) throw new UsageError("odw run: --break and --step run here; the remote run cannot take them (yet)");
    return cmdRunRemote(ref, values as Record<string, string | boolean | undefined>);
  }
  // `--break`/`--step` (ODW extension; see breaks.ts): where the run stops for a decision.
  let breaks: { at: string[]; step: boolean } | null = null;
  if (values.break !== undefined || values.step === true) {
    try {
      breaks = { at: values.break !== undefined ? parseBreakNames(values.break) : [], step: values.step === true };
    } catch (err) {
      throw new UsageError(`odw run: ${(err as Error).message}`);
    }
  }

  let budgetTotal: number | null = null;
  if (values.budget !== undefined) {
    budgetTotal = Number(values.budget);
    if (!Number.isFinite(budgetTotal) || budgetTotal <= 0) {
      process.stderr.write("odw run: --budget must be a positive number\n");
      return 2;
    }
  }

  const { mode, timeoutMs } = resolveStartMode("run", values);
  // --deadline (ODW extension): the worker stops the run once it passes, in every mode.
  const deadlineSeconds = values.deadline === undefined ? null : parseDeadline(values.deadline);
  if (deadlineSeconds === null && values.deadline !== undefined) throw new UsageError("odw run: --deadline must be a positive number of seconds");
  const permissions = parsePermissions("run", values.permissions);
  const trust: TrustLevel | null = values.untrusted === true ? "untrusted" : null;
  const sandbox = parseSandbox("run", values.sandbox, values["sandbox-image"]);

  // A dry run answers every agent itself: no adapter needs to be installed.
  if (!values.dry) warnIfNoDefaultAdapter(values.adapter ?? null, values.config ?? null, values.source ?? null, "run");
  const record = values.record ? recordTarget(ref, values["record-to"], values.config ?? null, values.source ?? null) : null;

  if (values.estimate) {
    const flags = { config: values.config ?? null, runsRoot: values["runs-root"] ?? null, source: values.source ?? null };
    if (!(await estimateBeforeRun(ref, flags, parseArgsValue(values.args), values.yes === true))) return 1;
  }

  const { runId, store, workflow } = startRun(ref, {
    args: parseArgsValue(values.args),
    configPath: values.config ?? null,
    runsRoot: values["runs-root"] ?? null,
    source: values.source ?? null,
    adapter: values.adapter ?? null,
    permissions,
    trust,
    sandbox,
    budgetTotal,
    dry: values.dry === true,
    record,
    deadlineSeconds,
    breaks,
  });
  if (record) process.stderr.write(`recording: once ${runId} ends, it is a case of ${record.file} (odw test ${record.workflow})\n`);
  if (!values.dry) {
    return afterStart(store, runId, mode, {
      timeoutMs,
      hint: "started run",
      banner: withWorkflowLines(startBanner(values.config ?? null, values.source ?? null, permissions, trust, sandbox), workflow),
    });
  }
  // A dry run is waited for (a non-TTY start would detach), then shown as its phase tree.
  process.stderr.write(`dry run: every agent gets a stub reply, no model is called\n`);
  const code = await afterStart(store, runId, mode === "detach" ? "wait" : mode, { timeoutMs, hint: "started dry run" });
  const status = store.readStatus(runId);
  if (TERMINAL_STATES.has(String(status.state))) {
    const declared = Array.isArray(status.phases) ? (status.phases as Array<{ title?: unknown }>).map((ph) => ph?.title).filter((t): t is string => typeof t === "string") : [];
    const counts = phaseCounts(store.readEvents(runId), declared);
    const agents = counts.reduce((n, c) => n + c.agents, 0);
    process.stderr.write(`dry run ${runId} ${String(status.state)}: ${agents} agent${agents === 1 ? "" : "s"} started, no model called ($0)\n`);
    for (const line of formatPhaseTree(counts, detectCaps(process.stderr, process.env).unicode)) process.stderr.write(`  ${line}\n`);
  }
  return code;
}

/**
 * Where `odw run --record` keeps the run (ODW extension): `--record-to`, else
 * `.odw/tests/<workflow>.json` in the run's source directory — the workflow's
 * meta.name, else its file's stem — and what the test file names as its
 * workflow: the name given, or a path relative to that directory.
 */
function recordTarget(ref: string, to: string | undefined, configPath: string | null, source: string | null): { file: string; workflow: string } {
  const cwd = source ? resolve(source) : process.cwd();
  const isPath = /\.(?:[cm]?js|ts)$/i.test(ref) || /[\\/]/.test(ref);
  const workflow = isPath ? relative(cwd, resolve(cwd, ref)) || ref : ref;
  if (to !== undefined) return { file: resolve(to), workflow };
  let name = basename(ref).replace(/\.[^.]*$/, "");
  try {
    const { scriptPath } = resolveWorkflow(ref, { cwd, config: loadConfig(configPath, { quiet: true, cwd }) });
    name = loadWorkflowScript(readFileSync(scriptPath, "utf8"), scriptPath).meta.name;
  } catch {
    // startRun reports a workflow it cannot resolve; the stem names the file meanwhile.
  }
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "workflow";
  return { file: join(cwd, ".odw", "tests", `${safe}.json`), workflow };
}

/**
 * `odw run <wf> --on ssh://host [--sync git|rsync]` (ODW extension): the run
 * starts detached on that machine, under its own odw config and CLI logins
 * (runtime/remote.ts). Flags that name something here — a config, a runs
 * root — or that would watch the run here are refused; the run flags go on.
 */
async function cmdRunRemote(ref: string, values: Record<string, string | boolean | undefined>): Promise<number> {
  if (values.on === undefined) throw new UsageError("odw run: --sync goes with --on ssh://host");
  const sync = values.sync ?? "git";
  if (sync !== "git" && sync !== "rsync") throw new UsageError(`odw run: --sync must be git or rsync; got '${String(sync)}'`);
  for (const flag of ["config", "runs-root"]) {
    if (values[flag] !== undefined) throw new UsageError(`odw run: --${flag} names a file here; with --on the run uses the remote's own odw config`);
  }
  for (const flag of ["wait", "fg", "timeout"]) {
    if (values[flag] !== undefined) throw new UsageError(`odw run: --on always starts detached; watch it with odw attach <run_id> --on ${String(values.on)}`);
  }
  const target = parseSshTarget(String(values.on));
  // Validated here as they would be there, so a typo fails before anything is sent.
  parsePermissions("run", values.permissions as string | undefined);
  parseSandbox("run", values.sandbox as string | undefined, values["sandbox-image"] as string | undefined);
  if (values.budget !== undefined && !(Number(values.budget) > 0)) throw new UsageError("odw run: --budget must be a positive number");
  const flags: string[] = [];
  if (values.deadline !== undefined && parseDeadline(String(values.deadline)) === null) throw new UsageError("odw run: --deadline must be a positive number of seconds");
  for (const flag of ["adapter", "permissions", "sandbox", "sandbox-image", "budget", "deadline"]) {
    if (typeof values[flag] === "string") flags.push(`--${flag}`, values[flag] as string);
  }
  if (values.untrusted === true) flags.push("--untrusted");
  return remoteRun({
    ref,
    target,
    sync,
    source: typeof values.source === "string" ? values.source : process.cwd(),
    args: parseArgsValue(values.args as string | undefined),
    flags,
  });
}

/** `odw pull <run_id> --from ssh://host[/dir]` (ODW extension): copy a remote run into the local runs root. */
async function cmdPull(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { from: { type: "string" }, config: { type: "string" }, "runs-root": { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) throw new UsageError("odw pull: missing <run_id>");
  if (values.from === undefined) throw new UsageError("odw pull: --from ssh://[user@]host[:port][/dir] is required: where the run is");
  return pullRun({ runId, target: parseSshTarget(values.from, "--from"), store: storeFrom(values), cwd: process.cwd() });
}

/** Hidden `odw __run-dir <run_id>`: what `odw pull` asks a remote odw — the run's absolute directory. */
function cmdRunDir(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" } },
  });
  return printRunDir(storeFrom(values), positionals[0]);
}

/** `--sandbox container` and `--sandbox-image <image>` (ODW extension), validated; null when absent. */
function parseSandbox(cmd: string, raw: string | undefined, image: string | undefined): SandboxFlag | null {
  if (raw === undefined) {
    if (image !== undefined) throw new UsageError(`odw ${cmd}: --sandbox-image needs --sandbox container`);
    return null;
  }
  if (raw !== "container") throw new UsageError(`odw ${cmd}: --sandbox must be container; got '${raw}'`);
  if (image !== undefined && !/^[A-Za-z0-9][^\s]*$/.test(image)) {
    throw new UsageError(`odw ${cmd}: --sandbox-image must be an image reference such as odw-agents:latest; got '${image}'`);
  }
  return { kind: "container", image: image ?? null };
}

/** `--permissions <tier>` (ODW extension), validated; null when absent. */
function parsePermissions(cmd: string, raw: string | undefined): PermissionTier | null {
  if (raw === undefined) return null;
  if (isPermissionTier(raw)) return raw;
  throw new UsageError(`odw ${cmd}: --permissions must be read, edit or full; got '${raw}'`);
}

/**
 * The start banner (ODW extensions), a line each: the permissions line — the
 * run's tier and what each installed adapter runs with — the trust line —
 * the run's trust and, untrusted, how each installed adapter keeps the
 * repository out, or that it cannot — and the concurrency line, the caps
 * the run's agents get (per adapter too). All from the config
 * the worker will load, which resolves a project-local file against --source
 * (see warnIfNoDefaultAdapter). Undefined when that config cannot be read:
 * the launch itself reports that.
 */
function startBanner(
  configPath: string | null,
  source: string | null,
  permissions: PermissionTier | null,
  trust: TrustLevel | null = null,
  sandbox: SandboxFlag | null = null,
): string | undefined {
  try {
    const cwd = source ? resolve(source) : process.cwd();
    const config = loadConfig(configPath, { quiet: true, cwd });
    if (permissions) config.settings.permissions = permissions;
    // The sandbox line (ODW extension): `--sandbox container` over the config's.
    config.settings.sandbox = withSandboxFlag(config.settings.sandbox, sandbox);
    // The trust line (ODW extension), decided as the worker will decide it (see untrusted.ts).
    config.settings.trust = resolveRunTrust({ flag: trust, config, configPath, source: cwd, cwd }).trust;
    const installed = (adapter: Adapter): boolean => isOnPath(adapter.command[0]!);
    return [
      permissionsBanner(config, installed),
      trustBanner(config, installed),
      `concurrency: ${describeConcurrency(config)}`,
      // The sandbox line (ODW extension), when a container is in play: none adds no line.
      ...(config.settings.sandbox !== "none" || Object.values(config.adapters).some((a) => a.sandbox) ? [sandboxBanner(config)] : []),
    ].join("\n");
  } catch {
    return undefined;
  }
}

/**
 * The start banner with what resolving the workflow said (ODW extensions): a
 * Claude Code plugin's workflow names its plugin, and a name a plugin also
 * ships, or one an untrusted run would not take from the repository, says so.
 */
function withWorkflowLines(banner: string | undefined, workflow: ResolvedWorkflow | undefined): string | undefined {
  const lines = [
    ...(workflow?.plugin ? [`workflow: ${workflow.plugin.name} from ${pluginOrigin(workflow.plugin)} (run in place, never modified)`] : []),
    ...(workflow?.notes ?? []).map((note) => `note: ${note}`),
  ];
  if (lines.length === 0) return banner;
  return [banner, ...lines].filter((line) => line !== undefined).join("\n");
}

/** `--timeout <seconds>` as milliseconds (undefined when absent). */
function parseTimeout(cmd: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new UsageError(`odw ${cmd}: --timeout must be a non-negative number of seconds`);
  }
  return seconds * 1000;
}

/**
 * How `run`, `rerun` and `resume` present the run they start: the
 * --fg/--wait/--detach mode (or the TTY/CI default) and the --timeout that
 * bounds the viewer. One resolver, so the commands validate in the same order:
 * the --timeout value, then conflicting mode flags, then a --timeout a
 * detached start cannot honor.
 */
function resolveStartMode(
  cmd: "run" | "rerun" | "resume",
  flags: { fg?: boolean; detach?: boolean; wait?: boolean; timeout?: string },
): { mode: RunMode; timeoutMs: number | undefined } {
  const timeoutMs = parseTimeout(cmd, flags.timeout);
  const resolved = resolveRunMode(
    { fg: flags.fg === true, detach: flags.detach === true, wait: flags.wait === true },
    { stdoutTTY: process.stdout.isTTY === true, stderrTTY: process.stderr.isTTY === true },
    process.env,
  );
  if ("usageError" in resolved) throw new UsageError(`odw ${cmd}: ${resolved.usageError}`);
  if (timeoutMs !== undefined && resolved.mode === "detach") {
    throw new UsageError(
      `odw ${cmd}: --timeout needs --wait or --fg (a detached start returns immediately)`,
    );
  }
  return { mode: resolved.mode, timeoutMs };
}

/**
 * Launch-time preflight: a missing/ambiguous default adapter is knowable NOW,
 * but a detached start would defer it into the run — the launch prints a run id,
 * exits 0, and the failure is only visible in `odw status`. Surface it here.
 * A warning, not an error: workflows that name adapters per call never need a
 * default, so the launch must not be blocked. Quiet load — the launcher's own
 * loadConfig lints the same file right after. The worker runs with cwd =
 * --source, so the project-local config is resolved against source, not the
 * launcher's cwd — else this would warn about a config the run never reads
 * (and stay silent about the one it does). Exported for tests.
 */
export function warnIfNoDefaultAdapter(
  adapter: string | undefined | null,
  configPath: string | null,
  source: string | null,
  command: string,
): void {
  if (adapter != null) return;
  try {
    resolveAdapter(
      loadConfig(configPath, { quiet: true, ...(source ? { cwd: resolve(source) } : {}) }),
    );
  } catch (err) {
    if (!(err instanceof AdapterNotFound)) return; // a broken config file fails the launch itself
    process.stderr.write(
      `odw ${command}: warning: bare agent() calls in this run will fail — ${err.message}\n`,
    );
  }
}

/**
 * What run/rerun/resume do once the detached worker is spawned, per the
 * resolved mode. The run itself is identical in all three: only the viewer
 * differs.
 */
async function afterStart(
  store: RunStore,
  runId: string,
  mode: RunMode,
  opts: { timeoutMs?: number; hint: string; banner?: string },
): Promise<number> {
  // The start banner (permissions, concurrency) goes to stderr in every mode
  // — under the live view's header when attached.
  const banner = bannerLines(opts.banner)
    .map((line) => `${line}\n`)
    .join("");
  if (mode === "detach") {
    process.stdout.write(runId + "\n");
    process.stderr.write(`${opts.hint} ${runId} (use 'odw status ${runId}')\n${banner}`);
    return 0;
  }
  if (mode === "wait") {
    process.stderr.write(`running ${runId} ...\n${banner}`);
    // A checkpoint() holds the run until someone answers it: say so, and how, once each.
    const told = new Set<number>();
    // A pause for a spent quota (ODW extension: quotaWait) ends by itself: say until when, once each.
    const toldPauses = new Set<string>();
    let flags: string[] | undefined;
    const status = await waitFor(store, runId, {
      timeoutMs: opts.timeoutMs,
      onStatus: ({ waiting, state, pausedFor }) => {
        const pause = state === "paused" ? pausedForOf(pausedFor) : null;
        if (pause && !toldPauses.has(`${pause.adapter}@${pause.resumeAt}`)) {
          toldPauses.add(`${pause.adapter}@${pause.resumeAt}`);
          process.stderr.write(`${sanitizeText(pausedText(pause), 120)} — odw resume ${runId} goes on now\n`);
        }
        const cp = waiting as { checkpointId?: unknown; title?: unknown } | null | undefined;
        if (!cp || !isCheckpointId(cp.checkpointId) || told.has(cp.checkpointId)) return;
        told.add(cp.checkpointId);
        const { approve, reject } = checkpointCommands(runId, cp.checkpointId, (flags ??= storeFlagsFor(store)));
        process.stderr.write(
          `waiting for a decision — checkpoint #${cp.checkpointId}: ${sanitizeText(cp.title, 200)}\n` +
            `  approve: ${approve}\n  reject:  ${reject}\n`,
        );
      },
    });
    if (!TERMINAL_STATES.has(String(status.state))) {
      process.stderr.write(
        `timed out waiting for ${runId} — run continues (odw attach ${runId})\n`,
      );
      return 124;
    }
    return reportTerminal(store, runId, status);
  }
  return attachRun(store, runId, {
    out: process.stdout,
    err: process.stderr,
    timeoutMs: opts.timeoutMs,
    commandFlags: storeFlagsFor(store),
    banner: opts.banner,
  });
}

/** `odw attach <run_id>` — (re)attach the foreground view to an existing run. */
async function cmdAttach(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      timeout: { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw attach: missing <run_id>\n");
    return 2;
  }
  const timeoutMs = parseTimeout("attach", values.timeout);
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  return attachRun(store, runId, {
    out: process.stdout,
    err: process.stderr,
    timeoutMs,
    commandFlags: storeFlagsFor(store),
  });
}

function cmdStatus(rest: string[]): number {
  const { store, runId } = storeAndRun(rest);
  if (!store) return runId ? 1 : 2;
  const status = store.readStatus(runId);
  const meta = store.readMeta(runId);
  const events = store.readEvents(runId);
  const name = (status.name as string) || baseName(meta.script as string | undefined);
  // What waits for a person (checkpoint(), ODW extension): only a live run can be answered.
  const run = detail(store, runId);
  const pending = run.pendingCheckpoints ?? [];
  process.stdout.write(`${runId}  [${run.state === "waiting" ? "waiting" : (status.state ?? "?")}]  ${name}\n`);
  if (status.description) process.stdout.write(`  ${status.description as string}\n`);
  // A run `odw pull` copied here (ODW extension): a snapshot of one on another machine.
  const remote = meta.origin === "remote" ? (meta.remote as { url?: unknown; pulledAt?: unknown } | undefined) : undefined;
  if (remote && typeof remote.url === "string") {
    const at = typeof remote.pulledAt === "number" ? ` at ${new Date(remote.pulledAt * 1000).toLocaleString()}` : "";
    process.stdout.write(`  pulled from ${sanitizeText(remote.url, 200)}${at} — a copy: odw pull ${runId} --from ${sanitizeText(remote.url, 200)} refreshes it\n`);
  }
  // What a run paused for a spent quota waits for (ODW extension: quotaWait).
  if (run.pausedFor) {
    process.stdout.write(`  ${sanitizeText(pausedText(run.pausedFor), 120)} — its agents go on then; odw resume ${runId} goes on now\n`);
  }
  process.stdout.write(`  dispatched: ${dispatchedCount(events, status)} agent(s)\n`);
  // What its agents spent (ODW extension): as their CLIs reported it, or chars/4 estimates.
  if (run.usage) process.stdout.write(`  usage: ${formatUsage(run.usage)}${estimateNote(run)}\n`);
  // …and where, phase by phase: the dashboard's spend receipt in text (ODW extension).
  for (const line of spendLines(run, detectCaps(process.stdout, process.env))) process.stdout.write(`${line}\n`);
  // Each adapter CLI's version, as the run recorded it (ODW extension; see provenance.ts).
  const clis = Object.entries(run.cliVersions ?? {}).map(([name, cli]) => `${name} ${cli.version ?? `unknown (${cli.error ?? "?"})`}`);
  if (clis.length > 0) process.stdout.write(`  CLIs: ${sanitizeText(clis.join(" · "), 300)}\n`);
  // Agents that fell back to another adapter, and adapters the quota breaker took out (ODW extensions).
  for (const line of fallbackLines(run.agents, events)) process.stdout.write(`  ${line}\n`);
  // Agents per account of an adapter (ODW extension; see adapters/accounts.ts).
  for (const line of accountLines(run.agents)) process.stdout.write(`  ${line}\n`);
  // Agents killed at one of their limits, with the evidence (ODW extension; see limits.ts).
  for (const line of runawayLines(run.agents)) process.stdout.write(`  ${line}\n`);
  if (typeof meta.resumedFrom === "string") {
    const replayed = events.filter((e) => e.type === "agent_finished" && e.cached === true).length;
    process.stdout.write(`  resumed from: ${meta.resumedFrom} (${replayed} agent result(s) replayed)\n`);
  }
  const flags = pending.length > 0 ? storeFlagsFor(store) : [];
  for (const cp of pending) {
    const since = new Date(cp.since * 1000).toLocaleTimeString();
    const { approve, reject } = checkpointCommands(runId, cp.checkpointId, flags);
    process.stdout.write(`  waiting for a decision since ${since} — checkpoint #${cp.checkpointId}: ${sanitizeText(cp.title, 200)}\n`);
    for (const line of payloadPreview(cp.payload)) process.stdout.write(`    ${line}\n`);
    process.stdout.write(`    approve: ${approve}\n    reject:  ${reject}\n`);
  }
  if (pending.length > 0) process.stdout.write("    (--note TEXT tells the workflow why)\n");
  if (pending.length > 0) process.stdout.write("    (odw approve --edit approves an edited payload; --payload JSON|@file does it without an editor)\n");
  return 0;
}

/** Lines of a checkpoint's payload a terminal shows: the start of it; the dashboard has it whole. */
function payloadPreview(payload: unknown, maxLines = 20): string[] {
  if (payload === null || payload === undefined) return [];
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  // Workflow-controlled text: sanitized, but keeping its indentation (the JSON's nesting).
  const lines = text.split("\n").map((line) => /^ */.exec(line)![0] + sanitizeText(line, 160));
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more line(s): the dashboard (odw serve) shows it all`);
  return ["payload:", ...shown.map((line) => `  ${line}`)];
}

/** Why a run's usage reads `~`: how many of its agents' CLIs reported no output tokens. */
function estimateNote(run: RunDetail): string {
  if (!run.usage?.estimated) return "";
  const counted = run.agents.filter((a) => a.usage);
  const estimated = counted.filter((a) => a.usage!.estimated).length;
  return estimated === counted.length
    ? " (estimated: chars/4 of the replies — the adapter reports no usage)"
    : ` (estimated in part: ${estimated} of ${counted.length} agents reported no output tokens)`;
}

/** Real dispatches: replayed agents (odw resume) never took one. */
function dispatchedCount(events: WorkflowEvent[], status: Record<string, unknown>): number {
  const recorded = typeof status.dispatched === "number" ? status.dispatched : 0;
  const observed = events.filter((e) => e.type === "agent_started" && e.cached !== true).length;
  return Math.max(recorded, observed);
}

/**
 * `odw result <run_id>` prints a finished run's result; with `--agent
 * <id|label>`, one agent's saved value — there as soon as that agent finished,
 * while the run is still going (or after it stalled, stopped or died).
 */
function cmdResult(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" }, agent: { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("missing <run_id>\n");
    return 2;
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  if (values.agent !== undefined) return reportAgent(store, runId, values.agent);
  return reportTerminal(store, runId, store.readStatus(runId));
}

/** One agent's saved value as JSON on stdout; an unknown, ambiguous or unfinished agent is an error. */
function reportAgent(store: RunStore, runId: string, ref: string): number {
  const matches = matchAgents(agentRows(store, runId), ref);
  if (matches.length === 0) {
    process.stderr.write(`run ${runId} has no agent '${ref}' (see odw agents ${runId})\n`);
    return 1;
  }
  if (matches.length > 1) {
    const ids = matches.map((r) => `${r.agentId ?? "?"} (${r.state})`).join(", ");
    process.stderr.write(
      `label '${ref}' matches ${matches.length} agents of run ${runId}: ${ids} — pick one: odw result ${runId} --agent <id>\n`,
    );
    return 1;
  }
  const row = matches[0]!;
  if (!row.record) {
    const why =
      row.state === "failed"
        ? `failed: ${row.error ?? "unknown error"}`
        : row.state === "done"
          ? "finished, but no result was saved for it (a run from before per-agent results, or the save failed — see odw logs)"
          : `is ${row.state}: no result yet`;
    process.stderr.write(`agent ${row.agentId ?? "?"} (${row.label}) ${why}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(row.record.value, null, 2) + "\n");
  return 0;
}

/**
 * `odw agents <run_id> [--json]` — every agent of a run (running and failed
 * ones too) with a one-line preview of its saved result. Works mid-run.
 */
function cmdAgents(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" }, json: { type: "boolean" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw agents: missing <run_id>\n");
    return 2;
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const rows = agentRows(store, runId);
  if (values.json) {
    process.stdout.write(JSON.stringify(rows.map(agentRowJson), null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stderr.write(`run ${runId} has no agents yet\n`);
    return 0;
  }
  const caps = detectCaps(process.stdout, process.env);
  const width = process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120;
  for (const line of formatAgentTable(rows, { width, caps })) process.stdout.write(line + "\n");
  const replayed = rows.some((r) => r.cached) ? `${caps.unicode ? "↺" : "(r)"} replayed by odw resume · ` : "";
  process.stderr.write(`${replayed}full value: odw result ${runId} --agent <id|label>\n`);
  return 0;
}

/**
 * `odw diff <run_id> [--agent <id|label>] [--stat]` (ODW extension) — what the
 * run's isolated agents changed, as the diffs kept in its directory: every
 * agent that kept one, each under a `# odw: agent …` line, or `--agent`'s
 * alone, verbatim. `--stat` prints a table instead (and `--agent`'s files).
 */
async function cmdDiff(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      agent: { type: "string" },
      stat: { type: "boolean" },
    },
  });
  const runId = positionals[0];
  if (!runId) throw new UsageError("odw diff: missing <run_id>");
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const rows = agentRows(store, runId);
  let agents = changedAgents(store, runId, rows);
  if (values.agent !== undefined) {
    const row = findAgent(rows, runId, values.agent, "diff");
    if (!row) return 1;
    agents = agents.filter((a) => a.row.agentId === row.agentId);
    if (agents.length === 0) {
      process.stderr.write(`agent ${row.agentId} (${sanitizeText(row.label, 80)}) kept no diff: ${noDiffReason(row)}\n`);
      return 0;
    }
  } else if (agents.length === 0) {
    process.stderr.write(
      `run ${runId} kept no changes: agents that run with isolation: "worktree" keep a diff of what they changed\n`,
    );
    return 0;
  }
  const caps = detectCaps(process.stdout, process.env);
  const width = process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120;
  if (values.stat) {
    const counted: Array<{ row: AgentRow; changes: AgentChanges; text?: string }> = [];
    for (const { row, file } of agents) {
      // The event's counts describe the whole change; the diff's own, a kept diff whose event is gone.
      const text = row.changes && values.agent === undefined ? undefined : await readFile(file, "utf8");
      counted.push({ row, changes: row.changes ?? countChanges(text!), text });
    }
    for (const line of formatChangeTable(counted, { width, caps })) process.stdout.write(line + "\n");
    const one = counted.length === 1 && values.agent !== undefined ? counted[0]! : undefined;
    if (one?.text !== undefined) {
      for (const line of formatFileList(diffFiles(one.text), { width, caps })) process.stdout.write(line + "\n");
      const cut = truncationNoteOf(one.text);
      if (cut) process.stdout.write(`  ${sanitizeText(cut, width)}\n`);
    }
    process.stderr.write(`full diff: odw diff ${runId} --agent <id|label> · apply one: odw apply ${runId} --agent <id|label>\n`);
    return 0;
  }
  // Colour only for a terminal: a diff piped or saved stays a patch git can read.
  const paint = process.stdout.isTTY === true && caps.color;
  for (const { row, file } of agents) {
    const text = await readFile(file, "utf8");
    if (values.agent === undefined) {
      const c = row.changes ?? countChanges(text);
      const kept = row.branch ? ` · branch ${row.branch}` : "";
      const head = `# odw: agent ${row.agentId} · ${sanitizeText(row.label, 80)} · ${c.files} file(s) +${c.insertions} -${c.deletions}${kept}`;
      process.stdout.write((paint ? colorDiff(head, caps) : head) + "\n");
    }
    process.stdout.write(paint ? colorDiff(text, caps) : text);
  }
  return 0;
}

/**
 * `odw apply <run_id> (--agent <id|label> | --all) [--check] [--force]
 * [--verify CMD | --no-verify]` (ODW extension) — preview, then apply, what
 * isolated agents changed to the git working tree you are in (see
 * runtime/apply): one agent's kept diff, or every finished agent's in agentId
 * order up to the first that would conflict. `--check` previews only;
 * `--verify` (else the `applyVerify` setting) runs a command after each apply
 * and rolls the apply back when it fails. Exit 0 when everything applied
 * cleanly (and passed), 1 otherwise. A signal during a verify rolls its apply
 * back, then ends odw by that signal. `--resolve [--adapter A] [--confirm]`
 * hands a conflict to a resolver run instead (runtime/apply-resolve), never
 * with `--force` or `--check`. `--pr [--base B] [--remote R] [--draft|--ready]
 * [--title T]` puts the diffs on a new branch instead, pushes it and opens a
 * PR with gh (runtime/apply-pr): your working tree is never touched.
 */
async function cmdApply(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      agent: { type: "string" },
      all: { type: "boolean" },
      check: { type: "boolean" },
      force: { type: "boolean" },
      verify: { type: "string" },
      "no-verify": { type: "boolean" },
      resolve: { type: "boolean" },
      adapter: { type: "string" },
      confirm: { type: "boolean" },
      pr: { type: "boolean" },
      base: { type: "string" },
      remote: { type: "string" },
      draft: { type: "boolean" },
      ready: { type: "boolean" },
      title: { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId) throw new UsageError("odw apply: missing <run_id>");
  if (!values.pr) {
    for (const flag of ["base", "remote", "draft", "ready", "title"] as const) {
      if (values[flag] !== undefined) throw new UsageError(`odw apply: --${flag} goes with --pr`);
    }
  } else {
    // A PR branch is made in a worktree of its own: nothing of yours is in the way, and nothing is only previewed.
    if (values.check) throw new UsageError("odw apply: --pr pushes a branch; --check previews only — drop one");
    if (values.force) throw new UsageError("odw apply: --pr never touches your working tree, so there is nothing to --force");
    if (values.resolve) throw new UsageError("odw apply: --pr does not take --resolve: resolve the conflict with odw apply --resolve first");
    if (values.draft && values.ready) throw new UsageError("odw apply: --draft and --ready exclude each other");
    for (const flag of ["base", "remote", "title"] as const) {
      if (values[flag] !== undefined && values[flag]!.trim() === "") throw new UsageError(`odw apply: --${flag} needs a value`);
    }
  }
  if (!values.resolve) {
    for (const flag of ["adapter", "confirm"] as const) {
      if (values[flag] !== undefined) throw new UsageError(`odw apply: --${flag} goes with --resolve`);
    }
  } else {
    // A resolver's work lands only on a tree whose paths hold nothing uncommitted, and is applied, not previewed.
    if (values.force) throw new UsageError("odw apply: --resolve does not apply over uncommitted changes: commit or stash them instead of --force");
    if (values.check) throw new UsageError("odw apply: --resolve applies; --check previews only — drop one");
  }
  if (values.agent === undefined && !values.all) {
    throw new UsageError(
      `odw apply: --agent <id|label> or --all is required — which agent's change to apply (odw diff ${runId} --stat lists them)`,
    );
  }
  if (values.agent !== undefined && values.all) throw new UsageError("odw apply: --agent and --all exclude each other");
  if (values.verify !== undefined && values["no-verify"]) throw new UsageError("odw apply: --verify and --no-verify exclude each other");
  if (values.verify !== undefined && values.verify.trim() === "") {
    throw new UsageError('odw apply: --verify needs a command to run, e.g. --verify "npm test"');
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const rows = agentRows(store, runId);
  let agents: AgentDiff[];
  if (values.all) {
    agents = changedAgents(store, runId, rows);
    if (agents.length === 0) {
      process.stderr.write(`run ${runId} kept no changes: agents that run with isolation: "worktree" keep a diff of what they changed\n`);
      return 0;
    }
  } else {
    const row = findAgent(rows, runId, values.agent!, "apply");
    if (!row) return 1;
    const file = store.agentDiffPath(runId, row.agentId);
    if (!existsSync(file)) {
      process.stderr.write(`odw apply: agent ${row.agentId} (${sanitizeText(row.label, 80)}) of run ${runId} kept no diff: ${noDiffReason(row)}\n`);
      return 1;
    }
    agents = [{ row, file }];
  }
  const check = values.check === true;
  // --check applies nothing, so it verifies nothing; --no-verify skips the applyVerify setting once.
  const settings = check || values["no-verify"] ? null : loadConfig(values.config ?? null, { quiet: true }).settings;
  const verify = settings ? (values.verify ?? settings.applyVerify) : null;
  const source = store.readMeta(runId).source;
  // A signal while an apply is verified stops the command; the apply is rolled back before odw ends by it.
  const interrupt = new AbortController();
  let caught: NodeJS.Signals | null = null;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals): void => {
    caught ??= signal;
    interrupt.abort();
  };
  if (values.adapter !== undefined) resolveAdapter(loadConfig(values.config ?? null, { quiet: true }), values.adapter); // fail fast on unknown names
  const resolveWith = values.resolve
    ? {
        ...resolverRuns({ store, runId, configPath: values.config ?? null, adapter: values.adapter ?? null }),
        confirm: values.confirm === true,
        input: process.stdin,
      }
    : null;
  if (verify || resolveWith || values.pr) for (const s of signals) process.on(s, onSignal);
  // A pipe or terminal that goes away (EPIPE, EIO) must not end odw between an apply and its rollback.
  const unheard = (): void => {};
  process.stdout.on("error", unheard);
  process.stderr.on("error", unheard);
  try {
    if (values.pr) {
      return await applyPr({
        cwd: process.cwd(),
        runId,
        agents,
        all: values.all === true,
        verify,
        timeout: settings?.timeout ?? null,
        interrupt: interrupt.signal,
        source: typeof source === "string" ? source : undefined,
        out: process.stdout,
        err: process.stderr,
        caps: detectCaps(process.stdout, process.env),
        width: process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120,
        pr: {
          base: values.base ?? null,
          remote: values.remote ?? "origin",
          draft: values.ready !== true,
          title: values.title ?? null,
          run: detail(store, runId),
        },
      });
    }
    return await applyAgents({
      cwd: process.cwd(),
      runId,
      agents,
      all: values.all === true,
      check,
      force: values.force === true,
      verify,
      timeout: settings?.timeout ?? null,
      interrupt: interrupt.signal,
      source: typeof source === "string" ? source : undefined,
      resolve: resolveWith,
      out: process.stdout,
      err: process.stderr,
      caps: detectCaps(process.stdout, process.env),
      width: process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120,
    });
  } finally {
    process.stdout.off("error", unheard);
    process.stderr.off("error", unheard);
    for (const s of signals) process.off(s, onSignal);
    if (caught) process.kill(process.pid, caught);
  }
}

/**
 * `odw compare <runA> <runB> [--json] [--agent <label|id>]` (ODW extension) —
 * what changed from run A to run B (see runtime/compare): the setup each ran
 * with, time, tokens, cost, which agents failed, whether their replies
 * differ. `--json` prints the comparison; `--agent` one agent's row and its
 * whole reply diff (with `--json`, that row). A run still going is compared
 * as it stands. Exit 0 once compared, 1 for a missing run or agent.
 */
function cmdCompare(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      json: { type: "boolean" },
      agent: { type: "string" },
    },
  });
  const [runA, runB, extra] = positionals;
  if (!runA || !runB || extra !== undefined) throw new UsageError("usage: odw compare <runA> <runB> [--json] [--agent <label|id>]");
  const store = storeFrom(values);
  for (const id of [runA, runB]) {
    if (!store.exists(id)) {
      process.stderr.write(`no such run: ${id}\n`);
      return 1;
    }
  }
  const a = readCompareRun(store, runA);
  const b = readCompareRun(store, runB);
  const caps = detectCaps(process.stdout, process.env);
  const width = Math.min(100, process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 100);
  if (values.agent !== undefined) {
    const bounded = compareRuns(a, b).agents;
    const rows = findComparedAgents(bounded, values.agent);
    if (rows.length === 0) {
      process.stderr.write(`neither run has an agent '${values.agent}' (see odw compare ${runA} ${runB})\n`);
      return 1;
    }
    if (rows.length > 1) {
      const which = rows.map((r) => `A#${r.a?.agentId ?? "-"}↔B#${r.b?.agentId ?? "-"}`).join(", ");
      process.stderr.write(
        `'${values.agent}' matches ${rows.length} agents: ${which} — pick one by its id in A (else B): --agent <id>\n`,
      );
      return 1;
    }
    // The whole reply diff: the comparison again, its bounds lifted — the same rows, in the same order.
    const full = compareRuns(a, b, { diffLines: Infinity, jsonPaths: Infinity, chars: Infinity });
    const row = full.agents[bounded.indexOf(rows[0]!)]!;
    if (values.json) {
      process.stdout.write(JSON.stringify(row, null, 2) + "\n");
      return 0;
    }
    for (const line of formatAgentComparison(row, full, { width, caps })) process.stdout.write(line + "\n");
    return 0;
  }
  const comparison = compareRuns(a, b);
  if (values.json) {
    process.stdout.write(JSON.stringify(comparison, null, 2) + "\n");
    return 0;
  }
  for (const line of formatComparison(comparison, { width, caps })) process.stdout.write(line + "\n");
  process.stderr.write(`one agent's whole reply diff: odw compare ${runA} ${runB} --agent <label|id> · all of it as JSON: --json\n`);
  return 0;
}

/**
 * `odw replay <run_id> --agent <id|label> [--prompt @file|TEXT] [--adapter A]
 * [--model M]` (ODW extension; runtime/replay.ts): that one agent's saved call
 * dispatched again as a new run — at the commit an isolated one started from
 * — in the run modes of `odw run`; then how to compare it with the original.
 */
async function cmdReplay(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      prompt: { type: "string" },
      adapter: { type: "string" },
      model: { type: "string" },
      config: { type: "string" },
      "runs-root": { type: "string" },
      wait: { type: "boolean" },
      fg: { type: "boolean" },
      detach: { type: "boolean", short: "d" },
      timeout: { type: "string" },
    },
  });
  const [runId, extra] = positionals;
  if (!runId || extra !== undefined || values.agent === undefined) {
    throw new UsageError("usage: odw replay <run_id> --agent <id|label> [--prompt @file|TEXT] [--adapter A] [--model M]");
  }
  for (const [flag, value] of [["prompt", values.prompt], ["adapter", values.adapter], ["model", values.model]] as const) {
    if (value !== undefined && value.trim() === "") throw new UsageError(`odw replay: --${flag} must not be empty`);
  }
  const start = resolveStartMode("run", values);
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const rows = agentRows(store, runId);
  const row = findAgent(rows, runId, values.agent, "replay");
  if (!row) return 1;
  let replayRun: { runId: string; store: RunStore };
  try {
    const plan = planReplay(store, runId, row.agentId, {
      ...(values.prompt !== undefined ? { prompt: readPromptOption(values.prompt) } : {}),
      ...(values.adapter !== undefined ? { adapter: values.adapter } : {}),
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values.config !== undefined ? { configPath: values.config } : {}),
    });
    replayRun = startReplay(plan);
    process.stderr.write(`replaying agent ${row.agentId} (${sanitizeText(row.label, 80)}) of ${runId}\n`);
    for (const note of plan.notes) process.stderr.write(`  ${sanitizeText(note, 200)}\n`);
  } catch (err) {
    if (err instanceof ReplayError) {
      process.stderr.write(`odw replay: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const code = await afterStart(replayRun.store, replayRun.runId, start.mode, { timeoutMs: start.timeoutMs, hint: "started replay" });
  // The original by its label when no other agent of its run has it, else by its id in the original run.
  const unique = rows.filter((r) => r.label === row.label).length === 1;
  const ref = unique ? row.label : String(row.agentId);
  const flags = storeFlagsFor(replayRun.store);
  const words = [runId, replayRun.runId, "--agent", ref, ...flags].map(shellArg).join(" ");
  process.stderr.write(`compare it with the original: odw compare ${words}\n`);
  return code;
}

/** The one agent `ref` names (an id or a label), or null once the reason it is none is printed. */
function findAgent(rows: AgentRow[], runId: string, ref: string, cmd: string): (AgentRow & { agentId: number }) | null {
  const matches = matchAgents(rows, ref);
  if (matches.length === 0) {
    process.stderr.write(`run ${runId} has no agent '${ref}' (see odw agents ${runId})\n`);
    return null;
  }
  if (matches.length > 1) {
    const ids = matches.map((r) => `${r.agentId ?? "?"} (${r.state})`).join(", ");
    process.stderr.write(
      `label '${ref}' matches ${matches.length} agents of run ${runId}: ${ids} — pick one: odw ${cmd} ${runId} --agent <id>\n`,
    );
    return null;
  }
  const row = matches[0]!;
  if (row.agentId === null) {
    const kept = cmd === "logs" ? "transcript" : cmd === "replay" ? "call to replay" : "diff";
    process.stderr.write(`that agent of run ${runId} has no id (a run from before agent ids): it kept no ${kept}\n`);
    return null;
  }
  return row as AgentRow & { agentId: number };
}

/** Why an agent has no kept diff. */
function noDiffReason(row: AgentRow): string {
  if (row.state === "running") return "it is still running";
  return 'it changed nothing, or it did not run with isolation: "worktree"';
}

/**
 * `odw logs <run_id> [--follow]` prints a run's progress events; with `--agent
 * <id|label>` one agent's transcript instead — what its CLI printed (ODW
 * extension; see runtime/transcript-view): readable, or its lines as kept
 * with `--raw`, and with `--follow` until that agent settles.
 */
async function cmdLogs(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      follow: { type: "boolean" },
      workflow: { type: "string" },
      agent: { type: "string" },
      raw: { type: "boolean" },
    },
  });
  if (values.raw && values.agent === undefined) {
    throw new UsageError("odw logs: --raw prints an agent's transcript as kept — name the agent with --agent <id|label>");
  }
  const store = storeFrom(values);
  let runId = positionals[0];
  // --workflow with no explicit id targets that workflow's most recent run,
  // reading only its bucket (no full scan).
  if (!runId && values.workflow) {
    const refs = store.listRunsForWorkflow(values.workflow);
    if (refs.length === 0) {
      process.stderr.write(`no runs found for workflow '${values.workflow}'\n`);
      return 1;
    }
    runId = refs[0]!.runId;
  }
  if (!runId) {
    process.stderr.write("missing <run_id> (or --workflow <name>)\n");
    return 2;
  }
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  if (values.agent !== undefined) {
    const row = findAgent(agentRows(store, runId), runId, values.agent, "logs");
    if (!row) return 1;
    const caps = detectCaps(process.stdout, process.env);
    const width = process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120;
    return printAgentLogs(store, runId, row, {
      raw: values.raw === true,
      follow: values.follow === true,
      out: process.stdout,
      err: process.stderr,
      caps,
      width,
    });
  }
  const observer = new RunObserver(store, runId);
  for (;;) {
    const observed = observer.read();
    for (const ev of observed.events) process.stdout.write(formatEvent(ev) + "\n");
    if (!values.follow) return 0;
    if (observed.note) process.stderr.write(observed.note + "\n");
    if (observed.error) {
      process.stderr.write(observed.error + "\n");
      return 1;
    }
    if (observed.terminal) {
      return observed.status.state === "done" ? 0 : reportTerminal(store, runId, observed.status);
    }
    await delay(300);
  }
}

function cmdList(rest: string[]): number {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      workflow: { type: "string" },
      by: { type: "string" },
    },
  });
  const store = storeFrom(values);
  const all = values.workflow ? store.listRunsForWorkflow(values.workflow) : store.listRuns();
  // `--by <name>` (ODW extension; see identity.ts): the runs it launched — `me` is the local user.
  const by = values.by === undefined ? null : (values.by === "me" ? localLauncher() : values.by.trim()) ?? "";
  if (by === "") throw new UsageError("odw list: --by needs a name (or me)");
  const runs = by === null ? all : all.filter((ref) => sameWho(store.readMeta(ref.runId).launchedBy, by));
  if (runs.length === 0) {
    const of = [values.workflow ? `for workflow '${values.workflow}'` : "", by !== null ? `launched by '${by}'` : ""].filter(Boolean).join(" ");
    process.stderr.write(of ? `no runs found ${of}\n` : "no runs found\n");
    return 0;
  }
  // What each run cost (ODW extension): a column only when some listed run reported dollars.
  const costs = runs.map((ref) => summarize(store, ref.runId).usage?.costUsd);
  const costW = Math.max(0, ...costs.map((c) => (c === undefined ? 0 : fmtUsd(c).length)));
  const none = detectCaps(process.stdout, process.env).unicode ? "—" : "-";
  for (const [i, ref] of runs.entries()) {
    const cost = costW > 0 ? `${(costs[i] === undefined ? none : fmtUsd(costs[i]!)).padStart(costW)}  ` : "";
    const status = store.readStatus(ref.runId);
    const name = (status.name as string) || ref.workflowName || "";
    // status.json names the checkpoint() a running run waits at (ODW extension).
    const state = status.state === "running" && status.waiting ? "waiting" : String(status.state ?? "?");
    // …and what a run paused for a spent quota waits for (ODW extension: quotaWait).
    const pausedFor = status.state === "paused" ? pausedForOf(status.pausedFor) : null;
    const until = pausedFor ? `  ${sanitizeText(pausedText(pausedFor), 120)}` : "";
    // A run `odw eval` started says which eval, case, adapter and repeat (ODW extension).
    const tag = evalTagOf(store.readMeta(ref.runId)).eval;
    const of = tag ? `  (eval ${sanitizeText(`${tag.name} · ${tag.case} · ${tag.adapter} #${tag.repeat}`, 120)})` : "";
    process.stdout.write(`${ref.runId}  ${state.padEnd(8)}  ${cost}${name}${until}${of}\n`);
  }
  return 0;
}

/** Is meta.json's `launchedBy` the name `by` (case aside: an email's case says nothing)? */
function sameWho(launchedBy: unknown, by: string): boolean {
  return typeof launchedBy === "string" && launchedBy.toLowerCase() === by.toLowerCase();
}

/**
 * The flags `odw rerun` and `odw resume` share: where to find the run, the
 * run-level adapter of the new run, and how to present it.
 */
const RELAUNCH_OPTIONS = {
  config: { type: "string" },
  "runs-root": { type: "string" },
  adapter: { type: "string" },
  permissions: { type: "string" },
  untrusted: { type: "boolean" },
  sandbox: { type: "string" },
  "sandbox-image": { type: "string" },
  wait: { type: "boolean" },
  fg: { type: "boolean" },
  detach: { type: "boolean", short: "d" },
  timeout: { type: "string" },
} as const;

/** `odw rerun <run_id>` — start a fresh run with the same inputs as an existing one. */
async function cmdRerun(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: RELAUNCH_OPTIONS });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw rerun: missing <run_id>\n");
    return 2;
  }
  const start = resolveStartMode("rerun", values);
  const permissions = parsePermissions("rerun", values.permissions);
  const sandbox = parseSandbox("rerun", values.sandbox, values["sandbox-image"]);
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  return relaunch("rerun", store, runId, { ...values, permissions, sandbox }, start);
}

/**
 * `odw resume <run_id>` — continue a run, the way its state allows:
 *
 *   - live and paused (or asked to pause): release it in place, as `odw
 *     pause|resume|stop` always did;
 *   - ended (done, failed, stopped — or stale: its worker is gone): start a
 *     NEW run with the same script, args and adapter whose unchanged agent()
 *     calls replay the old run's saved results, so only the rest runs;
 *   - live and not paused: refuse, since a replaying resume would redo the
 *     work it still has in flight. `--force` starts one anyway (the original
 *     keeps running).
 */
async function cmdResume(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ...RELAUNCH_OPTIONS, force: { type: "boolean" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("odw resume: missing <run_id>\n");
    return 2;
  }
  const start = resolveStartMode("resume", values);
  const permissions = parsePermissions("resume", values.permissions);
  const sandbox = parseSandbox("resume", values.sandbox, values["sandbox-image"]);
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  // A pulled run (ODW extension) goes on where it runs: resume it there, not as a copy here.
  const pulled = pulledRunRefusal(store.readMeta(runId), runId, "resume");
  if (pulled) {
    process.stderr.write(`odw resume: ${pulled}\n`);
    return 1;
  }
  if (!values.force && isRunActive(store, runId)) {
    const state = String(store.readStatus(runId).state ?? "pending");
    const control = store.readControl(runId);
    if (state === "paused" || control === "pause") {
      const given = values as Record<string, unknown>;
      const newRunFlag = ["adapter", "permissions", "untrusted", "sandbox", "wait", "fg", "detach", "timeout"].find((f) => given[f] !== undefined);
      if (newRunFlag) {
        throw new UsageError(
          `odw resume: run ${runId} is paused, so resume continues it in place — ` +
            `--${newRunFlag} applies only when resume starts a new run`,
        );
      }
      store.writeControl(runId, "resume", cliActor());
      // A pause for a spent quota (ODW extension: quotaWait) ends at once: its agents retry now.
      const pausedFor = pausedForOf(store.readStatus(runId).pausedFor);
      const quota = pausedFor ? ` — it was ${sanitizeText(pausedText(pausedFor), 120)}; its agents go on now` : "";
      process.stderr.write(`resume requested for ${runId}${quota}\n`);
      return 0;
    }
    // A run waiting at a checkpoint() goes on once someone answers it, not by resume.
    const waiting = store.readStatus(runId).waiting as { checkpointId?: unknown } | null | undefined;
    const answer =
      waiting && isCheckpointId(waiting.checkpointId)
        ? `  It waits for a decision at checkpoint #${waiting.checkpointId}: odw approve|reject ${runId} (see odw status ${runId}).\n`
        : "";
    process.stderr.write(
      `odw resume: run ${runId} is still ${control === "stop" ? "stopping" : state} — only a paused run continues in place.\n` +
        answer +
        `  To replay its finished agents in a new run, let it end first (odw stop ${runId}), or pass --force.\n`,
    );
    return 1;
  }
  return relaunch("resume", store, runId, { ...values, permissions, sandbox }, start);
}

/**
 * Start a new run from an existing run's recorded inputs — script, args,
 * source, config, budget, run-level adapter and permission tier (`--adapter`
 * and `--permissions` override the last two) — and present it per the
 * resolved mode. `rerun` starts over; `resume` also records the source run,
 * whose saved agent results the new run's worker replays for every agent()
 * call that is unchanged.
 */
async function relaunch(
  cmd: "rerun" | "resume",
  store: RunStore,
  runId: string,
  flags: { "runs-root"?: string; adapter?: string; permissions: PermissionTier | null; untrusted?: boolean; sandbox: SandboxFlag | null },
  start: { mode: RunMode; timeoutMs: number | undefined },
): Promise<number> {
  const meta = store.readMeta(runId);
  const script = meta.script as string | undefined;
  if (!script) {
    process.stderr.write(`run ${runId} has no script to ${cmd}\n`);
    return 1;
  }
  const opts = {
    args: meta.args,
    configPath: (meta.configPath as string | null) ?? null,
    runsRoot: flags["runs-root"] ?? null,
    source: (meta.source as string | undefined) ?? null,
    adapter: flags.adapter ?? (meta.adapter as string | null) ?? null,
    permissions: flags.permissions ?? (isPermissionTier(meta.permissions) ? meta.permissions : null),
    // An untrusted run's rerun or resume is untrusted too (ODW extension): nothing loosens it.
    trust: (flags.untrusted === true || meta.trust === "untrusted" ? "untrusted" : null) as TrustLevel | null,
    // A sandboxed run's rerun or resume is sandboxed too (ODW extension); --sandbox-image may change its image.
    sandbox: flags.sandbox ?? sandboxFlagOf(meta.sandbox),
    budgetTotal: (meta.budgetTotal as number | null) ?? null,
    // The worker reads the saved results from the source run's own directory.
    resumedFrom: cmd === "resume" ? { runId, dir: store.runDir(runId) } : null,
  };
  warnIfNoDefaultAdapter(opts.adapter, opts.configPath, opts.source, cmd);
  // An inline-launched run's script lives inside the OLD run dir. Re-archive its
  // source into the NEW run (via startRunFromSource) rather than pointing the new
  // run back at the old directory — so it stays self-contained and is correctly
  // flagged inline (no spurious run-by-name divergence note).
  //
  // Observe the NEW run through the store the launcher actually created it in
  // (the old run's configPath may point runsRoot somewhere the CLI-flag store
  // does not) — never through the store the OLD run was located with.
  let started: { runId: string; store: RunStore; workflow?: ResolvedWorkflow };
  if (meta.inline === true) {
    let sourceCode: string;
    try {
      sourceCode = readFileSync(script, "utf8");
    } catch {
      process.stderr.write(`run ${runId}: its archived script is gone, cannot ${cmd}\n`);
      return 1;
    }
    started = startRunFromSource(sourceCode, {
      ...opts,
      allowInvalid: true,
      origin: (meta.origin as string | null) ?? null,
      // A replay's rerun replays the same agent, at the same base commit (ODW extension).
      ...(meta.origin === "replay" && meta.replayOf !== null && typeof meta.replayOf === "object" ? { replayOf: meta.replayOf as ReplayLink } : {}),
      // …with the same call, kept out of meta.json (call.json).
      ...(meta.origin === "replay" ? { call: store.readRunCall(runId) } : {}),
    });
  } else {
    started = startRun(script, opts);
  }
  const saved = cmd === "resume" ? store.listAgentResults(runId).length : 0;
  return afterStart(started.store, started.runId, start.mode, {
    timeoutMs: start.timeoutMs,
    hint: cmd === "resume" ? `resuming ${runId} (${saved} saved agent result(s) to replay) as` : `re-running ${runId} as`,
    banner: withWorkflowLines(startBanner(opts.configPath, opts.source, opts.permissions, opts.trust, opts.sandbox), started.workflow),
  });
}

/**
 * `odw serve` — the live dashboard. ODW extensions:
 *   FILE.odwrun     show that shared bundle alone, read-only (`odw view FILE` too):
 *                   unpacked into a private temp dir, removed on exit
 *   --token [VALUE] every API read needs the token (remote read-only access); with
 *                   no VALUE a random one, printed once in the URL (`/#token=…`)
 *   --token-scope read|approve   approve: the token also answers checkpoints off loopback
 *   --tokens FILE   named tokens (runtime/serve-tokens.ts), each with its scope: attribution by name
 *   --public-url URL              answer signed one-time approve links (runtime/approve-links.ts)
 *   --rotate-approve-secret       replace the runs root's approve-link secret first
 */
async function cmdServe(rest: string[], as: "serve" | "view" = "serve"): Promise<number> {
  const { args, token: tokenFlag } = takeTokenFlag(rest);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      open: { type: "boolean" },
      "max-bytes": { type: "string" },
      "public-url": { type: "string" },
      "token-scope": { type: "string" },
      tokens: { type: "string" },
      "rotate-approve-secret": { type: "boolean" },
    },
  });
  if (positionals.length > 1) throw new UsageError("odw serve: at most one bundle file (FILE.odwrun)");
  // Approve links and the approve scope (ODW extensions): checkpoint decisions are the only remote writes.
  const scope = values["token-scope"] ?? "read";
  if (scope !== "read" && scope !== "approve") throw new UsageError("odw serve: --token-scope is read or approve");
  if (scope === "approve" && tokenFlag === undefined) throw new UsageError("odw serve: --token-scope approve goes with --token");
  const publicUrl = values["public-url"] === undefined ? null : parsePublicUrl(values["public-url"]);
  if (values["public-url"] !== undefined && !publicUrl) {
    if (publicUrlHasPath(values["public-url"])) {
      throw new UsageError(
        "odw serve: --public-url must be a root URL (https://host[:port]), with no path: links are answered at /approve/ on it, " +
          "so serve odw at the root of its host (a tunnel or a host of its own), not under a path",
      );
    }
    throw new UsageError("odw serve: --public-url must be an http(s) URL with no credentials, path, query, fragment, comma, semicolon or quote");
  }
  if ((publicUrl || values["rotate-approve-secret"]) && positionals[0] !== undefined) {
    throw new UsageError("odw serve: a shared bundle answers no approve links (--public-url, --rotate-approve-secret)");
  }
  const file = positionals[0];
  if (as === "view" && file === undefined) throw new UsageError("usage: odw view FILE.odwrun [--port N] [--host H] [--token [VALUE]]");

  // --port 0: any free port (the URL printed says which).
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`odw serve: invalid --port '${values.port}'\n`);
    return 2;
  }
  let token: string | null = null;
  const generated = tokenFlag === "";
  if (tokenFlag !== undefined) {
    token = generated ? generateToken() : tokenFlag;
    if (!isValidToken(token)) throw new UsageError("odw serve: --token VALUE must be 16-256 characters of A-Z a-z 0-9 . _ ~ - (or omit VALUE for a random one)");
  }
  // Named tokens (ODW extension: --tokens FILE, see runtime/serve-tokens.ts): each its own name and scope.
  let named: NamedToken[] = [];
  const tokensFile = values.tokens === undefined ? null : resolve(expandHome(values.tokens));
  if (tokensFile) {
    try {
      named = readTokens(tokensFile);
    } catch (err) {
      if (!(err instanceof TokenFileError)) throw err;
      process.stderr.write(`odw serve: --tokens: ${err.message}\n`);
      return 1;
    }
    if (named.length === 0 && token === null) {
      process.stderr.write(`odw serve: --tokens: ${tokensFile} has no tokens — add one with odw token add <name> --file ${tokensFile}\n`);
      return 1;
    }
  }
  const maxBytes = maxBytesOption("serve", values["max-bytes"]);
  if (values["max-bytes"] !== undefined && file === undefined) throw new UsageError("odw serve: --max-bytes goes with a bundle file");
  const host = values.host ?? "127.0.0.1";
  const config = loadConfig(values.config ?? null);

  let opened: OpenedBundle | null = null;
  if (file !== undefined) {
    try {
      opened = openBundle(file, maxBytes);
    } catch (err) {
      if (!(err instanceof BundleError)) throw err;
      process.stderr.write(`odw serve: ${err.message}\n`);
      return 1;
    }
  }
  const cleanup = () => opened?.cleanup();
  process.once("exit", cleanup); // however serve ends, the unpacked bundle goes with it
  const store = opened ? new RunStore(opened.root) : storeFrom(values);

  let handle: Awaited<ReturnType<typeof startServer>>;
  try {
    handle = await startServer({
      store,
      port,
      host,
      cwd: process.cwd(),
      config,
      configPath: values.config ? resolve(expandHome(values.config)) : null, // absolute: runs it starts work elsewhere
      token,
      namedTokens: named,
      bundle: opened?.info ?? null,
      publicUrl,
      tokenScope: scope,
      rotateApproveSecret: values["rotate-approve-secret"] === true,
    });
  } catch (err) {
    cleanup();
    throw err;
  }
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const base = loopback ? handle.url : `http://${reachableHost(host)}:${handle.port}`;
  const page = opened ? `#/job/${encodeURIComponent(opened.info.runId)}` : "";
  // The generated token is printed here, once, and nowhere else.
  const url = generated ? `${base}/#token=${token}` : `${base}/${page}`;
  process.stdout.write(`odw dashboard → ${url}\n`);
  if (opened) {
    process.stdout.write(`  shared bundle ${opened.info.file} (run ${opened.info.runId}), read-only\n`);
    process.stdout.write(`  unpacked in ${opened.root} (removed on exit)\n`);
  } else {
    process.stdout.write(`  watching ${store.root}\n`);
  }
  if (token) {
    process.stdout.write(
      generated
        ? "  reads need the token in that URL (or Authorization: Bearer <token>); writes stay loopback-only\n"
        : "  reads need the token given with --token (?token=, a cookie, or Authorization: Bearer); writes stay loopback-only\n",
    );
    if (scope === "approve") process.stdout.write("  --token-scope approve: the token also answers checkpoints (nothing else is writable remotely)\n");
  }
  if (named.length > 0) {
    const approvers = named.filter((t) => t.scope === "approve").map((t) => t.name);
    process.stdout.write(
      `  ${named.length} named token${named.length === 1 ? "" : "s"} from ${tokensFile}: reads need one; what each does is attributed to its name` +
        `${approvers.length ? `\n  approve scope (answers checkpoints, nothing else remotely): ${approvers.join(", ")}` : ""}\n`,
    );
  }
  if (values["rotate-approve-secret"]) process.stdout.write("  approve secret rotated: every approve link sent before no longer works\n");
  if (publicUrl) {
    process.stdout.write(`  approve links → ${publicUrl}/approve/… (signed, one-time; minted into "waiting" notify hooks while this runs)\n`);
    if (publicUrl.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(`${publicUrl}/`)) {
      process.stderr.write("  ⚠ --public-url is plain http: an approve link can be read and used by anyone on the path. Use https (a tunnel).\n");
    }
  }
  // Signed triggers (ODW extension): where each is answered, and one whose secret is missing.
  for (const line of opened ? [] : triggerLines(handle.triggers, publicUrl ?? base)) process.stdout.write(`${line}\n`);
  for (const line of handle.triggerWarnings) process.stderr.write(`  ${line}\n`);
  if (loopback && !publicUrl && Object.keys(handle.triggers).length > 0) {
    process.stdout.write("  triggers on a loopback bind answer loopback Hosts only: give a tunnel's URL as --public-url to take its webhooks\n");
  }
  if (!loopback && !token && named.length === 0) {
    process.stderr.write(
      `\n  ⚠ WARNING: bound to ${host} with no --token — anyone who can reach this port reads every project's runs\n` +
        `    (prompts, results). Writes are refused off-loopback, but reads are open. Require a token:\n` +
        `      odw serve --host ${host} --token\n\n`,
    );
  }
  process.stdout.write("  press Ctrl-C to stop\n");
  if (values.open) openBrowser(generated ? url : `${handle.url}/${page}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.stdout.write("\nshutting down…\n");
      handle.close().then(() => {
        cleanup();
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return 0;
}

/**
 * `--token [VALUE]` out of serve's arguments: parseArgs has no optional
 * values. The token is the next argument unless that is a flag or a bundle
 * file; `--token=VALUE` works too. Undefined without `--token`, "" for one
 * with no VALUE (a random token).
 */
function takeTokenFlag(rest: string[]): { args: string[]; token: string | undefined } {
  const args: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") {
      args.push(...rest.slice(i));
      break;
    }
    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      if (token === "") throw new UsageError("odw serve: --token= needs a VALUE (or plain --token for a random one)");
      continue;
    }
    if (arg !== "--token") {
      args.push(arg);
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("-") && !next.endsWith(BUNDLE_EXT)) {
      token = next;
      i++;
    } else {
      token = "";
    }
  }
  return { args, token };
}

/** `--max-bytes N`: a positive integer, else the default cap. */
function maxBytesOption(cmd: string, value: string | undefined): number {
  if (value === undefined) return DEFAULT_BUNDLE_MAX_BYTES;
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < 1) throw new UsageError(`odw ${cmd}: --max-bytes must be a positive integer (bytes)`);
  return n;
}

/** The host to print for a bind: a wildcard bind's first external IPv4 address (what a phone reaches), else the bind. */
function reachableHost(host: string): string {
  if (host !== "0.0.0.0" && host !== "::") return host.includes(":") ? `[${host}]` : host;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "localhost";
}

/**
 * `odw bundle <run_id>` (ODW extension; see runtime/bundle.ts): the run as one
 * redacted, self-contained file to share — `<run_id>.odwrun` here, or `--out
 * FILE` (`-`: stdout). `--no-transcripts` leaves the agents' transcripts out;
 * past 32 MiB it is refused unless `--max-bytes` raises the cap. Exit 0, 1 when
 * the run is unknown or the bundle too big, 2 on a usage error.
 */
function cmdBundle(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      out: { type: "string" },
      "no-transcripts": { type: "boolean" },
      "max-bytes": { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId || positionals.length > 1) throw new UsageError("usage: odw bundle <run_id> [--out FILE] [--no-transcripts] [--max-bytes N]");
  if (runId.startsWith("cc-")) throw new UsageError(`odw bundle: ${runId} is a Claude Code run: odw bundles its own runs`);
  if (!isBundleRunId(runId)) throw new UsageError(`odw bundle: not a run id: ${runId}`);
  const maxBytes = maxBytesOption("bundle", values["max-bytes"]);
  const config = loadConfig(values.config ?? null, { quiet: true });
  const store = values["runs-root"] ? new RunStore(values["runs-root"]) : new RunStore(resolveRunsRoot(config.settings.runsRoot));
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const state = String(store.readStatus(runId).state ?? "pending");
  if (!TERMINAL_STATES.has(state)) process.stderr.write(`odw bundle: run ${runId} is ${state}: the bundle holds what happened so far\n`);
  let made: ReturnType<typeof createBundle>;
  try {
    made = createBundle(store, runId, bundleRedactor(config), { transcripts: !values["no-transcripts"], maxBytes });
  } catch (err) {
    if (!(err instanceof BundleError)) throw err;
    process.stderr.write(`odw bundle: ${err.message}\n`);
    return 1;
  }
  const out = values.out ?? `${runId}${BUNDLE_EXT}`;
  const bytes = Buffer.byteLength(made.json);
  if (out === "-") process.stdout.write(made.json);
  else writeFileSync(out, made.json, { mode: 0o600 });
  const what = [
    `${bytes} bytes`,
    made.bundle.redacted ? "likely secrets redacted" : "nothing to redact found",
    made.bundle.transcripts ? "with transcripts" : "without transcripts",
  ].join(", ");
  process.stderr.write(`${out === "-" ? "wrote" : `wrote ${out}:`} run ${runId} (${what})\n`);
  if (out !== "-") process.stderr.write(`  look before you share: odw view ${out}${bytes > DEFAULT_BUNDLE_MAX_BYTES ? ` --max-bytes ${bytes}` : ""}\n`);
  return 0;
}

/** Best-effort: open `url` in the platform default browser; failures are silent. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const opener = spawn(cmd as string, args as string[], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    opener.on("error", () => {}); // no opener installed (ENOENT arrives as an event, not a throw)
    opener.unref();
  } catch {
    /* no browser opener available — the URL is already printed */
  }
}

function cmdControl(action: Command, rest: string[]): number {
  const { store, runId } = storeAndRun(rest);
  if (!store) return runId ? 1 : 2;
  const pulled = pulledRunRefusal(store.readMeta(runId), runId, action);
  if (pulled) {
    process.stderr.write(`odw ${action}: ${pulled}\n`);
    return 1;
  }
  store.writeControl(runId, action, cliActor());
  process.stderr.write(`${action} requested for ${runId}\n`);
  return 0;
}

/**
 * `odw approve|reject <run_id> [--note TEXT] [--checkpoint N]` — answer a
 * checkpoint() the run waits at (ODW extension): checkpoint N, else the
 * oldest one waiting. The answer always names the checkpoint the person saw,
 * so it can never land on a question asked after they decided; the run picks
 * it up from its decision log within a fraction of a second.
 *
 * `odw approve` may carry an edited payload: `--payload JSON|@file`, or
 * `--edit`, which opens $VISUAL / $EDITOR on the checkpoint's payload first
 * (see runtime/checkpoint-edit.ts). Either is checked as the run will check
 * it — JSON, at most 256 KiB, the checkpoint's schema — before it is written.
 */
async function cmdDecide(action: "approve" | "reject", rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      note: { type: "string" },
      checkpoint: { type: "string" },
      payload: { type: "string" },
      edit: { type: "boolean" },
    },
  });
  const runId = positionals[0];
  if (!runId) throw new UsageError(`odw ${action}: missing <run_id>`);
  let checkpointId: number | undefined;
  if (values.checkpoint !== undefined) {
    checkpointId = /^\d+$/.test(values.checkpoint) ? Number(values.checkpoint) : NaN;
    if (!isCheckpointId(checkpointId)) {
      throw new UsageError(`odw ${action}: --checkpoint must be a checkpoint number (1, 2, …)`);
    }
  }
  const note = values.note;
  if (note !== undefined && note.length > CHECKPOINT_NOTE_MAX) {
    throw new UsageError(`odw ${action}: --note must be at most ${CHECKPOINT_NOTE_MAX} characters`);
  }
  if ((values.payload !== undefined || values.edit) && action === "reject") {
    throw new UsageError("odw reject: --payload and --edit go with odw approve only — a rejection keeps the checkpoint's payload");
  }
  if (values.payload !== undefined && values.edit) {
    throw new UsageError("odw approve: --payload and --edit are mutually exclusive");
  }
  let edit: { value: unknown } | undefined;
  if (values.payload !== undefined) {
    const read = readPayloadOption(values.payload);
    if ("error" in read) throw new UsageError(`odw approve: --payload: ${read.error}`);
    const sized = checkEdit(read.value, null);
    if (!sized.ok) throw new UsageError(`odw approve: --payload: ${sized.message}`);
    edit = { value: sized.value };
  }
  if (values.edit && !(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
    throw new UsageError(
      "odw approve: --edit opens an editor, which needs a terminal (stdin and stdout are not one) — " +
        "pass the edited payload with --payload '<json>' or --payload @file.json",
    );
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const pulled = pulledRunRefusal(store.readMeta(runId), runId, action);
  if (pulled) {
    process.stderr.write(`odw ${action}: ${pulled}\n`);
    return 1;
  }
  const run = detail(store, runId);
  const pending = run.pendingCheckpoints ?? [];
  const target = checkpointId === undefined ? pending[0] : pending.find((cp) => cp.checkpointId === checkpointId);
  if (!target) {
    const open = pending.map((cp) => `#${cp.checkpointId} ${JSON.stringify(sanitizeText(cp.title, 80))}`).join(", ");
    process.stderr.write(
      pending.length === 0
        ? `run ${runId} has no checkpoint waiting for a decision (it is ${run.state})\n`
        : `checkpoint #${checkpointId} of run ${runId} is not waiting for a decision; waiting: ${open}\n`,
    );
    return 1;
  }
  const which = `checkpoint #${target.checkpointId}`;
  if (edit) {
    const checked = checkEdit(edit.value, target.schema ?? null);
    if (!checked.ok) {
      process.stderr.write(`odw approve: ${editRefusal(which, checked.message, checked.problems)}`);
      return 1;
    }
  }
  // An --edit file stays until its edit is written; it is kept, and named, when it cannot be.
  let keep: { file: string; discard(): void } | undefined;
  if (values.edit) {
    const blocked = editBlocker(target);
    if (blocked) {
      process.stderr.write(`odw approve: cannot --edit ${which}: ${blocked} — pass the edited payload with --payload @file.json\n`);
      return 1;
    }
    const outcome = await editPayload(target.payload, {
      editor: editorCommand(),
      check: (value) => checkEdit(value, target.schema ?? null),
    });
    const kept = (file: string | null | undefined): string => (file ? `  your edit is kept in ${file}\n` : "");
    switch (outcome.kind) {
      case "empty":
        process.stderr.write(`odw approve: the payload file was empty — not answering; ${which} still waits\n`);
        return 1;
      case "editor-failed":
        process.stderr.write(`odw approve: ${outcome.message} — not answering; ${which} still waits\n${kept(outcome.file)}`);
        return 1;
      case "refused":
        process.stderr.write(`odw approve: ${editRefusal(which, outcome.message, outcome.problems)}${kept(outcome.file)}`);
        return 1;
      case "unchanged":
        process.stderr.write(`payload unchanged — approving ${which} as is\n`);
        break;
      case "edited":
        edit = { value: outcome.value };
        keep = outcome;
        break;
    }
    // Time passed in the editor: the checkpoint may have been answered meanwhile, or the run ended.
    if (!(detail(store, runId).pendingCheckpoints ?? []).some((cp) => cp.checkpointId === target.checkpointId)) {
      process.stderr.write(`odw approve: ${which} of run ${runId} is no longer waiting for a decision\n${kept(keep?.file)}`);
      return 1;
    }
  }
  store.requestCheckpointDecision(runId, {
    action,
    checkpointId: target.checkpointId,
    ...(note !== undefined && note.trim() !== "" ? { note } : {}),
    ...(edit ? { payload: edit.value } : {}),
    by: "cli",
    who: cliActor(),
  });
  keep?.discard();
  process.stderr.write(
    `${action} requested for checkpoint #${target.checkpointId} ${JSON.stringify(sanitizeText(target.title, 120))} of ${runId}` +
      `${edit ? ", with an edited payload" : ""}\n`,
  );
  return 0;
}

/** Why an edited payload was refused: the message, or the schema's problems one per line. */
function editRefusal(which: string, message: string, problems: string[]): string {
  if (problems.length <= 1) return `${message} — not answering; ${which} still waits\n`;
  const shown = problems.slice(0, 20).map((p) => `  ${sanitizeText(p, 200)}\n`).join("");
  const more = problems.length > 20 ? `  … and ${problems.length - 20} more\n` : "";
  return `the edited payload does not match ${which}'s schema — not answering; it still waits:\n${shown}${more}`;
}

/**
 * `odw export <run_id> --otlp [--out <file> | --send]` (ODW extension) — the
 * run as OpenTelemetry traces in OTLP/JSON (see runtime/otel-export): on
 * stdout, into a file, or POSTed to the configured endpoint. Content is
 * captured only when `otel.captureContent` or
 * OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT asks. A run still going
 * is exported as it stands. Exit 0, or 1 when the run is unknown or the send failed.
 */
async function cmdExport(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      otlp: { type: "boolean" },
      out: { type: "string" },
      send: { type: "boolean" },
    },
  });
  const runId = positionals[0];
  if (!runId) throw new UsageError("odw export: missing <run_id>");
  if (!values.otlp) throw new UsageError("odw export: name the format: --otlp (OpenTelemetry traces, OTLP/JSON)");
  if (values.send && values.out !== undefined) throw new UsageError("odw export: --out and --send exclude each other");
  const config = loadConfig(values.config ?? null, { quiet: true });
  const store = values["runs-root"] ? new RunStore(values["runs-root"]) : new RunStore(resolveRunsRoot(config.settings.runsRoot));
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const state = String(store.readStatus(runId).state ?? "pending");
  if (!TERMINAL_STATES.has(state)) {
    process.stderr.write(`odw export: run ${runId} is ${state}: its trace holds what happened so far, open spans ending at its last event\n`);
  }
  const trace = exportRun(store, runId, config);
  const spans = spanCount(trace);
  if (values.send) {
    const target = otlpTarget(config.settings.otel, process.env);
    const failure = await postTrace(target, trace, exportTimeout(process.env, OTEL_SEND_TIMEOUT_MS));
    if (failure) {
      process.stderr.write(`odw export: ${failure}\n`);
      return 1;
    }
    process.stderr.write(`sent the trace of run ${runId} (${spans} spans) to ${target.origin}\n`);
    return 0;
  }
  const json = JSON.stringify(trace) + "\n";
  if (values.out !== undefined) {
    writeFileSync(values.out, json);
    process.stderr.write(`wrote the trace of run ${runId} (${spans} spans) to ${values.out}\n`);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

/** `odw workflows <list|where>` — inspect the workflows runnable by name. */
function cmdWorkflows(rest: string[]): number {
  const [sub, ...subRest] = rest;
  if (sub === "list") return cmdWorkflowsList(subRest);
  if (sub === "where") return cmdWorkflowsWhere(subRest);
  process.stderr.write(`odw workflows: expected 'list' or 'where', got '${sub ?? ""}'\n`);
  return 2;
}

function cmdWorkflowsList(rest: string[]): number {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      project: { type: "boolean" },
      global: { type: "boolean" },
      plugins: { type: "boolean" },
      all: { type: "boolean" },
    },
  });
  if ([values.project, values.global, values.plugins].filter(Boolean).length > 1) {
    process.stderr.write("odw workflows list: --project, --global and --plugins are mutually exclusive\n");
    return 2;
  }
  const config = loadConfig(values.config ?? null);
  let entries = listWorkflows(process.cwd(), config);
  const scoped = Boolean(values.project || values.global || values.plugins);
  if (values.project) entries = entries.filter((e) => e.origin === "project");
  if (values.global) entries = entries.filter((e) => e.origin === "global");
  // Workflows installed Claude Code plugins ship, as <plugin>:<name> (ODW extension).
  if (values.plugins) entries = entries.filter((e) => e.origin === "plugin");
  // The default (unscoped) view shows only the effective set; an explicit scope
  // or --all shows every entry, with shadowed ones still flagged.
  if (!values.all && !scoped) entries = entries.filter((e) => !e.shadowed);

  if (entries.length === 0) {
    process.stderr.write("no named workflows found\n");
    process.stderr.write(
      "  add one by dropping a .js file in ./.odw/workflows, ./.claude/workflows, ~/.odw/workflows, or ~/.claude/workflows\n" +
        "  (or install a Claude Code plugin that ships workflows: odw run <plugin>:<name>)\n",
    );
    return 0;
  }
  const width = Math.max(...entries.map((e) => e.name.length));
  for (const e of entries) {
    const scope = e.origin === "plugin" ? e.provider : `${e.provider}:${e.origin}`;
    const shadow = e.shadowed ? "  shadowed by higher-precedence workflow" : "";
    const note = e.note ? `  note: ${e.note}` : "";
    process.stdout.write(`${e.name.padEnd(width)}  (${scope.padEnd(14)} ${e.rootLabel})  ${e.path}${shadow}${note}\n`);
  }
  return 0;
}

function cmdWorkflowsWhere(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" } },
  });
  const name = positionals[0];
  if (!name) {
    process.stderr.write("odw workflows where: missing <name>\n");
    return 2;
  }
  const config = loadConfig(values.config ?? null);
  try {
    const { scriptPath, origin, provider, rootLabel } = resolveWorkflow(name, { cwd: process.cwd(), config });
    const scope = origin === "plugin" ? provider : provider ? `${provider}:${origin}` : origin;
    const source = `${scope}${provider && rootLabel ? ` ${rootLabel}` : ""}`;
    process.stdout.write(`${scriptPath}  (${source})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

// --- helpers -----------------------------------------------------------------

interface StoreFlags {
  config?: string;
  "runs-root"?: string;
}

function storeFrom(values: StoreFlags): RunStore {
  if (values["runs-root"]) return new RunStore(values["runs-root"]);
  return new RunStore(resolveRunsRoot(loadConfig(values.config ?? null).settings.runsRoot));
}

/** Parse `<run_id>` + store flags; returns null store with a printed error on failure. */
function storeAndRun(rest: string[]): { store: RunStore | null; runId: string } {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) {
    process.stderr.write("missing <run_id>\n");
    return { store: null, runId: "" };
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return { store: null, runId };
  }
  return { store, runId };
}

/**
 * What a printed `odw …` command needs to find a run in `store` from here:
 * `--runs-root` unless the store is the one a bare command resolves to.
 */
function storeFlagsFor(store: RunStore): string[] {
  try {
    if (resolve(resolveRunsRoot(loadConfig(null, { quiet: true }).settings.runsRoot)) === resolve(store.root)) {
      return [];
    }
  } catch {
    // An unreadable default config: name the runs root outright.
  }
  return ["--runs-root", resolve(store.root)];
}

function reportTerminal(store: RunStore, runId: string, status: Record<string, unknown>): number {
  const state = status.state;
  if (state === "done") {
    process.stdout.write(JSON.stringify(store.readResult(runId), null, 2) + "\n");
    return 0;
  }
  if (state === "failed") {
    const error = store.readError(runId) ?? {};
    process.stderr.write(`run failed: ${status.error ?? error.error ?? "unknown error"}\n`);
    return 1;
  }
  // Stopped by its --deadline (ODW extension): what it finished, and exit 3.
  if (stoppedByDeadline(status)) {
    const report = deadlineReport(store, runId);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.stderr.write(`run was stopped at its deadline (--deadline ${String(report.deadline)}); finished agents kept: ${(report.finished as unknown[]).length}\n`);
    return DEADLINE_EXIT_CODE;
  }
  if (state === "stopped") {
    process.stderr.write("run was stopped before completion\n");
    return 1;
  }
  process.stderr.write(`run is still '${String(state)}'; not finished\n`);
  return 1;
}

export function parseArgsValue(raw?: string): unknown {
  if (raw === undefined) return null;
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    // Input that *looks* like JSON but doesn't parse is almost always a typo'd
    // object, and silently passing it through as a string corrupts the run
    // (`args.foo` becomes undefined in every agent prompt). Fail loudly instead.
    const head = text.trimStart()[0];
    if (head === "{" || head === "[") {
      throw new Error(
        `--args looks like JSON but failed to parse: ${(err as Error).message}\n` +
          `  fix the JSON, or pass input that does not start with '{' or '[' to send a plain string`,
      );
    }
    return text; // a plain string that isn't JSON, e.g. --args hello
  }
}

function baseName(path: string | undefined): string {
  return path ? basename(path) : "";
}

export function isCliEntrypoint(argvEntry: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Run when invoked directly (`node dist/cli.js …`) or as the compiled SEA binary
// (where there is no script path on argv to match against this module).
if (isCliEntrypoint(process.argv[1]) || isSeaBinary()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
