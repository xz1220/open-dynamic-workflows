/**
 * What ran (an ODW extension): the facts `odw compare` holds two runs to.
 *
 * A run left to itself says what it did, not what it ran with — so two runs
 * of one workflow give "neither reproducibility across runs nor comparability
 * across versions". Each run therefore records:
 *
 *   - each adapter CLI's version, once per run: on the adapter's first
 *     dispatch, `<cli> --version` (its command's first argv element) runs
 *     beside the agent, killed after {@link VERSION_TIMEOUT_SECONDS}, and lands
 *     as a `cli_version` event. It never delays or fails the run: a probe still
 *     running when the run ends is killed and records nothing, and a missing
 *     binary or a CLI that does not answer records an unknown version with
 *     why. An adapter whose command is node (or another interpreter) or a
 *     script is not probed: `--version` would name the interpreter, or run
 *     the script. `recordVersions: false` turns the probes off;
 *   - the settings that change what its agents do ({@link BEHAVIOUR_SETTINGS})
 *     and a fingerprint of each adapter's definition, as its `run_started`
 *     event's `setup` ({@link runSetup});
 *   - odw's version and the sha256 of the workflow source as launched, in its
 *     meta.json (`odwVersion`, `sourceHash`; see runtime/run-store).
 */

import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";

import { agentBaseEnv } from "./adapters/agent-env.js";
import { runCommand, type CommandRunner } from "./adapters/runner.js";
import type { Adapter, CliResult, Config, Settings } from "./adapters/types.js";
import { CLI_VERSION, event, type WorkflowEvent } from "./events.js";
import { stableJson } from "./journal.js";
import { sanitizeText } from "./tty.js";

/** Seconds a `<cli> --version` probe may take; then it is killed and the version recorded unknown. */
export const VERSION_TIMEOUT_SECONDS = 3;

/** Characters of a CLI's version line kept, and of why there is none. */
const VERSION_CHARS = 120;

/** Bytes a probe may print: a CLI that answers `--version` with more is not answering it. */
const VERSION_OUTPUT_BYTES = 64 * 1024;

/**
 * Interpreters and launchers: `<it> --version` names it, not the agent CLI it
 * starts (`node agent.mjs`, `npx some-cli`, `python3 agent.py`, `sh -c …`).
 */
const LAUNCHERS = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  "npx",
  "pnpx",
  "bunx",
  "npm",
  "pnpm",
  "yarn",
  "python",
  "py",
  "pypy",
  "uv",
  "uvx",
  "pipx",
  "ruby",
  "perl",
  "php",
  "java",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "env",
]);

/** An interpreter's versioned name: python3, python3.12, ruby3.3, node22. */
const VERSIONED_LAUNCHER = /^(?:python|pypy|ruby|perl|php|node)[\d.]*$/;

/** A script file: `<it> --version` would run it, not ask it. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|py|rb|pl|php|sh|bash|zsh|fish)$/i;

/**
 * The executable whose `--version` names an adapter's CLI — its command's
 * first argv element — or null when it is not probed: node or another
 * interpreter (by name, or the node running odw), a script file, a relative
 * path (a script of the project's), or a `{placeholder}`.
 */
export function versionProbe(adapter: Adapter, execPath: string = process.execPath): string | null {
  const exe = adapter.command[0];
  if (!exe || exe.includes("{") || exe === execPath) return null;
  const name = basename(exe.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
  if (LAUNCHERS.has(name) || VERSIONED_LAUNCHER.test(name)) return null;
  if (SCRIPT_FILE.test(exe)) return null;
  const path = /[\\/]/.test(exe);
  if (path && !isAbsolute(exe) && !/^[A-Za-z]:[\\/]/.test(exe)) return null;
  return exe;
}

/** What a probe found: the CLI's version line, or null and why there is none. */
export type VersionFinding = { version: string } | { version: null; error: string };

/**
 * What a `--version` probe found: the first line the CLI printed (stdout
 * first: a warning on stderr is not its version), or why there is none.
 */
export function versionOf(cli: CliResult, timeoutSeconds = VERSION_TIMEOUT_SECONDS): VersionFinding {
  if (cli.timedOut) return { version: null, error: `no answer within ${timeoutSeconds}s` };
  const said = firstLine(cli.stdout) ?? firstLine(cli.stderr);
  if (cli.returncode === 127 && /^failed to launch/.test(cli.stderr)) {
    return { version: null, error: /\bENOENT\b/.test(cli.stderr) ? "not found" : `could not start: ${said ?? ""}`.trim() };
  }
  if (cli.returncode !== 0) return { version: null, error: said ? `exited ${cli.returncode}: ${said}` : `exited ${cli.returncode}` };
  if (!said) return { version: null, error: "printed nothing" };
  return { version: said };
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const clean = sanitizeText(line, VERSION_CHARS);
    if (clean) return clean;
  }
  return null;
}

export interface CliVersionOptions {
  /** Where the `cli_version` events go: the run's sink. */
  emit: (ev: WorkflowEvent) => void;
  /** The run's settings: a probe gets the environment its adapter's agents get. */
  settings: Pick<Settings, "agentEnv" | "agentEnvPass">;
  /** Where probes run: the run's source directory. */
  cwd?: string;
  /** Test seams: what runs a probe, and how long it may take. */
  runner?: CommandRunner;
  timeoutSeconds?: number;
}

/**
 * Records each adapter CLI's version once per run (see the module comment):
 * told of every agent CLI run by {@link note}, and closed before the run's
 * terminal event — nothing may follow that in events.jsonl.
 */
export class CliVersions {
  /** Adapters already noted: each is probed at most once per run. */
  private readonly noted = new Set<string>();
  private readonly stop = new AbortController();
  private closed = false;
  private readonly runner: CommandRunner;
  private readonly timeout: number;

  constructor(private readonly opts: CliVersionOptions) {
    this.runner = opts.runner ?? runCommand;
    this.timeout = opts.timeoutSeconds ?? VERSION_TIMEOUT_SECONDS;
  }

  /**
   * An agent's CLI is about to run on `adapter`. The first time in the run,
   * its version is probed beside it — never awaited: the agent does not wait.
   */
  note(adapter: Adapter): void {
    if (this.closed || this.noted.has(adapter.name)) return;
    this.noted.add(adapter.name);
    const exe = versionProbe(adapter);
    if (!exe) return;
    const env = { ...agentBaseEnv(process.env, this.opts.settings), ...adapter.env } as Record<string, string>;
    let probe: Promise<CliResult>;
    try {
      probe = this.runner([exe, "--version"], {
        cwd: this.opts.cwd,
        env,
        timeout: this.timeout,
        maxOutputBytes: VERSION_OUTPUT_BYTES,
        signal: this.stop.signal,
      });
    } catch (err) {
      probe = Promise.reject(err);
    }
    probe.then(
      (cli) => this.record(adapter.name, exe, versionOf(cli, this.timeout)),
      (err: unknown) =>
        this.record(adapter.name, exe, {
          version: null,
          error: `could not start: ${sanitizeText(err instanceof Error ? err.message : String(err), VERSION_CHARS)}`,
        }),
    );
  }

  /** The run is ending: record nothing more, and kill the probes still running. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop.abort();
  }

  private record(adapter: string, command: string, found: VersionFinding): void {
    if (this.closed) return;
    try {
      this.opts.emit(event(CLI_VERSION, { adapter, command, ...found }));
    } catch {
      // Recording what ran never fails the run.
    }
  }
}

/** A `cli_version` event as read back: the adapter's CLI, and its version (null: unknown, and why). */
export interface CliVersion {
  /** The executable probed: the adapter command's first argv element. */
  command: string;
  version: string | null;
  error?: string;
}

/**
 * The CLI versions a run recorded, by adapter, from its events (untrusted
 * JSON: a malformed one is skipped); the last event for an adapter wins.
 */
export function cliVersionsOf(events: Iterable<WorkflowEvent>): Record<string, CliVersion> {
  const out: Record<string, CliVersion> = {};
  for (const ev of events) {
    const found = readCliVersion(ev);
    if (found) out[found.adapter] = found.cli;
  }
  return out;
}

/** One `cli_version` event's adapter and finding, or null for anything else. */
export function readCliVersion(ev: WorkflowEvent): { adapter: string; cli: CliVersion } | null {
  if (ev.type !== CLI_VERSION || typeof ev.adapter !== "string" || typeof ev.command !== "string") return null;
  const version = typeof ev.version === "string" ? ev.version : null;
  const cli: CliVersion = { command: ev.command, version };
  if (version === null && typeof ev.error === "string") cli.error = ev.error;
  return { adapter: ev.adapter, cli };
}

/**
 * The settings that change what a run's agents do, or how its outcome is
 * decided — what `odw compare` holds two runs' setups to. Settings about where
 * things are kept or how they are shown stay out (runsRoot, notify,
 * maxDiffBytes, redact, …), and so does anything that may hold a secret.
 */
export const BEHAVIOUR_SETTINGS = [
  "defaultAdapter",
  "permissions",
  "trust",
  "concurrency",
  "maxAgents",
  "timeout",
  "stallTimeout",
  "stallRestarts",
  "transientRetries",
  "maxBackoff",
  "schemaRetries",
  "worktreeSetup",
  "worktreeSetupTimeout",
  "adaptiveConcurrency",
  "staggerFanOut",
  "agentEnv",
  "agentEnvPass",
  "schemaKeywords",
  "schemaPrompt",
  "fallback",
  "handoff",
  "models",
  "quotaBreaker",
  "quotaWait",
  "expectRetries",
  "permissionDenials",
  "mcpFailures",
  "orphanedBackground",
  "scopePolicy",
  "sandbox",
  "notes",
  "memory",
  "agentLimits",
  "costGate",
] as const satisfies ReadonlyArray<keyof Settings>;

/** What a run started with (its `run_started` event's `setup`). */
export interface RunSetup {
  /** The {@link BEHAVIOUR_SETTINGS} as the run had them, its `--adapter` and `--permissions` applied. */
  settings: Record<string, unknown>;
  /** A fingerprint of each configured adapter's definition ({@link adapterFingerprint}), by name. */
  adapters: Record<string, string>;
}

/** The setup a run records as it starts. */
export function runSetup(config: Config): RunSetup {
  const settings: Record<string, unknown> = {};
  for (const key of BEHAVIOUR_SETTINGS) settings[key] = config.settings[key] ?? null;
  const adapters: Record<string, string> = {};
  for (const name of Object.keys(config.adapters).sort()) adapters[name] = adapterFingerprint(config.adapters[name]!);
  return { settings, adapters };
}

/**
 * 12 hex characters of the sha256 of an adapter's definition — its command,
 * flags, output, tiers, limits — that change when any of it does. Its `env`
 * goes in by name only (the values are often secrets), and its display label
 * not at all.
 */
export function adapterFingerprint(adapter: Adapter): string {
  const definition: Record<string, unknown> = { ...adapter, env: adapter.env ? Object.keys(adapter.env).sort() : undefined };
  delete definition.label;
  return createHash("sha256").update(stableJson(definition)).digest("hex").slice(0, 12);
}

/** The sha256 (hex) of a workflow's source text; null when there is none to hash. */
export function sourceHash(text: string | null | undefined): string | null {
  return typeof text === "string" ? createHash("sha256").update(text, "utf8").digest("hex") : null;
}
