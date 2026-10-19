/**
 * The workflow lock (an ODW extension): what `odw workflows add` installed
 * from git, pinned.
 *
 * A workflows directory `D` (`.odw/workflows`, or `~/.odw/workflows` with
 * `--global`) has its lock beside it, `D.lock.json` — `.odw/workflows.lock.json`
 * — keyed by the installed workflow's name:
 *
 *   { "version": 1,
 *     "workflows": {
 *       "audit": { "url": "https://example.com/acme/flows.git", "ref": "v1.2.0",
 *                  "commit": "<40 hex>", "path": ".odw/workflows/audit.js",
 *                  "sha256": "<64 hex>", "installedAt": "2026-10-19T…Z",
 *                  "test": { "path": ".odw/tests/audit.json", "sha256": "…" } } } }
 *
 * `path` is the file's path in the fetched repository, `sha256` the hash of
 * the bytes written to `D/<name>.js`; the optional `test` and `eval` are the
 * workflow's `.odw/tests/<stem>.json` and `.odw/evals/<stem>.json` from the
 * same repository, copied to `tests/<name>.json` and `evals/<name>.json` next
 * to `D` (project installs only). Where a locked file lives on disk is
 * derived from its name, never read from the lock, so a lock that arrived
 * with a checkout cannot point a write anywhere else.
 *
 * A workflow with an entry here is third-party: it runs in a strict script
 * context by default, and a run whose file no longer hashes to its `sha256`
 * says so loudly (or, with `lockedWorkflows: "fail"`, does not start).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ConfigError } from "../errors.js";
import { writeJsonAtomic } from "../runtime/fs-util.js";

export const LOCK_VERSION = 1;

/** A workflow name, as `odw run <name>` resolves one (../workflows/resolve; not imported, which imports this). */
const NAME_RE = /^[A-Za-z0-9._-]{1,255}$/;
const isValidWorkflowName = (name: string) => NAME_RE.test(name) && name !== "." && name !== "..";

/** A file copied along with the workflow (its test or eval). */
export interface LockedExtra {
  /** Its path in the fetched repository. */
  path: string;
  sha256: string;
}

export interface LockEntry {
  /** Where it was fetched from: an https, ssh or file URL. */
  url: string;
  /** The ref asked for (`#ref`); null: the remote's HEAD. */
  ref: string | null;
  /** The commit it was read from. */
  commit: string;
  /** Its path in the fetched repository. */
  path: string;
  /** sha256 of the installed bytes. */
  sha256: string;
  installedAt: string;
  test?: LockedExtra;
  eval?: LockedExtra;
}

export interface WorkflowLock {
  version: typeof LOCK_VERSION;
  workflows: Record<string, LockEntry>;
}

export type ExtraKind = "test" | "eval";
export const EXTRA_KINDS: readonly ExtraKind[] = ["test", "eval"];
/** The directory an extra of `kind` lives in, beside the workflows directory and in the source repository's `.odw`. */
export const EXTRA_DIRS: Record<ExtraKind, string> = { test: "tests", eval: "evals" };

/** The lock file of workflows directory `dir`: `<dir>.lock.json`. */
export function lockPathFor(dir: string): string {
  return `${dir.replace(/[/\\]+$/, "")}.lock.json`;
}

/** Where entry `name`'s workflow lives: `<dir>/<name>.js`. */
export function lockedWorkflowPath(dir: string, name: string): string {
  return join(dir, `${name}.js`);
}

/** Where entry `name`'s test or eval lives: `tests/<name>.json` or `evals/<name>.json` beside `dir`. */
export function lockedExtraPath(dir: string, name: string, kind: ExtraKind): string {
  return join(dirname(dir), EXTRA_DIRS[kind], `${name}.json`);
}

export function sha256Of(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of the file at `path`; null when it cannot be read. */
export function sha256File(path: string): string | null {
  try {
    return sha256Of(readFileSync(path));
  } catch {
    return null;
  }
}

const HEX40 = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The lock at `path`: empty when there is none; a ConfigError when it is not one. */
export function readLock(path: string): WorkflowLock {
  if (!existsSync(path)) return { version: LOCK_VERSION, workflows: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path}: not a workflow lock: ${(err as Error).message}`);
  }
  const bad = (why: string) => new ConfigError(`${path}: not a workflow lock: ${why}`);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw bad("expected an object");
  const r = raw as Record<string, unknown>;
  if (r.version !== LOCK_VERSION) throw bad(`version ${JSON.stringify(r.version)} (this odw reads ${LOCK_VERSION})`);
  const list = r.workflows;
  if (list === null || typeof list !== "object" || Array.isArray(list)) throw bad('"workflows" is not an object');
  const workflows: Record<string, LockEntry> = {};
  for (const [name, value] of Object.entries(list as Record<string, unknown>)) {
    if (!isValidWorkflowName(name)) throw bad(`'${name}' is not a workflow name`);
    const e = value as Record<string, unknown> | null;
    const str = (k: string) => (e && typeof e[k] === "string" ? (e[k] as string) : null);
    const url = str("url");
    const commit = str("commit");
    const sha256 = str("sha256");
    const at = str("path");
    if (!e || typeof e !== "object" || !url || !at || !commit || !HEX40.test(commit) || !sha256 || !HEX64.test(sha256)) {
      throw bad(`entry '${name}' needs url, path, a commit id and a sha256`);
    }
    if (e.ref !== null && e.ref !== undefined && typeof e.ref !== "string") throw bad(`entry '${name}': ref must be a string or null`);
    const entry: LockEntry = {
      url,
      ref: typeof e.ref === "string" ? e.ref : null,
      commit,
      path: at,
      sha256,
      installedAt: str("installedAt") ?? "",
    };
    for (const kind of EXTRA_KINDS) {
      const x = e[kind] as Record<string, unknown> | undefined;
      if (x === undefined) continue;
      if (!x || typeof x.path !== "string" || typeof x.sha256 !== "string" || !HEX64.test(x.sha256)) {
        throw bad(`entry '${name}': ${kind} needs a path and a sha256`);
      }
      entry[kind] = { path: x.path, sha256: x.sha256 };
    }
    workflows[name] = entry;
  }
  return { version: LOCK_VERSION, workflows };
}

/** Write the lock, its entries by name. */
export function writeLock(path: string, lock: WorkflowLock): void {
  const workflows: Record<string, LockEntry> = {};
  for (const name of Object.keys(lock.workflows).sort()) workflows[name] = lock.workflows[name]!;
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, { version: LOCK_VERSION, workflows }, 2);
}

/** A workflow file that a lock covers: what it was installed from, and whether it still is that. */
export interface InstalledWorkflow {
  name: string;
  lockPath: string;
  entry: LockEntry;
  /** sha256 of the file as it is now; null when it cannot be read. */
  actualSha256: string | null;
  /** Its bytes are no longer the ones installed. */
  modified: boolean;
}

/**
 * The lock entry for the workflow at `scriptPath`, if its directory has a lock
 * that names it (`<dir>.lock.json`, entry `<stem>`); null for any other file —
 * and for a lock that cannot be read, which `odw workflows verify` reports.
 */
export function installedWorkflowFor(scriptPath: string): InstalledWorkflow | null {
  const file = basename(scriptPath);
  if (!file.endsWith(".js")) return null;
  const name = file.slice(0, -".js".length);
  const lockPath = lockPathFor(dirname(scriptPath));
  if (!existsSync(lockPath)) return null;
  let lock: WorkflowLock;
  try {
    lock = readLock(lockPath);
  } catch {
    return null;
  }
  const entry = Object.hasOwn(lock.workflows, name) ? lock.workflows[name] : undefined;
  if (!entry) return null;
  const actualSha256 = sha256File(scriptPath);
  return { name, lockPath, entry, actualSha256, modified: actualSha256 !== entry.sha256 };
}

/** One locked file's state on disk. */
export interface VerifiedFile {
  name: string;
  kind: "workflow" | ExtraKind;
  file: string;
  status: "ok" | "modified" | "missing";
  expected: string;
  actual: string | null;
  entry: LockEntry;
}

/** Every file the lock of workflows directory `dir` covers, against its sha256 (`odw workflows verify`). */
export function verifyLock(dir: string, lock: WorkflowLock, only?: string): VerifiedFile[] {
  const out: VerifiedFile[] = [];
  for (const name of Object.keys(lock.workflows).sort()) {
    if (only !== undefined && name !== only) continue;
    const entry = lock.workflows[name]!;
    const files: Array<{ kind: VerifiedFile["kind"]; file: string; expected: string }> = [
      { kind: "workflow", file: lockedWorkflowPath(dir, name), expected: entry.sha256 },
    ];
    for (const kind of EXTRA_KINDS) {
      const x = entry[kind];
      if (x) files.push({ kind, file: lockedExtraPath(dir, name, kind), expected: x.sha256 });
    }
    for (const f of files) {
      const actual = sha256File(f.file);
      const status = actual === null ? "missing" : actual === f.expected ? "ok" : "modified";
      out.push({ name, kind: f.kind, file: f.file, status, expected: f.expected, actual, entry });
    }
  }
  return out;
}

/** What a run says of a workflow installed from git whose file no longer hashes to its lock entry. */
export function modifiedLockedMessage(w: InstalledWorkflow): string {
  return (
    `workflow ${w.name} was installed from ${describeSource(w.entry)} but was modified since: its sha256 is not the one in ${w.lockPath} — ` +
    "odw workflows verify shows it; restore it, or odw workflows update --force"
  );
}

/** `url#ref @ commit12` — how a listing names where an installed workflow came from. */
export function describeSource(entry: Pick<LockEntry, "url" | "ref" | "commit">): string {
  return `${entry.url}${entry.ref ? `#${entry.ref}` : ""} @ ${entry.commit.slice(0, 12)}`;
}
