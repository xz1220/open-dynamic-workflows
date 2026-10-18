/**
 * The run directory: the file-backed seam between front and back.
 *
 * A run is a directory under `runsRoot`. The background worker writes to it; the
 * CLI reads from it. They never talk directly, which lets a run outlive the
 * command that started it and be observed from anywhere.
 *
 * Runs are bucketed by workflow so a run's owner is visible from its path and a
 * workflow's runs can be listed without scanning every run:
 *
 *   <runsRoot>/<workflow-slug>/<runId>/
 *     meta.json      immutable run description (script, args, source, config, workflowName,
 *                    resumedFrom: the run an `odw resume` replays; odwVersion and the
 *                    workflow's sourceHash, sha256, for `odw compare`; origin, and `eval`
 *                    for a run of `odw eval`; applyResolve for a resolver run of
 *                    `odw apply --resolve`, and resolvedBy — appended later — on the
 *                    run whose agent it resolved)
 *     status.json    mutable state (running/paused/done/failed/stopped, counters)
 *     events.jsonl   append-only progress stream
 *     agents/<agentId>.json  each completed agent()'s result, saved as it lands
 *                    (an AgentResultRecord; `agent_finished` carries `saved: true`)
 *     agents/<agentId>.diff  what an isolated agent changed, as a unified diff
 *                    (ODW extension; its event and record carry `changes`)
 *     agents/<agentId>.transcript.jsonl  what an agent's CLI printed on stdout, as it ran
 *                    (ODW extension; see ../transcript), and agents/<agentId>.stderr.txt
 *                    the end of its stderr — none for a replayed agent
 *     agents/<agentId>.handoff.md  the brief a fallback that handed an agent's work over put in the
 *                    next adapter's prompt (ODW extension; see ../handoff)
 *     agents/<agentId>.schema.json  the schema of an agent whose CLI reads it from a file
 *                    (ODW extension; see ../adapters/native-schema), there only while it runs
 *     result.json    final return value (on success)
 *     error.json     message + stack (on failure)
 *     control.json   pause/resume/stop request written by the CLI
 *     decisions.jsonl  answers to checkpoint() calls, appended by `odw approve|reject` and
 *                    the dashboard: one { action: approve|reject, checkpointId?, note?,
 *                    by, at } per line
 *     worker.log     the worker process's stdout/stderr
 *
 * A `runId` is globally unique, so it stays the public handle: `runDir(runId)`
 * locates a run across buckets (and still finds pre-bucket flat runs under
 * `<runsRoot>/<runId>/`, so old run directories keep working).
 *
 * All JSON writes are atomic (temp file + rename) so a concurrent reader never
 * sees a half-written file.
 *
 * What the worker writes here of its agents — events, saved results, the
 * transcripts, the error and the result — has its likely secrets redacted
 * first (ODW extension; see ../redact), and so is worker.log, as the worker
 * prints it. Kept diffs are not: they are the agents' changes to the code,
 * what `odw apply` applies; nor are meta.json's `args`, what `odw rerun` and
 * `odw resume` start from — they are redacted where they are served.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { isCheckpointRequest, type CheckpointRequest } from "../control.js";
import type { EventSink, WorkflowEvent } from "../events.js";
import type { AgentResultRecord } from "../journal.js";
import { sourceHash } from "../provenance.js";
import type { Redactor } from "../redact.js";
import type { TranscriptPaths } from "../transcript.js";
import { VERSION } from "../version.generated.js";
import { readdirSafe, readJsonFile, writeJsonAtomic } from "./fs-util.js";

/** Terminal states: a run in one of these will not change again. */
export const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);

const META = "meta.json";
const STATUS = "status.json";
const EVENTS = "events.jsonl";
const RESULT = "result.json";
const ERROR = "error.json";
const CONTROL = "control.json";
const DECISIONS = "decisions.jsonl";
const LOG = "worker.log";
const AGENTS = "agents";
const AGENT_FILE = /^(\d+)\.json$/;

export interface CreateRunInput {
  /**
   * Absolute path of the script to run. With `inlineSource` set, pass "" — the
   * store writes the source as `workflow.js` inside the run directory and
   * records THAT path, so an inline script is archived with its run.
   */
  script: string;
  args: unknown;
  configPath?: string | null;
  source: string;
  budgetTotal?: number | null;
  /** The workflow's identity (meta.name). Drives the run's bucket; recorded in meta. */
  workflowName?: string | null;
  /** Workflow source to materialise inside the run dir (inline launches). */
  inlineSource?: string | null;
  /** Run-level adapter override: the default `agent()` adapter for this run. */
  adapter?: string | null;
  /** Run-level permission tier override (`--permissions`; ODW extension), else the config's. */
  permissions?: string | null;
  /** `"untrusted"` from `--untrusted` (ODW extension; see ../untrusted), else the config's trust. */
  trust?: string | null;
  /** `--sandbox container` [`--sandbox-image`] (ODW extension; see ../adapters/sandbox), else the config's sandbox. */
  sandbox?: { kind: "container"; image: string | null } | null;
  /** The Claude Code plugin the workflow came from (ODW extension; see ../workflows/plugins), recorded as `plugin`. */
  plugin?: { name: string; id: string; version: string | null; scope: string } | null;
  /** What resolving the workflow's name noted — a plugin's same-named workflow it did not pick — for the run's log. */
  workflowNotes?: string[];
  /** Where the run was initiated from (e.g. "chat" for Chat Host runs, "eval" for `odw eval`'s). */
  origin?: string | null;
  /** The `odw eval` cell this run is one repeat of (ODW extension); written to meta only when set. */
  eval?: EvalRunTag | null;
  /** The agent whose conflicts this run resolves for `odw apply --resolve` (ODW extension); written to meta only when set. */
  applyResolve?: ResolveLink | null;
  /**
   * `odw resume`: the run whose saved agent results this run replays, and its
   * directory (where the worker reads them — the runs may live in different
   * runs roots).
   */
  resumedFrom?: { runId: string; dir: string } | null;
  /** `odw run --dry` (ODW extension; see ../wftest): every agent gets a stub, no model is called; written to meta only when set. */
  dry?: boolean | null;
  /** `odw run --record` (ODW extension): the test file the run is kept in as a case, and the workflow it names; written to meta only when set. */
  record?: { file: string; workflow: string } | null;
  /**
   * Where the run came from when a signed trigger started it (ODW extension;
   * see ../triggers): written to meta as `context`, handed to notify hooks.
   */
  context?: Record<string, unknown> | null;
  /**
   * `--deadline <seconds>` (ODW extension): the worker stops the run that many
   * seconds after it was created. Written to meta as `deadline: { seconds, at }`.
   */
  deadlineSeconds?: number | null;
}

/**
 * Which `odw eval` run this is (ODW extension; see ../eval): the eval's name,
 * the case, the adapter the cell names, and which repeat (from 1). Kept in
 * meta.json as `eval`, beside `origin: "eval"`.
 */
export interface EvalRunTag {
  name: string;
  case: string;
  adapter: string;
  repeat: number;
}

/**
 * A link between a run and the resolver run `odw apply --resolve` started for
 * one of its agents (ODW extension): the other run's id, and the agent. The
 * resolver's meta.json keeps it as `applyResolve`; the agent's run appends it
 * to `resolvedBy`.
 */
export interface ResolveLink {
  runId: string;
  agentId: number;
}

/** A run plus the workflow it belongs to, returned by listing. */
export interface RunRef {
  runId: string;
  workflowName: string | null;
}

/** Optional fingerprints also identify rewrites when a filesystem reuses an inode. */
export interface EventsCursor {
  offset: number;
  ino?: number;
  prefix?: string;
  boundary?: string;
}

const CURSOR_WINDOW_BYTES = 128;

function readWindow(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const count = readSync(fd, buf, 0, length, start);
  return buf.subarray(0, count).toString("base64");
}

export class RunStore {
  /** runId → its directory, primed on create/list so reads avoid a bucket scan. */
  private readonly dirCache = new Map<string, string>();

  constructor(readonly root: string) {}

  // --- creation & paths ------------------------------------------------------

  create(input: CreateRunInput): string {
    const runId = newRunId();
    const bucket = bucketFor(input.workflowName, input.inlineSource != null ? "workflow.js" : input.script);
    const dir = join(this.root, bucket, runId);
    mkdirSync(dir, { recursive: true });
    this.dirCache.set(runId, dir);
    let script = input.script;
    if (input.inlineSource != null) {
      // Materialise the inline source before meta.json so a reader never sees a
      // meta that points at a not-yet-written file.
      script = join(dir, "workflow.js");
      writeFileSync(script, input.inlineSource, "utf8");
    }
    const createdAt = now();
    writeJson(join(dir, META), {
      runId,
      script,
      args: input.args ?? null,
      configPath: input.configPath ?? null,
      source: input.source,
      budgetTotal: input.budgetTotal ?? null,
      workflowName: input.workflowName ?? null,
      adapter: input.adapter ?? null,
      permissions: input.permissions ?? null,
      ...(input.trust ? { trust: input.trust } : {}),
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      ...(input.plugin ? { plugin: input.plugin } : {}),
      ...(input.workflowNotes && input.workflowNotes.length > 0 ? { workflowNotes: input.workflowNotes } : {}),
      origin: input.origin ?? null,
      ...(input.eval ? { eval: input.eval } : {}),
      ...(input.applyResolve ? { applyResolve: input.applyResolve } : {}),
      ...(input.dry ? { dry: true } : {}),
      ...(input.record ? { record: input.record } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.deadlineSeconds ? { deadline: { seconds: input.deadlineSeconds, at: createdAt + input.deadlineSeconds } } : {}),
      resumedFrom: input.resumedFrom?.runId ?? null,
      resumedFromDir: input.resumedFrom?.dir ?? null,
      // First-class fact (not inferred from path topology): the script lives in
      // this run dir because it was launched from inline source. Drives the
      // worker's run-by-name divergence exemption and `odw rerun` re-archival.
      inline: input.inlineSource != null,
      // What ran, for `odw compare` (ODW extension; see ../provenance): this
      // odw's version, and the sha256 of the workflow source as launched.
      odwVersion: VERSION,
      sourceHash: sourceHash(input.inlineSource ?? readText(script)),
      createdAt,
    });
    writeJson(join(dir, STATUS), { runId, state: "pending", dispatched: 0, updatedAt: now() });
    return runId;
  }

  /** Locate a run's directory by id, across buckets (and legacy flat layout). */
  runDir(runId: string): string {
    const cached = this.dirCache.get(runId);
    if (cached) return cached;
    // Legacy flat layout: <root>/<runId>/.
    const flat = join(this.root, runId);
    if (existsSync(join(flat, META))) {
      this.dirCache.set(runId, flat);
      return flat;
    }
    // Bucketed layout: <root>/<bucket>/<runId>/.
    for (const entry of readdirSafe(this.root)) {
      if (!entry.isDirectory()) continue;
      const candidate = join(this.root, entry.name, runId);
      if (existsSync(join(candidate, META))) {
        this.dirCache.set(runId, candidate);
        return candidate;
      }
    }
    // Not found: the flat path, so existsSync(.../meta.json) stays false and the
    // caller's "no such run" handling is unchanged.
    return flat;
  }
  exists(runId: string): boolean {
    return existsSync(join(this.runDir(runId), META));
  }
  eventsPath(runId: string): string {
    return join(this.runDir(runId), EVENTS);
  }
  logPath(runId: string): string {
    return join(this.runDir(runId), LOG);
  }
  controlPath(runId: string): string {
    return join(this.runDir(runId), CONTROL);
  }
  decisionsPath(runId: string): string {
    return join(this.runDir(runId), DECISIONS);
  }

  // --- meta & status ---------------------------------------------------------

  readMeta(runId: string): Record<string, unknown> {
    return readJsonFile(join(this.runDir(runId), META)) ?? {};
  }
  /**
   * Note in meta.json that `odw apply --resolve` started resolver run `link`
   * for one of this run's agents: appended to `resolvedBy`, the one field of
   * meta.json written after the run was created.
   */
  addResolvedBy(runId: string, link: ResolveLink): void {
    const meta = this.readMeta(runId);
    const links = Array.isArray(meta.resolvedBy) ? meta.resolvedBy : [];
    writeJson(join(this.runDir(runId), META), { ...meta, resolvedBy: [...links, link] });
  }
  readStatus(runId: string): Record<string, unknown> {
    return readJsonFile(join(this.runDir(runId), STATUS)) ?? {};
  }
  updateStatus(runId: string, fields: Record<string, unknown>): Record<string, unknown> {
    const status = { ...this.readStatus(runId), ...fields, updatedAt: now() };
    writeJson(join(this.runDir(runId), STATUS), status);
    return status;
  }

  // --- events ----------------------------------------------------------------

  readEvents(runId: string): WorkflowEvent[] {
    const path = this.eventsPath(runId);
    if (!existsSync(path)) return [];
    const out: WorkflowEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as WorkflowEvent);
      } catch {
        // JsonlSink appends without fsync, so a live reader can catch the final
        // line mid-write. Skip the torn line; the next read sees it whole.
      }
    }
    return out;
  }

  /**
   * Incremental read for live observers: return the events appended since
   * `cursor` and the cursor to pass next time. The cursor only ever advances to
   * a byte offset just past a complete `\n`-terminated line, so a torn tail
   * (mid-append) is simply left for the next poll and a multi-byte character
   * can never be split. Size, inode, and fixed windows of previously consumed
   * bytes guard log rotation. Inodes can be reused immediately, so changed
   * prefix/boundary bytes also reset the cursor. These bounded checks assume an
   * append-only log; they are not an integrity check for arbitrary middle edits.
   * Window validation reads at most 256 old bytes, not the whole growing log.
   * `reset` is true when such a replacement was detected and the read restarted
   * from the top: the returned events then REPLACE everything read before.
   */
  readEventsSince(
    runId: string,
    cursor: EventsCursor,
  ): { events: WorkflowEvent[]; cursor: EventsCursor; reset: boolean } {
    const path = this.eventsPath(runId);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return { events: [], cursor, reset: false }; // not written yet (or transiently unreadable)
    }
    try {
      const stat = fstatSync(fd);
      const size = stat.size;
      const sameFile = cursor.ino === undefined || cursor.ino === stat.ino;
      const windowSize = Math.min(cursor.offset, CURSOR_WINDOW_BYTES);
      const unchanged = sameFile && size >= cursor.offset &&
        (cursor.prefix === undefined || readWindow(fd, 0, windowSize) === cursor.prefix) &&
        (cursor.boundary === undefined ||
          readWindow(fd, cursor.offset - windowSize, windowSize) === cursor.boundary);
      const offset = unchanged ? cursor.offset : 0;
      const reset = offset !== cursor.offset;
      const nextCursor = (nextOffset: number): EventsCursor => {
        const length = Math.min(nextOffset, CURSOR_WINDOW_BYTES);
        return {
          offset: nextOffset,
          ino: stat.ino,
          prefix: readWindow(fd, 0, length),
          boundary: readWindow(fd, nextOffset - length, length),
        };
      };
      if (size === offset) return { events: [], cursor: nextCursor(offset), reset };
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      const chunk = buf.subarray(0, read);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) return { events: [], cursor: nextCursor(offset), reset }; // torn tail only
      const events: WorkflowEvent[] = [];
      for (const line of chunk.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as WorkflowEvent);
        } catch {
          // Complete but unparsable line — skip it, same tolerance as readEvents.
        }
      }
      return { events, cursor: nextCursor(offset + lastNl + 1), reset };
    } finally {
      closeSync(fd);
    }
  }

  // --- result & error --------------------------------------------------------

  /** `redacted`: secrets in it were redacted (ODW extension), and result.json says so. */
  writeResult(runId: string, value: unknown, redacted = false): void {
    writeJson(join(this.runDir(runId), RESULT), { value: value ?? null, ...(redacted ? { redacted: true } : {}) });
  }
  readResult(runId: string): unknown {
    const payload = readJsonFile(join(this.runDir(runId), RESULT));
    return payload === null ? null : payload.value;
  }
  hasResult(runId: string): boolean {
    return existsSync(join(this.runDir(runId), RESULT));
  }
  writeError(runId: string, error: Record<string, unknown>): void {
    writeJson(join(this.runDir(runId), ERROR), error);
  }
  readError(runId: string): Record<string, unknown> | null {
    return readJsonFile(join(this.runDir(runId), ERROR));
  }

  // --- per-agent results -----------------------------------------------------

  /**
   * Save one completed agent's record as `agents/<agentId>.json`, atomically:
   * a reader polling a live run never sees half a result.
   */
  writeAgentResult(runId: string, rec: AgentResultRecord): void {
    if (!isAgentId(rec.agentId)) throw new Error(`invalid agentId ${String(rec.agentId)}`);
    const dir = join(this.runDir(runId), AGENTS);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, `${rec.agentId}.json`), { ...rec, value: rec.value ?? null });
  }
  /** One saved agent result, or null when that agent has none (not finished, failed, unknown). */
  readAgentResult(runId: string, agentId: number): AgentResultRecord | null {
    if (!isAgentId(agentId)) return null;
    const rec = readJsonFile<AgentResultRecord>(join(this.runDir(runId), AGENTS, `${agentId}.json`));
    return isAgentRecord(rec) ? rec : null;
  }
  /**
   * Where an isolated agent's change is kept as a unified diff (ODW
   * extension): `agents/<agentId>.diff`, there only when it changed anything.
   */
  agentDiffPath(runId: string, agentId: number): string {
    if (!isAgentId(agentId)) throw new Error(`invalid agentId ${String(agentId)}`);
    return join(this.runDir(runId), AGENTS, `${agentId}.diff`);
  }
  /**
   * Where an agent's transcript is kept as it runs (ODW extension): what its
   * CLI printed on stdout, `agents/<agentId>.transcript.jsonl`, and the end of
   * its stderr, `agents/<agentId>.stderr.txt` (see ../transcript).
   */
  agentTranscriptPaths(runId: string, agentId: number): TranscriptPaths {
    if (!isAgentId(agentId)) throw new Error(`invalid agentId ${String(agentId)}`);
    const dir = join(this.runDir(runId), AGENTS);
    return { transcript: join(dir, `${agentId}.transcript.jsonl`), stderr: join(dir, `${agentId}.stderr.txt`) };
  }
  /**
   * Where the brief of a fallback that handed an agent's work over is kept
   * (ODW extension; see ../handoff): `agents/<agentId>.handoff.md` — the
   * latest, when it was handed over more than once.
   */
  agentHandoffPath(runId: string, agentId: number): string {
    if (!isAgentId(agentId)) throw new Error(`invalid agentId ${String(agentId)}`);
    return join(this.runDir(runId), AGENTS, `${agentId}.handoff.md`);
  }
  /**
   * Where an agent's schema is written for a CLI that reads it from a file
   * (ODW extension; `flags.schema.mode: "file"`): `agents/<agentId>.schema.json`,
   * removed once each of its CLI runs ends.
   */
  agentSchemaPath(runId: string, agentId: number): string {
    if (!isAgentId(agentId)) throw new Error(`invalid agentId ${String(agentId)}`);
    return join(this.runDir(runId), AGENTS, `${agentId}.schema.json`);
  }
  /** Every saved agent result of a run, by agentId (call order). */
  listAgentResults(runId: string): AgentResultRecord[] {
    const dir = join(this.runDir(runId), AGENTS);
    const out: AgentResultRecord[] = [];
    for (const entry of readdirSafe(dir)) {
      // Temp files of an in-flight atomic write never match the pattern.
      if (!entry.isFile() || !AGENT_FILE.test(entry.name)) continue;
      const rec = readJsonFile<AgentResultRecord>(join(dir, entry.name));
      if (isAgentRecord(rec)) out.push(rec);
    }
    return out.sort((a, b) => a.agentId - b.agentId);
  }

  // --- control ---------------------------------------------------------------

  writeControl(runId: string, action: string): void {
    writeJson(this.controlPath(runId), { action, at: now() });
  }
  readControl(runId: string): string | null {
    const payload = readJsonFile(this.controlPath(runId));
    return payload === null ? null : ((payload.action as string) ?? null);
  }
  /** The control request whole: its action and when it was written (epoch seconds); null when none was. */
  readControlRequest(runId: string): { action: string | null; at: number | null } | null {
    const payload = readJsonFile(this.controlPath(runId));
    if (payload === null) return null;
    return {
      action: typeof payload.action === "string" ? payload.action : null,
      at: typeof payload.at === "number" ? payload.at : null,
    };
  }
  /**
   * Answer a waiting checkpoint() (ODW extension): one line appended to the
   * run's decisions.jsonl, stamped with `at`. Appending rewrites nothing, so
   * neither a stop or pause written to control.json at the same moment nor
   * another answer can be lost to it. The worker takes each request once (see
   * FileControl).
   */
  requestCheckpointDecision(runId: string, request: Omit<CheckpointRequest, "at">): void {
    appendFileSync(this.decisionsPath(runId), JSON.stringify({ ...request, at: now() }) + "\n");
  }
  /** The checkpoint answers written so far, oldest first; a malformed line, or one mid-append, is left out. */
  readCheckpointRequests(runId: string): CheckpointRequest[] {
    let text: string;
    try {
      text = readFileSync(this.decisionsPath(runId), "utf8");
    } catch {
      return []; // none written yet
    }
    const out: CheckpointRequest[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line) as unknown;
        if (isCheckpointRequest(request)) out.push(request);
      } catch {
        // A line still being appended: the next read sees it whole.
      }
    }
    return out;
  }

  // --- listing ---------------------------------------------------------------

  /**
   * Every known run, newest first. Walks at most two levels so it lists both the
   * bucketed layout (`<bucket>/<runId>/`) and any legacy flat run
   * (`<runId>/`) — a `meta.json` at level 1 marks a flat run, at level 2 a
   * bucketed one. Runs are sorted by runId descending (the id's timestamp prefix
   * makes that reverse-chronological).
   */
  listRuns(): RunRef[] {
    const out: RunRef[] = [];
    this.walkRuns((runId, dir, bucket) => {
      out.push({ runId, workflowName: readWorkflowName(dir) ?? bucket });
    });
    out.sort(byRunIdDesc);
    return out;
  }

  /**
   * Every known run id, newest first — {@link listRuns} without reading any
   * meta.json, for pollers (the dashboard) that only need ids. A directory
   * already known to be a run is not re-checked for its meta.json either, so a
   * steady-state listing costs one readdir per bucket.
   */
  listRunIds(): string[] {
    const out: string[] = [];
    this.walkRuns((runId) => {
      out.push(runId);
    });
    return out.sort().reverse();
  }

  /**
   * Runs for one workflow, newest first. Reads only that workflow's bucket — no
   * full-tree scan — so it stays cheap as the runs root grows.
   */
  listRunsForWorkflow(name: string): RunRef[] {
    const dir = join(this.root, slugify(name));
    const out: RunRef[] = [];
    for (const sub of readdirSafe(dir)) {
      if (!sub.isDirectory()) continue;
      const runDir = join(dir, sub.name);
      if (!existsSync(join(runDir, META))) continue;
      this.dirCache.set(sub.name, runDir);
      out.push({ runId: sub.name, workflowName: readWorkflowName(runDir) ?? name });
    }
    out.sort(byRunIdDesc);
    return out;
  }

  /**
   * Visit every run directory: at most two levels, so both the bucketed layout
   * (`<bucket>/<runId>/`) and any legacy flat run (`<runId>/`) are found — a
   * `meta.json` at level 1 marks a flat run, at level 2 a bucketed one.
   * `bucket` is the level-1 directory name for a bucketed run, else null.
   * Unreadable directories are skipped, never fatal.
   */
  private walkRuns(visit: (runId: string, dir: string, bucket: string | null) => void): void {
    for (const entry of readdirSafe(this.root)) {
      if (!entry.isDirectory()) continue;
      const lvl1 = join(this.root, entry.name);
      if (this.isRunDir(entry.name, lvl1)) {
        // Legacy flat run: the directory name is the runId.
        visit(entry.name, lvl1, null);
        continue;
      }
      // A bucket: descend exactly one level.
      for (const sub of readdirSafe(lvl1)) {
        if (!sub.isDirectory()) continue;
        const dir = join(lvl1, sub.name);
        if (this.isRunDir(sub.name, dir)) visit(sub.name, dir, entry.name);
      }
    }
  }

  /** Does `dir` hold run `runId` (a meta.json)? Known run dirs skip the stat. */
  private isRunDir(runId: string, dir: string): boolean {
    if (this.dirCache.get(runId) === dir) return true;
    if (!existsSync(join(dir, META))) return false;
    this.dirCache.set(runId, dir);
    return true;
  }
}

/**
 * An {@link EventSink} that appends each event to events.jsonl — its likely
 * secrets redacted, and the event marked `redacted: true`, once the worker has
 * given it the run's redactor (ODW extension; see ../redact).
 */
export class JsonlSink implements EventSink {
  redactor: Redactor | undefined;
  constructor(private readonly path: string) {}
  emit(ev: WorkflowEvent): void {
    appendFileSync(this.path, JSON.stringify(this.redactor ? this.redactor.record(ev) : ev) + "\n");
  }
}

// --- module helpers ----------------------------------------------------------

/** Newest-first comparator on runId (its timestamp prefix orders chronologically). */
function byRunIdDesc(a: RunRef, b: RunRef): number {
  return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
}

/** The bucket a run lands in: its workflow name (else the script's stem), slugified. */
function bucketFor(workflowName: string | null | undefined, script: string): string {
  const name = workflowName && workflowName.trim() ? workflowName : stemOf(script);
  return slugify(name);
}

/** Filename stem of a script path (basename without its extension). */
function stemOf(script: string): string {
  return basename(script).replace(/\.[^.]*$/, "");
}

/**
 * A filesystem-safe bucket name. meta.name may contain spaces or slashes, so
 * anything outside `[A-Za-z0-9._-]` collapses to a dash; the true name is kept
 * in meta.json. Empty or all-punctuation names fall back to a fixed bucket.
 */
function slugify(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return s.length ? s : "_workflow";
}

/** An agent id is a non-negative integer: it names a file, so nothing else may pass. */
function isAgentId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
}

/** A parsed agents/<id>.json that looks like a record (a hand-edited file may not). */
function isAgentRecord(rec: unknown): rec is AgentResultRecord {
  return rec !== null && typeof rec === "object" && !Array.isArray(rec) && isAgentId((rec as AgentResultRecord).agentId);
}

/** The recorded workflowName from a run directory's meta.json, or null. */
function readWorkflowName(dir: string): string | null {
  const meta = readJsonFile(join(dir, META));
  return meta && typeof meta.workflowName === "string" ? meta.workflowName : null;
}

function now(): number {
  return Date.now() / 1000;
}

/** A file's text, or null when it cannot be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, "0");
  return `${stamp}-${rand}`;
}

/** Run files are pretty-printed: they are meant to be read by people too. */
function writeJson(path: string, payload: unknown): void {
  writeJsonAtomic(path, payload, 2);
}
