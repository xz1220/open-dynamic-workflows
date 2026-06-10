/**
 * Central read-only state.
 *
 * The run *list* stays live over SSE (`/api/stream` pushes the whole list on
 * change). Focused detail (a single run's DAG/logs, the Activity firehose) is
 * pulled by a route-aware poller in main.ts. Every mutation calls emit(); the
 * app re-renders the active view. Defensive throughout — a failed fetch never
 * crashes the window, it just leaves the last-known state and flips `conn`.
 */
import { api } from "./api";
import type {
  AdapterListing,
  Connection,
  RunDetail,
  RunSummary,
  WorkflowEvent,
  WorkflowSummary,
} from "./types";
import { ACTIVE } from "./util";

export type ActivityEvent = WorkflowEvent & { _run: string; _adapter: string | null };

type Listener = () => void;

class Store {
  conn: Connection = "connecting";
  runs: RunSummary[] = [];
  workflows: WorkflowSummary[] | null = null;
  adapters: AdapterListing[] | null = null;
  run: RunDetail | null = null;
  runEvents: WorkflowEvent[] = [];
  result: unknown = undefined;
  resultLoaded = false;
  activity: ActivityEvent[] = [];
  activeDetails: RunDetail[] = [];

  private listeners = new Set<Listener>();
  private es: EventSource | null = null;
  private backoff = 1000;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(): void {
    for (const l of this.listeners) l();
  }

  /** Open the live run-list stream; reconnect with backoff on error. */
  connect(): void {
    try {
      this.es?.close();
      const es = new EventSource("/api/stream");
      this.es = es;
      es.addEventListener("runs", (e) => {
        try {
          this.runs = JSON.parse((e as MessageEvent).data) as RunSummary[];
        } catch {
          /* ignore a torn frame */
        }
        this.conn = "live";
        this.backoff = 1000;
        this.emit();
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
      this.loadRuns();
      setTimeout(() => this.connect(), 3000);
    }
  }

  async loadRuns(): Promise<void> {
    try {
      this.runs = await api.runs();
      this.emit();
    } catch {
      /* keep last-known */
    }
  }

  async loadWorkflows(): Promise<void> {
    try {
      this.workflows = await api.workflows();
      this.emit();
    } catch {
      this.workflows = this.workflows ?? [];
      this.emit();
    }
  }

  async loadAdapters(): Promise<void> {
    try {
      this.adapters = await api.adapters();
      this.emit();
    } catch {
      this.adapters = this.adapters ?? [];
      this.emit();
    }
  }

  async loadRun(id: string): Promise<void> {
    try {
      const [run, events] = await Promise.all([api.run(id), api.events(id)]);
      this.run = run;
      this.runEvents = events;
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

  clearRun(): void {
    this.run = null;
    this.runEvents = [];
    this.result = undefined;
    this.resultLoaded = false;
  }

  /**
   * Refresh the Activity view: a tail of events across the newest runs (the
   * firehose) and the folded detail of every active run (the per-adapter fleet).
   */
  async loadActivity(): Promise<void> {
    const recent = this.runs.slice(0, 8);
    const active = this.runs.filter((r) => ACTIVE.has(r.state));
    const [tails, details] = await Promise.all([
      Promise.all(
        recent.map(async (r) => {
          try {
            const evs = await api.events(r.runId);
            return evs.slice(-12).map(
              (e): ActivityEvent => ({
                ...e,
                _run: r.name,
                _adapter: typeof e.adapter === "string" ? e.adapter : null,
              }),
            );
          } catch {
            return [] as ActivityEvent[];
          }
        }),
      ),
      Promise.all(
        active.map(async (r) => {
          try {
            return await api.run(r.runId);
          } catch {
            return null;
          }
        }),
      ),
    ]);
    this.activity = tails.flat().sort((a, b) => b.ts - a.ts).slice(0, 40);
    this.activeDetails = details.filter((d): d is RunDetail => d != null);
    this.emit();
  }
}

export const store = new Store();
