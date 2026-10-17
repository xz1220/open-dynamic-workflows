/**
 * Central client state.
 *
 * The run *list* stays live over SSE (`/api/stream` pushes the whole list on
 * change). Focused detail (a single run's DAG/logs, the Activity stream) is
 * pulled by a route-aware poller in main.ts — incrementally: a run's events are
 * fetched with `?since=<count>` so a long log is downloaded once, and an
 * unchanged poll does not repaint. Every mutation calls emit(); the app morphs
 * the active view. Defensive throughout — a failed fetch never crashes the
 * window, it just leaves the last-known state and flips `conn`.
 */
import { api } from "./api";
import type {
  ActivityEvent,
  AgentResultRecord,
  Capabilities,
  ChatSession,
  ChatSessionSummary,
  Connection,
  RunDetail,
  RunSummary,
  SettingsSnapshot,
  WorkflowEvent,
  WorkflowSummary,
} from "./types";
import { ACTIVE, TERMINAL } from "./util";

type Listener = () => void;
/** A run left the active set (finished, failed, or was stopped). */
export type TransitionListener = (run: RunSummary, from: string) => void;

class Store {
  conn: Connection = "connecting";
  runs: RunSummary[] = [];
  /** True once the first run list arrived (SSE or fetch). */
  runsLoaded = false;
  workflows: WorkflowSummary[] | null = null;
  settings: SettingsSnapshot | null = null;
  chatSessions: ChatSessionSummary[] | null = null;
  chat: ChatSession | null = null;
  chatMissingId: string | null = null;
  chatError = "";
  chatSending = false;
  chatCreating = false;
  // Default writable = true (the loopback common case) until the probe answers,
  // so local use never flashes a read-only UI on first paint.
  capabilities: Capabilities = { writable: true };
  run: RunDetail | null = null;
  runEvents: WorkflowEvent[] = [];
  result: unknown = undefined;
  resultLoaded = false;
  activity: ActivityEvent[] = [];
  fleet: Record<string, number> = {};
  activityLoaded = false;
  /** Persisted agent outputs by `${runId}:${agentId}`; null = none available. */
  agentResults = new Map<string, AgentResultRecord | null>();

  private listeners = new Set<Listener>();
  private transitions = new Set<TransitionListener>();
  private es: EventSource | null = null;
  private backoff = 1000;
  private runSig = "";
  private chatSessionsTimer: number | null = null;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(): void {
    for (const l of this.listeners) l();
  }
  onTransition(l: TransitionListener): void {
    this.transitions.add(l);
  }

  /** Replace the run list, announcing runs that just left the active set. */
  private setRuns(next: RunSummary[]): void {
    if (this.runsLoaded) {
      const before = new Map(this.runs.map((r) => [r.runId, r.state]));
      for (const r of next) {
        const prev = before.get(r.runId);
        if (prev && ACTIVE.has(prev) && (TERMINAL.has(r.state) || r.state === "stale")) {
          for (const l of this.transitions) l(r, prev);
        }
      }
    }
    this.runs = next;
    this.runsLoaded = true;
  }

  /** Open the live run-list stream; reconnect with backoff on error. */
  connect(): void {
    try {
      this.es?.close();
      const es = new EventSource("/api/stream");
      this.es = es;
      es.addEventListener("runs", (e) => {
        try {
          this.setRuns(JSON.parse((e as MessageEvent).data) as RunSummary[]);
        } catch {
          /* ignore a torn frame */
        }
        this.conn = "live";
        this.backoff = 1000;
        this.emit();
      });
      // Servers that diff the run list push only what changed after the first
      // full `runs` frame: upserted summaries and removed run ids.
      es.addEventListener("runs-delta", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as { upsert?: RunSummary[]; remove?: string[] };
          this.setRuns(applyRunsDelta(this.runs, d.upsert ?? [], d.remove ?? []));
        } catch {
          return; // a torn delta: the next full frame (or reconnect) resyncs
        }
        this.conn = "live";
        this.emit();
      });
      es.addEventListener("chat", (e) => {
        let sessionId: string | null = null;
        try {
          const payload = JSON.parse((e as MessageEvent).data) as { sessionId?: unknown };
          sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
        } catch {
          sessionId = null;
        }
        // Streaming turns push many `chat` frames; coalesce the list refresh.
        if (this.chatSessionsTimer == null) {
          this.chatSessionsTimer = window.setTimeout(() => {
            this.chatSessionsTimer = null;
            void this.loadChatSessions();
          }, 300);
        }
        if (sessionId && (this.chat?.id === sessionId || this.chatMissingId === sessionId)) {
          void this.loadChatSession(sessionId);
        }
      });
      es.onerror = () => {
        this.conn = "reconnecting";
        this.emit();
        es.close();
        const wait = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 15000);
        setTimeout(() => this.connect(), wait);
      };
    } catch {
      // EventSource unavailable: fall back to plain polling of the run list.
      this.conn = "reconnecting";
      void this.loadRuns();
      setTimeout(() => this.connect(), 3000);
    }
  }

  async loadRuns(): Promise<void> {
    try {
      this.setRuns(await api.runs());
      this.emit();
    } catch {
      /* keep last-known */
    }
  }

  async loadWorkflows(): Promise<void> {
    try {
      this.workflows = await api.workflows();
    } catch {
      this.workflows = this.workflows ?? [];
    }
    this.emit();
  }

  async loadCapabilities(): Promise<void> {
    try {
      this.capabilities = await api.capabilities();
      this.emit();
    } catch {
      /* keep the optimistic default; a failed write still surfaces its 409 */
    }
  }

  async loadSettings(): Promise<void> {
    try {
      this.settings = await api.settings();
    } catch {
      /* the view shows its loading state */
    }
    this.emit();
  }

  async loadChatSessions(): Promise<void> {
    try {
      this.chatSessions = await api.chatSessions();
      this.emit();
    } catch (err) {
      this.chatSessions = this.chatSessions ?? [];
      this.chatError = (err as Error).message;
      this.emit();
    }
  }

  async loadChatSession(id: string): Promise<void> {
    try {
      this.chat = await api.chatSession(id);
      this.chatMissingId = null;
      this.chatError = "";
      this.emit();
    } catch (err) {
      this.chat = null;
      this.chatMissingId = id;
      this.chatError = (err as Error).message;
      this.emit();
    }
  }

  async createChatSession(source?: string): Promise<ChatSession | null> {
    this.chatCreating = true;
    this.chatError = "";
    this.emit();
    try {
      this.chat = await api.createChatSession(source ? { source } : {});
      this.chatMissingId = null;
      await this.loadChatSessions();
      return this.chat;
    } catch (err) {
      this.chatError = (err as Error).message;
      this.emit();
      return null;
    } finally {
      this.chatCreating = false;
      this.emit();
    }
  }

  async sendChatMessage(id: string, text: string): Promise<ChatSession | null> {
    this.chatSending = true;
    this.chatError = "";
    this.emit();
    try {
      this.chat = await api.sendChatMessage(id, { text });
      this.chatMissingId = null;
      await this.loadChatSessions();
      return this.chat;
    } catch (err) {
      this.chatError = (err as Error).message;
      this.emit();
      return null;
    } finally {
      this.chatSending = false;
      this.emit();
    }
  }

  async deleteChatSession(id: string): Promise<boolean> {
    this.chatError = "";
    try {
      await api.deleteChatSession(id);
      if (this.chat?.id === id) this.chat = null;
      if (this.chatMissingId === id) this.chatMissingId = null;
      await this.loadChatSessions();
      return true;
    } catch (err) {
      this.chatError = (err as Error).message;
      this.emit();
      return false;
    }
  }

  /** The run the Job view shows; loads for any other run are dropped. */
  focusedRunId: string | null = null;
  private runLoad: Promise<void> | null = null;
  private runLoadAgain = false;

  focusRun(id: string | null): void {
    if (this.focusedRunId === id) return;
    this.focusedRunId = id;
    this.clearRun();
  }

  /**
   * Refresh the focused run. Events are fetched incrementally (only what was
   * appended since the last poll), overlapping refreshes coalesce into one
   * follow-up, and nothing repaints when neither the folded detail nor the
   * event log moved.
   */
  async loadRun(id: string): Promise<void> {
    if (this.focusedRunId !== id) return;
    if (this.runLoad) {
      this.runLoadAgain = true;
      return this.runLoad;
    }
    this.runLoad = this.fetchRun(id);
    try {
      await this.runLoad;
    } finally {
      this.runLoad = null;
    }
    if (this.runLoadAgain) {
      this.runLoadAgain = false;
      await this.loadRun(id);
    }
  }

  private async fetchRun(id: string): Promise<void> {
    const same = this.run?.runId === id;
    const since = same ? this.runEvents.length : 0;
    try {
      const [run, events] = await Promise.all([api.run(id), api.events(id, since)]);
      if (this.focusedRunId !== id) return; // navigated away mid-flight
      const sig = JSON.stringify(run);
      if (same && sig === this.runSig && events.length === 0) return;
      this.run = run;
      this.runSig = sig;
      this.runEvents = same ? this.runEvents.concat(events) : events;
      this.emit();
    } catch {
      /* keep last-known */
    }
  }

  async loadResult(id: string): Promise<void> {
    try {
      const r = await api.result(id);
      this.result = r.value;
    } catch {
      this.result = undefined;
    }
    this.resultLoaded = true;
    this.emit();
  }

  /** Fetch one completed agent's output once; later calls are cache hits. */
  async loadAgentResult(runId: string, agentId: number): Promise<void> {
    const key = `${runId}:${agentId}`;
    if (this.agentResults.has(key)) return;
    if (this.agentResults.size > 400) this.agentResults.clear();
    this.agentResults.set(key, null);
    try {
      this.agentResults.set(key, await api.agentResult(runId, agentId));
    } catch {
      return; // not persisted (older server, Claude run, still running) — stays null
    }
    if (this.run?.runId === runId) this.emit();
  }

  clearRun(): void {
    this.run = null;
    this.runSig = "";
    this.runEvents = [];
    this.result = undefined;
    this.resultLoaded = false;
  }

  /**
   * Refresh the Activity view: the newest events across runs and the running
   * agents per adapter, aggregated server-side in one request. Older servers
   * without `/api/activity` fall back to fanning out over the newest runs.
   */
  async loadActivity(): Promise<void> {
    try {
      const snap = await api.activity(200);
      this.activity = snap.events;
      this.fleet = snap.fleet;
    } catch {
      await this.loadActivityFallback();
    }
    this.activityLoaded = true;
    this.emit();
  }

  private async loadActivityFallback(): Promise<void> {
    const recent = this.runs.slice(0, 8);
    const active = this.runs.filter((r) => ACTIVE.has(r.state));
    const [tails, details] = await Promise.all([
      Promise.all(
        recent.map(async (r) => {
          try {
            const evs = await api.events(r.runId);
            return evs.slice(-24).map(
              (e): ActivityEvent => ({
                ...e,
                runId: r.runId,
                run: r.name,
                adapter: typeof e.adapter === "string" ? e.adapter : null,
                provider: r.provider,
              }),
            );
          } catch {
            return [] as ActivityEvent[];
          }
        }),
      ),
      Promise.all(active.map((r) => api.run(r.runId).catch(() => null))),
    ]);
    this.activity = tails.flat().sort((a, b) => b.ts - a.ts).slice(0, 200);
    const fleet: Record<string, number> = {};
    for (const d of details) {
      for (const a of d?.agents ?? []) {
        if (a.state !== "running") continue;
        const key = a.adapter ?? "—";
        fleet[key] = (fleet[key] ?? 0) + 1;
      }
    }
    this.fleet = fleet;
  }
}

/** Merge an SSE delta into the run list, keeping newest-first order. */
export function applyRunsDelta(runs: RunSummary[], upsert: RunSummary[], remove: string[]): RunSummary[] {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  for (const id of remove) byId.delete(id);
  for (const r of upsert) byId.set(r.runId, r);
  return [...byId.values()].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0),
  );
}

export const store = new Store();
