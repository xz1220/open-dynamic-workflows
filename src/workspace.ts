/**
 * Workspace isolation and diff capture (cross-cutting).
 *
 * Each `agent` call runs against a *workspace*. Two modes:
 *   - `copy` (default): the source tree is copied to a throwaway directory, the
 *     agent runs there, and its changes are returned as a unified diff. The
 *     caller's real working tree is never touched.
 *   - `inplace`: the agent runs directly in the source directory, no diff. The
 *     right choice for read-only / analysis workflows (e.g. deep-research).
 */

import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { unifiedDiff } from "./diff.js";

export type WorkspaceMode = "copy" | "inplace";

export interface Workspace {
  /** Directory the agent runs in. */
  path: string;
  /** The original source tree. */
  source: string;
  /** Unified diff of text changes since the workspace opened (empty for inplace). */
  diff(): Promise<string>;
}

/** Directories never worth copying into an isolated workspace. */
const IGNORED_DIRS = new Set([
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  ".pytest_cache",
  ".ruff_cache",
]);
/** Files larger than this are copied but skipped in the textual diff. */
const MAX_DIFF_BYTES = 512 * 1024;

/** Open a workspace, run `fn` inside it, then clean up (copy mode only). */
export async function withWorkspace<T>(
  source: string,
  mode: WorkspaceMode,
  fn: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  if (mode === "inplace") {
    return fn({ path: source, source, diff: async () => "" });
  }
  if (mode !== "copy") {
    throw new Error(`unknown workspace mode '${mode}'; use 'copy' or 'inplace'`);
  }

  const tmp = await mkdtemp(join(tmpdir(), "odw-ws-"));
  const work = join(tmp, basename(source));
  try {
    await cp(source, work, {
      recursive: true,
      filter: (src) => !IGNORED_DIRS.has(basename(src)),
    });
    const before = await snapshot(work);
    const ws: Workspace = {
      path: work,
      source,
      diff: async () => computeDiff(before, await snapshot(work)),
    };
    return await fn(ws);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// --- internals ---------------------------------------------------------------

/** Map each small text file (path relative to `root`) to its contents. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        if (info.size > MAX_DIFF_BYTES) continue;
        const text = await readFile(full, "utf8");
        out.set(relative(root, full), text);
      } catch {
        continue; // unreadable or binary: copied, but not diffed
      }
    }
  }
  await walk(root);
  return out;
}

function computeDiff(before: Map<string, string>, after: Map<string, string>): string {
  const rels = [...new Set([...before.keys(), ...after.keys()])].sort();
  let out = "";
  for (const rel of rels) {
    const oldText = before.get(rel) ?? "";
    const newText = after.get(rel) ?? "";
    if (oldText === newText) continue;
    out += unifiedDiff(oldText, newText, `a/${rel}`, `b/${rel}`);
  }
  return out;
}
