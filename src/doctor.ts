/**
 * `odw doctor` — is this machine ready to run workflows?
 *
 * A checklist, cheapest first: the Node runtime, the config file, the run
 * directory, the workflow directories, and every configured adapter (installed?
 * answers `--version`?). With `--smoke` it goes one step further and sends a
 * real one-line prompt through the same bridge a workflow uses — the only way
 * to learn that a CLI which installs fine still blocks on an approval prompt,
 * needs a login, or exits 0 without answering when run headless. That costs a
 * model call, so it is opt-in.
 *
 * Reporting only: nothing here touches config, runs or adapters (the run
 * directory is created if missing, exactly as the first run would).
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  listAdapters,
  resolveClaudeWorkflowsRoot,
  resolveRunsRoot,
  resolveWorkflowsRoot,
} from "./adapters/config.js";
import { runCommand, type CommandRunner } from "./adapters/runner.js";
import type { Config, PermissionTier } from "./adapters/types.js";
import { Bridge } from "./bridge.js";
import { redactorFor, type RedactionCoverage } from "./redact.js";
import { describeConcurrency } from "./throttle.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warn/fail. */
  hint?: string;
  /** Adapter checks: the permission tiers it declares flags for (ODW extension). */
  tiers?: PermissionTier[];
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /** The loaded config, or the error that loading it raised. */
  config: Config | Error;
  configPath: string | null;
  /** Project directory (workflow lookup + smoke-test workspace). */
  cwd: string;
  /** Adapters to smoke-test with a real prompt; empty = none. */
  smoke: string[];
  /** Seconds per smoke prompt. */
  smokeTimeout?: number;
  runner?: CommandRunner;
  nodeVersion?: string;
  /** The environment runs would start agents with; defaults to this process's. */
  env?: Record<string, string | undefined>;
}

/** The marker a smoke prompt asks for — unlikely to appear by accident. */
export const SMOKE_TOKEN = "ODW_DOCTOR_OK";

const MIN_NODE_MAJOR = 20;

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);
  const runner = opts.runner ?? runCommand;

  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);
  add({
    id: "node",
    title: "Node.js runtime",
    status: major >= MIN_NODE_MAJOR ? "ok" : "fail",
    detail: `v${nodeVersion} on ${process.platform}-${process.arch}`,
    hint: major >= MIN_NODE_MAJOR ? undefined : `odw needs Node ${MIN_NODE_MAJOR} or newer`,
  });

  if (opts.config instanceof Error) {
    add({
      id: "config",
      title: "Config",
      status: "fail",
      detail: opts.config.message,
      hint: "fix the file above, or move it aside to fall back to the built-in defaults",
    });
    return { ok: false, checks };
  }
  const config = opts.config;
  add({ id: "config", title: "Config", status: "ok", detail: opts.configPath ?? "built-in defaults" });

  const runsRoot = resolveRunsRoot(config.settings.runsRoot);
  try {
    mkdirSync(runsRoot, { recursive: true });
    const probe = join(runsRoot, `.odw-doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    add({ id: "runs-root", title: "Run directory", status: "ok", detail: runsRoot });
  } catch (err) {
    add({
      id: "runs-root",
      title: "Run directory",
      status: "fail",
      detail: `${runsRoot}: ${(err as Error).message}`,
      hint: "set runsRoot in your config (or --runs-root) to a writable directory",
    });
  }

  const roots = [
    join(opts.cwd, ".odw", "workflows"),
    join(opts.cwd, ".claude", "workflows"),
    resolveWorkflowsRoot(config.settings.workflowsRoot),
    resolveClaudeWorkflowsRoot(config.settings.claudeWorkflowsRoot),
  ];
  const present = roots.filter((r) => existsSync(r));
  add({
    id: "workflow-dirs",
    title: "Workflow directories",
    status: "ok",
    detail: present.length ? present.join(", ") : "none yet — `odw run <file.js>` still works",
  });

  const listing = listAdapters(config);
  const installed = listing.filter((a) => a.installed);
  const def = config.settings.defaultAdapter;
  const defListing = def ? listing.find((a) => a.name === def) : undefined;
  add({
    id: "default-adapter",
    title: "Default adapter",
    status: !def ? "warn" : defListing?.installed ? "ok" : "fail",
    detail: !def
      ? `not set (${installed.length} installed: ${installed.map((a) => a.name).join(", ") || "none"})`
      : defListing
        ? `${def}${defListing.installed ? "" : " — not found on PATH"}`
        : `${def} — not a configured adapter`,
    hint: !def
      ? "run `odw init` to pick one, or pass --adapter; bare agent() calls need it"
      : defListing?.installed
        ? undefined
        : "install that CLI, or run `odw init` to choose an installed one",
  });

  // The caps a run's agents get, per adapter too, and how rate limits and fan-outs move them (ODW extensions).
  add({ id: "concurrency", title: "Concurrency", status: "ok", detail: describeConcurrency(config, { details: true }) });

  // Whether what runs keep and serve has its likely secrets redacted (ODW extension; see ./redact).
  add(redactionCheck(redactorFor(config, opts.env ?? process.env).coverage));

  for (const a of listing) {
    // The permission tiers it can run (ODW extension): `odw run --permissions`
    // refuses read on an adapter without it, and runs full as edit.
    const tiers = a.tiers.length > 0 ? `tiers: ${a.tiers.join(", ")}` : "tiers: none declared (runs as configured)";
    if (!a.installed) {
      add({ id: `adapter:${a.name}`, title: `Adapter ${a.name}`, status: "skip", detail: `not installed · ${tiers}`, tiers: a.tiers });
      continue;
    }
    const exe = config.adapters[a.name]!.command[0]!;
    const res = await runner([exe, "--version"], { timeout: 15 });
    const line = (res.stdout || res.stderr).trim().split("\n")[0]?.slice(0, 80) ?? "";
    add({
      id: `adapter:${a.name}`,
      title: `Adapter ${a.name}`,
      status: res.returncode === 0 ? "ok" : "warn",
      detail: `${res.returncode === 0 ? line || "installed" : `\`${exe} --version\` exited ${res.returncode}`} · ${a.permissionNote} · ${tiers}`,
      hint: res.returncode === 0 ? undefined : "the CLI is on PATH but did not answer --version; try running it once by hand",
      tiers: a.tiers,
    });
  }

  for (const name of opts.smoke) {
    const listingFor = listing.find((a) => a.name === name);
    if (!listingFor) {
      add({ id: `smoke:${name}`, title: `Smoke ${name}`, status: "fail", detail: "not a configured adapter" });
      continue;
    }
    if (!listingFor.installed) {
      add({ id: `smoke:${name}`, title: `Smoke ${name}`, status: "skip", detail: "not installed" });
      continue;
    }
    // One try: a smoke check reports a rate limit, it does not wait one out.
    const smokeConfig: Config = {
      ...config,
      settings: { ...config.settings, timeout: opts.smokeTimeout ?? 180, schemaRetries: 0, transientRetries: 0 },
    };
    const bridge = new Bridge(smokeConfig, { source: opts.cwd, runner });
    const started = Date.now();
    try {
      const outcome = await bridge.run({
        prompt: `This is a connectivity check. Reply with exactly ${SMOKE_TOKEN} and nothing else. Do not use any tools.`,
        adapter: name,
        label: "doctor",
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const text = String(outcome.text ?? "");
      const answered = text.includes(SMOKE_TOKEN);
      add({
        id: `smoke:${name}`,
        title: `Smoke ${name}`,
        status: answered ? "ok" : "fail",
        detail: answered
          ? `answered headless in ${secs}s`
          : `exited cleanly but did not answer (${JSON.stringify(text.trim().slice(0, 80))})`,
        hint: answered
          ? undefined
          : "a CLI that exits 0 without answering usually needs a login, a trust prompt, or an approval mode for headless use",
      });
    } catch (err) {
      add({
        id: `smoke:${name}`,
        title: `Smoke ${name}`,
        status: "fail",
        detail: (err as Error).message.split("\n")[0]!.slice(0, 160),
        hint: "run the adapter's command by hand in this directory to see what it is waiting for",
      });
    }
  }

  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

/** Variables the redaction check names before it says how many more. */
const VARIABLES_SHOWN = 5;

/**
 * The redaction check (ODW extension): what is redacted from what runs keep
 * and serve — or, with `redact: false` (or every part of it off), a warning.
 */
export function redactionCheck(coverage: RedactionCoverage): DoctorCheck {
  const check = { id: "redaction", title: "Redaction" };
  const parts: string[] = [];
  if (coverage.env) {
    const names = coverage.variables;
    const shown = names.slice(0, VARIABLES_SHOWN).join(", ");
    const more = names.length > VARIABLES_SHOWN ? `, and ${names.length - VARIABLES_SHOWN} more` : "";
    parts.push(
      names.length === 0
        ? "NAME=value of secret-looking names (no secret-named variable in this environment)"
        : `the values of ${names.length} secret-named variable${names.length === 1 ? "" : "s"} (${shown}${more}), NAME=value of secret-looking names`,
    );
  }
  if (coverage.patterns) parts.push("token shapes");
  if (coverage.extra > 0) parts.push(`${coverage.extra} extra pattern${coverage.extra === 1 ? "" : "s"}`);
  if (coverage.off || parts.length === 0) {
    return {
      ...check,
      status: "warn",
      detail: coverage.off ? 'off ("redact": false)' : "nothing to look for (redact.env and redact.patterns are false, no extra)",
      hint: `secrets agents print are kept and served in clear — ${
        coverage.off ? 'remove "redact": false from the config' : 'set "redact.env" or "redact.patterns" back to true'
      }`,
    };
  }
  return { ...check, status: "ok", detail: `on — ${parts.join(", ")}` };
}
