/**
 * Typed client for the `odw serve` API.
 *
 * Reads are unconditional; chat writes and run control are loopback-only on the
 * server side. Claude-provider runs remain strictly read-only — the server
 * refuses control for them.
 */
import type {
  ActivitySnapshot,
  AgentResultRecord,
  Capabilities,
  ChatSession,
  ChatSessionSummary,
  RunComparison,
  RunDetail,
  RunSummary,
  ScheduleView,
  SettingsSnapshot,
  TranscriptPage,
  WorkflowDetail,
  WorkflowEvent,
  WorkflowSummary,
} from "./types";

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const payload = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(payload.error ?? `${url} → ${r.status}`));
  return payload as T;
}

/** POST JSON; throws with the server's error message so forms can show it. */
async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(payload.error ?? `${url} → ${r.status}`));
  return payload as T;
}

async function deleteJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    method: "DELETE",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  const payload = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(payload.error ?? `${url} → ${r.status}`));
  return payload as T;
}

const enc = encodeURIComponent;

export const api = {
  runs: () => getJSON<RunSummary[]>("/api/runs"),
  run: (id: string) => getJSON<RunDetail>(`/api/runs/${enc(id)}`),
  /** What changed between two of ODW's runs (B against A). */
  compare: (a: string, b: string) => getJSON<RunComparison>(`/api/compare?a=${enc(a)}&b=${enc(b)}`),
  events: (id: string, since = 0) =>
    getJSON<WorkflowEvent[]>(`/api/runs/${enc(id)}/events?since=${since}`),
  /** The newest events across runs plus running agents per adapter. */
  activity: (limit = 200) => getJSON<ActivitySnapshot>(`/api/activity?limit=${limit}`),
  result: (id: string) => getJSON<{ value: unknown }>(`/api/runs/${enc(id)}/result`),
  /** A completed agent's persisted output (404 when the server or run has none). */
  agentResult: (id: string, agentId: number) =>
    getJSON<AgentResultRecord>(`/api/runs/${enc(id)}/agents/${agentId}`),
  /** An isolated agent's unified diff as text; null when it changed nothing (or the server keeps no diffs). */
  agentDiff: async (id: string, agentId: number): Promise<string | null> => {
    const r = await fetch(`/api/runs/${enc(id)}/agents/${agentId}/diff`, { headers: { accept: "text/plain" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`diff of agent ${agentId} → ${r.status}`);
    return r.text();
  },
  /** A page of an agent's transcript from `since`; null when the agent kept none (404). */
  transcript: async (id: string, agentId: number, since: number): Promise<TranscriptPage | null> => {
    const r = await fetch(`/api/runs/${enc(id)}/agents/${agentId}/transcript?since=${since}`, { headers: { accept: "application/json" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`transcript of agent ${agentId} → ${r.status}`);
    return (await r.json()) as TranscriptPage;
  },
  /** `odw schedule` entries; empty from servers without schedules. */
  schedules: () => getJSON<ScheduleView[]>("/api/schedules"),
  workflows: () => getJSON<WorkflowSummary[]>("/api/workflows"),
  workflow: (name: string, provider?: string) =>
    getJSON<WorkflowDetail>(`/api/workflows/${enc(name)}${provider ? `?provider=${enc(provider)}` : ""}`),
  capabilities: () => getJSON<Capabilities>("/api/capabilities"),
  settings: () => getJSON<SettingsSnapshot>("/api/settings"),
  chatSessions: () => getJSON<ChatSessionSummary[]>("/api/chat/sessions"),
  chatSession: (id: string) => getJSON<ChatSession>(`/api/chat/sessions/${enc(id)}`),

  // --- local writes ---
  createChatSession: (body: { source?: string } = {}) => postJSON<ChatSession>("/api/chat/sessions", body),
  sendChatMessage: (id: string, body: { text: string; adapter?: string; source?: string }) =>
    postJSON<ChatSession>(`/api/chat/sessions/${enc(id)}/messages`, body),
  deleteChatSession: (id: string) => deleteJSON<{ ok: true }>(`/api/chat/sessions/${enc(id)}`),
  control: (id: string, action: "pause" | "resume" | "stop") =>
    postJSON<{ ok: boolean }>(`/api/runs/${enc(id)}/control`, { action }),
  /**
   * Approve or reject a pending checkpoint() (ODW runs, loopback only). An
   * approval may carry `payload`, an edit of the checkpoint's: the server
   * refuses one off its schema (400, with `problems`) or over 256 KiB (413).
   */
  checkpoint: (
    id: string,
    body:
      | { action: "approve"; checkpointId?: number; note?: string; payload?: unknown }
      | { action: "reject"; checkpointId?: number; note?: string },
  ) => postJSON<{ ok: boolean }>(`/api/runs/${enc(id)}/checkpoint`, body),
};
