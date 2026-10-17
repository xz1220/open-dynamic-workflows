/**
 * Presentation preferences — theme, motion and desktop notifications.
 *
 * Pure client-side choices persisted to localStorage (best effort). They never
 * touch run data, so they stay within the dashboard's narrow write contract.
 * The resolved values are reflected on <html> as `data-theme` / `data-motion`,
 * which is all the stylesheet keys off.
 */

export type ThemePref = "system" | "light" | "dark";
export type MotionPref = "system" | "full" | "reduced";

const KEYS = { theme: "odw.theme", motion: "odw.motion", notify: "odw.notify" } as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* persistence is best-effort (private mode / sandbox) */
  }
}

const media = (q: string): MediaQueryList | null =>
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q) : null;

const darkQuery = media("(prefers-color-scheme: dark)");
const reducedQuery = media("(prefers-reduced-motion: reduce)");

export const prefs = {
  theme: ((): ThemePref => {
    const v = read(KEYS.theme);
    return v === "light" || v === "dark" ? v : "system";
  })(),
  motion: ((): MotionPref => {
    const v = read(KEYS.motion);
    return v === "full" || v === "reduced" ? v : "system";
  })(),
  notify: read(KEYS.notify) === "1",
};

export function resolvedTheme(): "light" | "dark" {
  if (prefs.theme !== "system") return prefs.theme;
  return darkQuery?.matches ? "dark" : "light";
}

export function reducedMotion(): boolean {
  if (prefs.motion !== "system") return prefs.motion === "reduced";
  return Boolean(reducedQuery?.matches);
}

/** Reflect the resolved preferences on the document element. */
export function applyPrefs(): void {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  root.dataset.motion = reducedMotion() ? "reduced" : "full";
  root.style.colorScheme = resolvedTheme();
}

/**
 * Switch theme. Where the View Transitions API exists the new palette is
 * revealed as a circle growing from the pointer — otherwise it just swaps.
 */
export function setTheme(next: ThemePref, origin?: { x: number; y: number }): void {
  const before = resolvedTheme();
  prefs.theme = next;
  write(KEYS.theme, next);
  if (resolvedTheme() === before) {
    applyPrefs();
    return;
  }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || reducedMotion()) {
    applyPrefs();
    return;
  }
  const x = origin?.x ?? window.innerWidth - 40;
  const y = origin?.y ?? 40;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const vt = doc.startViewTransition(() => applyPrefs());
  void vt.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
}

export function setMotion(next: MotionPref): void {
  prefs.motion = next;
  write(KEYS.motion, next);
  applyPrefs();
}

/** Desktop notifications need an explicit opt-in plus the browser's permission. */
export async function setNotify(on: boolean): Promise<boolean> {
  if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") {
    try {
      const p = await Notification.requestPermission();
      if (p !== "granted") on = false;
    } catch {
      on = false;
    }
  }
  prefs.notify = on;
  write(KEYS.notify, on ? "1" : "0");
  return on;
}

export function notificationsAvailable(): boolean {
  return typeof Notification !== "undefined";
}

/** Follow OS-level changes while the matching preference is "system". */
export function watchSystemPrefs(onChange: () => void): void {
  const handler = () => {
    applyPrefs();
    onChange();
  };
  darkQuery?.addEventListener?.("change", handler);
  reducedQuery?.addEventListener?.("change", handler);
}
