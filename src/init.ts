/**
 * `odw init` — detect agent CLIs, show their permission posture, set the default.
 *
 * Doctor and setup in one idempotent verb:
 *
 *   - always prints the adapter table (installed on PATH? default? permissions)
 *   - `--adapter <name>` persists a default without prompting — the path for
 *     agents, after asking their user which CLI to default to
 *   - at a real keyboard (and not `--check`) it offers a numbered pick
 *   - otherwise it is a pure report: exit 0 when a run would resolve an adapter
 *     today, exit 1 with a one-line fix when it would not
 *
 * `resolveAdapter()` itself never prompts — interactivity exists only behind
 * this explicit command, so the primary non-interactive caller (an AI agent's
 * shell) can never block on a hidden prompt. The doctor verdict is computed by
 * calling the resolver, never by re-deriving its rules, so the two can't drift.
 */

import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  defaultConfig,
  listAdapters,
  loadConfig,
  resolveAdapter,
  writeDefaultAdapter,
  type AdapterListing,
} from "./adapters/config.js";
import type { Config } from "./adapters/types.js";
import { envTruthy } from "./runtime/live-view.js";
import { detectCaps, glyphs, palette, type Glyphs, type Palette } from "./tty.js";

/** An unanswered prompt (a PTY harness with nobody home) must not wedge an install. */
const PROMPT_TIMEOUT_MS = 120_000;

export interface InitFlags {
  adapter?: string;
  check?: boolean;
  config?: string | null;
}

/** Streams/env injected for tests; production callers pass nothing. */
export interface InitIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  err: NodeJS.WritableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
}

export async function cmdInit(flags: InitFlags, io?: Partial<InitIO>): Promise<number> {
  const input = io?.input ?? process.stdin;
  const err = io?.err ?? process.stderr;
  const env = io?.env ?? process.env;

  if (flags.check && flags.adapter !== undefined) {
    err.write("odw init: --check and --adapter cannot be combined (--check never writes)\n");
    return 2;
  }

  // `--adapter --config <new file>` bootstraps a config that doesn't exist yet;
  // everywhere else a missing explicit path stays the hard error it always was.
  const bootstrapping =
    flags.adapter !== undefined && flags.config != null && !existsSync(flags.config);
  const config = bootstrapping ? defaultConfig() : loadConfig(flags.config ?? null);
  const caps = detectCaps(err, env);
  const p = palette(caps);
  const g = glyphs(caps);
  const rows = listAdapters(config);
  const installed = rows.filter((r) => r.installed);

  writeTable(rows, err, p, g);

  // The deterministic write path (what agents use, after asking their user).
  if (flags.adapter !== undefined) {
    const known = rows.find((r) => r.name === flags.adapter);
    if (!known) {
      err.write(
        `odw init: unknown adapter '${flags.adapter}'; available: ${rows.map((r) => r.name).join(", ")}\n`,
      );
      return 2;
    }
    if (!known.installed) {
      err.write(
        `odw init: '${flags.adapter}' is not on PATH — install it first, or pick an installed one` +
          `${installed.length ? ` (${installed.map((r) => r.name).join(", ")})` : ""}\n`,
      );
      return 1;
    }
    return persist(flags.adapter, flags.config ?? null, err, p, g);
  }

  const resolved = tryResolve(config);
  if (resolved) {
    // resolveAdapter honours an explicit default without checking PATH (the
    // spawn would fail with its own error) — but a doctor saying "no setup
    // needed" about a CLI that isn't there would be a false all-clear.
    const row = rows.find((r) => r.name === resolved);
    if (row && !row.installed) {
      err.write(
        `${p.err(g.fail)} defaultAdapter "${resolved}" is set but its CLI is not on PATH — ` +
          `install it, or re-pick${installed.length ? `: odw init --adapter ${installed[0]!.name}` : " after installing one"}\n`,
      );
      if (installed.length > 0 && interactive(flags, input, err, env)) {
        return promptAndPersist(installed, flags.config ?? null, input, err, p, g);
      }
      return 1;
    }
    err.write(`${p.ok(g.ok)} a run resolves to ${p.bold(resolved)} — no setup needed\n`);
    return 0;
  }

  if (installed.length === 0) {
    err.write(
      `${p.err(g.fail)} no agent CLI found on PATH — install one of the above first ` +
        `(e.g. claude or codex), then re-run 'odw init'\n`,
    );
    return 1;
  }

  // Several CLIs installed, no default. Prompt only at a real keyboard.
  if (interactive(flags, input, err, env)) {
    return promptAndPersist(installed, flags.config ?? null, input, err, p, g);
  }
  err.write(
    `${p.err(g.fail)} several agent CLIs are installed (${installed.map((r) => r.name).join(", ")}) and no default is set\n` +
      `  at a terminal:  odw init            (interactive pick)\n` +
      `  as an agent:    ask your user which CLI to default to, then run: odw init --adapter <name>\n`,
  );
  return 1;
}

// --- internals -----------------------------------------------------------------

function writeTable(
  rows: AdapterListing[],
  err: NodeJS.WritableStream,
  p: Palette,
  g: Glyphs,
): void {
  err.write(p.bold("agent CLIs odw can drive:") + "\n");
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const labelW = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    const mark = r.installed ? p.ok(g.ok) : p.dim(g.fail);
    const note = r.installed ? p.dim(r.permissionNote) : p.dim("not installed");
    const def = r.isDefault ? p.accent("  (default)") : "";
    err.write(`  ${mark} ${r.name.padEnd(nameW)}  ${r.label.padEnd(labelW)}  ${note}${def}\n`);
  }
  err.write("\n");
}

/** Would `resolveAdapter` succeed today? Asks the resolver itself. */
function tryResolve(config: Config): string | null {
  try {
    return resolveAdapter(config).name;
  } catch {
    return null;
  }
}

/**
 * A prompt is offered only when BOTH ends are a real terminal, the terminal is
 * sane, and no automation marker is set — the same convention as the run
 * live-view gate, so "odw never prompts your shell" stays one rule.
 */
function interactive(
  flags: InitFlags,
  input: { isTTY?: boolean },
  err: { isTTY?: boolean },
  env: Record<string, string | undefined>,
): boolean {
  if (flags.check) return false;
  // Windows consoles commonly omit TERM, but an explicit dumb terminal still
  // means automation and must never prompt.
  const termOk =
    env.TERM === undefined ? process.platform === "win32" : env.TERM !== "dumb";
  return (
    input.isTTY === true &&
    err.isTTY === true &&
    termOk &&
    !envTruthy(env.CI) &&
    !envTruthy(env.ODW_DETACH)
  );
}

async function promptAndPersist(
  installed: AdapterListing[],
  configPath: string | null,
  input: NodeJS.ReadableStream,
  err: NodeJS.WritableStream,
  p: Palette,
  g: Glyphs,
): Promise<number> {
  for (const [i, r] of installed.entries()) {
    err.write(`  ${p.bold(String(i + 1))}) ${r.name}  ${p.dim(r.permissionNote)}\n`);
  }
  let aborted = false;
  let timedOut = false;
  const answer = await new Promise<string | null>((resolve) => {
    const rl = createInterface({ input, output: err });
    const timer = setTimeout(() => {
      timedOut = true;
      rl.close();
    }, PROMPT_TIMEOUT_MS);
    timer.unref?.();
    rl.on("SIGINT", () => {
      aborted = true;
      rl.close();
    });
    rl.on("close", () => {
      clearTimeout(timer);
      resolve(null); // EOF/abort/timeout; a real answer resolved first
    });
    rl.question(
      `pick a default agent [1-${installed.length}, Enter to skip]: `,
      (a) => {
        clearTimeout(timer);
        resolve(a); // before close() — its 'close' event may fire synchronously
        rl.close();
      },
    );
  });
  if (aborted) {
    err.write("\naborted — nothing written\n");
    return 130;
  }
  if (timedOut) {
    err.write(
      `\nno answer after ${PROMPT_TIMEOUT_MS / 1000}s — skipped; ` +
        `run 'odw init' again, or non-interactively: odw init --adapter <name>\n`,
    );
    return 1;
  }
  const trimmed = (answer ?? "").trim();
  if (trimmed === "") {
    err.write(
      `skipped — nothing written (workflows can still name adapters per call, ` +
        `or run 'odw init' again later)\n`,
    );
    return 1;
  }
  const idx = Number(trimmed);
  if (!Number.isInteger(idx) || idx < 1 || idx > installed.length) {
    err.write(`'${trimmed}' is not in 1-${installed.length} — nothing written\n`);
    return 1;
  }
  return persist(installed[idx - 1]!.name, configPath, err, p, g);
}

function persist(
  name: string,
  configPath: string | null,
  err: NodeJS.WritableStream,
  p: Palette,
  g: Glyphs,
): number {
  const written = writeDefaultAdapter(name, configPath);
  err.write(`${p.ok(g.ok)} wrote defaultAdapter "${name}" → ${written.path}\n`);
  if (written.shadowWarning) {
    err.write(`  ${p.err("warning:")} ${written.shadowWarning}\n`);
  }
  err.write(p.dim(`  check it: odw doctor --smoke   (one real prompt to ${name})`) + "\n");
  err.write(p.dim("  then try: odw run <workflow.js>") + "\n");
  return 0;
}
