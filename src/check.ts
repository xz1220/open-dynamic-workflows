/**
 * `odw check <wf>` (an ODW extension): the loader's checks from the command
 * line, before anything runs.
 *
 * {@link checkWorkflow} compiles a workflow the way a run does (./loader:
 * the `meta` literal parsed as a pure literal, its name, description and
 * phases checked, the body compiled — never run) and reports a problem with
 * its line and column and a code frame: the source lines around it, a caret
 * under the column. The portability warnings `validate()` gives (./loader
 * `scanDualCompat`) come with it, Claude Code's own limits among them — a
 * `parallel()`/`pipeline()` the source settles at more than 4,096 items (see
 * ./claude-limits), a `meta` that is not a pure literal. Nothing is
 * enforced for them: ODW runs such a fan-out. {@link formatCheck} is the CLI's text; the
 * report itself is what `odw check --json` prints:
 *
 *   { file, ok, meta?: { name, description, phases }, errors: [{ message,
 *     line?, column?, frame? }], warnings: [string] }
 *
 * `--capabilities` (an ODW extension; see ./script-context) adds what the
 * script names outside Claude Code's dialect — `process`, `require`,
 * `import(`, `globalThis`, `Function(`, `eval`, `fetch`, timers, … — and the
 * ODW extension primitives it calls, read off the source, never run:
 *
 *   capabilities: { outOfDialect: [{ name, line, column, count, strict }], extensions: [string] }
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./adapters/config.js";
import { checkMeta } from "./dual-compat.js";
import { WorkflowScriptError } from "./errors.js";
import { loadWorkflowScript, scanDualCompat } from "./loader.js";
import { scanCapabilities, type CapabilityReport } from "./script-context.js";
import { resolveWorkflow } from "./workflows/resolve.js";

export interface CheckProblem {
  message: string;
  /** 1-based, when the loader knows where. */
  line?: number;
  column?: number;
  /** The source lines around it, a caret under the column (see {@link codeFrame}). */
  frame?: string;
}

export interface CheckReport {
  file: string;
  ok: boolean;
  /** What a run would register the workflow as, when it compiles. */
  meta?: { name: string; description: string; phases: string[] };
  errors: CheckProblem[];
  warnings: string[];
  /** With `--capabilities`: what it names outside the dialect, and the ODW extensions it calls. */
  capabilities?: CapabilityReport;
}

/** Lines of context a code frame shows before and after the line at fault. */
const FRAME_CONTEXT = 2;
/** Characters of a source line a code frame shows; a longer one is cut around the column. */
const FRAME_WIDTH = 160;

/** Compile `source` as workflow `file` (never run it) and report what a run would refuse, and where. */
export function checkWorkflow(source: string, file: string): CheckReport {
  try {
    const { meta } = loadWorkflowScript(source, file);
    return {
      file,
      ok: true,
      meta: {
        name: meta.name,
        description: meta.description,
        phases: (meta.phases ?? []).map((p) => (typeof p?.title === "string" ? p.title : String(p))),
      },
      errors: [],
      warnings: scanDualCompat(source),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = err instanceof WorkflowScriptError ? err.location : undefined;
    const problem: CheckProblem = at
      ? { message, line: at.line, column: at.column, frame: codeFrame(source, at.line, at.column) }
      : { message };
    const warnings = scanDualCompat(source);
    // A Claude Code limit too: it reads meta without running the script, and drops one it cannot.
    const metaCheck = checkMeta(source);
    if (metaCheck.found && !metaCheck.pure) {
      warnings.push(
        "meta is not a pure literal — Claude Code reads it without running the script, so it drops the workflow " +
          "from its completions; ODW refuses to run it",
      );
    }
    return { file, ok: false, errors: [problem], warnings };
  }
}

/**
 * The lines of `source` around `line` (1-based), numbered, the line at fault
 * marked with `>` and a caret under `column`:
 *
 *       1 | export const meta = { name: 'x', description: 'y' }
 *   >   2 | const s = 'ends early\\' and the rest'
 *         |                          ^
 *       3 | log(s)
 *
 * Tabs show as one space each, so the caret stays under its column; control
 * characters show as `?`; a line longer than 160 characters is cut around
 * the column.
 */
export function codeFrame(source: string, line: number, column: number): string {
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/);
  const at = Math.min(Math.max(1, line), lines.length);
  const first = Math.max(1, at - FRAME_CONTEXT);
  const last = Math.min(lines.length, at + FRAME_CONTEXT);
  const width = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    const raw = lines[n - 1] ?? "";
    const { text, offset } = n === at ? window(raw, column) : window(raw, 1);
    out.push(`${n === at ? ">" : " "} ${String(n).padStart(width)} | ${printable(text)}`.trimEnd());
    if (n === at) out.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, column - 1 - offset))}^`);
  }
  return out.join("\n");
}

/** At most FRAME_WIDTH characters of `text`, around `column`; `offset`: how many were cut from its start. */
function window(text: string, column: number): { text: string; offset: number } {
  if (text.length <= FRAME_WIDTH) return { text, offset: 0 };
  const offset = Math.max(0, Math.min(column - 1 - FRAME_WIDTH / 2, text.length - FRAME_WIDTH));
  return { text: text.slice(offset, offset + FRAME_WIDTH), offset };
}

/** A source line as a terminal may show it: a tab as a space, any other control character as `?`. */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\t/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

/** {@link checkWorkflow}'s report with what the script names outside the dialect (`odw check --capabilities`). */
export function checkCapabilities(source: string, file: string): CheckReport {
  return { ...checkWorkflow(source, file), capabilities: scanCapabilities(source) };
}

/** `odw check`'s text: `file:line:column: error: message`, the code frame, then each warning (and its capabilities). */
export function formatCheck(report: CheckReport): string[] {
  const out: string[] = [];
  for (const e of report.errors) {
    // The position leads the line here: the message need not say it again, nor name the file.
    let message = e.message;
    for (const prefix of [`failed to compile workflow ${report.file}: `, `workflow ${report.file}: `]) {
      if (message.startsWith(prefix)) message = message.slice(prefix.length);
    }
    if (e.line) message = message.replace(` (line ${e.line}:${e.column})`, "");
    out.push(`${report.file}${e.line ? `:${e.line}:${e.column}` : ""}: error: ${message}`);
    if (e.frame) out.push(e.frame);
  }
  for (const w of report.warnings) out.push(`${report.file}: warning: ${w}`);
  if (report.capabilities) {
    const { outOfDialect, extensions } = report.capabilities;
    for (const use of outOfDialect) {
      const times = use.count > 1 ? `, ${use.count} times` : "";
      const strict = use.strict ? "a strict context has its own, bare one" : "not in a strict context";
      out.push(`${report.file}:${use.line}:${use.column}: capability: ${use.name} — outside the dialect${times}; ${strict}`);
    }
    if (outOfDialect.length === 0) out.push(`${report.file}: capabilities: nothing outside the dialect`);
    out.push(`${report.file}: ODW extensions: ${extensions.length > 0 ? extensions.join(", ") : "none"}`);
  }
  if (report.ok && report.meta) {
    const phases = report.meta.phases.length;
    out.push(`${report.file}: ok — workflow '${report.meta.name}'${phases > 0 ? `, ${phases} phase${phases === 1 ? "" : "s"}` : ""}`);
  }
  return out;
}

/**
 * `odw check <script.js|name> [--json] [--capabilities] [--config P]`: resolve the workflow as
 * `odw run` would, check it, and print the report. Exit 0 when it would load
 * (warnings or not), 1 when it would not, 2 for a usage mistake.
 */
export function cmdCheck(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { json: { type: "boolean" }, capabilities: { type: "boolean" }, config: { type: "string" } },
  });
  const ref = positionals[0];
  if (!ref || positionals.length > 1) {
    process.stderr.write("usage: odw check <script.js|name> [--json] [--capabilities]\n");
    return 2;
  }
  let scriptPath: string;
  try {
    scriptPath = resolveWorkflow(ref, { cwd: process.cwd(), config: loadConfig(values.config ?? null, { quiet: true }) }).scriptPath;
  } catch (err) {
    process.stderr.write(`odw check: ${(err as Error).message}\n`);
    return 1;
  }
  let source: string;
  try {
    source = readFileSync(scriptPath, "utf8");
  } catch (err) {
    process.stderr.write(`odw check: cannot read ${scriptPath}: ${(err as Error).message}\n`);
    return 1;
  }
  const shown = relative(process.cwd(), scriptPath);
  const file = shown && !shown.startsWith("..") ? shown : scriptPath;
  const report = values.capabilities ? checkCapabilities(source, file) : checkWorkflow(source, file);
  if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else for (const line of formatCheck(report)) (report.ok ? process.stdout : process.stderr).write(line + "\n");
  return report.ok ? 0 : 1;
}
