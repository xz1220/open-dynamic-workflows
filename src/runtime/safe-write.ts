/**
 * Writing a file into a directory tree that may have come from someone else —
 * a cloned project's `.odw` — without following a symlink out of it: shared
 * by `odw types` (../editor-types) and `odw workflows add|update`
 * (../workflows/install).
 *
 * {@link unsafeTarget} says why a path must not be written: it, or a directory
 * from the root down to it, is a symlink, or its parent resolves outside the
 * root. {@link writeReplacing} writes through a temporary file created beside
 * the target (`wx`: never through something already there) and renamed over
 * it, so even a link put there meanwhile is replaced, never written through.
 * {@link writeInside} does both, creating the directories in between.
 */

import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Why `path` must not be written, or null: it, or a directory from `root`
 * down to it, is a symlink, or its parent's realpath leaves `root`'s. A
 * symlink is never written through — not a file, not a dangling link —
 * wherever it points.
 */
export function unsafeTarget(root: string, path: string): string | null {
  const parts = relative(root, path).split(sep);
  if (parts[0] === ".." || isAbsolute(relative(root, path))) return `${path} is outside ${root}`;
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      break; // not there yet: created, as a directory or the file, below what was checked
    }
    if (st.isSymbolicLink()) return `${at} is a symbolic link`;
  }
  try {
    const parent = realpathSync(dirname(path));
    if (!within(realpathSync(root), parent) && parent !== realpathSync(root)) return `${dirname(path)} resolves outside ${root}`;
  } catch {
    // the parent is not there yet: nothing resolves anywhere
  }
  return null;
}

/** Write through a temporary file beside `path`, renamed over it: never through what `path` is. */
export function writeReplacing(path: string, content: string | Buffer): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, content, typeof content === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** A path refused by {@link writeInside}: its message names the path and why. */
export class UnsafeWriteError extends Error {
  constructor(readonly reason: string) {
    super(`not writing ${reason} — a symlink is never written through`);
    this.name = "UnsafeWriteError";
  }
}

/**
 * Write `content` to `path` inside `root`: checked ({@link unsafeTarget}),
 * its directories made, checked again (a link put there meanwhile), and
 * written by {@link writeReplacing}. An {@link UnsafeWriteError} when refused.
 */
export function writeInside(root: string, path: string, content: string | Buffer): void {
  const before = unsafeTarget(root, path);
  if (before) throw new UnsafeWriteError(before);
  mkdirSync(dirname(path), { recursive: true });
  const after = unsafeTarget(root, path);
  if (after) throw new UnsafeWriteError(after);
  writeReplacing(path, content);
}

/** `path` is strictly inside `root`. */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
