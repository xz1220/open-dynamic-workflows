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
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** Validate a parsed sessions file; anything unusable reads as no sessions. */
function parseChatFile(parsed: unknown): ChatFile {
  const sessions =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { sessions?: unknown }).sessions
      : undefined;
  return { version: STORAGE_VERSION, sessions: Array.isArray(sessions) ? sessions.filter(validSession) : [] };
}

export class ChatStore {
  private readonly file: string;
  private readonly streamPersistMs: number;
  private readonly onError: (err: unknown) => void;
  private data: ChatFile | null = null;
  /** The file's signature as we last read or wrote it; anything else is someone else's write. */
  private diskSig = "";
  /** Memory holds changes the file does not (streaming text awaiting its write). */
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(root: string, private readonly defaultSource: string, opts: ChatStoreOptions = {}) {
    this.file = join(root, "_chat", "sessions.json");
    this.streamPersistMs = opts.streamPersistMs ?? STREAM_PERSIST_MS;
    this.onError =
      opts.onError ??
      ((err) => process.stderr.write(`odw chat store: write failed: ${(err as Error)?.message ?? String(err)}\n`));
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
    });
    return session;
  }

  appendUserMessage(id: string, text: string, kind?: ChatMessageKind): ChatSessionRecord {
    return this.writeThrough(() =>
      this.replace(id, (s) => {
        const ts = now();
        return {
          ...s,
          title: s.title === "Untitled hosted turn" ? titleFrom(text) : s.title,
          updatedAt: ts,
          messages: [...s.messages, { id: newId("msg"), role: "user", text, ts, ...(kind ? { kind } : {}) }],
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
        const message: ChatMessage = {
          id: newId("msg"),
          role: "assistant",
          text,
          ts,
          ...(kind ? { kind } : {}),
          ...(status ? { status } : {}),
        };
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
    messages[at] = {
      ...messages[at]!,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    const stillStreaming = messages.some((m) => m.status === "streaming");
    const next: ChatSessionRecord = {
      ...session,
      messages,
      updatedAt: now(),
      state: !stillStreaming && session.state === "running" ? "idle" : session.state,
    };
    data.sessions = data.sessions.slice();
    data.sessions[index] = next;
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
    return next;
  }

  /** The in-memory sessions, (re)read from disk on first use or after an outside write. */
  private load(): ChatFile {
    if (this.data && (this.dirty || statSig(this.file) === this.diskSig)) return this.data;
    // Stat before reading: a write racing the read shows up as a new signature next time.
    this.diskSig = statSig(this.file);
    this.data = parseChatFile(readJsonFile<unknown>(this.file));
    return this.data;
  }

  private persist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    // Write what is in memory — never re-load() here: an outside write landing
    // between our change and this write would otherwise swallow the change.
    const data = this.data ?? this.load();
    mkdirSync(dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, data);
    this.dirty = false;
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
