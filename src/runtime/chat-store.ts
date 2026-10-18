/**
 * The Chat Host's session store (L5): every session of `odw serve`'s local
 * chat, persisted as one JSON file under the runs root
 * (`<runsRoot>/_chat/sessions.json`).
 *
 * Sessions are served from memory. Structural changes (a new session, a
 * message, a linked run, a deletion) are written through at once; a streaming
 * reply's text changes many times a second, so those updates stay in memory
 * and are persisted at most once per {@link STREAM_PERSIST_MS} — and at once
 * when the message settles, or on {@link ChatStore.flush} (server shutdown).
 * Objects handed out are never mutated afterwards (copy-on-write), so a caller
 * may hold a session while the stream keeps updating it. If another process
 * rewrites the file, the next read picks its version up.
 *
 * Given the run's {@link Redactor} (an ODW extension; see ../redact), what it
 * keeps has its likely secrets replaced by `«redacted:<kind>»` before it is
 * kept — in memory, so served, and on disk — a message that had any marked
 * `redacted: true`. What a person typed (role "user", the run results posted
 * as one included) is their data: token shapes only, as for a run's result.
 * What an agent said (Codex's replies, its errors) gets the environment's
 * values too. A reply still streaming keeps only what a secret could no
 * longer be completing — its whole lines — until it settles. Sessions read
 * from disk are redacted as they are read: a file written before redaction
 * was on gets its secrets out once it is next written.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { hasMarker, type Redactor } from "../redact.js";
import { readJsonFile, statSig, writeJsonAtomic } from "./fs-util.js";

export type ChatRole = "user" | "assistant" | "tool";
export type ChatSessionState = "running" | "idle" | "done";
export type ChatMessageStatus = "streaming" | "done" | "failed";
export type ChatToolStatus = "running" | "done" | "failed" | "stale";
export type ChatMessageKind = "chat.ready" | "chat.linked" | "chat.recorded" | "chat.odw_result";

export interface ChatToolEvent {
  type: string;
  label: string;
  ts: number;
}

export interface ChatToolCall {
  name: "odw.run";
  status: ChatToolStatus;
  workflow: string;
  runId: string;
  progress: number;
  phase: string;
  events: ChatToolEvent[];
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
  kind?: ChatMessageKind;
  status?: ChatMessageStatus;
  tool?: ChatToolCall;
  /** Likely secrets in its text were replaced by `«redacted:<kind>»` before it was kept (ODW extension). */
  redacted?: boolean;
}

export interface ChatLinkedRunRef {
  runId: string;
  workflow: string;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  source: string;
  state: ChatSessionState;
  updatedAt: number;
  messages: ChatMessage[];
  linkedRuns: ChatLinkedRunRef[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  source: string;
  state: ChatSessionState;
  updatedAt: number;
  lastMessage: string;
  linkedRuns: number;
}

export interface ChatStoreOptions {
  /** How long streaming-text changes may stay unpersisted (ms). */
  streamPersistMs?: number;
  /** Where a failed background write is reported (it cannot be thrown to anyone). */
  onError?: (err: unknown) => void;
  /** What keeps likely secrets out of what the store keeps (ODW extension); absent: nothing is redacted. */
  redactor?: Redactor;
}

const STORAGE_VERSION = 1;
/** Streaming text is persisted at most this often. */
const STREAM_PERSIST_MS = 1000;

interface ChatFile {
  version: number;
  sessions: ChatSessionRecord[];
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled hosted turn";
  return clean.length > 54 ? `${clean.slice(0, 51)}...` : clean;
}

/** The sidebar row for a session (its stored state; callers may refine it). */
export function sessionSummary(s: ChatSessionRecord): ChatSessionSummary {
  return {
    id: s.id,
    title: s.title,
    source: s.source,
    state: s.state,
    updatedAt: s.updatedAt,
    lastMessage: summaryText(s.messages),
    linkedRuns: s.linkedRuns.length,
  };
}

function summaryText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i]!.text.trim();
    if (text) return text;
  }
  return "";
}

function validMessage(value: unknown): value is ChatMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant" || m.role === "tool") &&
    typeof m.text === "string" &&
    typeof m.ts === "number" &&
    (m.kind === undefined ||
      m.kind === "chat.ready" ||
      m.kind === "chat.linked" ||
      m.kind === "chat.recorded" ||
      m.kind === "chat.odw_result") &&
    (m.status === undefined || m.status === "streaming" || m.status === "done" || m.status === "failed")
  );
}

function validSession(value: unknown): value is ChatSessionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    typeof s.source === "string" &&
    (s.state === "running" || s.state === "idle" || s.state === "done") &&
    typeof s.updatedAt === "number" &&
    Array.isArray(s.messages) &&
    s.messages.every(validMessage) &&
    Array.isArray(s.linkedRuns)
  );
}

/**
 * What a redactor makes of a message's text (ODW extension): what a person
 * typed is their data — token shapes only; anything else is an agent's.
 */
function policyFor(role: ChatRole, redactor: Redactor): Redactor {
  return role === "user" ? redactor.shapes : redactor;
}

/** `message` with `text` kept as the redactor allows, marked `redacted` when it holds a marker. */
function withText(message: ChatMessage, text: string, redactor: Redactor | undefined): ChatMessage {
  const kept = redactor ? policyFor(message.role, redactor).text(text) : text;
  const { redacted: _was, ...rest } = message;
  return redactor?.active && hasMarker(kept) ? { ...rest, text: kept, redacted: true } : { ...rest, text: kept };
}

/** A session read from disk with its likely secrets redacted (a file kept before redaction was on). */
function redactSession(session: ChatSessionRecord, redactor: Redactor): ChatSessionRecord {
  let changed = false;
  const messages = session.messages.map((message) => {
    if (message.redacted === true) return message;
    const next = withText(message, message.text, redactor);
    if (next.text === message.text) return message;
    changed = true;
    return next;
  });
  const title = redactor.shapes.text(session.title);
  return changed || title !== session.title ? { ...session, title, messages } : session;
}

/** Validate a parsed sessions file — redacted, given a redactor; anything unusable reads as no sessions. */
function parseChatFile(parsed: unknown, redactor?: Redactor): ChatFile {
  const sessions =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { sessions?: unknown }).sessions
      : undefined;
  const valid = Array.isArray(sessions) ? sessions.filter(validSession) : [];
  return { version: STORAGE_VERSION, sessions: redactor?.active ? valid.map((s) => redactSession(s, redactor)) : valid };
}

export class ChatStore {
  private readonly file: string;
  private readonly streamPersistMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly redactor: Redactor | undefined;
  private data: ChatFile | null = null;
  /** The file's signature as we last read or wrote it; anything else is someone else's write. */
  private diskSig = "";
  /** Memory holds changes the file does not (streaming text awaiting its write). */
  private dirty = false;
  /** Sessions this process changed (or created) / deleted since it last wrote. */
  private readonly touched = new Set<string>();
  private readonly deleted = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(root: string, private readonly defaultSource: string, opts: ChatStoreOptions = {}) {
    this.file = join(root, "_chat", "sessions.json");
    this.streamPersistMs = opts.streamPersistMs ?? STREAM_PERSIST_MS;
    this.onError =
      opts.onError ??
      ((err) => process.stderr.write(`odw chat store: write failed: ${(err as Error)?.message ?? String(err)}\n`));
    this.redactor = opts.redactor;
  }

  list(): ChatSessionSummary[] {
    return this.load().sessions.map(sessionSummary);
  }

  get(id: string): ChatSessionRecord | null {
    return this.load().sessions.find((s) => s.id === id) ?? null;
  }

  records(): readonly ChatSessionRecord[] {
    return this.load().sessions;
  }

  create(source?: string): ChatSessionRecord {
    const ts = now();
    const session: ChatSessionRecord = {
      id: newId("chat"),
      title: "Untitled hosted turn",
      source: source?.trim() || this.defaultSource,
      state: "idle",
      updatedAt: ts,
      linkedRuns: [],
      messages: [
        {
          id: newId("msg"),
          role: "assistant",
          ts,
          kind: "chat.ready",
          text: "This local Chat Host session is ready. Mention ODW or workflow to attach a real ODW run to the turn.",
        },
      ],
    };
    this.writeThrough(() => {
      const data = this.load();
      data.sessions = [session, ...data.sessions];
      this.touched.add(session.id);
    });
    return session;
  }

  appendUserMessage(id: string, text: string, kind?: ChatMessageKind): ChatSessionRecord {
    return this.writeThrough(() =>
      this.replace(id, (s) => {
        const ts = now();
        const message = withText({ id: newId("msg"), role: "user", text: "", ts, ...(kind ? { kind } : {}) }, text, this.redactor);
        return {
          ...s,
          // The title comes from the message as kept.
          title: s.title === "Untitled hosted turn" ? titleFrom(message.text) : s.title,
          updatedAt: ts,
          messages: [...s.messages, message],
        };
      }),
    );
  }

  appendAssistantMessage(
    id: string,
    text: string,
    kind?: ChatMessageKind,
    status?: ChatMessageStatus,
  ): ChatSessionRecord {
    return this.writeThrough(() =>
      this.replace(id, (s) => {
        const ts = now();
        const message = withText(
          { id: newId("msg"), role: "assistant", text: "", ts, ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
          text,
          this.redactor,
        );
        return {
          ...s,
          state: status === "streaming" ? "running" : s.state,
          updatedAt: ts,
          messages: [...s.messages, message],
        };
      }),
    );
  }

  /**
   * Patch one message. A text-only patch (a streaming reply growing) is kept
   * in memory and persisted within {@link STREAM_PERSIST_MS}; a status change
   * (the reply settled) is written at once. Either way the in-memory session
   * reflects the patch even if the write fails — a settled message must never
   * stay "streaming" and block its session — and a failed write is retried.
   * `text` is the whole text so far, as it was said: with a redactor, a
   * streaming patch keeps what {@link Redactor.ready} lets go of it, and a
   * settled one all of it, redacted.
   */
  updateMessage(
    id: string,
    messageId: string,
    patch: { text?: string; status?: ChatMessageStatus },
  ): ChatSessionRecord | null {
    const data = this.load();
    const index = data.sessions.findIndex((s) => s.id === id);
    const session = data.sessions[index];
    const at = session ? session.messages.findIndex((m) => m.id === messageId) : -1;
    if (!session || at === -1) return null;
    const messages = session.messages.slice();
    const patched: ChatMessage = { ...messages[at]!, ...(patch.status !== undefined ? { status: patch.status } : {}) };
    let text = patch.text;
    // A reply still arriving keeps no part of a secret it may be completing (ODW extension).
    if (text !== undefined && patch.status === undefined && this.redactor?.active) text = text.slice(0, this.redactor.ready(text));
    messages[at] = text !== undefined ? withText(patched, text, this.redactor) : patched;
    const stillStreaming = messages.some((m) => m.status === "streaming");
    const next: ChatSessionRecord = {
      ...session,
      messages,
      updatedAt: now(),
      state: !stillStreaming && session.state === "running" ? "idle" : session.state,
    };
    data.sessions = data.sessions.slice();
    data.sessions[index] = next;
    this.touched.add(id);
    this.dirty = true;
    if (patch.status === undefined) {
      this.persistSoon();
      return next;
    }
    try {
      this.persist();
    } catch (err) {
      this.persistSoon(); // retry later; memory already holds the settled message
      throw err;
    }
    return next;
  }

  appendToolRun(id: string, runId: string, workflow: string): ChatSessionRecord {
    return this.writeThrough(() =>
      this.replace(id, (s) => {
        const ts = now();
        return {
          ...s,
          state: "running",
          updatedAt: ts,
          linkedRuns: [{ runId, workflow }, ...s.linkedRuns],
          messages: [
            ...s.messages,
            {
              id: newId("msg"),
              role: "tool",
              text: "ODW run requested by the local Chat Host.",
              ts,
              tool: {
                name: "odw.run",
                status: "running",
                workflow,
                runId,
                progress: 0,
                phase: "Starting",
                events: [{ type: "run_started", label: "run requested", ts }],
              },
            },
          ],
        };
      }),
    );
  }

  delete(id: string): boolean {
    if (!this.get(id)) return false;
    this.writeThrough(() => {
      const data = this.load();
      data.sessions = data.sessions.filter((s) => s.id !== id);
      this.touched.delete(id);
      this.deleted.add(id);
    });
    return true;
  }

  /** Persist pending streaming text now (server shutdown). */
  flush(): void {
    if (this.dirty) this.persist();
  }

  /**
   * Apply a structural change and write it through. On a failed write the
   * change is rolled back and the error thrown, so a failed request leaves
   * nothing behind (sessions arrays are never mutated in place, so the old
   * array is exactly the previous state).
   */
  private writeThrough<T>(change: () => T): T {
    const data = this.load();
    const before = data.sessions;
    const result = change();
    try {
      this.persist();
    } catch (err) {
      data.sessions = before;
      throw err;
    }
    return result;
  }

  /** Swap session `id` for `fn(session)`; throws for an unknown id. */
  private replace(id: string, fn: (s: ChatSessionRecord) => ChatSessionRecord): ChatSessionRecord {
    const data = this.load();
    const index = data.sessions.findIndex((s) => s.id === id);
    if (index === -1) throw new Error(`no such chat session: ${id}`);
    const next = fn(data.sessions[index]!);
    data.sessions = data.sessions.slice();
    data.sessions[index] = next;
    this.touched.add(id);
    return next;
  }

  /** The in-memory sessions, (re)read from disk on first use or after an outside write. */
  private load(): ChatFile {
    if (this.data && (this.dirty || statSig(this.file) === this.diskSig)) return this.data;
    // Stat before reading: a write racing the read shows up as a new signature next time.
    this.diskSig = statSig(this.file);
    this.data = parseChatFile(readJsonFile<unknown>(this.file), this.redactor);
    return this.data;
  }

  private persist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    // Write what is in memory — never a plain re-load() here: an outside write
    // landing between our change and this write would swallow the change. But
    // another `odw serve` sharing the file may have written since we last
    // synced: then merge — its sessions, with ours replacing the ones we
    // touched and dropping the ones we deleted — instead of clobbering them.
    let data = this.data ?? this.load();
    if (this.data && statSig(this.file) !== this.diskSig) {
      const disk = parseChatFile(readJsonFile<unknown>(this.file), this.redactor);
      const ours = new Map(data.sessions.map((s) => [s.id, s]));
      const onDisk = new Set(disk.sessions.map((s) => s.id));
      const sessions = disk.sessions
        .filter((s) => !this.deleted.has(s.id))
        .map((s) => (this.touched.has(s.id) ? (ours.get(s.id) ?? s) : s));
      for (const s of data.sessions) if (this.touched.has(s.id) && !onDisk.has(s.id)) sessions.unshift(s);
      data = { ...disk, sessions };
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, data);
    this.data = data; // only once written: a failed write leaves memory for the caller to roll back
    this.dirty = false;
    this.touched.clear();
    this.deleted.clear();
    this.diskSig = statSig(this.file);
  }

  private persistSoon(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.persist();
      } catch (err) {
        this.onError(err);
      }
    }, this.streamPersistMs);
    this.persistTimer.unref?.();
  }
}
