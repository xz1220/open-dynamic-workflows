/**
 * The `odw eval` report (an ODW extension): what `--json` prints, `--out`
 * writes, `<runsRoot>/_evals/<name>/<id>.json` keeps, `--baseline` reads back
 * and `GET /api/evals/:name/:id` serves. A wire contract; its keys are stable:
 *
 *   version      1 — it changes when a key changes meaning
 *   name, id     the eval's name; this report's id (its start time, then 6 hex digits)
 *   file         the eval file, absolute
 *   description  the eval's, or null
 *   evalHash     sha256 of the definition as run (keys sorted; --adapter and --repeats
 *                applied): same hash, same eval
 *   definition   that definition: workflow, cases [{ name, args, checks }], adapters (null:
 *                the config's default), repeats, concurrency, budget, timeout
 *   workflow     { ref (as the file names it), script (the file it resolved to), sourceHash }
 *   odwVersion   the odw that ran it
 *   cliVersions  { <adapter>: [version, …] }: each adapter CLI's versions the runs' cli_version
 *                events recorded ("unknown" when a CLI did not tell)
 *   startedAt, finishedAt   ISO 8601; wallMs, the eval's whole time
 *   totals       { runs, passed, failed, passRate, costUsd, inputTokens, outputTokens }
 *                (costUsd and tokens: summed over the runs that reported them; null when none did)
 *   cells        a row per case × adapter, in definition order:
 *                { case, adapter, runs, passed, passRate, medianMs (median wall time),
 *                  costUsd (total), meanCostUsd, meanTokens (input + output), runIds }
 *                — the means over the runs that reported them; null when none did
 *   runs         a row per run: { runId, case, adapter, repeat (from 1), state, passed,
 *                timedOut, wallMs, inputTokens, outputTokens, costUsd, estimated (some output
 *                tokens are chars/4), cliVersions { <adapter>: version|null }, error,
 *                failures [{ check, message }] }
 *   baseline     null, or the comparison with --baseline's report (B is this one, A the baseline):
 *                { file, name, id, evalHash, sameDefinition, cells: [{ case, adapter, status:
 *                  "regressed" | "improved" | "unchanged" | "new" | "missing", passRate,
 *                  meanCostUsd, medianMs: each { a, b, delta } }], regressed: [{ case, adapter }] }
 *                — a cell regressed when its pass rate fell
 *
 * Any cell's runs open with `odw compare <runA> <runB>`: two repeats of one
 * cell, or the same case on two adapters, or a run against its baseline's.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigError } from "../errors.js";
import { writeJsonAtomic, readdirSafe } from "../runtime/fs-util.js";
import {
  displayWidth,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  glyphs,
  padEndWidth,
  palette,
  sanitizeText,
  truncateToWidth,
  type TermCaps,
} from "../tty.js";
import { isEvalName, type EvalDefinition } from "./definition.js";
import type { CheckFailure } from "./judge.js";

export const REPORT_VERSION = 1;

export interface EvalRunRecord {
  runId: string;
  case: string;
  adapter: string;
  repeat: number;
  state: string;
  passed: boolean;
  timedOut: boolean;
  wallMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  estimated: boolean;
  cliVersions: Record<string, string | null>;
  error: string | null;
  failures: CheckFailure[];
}

export interface EvalCell {
  case: string;
  adapter: string;
  runs: number;
  passed: number;
  passRate: number;
  medianMs: number | null;
  costUsd: number | null;
  meanCostUsd: number | null;
  meanTokens: number | null;
  runIds: string[];
}

export interface EvalTotals {
  runs: number;
  passed: number;
  failed: number;
  passRate: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Delta {
  a: number | null;
  b: number | null;
  delta: number | null;
}

export type CellStatus = "regressed" | "improved" | "unchanged" | "new" | "missing";

export interface BaselineCell {
  case: string;
  adapter: string;
  status: CellStatus;
  passRate: Delta;
  meanCostUsd: Delta;
  medianMs: Delta;
}

export interface BaselineComparison {
  file: string;
  name: string;
  id: string;
  evalHash: string;
  sameDefinition: boolean;
  cells: BaselineCell[];
  regressed: Array<{ case: string; adapter: string }>;
}

export interface EvalReport {
  version: typeof REPORT_VERSION;
  name: string;
  id: string;
  file: string;
  description: string | null;
  evalHash: string;
  definition: Omit<EvalDefinition, "name" | "description">;
  workflow: { ref: string; script: string; sourceHash: string | null };
  odwVersion: string;
  cliVersions: Record<string, string[]>;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  totals: EvalTotals;
  cells: EvalCell[];
  runs: EvalRunRecord[];
  baseline: BaselineComparison | null;
}

// --- building ------------------------------------------------------------------

/** The cells of `runs`: a row per case × adapter, in `cases` × `adapters` order (adapter first). */
export function cellsOf(runs: EvalRunRecord[], cases: string[], adapters: string[]): EvalCell[] {
  const cells: EvalCell[] = [];
  for (const adapter of adapters) {
    for (const name of cases) {
      const mine = runs.filter((r) => r.case === name && r.adapter === adapter).sort((x, y) => x.repeat - y.repeat);
      const passed = mine.filter((r) => r.passed).length;
      const costs = known(mine.map((r) => r.costUsd));
      const tokens = mine.filter((r) => r.inputTokens !== null || r.outputTokens !== null).map((r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0));
      const cost = costs.length ? sum(costs) : null;
      cells.push({
        case: name,
        adapter,
        runs: mine.length,
        passed,
        passRate: mine.length ? passed / mine.length : 0,
        medianMs: median(known(mine.map((r) => r.wallMs))),
        costUsd: cost,
        meanCostUsd: cost === null ? null : cost / costs.length,
        meanTokens: tokens.length ? sum(tokens) / tokens.length : null,
        runIds: mine.map((r) => r.runId),
      });
    }
  }
  return cells;
}

export function totalsOf(runs: EvalRunRecord[]): EvalTotals {
  const passed = runs.filter((r) => r.passed).length;
  const costs = known(runs.map((r) => r.costUsd));
  const input = known(runs.map((r) => r.inputTokens));
  const output = known(runs.map((r) => r.outputTokens));
  return {
    runs: runs.length,
    passed,
    failed: runs.length - passed,
    passRate: runs.length ? passed / runs.length : 0,
    costUsd: costs.length ? sum(costs) : null,
    inputTokens: input.length ? sum(input) : null,
    outputTokens: output.length ? sum(output) : null,
  };
}

/** Each adapter CLI's versions the runs recorded, sorted; "unknown" for a CLI that did not tell. */
export function cliVersionsOfRuns(runs: EvalRunRecord[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const run of runs) {
    for (const [adapter, version] of Object.entries(run.cliVersions)) (out[adapter] ??= new Set()).add(version ?? "unknown");
  }
  return Object.fromEntries(Object.keys(out).sort().map((adapter) => [adapter, [...out[adapter]!].sort()]));
}

// --- the baseline -----------------------------------------------------------------

/**
 * This report against an earlier one, cell by cell (matched by case name and
 * adapter): pass rate, mean cost and median time, B − A. A cell regressed
 * when its pass rate fell; it improved when it rose. A cell only this report
 * has is new; one only the baseline has is missing — neither regressed.
 */
export function compareToBaseline(cells: EvalCell[], evalHash: string, baseline: EvalReport, file: string): BaselineComparison {
  const key = (c: { case: string; adapter: string }) => `${c.adapter}\u0000${c.case}`;
  const before = new Map(baseline.cells.map((c) => [key(c), c]));
  const rows: BaselineCell[] = [];
  for (const cell of cells) {
    const old = before.get(key(cell));
    before.delete(key(cell));
    const passRate = delta(old ? old.passRate : null, cell.passRate);
    const status: CellStatus = !old ? "new" : passRate.delta! < 0 ? "regressed" : passRate.delta! > 0 ? "improved" : "unchanged";
    rows.push({
      case: cell.case,
      adapter: cell.adapter,
      status,
      passRate,
      meanCostUsd: delta(old?.meanCostUsd ?? null, cell.meanCostUsd),
      medianMs: delta(old?.medianMs ?? null, cell.medianMs),
    });
  }
  for (const old of before.values()) {
    rows.push({
      case: old.case,
      adapter: old.adapter,
      status: "missing",
      passRate: delta(old.passRate, null),
      meanCostUsd: delta(old.meanCostUsd, null),
      medianMs: delta(old.medianMs, null),
    });
  }
  return {
    file,
    name: baseline.name,
    id: baseline.id,
    evalHash: baseline.evalHash,
    sameDefinition: baseline.evalHash === evalHash,
    cells: rows,
    regressed: rows.filter((r) => r.status === "regressed").map((r) => ({ case: r.case, adapter: r.adapter })),
  };
}

function delta(a: number | null, b: number | null): Delta {
  return { a, b, delta: a !== null && b !== null ? b - a : null };
}

/**
 * Read a report back (`--baseline`): any JSON file with `version` 1 and the
 * fields a comparison needs. A ConfigError says what is wrong with it.
 */
export function readReportFile(file: string): EvalReport {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new ConfigError(`baseline ${file}: ${e.code === "ENOENT" ? "no such file" : e.code ? e.message : `not valid JSON: ${e.message}`}`);
  }
  const problem = reportProblem(raw);
  if (problem) throw new ConfigError(`baseline ${file}: not an odw eval report (${problem})`);
  return raw as EvalReport;
}

/** What makes `raw` no report a baseline can be, or null. */
function reportProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return "not a JSON object";
  if (raw.version !== REPORT_VERSION) return `version ${JSON.stringify(raw.version)}, expected ${REPORT_VERSION}`;
  for (const key of ["name", "id", "evalHash"]) if (typeof raw[key] !== "string") return `no ${key}`;
  if (!Array.isArray(raw.cells)) return "no cells";
  for (const cell of raw.cells) {
    if (!isRecord(cell) || typeof cell.case !== "string" || typeof cell.adapter !== "string" || typeof cell.passRate !== "number") {
      return "a cell without case, adapter and passRate";
    }
    for (const field of ["meanCostUsd", "medianMs"]) {
      if (cell[field] !== null && typeof cell[field] !== "number") return `a cell whose ${field} is not a number`;
    }
  }
  return null;
}

// --- storage under the runs root -----------------------------------------------------

/** Where reports are kept: `<runsRoot>/_evals/<name>/<id>.json`. */
export function evalsDir(runsRoot: string): string {
  return join(runsRoot, "_evals");
}

export function saveReport(runsRoot: string, report: EvalReport): string {
  const dir = join(evalsDir(runsRoot), report.name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.id}.json`);
  writeJsonAtomic(file, report, 2);
  return file;
}

/** What `GET /api/evals` lists of a report. */
export interface EvalReportSummary {
  name: string;
  id: string;
  description: string | null;
  workflow: string;
  evalHash: string;
  startedAt: string;
  finishedAt: string;
  totals: EvalTotals;
  adapters: string[];
  cases: number;
  /** Cells that regressed against its baseline; null when it had none. */
  regressed: number | null;
}

/** Every kept report, newest first (by id); a file that is no report is skipped. */
export function listReports(runsRoot: string): EvalReportSummary[] {
  const out: EvalReportSummary[] = [];
  for (const dir of readdirSafe(evalsDir(runsRoot))) {
    if (!dir.isDirectory() || !isEvalName(dir.name)) continue;
    for (const entry of readdirSafe(join(evalsDir(runsRoot), dir.name))) {
      const id = entry.name.replace(/\.json$/, "");
      if (!entry.isFile() || id === entry.name || !isEvalName(id)) continue;
      const report = readStoredReport(runsRoot, dir.name, id);
      if (report) out.push(summaryOf(report));
    }
  }
  return out.sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : x.name.localeCompare(y.name)));
}

/** One kept report, or null: none by that name and id, or not a report. Name and id must be eval names. */
export function readStoredReport(runsRoot: string, name: string, id: string): EvalReport | null {
  if (!isEvalName(name) || !isEvalName(id)) return null;
  const file = join(evalsDir(runsRoot), name, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return reportProblem(raw) === null ? (raw as EvalReport) : null;
  } catch {
    return null;
  }
}

function summaryOf(report: EvalReport): EvalReportSummary {
  const adapters = [...new Set((report.cells ?? []).map((c) => c.adapter))];
  return {
    name: report.name,
    id: report.id,
    description: report.description ?? null,
    workflow: report.workflow?.ref ?? "",
    evalHash: report.evalHash,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    totals: report.totals,
    adapters,
    cases: new Set((report.cells ?? []).map((c) => c.case)).size,
    regressed: report.baseline ? report.baseline.regressed.length : null,
  };
}

// --- the table ---------------------------------------------------------------------

export interface FormatOptions {
  caps: TermCaps;
  /** Columns a line may take. */
  width: number;
}

/**
 * The report as `odw eval` prints it: a row per cell — pass k/n, median wall
 * time, total and mean cost, mean tokens — then the totals, the failures
 * (each run's missed checks, with its run id) and, with a baseline, each
 * cell's deltas and the cells that regressed.
 */
export function formatReport(report: EvalReport, opts: FormatOptions): string[] {
  const p = palette(opts.caps);
  const g = glyphs(opts.caps);
  const lines: string[] = [];
  const header = ["CASE", "ADAPTER", "PASS", "MEDIAN TIME", "COST", "MEAN COST", "MEAN TOKENS"];
  const rows = report.cells.map((c) => [
    c.case,
    c.adapter,
    `${c.passed}/${c.runs}`,
    c.medianMs === null ? "-" : fmtDuration(c.medianMs),
    c.costUsd === null ? "-" : fmtUsd(c.costUsd),
    c.meanCostUsd === null ? "-" : fmtUsd(c.meanCostUsd),
    c.meanTokens === null ? "-" : fmtTokens(c.meanTokens),
  ]);
  const tones = report.cells.map((c) => (c.passed === c.runs ? p.ok : c.passed === 0 ? p.err : p.run));
  lines.push(...table(header, rows, opts.width, (row, col, text) => (col === 2 ? tones[row]!(text) : text), p.bold));

  const t = report.totals;
  const spent = t.costUsd === null ? "cost unknown" : `cost ${fmtUsd(t.costUsd)}`;
  const tokens = t.inputTokens === null && t.outputTokens === null ? "" : ` · tokens ${fmtTokens(t.inputTokens ?? 0)} in, ${fmtTokens(t.outputTokens ?? 0)} out`;
  const passTone = t.passed === t.runs ? p.ok : p.err;
  lines.push("");
  const totals = `${t.passed}/${t.runs} passed (${percent(t.passRate)}) · ${spent}${tokens} · ${fmtDuration(report.wallMs)} wall`;
  const fitted = truncateToWidth(totals, Math.max(10, opts.width - 7));
  const cut = fitted.indexOf(" passed");
  lines.push(`${p.bold("total")}  ${cut === -1 ? fitted : passTone(fitted.slice(0, cut + 7)) + fitted.slice(cut + 7)}`);

  const failed = report.runs.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push("", p.bold("failures"));
    for (const run of failed) {
      lines.push(truncateToWidth(`  ${sanitizeText(run.case, 60)} · ${run.adapter} · #${run.repeat}  ${run.runId}  ${run.state}`, opts.width));
      for (const f of run.failures) {
        lines.push(truncateToWidth(`    ${p.err(g.fail)} ${sanitizeText(f.check, 80)}: ${sanitizeText(f.message, 300)}`, opts.width));
      }
    }
  }

  const base = report.baseline;
  if (base) {
    lines.push("", p.bold(`against baseline ${base.name}/${base.id}`) + (base.sameDefinition ? "" : p.dim("  (its eval definition differs)")));
    const statusTone = (s: CellStatus) => (s === "regressed" ? p.err : s === "improved" ? p.ok : p.dim);
    const baseRows = base.cells.map((c) => [
      c.case,
      c.adapter,
      `${pct(c.passRate.a)} ${g.arrow} ${pct(c.passRate.b)}`,
      signed(c.passRate.delta, (n) => `${Math.round(n * 100)}pp`),
      signed(c.meanCostUsd.delta, fmtUsd),
      signed(c.medianMs.delta, fmtDuration),
      c.status,
    ]);
    lines.push(
      ...table(["CASE", "ADAPTER", "PASS RATE", "Δ PASS", "Δ MEAN COST", "Δ MEDIAN TIME", ""], baseRows, opts.width, (row, col, text) =>
        col === 6 ? statusTone(base.cells[row]!.status)(text) : text, p.bold),
    );
    lines.push("");
    lines.push(
      base.regressed.length === 0
        ? p.ok("no cell regressed")
        : p.err(`regressed: ${base.regressed.map((r) => `${sanitizeText(r.case, 60)} · ${r.adapter}`).join(", ")}`),
    );
  }
  return lines;
}

/** Columns padded to their widest cell, the first ones cut to fit `width`. */
function table(
  header: string[],
  rows: string[][],
  width: number,
  paint: (row: number, col: number, text: string) => string,
  bold: (s: string) => string,
): string[] {
  const clean = rows.map((r) => r.map((cell, i) => (i < 2 ? sanitizeText(cell, 60) : cell)));
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...clean.map((r) => displayWidth(r[i]!))));
  // Too wide: the case column gives way first.
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
  if (total > width) widths[0] = Math.max(8, widths[0]! - (total - width));
  const line = (cells: string[], style: (row: number, col: number, text: string) => string, row: number) =>
    cells
      .map((cell, i) => {
        const fitted = displayWidth(cell) > widths[i]! ? truncateToWidth(cell, widths[i]!) : cell;
        const padded = i === cells.length - 1 ? fitted : padEndWidth(fitted, widths[i]!);
        return style(row, i, padded);
      })
      .join("  ")
      .replace(/\s+$/, "");
  return [line(header, (_r, _c, text) => bold(text), -1), ...clean.map((r, i) => line(r, paint, i))];
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function pct(rate: number | null): string {
  return rate === null ? "-" : percent(rate);
}

function signed(n: number | null, fmt: (n: number) => string): string {
  if (n === null) return "-";
  if (n === 0) return "0";
  return n > 0 ? `+${fmt(n)}` : `-${fmt(-n)}`;
}

// --- helpers -------------------------------------------------------------------------

function known(values: Array<number | null>): number[] {
  return values.filter((v): v is number => v !== null);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
