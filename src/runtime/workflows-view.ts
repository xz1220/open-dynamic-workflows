/**
 * Read-model for workflows (L5) — the Workspace tab's data.
 *
 * Mirrors {@link ./runs-view} but for the *managed directory* side: it turns the
 * workflow scripts a user's agent has written into `.odw/workflows` (project) and
 * `~/.odw/workflows` (global) into the shape the Workspace UI wants — name,
 * description, declared phases, source text, and which runs belong to each.
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
  /** Absolute path of the script on disk. */
  path: string;
  description: string | null;
  phases: Array<{ title: string }>;
  /** How many recorded runs this workflow has (its bucket size). */
  runCount: number;
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

/** Every resolvable workflow (winners only — shadowed duplicates dropped). */
export function listWorkflowSummaries(
  cwd: string,
  config: Config,
  store?: RunStore,
): WorkflowSummary[] {
  const out: WorkflowSummary[] = [];
  for (const w of listWorkflows(cwd, config)) {
    if (w.shadowed) continue; // a higher-precedence root already defines this name
    const meta = readMetaSafe(w.path);
    out.push({
      name: w.name,
      origin: w.origin,
      path: w.path,
      description: meta?.description ?? null,
      phases: meta?.phases ?? [],
      runCount: store ? store.listRunsForWorkflow(w.name).length : 0,
    });
  }
  return out;
}

/** One workflow with its source and runs, or null if no such name resolves. */
export function workflowDetail(
  cwd: string,
  config: Config,
  store: RunStore,
  name: string,
): WorkflowDetail | null {
  const all = listWorkflows(cwd, config);
  const w = all.find((x) => x.name === name && !x.shadowed) ?? all.find((x) => x.name === name);
  if (!w) return null;
  const meta = readMetaSafe(w.path);
  let source = "";
  try {
    source = readFileSync(w.path, "utf8");
  } catch {
    source = "";
  }
  const runs = store.listRunsForWorkflow(name).map((r) => ({ runId: r.runId }));
  return {
    name: w.name,
    origin: w.origin,
    path: w.path,
    description: meta?.description ?? null,
    phases: meta?.phases ?? [],
    runCount: runs.length,
    source,
    runs,
  };
}
