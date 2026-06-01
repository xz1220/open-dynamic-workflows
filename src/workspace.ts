/**
 * Workspace isolation and diff capture (cross-cutting) — STUB (M1).
 *
 * Each `agent` call runs against a *workspace*. Two modes:
 *   - `copy` (default): the source tree is copied to a throwaway directory, the
 *     agent runs there, and its changes are returned as a unified diff. The
 *     caller's real working tree is never touched.
 *   - `inplace`: the agent runs directly in the source directory, no diff. The
 *     right choice for read-only / analysis workflows (e.g. deep-research).
 */

import { notImplemented } from "./errors.js";

export type WorkspaceMode = "copy" | "inplace";

export interface Workspace {
  /** Directory the agent runs in. */
  path: string;
  /** The original source tree. */
  source: string;
  /** Unified diff of text changes since the workspace opened (empty for inplace). */
  diff(): Promise<string>;
}

/** Open a workspace, run `fn` inside it, then clean up (copy mode only). */
export async function withWorkspace<T>(
  _source: string,
  _mode: WorkspaceMode,
  _fn: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  throw notImplemented("workspace (M1)");
}
