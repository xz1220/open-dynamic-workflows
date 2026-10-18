/**
 * `odw gc` and `odw pin` (ODW extensions; see ./gc).
 *
 *   odw gc [--dry-run] [--yes] [--older-than 30d] [--json] [--source DIR] [--config P] [--runs-root DIR]
 *   odw pin [<run_id> [--remove]] [--json]
 *
 * `gc` reports what ODW left — orphaned worktrees, keep branches, expired run
 * directories, and their sizes — and deletes nothing unless `--yes` is given
 * (`--dry-run`, the default, says so explicitly). `--older-than` (`30d`,
 * `12h`, `2w`) overrides the config's `retention.days`. The repository of
 * `--source` (default: the current directory) is looked at besides each run's
 * own. Exit 0, 1 when a removal failed, 2 on a usage error.
 *
 * `pin <run_id>` marks a run so gc skips it in every kind; `--remove` unpins
 * it; with no run id it lists the pinned runs.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, resolveRunsRoot } from "../adapters/config.js";
import { cliActor } from "../identity.js";
import { detectCaps, palette, sanitizeText, type TermCaps } from "../tty.js";
import { applyGc, formatBytes, pinRun, planGc, readPin, unpinRun, type GcPlan, type GcResult } from "./gc.js";
import { RunStore } from "./run-store.js";
import { RUN_ID_RE } from "./run-source.js";

const GC_USAGE = "usage: odw gc [--dry-run] [--yes] [--older-than 30d] [--json] [--source DIR]";
const PIN_USAGE = "usage: odw pin [<run_id> [--remove]] [--json]";
/** Lines listed per kind before "… and N more". */
const LIST_MAX = 20;

/** `30d`, `12h`, `2w`, or a bare number of days → days; null when malformed. */
export function parseAge(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([hdw]?)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const days = m[2] === "h" ? n / 24 : m[2] === "w" ? n * 7 : n;
  return Number.isFinite(days) && days > 0 ? days : null;
}

function ageText(days: number): string {
  return days < 1 ? `${Math.round(days * 24)}h` : `${Math.floor(days)}d`;
}

export async function cmdGc(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
      "older-than": { type: "string" },
      json: { type: "boolean" },
      source: { type: "string" },
      config: { type: "string" },
      "runs-root": { type: "string" },
    },
  });
  if (positionals.length > 0) return usage(GC_USAGE);
  if (values.yes && values["dry-run"]) return usage(`odw gc: --dry-run and --yes contradict each other\n${GC_USAGE}`);
  const config = loadConfig(values.config ?? null, { quiet: true });
  let days = config.settings.retention.days;
  if (values["older-than"] !== undefined) {
    const parsed = parseAge(values["older-than"]);
    if (parsed === null) return usage(`odw gc: --older-than takes an age like 30d, 12h or 2w; got ${JSON.stringify(values["older-than"])}`);
    days = parsed;
  }
  const store = new RunStore(values["runs-root"] ?? resolveRunsRoot(config.settings.runsRoot));
  const source = resolve(values.source ?? process.cwd());
  const plan = await planGc({ store, olderThanDays: days, transcripts: config.settings.retention.transcripts, repos: [source] });
  const result = values.yes ? await applyGc(plan, { store }) : null;
  if (values.json) {
    process.stdout.write(JSON.stringify(gcJson(plan, result), null, 2) + "\n");
  } else {
    process.stdout.write(formatGc(plan, result, detectCaps(process.stdout, process.env)) + "\n");
  }
  return result && result.errors.length > 0 ? 1 : 0;
}

function usage(text: string): number {
  process.stderr.write(`${text}\n`);
  return 2;
}

/** The plan (and what was done) as `odw gc --json` prints it. */
export function gcJson(plan: GcPlan, result: GcResult | null): Record<string, unknown> {
  const orphans = plan.worktrees.filter((w) => w.orphan);
  return {
    version: 1,
    dryRun: result === null,
    olderThanDays: plan.olderThanDays,
    runsRoot: plan.runsRoot,
    worktrees: orphans.map((w) => ({ dir: w.dir, worktree: w.worktree, repo: w.repo, run: w.run, pid: w.pid, registered: w.registered, why: w.why, bytes: w.bytes })),
    worktreesKept: plan.worktrees.filter((w) => !w.orphan).map((w) => ({ dir: w.dir, run: w.run, why: w.why })),
    branches: plan.branches.candidates,
    branchesKept: plan.branches.kept,
    branchesUnknownRun: plan.branches.unknown,
    runs: plan.runs.map((r) => ({ runId: r.runId, workflow: r.workflow, ageDays: Math.floor(r.ageDays), files: r.files.length, bytes: r.bytes })),
    skipped: plan.skipped,
    totals: { ...plan.totals, reclaimable: plan.totals.worktreeBytes + plan.totals.transcriptBytes },
    ...(result ? { removed: result } : {}),
  };
}

/** The report `odw gc` prints. */
export function formatGc(plan: GcPlan, result: GcResult | null, caps: TermCaps = { color: false, truecolor: false, unicode: false }): string {
  const p = palette(caps);
  const safe = (s: string) => sanitizeText(s, 300);
  const lines: string[] = [];
  const mode = result === null ? p.run("dry run — nothing is deleted; --yes deletes") : p.err("--yes: deleting");
  lines.push(`${p.bold("odw gc")} · ${mode}`);
  lines.push(p.dim(`runs root ${safe(plan.runsRoot)} · ${formatBytes(plan.totals.runsRootBytes)}`));
  const more = (n: number) => (n > LIST_MAX ? [p.dim(`  … and ${n - LIST_MAX} more`)] : []);

  const orphans = plan.worktrees.filter((w) => w.orphan);
  lines.push("", `${p.bold("Orphaned worktrees")}  ${orphans.length}${orphans.length ? ` · ${formatBytes(plan.totals.worktreeBytes)}` : ""}`);
  for (const w of orphans.slice(0, LIST_MAX)) lines.push(`  ${safe(w.dir)}  ${p.dim(safe(w.why))}  ${formatBytes(w.bytes)}`);
  lines.push(...more(orphans.length));
  const inUse = plan.worktrees.length - orphans.length;
  if (inUse > 0) lines.push(p.dim(`  ${inUse} more in use or kept (see --json)`));

  const b = plan.branches;
  lines.push("", `${p.bold("Keep branches")}  ${b.candidates.length}`);
  for (const c of b.candidates.slice(0, LIST_MAX)) {
    const why = c.reason === "applied" ? "HEAD already holds its change" : `its run is older than ${ageText(plan.olderThanDays)}`;
    lines.push(`  ${safe(c.branch)}  ${p.dim(`${why} · ${safe(c.repo)}`)}`);
  }
  lines.push(...more(b.candidates.length));
  if (b.unknown.length > 0) lines.push(p.dim(`  ${b.unknown.length} odw branch(es) of runs not in this runs root: kept`));

  lines.push("", `${p.bold(`Runs older than ${ageText(plan.olderThanDays)}`)}  ${plan.runs.length}${plan.runs.length ? ` · ${formatBytes(plan.totals.transcriptBytes)} of transcripts and stderr` : ""}`);
  for (const r of plan.runs.slice(0, LIST_MAX)) {
    lines.push(`  ${safe(r.runId)}  ${p.dim(`${safe(r.workflow ?? "?")} · ${ageText(r.ageDays)} · ${r.files.length} file(s)`)}  ${formatBytes(r.bytes)}`);
  }
  lines.push(...more(plan.runs.length));
  if (plan.runs.length > 0) lines.push(p.dim("  meta, status, events, results and diffs stay: odw list, estimate and compare still work"));

  const skipped: string[] = [];
  if (plan.skipped.pinned.length) skipped.push(`${plan.skipped.pinned.length} pinned`);
  if (plan.skipped.active.length) skipped.push(`${plan.skipped.active.length} running or waiting`);
  if (skipped.length) lines.push("", p.dim(`skipped runs: ${skipped.join(", ")} (odw pin <run_id> keeps one)`));

  const reclaimable = plan.totals.worktreeBytes + plan.totals.transcriptBytes;
  lines.push("");
  if (result === null) {
    const nothing = orphans.length === 0 && b.candidates.length === 0 && plan.runs.length === 0;
    lines.push(nothing ? p.ok("nothing to reclaim") : `would reclaim ${formatBytes(reclaimable)}${b.candidates.length ? ` and ${b.candidates.length} branch(es)` : ""} — ${p.bold("odw gc --yes")} deletes it`);
  } else {
    lines.push(
      p.ok(`removed ${result.worktrees} worktree(s), ${result.branches} branch(es), trimmed ${result.runs} run(s): ${formatBytes(result.bytes)} reclaimed`),
    );
    for (const e of result.errors) lines.push(p.err(`  failed: ${safe(e)}`));
  }
  return lines.join("\n");
}

export function cmdPin(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      remove: { type: "boolean" },
      json: { type: "boolean" },
      config: { type: "string" },
      "runs-root": { type: "string" },
    },
  });
  if (positionals.length > 1 || (values.remove && positionals.length === 0)) return usage(PIN_USAGE);
  const config = loadConfig(values.config ?? null, { quiet: true });
  const store = new RunStore(values["runs-root"] ?? resolveRunsRoot(config.settings.runsRoot));
  const runId = positionals[0];
  if (runId === undefined) {
    const pinned = store
      .listRuns()
      .map((ref) => ({ runId: ref.runId, workflow: ref.workflowName, pin: readPin(store.runDir(ref.runId)) }))
      .filter((r) => r.pin !== null);
    if (values.json) process.stdout.write(JSON.stringify(pinned.map((r) => ({ runId: r.runId, workflow: r.workflow, ...r.pin })), null, 2) + "\n");
    else if (pinned.length === 0) process.stdout.write("no pinned runs\n");
    else for (const r of pinned) process.stdout.write(`${r.runId}  ${sanitizeText(r.workflow ?? "", 80)}${r.pin!.by ? `  pinned by ${sanitizeText(r.pin!.by, 80)}` : ""}\n`);
    return 0;
  }
  if (!RUN_ID_RE.test(runId) || runId.startsWith("cc-")) return usage(`odw pin: not an odw run id: ${sanitizeText(runId, 80)}`);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const dir = store.runDir(runId);
  if (values.remove) {
    const was = unpinRun(dir);
    process.stdout.write(was ? `unpinned ${runId}: odw gc may reclaim it again\n` : `${runId} was not pinned\n`);
    return 0;
  }
  pinRun(dir, cliActor());
  process.stdout.write(`pinned ${runId}: odw gc skips it (odw pin ${runId} --remove undoes it)\n`);
  return 0;
}
