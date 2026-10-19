/**
 * `odw outcomes` (an ODW extension; see ./outcomes): what became of the work
 * runs did, across runs and weeks — kept diffs applied, dismissed or left,
 * failures by reason, rework, and spend per applied change — per workflow,
 * adapter and model, against the window before.
 *
 *   odw outcomes [--since 30d] [--workflow W] [--json | --markdown] [--config P] [--runs-root DIR]
 *
 * `--since` takes `90m`, `12h`, `30d` or `4w` (default 30d; at most 156w). Read only: it
 * never writes a mark or a file. Exit 0; 2 on a usage error.
 */

import { parseArgs } from "node:util";

import { loadConfig, resolveRunsRoot } from "../adapters/config.js";
import { detectCaps } from "../tty.js";
import { parseSince, sinceTooLong } from "./digest-cli.js";
import { collectOutcomes, formatOutcomes, outcomesMarkdown } from "./outcomes.js";
import { RunStore } from "./run-store.js";

const USAGE = "usage: odw outcomes [--since 30d] [--workflow W] [--json | --markdown] [--config P] [--runs-root DIR]";

/** The window without --since: thirty days. */
export const OUTCOMES_DEFAULT_SECONDS = 30 * 86_400;

/** `odw outcomes …`; returns the exit code. */
export function cmdOutcomes(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      workflow: { type: "string" },
      json: { type: "boolean" },
      markdown: { type: "boolean" },
      config: { type: "string" },
      "runs-root": { type: "string" },
    },
  });
  if (positionals.length > 0) return usage(`odw outcomes: unexpected argument '${positionals[0]}'\n${USAGE}`);
  if (values.json && values.markdown) return usage(`odw outcomes: pick one of --json and --markdown\n${USAGE}`);
  let seconds = OUTCOMES_DEFAULT_SECONDS;
  if (values.since !== undefined) {
    const parsed = parseSince(values.since);
    if (parsed === null) return usage(`odw outcomes: --since takes an age like 12h, 30d or 4w; got ${JSON.stringify(values.since)}`);
    const tooLong = sinceTooLong(parsed);
    if (tooLong) return usage(`odw outcomes: --${tooLong}; got ${JSON.stringify(values.since)}`);
    seconds = parsed;
  }
  if (values.workflow !== undefined && values.workflow.trim() === "") return usage(`odw outcomes: --workflow needs a name\n${USAGE}`);
  const config = loadConfig(values.config ?? null, { quiet: true });
  const store = new RunStore(values["runs-root"] ?? resolveRunsRoot(config.settings.runsRoot));
  const until = Date.now() / 1000;
  const outcomes = collectOutcomes(store, { since: until - seconds, until, workflow: values.workflow ?? null });
  if (values.json) process.stdout.write(JSON.stringify(outcomes, null, 2) + "\n");
  else if (values.markdown) process.stdout.write(outcomesMarkdown(outcomes) + "\n");
  else process.stdout.write(formatOutcomes(outcomes, detectCaps(process.stdout, process.env)) + "\n");
  return 0;
}

function usage(text: string): number {
  process.stderr.write(`${text}\n`);
  return 2;
}
