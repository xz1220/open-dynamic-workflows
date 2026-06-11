/**
 * Typed client for the `odw serve` API.
 *
 * Reads are unconditional; writes exist since the launch layer (generate / run /
 * save / control) and are loopback-only on the server side. Claude-provider
 * runs remain strictly read-only — the server refuses control for them.
 */
import type {
  AdapterListing,
  Capabilities,
  RunDetail,
  RunSummary,
  WorkflowDetail,
  WorkflowEvent,
  WorkflowSummary,
} from "./types";

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return (await r.json()) as T;
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

const enc = encodeURIComponent;

export const api = {
  runs: () => getJSON<RunSummary[]>("/api/runs"),
  run: (id: string) => getJSON<RunDetail>(`/api/runs/${enc(id)}`),
  events: (id: string, since = 0) =>
    getJSON<WorkflowEvent[]>(`/api/runs/${enc(id)}/events?since=${since}`),
  result: (id: string) => getJSON<{ value: unknown }>(`/api/runs/${enc(id)}/result`),
  workflows: () => getJSON<WorkflowSummary[]>("/api/workflows"),
  workflow: (name: string, provider?: string) =>
    getJSON<WorkflowDetail>(`/api/workflows/${enc(name)}${provider ? `?provider=${enc(provider)}` : ""}`),
  adapters: () => getJSON<AdapterListing[]>("/api/adapters"),
  capabilities: () => getJSON<Capabilities>("/api/capabilities"),

  // --- launch-layer writes ---
  generate: (body: { task: string; adapter?: string; source?: string }) =>
    postJSON<{ runId: string }>("/api/generate", body),
  launchRun: (body: { script?: string; name?: string; args?: unknown; adapter?: string; source?: string }) =>
    postJSON<{ runId: string }>("/api/runs", body),
  saveWorkflow: (body: {
    name: string;
    source?: string;
    fromRun?: string;
    scope: "global" | "project";
    projectDir?: string;
  }) => postJSON<{ path: string }>("/api/workflows", body),
  control: (id: string, action: "pause" | "resume" | "stop") =>
    postJSON<{ ok: boolean }>(`/api/runs/${enc(id)}/control`, { action }),
};
