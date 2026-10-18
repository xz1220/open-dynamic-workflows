/**
 * `odw eval` — run a workflow over a set of cases, on one or more adapters,
 * several times each, and report pass rate, cost and latency (an ODW
 * extension; the eval file is ./definition, the report ./report).
 *
 *   odw eval <file|name> [--adapter a,b] [--repeats N] [--json] [--out report.json]
 *                        [--baseline report.json] [--config P] [--runs-root DIR]
 *
 * `<name>` is `.odw/evals/<name>.json` in this directory; anything ending in
 * .json or holding a path separator is a file. Every case × adapter × repeat
 * is a real odw run in the run store — started like `odw run`, from this
 * directory, with `--adapter` set to the cell's adapter (none for the
 * config's default), the eval's `budget` as `--budget` — and marked
 * `origin: "eval"` with `eval: { name, case, adapter, repeat }` in its
 * meta.json. At most `concurrency` run at once, in adapter, case, repeat
 * order. A run past the eval's `timeout` is stopped, and fails.
 *
 * Progress goes to stderr, a line per finished run; then the table (or, with
 * --json, the report) to stdout. The report is kept under
 * `<runsRoot>/_evals/<name>/<id>.json` — and written to --out. Exit 0 when
 * every run passed, or — with --baseline — when no cell's pass rate fell
 * below the baseline's; 1 otherwise; 2 for a usage error (a bad flag, eval
 * file, adapter, workflow or baseline: nothing ran).
 *
 * Ctrl-C (or SIGTERM, SIGHUP) stops every run the eval started — a stop
 * request each, as `odw stop` writes — waits up to 30 seconds for them to
 * end (a second Ctrl-C does not wait), keeps no report, and ends odw by that
 * signal.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, resolveAdapter, resolveRunsRoot } from "../adapters/config.js";
import { isCheckpointId } from "../control.js";
import { AdapterNotFound, ConfigError, DynamicWorkflowError } from "../errors.js";
import { RUN_FAILED, RUN_FINISHED, RUN_STARTED, RUN_STOPPED, type WorkflowEvent } from "../events.js";
import { loadWorkflowScript } from "../loader.js";
import { cliVersionsOf, sourceHash } from "../provenance.js";
import { startRun } from "../runtime/launcher.js";
import { RunObserver } from "../runtime/run-liveness.js";
import { RunStore } from "../runtime/run-store.js";
import { readFacts, summaryFrom } from "../runtime/runs-view.js";
import { detectCaps, fmtDuration, fmtUsd, glyphs, palette, sanitizeText } from "../tty.js";
import { VERSION } from "../version.generated.js";
import { resolveWorkflow } from "../workflows/resolve.js";
import {
  evalHash,
  isEvalName,
  loadEvalFile,
  MAX_REPEATS,
  parseAdapterList,
  type EvalCase,
  type EvalDefinition,
} from "./definition.js";
import { judgeRun, type RunOutcome } from "./judge.js";
import {
  cellsOf,
  cliVersionsOfRuns,
  compareToBaseline,
  formatReport,
  readReportFile,
  REPORT_VERSION,
  saveReport,
  totalsOf,
  type EvalReport,
  type EvalRunRecord,
} from "./report.js";

/** A command-line mistake, or an eval that cannot start: printed as is, exit 2. */
class EvalUsage extends Error {}

/** How long stopped runs get to end before odw stops waiting for them. */
const STOP_GRACE_MS = 30_000;
const POLL_MS = 150;

/** `odw eval …`; returns the exit code. */
export async function cmdEval(rest: string[]): Promise<number> {
  try {
    return await evalCommand(rest);
  } catch (err) {
    if (err instanceof EvalUsage) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    // A bad eval file, adapter, config or workflow: nothing ran yet.
    if (err instanceof DynamicWorkflowError) {
      process.stderr.write(`odw eval: ${err.message}\n`);
      return 2;
    }
    throw err; // parseArgs usage errors and the unexpected: cli.ts reports them
  }
}

/** One run to make: a case, on an adapter, the n-th time. */
interface Job {
  case: EvalCase;
  /** The cell's adapter, as the report names it. */
  label: string;
  /** What the run gets as --adapter: null for the config's default. */
  adapter: string | null;
  repeat: number;
}

async function evalCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      adapter: { type: "string", multiple: true },
      repeats: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      baseline: { type: "string" },
    },
  });
  const [ref, extra] = positionals;
  if (!ref || extra !== undefined) {
    throw new EvalUsage(
      "usage: odw eval <file|name> [--adapter a,b] [--repeats N] [--json] [--out report.json] [--baseline report.json]",
    );
  }
  const cwd = process.cwd();
  const file = evalFileOf(ref, cwd);
  const loaded = loadEvalFile(file);
  const def = applyFlags(loaded, values.adapter, values.repeats);

  const configPath = values.config ?? null;
  const config = loadConfig(configPath, { quiet: true, cwd });
  for (const name of def.adapters ?? []) resolveAdapter(config, name); // AdapterNotFound: exit 2
  let defaultLabel = "default";
  if (def.adapters === null) {
    try {
      defaultLabel = resolveAdapter(config).name;
    } catch (err) {
      if (!(err instanceof AdapterNotFound)) throw err;
      process.stderr.write(`odw eval: warning: bare agent() calls in these runs will fail — ${err.message}\n`);
    }
  }
  const { scriptPath } = resolveWorkflow(def.workflow, { cwd, config });
  let source: string;
  try {
    source = readFileSync(scriptPath, "utf8");
    loadWorkflowScript(source, scriptPath);
  } catch (err) {
    throw new ConfigError(`workflow ${scriptPath} does not load: ${(err as Error).message}`);
  }
  const baseline = values.baseline !== undefined ? readReportFile(values.baseline) : null;
  const runsRoot = resolve(values["runs-root"] ?? resolveRunsRoot(config.settings.runsRoot));
  const store = new RunStore(runsRoot);

  const labels = def.adapters ?? [defaultLabel];
  const jobs: Job[] = [];
  for (const label of labels) {
    for (const c of def.cases) {
      for (let repeat = 1; repeat <= def.repeats; repeat++) jobs.push({ case: c, label, adapter: def.adapters ? label : null, repeat });
    }
  }

  const caps = detectCaps(process.stderr, process.env);
  const p = palette(caps);
  const g = glyphs(caps);
  const say = (line: string): void => {
    process.stderr.write(line + "\n");
  };
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const atOnce = Math.min(def.concurrency, jobs.length);
  say(
    `odw eval ${def.name}: ${plural(def.cases.length, "case")} × ${plural(labels.length, "adapter")} × ${plural(def.repeats, "repeat")}` +
      ` = ${plural(jobs.length, "run")}, ${atOnce} at once · workflow ${sanitizeText(def.workflow, 80)}`,
  );

  // Ctrl-C stops what the eval started; a second one stops waiting for it.
  const interrupt = new AbortController();
  const giveUp = new AbortController();
  const live = new Set<string>();
  let caught: NodeJS.Signals | null = null;
  let fatal: string | null = null;
  const stopAll = (): void => {
    interrupt.abort();
    for (const runId of live) store.writeControl(runId, "stop");
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals): void => {
    if (caught) {
      giveUp.abort();
      return;
    }
    caught = signal;
    say(`\nodw eval: ${signal} — stopping ${plural(live.size, "run")} it started (again to stop waiting for them)`);
    stopAll();
  };
  for (const s of signals) process.on(s, onSignal);

  const startedAt = new Date();
  const records: EvalRunRecord[] = [];
  const started: string[] = [];
  let next = 0;
  let finished = 0;
  const width = String(jobs.length).length;

  const runJob = async (job: Job): Promise<void> => {
    const tag = `${sanitizeText(job.case.name, 60)} · ${job.label} · #${job.repeat}`;
    let runId: string;
    try {
      runId = startRun(def.workflow, {
        args: job.case.args,
        configPath,
        runsRoot,
        source: cwd,
        adapter: job.adapter,
        budgetTotal: def.budget,
        origin: "eval",
        eval: { name: def.name, case: job.case.name, adapter: job.label, repeat: job.repeat },
      }).runId;
    } catch (err) {
      fatal ??= `could not start ${tag}: ${(err as Error).message}`;
      stopAll();
      return;
    }
    live.add(runId);
    started.push(runId);
    if (interrupt.signal.aborted) store.writeControl(runId, "stop"); // Ctrl-C while it was being created
    const told = new Set<number>();
    const watched = await watchRun(store, runId, {
      timeoutMs: def.timeout !== null ? def.timeout * 1000 : null,
      interrupt: interrupt.signal,
      giveUp: giveUp.signal,
      onStatus: ({ waiting }) => {
        const cp = waiting as { checkpointId?: unknown; title?: unknown } | null | undefined;
        if (!cp || !isCheckpointId(cp.checkpointId) || told.has(cp.checkpointId)) return;
        told.add(cp.checkpointId);
        say(
          `  ${tag} (${runId}) waits for a decision at checkpoint #${cp.checkpointId}: ${sanitizeText(cp.title, 120)} — ` +
            `odw approve|reject ${runId}`,
        );
      },
    });
    live.delete(runId);
    if (interrupt.signal.aborted) return; // interrupted: no report to judge it for
    const outcome = outcomeOf(store, runId, watched);
    const failures = await judgeRun(job.case.checks, outcome, {
      cwd,
      env: { ODW_EVAL_NAME: def.name, ODW_EVAL_CASE: job.case.name, ODW_EVAL_ADAPTER: job.label, ODW_EVAL_REPEAT: String(job.repeat) },
      signal: interrupt.signal,
    });
    const record: EvalRunRecord = {
      runId,
      case: job.case.name,
      adapter: job.label,
      repeat: job.repeat,
      state: outcome.state,
      passed: failures.length === 0,
      timedOut: outcome.timedOut !== null,
      wallMs: outcome.wallMs,
      inputTokens: watched.usage.inputTokens,
      outputTokens: watched.usage.outputTokens,
      costUsd: outcome.costUsd,
      estimated: watched.usage.estimated,
      cliVersions: watched.cliVersions,
      error: outcome.error,
      failures,
    };
    records.push(record);
    finished++;
    const mark = record.passed ? p.ok(g.ok) : p.err(g.fail);
    const took = record.wallMs === null ? "?" : fmtDuration(record.wallMs);
    const cost = record.costUsd === null ? "" : `  ${fmtUsd(record.costUsd)}`;
    const why = failures[0] ? `  ${p.err(`${sanitizeText(failures[0].check, 60)}: ${sanitizeText(failures[0].message, 120)}`)}` : "";
    say(`[${String(finished).padStart(width)}/${jobs.length}] ${mark} ${tag}  ${took}${cost}  ${p.dim(runId)}${why}`);
  };

  try {
    const lane = async (): Promise<void> => {
      while (!interrupt.signal.aborted && next < jobs.length) await runJob(jobs[next++]!);
    };
    await Promise.all(Array.from({ length: atOnce }, lane));
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }

  if (caught || fatal !== null) {
    const stillGoing = [...live];
    if (fatal !== null) say(`odw eval: ${fatal}`);
    say(
      `odw eval: stopped — ${plural(started.length, "run")} started, no report kept` +
        (stillGoing.length ? `; still stopping: ${stillGoing.join(", ")}` : ""),
    );
    if (caught) {
      process.kill(process.pid, caught); // end by the signal, as an interrupted command does
      return 130;
    }
    return 1;
  }

  const finishedAt = new Date();
  const { name, description, ...definition } = def;
  const hash = evalHash(def);
  const cells = cellsOf(records, def.cases.map((c) => c.name), labels);
  const report: EvalReport = {
    version: REPORT_VERSION,
    name,
    id: reportId(startedAt),
    file,
    description,
    evalHash: hash,
    definition,
    workflow: { ref: def.workflow, script: scriptPath, sourceHash: sourceHash(source) },
    odwVersion: VERSION,
    cliVersions: cliVersionsOfRuns(records),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallMs: finishedAt.getTime() - startedAt.getTime(),
    totals: totalsOf(records),
    cells,
    runs: orderRuns(records, jobs),
    baseline: baseline ? compareToBaseline(cells, hash, baseline, resolve(values.baseline!)) : null,
  };

  const kept = saveReport(runsRoot, report);
  if (values.out !== undefined) writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const out = detectCaps(process.stdout, process.env);
    const columns = process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 120;
    for (const line of formatReport(report, { caps: out, width: columns })) process.stdout.write(line + "\n");
  }
  say(`report: ${kept}${values.out !== undefined ? ` (and ${values.out})` : ""} · two runs side by side: odw compare <runA> <runB>`);
  if (report.baseline) return report.baseline.regressed.length === 0 ? 0 : 1;
  return report.totals.passed === report.totals.runs ? 0 : 1;
}

/** The eval file `ref` names: a path (it ends in .json or has a separator), else `.odw/evals/<ref>.json`. */
function evalFileOf(ref: string, cwd: string): string {
  if (/\.json$/i.test(ref) || /[\\/]/.test(ref)) return resolve(cwd, ref);
  if (!isEvalName(ref)) throw new EvalUsage(`odw eval: '${ref}' is neither an eval file (….json) nor an eval name`);
  const file = join(cwd, ".odw", "evals", `${ref}.json`);
  if (!existsSync(file)) throw new EvalUsage(`odw eval: no eval named '${ref}': ${file} does not exist`);
  return file;
}

/** The definition with `--adapter` (each value split at commas) and `--repeats` in place of the file's. */
function applyFlags(def: EvalDefinition, adapterFlags: string[] | undefined, repeatsFlag: string | undefined): EvalDefinition {
  const out = { ...def };
  if (adapterFlags !== undefined) {
    const names = adapterFlags.flatMap((value) => value.split(",")).map((name) => name.trim());
    out.adapters = parseAdapterList(names, (message) => {
      throw new EvalUsage(`odw eval: --adapter ${message}`);
    });
  }
  if (repeatsFlag !== undefined) {
    const n = Number(repeatsFlag);
    if (!/^\d+$/.test(repeatsFlag.trim()) || !Number.isInteger(n) || n < 1 || n > MAX_REPEATS) {
      throw new EvalUsage(`odw eval: --repeats must be a whole number from 1 to ${MAX_REPEATS}; got '${repeatsFlag}'`);
    }
    out.repeats = n;
  }
  return out;
}

/** What watching a run to its end found. */
interface Watched {
  status: Record<string, unknown>;
  events: WorkflowEvent[];
  /** Seconds of the eval's timeout, when it stopped the run. */
  timedOut: number | null;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null; estimated: boolean };
  cliVersions: Record<string, string | null>;
}

/**
 * Wait for a run to end. Past `timeoutMs` — or once `interrupt` fires — it
 * is asked to stop, and given {@link STOP_GRACE_MS} to (or until `giveUp`).
 */
async function watchRun(
  store: RunStore,
  runId: string,
  opts: {
    timeoutMs: number | null;
    interrupt: AbortSignal;
    giveUp: AbortSignal;
    onStatus: (status: Record<string, unknown>) => void;
  },
): Promise<Watched> {
  const observer = new RunObserver(store, runId);
  const began = Date.now();
  let stopAt: number | null = null;
  let timedOut: number | null = null;
  let status: Record<string, unknown>;
  for (;;) {
    const seen = observer.read();
    if (seen.terminal) {
      status = seen.status;
      break;
    }
    if (seen.error) {
      status = { ...seen.status, state: "failed", error: seen.error };
      break;
    }
    const now = Date.now();
    if (stopAt === null) {
      const late = opts.timeoutMs !== null && now - began >= opts.timeoutMs;
      if (opts.interrupt.aborted || late) {
        if (late && !opts.interrupt.aborted) timedOut = opts.timeoutMs! / 1000;
        store.writeControl(runId, "stop");
        stopAt = now;
      } else {
        opts.onStatus(seen.status);
      }
    } else if (opts.giveUp.aborted || now - stopAt >= STOP_GRACE_MS) {
      status = seen.status;
      break;
    }
    await new Promise<void>((r) => setTimeout(r, POLL_MS));
  }
  const events = store.readEvents(runId);
  const usage = summaryFrom(runId, readFacts(store, runId, events)).usage ?? null;
  const versions = cliVersionsOf(events);
  return {
    status,
    events,
    timedOut,
    usage: {
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd: usage?.costUsd ?? null,
      estimated: usage?.estimated === true,
    },
    cliVersions: Object.fromEntries(Object.entries(versions).map(([adapter, cli]) => [adapter, cli.version])),
  };
}

/** What a watched run came to, as its checks see it. */
function outcomeOf(store: RunStore, runId: string, watched: Watched): RunOutcome {
  const state = String(watched.status.state ?? "pending");
  const error = state === "done" ? null : (str(watched.status.error) ?? str(store.readError(runId)?.error));
  return {
    runId,
    state,
    result: state === "done" ? store.readResult(runId) : null,
    error,
    wallMs: wallMsOf(store, runId, watched),
    costUsd: watched.usage.costUsd,
    timedOut: watched.timedOut,
  };
}

/** Start to end: its run_started event to its end event — else its creation to its last status write. */
function wallMsOf(store: RunStore, runId: string, watched: Watched): number | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const ev of watched.events) {
    if (ev.type === RUN_STARTED && start === null && typeof ev.ts === "number") start = ev.ts;
    if ((ev.type === RUN_FINISHED || ev.type === RUN_FAILED || ev.type === RUN_STOPPED) && typeof ev.ts === "number") end = ev.ts;
  }
  const meta = store.readMeta(runId);
  start ??= typeof meta.createdAt === "number" ? meta.createdAt : null;
  end ??= typeof watched.status.updatedAt === "number" ? watched.status.updatedAt : null;
  return start !== null && end !== null ? Math.max(0, Math.round((end - start) * 1000)) : null;
}

/** The runs in job order (adapter, case, repeat), whatever order they finished in. */
function orderRuns(records: EvalRunRecord[], jobs: Job[]): EvalRunRecord[] {
  const index = (r: EvalRunRecord) => jobs.findIndex((j) => j.label === r.adapter && j.case.name === r.case && j.repeat === r.repeat);
  return [...records].sort((a, b) => index(a) - index(b));
}

/** A report id: its start time, as run ids begin, then 6 hex digits. */
function reportId(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${stamp}-${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, "0")}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
