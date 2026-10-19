/**
 * Run bundles (ODW extension): one run as one redacted, self-contained file to
 * share — `odw bundle <run>` writes it, `odw serve --open FILE.odwrun` (or
 * `odw view FILE`) shows it read-only on the dashboard.
 *
 * A bundle (`<runId>.odwrun`) is a single JSON object:
 *
 *   { format: "odw-run-bundle", version: 1, odwVersion, bundledAt, runId,
 *     redacted, transcripts,
 *     meta, status, events, result, error,
 *     agents: [{ agentId, record, diff, transcript, stderr, redacted? }] }
 *
 * `meta` keeps only the fields that describe the run (never its config path
 * or anything of the machine's config, environment, notify or otel settings),
 * `status` loses the worker's pid, and every string in it — args, events,
 * saved results, kept diffs, transcripts, the result, the error — has been
 * through the run's redactor (../redact: the token shapes and the
 * environment's secret values, whatever the config's `redact` says), each
 * piece marked `redacted: true` where something was replaced, and the bundle
 * too. `transcripts: false` (`--no-transcripts`) leaves the agents'
 * transcripts and stderr out. The events keep what they always had — the
 * `run_started` setup `odw compare` reads is the behaviour settings and
 * adapter fingerprints, nothing secret (../provenance). A kept diff in a
 * bundle is a redacted copy: for reading, not for `odw apply`.
 *
 * Opening one trusts nothing in it: the file's size is capped before it is
 * read, the run id must match RUN_ID_RE, every agent id is a non-negative
 * integer (it names files), every field has the type it should, and the run
 * is unpacked into a fresh private temp directory under fixed file names —
 * nothing the file says ever becomes a path.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowEvent } from "../events.js";
import type { AgentResultRecord } from "../journal.js";
import { createRedactor, type Redactor } from "../redact.js";
import type { Config } from "../adapters/types.js";
import { VERSION } from "../version.generated.js";
import { readdirSafe } from "./fs-util.js";
import { RUN_ID_RE } from "./run-source.js";
import type { RunStore } from "./run-store.js";

export const BUNDLE_FORMAT = "odw-run-bundle";
export const BUNDLE_VERSION = 1;
/** A bundle's file extension. */
export const BUNDLE_EXT = ".odwrun";
/** The size a bundle may have, written or opened, unless `--max-bytes` says otherwise. */
export const DEFAULT_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
/** Agents a bundle may hold: each becomes up to four files when it is opened. */
export const MAX_BUNDLE_AGENTS = 10_000;

/** The meta.json fields a bundle keeps: what describes the run, nothing of the machine's setup. */
const META_FIELDS = [
  "runId",
  "script",
  "args",
  "source",
  "budgetTotal",
  "workflowName",
  "adapter",
  "permissions",
  "origin",
  "resumedFrom",
  "inline",
  "odwVersion",
  "sourceHash",
  "createdAt",
] as const;

/** status.json fields a bundle never carries: the worker's process, which is no one's to probe elsewhere. */
const STATUS_DROPPED = new Set(["pid", "pidStart"]);

/** One agent's files in a bundle. */
export interface BundleAgent {
  agentId: number;
  /** Its saved result (agents/<id>.json), or null when it saved none (failed, still running). */
  record: AgentResultRecord | null;
  /** What it changed, as its kept unified diff — redacted, so for reading, not for `odw apply`. */
  diff: string | null;
  /** What its CLI printed (agents/<id>.transcript.jsonl); null without one, or with `transcripts: false`. */
  transcript: string | null;
  /** The end of its stderr (agents/<id>.stderr.txt); null as for `transcript`. */
  stderr: string | null;
  /** Something in its diff, transcript or stderr was redacted. */
  redacted?: true;
}

export interface RunBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  /** The odw that wrote the bundle. */
  odwVersion: string | null;
  /** When it was written, epoch seconds. */
  bundledAt: number | null;
  runId: string;
  /** Something anywhere in it was redacted. */
  redacted: boolean;
  /** Whether the agents' transcripts are in it. */
  transcripts: boolean;
  meta: Record<string, unknown>;
  status: Record<string, unknown>;
  events: WorkflowEvent[];
  /** result.json: `{ value }`, or null when the run returned nothing (yet). */
  result: { value: unknown; redacted?: true } | null;
  /** error.json, or null. */
  error: Record<string, unknown> | null;
  agents: BundleAgent[];
}

export interface BundleOptions {
  /** Include the agents' transcripts and stderr (default true; `--no-transcripts`). */
  transcripts?: boolean;
  /** The size cap, in bytes (default {@link DEFAULT_BUNDLE_MAX_BYTES}; `--max-bytes`). */
  maxBytes?: number;
  /** The clock, epoch seconds (tests). */
  now?: () => number;
}

/** A bundle refused — too big, malformed, unsafe — with a message for the person. */
export class BundleError extends Error {}

/**
 * The redactor a bundle goes through: the config's `redact` patterns and
 * `extra`, over the environment odw starts agents with (its own and each
 * adapter's) — and, since a bundle is made to be shared, the defaults when the
 * config turns redaction off.
 */
export function bundleRedactor(config: Pick<Config, "adapters" | "settings">, env: Readonly<Record<string, string | undefined>> = process.env): Redactor {
  const setting = config.settings.redact;
  const on = setting === false ? undefined : { ...setting, env: true, patterns: true };
  return createRedactor(on, { env: [env, ...Object.values(config.adapters).map((adapter) => adapter.env)] });
}

/**
 * Build the bundle of `runId` (which must exist in `store`), redacted by
 * `redactor`. Throws a {@link BundleError} when it would pass `maxBytes`.
 * Returns the bundle and its JSON text.
 */
export function createBundle(store: RunStore, runId: string, redactor: Redactor, options: BundleOptions = {}): { bundle: RunBundle; json: string } {
  if (!isBundleRunId(runId)) throw new BundleError(`not a run id: ${runId}`);
  const withTranscripts = options.transcripts !== false;
  const maxBytes = options.maxBytes ?? DEFAULT_BUNDLE_MAX_BYTES;
  let redacted = false;
  const rec = <T extends object>(value: T): T => {
    const out = redactor.record(value);
    if ((out as { redacted?: unknown }).redacted === true) redacted = true;
    return out;
  };
  const text = (value: string | null): { text: string | null; changed: boolean } => {
    if (value === null) return { text: null, changed: false };
    const out = redactor.text(value);
    return { text: out, changed: out !== value };
  };

  const rawMeta = store.readMeta(runId);
  const meta: Record<string, unknown> = {};
  for (const field of META_FIELDS) if (field in rawMeta) meta[field] = rawMeta[field];
  const status = Object.fromEntries(Object.entries(store.readStatus(runId)).filter(([key]) => !STATUS_DROPPED.has(key)));
  const resultFile = store.hasResult(runId) ? { value: store.readResult(runId) } : null;
  const error = store.readError(runId);

  const dir = join(store.runDir(runId), "agents");
  const ids = new Set<number>();
  for (const entry of readdirSafe(dir)) {
    const m = /^(\d+)\.(?:json|diff|transcript\.jsonl|stderr\.txt)$/.exec(entry.name);
    if (entry.isFile() && m && Number.isSafeInteger(Number(m[1]))) ids.add(Number(m[1]));
  }
  const agents: BundleAgent[] = [...ids].sort((a, b) => a - b).map((agentId) => {
    const saved = store.readAgentResult(runId, agentId);
    const paths = store.agentTranscriptPaths(runId, agentId);
    const diff = text(readText(store.agentDiffPath(runId, agentId)));
    const transcript = withTranscripts ? readText(paths.transcript) : null;
    const transcriptOut = transcript === null ? null : transcript.split(/(?<=\n)/).map((line) => redactor.jsonLine(line)).join("");
    const stderr = text(withTranscripts ? readText(paths.stderr) : null);
    const changed = diff.changed || stderr.changed || transcriptOut !== transcript;
    if (changed) redacted = true;
    return {
      agentId,
      record: saved ? rec(saved) : null,
      diff: diff.text,
      transcript: transcriptOut,
      stderr: stderr.text,
      ...(changed ? { redacted: true as const } : {}),
    };
  });

  const bundle: RunBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    odwVersion: VERSION,
    bundledAt: (options.now ?? (() => Date.now() / 1000))(),
    runId,
    redacted: false,
    transcripts: withTranscripts,
    meta: rec(meta),
    status: rec(status),
    events: store.readEvents(runId).map((ev) => rec(ev)),
    result: resultFile ? rec(resultFile) : null,
    error: error ? rec(error) : null,
    agents,
  };
  bundle.redacted = redacted;
  const json = JSON.stringify(bundle) + "\n";
  const bytes = Buffer.byteLength(json);
  if (bytes > maxBytes) {
    const transcriptBytes = agents.reduce((n, a) => n + Buffer.byteLength(a.transcript ?? "") + Buffer.byteLength(a.stderr ?? ""), 0);
    const hint = withTranscripts && transcriptBytes > 0 ? `--no-transcripts leaves out ${transcriptBytes} bytes of transcripts; ` : "";
    throw new BundleError(`the bundle of run ${runId} would be ${bytes} bytes, over the ${maxBytes}-byte cap: ${hint}--max-bytes <n> raises the cap`);
  }
  return { bundle, json };
}

/** A run id a bundle may carry: one safe path segment that names an ODW run (not `.`/`..`, not a Claude `cc-` id). */
export function isBundleRunId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && RUN_ID_RE.test(value) && !/^\.+$/.test(value) && !value.startsWith("cc-");
}

/**
 * Read and check a bundle file: at most `maxBytes` (checked before it is
 * read), JSON, this format and version, and every field the shape it should
 * have. Throws a {@link BundleError} saying what is wrong.
 */
export function readBundle(file: string, maxBytes = DEFAULT_BUNDLE_MAX_BYTES): RunBundle {
  let size: number;
  try {
    const info = statSync(file);
    if (!info.isFile()) throw new BundleError(`${file} is not a file`);
    size = info.size;
  } catch (err) {
    if (err instanceof BundleError) throw err;
    throw new BundleError(`cannot read ${file}: ${(err as Error).message}`);
  }
  if (size > maxBytes) throw new BundleError(`${file} is ${size} bytes, over the ${maxBytes}-byte cap: --max-bytes <n> raises it`);
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (err) {
    throw new BundleError(`cannot read ${file}: ${(err as Error).message}`);
  }
  // The file may have grown between the stat and the read.
  if (raw.length > maxBytes) throw new BundleError(`${file} is over the ${maxBytes}-byte cap: --max-bytes <n> raises it`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BundleError(`${file} is not a run bundle (not JSON)`);
  }
  return checkBundle(parsed);
}

/** `value` as a {@link RunBundle}, or a {@link BundleError} naming the first thing wrong with it. */
export function checkBundle(value: unknown): RunBundle {
  const bad = (what: string): never => {
    throw new BundleError(`not a valid run bundle: ${what}`);
  };
  if (!isPlainObject(value)) return bad("not a JSON object");
  if (value.format !== BUNDLE_FORMAT) return bad(`format must be "${BUNDLE_FORMAT}"`);
  if (value.version !== BUNDLE_VERSION) return bad(`version ${JSON.stringify(value.version)} is not one this odw reads (${BUNDLE_VERSION})`);
  if (!isBundleRunId(value.runId)) return bad("runId must be a run id ([A-Za-z0-9._-], not a Claude cc- id)");
  const runId = value.runId;
  if (!isPlainObject(value.meta)) return bad("meta must be an object");
  if (!isPlainObject(value.status)) return bad("status must be an object");
  if (!Array.isArray(value.events) || !value.events.every((ev) => isPlainObject(ev) && typeof ev.type === "string")) {
    return bad("events must be an array of events (objects with a string type)");
  }
  if (value.result !== null && value.result !== undefined && !(isPlainObject(value.result) && "value" in value.result)) {
    return bad("result must be null or { value }");
  }
  if (value.error !== null && value.error !== undefined && !isPlainObject(value.error)) return bad("error must be null or an object");
  if (!Array.isArray(value.agents)) return bad("agents must be an array");
  if (value.agents.length > MAX_BUNDLE_AGENTS) return bad(`more than ${MAX_BUNDLE_AGENTS} agents`);
  const seen = new Set<number>();
  const agents: BundleAgent[] = value.agents.map((agent, i) => {
    if (!isPlainObject(agent)) return bad(`agents[${i}] must be an object`);
    const { agentId } = agent;
    if (typeof agentId !== "number" || !Number.isSafeInteger(agentId) || agentId < 0) return bad(`agents[${i}].agentId must be a non-negative integer`);
    if (seen.has(agentId)) return bad(`agent ${agentId} appears twice`);
    seen.add(agentId);
    const record = agent.record ?? null;
    if (record !== null && !(isPlainObject(record) && record.agentId === agentId)) {
      return bad(`agents[${i}].record must be null or a saved result with agentId ${agentId}`);
    }
    for (const field of ["diff", "transcript", "stderr"] as const) {
      const v = agent[field];
      if (v !== null && v !== undefined && typeof v !== "string") return bad(`agents[${i}].${field} must be a string or null`);
    }
    return {
      agentId,
      record: record as AgentResultRecord | null,
      diff: (agent.diff as string | undefined) ?? null,
      transcript: (agent.transcript as string | undefined) ?? null,
      stderr: (agent.stderr as string | undefined) ?? null,
      ...(agent.redacted === true ? { redacted: true as const } : {}),
    };
  });
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    odwVersion: typeof value.odwVersion === "string" ? value.odwVersion : null,
    bundledAt: typeof value.bundledAt === "number" && Number.isFinite(value.bundledAt) ? value.bundledAt : null,
    runId,
    redacted: value.redacted === true,
    transcripts: value.transcripts !== false,
    meta: value.meta,
    status: value.status,
    events: value.events as WorkflowEvent[],
    result: isPlainObject(value.result) ? (value.result as RunBundle["result"]) : null,
    error: isPlainObject(value.error) ? value.error : null,
    agents,
  };
}

/** What `odw serve` says about the bundle it shows (GET /api/capabilities → `bundle`). */
export interface BundleInfo {
  runId: string;
  /** The bundle file's name (not its path). */
  file: string;
  bundledAt: number | null;
  odwVersion: string | null;
  redacted: boolean;
  transcripts: boolean;
}

/** A bundle unpacked as a runs root, and how to remove it. */
export interface OpenedBundle {
  /** The private temp directory: a runs root holding the one run. */
  root: string;
  info: BundleInfo;
  /** Remove the temp directory (idempotent; never throws). */
  cleanup(): void;
}

/**
 * Unpack a checked bundle into a fresh private temp directory as a runs root
 * — `<tmp>/bundle/<runId>/` with the run store's file names, agent files named
 * by their integer ids — so the dashboard serves it as any run. The run's meta
 * gains `bundle` (the "shared bundle" tag); its status keeps no pid, so a run
 * bundled while it went on shows as stale, not running.
 */
export function unpackBundle(bundle: RunBundle, fileName: string, parent = tmpdir()): OpenedBundle {
  const root = mkdtempSync(join(parent, "odw-bundle-"));
  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort: the OS clears its temp dir */
    }
  };
  try {
    const dir = join(root, "bundle", bundle.runId);
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
    // "wx": a fresh file, never one already there (nor a link planted in its place).
    const write = (name: string, data: string) => writeFileSync(join(dir, name), data, { flag: "wx", mode: 0o600 });
    const info: BundleInfo = {
      runId: bundle.runId,
      file: fileName,
      bundledAt: bundle.bundledAt,
      odwVersion: bundle.odwVersion,
      redacted: bundle.redacted,
      transcripts: bundle.transcripts,
    };
    // Only the fields a bundle is made with: nothing else the file carries reaches the dashboard.
    const meta: Record<string, unknown> = {};
    for (const field of META_FIELDS) if (field in bundle.meta) meta[field] = bundle.meta[field];
    write("meta.json", JSON.stringify({ ...meta, runId: bundle.runId, bundle: { bundledAt: info.bundledAt, odwVersion: info.odwVersion } }, null, 2));
    const status = Object.fromEntries(Object.entries(bundle.status).filter(([key]) => !STATUS_DROPPED.has(key)));
    write("status.json", JSON.stringify({ ...status, runId: bundle.runId }, null, 2));
    write("events.jsonl", bundle.events.map((ev) => JSON.stringify(ev) + "\n").join(""));
    if (bundle.result) write("result.json", JSON.stringify(bundle.result, null, 2));
    if (bundle.error) write("error.json", JSON.stringify(bundle.error, null, 2));
    for (const agent of bundle.agents) {
      const name = String(agent.agentId); // a non-negative integer: checkBundle saw to it
      if (agent.record) write(`agents/${name}.json`, JSON.stringify(agent.record, null, 2));
      if (agent.diff !== null) write(`agents/${name}.diff`, agent.diff);
      if (agent.transcript !== null) write(`agents/${name}.transcript.jsonl`, agent.transcript);
      if (agent.stderr !== null) write(`agents/${name}.stderr.txt`, agent.stderr);
    }
    return { root, info, cleanup };
  } catch (err) {
    cleanup();
    throw err instanceof BundleError ? err : new BundleError(`cannot unpack the bundle: ${(err as Error).message}`);
  }
}

/** Read, check and unpack a bundle file (see {@link readBundle}, {@link unpackBundle}). */
export function openBundle(file: string, maxBytes = DEFAULT_BUNDLE_MAX_BYTES, parent = tmpdir()): OpenedBundle {
  const bundle = readBundle(file, maxBytes);
  return unpackBundle(bundle, file.split(/[\\/]/).pop() || file, parent);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
