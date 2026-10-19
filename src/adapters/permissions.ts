/**
 * Permission tiers (an ODW extension): read < edit < full.
 *
 * A run has a tier (`permissions` in the config, `odw run --permissions`); an
 * adapter's own `permissions` and an agent() call's `permissions` may only
 * lower it, so an agent's tier is the lowest of the three. A call that asks
 * for more than that is an error naming both tiers — never a silent downgrade.
 *
 * Each CLI's flags for a tier come from its `permissionArgs` and replace the
 * `{permission_args}` element of its command. A tier the adapter declares no
 * flags for is one ODW cannot trust the CLI to enforce headless: an agent that
 * asks such an adapter for `read` fails before its CLI starts; one that asks
 * for `full` runs with the adapter's `edit` flags, and the run says so once
 * per adapter. An adapter with no `permissionArgs` at all (a user's own CLI)
 * runs as configured, treated as `edit`, and any other tier is logged the same
 * way. An ACP agent (`"protocol": "acp"`) runs every tier: ODW answers each
 * permission request it makes by its tier (see ./acp).
 */

import type { Adapter, Config, PermissionArgs, PermissionTier } from "./types.js";

/** The tiers, strictest first. */
export const PERMISSION_TIERS: readonly PermissionTier[] = ["read", "edit", "full"];

/** The command element a tier's flags replace. */
export const PERMISSION_ARGS_TOKEN = "{permission_args}";

export function isPermissionTier(value: unknown): value is PermissionTier {
  return typeof value === "string" && (PERMISSION_TIERS as readonly string[]).includes(value);
}

const rank = (tier: PermissionTier): number => PERMISSION_TIERS.indexOf(tier);

/** The stricter of two tiers. */
export function minTier(a: PermissionTier, b: PermissionTier): PermissionTier {
  return rank(a) <= rank(b) ? a : b;
}

/** `command` with its `{permission_args}` element replaced by `args` (a command without one is returned as is). */
export function spliceArgs(command: string[], args: string[]): string[] {
  const at = command.indexOf(PERMISSION_ARGS_TOKEN);
  return at === -1 ? [...command] : [...command.slice(0, at), ...args, ...command.slice(at + 1)];
}

/** The tiers an adapter declares flags for, strictest first; none for an adapter without `permissionArgs`. */
export function declaredTiers(adapter: Adapter): PermissionTier[] {
  // An ACP agent's tier is how ODW answers its permission requests (see ./acp): any.
  if (adapter.protocol === "acp") return [...PERMISSION_TIERS];
  const declared = adapter.permissionArgs;
  return declared ? PERMISSION_TIERS.filter((tier) => declared[tier] !== undefined) : [];
}

/** What one agent runs with, as decided by {@link planPermissions}. */
export interface PermissionPlan {
  /**
   * The tier the agent asked for: its call's `permissions`, else the lower of
   * the run's and its adapter's. Absent when the call's option is not a tier.
   */
  requested?: PermissionTier;
  /** The tier its CLI runs with; absent when it cannot run (see `error`). */
  tier?: PermissionTier;
  /** The flags that replace the command's `{permission_args}` element. */
  args: string[];
  /** The agent runs another tier than it asked for, or one ODW cannot enforce: the run logs it once per adapter. */
  note?: string;
  /** Why the agent cannot run at all: it fails before its CLI starts. */
  error?: string;
}

/**
 * Decide the tier an agent on `adapter` runs with, and its flags: the lowest
 * of the run's tier, the adapter's `permissions` and the call's `option`. An
 * option above the run's (or the adapter's) tier is an error, as is `read` on
 * an adapter with no read flags; `alternative` names an adapter that has
 * them, for that error's advice.
 */
export function planPermissions(
  adapter: Adapter,
  run: PermissionTier,
  option?: unknown,
  alternative?: string | null,
): PermissionPlan {
  if (option !== undefined && !isPermissionTier(option)) {
    return {
      args: [],
      error: `agent() option permissions must be "read", "edit" or "full"; got ${JSON.stringify(option) ?? String(option)}`,
    };
  }
  const ceiling = adapter.permissions !== undefined ? minTier(run, adapter.permissions) : run;
  if (option !== undefined && rank(option) > rank(ceiling)) {
    return { requested: option, args: [], error: escalation(adapter, run, option, ceiling) };
  }
  const requested = option ?? ceiling;
  const declared = adapter.permissionArgs;
  // An ACP agent (ODW extension; see ./acp) runs any tier: ODW answers its
  // permission requests by it — with the tier's own flags, where it declares them.
  if (adapter.protocol === "acp") return { requested, tier: requested, args: [...(declared?.[requested] ?? declared?.edit ?? [])] };
  if (!declared) {
    if (requested === "edit") return { requested, tier: "edit", args: [] };
    return {
      requested,
      tier: "edit",
      args: [],
      note:
        `adapter '${adapter.name}' declares no permissionArgs, so ODW cannot make it run "${requested}": ` +
        `its agents run with its command as configured (treated as "edit")`,
    };
  }
  const exact = declared[requested];
  if (exact) return { requested, tier: requested, args: [...exact] };
  if (requested === "read") return { requested, args: [], error: refusal(adapter, run, option, alternative) };
  // `full`, undeclared: the CLI's `edit` posture is the loosest it has.
  const flags = declared.edit.length > 0 ? ` (${declared.edit.join(" ")})` : "";
  return {
    requested,
    tier: "edit",
    args: [...declared.edit],
    note: `adapter '${adapter.name}' has no "full" mode: its agents run with its "edit" flags${flags}`,
  };
}

/** Why an agent may not have the tier it asked for: what caps it, and how to ask within it. */
function escalation(adapter: Adapter, run: PermissionTier, option: PermissionTier, ceiling: PermissionTier): string {
  const caps: string[] = [];
  const raise: string[] = [];
  if (rank(run) < rank(option)) {
    caps.push(`the run allows only "${run}"`);
    raise.push(`start the run with --permissions ${option}`);
  }
  if (adapter.permissions !== undefined && rank(adapter.permissions) < rank(option)) {
    caps.push(`adapter '${adapter.name}' is capped at "${adapter.permissions}" by its "permissions" setting`);
    raise.push(`raise that setting`);
  }
  return (
    `agent() asked for permissions "${option}", but ${caps.join(" and ")} ` +
    `(an agent may only lower its run's tier: read < edit < full) — ask for "${ceiling}" or less, or ${raise.join(" and ")}`
  );
}

/**
 * Why `adapter` cannot run an agent read-only, and what would let it run:
 * another adapter, or lifting every "read" that applies — the call's, the
 * adapter's own setting, the run's.
 */
function refusal(adapter: Adapter, run: PermissionTier, option: unknown, alternative?: string | null): string {
  const lift: string[] = [];
  if (option === "read") lift.push(`drop permissions: "read" from the agent() call`);
  if (adapter.permissions === "read") lift.push(`set "permissions": "edit" on adapter '${adapter.name}'`);
  if (run === "read") lift.push("run with --permissions edit");
  const other = alternative
    ? `use an adapter that can (--adapter ${alternative}, or agent(prompt, { adapter: "${alternative}" })), or `
    : "";
  return (
    `${adapter.name} cannot run read-only (adapter '${adapter.name}' declares no "read" permissionArgs); ` +
    `${other}${lift.join(" and ")}`
  );
}

/**
 * The adapter to suggest for a read-only agent `adapter` cannot run: the first
 * other adapter (by name) that declares read flags, preferring one whose CLI
 * `isInstalled`; null when none does.
 */
export function readCapableAdapter(config: Config, exclude: string, isInstalled: (adapter: Adapter) => boolean): string | null {
  const able = Object.keys(config.adapters)
    .sort()
    .filter((name) => name !== exclude && declaredTiers(config.adapters[name]!).includes("read"));
  return able.find((name) => isInstalled(config.adapters[name]!)) ?? able[0] ?? null;
}

/**
 * The start banner's permissions line: the run's tier, then the tier each
 * adapter `isInstalled` keeps runs with — why, where that differs from the
 * run's, and "refused" where it has no read mode. One line, for any terminal.
 */
export function permissionsBanner(config: Config, isInstalled: (adapter: Adapter) => boolean): string {
  const run = runTier(config);
  const parts = Object.keys(config.adapters)
    .sort()
    .filter((name) => isInstalled(config.adapters[name]!))
    .map((name) => {
      const adapter = config.adapters[name]!;
      const plan = planPermissions(adapter, run);
      if (plan.error) return `${name} refused (no read mode)`;
      if (plan.note && !adapter.permissionArgs) return `${name} as configured (no tiers declared)`;
      if (plan.note) return `${name} edit (no full mode)`;
      return plan.tier !== run ? `${name} ${plan.tier} (adapter setting)` : `${name} ${plan.tier}`;
    });
  return `permissions: ${run}${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
}

/** An adapter's argv template with the flags it runs with at `tier` in place (none where it cannot run). */
export function commandAt(adapter: Adapter, tier: PermissionTier): string[] {
  return spliceArgs(adapter.command, planPermissions(adapter, tier).args);
}

/** The run's tier from its settings ("edit" for settings that predate tiers). */
export function runTier(config: Config): PermissionTier {
  return isPermissionTier(config.settings.permissions) ? config.settings.permissions : "edit";
}

/** A deep copy of declared flags. */
export function copyPermissionArgs(declared: PermissionArgs): PermissionArgs {
  const out: PermissionArgs = { edit: [...declared.edit] };
  if (declared.read) out.read = [...declared.read];
  if (declared.full) out.full = [...declared.full];
  return out;
}
