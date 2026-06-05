/**
 * Native bridge (Tauri). Entirely optional: in a plain browser (`odw serve`)
 * `window.__TAURI__` is absent and every call here is a no-op. When wrapped by
 * the Tauri shell, the SPA reports the active-run count so the shell can drive
 * the Dock badge, and emits run-finished/failed transitions for native
 * notifications — keeping all run *state* in the (single) web layer and letting
 * Rust stay a thin presenter.
 */
import type { RunSummary } from "./types";

interface BadgeTarget {
  setBadgeCount?: (n?: number) => Promise<void>;
}
interface TauriGlobal {
  event?: { emit?: (event: string, payload?: unknown) => Promise<void> };
  // macOS Dock badge: a window method in Tauri 2 (core:window:allow-set-badge-count);
  // older shapes exposed it on `app`. Try the window first, fall back to app.
  window?: { getCurrentWindow?: () => BadgeTarget };
  app?: BadgeTarget;
}
function tauri(): TauriGlobal | null {
  return (globalThis as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

/** Set (or clear, when undefined) the Dock badge via whichever API this build exposes. */
function setBadge(t: TauriGlobal, count: number | undefined): void {
  const win = t.window?.getCurrentWindow?.();
  if (win?.setBadgeCount) void win.setBadgeCount(count);
  else void t.app?.setBadgeCount?.(count);
}

export function isNative(): boolean {
  return tauri() !== null;
}

const ACTIVE = new Set(["running", "paused", "pending"]);
let lastStates = new Map<string, string>();

/**
 * Push UI-derived signals to the shell. Call on every run-list update.
 *  - Dock badge = active run count (0 clears it).
 *  - Emit `run:transition` for any run that just reached a terminal state, so
 *    the Rust side can raise a native notification (respecting user prefs there).
 */
export function syncNative(runs: RunSummary[]): void {
  const t = tauri();
  if (!t) return;

  const active = runs.filter((r) => ACTIVE.has(r.state)).length;
  setBadge(t, active > 0 ? active : undefined);

  const next = new Map<string, string>();
  for (const r of runs) {
    next.set(r.runId, r.state);
    const prev = lastStates.get(r.runId);
    const terminal = r.state === "done" || r.state === "failed" || r.state === "stopped";
    if (prev && prev !== r.state && terminal) {
      void t.event?.emit?.("run:transition", {
        runId: r.runId,
        name: r.name,
        state: r.state,
        agents: r.counts.agents,
        failed: r.counts.failed,
      });
    }
  }
  lastStates = next;
}
