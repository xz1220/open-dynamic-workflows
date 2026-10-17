/**
 * Routing an agent() call (ODW extensions): which adapter it runs on, with
 * which model, and where it goes when that CLI cannot take it.
 *
 *   - Phase defaults: a `meta.phases` entry `{ title, adapter?, model? }`, or
 *     `phase(title, { adapter?, model? })`, gives the phase's agents the
 *     adapter and model they do not name themselves; an option the call sets
 *     always wins. A phase default is a default like the run's own: it stays
 *     out of the call's resume key (see ./journal).
 *   - Model tiers: `model: "@fast"` names a tier of the `models` setting, in
 *     which each adapter has a model id of its own; a call gets the id of the
 *     adapter it runs on — after a fallback, the next adapter's.
 *   - Fallback chains: an agent() call's `adapter` may list several adapters
 *     in order of preference, and the `fallback` setting gives each adapter
 *     the ones to try after it. The bridge walks the chain (Bridge.route):
 *     a call whose CLI's quota is spent or whose login is refused moves on to
 *     the next adapter, and the run's quota breaker takes an adapter whose
 *     quota failed `quotaBreaker` times in a row out of the run.
 */

import type { Adapter, Settings } from "./adapters/types.js";
import { AgentError, WorkflowScriptError } from "./errors.js";

/** An agent() call's `adapter`: an adapter's name or — an ODW extension — a list of them, in order of preference. */
export type AdapterChoice = string | string[];

/** What a phase gives the agents in it that do not say themselves (an ODW extension). */
export interface PhaseDefaults {
  adapter?: AdapterChoice;
  model?: string;
}

/** The options phase(title, opts) takes. */
const PHASE_OPTIONS = ["adapter", "model"];

/**
 * The defaults a `meta.phases` entry, or a phase() call's options, give a
 * phase — validated: `adapter` is an adapter's name or a non-empty list of
 * them, `model` a model id or a tier (`"@fast"`). `where` names the source in
 * an error. A meta entry's other fields (`title`, `detail`) are its own;
 * phase() options are `strict`: they take these two only.
 */
export function phaseDefaultsOf(raw: unknown, where: string, opts: { strict?: boolean } = {}): PhaseDefaults {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowScriptError(`${where} must be an object: { adapter?, model? }; got ${describe(raw)}`);
  }
  const fields = raw as Record<string, unknown>;
  const unknown = opts.strict ? Object.keys(fields).filter((key) => !PHASE_OPTIONS.includes(key)) : [];
  if (unknown.length > 0) {
    throw new WorkflowScriptError(`${where} takes adapter and model only; got ${unknown.map((key) => JSON.stringify(key)).join(", ")}`);
  }
  const defaults: PhaseDefaults = {};
  if (fields.adapter != null) {
    if (!isAdapterChoice(fields.adapter)) {
      throw new WorkflowScriptError(
        `${where}.adapter must be an adapter name or a non-empty list of them; got ${describe(fields.adapter)}`,
      );
    }
    defaults.adapter = Array.isArray(fields.adapter) ? [...fields.adapter] : fields.adapter;
  }
  if (fields.model != null) {
    if (typeof fields.model !== "string" || fields.model === "") {
      throw new WorkflowScriptError(`${where}.model must be a model id or a tier such as "@fast"; got ${describe(fields.model)}`);
    }
    defaults.model = fields.model;
  }
  return defaults;
}

/** An adapter's name, or a non-empty list of them. */
export function isAdapterChoice(value: unknown): value is AdapterChoice {
  const name = (v: unknown): boolean => typeof v === "string" && v !== "";
  return name(value) || (Array.isArray(value) && value.length > 0 && value.every(name));
}

/** The adapter a choice names first — the one the call asks for, as its label. */
export function firstAdapter(choice: unknown): string | undefined {
  const first = Array.isArray(choice) ? choice[0] : choice;
  return typeof first === "string" ? first : undefined;
}

// --- model tiers -------------------------------------------------------------------

/** A tier's name in the `models` setting: what follows the `@` of `model: "@fast"`. */
export const TIER_NAME = /^[\w.-]+$/;

/** A model naming a tier: `@` and a tier name. Anything else — `"@cf/…"` included — is a model id. */
const TIER_REF = /^@([\w.-]+)$/;

/**
 * The model id a call runs `adapter` with: `model` as it is, or — for a tier
 * (`"@fast"`) — that adapter's id in `settings.models`. A tier without one for
 * the adapter leaves its CLI's own default model, and `notes` says so. An
 * unknown tier is an AgentError naming the tiers there are.
 */
export function resolveModel(
  model: string | undefined,
  adapter: Adapter,
  settings: Settings,
  notes: string[],
): string | undefined {
  const tier = model ? TIER_REF.exec(model)?.[1] : undefined;
  if (tier === undefined) return model;
  const tiers = settings.models ?? {};
  const ids = own(tiers, tier);
  if (!ids) {
    const names = Object.keys(tiers)
      .sort()
      .map((name) => `@${name}`);
    throw new AgentError(
      `agent() model '${model}' names no model tier: ` +
        (names.length > 0 ? `the tiers are ${names.join(", ")}` : `none is configured (set "models" in the config)`),
    );
  }
  const id = own(ids, adapter.name);
  if (id === undefined) {
    notes.push(`model tier '${model}' has no model for adapter '${adapter.name}' — the CLI's own default model is used`);
  }
  return id;
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
