/**
 * Workflow loader / transform — STUB (M2). THE crux of this runtime.
 *
 * Claude Code's workflow dialect is neither a normal ES module nor a plain
 * script. A file like `deep-research.js` has:
 *
 *   - `export const meta = {...}` at the top (a pure literal), and
 *   - a *body* that uses top-level `await` AND top-level `return` — neither of
 *     which is legal in standard ESM/CJS — referencing *injected globals*
 *     (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`,
 *     `workflow`) that are never imported.
 *
 * So "loading" is a source transform, done here and nowhere else:
 *
 *   1. Extract the `meta` literal up front (so the runtime can register the
 *      workflow's name/phases before the body runs).
 *   2. Strip the `export` keyword from it.
 *   3. Wrap the remaining body in an async function whose parameters ARE the
 *      injected primitives (plus `args`), so the body's top-level `return`
 *      becomes the workflow's result and top-level `await` is legal.
 *
 * The transform stays dependency-free by reusing the same balanced-span scan the
 * schema extractor uses to find the `meta` object literal.
 */

import { notImplemented } from "./errors.js";
import type { WorkflowGlobals } from "./primitives.js";

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhaseMeta[];
  model?: string;
}

export interface LoadedWorkflow {
  meta: WorkflowMeta;
  /** Execute the transformed body with the injected globals and `args`. */
  run(globals: WorkflowGlobals, args: unknown): Promise<unknown>;
}

/** Parse + transform a workflow script's source into a runnable form. */
export function loadWorkflowScript(_source: string, _filename: string): LoadedWorkflow {
  throw notImplemented("workflow loader / transform (M2)");
}
