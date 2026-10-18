/**
 * The GitHub deliveries signed triggers accepted (an ODW extension; see
 * ./trigger-route), kept under the runs root so a replay is caught across
 * `odw serve` restarts:
 *
 *   <runsRoot>/_triggers/seen.jsonl   one { key, at } per line (`at` Unix ms),
 *                                     or { key, forget: true } for a delivery
 *                                     refused for now (its retry must count)
 *
 * GitHub signs no timestamp: the same delivery, captured, verifies forever.
 * Each accepted delivery's signature and `X-GitHub-Delivery` id are kept for
 * {@link SEEN_RETENTION_SEC} (30 days); either one seen again inside that is
 * a replay. What remains: a delivery older than that, or one replayed against
 * another runs root (or after `_triggers/` was deleted), verifies again — so
 * rotate a trigger's secret when one may have leaked, and keep `dedupe`, a
 * `rateLimit` and `untrusted` on.
 *
 * The file is appended to, and compacted (rewritten without expired and
 * forgotten keys) when loaded. Another `odw serve` on the same runs root
 * appending to it is read on the next check (the file's size changed).
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How long a GitHub delivery is remembered: GitHub signs no time, so this is the replay window. */
export const SEEN_RETENTION_SEC = 30 * 24 * 3600;

/** The most keys kept: the oldest go first past it. */
const MAX_SEEN = 200_000;

/** Where the seen deliveries of a runs root are kept. */
export function seenFile(runsRoot: string): string {
  return join(runsRoot, "_triggers", "seen.jsonl");
}

export class SeenDeliveries {
  private seen: Map<string, number> | null = null;
  /** The file's size as last read or written: another writer changes it. */
  private size = -1;
  private warned = false;

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = () => {},
    private readonly retentionSec = SEEN_RETENTION_SEC,
  ) {}

  /** Record `keys` as seen at `now`; false when any was seen inside the retention (a replay). */
  remember(keys: readonly string[], now: number): boolean {
    const seen = this.load(now);
    const cutoff = now - this.retentionSec * 1000;
    if (keys.some((key) => (seen.get(key) ?? -Infinity) > cutoff)) return false;
    for (const key of keys) {
      seen.delete(key); // re-inserted last: the map stays oldest first
      seen.set(key, now);
    }
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value!);
    this.append(keys.map((key) => ({ key, at: now })));
    return true;
  }

  /** Forget `keys`: their delivery started nothing yet (refused for now), so the sender's retry must count. */
  forget(keys: readonly string[], now: number): void {
    const seen = this.load(now);
    for (const key of keys) seen.delete(key);
    this.append(keys.map((key) => ({ key, forget: true })));
  }

  private load(now: number): Map<string, number> {
    const size = this.fileSize();
    if (this.seen && size === this.size) return this.seen;
    const first = this.seen === null;
    const seen = new Map<string, number>();
    let lines = 0;
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      // none yet
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      lines++;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn line
      }
      if (entry === null || typeof entry !== "object") continue;
      const { key, at, forget } = entry as { key?: unknown; at?: unknown; forget?: unknown };
      if (typeof key !== "string") continue;
      seen.delete(key);
      if (forget !== true && typeof at === "number" && Number.isFinite(at)) seen.set(key, at);
    }
    const cutoff = now - this.retentionSec * 1000;
    for (const [key, at] of seen) if (at <= cutoff) seen.delete(key);
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value!);
    this.seen = seen;
    this.size = size;
    // Compact once, at the first load: expired and forgotten keys go.
    if (first && lines > seen.size) this.rewrite(seen);
    return seen;
  }

  private rewrite(seen: Map<string, number>): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, [...seen].map(([key, at]) => `${JSON.stringify({ key, at })}\n`).join(""), { mode: 0o600 });
      renameSync(tmp, this.file);
      this.size = this.fileSize();
    } catch (err) {
      this.warn(err);
    }
  }

  private append(entries: Array<Record<string, unknown>>): void {
    if (entries.length === 0) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
      this.size = this.fileSize();
    } catch (err) {
      // Still remembered in memory: a replay is caught until a restart.
      this.warn(err);
    }
  }

  private fileSize(): number {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  private warn(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.log(`odw serve: could not keep the triggers' seen deliveries in ${this.file} (${(err as Error).message}): a replay is caught only until a restart`);
  }
}
