/**
 * An isolated agent's slot (an ODW extension): a stable name for what it runs
 * beside its worktree — a compose project, a database, a volume prefix.
 *
 * Every agent call with `isolation: "worktree"` gets `ODW_SLOT`, the same for
 * each CLI run of the call and for its `worktreeSetup` and `worktreeTeardown`:
 * `odw-<run>-<agent>`, where `<run>` is the run id's random part (the last six
 * hex digits of `20261018-093012-a1b2c3`) and `<agent>` its agent id. Only
 * lowercase letters, digits and hyphens, starting with a letter — a valid
 * compose project name, and a database or volume name once quoted, or with
 * the hyphens swapped for underscores.
 *
 * `COMPOSE_PROJECT_NAME` is set to it, so `docker compose up` in a worktree
 * starts that agent's own stack — even when the user set one: kept, every
 * agent would share the user's stack, and a teardown's `down -v` would remove
 * it (the run logs, once, that it was overridden). One inherited from another
 * run's agent (a worker started by an agent) is that agent's slot: for an
 * agent without a slot it is dropped.
 */

/** `odw-` and a lowercase name: what {@link slotName} makes, and `odw gc` looks for in compose projects. */
export const SLOT_PREFIX = "odw-";

/** The run id ODW makes: `YYYYMMDD-HHMMSS-<6 hex>`. */
const RUN_ID_PARTS = /^\d{8}-\d{6}-([0-9a-f]{6})$/;

/** The part of `runId` a slot carries: its random suffix, or (another id's form) its last characters, lowercased. */
export function runSlotPart(runId: string | undefined): string {
  if (runId === undefined) return `p${process.pid}`;
  const m = RUN_ID_PARTS.exec(runId);
  if (m) return m[1]!;
  const tidy = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return tidy.slice(-12).replace(/^-+/, "") || "run";
}

/** `ODW_SLOT` for agent `agentId` of run `runId` (outside a run, the process stands in for it). */
export function slotName(runId: string | undefined, agentId: number | string | undefined): string {
  const agent = agentId === undefined ? "0" : String(agentId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "0";
  return `${SLOT_PREFIX}${runSlotPart(runId)}-${agent}`;
}

/**
 * `base` with `COMPOSE_PROJECT_NAME` set to `slot` — whatever was there — or,
 * without a slot, without the one an agent's slot left there. `onOverride` is
 * told a value of the user's that the slot replaced. A copy; `base` is not
 * changed.
 */
export function withSlot(
  base: Record<string, string | undefined>,
  slot: string | undefined,
  onOverride?: (userValue: string) => void,
): Record<string, string | undefined> {
  const env = { ...base };
  const inherited = env.ODW_SLOT !== undefined && env.COMPOSE_PROJECT_NAME === env.ODW_SLOT;
  if (slot !== undefined) {
    const user = env.COMPOSE_PROJECT_NAME;
    if (user && !inherited && user !== slot) onOverride?.(user);
    env.COMPOSE_PROJECT_NAME = slot;
  } else if (inherited) {
    delete env.COMPOSE_PROJECT_NAME;
  }
  return env;
}
