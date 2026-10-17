import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

const STORAGE_VERSION = 1;

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

export class ChatStore {
  private readonly file: string;

  constructor(root: string, private readonly defaultSource: string) {
    this.file = join(root, "_chat", "sessions.json");
  }

  list(): ChatSessionSummary[] {
    return this.read().sessions.map(sessionSummary);
  }

  get(id: string): ChatSessionRecord | null {
    return this.read().sessions.find((s) => s.id === id) ?? null;
  }

  records(): ChatSessionRecord[] {
    return this.read().sessions;
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
    const data = this.read();
    data.sessions.unshift(session);
    this.write(data);
    return session;
  }

  appendUserMessage(id: string, text: string, kind?: ChatMessageKind): ChatSessionRecord {
    const data = this.read();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) throw new Error(`no such chat session: ${id}`);
    const ts = now();
    session.messages.push({ id: newId("msg"), role: "user", text, ts, ...(kind ? { kind } : {}) });
    if (session.title === "Untitled hosted turn") session.title = titleFrom(text);
    session.updatedAt = ts;
    this.write(data);
    return session;
  }

  appendAssistantMessage(
    id: string,
    text: string,
    kind?: ChatMessageKind,
    status?: ChatMessageStatus,
  ): ChatSessionRecord {
    const data = this.read();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) throw new Error(`no such chat session: ${id}`);
    const ts = now();
    session.messages.push({
      id: newId("msg"),
      role: "assistant",
      text,
      ts,
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
    });
    if (status === "streaming") session.state = "running";
    session.updatedAt = ts;
    this.write(data);
    return session;
  }

  updateMessage(
    id: string,
    messageId: string,
    patch: { text?: string; status?: ChatMessageStatus },
  ): ChatSessionRecord | null {
    const data = this.read();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) return null;
    const message = session.messages.find((m) => m.id === messageId);
    if (!message) return null;
    if (patch.text !== undefined) message.text = patch.text;
    if (patch.status !== undefined) message.status = patch.status;
    const ts = now();
    session.updatedAt = ts;
    const stillStreaming = session.messages.some((m) => m.status === "streaming");
    if (!stillStreaming && session.state === "running") session.state = "idle";
    this.write(data);
    return session;
  }

  appendToolRun(id: string, runId: string, workflow: string): ChatSessionRecord {
    const data = this.read();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) throw new Error(`no such chat session: ${id}`);
    const ts = now();
    session.linkedRuns.unshift({ runId, workflow });
    session.messages.push({
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
    });
    session.state = "running";
    session.updatedAt = ts;
    this.write(data);
    return session;
  }

  delete(id: string): boolean {
    const data = this.read();
    const next = data.sessions.filter((s) => s.id !== id);
    if (next.length === data.sessions.length) return false;
    data.sessions = next;
    this.write(data);
    return true;
  }

  private read(): ChatFile {
    if (!existsSync(this.file)) return { version: STORAGE_VERSION, sessions: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { version: STORAGE_VERSION, sessions: [] };
      }
      const sessions = (parsed as { sessions?: unknown }).sessions;
      if (!Array.isArray(sessions)) return { version: STORAGE_VERSION, sessions: [] };
      return { version: STORAGE_VERSION, sessions: sessions.filter(validSession) };
    } catch {
      return { version: STORAGE_VERSION, sessions: [] };
    }
  }

  private write(data: ChatFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}
