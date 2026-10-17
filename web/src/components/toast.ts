/**
 * Toasts + desktop notifications for run transitions.
 *
 * When a run leaves the active set the dashboard says so: an in-page toast
 * (always), and a system notification when the user opted in and the tab is in
 * the background — the "tell me when my long run is done" need.
 */
import { glyph } from "./glyph";
import { prefs } from "../prefs";
import { esc } from "../util";

let root: HTMLElement | null = null;

function host(): HTMLElement {
  if (root) return root;
  root = document.createElement("div");
  root.id = "toasts";
  root.setAttribute("aria-live", "polite");
  document.body.appendChild(root);
  return root;
}

export interface ToastSpec {
  state: string;
  title: string;
  body: string;
  /** Hash to open on click. */
  href?: string;
  ttlMs?: number;
}

function dismiss(el: HTMLElement): void {
  if (el.classList.contains("out")) return;
  el.classList.add("out");
  setTimeout(() => el.remove(), 300);
}

export function toast(spec: ToastSpec): void {
  const box = host();
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML =
    `${glyph(spec.state)}<div><b>${esc(spec.title)}</b><span>${esc(spec.body)}</span></div>` +
    (spec.href ? `<span class="go">open →</span>` : "");
  el.addEventListener("click", () => {
    if (spec.href) location.hash = spec.href;
    dismiss(el);
  });
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild?.remove();
  setTimeout(() => dismiss(el), spec.ttlMs ?? 6500);
}

/** A system notification, only when opted in, permitted, and the tab is hidden. */
export function notifyDesktop(spec: ToastSpec): void {
  if (!prefs.notify || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted" || !document.hidden) return;
  try {
    const n = new Notification(spec.title, { body: spec.body, tag: spec.href ?? spec.title });
    n.onclick = () => {
      window.focus();
      if (spec.href) location.hash = spec.href;
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}
