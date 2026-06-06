/**
 * Read-model for workflows (L5) — the Workspace tab's data.
 *
 * Mirrors {@link ./runs-view} but for the *managed directory* side: it turns the
 * workflow scripts a user's agent has written into ODW and Claude Code workflow
 * roots into the shape the Workspace UI wants — name, description, declared
 * phases, source text, and which runs belong to each.
 *
 * Like the rest of `odw serve`, it is strictly read-only and never executes a
 * workflow body: `listWorkflows` is a pure readdir, and `loadWorkflowScript` only
 * extracts (and `new Function`-evaluates) the `meta` *literal* — the body is
 * transformed but never run. A malformed neighbour is skipped, never fatal.
 */

import { readFileSync } from "node:fs";

import type { Config } from "../adapters/types.js";
import { loadWorkflowScript, type WorkflowMeta } from "../loader.js";
import { listWorkflows } from "../workflows/resolve.js";
import type { RunStore } from "./run-store.js";

export interface WorkflowSummary {
  /** meta.name === filename stem (the run handle). */
  name: string;
  origin: "project" | "global";
  provider: "odw" | "claude";
  rootLabel: string;
  /** Absolute path of the script on disk. */
  path: string;
  description: string | null;
  phases: Array<{ title: string }>;
  /** How many recorded runs this workflow has (its bucket size). */
  runCount: number;
  /**
   * A higher-precedence root (of ANY provider) already defines this name, so
   * `odw run <name>` resolves to that other script — not this one. The Workspace
   * still SHOWS it (grouped under its provider) so a Claude workflow is never
   * silently hidden behind a same-named ODW one; the flag lets the UI say so.
   */
  shadowed: boolean;
}

export interface WorkflowDetail extends WorkflowSummary {
  /** Raw `.js` source for the read-only source view. */
  source: string;
  /** This workflow's runs, newest first (runId only — fetch detail per run). */
  runs: Array<{ runId: string }>;
}

/** Extract a workflow's `meta` literal without running its body; null on error. */
function readMetaSafe(path: string): WorkflowMeta | null {
  try {
    return loadWorkflowScript(readFileSync(path, "utf8"), path).meta;
  } catch {
    return null; // unreadable or malformed neighbour: skip, don't break the list
  }
}

/**
 * Every workflow the dashboard should SHOW, deduped per (provider, name) so the
 * higher-precedence root wins within a provider — but cross-provider collisions
 * are kept: a Claude `deep-research` and an ODW `deep-research` both appear, the
 * shadowed one flagged. (Contrast `odw run`, which must pick exactly one script;
 * the observatory's job is to show what exists, not hide it.)
 */
export function listWorkflowSummaries(
  cwd: string,
  config: Config,
  store?: RunStore,
): WorkflowSummary[] {
  const out: WorkflowSummary[] = [];
  const seen = new Set<string>(); // `${provider}:${name}` — top root per provider+name wins
  for (const w of listWorkflows(cwd, config)) {
    const key = `${w.provider}:${w.name}`;
    if (seen.has(key)) continue; // a higher-precedence root of the SAME provider already won this name
    seen.add(key);
    const meta = readMetaSafe(w.path);
    out.push({
      name: w.name,
      origin: w.origin,
      provider: w.provider,
      rootLabel: w.rootLabel,
      path: w.path,
      description: meta?.description ?? null,
      phases: meta?.phases ?? [],
      // Run buckets are keyed by NAME only (no provider), so a shadowed entry would
      // otherwise borrow the winner's runs — runs it can never have produced, since
      // `odw run <name>` always resolves to the winner. Credit only the winner.
      runCount: store && !w.shadowed ? store.listRunsForWorkflow(w.name).length : 0,
      shadowed: w.shadowed,
    });
  }
  return out;
}

/**
 * One workflow with its source and runs, or null if no such name resolves.
 * `provider` disambiguates a cross-provider name collision: with it, the named
 * provider's entry is returned (so the Workspace can open a shadowed Claude
 * workflow's source); without it, the run-resolution winner is returned.
 */
export function workflowDetail(
  cwd: string,
  config: Config,
  store: RunStore,
  name: string,
  provider?: "odw" | "claude",
): WorkflowDetail | null {
  const all = listWorkflows(cwd, config);
  const w = provider
    ? all.find((x) => x.name === name && x.provider === provider)
    : (all.find((x) => x.name === name && !x.shadowed) ?? all.find((x) => x.name === name));
  if (!w) return null;
  const meta = readMetaSafe(w.path);
  let source = "";
  try {
    source = readFileSync(w.path, "utf8");
  } catch {
    source = "";
  }
  // Same name-keyed-bucket caveat as listWorkflowSummaries: a shadowed entry must
  // not claim the winner's run history, so report no runs for it.
  const runs = w.shadowed ? [] : store.listRunsForWorkflow(name).map((r) => ({ runId: r.runId }));
  return {
    name: w.name,
    origin: w.origin,
    provider: w.provider,
    rootLabel: w.rootLabel,
    path: w.path,
    description: meta?.description ?? null,
    phases: meta?.phases ?? [],
    runCount: runs.length,
    shadowed: w.shadowed,
    source,
    runs,
  };
}
