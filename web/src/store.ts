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
import { api, HttpError } from "./api";
import { parseDiff, type ParsedDiff } from "./components/diff";
import type {
  ActivityEvent,
  AgentResultRecord,
  Capabilities,
  ChatSession,
  ChatSessionSummary,
  Connection,
  RunComparison,
  RunDetail,
  RunSummary,
  ScheduleView,
  SettingsSnapshot,
  TranscriptEntry,
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
  /** The server wants a token (`odw serve --token`) this browser has not given: show the token screen. */
  needsToken = false;
  /** Why the last token was refused ("wrong" | "locked"), for the token screen. */
  tokenError: "wrong" | "locked" | null = null;
  run: RunDetail | null = null;
  runEvents: WorkflowEvent[] = [];
  result: unknown = undefined;
  resultLoaded = false;
  activity: ActivityEvent[] = [];
  fleet: Record<string, number> = {};
  activityLoaded = false;
  private activitySig = "";
  /** Persisted agent outputs by `${runId}:${agentId}`; null = none available. */
  agentResults = new Map<string, AgentResultRecord | null>();
  /** Agent transcripts by `runId:agentId`, loaded page by page and kept growing while the agent runs. */
  transcripts = new Map<string, TranscriptState>();
  private transcriptsLoading = new Set<string>();
  /** `odw schedule` entries for the Jobs page (empty until loaded, or from older servers). */
  schedules: ScheduleView[] = [];
  /** The comparison on screen, by "a/b"; null while it loads. */
  comparison: { key: string; value: RunComparison | null; error: string | null } | null = null;
  /** Parsed diffs of worktree agents by `runId:agentId`; null = none to show. */
  agentDiffs = new Map<string, ParsedDiff | null>();
  private diffsLoading = new Set<string>();

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
        const ended = prev && ACTIVE.has(prev) && (TERMINAL.has(r.state) || r.state === "stale");
        // A run that starts waiting at a checkpoint() needs a person: say so too.
        const asks = r.state === "waiting" && prev !== "waiting";
        if (ended || asks) {
          for (const l of this.transitions) l(r, prev ?? "pending");
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
      // delta=1: after the first full list the server sends only what changed.
      const es = new EventSource("/api/stream?delta=1");
      this.es = es;
      es.addEventListener("runs", (e) => {
        this.runsFrames++;
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
        this.runsFrames++;
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
        if (sessionId && sessionId === this.chatWanted) void this.loadChatSession(sessionId);
      });
      es.onerror = () => {
        this.conn = "reconnecting";
        this.emit();
        es.close();
        // The token may be what failed (a server restarted with a new one): ask, and stop retrying if so.
        if (this.capabilities.auth === "token") {
          void this.loadCapabilities().then(() => {
            if (!this.needsToken) setTimeout(() => this.connect(), this.backoff);
          });
          this.backoff = Math.min(this.backoff * 2, 15000);
          return;
        }
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

  /** Counts run-list frames from the stream, so an older fetch never overwrites one. */
  private runsFrames = 0;

  async loadRuns(): Promise<void> {
    const frames = this.runsFrames;
    try {
      const runs = await api.runs();
      if (this.runsFrames !== frames) return; // the live stream already delivered newer data
      this.setRuns(runs);
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
      this.needsToken = false;
      this.emit();
    } catch (err) {
      // 401: reads need a token this browser has not given (odw serve --token).
      if (err instanceof HttpError && err.status === 401) {
        this.needsToken = true;
        this.capabilities = { writable: false };
        this.es?.close();
        this.emit();
      }
      /* otherwise keep the optimistic default; a failed write still surfaces its 409 */
    }
  }

  /** Give the server a token: it answers with its cookie. True when it took it. */
  async signIn(token: string): Promise<boolean> {
    const answer = await api.signIn(token.trim()).catch(() => "wrong" as const);
    this.tokenError = answer === "ok" ? null : answer;
    this.emit();
    return answer === "ok";
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

  /** The session the Chat view asked for last; replies for any other are dropped. */
  chatWanted: string | null = null;

  async loadChatSession(id: string): Promise<void> {
    this.chatWanted = id;
    try {
      const session = await api.chatSession(id);
      if (this.chatWanted !== id) return; // the user moved to another session meanwhile
      this.chat = session;
      this.chatMissingId = null;
      this.chatError = "";
      this.emit();
    } catch (err) {
      if (this.chatWanted !== id) return;
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
      this.chatWanted = this.chat.id;
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
      const updated = await api.sendChatMessage(id, { text });
      // Only show the reply if the user is still on that session.
      if (this.chatWanted === id || this.chatWanted === null) this.chat = updated;
      this.chatMissingId = null;
      await this.loadChatSessions();
      return updated;
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
  /** Bumped on every focus change: a reply from an older generation is stale. */
  private runGen = 0;
  private runLoad: Promise<void> | null = null;
  private runLoadId: string | null = null;
  private runLoadAgain = false;

  focusRun(id: string | null): void {
    if (this.focusedRunId === id) return;
    this.focusedRunId = id;
    this.runGen++;
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
    // Join an in-flight load only when it is for this same run.
    if (this.runLoad && this.runLoadId === id) {
      this.runLoadAgain = true;
      return this.runLoad;
    }
    const load = this.fetchRun(id, this.runGen);
    this.runLoad = load;
    this.runLoadId = id;
    try {
      await load;
    } finally {
      if (this.runLoad === load) {
        this.runLoad = null;
        this.runLoadId = null;
      }
    }
    if (this.runLoadAgain && this.focusedRunId === id) {
      this.runLoadAgain = false;
      await this.loadRun(id);
    }
  }

  private async fetchRun(id: string, gen: number): Promise<void> {
    const same = this.run?.runId === id;
    // Only ODW event logs are append-only; a Claude run's log is rebuilt from
    // its transcripts on every read (it shrinks and reorders), so fetch it whole.
    const incremental = same && this.run?.provider === "odw";
    const since = incremental ? this.runEvents.length : 0;
    try {
      const [run, events] = await Promise.all([api.run(id), api.events(id, since)]);
      if (gen !== this.runGen || this.focusedRunId !== id) return; // navigated away mid-flight
      const sig = JSON.stringify(run);
      if (incremental && sig === this.runSig && events.length === 0) return;
      this.run = run;
      this.runSig = sig;
      this.runEvents = incremental ? this.runEvents.concat(events) : events;
      this.emit();
    } catch {
      /* keep last-known */
    }
  }

  async loadResult(id: string): Promise<void> {
    try {
      const r = await api.result(id);
      if (this.focusedRunId !== id) return;
      this.result = r.value;
      this.resultLoaded = true;
    } catch {
      // Not written yet (or a transient error): stay "not loaded" so the next
      // poll asks again, instead of rendering `undefined` as the result.
      this.result = undefined;
    }
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

  /**
   * Fetch what is new in one agent's transcript (from where the last load
   * stopped, following `more`). The newest TRANSCRIPT_KEEP entries are kept;
   * older ones are dropped and counted.
   */
  async loadTranscript(runId: string, agentId: number): Promise<void> {
    const key = `${runId}:${agentId}`;
    if (this.transcriptsLoading.has(key)) return;
    if (!this.transcripts.has(key) && this.transcripts.size >= 12) this.transcripts.delete(this.transcripts.keys().next().value!);
    this.transcriptsLoading.add(key);
    let changed = false;
    try {
      for (let pages = 0; pages < 20; pages++) {
        const cur = this.transcripts.get(key);
        const page = await api.transcript(runId, agentId, cur?.next ?? 0);
        if (page === null) {
          if (!cur?.missing) this.transcripts.set(key, { entries: [], next: 0, dropped: 0, truncated: false, replayed: false, missing: true });
          changed = !cur?.missing;
          break;
        }
        if (page.entries.length || !cur || cur.truncated !== page.truncated || cur.replayed !== page.replayed) {
          const entries = [...(cur?.entries ?? []), ...page.entries];
          const over = Math.max(0, entries.length - TRANSCRIPT_KEEP);
          this.transcripts.set(key, {
            entries: over ? entries.slice(over) : entries,
            next: page.next,
            dropped: (cur?.dropped ?? 0) + over,
            truncated: page.truncated,
            replayed: page.replayed,
            missing: false,
          });
          changed = true;
        }
        if (!page.more) break;
      }
    } catch {
      /* a dropped request: the next poll tries again */
    } finally {
      this.transcriptsLoading.delete(key);
    }
    if (changed && this.run?.runId === runId) this.emit();
  }

  /** Refresh the scheduled runs; repaints only when something changed. */
  /** Load (or refresh) what changed between runs `a` and `b`. */
  async loadCompare(a: string, b: string): Promise<void> {
    const key = `${a}/${b}`;
    if (this.comparison?.key !== key) {
      this.comparison = { key, value: null, error: null };
      this.emit();
    }
    try {
      const value = await api.compare(a, b);
      if (this.comparison?.key !== key) return;
      if (JSON.stringify(value) === JSON.stringify(this.comparison.value)) return;
      this.comparison = { key, value, error: null };
    } catch (err) {
      if (this.comparison?.key !== key) return;
      this.comparison = { key, value: null, error: (err as Error).message };
    }
    this.emit();
  }

  async loadSchedules(): Promise<void> {
    let next: ScheduleView[];
    try {
      next = await api.schedules();
    } catch {
      next = []; // an older server has no /api/schedules
    }
    if (JSON.stringify(next) === JSON.stringify(this.schedules)) return;
    this.schedules = next;
    this.emit();
  }

  /** Fetch and parse one agent's diff once; diffs are immutable once the agent finished. */
  async loadAgentDiff(runId: string, agentId: number): Promise<void> {
    const key = `${runId}:${agentId}`;
    if (this.agentDiffs.has(key) || this.diffsLoading.has(key)) return;
    // Diffs can be large: keep only the latest few parsed.
    if (this.agentDiffs.size >= 24) this.agentDiffs.delete(this.agentDiffs.keys().next().value!);
    this.diffsLoading.add(key);
    try {
      const text = await api.agentDiff(runId, agentId);
      this.agentDiffs.set(key, text == null ? null : parseDiff(text));
    } catch {
      this.agentDiffs.set(key, null);
    } finally {
      this.diffsLoading.delete(key);
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
      // An idle fleet answers the poll with the same snapshot: skip the repaint.
      const sig = `${snap.events.length}:${snap.events[0]?.ts}:${snap.events[0]?.type}:${JSON.stringify(snap.fleet)}`;
      if (this.activityLoaded && sig === this.activitySig) return;
      this.activitySig = sig;
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
/** Transcript entries a page keeps in memory per agent; older ones are dropped (the CLI shows them all). */
export const TRANSCRIPT_KEEP = 4000;

export interface TranscriptState {
  entries: TranscriptEntry[];
  /** The `since` of the next load. */
  next: number;
  /** Entries dropped from the front to stay under TRANSCRIPT_KEEP. */
  dropped: number;
  truncated: boolean;
  replayed: boolean;
  /** The server kept no transcript for this agent (404). */
  missing: boolean;
}

export function applyRunsDelta(runs: RunSummary[], upsert: RunSummary[], remove: string[]): RunSummary[] {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  for (const id of remove) byId.delete(id);
  for (const r of upsert) byId.set(r.runId, r);
  return [...byId.values()].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0),
  );
}

export const store = new Store();
