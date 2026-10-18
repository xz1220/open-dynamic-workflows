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
  EvalReport,
  EvalReportSummary,
  RunComparison,
  RunDetail,
  WorkflowEstimate,
  WorkflowMemory,
  RunNote,
  RunSummary,
  ReviewMark,
  ReviewQueue,
  ScheduleView,
  SettingsSnapshot,
  TranscriptPage,
  WorkflowDetail,
  WorkflowEvent,
  WorkflowSummary,
} from "./types";

/** A refused request: its HTTP status (401: this dashboard needs a token). */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJSON<T>(url: string): Promise<T> {
  // Same-origin fetches send the token cookie of `odw serve --token` on their own.
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const payload = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new HttpError(String(payload.error ?? `${url} → ${r.status}`), r.status);
  return payload as T;
}

/**
 * Trade a token (`odw serve --token`) for the server's HttpOnly cookie: one
 * request with `?token=`. "ok", or why not: "wrong" (401) or "locked" (429:
 * too many wrong tokens from here for a while).
 */
async function signIn(token: string): Promise<"ok" | "wrong" | "locked"> {
  const r = await fetch(`/api/capabilities?token=${encodeURIComponent(token)}`, { headers: { accept: "application/json" } });
  return r.ok ? "ok" : r.status === 429 ? "locked" : "wrong";
}

/** POST JSON; throws with the server's error message so forms can show it. */
async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    // A refused checkpoint edit says each way it misses the schema.
    const problems = Array.isArray(payload.problems) ? `\n${payload.problems.map(String).join("\n")}` : "";
    throw new Error(String(payload.error ?? `${url} → ${r.status}`) + problems);
  }
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
  /** A run's notes board (ODW extension), oldest first. */
  notes: (id: string) => getJSON<RunNote[]>(`/api/runs/${enc(id)}/notes`),
  /** The kept `odw eval` reports, newest first. */
  evals: () => getJSON<EvalReportSummary[]>("/api/evals"),
  evalReport: (name: string, id: string) => getJSON<EvalReport>(`/api/evals/${enc(name)}/${enc(id)}`),
  /** What changed between two of ODW's runs (B against A). */
  compare: (a: string, b: string) => getJSON<RunComparison>(`/api/compare?a=${enc(a)}&b=${enc(b)}`),
  /** What a run of a workflow is likely to cost and take, from its earlier runs (ODW extension). */
  memory: (workflow: string) => getJSON<WorkflowMemory[]>(`/api/memory?workflow=${enc(workflow)}`),
  estimate: (workflow: string, sourceHash?: string) =>
    getJSON<WorkflowEstimate>(`/api/estimate?workflow=${enc(workflow)}${sourceHash ? `&sourceHash=${enc(sourceHash)}` : ""}`),
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
  /** The review queue (ODW extension): kept diffs not dealt with yet, riskiest first; `all` includes the marked. */
  review: (all = false) => getJSON<ReviewQueue>(`/api/review${all ? "?all=1" : ""}`),
  /** `odw schedule` entries; empty from servers without schedules. */
  schedules: () => getJSON<ScheduleView[]>("/api/schedules"),
  workflows: () => getJSON<WorkflowSummary[]>("/api/workflows"),
  workflow: (name: string, provider?: string) =>
    getJSON<WorkflowDetail>(`/api/workflows/${enc(name)}${provider ? `?provider=${enc(provider)}` : ""}`),
  capabilities: () => getJSON<Capabilities>("/api/capabilities"),
  signIn,
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
  /** Mark an agent's kept diff on the review queue (ODW extension, loopback only). */
  markReview: (id: string, agentId: number, state: ReviewMark["state"], note?: string) =>
    postJSON<{ ok: boolean }>(`/api/runs/${enc(id)}/agents/${agentId}/review`, { state, ...(note ? { note } : {}) }),
};
