/**
 * Drift watch (an ODW extension): notice when a CLI or a model changed under
 * a workflow between two of its runs.
 *
 * Retired model names and CLI upgrades break workflows, sometimes silently: a
 * run still "passes" on a model it was never tuned for. So as a run starts,
 * its worker finds the previous finished run of the same workflow — the
 * newest one in its bucket of the runs root that ended (done, failed or
 * stopped), was no dry run, and has the same meta.sourceHash or the same name
 * — and reads what that run recorded: each adapter CLI's version (its
 * `cli_version` events, see ./provenance) and the model each agent label asked
 * for on its adapter (`agent_started`; a `"@tier"` read through that run's
 * own `models` setting). Then, as this run records the same facts, each
 * difference is logged once:
 *
 *   drift: claude CLI 2.1.302 → 2.1.330 since the last run of review-swarm (<runId>)
 *
 * as a `log` event carrying `drift: { kind, adapter, label?, from, to, since }`,
 * which the run's summary folds into its `drift` field (runtime/runs-view).
 * Only what both runs recorded is compared: an adapter or a label one of them
 * never used is no drift, and neither is a CLI whose version is unknown.
 *
 * When the workflow has an eval file (`.odw/evals/<name>.json` in the run's
 * source directory), the first difference also suggests running it against
 * its last kept report — or, with `driftEval: true` in the config, says the
 * eval starts by itself once the run ends: the worker then starts
 * `odw eval <name> --baseline <report>` detached, its output in the run
 * directory's drift-eval.log. A run `odw eval` started never starts another.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { AGENT_STARTED, LOG, RUN_STARTED, event, type WorkflowEvent } from "./events.js";
import { isEvalName } from "./eval/definition.js";
import { evalsDir } from "./eval/report.js";
import { cliVersionsOf, readCliVersion } from "./provenance.js";
import { readdirSafe } from "./runtime/fs-util.js";
import { TERMINAL_STATES, type RunStore } from "./runtime/run-store.js";

/** One thing that changed since the workflow's previous run. */
export interface DriftChange {
  /** An adapter CLI's version (`cli`), or the model an agent label asked for on its adapter (`model`). */
  kind: "cli" | "model";
  adapter: string;
  /** The agent label whose model changed (kind "model"): the first one seen. */
  label?: string;
  /** What the previous run had, and what this one has: a version line, a model id, or null for the CLI's default model. */
  from: string | null;
  to: string | null;
}

/** What a run's summary says of its drift: the run it is compared with, and what changed. */
export interface RunDrift {
  since: string;
  changes: DriftChange[];
}

/** What the previous run recorded, as drift watch compares with it. */
export interface DriftBaseline {
  runId: string;
  /** Each adapter's CLI version line, where it was known. */
  cli: Record<string, string>;
  /** Per agent label, the adapter its first agent started on and the model it asked for (null: the CLI's default). */
  models: Record<string, { adapter: string; model: string | null }>;
}

/** How many of a bucket's newest runs are looked at for the previous one. */
const SCAN_RUNS = 50;

/**
 * The previous finished run of `runId`'s workflow, read from its bucket (see
 * the module comment); null when there is none, or none that recorded a
 * version or an agent. Unreadable runs are skipped, never fatal.
 */
export function previousRun(
  store: RunStore,
  runId: string,
  opts: { workflow: string; sourceHash: string | null },
): DriftBaseline | null {
  let bucket: string;
  let createdAt: number;
  try {
    bucket = dirname(store.runDir(runId));
    createdAt = Number(store.readMeta(runId).createdAt);
  } catch {
    return null;
  }
  // A run id's stamp is to the second, and its suffix random: runs of one
  // second are ordered by their meta.createdAt.
  const stamp = runId.slice(0, 15);
  const earlier: Array<{ id: string; meta: Record<string, unknown> }> = [];
  for (const id of readdirSafe(bucket)
    .filter((entry) => entry.isDirectory() && entry.name !== runId && entry.name.slice(0, 15) <= stamp)
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, SCAN_RUNS)) {
    try {
      if (!existsSync(join(bucket, id, "meta.json"))) continue;
      const meta = store.readMeta(id);
      if (typeof meta.createdAt === "number" && meta.createdAt < createdAt) earlier.push({ id, meta });
    } catch {
      continue;
    }
  }
  earlier.sort((x, y) => (y.meta.createdAt as number) - (x.meta.createdAt as number));
  for (const { id, meta } of earlier) {
    try {
      const status = store.readStatus(id);
      if (!TERMINAL_STATES.has(String(status.state)) || meta.dry === true) continue;
      const name = typeof meta.workflowName === "string" ? meta.workflowName : typeof status.name === "string" ? status.name : null;
      const sameSource = opts.sourceHash !== null && meta.sourceHash === opts.sourceHash;
      if (!sameSource && name !== opts.workflow) continue;
      const baseline = baselineOf(id, store.readEvents(id));
      if (Object.keys(baseline.cli).length > 0 || Object.keys(baseline.models).length > 0) return baseline;
    } catch {
      continue;
    }
  }
  return null;
}

/** What a run's events say it ran with: its CLI versions and each label's requested model. */
export function baselineOf(runId: string, events: readonly WorkflowEvent[]): DriftBaseline {
  const cli: Record<string, string> = {};
  for (const [adapter, found] of Object.entries(cliVersionsOf(events))) if (found.version !== null) cli[adapter] = found.version;
  let tiers: unknown;
  const models: DriftBaseline["models"] = {};
  for (const ev of events) {
    if (ev.type === RUN_STARTED) tiers = (ev.setup as { settings?: { models?: unknown } } | undefined)?.settings?.models;
    const started = startedModel(ev, tiers);
    if (started && !(started.label in models)) models[started.label] = { adapter: started.adapter, model: started.model };
  }
  return { runId, cli, models };
}

/** An agent_started event's label, adapter and requested model (a tier resolved through `tiers`); null for anything else. */
function startedModel(ev: WorkflowEvent, tiers: unknown): { label: string; adapter: string; model: string | null } | null {
  if (ev.type !== AGENT_STARTED || typeof ev.label !== "string" || typeof ev.adapter !== "string") return null;
  // A replayed agent (odw resume) asked no CLI for anything: its event names no model.
  if (ev.cached === true) return null;
  const model = typeof ev.model === "string" ? resolveTier(ev.model, ev.adapter, tiers) : null;
  return { label: ev.label, adapter: ev.adapter, model };
}

/** `"@fast"` as the model id `tiers` gives `adapter`, else as written. */
function resolveTier(model: string, adapter: string, tiers: unknown): string {
  const tier = /^@([\w.-]+)$/.exec(model)?.[1];
  if (tier === undefined || tiers === null || typeof tiers !== "object") return model;
  const ids = Object.prototype.hasOwnProperty.call(tiers, tier) ? (tiers as Record<string, unknown>)[tier] : undefined;
  if (ids === null || typeof ids !== "object") return model;
  const id = Object.prototype.hasOwnProperty.call(ids, adapter) ? (ids as Record<string, unknown>)[adapter] : undefined;
  return typeof id === "string" ? id : model;
}

/** The workflow's eval, as drift watch suggests or starts it. */
export interface DriftEval {
  /** The eval's name: `.odw/evals/<name>.json`. */
  name: string;
  /** Its newest kept report, `<runsRoot>/_evals/<name>/<id>.json`; null when it has none yet. */
  baseline: string | null;
}

/** The workflow's eval file in `source`, and its newest kept report under `runsRoot`; null when it has no eval file. */
export function driftEvalOf(source: string | null, workflow: string, runsRoot: string): DriftEval | null {
  if (!source || !isEvalName(workflow) || !existsSync(join(source, ".odw", "evals", `${workflow}.json`))) return null;
  const dir = join(evalsDir(runsRoot), workflow);
  const ids = readdirSafe(dir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && isEvalName(entry.name.slice(0, -5)))
    .map((entry) => entry.name)
    .sort();
  const newest = ids.at(-1);
  return { name: workflow, baseline: newest ? join(dir, newest) : null };
}

/** The `odw eval` arguments that check the workflow against its last report. */
export function driftEvalArgs(found: DriftEval): string[] {
  return ["eval", found.name, ...(found.baseline ? ["--baseline", found.baseline] : [])];
}

export interface DriftWatchOptions {
  /** The workflow's name, as the log lines say it. */
  workflow: string;
  baseline: DriftBaseline;
  /** This run's `models` setting: what a `"@tier"` resolves to. */
  tiers: unknown;
  /** Where the log lines go: the run's sink. */
  emit: (ev: WorkflowEvent) => void;
  /** The workflow's eval, when it has one. */
  evalOf?: DriftEval | null;
  /** `driftEval: true`: the eval starts once the run ends. */
  autoEval?: boolean;
}

/**
 * Compares a running run with its workflow's previous run (see the module
 * comment): told of every event the run emits, it logs each change once.
 */
export class DriftWatch {
  private readonly changes: DriftChange[] = [];
  private readonly seen = new Set<string>();
  /** Labels whose model this run already compared: a label's first agent stands for it, as in the baseline. */
  private readonly compared = new Set<string>();

  constructor(private readonly opts: DriftWatchOptions) {}

  /** What changed so far, or null while nothing did. */
  get drift(): RunDrift | null {
    return this.changes.length > 0 ? { since: this.opts.baseline.runId, changes: this.changes.map((c) => ({ ...c })) } : null;
  }

  /** The eval to start once the run ends — `driftEval: true`, and something changed — or null. */
  get pendingEval(): DriftEval | null {
    return this.opts.autoEval && this.opts.evalOf && this.changes.length > 0 ? this.opts.evalOf : null;
  }

  observe(ev: WorkflowEvent): void {
    const cli = readCliVersion(ev);
    if (cli) {
      const before = this.opts.baseline.cli[cli.adapter];
      if (before !== undefined && cli.cli.version !== null && cli.cli.version !== before) {
        this.note({ kind: "cli", adapter: cli.adapter, from: before, to: cli.cli.version });
      }
      return;
    }
    const started = startedModel(ev, this.opts.tiers);
    if (!started || this.compared.has(started.label)) return;
    this.compared.add(started.label);
    const before = this.opts.baseline.models[started.label];
    if (before && before.adapter === started.adapter && before.model !== started.model) {
      this.note({ kind: "model", adapter: started.adapter, label: started.label, from: before.model, to: started.model });
    }
  }

  private note(change: DriftChange): void {
    const key = `${change.kind}\0${change.adapter}\0${change.from}\0${change.to}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const first = this.changes.length === 0;
    this.changes.push(change);
    const { workflow, baseline } = this.opts;
    const since = `since the last run of ${workflow} (${baseline.runId})`;
    const message =
      change.kind === "cli"
        ? `drift: ${change.adapter} CLI ${shortVersion(change.from)} → ${shortVersion(change.to)} ${since}`
        : `drift: ${change.label} asks ${change.adapter} for model ${modelName(change.from)} → ${modelName(change.to)} ${since}`;
    this.emit({ message, drift: { ...change, since: baseline.runId } });
    if (first && this.opts.evalOf) this.emit({ message: this.evalLine(this.opts.evalOf) });
  }

  private evalLine(found: DriftEval): string {
    const command = `odw ${driftEvalArgs(found).join(" ")}`;
    if (this.opts.autoEval) return `drift: driftEval — \`${command}\` starts once the run ends (its output in drift-eval.log)`;
    return found.baseline
      ? `drift: ${found.name} has an eval — check it still passes against its last report: ${command}`
      : `drift: ${found.name} has an eval, with no report kept yet — run it: ${command}`;
  }

  private emit(fields: Record<string, unknown>): void {
    try {
      this.opts.emit(event(LOG, fields));
    } catch {
      // Watching for drift never fails the run.
    }
  }
}

/** A version line as a log line says it: its version number when it has one ("2.1.330 (Claude Code)" → "2.1.330"). */
export function shortVersion(line: string | null): string {
  if (line === null) return "unknown";
  return /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/.exec(line)?.[1] ?? line;
}

function modelName(model: string | null): string {
  return model ?? "(the CLI's default)";
}

/** A `drift` field of a log event as the run's summary folds it; null for anything else. */
export function readDrift(ev: WorkflowEvent): (DriftChange & { since: string }) | null {
  if (ev.type !== LOG || ev.drift === null || typeof ev.drift !== "object") return null;
  const d = ev.drift as Record<string, unknown>;
  if ((d.kind !== "cli" && d.kind !== "model") || typeof d.adapter !== "string" || typeof d.since !== "string") return null;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    kind: d.kind,
    adapter: d.adapter,
    ...(typeof d.label === "string" ? { label: d.label } : {}),
    from: text(d.from),
    to: text(d.to),
    since: d.since,
  };
}
