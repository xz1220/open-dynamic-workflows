/**
 * Untrusted runs and the repository's own config (an ODW extension; see
 * adapters/trust.ts for what each CLI runs with).
 *
 * The config a run reads may be the repository's own: `./odw.config.json` in
 * the source directory, or any file inside the repository. Such a file is
 * code the repository ships, like its CLAUDE.md or its hooks, so in an
 * untrusted run:
 *
 *   - it cannot loosen the run: a run is untrusted when `--untrusted` says so,
 *     when the config in use does, or — when that config is the repository's
 *     own and so shadows the user's — when `~/.config/odw/config.json` does;
 *   - the `worktreeSetup` it sets does not run: a command the repository
 *     chose would run in every isolated agent's worktree. One the user's own
 *     config sets (`--config`, `$ODW_CONFIG`, `~/.config/odw/config.json`
 *     outside the repository) still runs;
 *   - the run says, once, that the config is the repository's — its adapters
 *     and other settings still apply — and how to use one of the user's own.
 *
 * `.worktreeinclude` is always the repository's: its `symlink:` lines are
 * refused where worktrees are prepared (see ./worktree-setup).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { homeDir, locateConfig } from "./adapters/config.js";
import { isTrustLevel } from "./adapters/trust.js";
import type { Config, TrustLevel } from "./adapters/types.js";

/** How a run's trust was decided, and what of the repository's config it refused. */
export interface RunTrust {
  trust: TrustLevel;
  /** What made it untrusted, for the run's log; null when trusted. */
  why: string | null;
  /** The config file in use when it lies inside the repository — the repository's own — else null. */
  repositoryConfig: string | null;
}

/** The repository `source` is in: its git top level, else `source` itself. */
export function repositoryRoot(source: string): string {
  try {
    const top = execFileSync("git", ["-C", source, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (top) return top;
  } catch {
    // not a repository (or no git): the directory is the whole of it
  }
  return resolve(source);
}

/**
 * The config file `loadConfig(configPath)` reads, searched from `cwd`, when
 * it lies inside the repository `source` is in; null when it does not, or
 * when there is none.
 */
export function repositoryConfig(configPath: string | null, source: string, cwd?: string): string | null {
  let located: string | null;
  try {
    located = locateConfig(configPath, cwd);
  } catch {
    return null; // a missing explicit file fails the load itself
  }
  if (!located) return null;
  return inside(repositoryRoot(source), resolve(cwd ?? process.cwd(), located)) ? located : null;
}

/** The `trust` the user's own `~/.config/odw/config.json` sets, when it sets a valid one. */
export function userConfigTrust(): TrustLevel | null {
  try {
    const raw = JSON.parse(readFileSync(join(homeDir(), ".config", "odw", "config.json"), "utf8")) as unknown;
    const trust = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).trust : undefined;
    return isTrustLevel(trust) ? trust : null;
  } catch {
    return null;
  }
}

/**
 * A run's trust: untrusted when `flag` (`--untrusted`, recorded in the run's
 * meta) says so, when `config` does, or when `config` is the repository's own
 * and the user's `~/.config/odw/config.json` — which it shadows — does.
 */
export function resolveRunTrust(opts: {
  flag: TrustLevel | null;
  config: Config;
  configPath: string | null;
  source: string;
  /** Where the config was searched from (the worker's cwd); default process.cwd(). */
  cwd?: string;
}): RunTrust {
  const repoConfig = repositoryConfig(opts.configPath, opts.source, opts.cwd);
  if (opts.flag === "untrusted") return { trust: "untrusted", why: "--untrusted", repositoryConfig: repoConfig };
  if (opts.config.settings.trust === "untrusted") {
    return { trust: "untrusted", why: `"trust": "untrusted" in the config`, repositoryConfig: repoConfig };
  }
  if (repoConfig && userConfigTrust() === "untrusted") {
    return {
      trust: "untrusted",
      why: `"trust": "untrusted" in ~/.config/odw/config.json, which the repository's own config cannot loosen`,
      repositoryConfig: repoConfig,
    };
  }
  return { trust: "trusted", why: null, repositoryConfig: repoConfig };
}

/**
 * `config` as an untrusted run uses it — its trust set, and without the
 * `worktreeSetup` the repository's own config set — and what the run logs
 * about it, one line each. A trusted run's config is returned as it is.
 */
export function applyRunTrust(config: Config, run: RunTrust): { config: Config; notes: string[] } {
  const settings = { ...config.settings, trust: run.trust };
  if (run.trust !== "untrusted") return { config: { ...config, settings }, notes: [] };
  const notes = [
    `untrusted run (${run.why}): each agent CLI runs in its documented way of ignoring the repository's ` +
      `instructions, settings and hooks; what one cannot keep out is said below`,
  ];
  if (run.repositoryConfig) {
    if (settings.worktreeSetup) {
      notes.push(
        `untrusted run: not running the worktreeSetup that the repository's own config (${run.repositoryConfig}) sets — ` +
          `it is the repository's code; set worktreeSetup in a config of your own (--config) to run one`,
      );
      settings.worktreeSetup = null;
    }
    notes.push(
      `untrusted run: the config in use is the repository's own (${run.repositoryConfig}) — its adapters and other ` +
        `settings still apply; pass --config with a file of your own to keep them out`,
    );
  }
  return { config: { ...config, settings }, notes };
}

/** Whether `path` is `root` or lies under it, links resolved where they exist. */
function inside(root: string, path: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const rel = relative(real(root), real(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
