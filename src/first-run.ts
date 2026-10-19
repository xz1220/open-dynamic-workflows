/**
 * The first useful run, for $0 (ODW extension): the steps `odw` with no
 * arguments and `odw doctor` show a new user — a template written, its
 * starter test, a dry run with every agent stubbed, the dashboard. None of
 * them calls a model. `odw init` offers the same run at a real keyboard.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { RunStore } from "./runtime/run-store.js";

export interface FirstRunStep {
  command: string;
  note: string;
}

/** The steps from here: `odw new hello` only while .odw/workflows/hello.js is not there yet. */
export function firstRunSteps(cwd: string): FirstRunStep[] {
  const steps: FirstRunStep[] = [];
  if (!existsSync(join(cwd, ".odw", "workflows", "hello.js"))) {
    steps.push({ command: "odw new hello", note: "writes .odw/workflows/hello.js and a starter test" });
  }
  steps.push(
    { command: "odw test hello", note: "its starter test: scripted replies, no model called" },
    { command: "odw run hello --dry", note: "the live view and the phase tree, every agent stubbed" },
    { command: "odw serve --open", note: "the dashboard: that run, and every run after it" },
  );
  return steps;
}

/** Whether the runs root holds no run yet — a new user, to whom the first-run steps are shown. */
export function noRunsYet(runsRoot: string): boolean {
  if (!existsSync(runsRoot)) return true;
  try {
    return new RunStore(runsRoot).listRunIds().length === 0;
  } catch {
    return false;
  }
}

/** The steps as aligned lines, each note through `dim`. */
export function formatSteps(steps: FirstRunStep[], dim: (s: string) => string = (s) => s): string[] {
  const width = Math.max(...steps.map((s) => s.command.length));
  return steps.map((s) => `  ${s.command.padEnd(width)}  ${dim(s.note)}`);
}

/**
 * What `odw` with no arguments prints for a new user: what odw is, the first
 * run for $0, then the setup and the real run — and where every command is.
 */
export function welcomeText(header: string, cwd: string): string {
  const then: FirstRunStep[] = [
    { command: "odw doctor", note: "is this machine ready: adapters, disk, open-file limit, git (no model called)" },
    { command: "odw init", note: "pick the agent CLI real runs use" },
    { command: "odw run hello", note: "the real run, on that CLI" },
  ];
  return [
    header,
    "",
    "Your first run costs nothing — no model is called:",
    ...formatSteps(firstRunSteps(cwd)),
    "",
    "Then:",
    ...formatSteps(then),
    "",
    "Every command: odw --help",
  ].join("\n");
}
