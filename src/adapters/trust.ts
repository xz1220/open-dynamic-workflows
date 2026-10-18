/**
 * Trust levels (an ODW extension): trusted | untrusted.
 *
 * Running agents in someone else's repository is dangerous: its CLAUDE.md or
 * AGENTS.md steer the agent, and its hooks, MCP servers and project settings
 * run or configure it. A run has a trust level (`trust` in the config, `odw
 * run --untrusted`), default `trusted`; an adapter's own `trust: "untrusted"`
 * makes it untrusted in any run, and nothing loosens an untrusted run.
 *
 * An untrusted agent's CLI runs in its documented equivalent of "ignore this
 * repository's customizations": its `untrustedArgs`, added after its tier's
 * flags where its command has `{permission_args}` (Claude Code's
 * `--safe-mode`). Only flags a CLI's own docs confirm are filled in; a CLI
 * with none — or with some that leave part of the repository in — carries an
 * `untrustedNote` saying what still reaches the agent, and the run says it
 * once per adapter: an untrusted run never degrades silently. A user's
 * adapter without `untrustedArgs` is said to keep nothing out.
 *
 * The repository's own code that ODW itself would run — `.worktreeinclude`
 * links and a `worktreeSetup` from its config — is refused in an untrusted
 * run (see ../untrusted).
 */

import type { Adapter, Config, TrustLevel } from "./types.js";

/** The levels, loosest first. */
export const TRUST_LEVELS: readonly TrustLevel[] = ["trusted", "untrusted"];

export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value);
}

/** The run's trust level from its settings ("trusted" for settings that predate trust). */
export function runTrust(config: Config): TrustLevel {
  return config.settings.trust === "untrusted" ? "untrusted" : "trusted";
}

/** What one agent's CLI runs with, as decided by {@link planTrust}. */
export interface TrustPlan {
  /** The run's level, or `untrusted` when its adapter says so. */
  trust: TrustLevel;
  /** The flags added after its tier's at `{permission_args}`: none when trusted. */
  args: string[];
  /** Untrusted only: what of the repository still reaches the agent, for the run's log (once per adapter). */
  note?: string;
}

/** The trust an agent on `adapter` runs with in a run of `run` trust, and its flags. */
export function planTrust(adapter: Adapter, run: TrustLevel): TrustPlan {
  const trust: TrustLevel = run === "untrusted" || adapter.trust === "untrusted" ? "untrusted" : "trusted";
  if (trust === "trusted") return { trust, args: [] };
  const args = adapter.untrustedArgs ? [...adapter.untrustedArgs] : [];
  if (adapter.untrustedNote) return { trust, args, note: adapter.untrustedNote };
  if (!adapter.untrustedArgs) {
    return {
      trust,
      args,
      note:
        `adapter '${adapter.name}' declares no untrustedArgs, so ODW cannot keep the repository's instructions, ` +
        `settings and hooks from it — whatever its CLI reads from the repository still reaches the agent`,
    };
  }
  return { trust, args };
}

/** How an adapter runs untrusted, in a few words: its flags, and what they leave in. */
export function untrustedPosture(adapter: Adapter): string {
  const flags = adapter.untrustedArgs && adapter.untrustedArgs.length > 0 ? adapter.untrustedArgs.join(" ") : null;
  if (!adapter.untrustedNote && flags) return flags;
  if (!adapter.untrustedNote && !adapter.untrustedArgs) return "no way declared";
  return flags ? `${flags} (partial)` : "no documented way";
}

/**
 * The start banner's trust line: the run's level and, untrusted, how each
 * adapter `isInstalled` keeps the repository out — or that it cannot. One
 * line, for any terminal.
 */
export function trustBanner(config: Config, isInstalled: (adapter: Adapter) => boolean): string {
  const run = runTrust(config);
  const names = Object.keys(config.adapters)
    .sort()
    .filter((name) => isInstalled(config.adapters[name]!));
  const untrusted = names.filter((name) => planTrust(config.adapters[name]!, run).trust === "untrusted");
  if (untrusted.length === 0) return `trust: ${run}`;
  const parts = untrusted.map((name) => `${name} ${untrustedPosture(config.adapters[name]!)}`);
  const head = run === "untrusted" ? "trust: untrusted" : "trust: trusted (untrusted adapters)";
  return `${head} — ${parts.join(", ")}`;
}
