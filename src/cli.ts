#!/usr/bin/env node
/**
 * Command-line front end (L6).
 *
 * `odw` starts runs and observes them. It is a thin client over the run
 * directory: `run` launches a background worker; everything else reads or pokes
 * the run directory. Run state lives on disk, so the CLI and worker stay fully
 * decoupled.
 *
 * Commands (most are wired up in M4/M5):
 *   odw run <script.js> [--args JSON|@file] [--wait]
 *   odw list
 *   odw status <run_id>
 *   odw logs <run_id> [--follow]
 *   odw result <run_id>
 *   odw pause|resume|stop <run_id>
 */

import { pathToFileURL } from "node:url";
import { VERSION } from "./index.js";

export const COMMANDS = [
  "run",
  "list",
  "status",
  "logs",
  "result",
  "pause",
  "resume",
  "stop",
] as const;

export type Command = (typeof COMMANDS)[number];

export function versionText(): string {
  return `open-dynamic-workflows ${VERSION}`;
}

export function helpText(): string {
  return [
    `odw — Open Dynamic Workflows (v${VERSION})`,
    "Run Claude Code-format dynamic-workflow scripts against any coding-agent CLI.",
    "",
    "Usage:",
    "  odw run <script.js> [--args JSON|@file] [--wait]   start a workflow (background)",
    "  odw status <run_id>                                show a run's current state",
    "  odw logs <run_id> [--follow]                       print a run's progress events",
    "  odw result <run_id>                                print a finished run's result",
    "  odw list                                           list known runs",
    "  odw pause|resume|stop <run_id>                     control a running workflow",
    "",
    "Options:",
    "  -h, --help       show this help",
    "  -v, --version    show the version",
  ].join("\n");
}

/** Parse and dispatch a CLI invocation. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(helpText() + "\n");
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(versionText() + "\n");
    return 0;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    process.stderr.write(`odw: unknown command '${command}'\n\n`);
    process.stderr.write(helpText() + "\n");
    return 2;
  }

  // Commands land in M4 (runtime + CLI) and M5 (end-to-end). Until then, fail
  // loudly rather than pretending to do work.
  void rest;
  process.stderr.write(
    `odw: '${command}' is not wired up yet — the runtime lands in milestone M4/M5.\n`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
