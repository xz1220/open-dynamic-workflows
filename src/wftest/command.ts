/**
 * `odw test` — run a workflow's test cases for $0 (an ODW extension; the
 * test file is ./definition, the mock agent ./mock).
 *
 *   odw test [<wf|file>] [--case N|name]... [--json] [--keep] [--runs-root DIR] [--config P]
 *
 * `<wf>` is `.odw/tests/<wf>.json` in this directory; anything ending in
 * .json or holding a path separator is a file; nothing at all runs every
 * `.odw/tests/*.json`. Each case is a real odw run — worker, scheduler,
 * bridge, schema validation and retries — started from this directory, its
 * agents answered by the case's scripted replies: nothing calls a model. The
 * runs go in a scratch run store, removed afterwards; `--keep` keeps it (and
 * says where), `--runs-root DIR` puts them in DIR (kept).
 *
 * A line per case (✔ or ✖, its name, its agents and time, then each
 * expectation it missed) — or, with --json, the report: `{ version, odwVersion,
 * passed, failed, runsRoot, cases: [{ file, workflow, case, passed, failures:
 * [{ check, message }], runId, state, agents, durationMs }] }`.
 *
 * Exit 0 when every case passed, 1 when any failed, 2 for a usage error (a
 * bad flag or test file, an unknown case, a workflow that does not load:
 * nothing ran).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "../adapters/config.js";
import { ConfigError, DynamicWorkflowError } from "../errors.js";
import { isEvalName } from "../eval/definition.js";
import { loadWorkflowScript } from "../loader.js";
import { detectCaps, fmtDuration, glyphs, palette, sanitizeText } from "../tty.js";
import { VERSION } from "../version.generated.js";
import { resolveWorkflow } from "../workflows/resolve.js";
import { loadTestFile, type TestCase, type TestFile } from "./definition.js";
import { runTestCase, type CaseResult } from "./run.js";

/** The `--json` report's shape version. */
export const TEST_REPORT_VERSION = 1;

export interface TestReport {
  version: number;
  odwVersion: string;
  passed: number;
  failed: number;
  /** Where the runs are; null when they were removed. */
  runsRoot: string | null;
  cases: Array<CaseResult & { file: string; workflow: string; case: string }>;
}

/** A command-line mistake, or tests that cannot start: printed as is, exit 2. */
class TestUsage extends Error {}

const USAGE = "usage: odw test [<wf|file.json>] [--case N|name]... [--json] [--keep] [--runs-root DIR] [--config P]";

/** `odw test …`; returns the exit code. */
export async function cmdTest(rest: string[]): Promise<number> {
  try {
    return await testCommand(rest);
  } catch (err) {
    if (err instanceof TestUsage) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof DynamicWorkflowError) {
      process.stderr.write(`odw test: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

async function testCommand(rest: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        case: { type: "string", multiple: true },
        json: { type: "boolean" },
        keep: { type: "boolean" },
        "runs-root": { type: "string" },
        config: { type: "string" },
      },
    });
  } catch (err) {
    throw new TestUsage(`odw test: ${(err as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new TestUsage(USAGE);
  const cwd = process.cwd();
  const files = testFilesOf(positionals[0], cwd);
  const configPath = values.config !== undefined ? resolve(values.config) : null;
  const config = loadConfig(configPath, { quiet: true, cwd });

  // Everything is read and checked before anything runs.
  const plan: Array<{ test: TestFile; script: string; cases: TestCase[] }> = [];
  for (const file of files) {
    const test = loadTestFile(file);
    const { scriptPath } = resolveWorkflow(test.workflow, { cwd, config });
    try {
      loadWorkflowScript(readFileSync(scriptPath, "utf8"), scriptPath);
    } catch (err) {
      throw new ConfigError(`workflow ${scriptPath} (test file ${file}) does not load: ${(err as Error).message}`);
    }
    plan.push({ test, script: scriptPath, cases: selectCases(test, values.case) });
  }
  const total = plan.reduce((n, p) => n + p.cases.length, 0);
  if (total === 0) throw new TestUsage(`odw test: no case is named ${values.case!.map((s) => `'${s}'`).join(" or ")}`);

  const keep = values.keep === true || values["runs-root"] !== undefined;
  const runsRoot = values["runs-root"] !== undefined ? resolve(values["runs-root"]) : mkdtempSync(join(tmpdir(), "odw-test-"));
  const caps = detectCaps(process.stdout, process.env);
  const p = palette(caps);
  const g = glyphs(caps);
  const say = (line: string): void => {
    if (!values.json) process.stdout.write(line + "\n");
  };
  const results: TestReport["cases"] = [];
  try {
    for (const { test, script, cases } of plan) {
      say(`${p.dim(relative(cwd, test.file) || test.file)} ${p.dim("·")} workflow ${sanitizeText(test.workflow, 80)}`);
      for (const c of cases) {
        const result = await runTestCase(c, { script, cwd, configPath, runsRoot, file: test.file });
        results.push({ file: test.file, workflow: test.workflow, case: c.name, ...result });
        const mark = result.passed ? p.ok(g.ok) : p.err(g.fail);
        const about = `${result.agents} agent${result.agents === 1 ? "" : "s"}, ${fmtDuration(result.durationMs)}`;
        say(`  ${mark} ${sanitizeText(c.name, 100)}  ${p.dim(about)}${keep ? `  ${p.dim(result.runId)}` : ""}`);
        for (const f of result.failures) say(`      ${p.err(sanitizeText(f.check, 80))}: ${sanitizeText(f.message, 240)}`);
      }
    }
  } finally {
    if (!keep) rmSync(runsRoot, { recursive: true, force: true });
  }
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  if (values.json) {
    const report: TestReport = { version: TEST_REPORT_VERSION, odwVersion: VERSION, passed, failed, runsRoot: keep ? runsRoot : null, cases: results };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    say(`${failed === 0 ? p.ok(`${passed} passed`) : `${passed} passed, ${p.err(`${failed} failed`)}`} · no model called, $0`);
    if (keep) say(p.dim(`runs kept in ${runsRoot} (odw logs <run_id> --runs-root ${runsRoot})`));
  }
  return failed === 0 ? 0 : 1;
}

/** The test files `ref` names: a file, `.odw/tests/<ref>.json`, or (none) every `.odw/tests/*.json`. */
function testFilesOf(ref: string | undefined, cwd: string): string[] {
  const dir = join(cwd, ".odw", "tests");
  if (ref === undefined) {
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    if (files.length === 0) throw new TestUsage(`odw test: no tests to run: ${dir} holds no .json test file (odw run <wf> --record makes one)`);
    return files.map((f) => join(dir, f));
  }
  if (/\.json$/i.test(ref) || /[\\/]/.test(ref)) {
    const file = resolve(cwd, ref);
    if (!existsSync(file)) throw new TestUsage(`odw test: no such test file: ${file}`);
    return [file];
  }
  if (!isEvalName(ref)) throw new TestUsage(`odw test: '${ref}' is neither a test file (….json) nor a workflow name`);
  const file = join(dir, `${ref}.json`);
  if (!existsSync(file)) throw new TestUsage(`odw test: no tests for '${ref}': ${file} does not exist (odw run ${ref} --record makes one)`);
  return [file];
}

/** The cases `--case` names — by number (from 1) or name — or every case. */
function selectCases(test: TestFile, selectors: string[] | undefined): TestCase[] {
  if (!selectors) return test.cases;
  return test.cases.filter((c, i) => selectors.some((s) => (/^\d+$/.test(s) ? Number(s) === i + 1 : s === c.name)));
}
