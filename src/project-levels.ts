/**
 * The project's levels: the working directory, then each parent up to the
 * repository root (the nearest holding `.git`, a directory or a worktree's
 * file). What `.claude/agents`, `.odw/agents` and the workflow directories
 * are looked up along (see ./agent-types, ./workflows/resolve).
 *
 * As git's `safe.directory` does, a parent not owned by the current user ends
 * the walk: a `.git` or `.claude/` someone else put above the working
 * directory (a shared `/tmp`, another account's home) is never read. The
 * working directory itself is the user's choice and always a level. On
 * Windows, or where `process.getuid` is missing, there is no check. When a
 * repository root was beyond such a parent, stderr says so once per directory.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Whether a directory may be read as part of the project: owned by the current user. */
export type OwnedPredicate = (dir: string) => boolean;

function ownedByCurrentUser(dir: string): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  try {
    return statSync(dir).uid === process.getuid();
  } catch {
    return true; // gone: nothing to read there either
  }
}

let owned: OwnedPredicate = ownedByCurrentUser;
const said = new Set<string>();

/** Tests only: swap the ownership check (null: the real one back). */
export function setOwnershipPredicate(predicate: OwnedPredicate | null): void {
  owned = predicate ?? ownedByCurrentUser;
}

/**
 * `cwd`, then each parent up to the nearest one holding `.git`; only `cwd`
 * outside a repository, or when a parent before the root is not the current
 * user's.
 */
export function projectLevels(cwd: string): string[] {
  const start = resolve(cwd);
  const levels: string[] = [];
  for (let dir = start; ; ) {
    if (dir !== start && !owned(dir)) {
      noteSkipped(start, dir);
      return [start];
    }
    levels.push(dir);
    if (existsSync(join(dir, ".git"))) return levels;
    const parent = dirname(dir);
    if (parent === dir) return [start];
    dir = parent;
  }
}

/** Say once that a repository root above `stop` was not walked to — only when there is one. */
function noteSkipped(start: string, stop: string): void {
  if (said.has(stop)) return;
  for (let dir = stop; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      said.add(stop);
      process.stderr.write(
        `odw: ${stop} is not owned by the current user — the project lookup from ${start} stops below it ` +
          `(its .claude/ and .odw/ directories, and those above it up to ${dir}, are not read)\n`,
      );
      return;
    }
    if (dirname(dir) === dir) return;
  }
}
