/**
 * Small filesystem helpers shared by the run store, the run sources and the
 * chat store (L5). Everything here is node:fs only and never throws on a
 * missing or unreadable file — callers treat "can't read" as "nothing there".
 */

import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/** Parse a JSON file; null when it is missing, unreadable or not valid JSON. */
export function readJsonFile<T = Record<string, unknown>>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Write JSON atomically (temp file + rename), so a concurrent reader never sees
 * a half-written file. The temp name is unique per process and call, so two
 * writers can never clobber each other's temp file.
 */
export function writeJsonAtomic(path: string, payload: unknown, indent?: number): void {
  const tmp = `${path}.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, indent), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true }); // e.g. ENOSPC mid-write: leave no partial temp file behind
    } catch {
      /* the write error is the one worth reporting */
    }
    throw err;
  }
}

/**
 * A cheap change fingerprint for one file: inode + size + mtime, or "-" when
 * the file is missing. The inode catches atomic temp-file + rename rewrites
 * that land with the same size inside one mtime tick.
 */
export function statSig(path: string): string {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "-";
  }
}

/**
 * A memo keyed by id and validated by a caller-supplied signature (typically
 * {@link statSig}s of the files the value was derived from): a value is reused
 * only while its signature is unchanged. `compute` receives the previous value
 * (if any) so incremental folds can resume instead of starting over.
 *
 * With `maxEntries` set it is also an LRU: a hit refreshes recency and the
 * least recently used entry is evicted past the bound.
 */
export class SigCache<V> {
  private readonly entries = new Map<string, { sig: string; value: V }>();

  constructor(private readonly maxEntries = Infinity) {}

  get(key: string, sig: string, compute: (previous: V | undefined) => V): V {
    const hit = this.entries.get(key);
    if (hit && hit.sig === sig) {
      if (this.maxEntries !== Infinity) {
        this.entries.delete(key);
        this.entries.set(key, hit);
      }
      return hit.value;
    }
    const value = compute(hit?.value);
    this.entries.delete(key);
    this.entries.set(key, { sig, value });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return value;
  }

  /** Drop every entry whose key is not in `live` (e.g. runs deleted from disk). */
  retain(live: Set<string>): void {
    for (const key of this.entries.keys()) if (!live.has(key)) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
