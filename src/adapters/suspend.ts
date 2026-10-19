/**
 * The host went to sleep (an ODW extension): a laptop's lid closed, a VM
 * paused, the worker itself stopped (SIGSTOP) — time passed in which nothing
 * of the run could have run.
 *
 * Silence across such a gap is no agent's fault, so the stall watchdog must
 * not count it (see ./runner). The watchdog measures silence on the monotonic
 * clock (`performance.now()`), which on Linux and macOS does not advance while
 * the machine sleeps; the wall clock does. A watcher wakes every
 * {@link SUSPEND_TICK_MS} and compares the two: a wall-clock jump past the
 * monotonic one — or a tick that came far later than it was due on both, the
 * event loop itself having been suspended (Windows' monotonic clock keeps
 * counting through sleep) — of more than {@link SUSPEND_THRESHOLD_MS} is a
 * suspension. Each one is told once to every listener: each running agent's
 * watchdog starts its silence over (a full `stallTimeout` of grace), and the
 * worker logs it once as a `host_suspended` event.
 *
 * A watchdog that wakes before the watcher's next tick asks first
 * ({@link checkHostSuspend}), so a wake-up never kills an agent in the moment
 * before the gap is noticed. The watcher runs only while someone listens, and
 * never keeps the process alive.
 */

import { performance } from "node:perf_hooks";

/** How often the watcher compares the clocks. */
export const SUSPEND_TICK_MS = 30_000;

/** A gap past this, beyond what the tick was due, is a suspension. */
export const SUSPEND_THRESHOLD_MS = 60_000;

/** A suspension, as told to listeners. */
export interface HostSuspension {
  /** How long the host was gone, in whole seconds (the wall clock's lead, or the late tick's gap: roughly). */
  sleptSeconds: number;
  /** When it was noticed (epoch ms). */
  at: number;
}

type Listener = (suspension: HostSuspension) => void;

/** The clocks read: a test seam. */
export interface SuspendClocks {
  wall: () => number;
  mono: () => number;
}

const SYSTEM_CLOCKS: SuspendClocks = { wall: () => Date.now(), mono: () => performance.now() };

let clocks: SuspendClocks = SYSTEM_CLOCKS;
const listeners = new Set<Listener>();
let ticker: NodeJS.Timeout | undefined;
let last: { wall: number; mono: number } | undefined;

/**
 * Be told of each suspension of the host until the returned function is
 * called. The first listener starts the watcher; the last one gone stops it.
 */
export function onHostSuspend(listener: Listener): () => void {
  listeners.add(listener);
  if (!ticker) {
    last = { wall: clocks.wall(), mono: clocks.mono() };
    ticker = setInterval(checkHostSuspend, SUSPEND_TICK_MS);
    ticker.unref();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = undefined;
      last = undefined;
    }
  };
}

/**
 * Compare the clocks now (the watcher does every tick; a stall watchdog does
 * before it kills): a suspension since the last look is told to every
 * listener, once, and true is returned.
 */
export function checkHostSuspend(): boolean {
  if (!last) return false;
  const now = { wall: clocks.wall(), mono: clocks.mono() };
  const wallGap = now.wall - last.wall;
  const monoGap = now.mono - last.mono;
  last = now;
  // Slept with the monotonic clock stopped: the wall clock ran ahead of it.
  // Suspended with both running: more passed than one tick could take.
  const lost = Math.max(wallGap - monoGap, Math.min(wallGap, monoGap) - SUSPEND_TICK_MS);
  if (lost <= SUSPEND_THRESHOLD_MS) return false;
  const slept = wallGap - monoGap > SUSPEND_THRESHOLD_MS ? wallGap - monoGap : Math.min(wallGap, monoGap);
  const suspension: HostSuspension = { sleptSeconds: Math.round(slept / 1000), at: now.wall };
  for (const listener of [...listeners]) {
    try {
      listener(suspension);
    } catch {
      // one listener's failure must not keep the others from hearing it
    }
  }
  return true;
}

/** Tests: read these clocks instead of the system's (none: the system's again). Resets the last look. */
export function setSuspendClocks(next: SuspendClocks | null): void {
  clocks = next ?? SYSTEM_CLOCKS;
  last = ticker ? { wall: clocks.wall(), mono: clocks.mono() } : undefined;
}
