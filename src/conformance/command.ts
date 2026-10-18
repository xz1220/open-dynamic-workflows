/**
 * `odw conformance` — check this ODW against the dialect conformance suite
 * (./suite; the format is the repository's conformance/README.md).
 *
 *   odw conformance [--json] [--case N|name]... [--dir DIR] [--strict]
 *
 * Runs every case (or the `--case` ones) one after another, each as a real
 * odw run on the suite's mock agent, and prints a line per case: ✔ or ✖, its
 * name, `(unspecified)` when Claude Code's docs do not settle it, its title,
 * then each expectation it missed. `--json` prints the report instead.
 * `--dir` names another suite directory (one with cases/ and
 * mock-agent.mjs); the default is the suite this odw ships with.
 * `--strict` runs every case in a strict script context (an ODW extension;
 * see ../script-context) — the bare realm Claude Code gives a script.
 *
 * Exit 0 when every case passed, 1 when any failed (unspecified ones too:
 * they pin what ODW does), 2 for a usage error — an unknown case, a suite
 * or expected.json that does not follow the format: nothing ran.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { detectCaps, glyphs, palette, sanitizeText } from "../tty.js";
import { VERSION } from "../version.generated.js";
import type { ScriptContext } from "../script-context.js";
import {
  checkCase,
  ConformanceFormatError,
  defaultSuiteDir,
  loadSuite,
  selectCase,
  type CaseReport,
  type ConformanceCase,
} from "./suite.js";

/** The `--json` report's shape version. */
export const CONFORMANCE_REPORT_VERSION = 1;

export interface ConformanceReport {
  version: number;
  odwVersion: string;
  suite: string;
  /** The script context every case ran in: "strict" under --strict, else each run's own ("host"). */
  scriptContext: ScriptContext;
  passed: number;
  failed: number;
  cases: CaseReport[];
}

/** `odw conformance …`; returns the exit code. */
export async function cmdConformance(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      case: { type: "string", multiple: true },
      dir: { type: "string" },
      strict: { type: "boolean" },
    },
  });
  if (positionals.length > 0) {
    process.stderr.write("usage: odw conformance [--json] [--case N|name]... [--dir DIR] [--strict]\n");
    return 2;
  }
  const dir = values.dir !== undefined ? resolve(values.dir) : defaultSuiteDir();
  if (dir === null) {
    process.stderr.write(
      "odw conformance: this odw ships without the suite (a standalone binary has none) — " +
        "pass --dir <conformance directory> from a checkout of open-dynamic-workflows\n",
    );
    return 2;
  }
  let cases: ConformanceCase[];
  try {
    const all = loadSuite(dir);
    cases = values.case ? [...new Set(values.case.map((sel) => selectCase(all, sel)))] : all;
  } catch (err) {
    if (!(err instanceof ConformanceFormatError)) throw err;
    process.stderr.write(`odw conformance: ${err.message}\n`);
    return 2;
  }

  const caps = detectCaps(process.stdout, process.env);
  const paint = palette(caps);
  const g = glyphs(caps);
  const text = !values.json;
  if (text) {
    const unspecified = cases.filter((c) => c.claudeCode === "unspecified").length;
    process.stdout.write(
      `odw conformance — ${cases.length} case${cases.length === 1 ? "" : "s"} from ${dir}` +
        (values.strict ? " in a strict script context" : "") +
        (unspecified > 0 ? paint.dim(` (${unspecified} unspecified in Claude Code's docs)`) : "") +
        "\n",
    );
  }
  const reports: CaseReport[] = [];
  for (const c of cases) {
    const report = await checkCase(c, dir, values.strict ? { scriptContext: "strict" } : {});
    reports.push(report);
    if (text) process.stdout.write(formatCase(report, paint, g));
  }
  const failed = reports.filter((r) => !r.passed).length;
  if (values.json) {
    const report: ConformanceReport = {
      version: CONFORMANCE_REPORT_VERSION,
      odwVersion: VERSION,
      suite: dir,
      scriptContext: values.strict ? "strict" : "host",
      passed: reports.length - failed,
      failed,
      cases: reports,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const line = `${reports.length - failed} passed, ${failed} failed`;
    process.stdout.write((failed > 0 ? paint.err(line) : paint.ok(line)) + "\n");
  }
  return failed > 0 ? 1 : 0;
}

function formatCase(
  r: CaseReport,
  paint: ReturnType<typeof palette>,
  g: ReturnType<typeof glyphs>,
): string {
  const mark = r.passed ? paint.ok(g.ok) : paint.err(g.fail);
  const tag = r.claudeCode === "unspecified" ? ` ${paint.dim("(unspecified)")}` : "";
  const lines = [`  ${mark} ${r.case}${tag}  ${paint.dim(sanitizeText(r.title, 160))}`];
  for (const failure of r.failures) lines.push(`      ${paint.err(sanitizeText(failure, 800))}`);
  return lines.join("\n") + "\n";
}
