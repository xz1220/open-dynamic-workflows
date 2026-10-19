/**
 * `odw run <wf> --help` (an ODW extension): what a workflow takes as `args`,
 * from its `meta.input` (see ./input-schema), before anything runs. The
 * workflow is resolved as `odw run` would and compiled, never run.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "./adapters/config.js";
import { describeInput } from "./input-schema.js";
import { loadWorkflowScript } from "./loader.js";
import { sanitizeText } from "./tty.js";
import { resolveWorkflow } from "./workflows/resolve.js";

/** The help text for `odw run <ref> --help`, as lines. Throws when the workflow does not resolve or load. */
export function runHelpLines(ref: string, opts: { config: string | null; source: string | null }): string[] {
  const cwd = opts.source ? resolve(opts.source) : process.cwd();
  const { scriptPath } = resolveWorkflow(ref, { cwd, config: loadConfig(opts.config, { quiet: true, cwd }) });
  const { meta } = loadWorkflowScript(readFileSync(scriptPath, "utf8"), scriptPath);
  const out = [`usage: odw run ${ref} [--args JSON|@file] [run options — odw --help]`, "", `${meta.name} — ${meta.description}`];
  if (meta.whenToUse) out.push(`when to use: ${meta.whenToUse}`);
  out.push("");
  if (meta.input === undefined) {
    out.push("args: not declared (no meta.input) — whatever --args holds reaches the script unchecked");
  } else {
    out.push("args (meta.input, checked before the run starts):");
    for (const line of describeInput(meta.input)) out.push(`  ${line}`);
  }
  // The script's own words reach the terminal as text: no escape sequence (OSC 52 writes the clipboard), no control character.
  return out.map(shown);
}

/** A line without escapes or control characters, its indentation kept. */
function shown(line: string): string {
  const indent = /^ */.exec(line)![0];
  return indent + sanitizeText(line.slice(indent.length), 2000);
}
