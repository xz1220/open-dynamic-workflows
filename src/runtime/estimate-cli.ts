/**
 * `odw estimate <wf> [--args JSON|@file] [--json]` and `odw run --estimate
 * [--yes]` (ODW extensions; see ./estimate): what a run of a workflow is
 * likely to cost and take, from its earlier runs, before it starts.
 *
 * The workflow resolves as `odw run` resolves it — a path, a name, a
 * plugin's `<plugin>:<name>` — and its source's sha256 picks the earlier
 * runs of the exact same source when there are any. A name that no longer
 * resolves to a file is estimated by name alone, from its runs.
 *
 * `odw run --estimate` prints the estimate on stderr and asks "start it?
 * [y/N]" on a terminal; `--yes` starts it without asking. With no terminal to
 * ask on, and no `--yes`, it does not start (exit 1).
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, resolveRunsRoot } from "../adapters/config.js";
import { loadWorkflowScript } from "../loader.js";
import { sourceHash } from "../provenance.js";
import { detectCaps, sanitizeText } from "../tty.js";
import { resolveWorkflow } from "../workflows/resolve.js";
import { formatEstimate, loadEstimate, type WorkflowEstimate } from "./estimate.js";
import { RunStore } from "./run-store.js";

/** What names a workflow's earlier runs: its name, its source's sha256, and the store they are in. */
export interface WorkflowIdentity {
  workflow: string;
  sourceHash: string | null;
  store: RunStore;
  /** Why the source could not be read, when the workflow was estimated by its name alone. */
  unresolved?: string;
}

/** How `ref` resolves for an estimate, under `--config`, `--runs-root` and `--source`. */
export function workflowIdentity(
  ref: string,
  flags: { config?: string | null; runsRoot?: string | null; source?: string | null },
): WorkflowIdentity {
  const config = loadConfig(flags.config ?? null, { quiet: true });
  const store = new RunStore(flags.runsRoot ?? resolveRunsRoot(config.settings.runsRoot));
  const cwd = flags.source ? resolve(flags.source) : process.cwd();
  try {
    const resolved = resolveWorkflow(ref, { cwd, config });
    const text = readFileSync(resolved.scriptPath, "utf8");
    const workflow = resolved.plugin ? resolved.plugin.name : loadWorkflowScript(text, resolved.scriptPath).meta.name;
    return { workflow, sourceHash: sourceHash(text), store };
  } catch (err) {
    // A workflow known only from its runs (its file gone, or elsewhere): by its name.
    if (/[\\/]/.test(ref) || /\.[cm]?js$/.test(ref)) throw err;
    return { workflow: ref, sourceHash: null, store, unresolved: err instanceof Error ? err.message : String(err) };
  }
}

/** The estimate of `ref`'s next run (with `args`, when given). */
export function estimateRef(
  ref: string,
  flags: { config?: string | null; runsRoot?: string | null; source?: string | null },
  args?: unknown,
): WorkflowEstimate {
  const id = workflowIdentity(ref, flags);
  const est = loadEstimate(id.store, { workflow: id.workflow, sourceHash: id.sourceHash, ...(args !== undefined ? { args } : {}) });
  if (id.unresolved) est.notes.push(`could not read the workflow (${sanitizeText(id.unresolved, 200)}): estimated by its name alone`);
  return est;
}

/** `odw estimate <wf> [--args JSON|@file] [--json]`. Exit 0 once estimated — without history too. */
export function cmdEstimate(rest: string[], parseArgsValue: (raw: string | undefined) => unknown): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      args: { type: "string" },
      json: { type: "boolean" },
      config: { type: "string" },
      "runs-root": { type: "string" },
      source: { type: "string" },
    },
  });
  const [ref, extra] = positionals;
  if (!ref || extra !== undefined) {
    process.stderr.write("usage: odw estimate <script.js|name> [--args JSON|@file] [--json]\n");
    return 2;
  }
  const args = values.args === undefined ? undefined : parseArgsValue(values.args);
  const est = estimateRef(ref, { config: values.config, runsRoot: values["runs-root"], source: values.source }, args);
  if (values.json) {
    process.stdout.write(JSON.stringify(est, null, 2) + "\n");
    return 0;
  }
  printEstimate(est, process.stdout);
  return 0;
}

/**
 * `odw run --estimate [--yes]`: print the estimate on stderr, then ask on a
 * terminal whether to start. True: start the run.
 */
export async function estimateBeforeRun(
  ref: string,
  flags: { config?: string | null; runsRoot?: string | null; source?: string | null },
  args: unknown,
  yes: boolean,
  io: { input?: NodeJS.ReadableStream & { isTTY?: boolean }; err?: NodeJS.WritableStream & { isTTY?: boolean } } = {},
): Promise<boolean> {
  const input = io.input ?? process.stdin;
  const err = io.err ?? process.stderr;
  printEstimate(estimateRef(ref, flags, args), err);
  if (yes) return true;
  if (input.isTTY !== true || err.isTTY !== true) {
    err.write("odw run --estimate: no terminal to ask on — pass --yes to start it after the estimate\n");
    return false;
  }
  const go = await askYesNo("start the run? [y/N] ", input, err);
  if (!go) err.write("not started\n");
  return go;
}

/** Ask a yes/no question; anything but y or yes — Enter, EOF, Ctrl-C — is no. */
export function askYesNo(question: string, input: NodeJS.ReadableStream, err: NodeJS.WritableStream): Promise<boolean> {
  return new Promise<boolean>((done) => {
    const rl = createInterface({ input, output: err });
    let answered = false;
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (!answered) done(false);
    });
    rl.question(question, (answer) => {
      answered = true;
      done(/^\s*y(es)?\s*$/i.test(answer));
      rl.close();
    });
  });
}

function printEstimate(est: WorkflowEstimate, out: NodeJS.WritableStream & { isTTY?: boolean; columns?: number }): void {
  const caps = detectCaps(out, process.env);
  const width = Math.min(120, out.isTTY && out.columns ? out.columns : 120);
  for (const line of formatEstimate(est, { width, caps })) out.write(line + "\n");
}
