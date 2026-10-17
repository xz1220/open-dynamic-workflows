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
  RunDetail,
  RunSummary,
  SettingsSnapshot,
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
  events: (id: string, since = 0) =>
    getJSON<WorkflowEvent[]>(`/api/runs/${enc(id)}/events?since=${since}`),
  /** The newest events across runs plus running agents per adapter. */
  activity: (limit = 200) => getJSON<ActivitySnapshot>(`/api/activity?limit=${limit}`),
  result: (id: string) => getJSON<{ value: unknown }>(`/api/runs/${enc(id)}/result`),
  /** A completed agent's persisted output (404 when the server or run has none). */
  agentResult: (id: string, agentId: number) =>
    getJSON<AgentResultRecord>(`/api/runs/${enc(id)}/agents/${agentId}`),
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
};
