/**
 * App entry: hash router, morph-based rendering, route-aware polling, and the
 * global affordances (command palette, shortcuts, toasts, theme).
 *
 * The run list stays live over SSE (store.connect). The focused data for the
 * current route — a run's DAG/logs, the Activity stream, the Workspace list —
 * is refreshed while that route is shown; every async load carries a route
 * token so a slow response can never repaint (or re-arm a poller for) a page
 * the user already left. Views are pure `state → HTML` functions; render()
 * morphs the result into the live DOM, so scroll positions, focus and running
 * animations survive every repaint. One click layer delegates all actions.
 */
import { api } from "./api";
import { renderDiff } from "./components/diff";
import { glyph } from "./components/glyph";
import { closePalette, isPaletteOpen, openPalette, setPaletteSource, type PaletteItem } from "./components/palette";
import { closeShortcuts, shortcutsOpen, toggleShortcuts } from "./components/shortcuts";
import { notifyDesktop, toast } from "./components/toast";
import { icons } from "./icons";
import { getLang, setLang, t as tr, tn, type Lang } from "./i18n";
import { morph } from "./morph";
import {
  applyPrefs,
  prefs,
  reducedMotion,
  resolvedTheme,
  setMotion,
  setNotify,
  setTheme,
  watchSystemPrefs,
  type MotionPref,
  type ThemePref,
} from "./prefs";
import { activeRuns, rail, statusbar, topbar, type Route } from "./shell";
import { store } from "./store";
import type { RunSummary, WorkflowDetail } from "./types";
import { ACTIVE, TERMINAL, fmtDurSec, runDurationSec } from "./util";
import { renderActivity } from "./views/activity";
import { renderChat } from "./views/chat";
import { LOG_PAGE, changedAgents, renderJob, reviewTarget, type JobTab, type JobViewState } from "./views/job";
import { HISTORY_PAGE, renderJobs, type JobsFilter, type JobsState } from "./views/jobs";
import { renderSettings } from "./views/settings";
import { orderedWorkflows, renderWorkspace, wfKey } from "./views/workspace";

/** Reflect the chosen language on <html lang> (a11y + correct CJK shaping). */
function applyDocLang(): void {
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
}

const root = document.getElementById("app")!;
const nowSec = () => Date.now() / 1000;

// --- view-local UI state (not in the store) ---
const jobs: JobsState = { filter: "all", query: "", limit: HISTORY_PAGE };
const job: JobViewState = {
  cpNote: "",
  tab: "graph",
  selectedAi: null,
  reviewAi: null,
  zoom: 1,
  logQuery: "",
  logTypes: new Set(["agent", "command", "phase", "log", "run"]),
  logLimit: LOG_PAGE,
  follow: true,
  motion: !reducedMotion(),
};
let wfActive: string | null = null;
let wfDetail: WorkflowDetail | null = null;
let wfQuery = "";
let chatDraft = "";
let activeChatId: string | null = null;
let composing = false;
let deferredRender = false;
let chatScrollToBottomOnNextRender = false;
let lastRouteKey = "";

// --- polling, guarded by a route token ---
let poll: number | null = null;
let routeToken = 0;

const CHAT_STICKY_BOTTOM_PX = 32;
const JOB_TABS: JobTab[] = ["graph", "timeline", "logs", "result", "changes"];

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [view, ...rest] = h.split("/");
  switch (view) {
    case "chat":
      return { view: "chat", param: rest.length ? decodeURIComponent(rest[0]!) : null };
    case "workspace":
      return { view: "workspace", param: rest.length ? decodeURIComponent(rest[0]!) : null };
    case "jobs": {
      // #/jobs[/<filter>] — the filter is part of the URL so a view can be shared.
      const f = rest[0];
      jobs.filter = f === "live" ? "active" : f === "done" || f === "failed" ? f : "all";
      return { view: "jobs", param: null };
    }
    case "job": {
      // #/job/<runId>[/<tab>] — the trailing tab segment is optional.
      const last = rest[rest.length - 1] as JobTab | undefined;
      if (last && JOB_TABS.includes(last)) {
        job.tab = last;
        return { view: "job", param: decodeURIComponent(rest.slice(0, -1).join("/")) || null };
      }
      job.tab = "graph";
      return { view: "job", param: decodeURIComponent(rest.join("/")) || null };
    }
    case "settings":
      return { view: "settings", param: null };
    default:
      if (h && view !== "activity") history.replaceState(null, "", "#/activity");
      return { view: "activity", param: null };
  }
}

const currentRoute = parseHash;

function viewHtml(route: Route): string {
  const now = nowSec();
  switch (route.view) {
    case "chat":
      return renderChat(store.chatSessions, store.chat, chatDraft, activeChatId, {
        creating: store.chatCreating,
        sending: store.chatSending,
        error: store.chatError,
        missingId: store.chatMissingId,
        writable: store.capabilities.writable,
      });
    case "activity":
      return renderActivity(now);
    case "workspace":
      return renderWorkspace(wfActive, wfDetail, wfQuery);
    case "jobs":
      return renderJobs(jobs, now);
    case "job":
      return renderJob(job, now);
    case "settings":
      return renderSettings(store.settings);
  }
}

// --- render ---
function render(): void {
  if (composing) {
    deferredRender = true;
    return;
  }
  const route = currentRoute();
  const chatScroll = captureChatScroll(route);
  const focus = captureFocus();
  const followLogs = job.follow && route.view === "job" && job.tab === "logs" && logsAtBottom();
  morph(
    root,
    `<div class="app">` +
      rail(route) +
      topbar(route) +
      `<main class="main" data-view="${route.view}">${viewHtml(route)}</main>` +
      statusbar() +
      `</div>`,
  );
  restoreFocus(focus);
  restoreChatScroll(chatScroll, route);
  afterRender(route, followLogs);
}

function afterRender(route: Route, followLogs: boolean): void {
  const key = `${route.view}:${route.param ?? ""}`;
  if (key !== lastRouteKey) {
    lastRouteKey = key;
    root.querySelector(".main")?.scrollTo({ top: 0 });
  }
  // Slide the tab ink bar under the active tab.
  const bar = root.querySelector<HTMLElement>(".tabs .ink-bar");
  const on = root.querySelector<HTMLElement>(".tabs .tab.on");
  if (bar && on) {
    bar.style.left = `${on.offsetLeft}px`;
    bar.style.width = `${on.offsetWidth}px`;
  }
  if (followLogs) {
    const body = root.querySelector<HTMLElement>(".tab-body");
    if (body) body.scrollTop = body.scrollHeight;
  }
  followLane();
  // The drawer's agent finished (or was just opened): fetch its persisted output once.
  const sel = route.view === "job" && job.selectedAi != null ? store.run?.agents[job.selectedAi] : undefined;
  if (store.run && sel?.agentId != null && sel.state !== "running") void store.loadAgentResult(store.run.runId, sel.agentId);
  // Diffs: the drawer's agent's (for its file list) and the one under review.
  if (store.run && route.view === "job") {
    if (sel?.agentId != null && sel.changes?.files) void store.loadAgentDiff(store.run.runId, sel.agentId);
    const target = job.tab === "changes" ? reviewTarget(store.run, job.reviewAi) : null;
    if (target) {
      void store.loadAgentDiff(store.run.runId, target.a.agentId!);
      void store.loadAgentResult(store.run.runId, target.a.agentId!);
    }
  }
  fillDiffs();
  updateChrome();
}

/**
 * Paint each diff host once per version. A diff can run to thousands of rows,
 * so it is drawn here — not in the view's HTML, which is re-parsed on every
 * live tick — and its host is frozen against morph (`data-morph="skip"`).
 */
function fillDiffs(): void {
  for (const host of root.querySelectorAll<HTMLElement>("[data-diff]")) {
    if (host.dataset.filled === host.dataset.v) continue;
    const parsed = store.agentDiffs.get(host.dataset.diff!);
    host.innerHTML =
      parsed === undefined
        ? `<div class="diff-loading"><span class="skel"></span><span class="skel"></span><span class="skel"></span></div>`
        : parsed === null
          ? `<p class="dnote">${tr("This agent's diff is not available.")}</p>`
          : renderDiff(parsed, { fullCmd: host.dataset.full });
    host.dataset.filled = host.dataset.v;
  }
}

/** Show another agent's changes in the Changes tab. */
function review(ai: number): void {
  job.reviewAi = ai;
  if (job.tab !== "changes") return selectTab("changes");
  render();
  root.querySelector<HTMLElement>(".tab-body")?.scrollTo({ top: 0 });
}

/**
 * Keep the phase that is running in view on wide graphs — unless the user has
 * panned recently, in which case their viewport wins.
 */
let followedLane = "";
let lastPanAt = 0;
function followLane(): void {
  const canvas = root.querySelector<HTMLElement>("[data-canvas]");
  const lane = root.querySelector<HTMLElement>(".lanehead.on");
  if (!canvas || !lane) return;
  const key = `${store.run?.runId}:${lane.dataset.key}`;
  if (key === followedLane) return;
  followedLane = key;
  if (Date.now() - lastPanAt < 8000) return;
  const x = lane.offsetLeft * job.zoom;
  if (x > canvas.scrollLeft && x + 220 < canvas.scrollLeft + canvas.clientWidth) return;
  canvas.scrollTo({ left: Math.max(0, x - canvas.clientWidth / 3), behavior: reducedMotion() ? "auto" : "smooth" });
}

function logsAtBottom(): boolean {
  const body = root.querySelector<HTMLElement>('.tab-body[data-tabbody="logs"]');
  if (!body) return true;
  return body.scrollHeight - body.scrollTop - body.clientHeight < 60;
}

/** Window title + favicon mirror the fleet: a signal dot while anything runs. */
let lastChrome = "";
function updateChrome(): void {
  const active = activeRuns();
  const route = currentRoute();
  const label =
    route.view === "job" && store.run
      ? store.run.name
      : { activity: tr("Activity"), jobs: tr("Jobs"), job: tr("Jobs"), workspace: tr("Workspace"), chat: tr("Chat"), settings: tr("Settings") }[route.view];
  const title = `${active.length ? `(${active.length}) ` : ""}${label} · odw`;
  const sig = `${title}|${active.length > 0}|${resolvedTheme()}`;
  if (sig === lastChrome) return;
  lastChrome = sig;
  document.title = title;
  const dark = resolvedTheme() === "dark";
  const ink = dark ? "#edede6" : "#131311";
  const dot = active.length ? (dark ? "#2ee88e" : "#00b26a") : ink;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M12 42 C30 42 32 20 50 20' stroke='${dot}' stroke-width='9' fill='none' stroke-linecap='round'/>` +
    `<circle cx='12' cy='42' r='9' fill='${ink}'/><circle cx='52' cy='20' r='9' fill='${ink}'/><circle cx='34' cy='50' r='7' fill='${dot}'/></svg>`;
  let link = document.querySelector<HTMLLinkElement>("link[rel=icon]");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// --- chat composer + scroll (the thread keeps its place through live updates) ---
function hasStreamingChatAssistant(): boolean {
  return Boolean(store.chat?.messages.some((m) => m.role === "assistant" && m.status === "streaming"));
}

function refreshChatComposer(): void {
  const btn = root.querySelector<HTMLButtonElement>("[data-chat-send]");
  if (!btn) return;
  const locked = store.chatSending || hasStreamingChatAssistant() || !store.capabilities.writable;
  const canSend = Boolean(store.chat && activeChatId && chatDraft.trim() && !locked);
  btn.disabled = !canSend;
  btn.classList.toggle("disabled", !canSend);
  if (canSend) btn.removeAttribute("aria-disabled");
  else btn.setAttribute("aria-disabled", "true");
}

type ChatScrollSnapshot = { sessionId: string; scrollTop: number; nearBottom: boolean };
const chatScrollBySession = new Map<string, ChatScrollSnapshot>();

function renderedChatSessionId(route: Route): string | null {
  if (route.view !== "chat") return null;
  return store.chat?.id ?? activeChatId ?? route.param ?? null;
}

function messageListChatId(el: HTMLElement, route: Route): string | null {
  return el.dataset.chatId ?? renderedChatSessionId(route);
}

function snapshotChatScroll(sessionId: string, el: HTMLElement): ChatScrollSnapshot {
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return { sessionId, scrollTop: el.scrollTop, nearBottom: distanceFromBottom <= CHAT_STICKY_BOTTOM_PX };
}

function captureChatScroll(route: Route): ChatScrollSnapshot | null {
  const el = root.querySelector<HTMLElement>(".chat-messages");
  const sessionId = el ? messageListChatId(el, route) : null;
  if (!sessionId || !el) return null;
  const snap = snapshotChatScroll(sessionId, el);
  chatScrollBySession.set(sessionId, snap);
  return snap;
}

function applyChatScroll(sessionId: string, mode: "bottom" | "position", scrollTop = 0): void {
  const route = currentRoute();
  if (route.view !== "chat") return;
  const el = root.querySelector<HTMLElement>(".chat-messages");
  if (!el || messageListChatId(el, route) !== sessionId) return;
  const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  el.scrollTop = mode === "bottom" ? el.scrollHeight : Math.min(scrollTop, maxScrollTop);
  chatScrollBySession.set(sessionId, snapshotChatScroll(sessionId, el));
}

function restoreChatScroll(snap: ChatScrollSnapshot | null, route: Route): void {
  const el = root.querySelector<HTMLElement>(".chat-messages");
  const sessionId = el ? messageListChatId(el, route) : renderedChatSessionId(route);
  if (!sessionId || !el) {
    if (route.view !== "chat") chatScrollToBottomOnNextRender = false;
    return;
  }
  const saved = chatScrollToBottomOnNextRender
    ? { ...snapshotChatScroll(sessionId, el), nearBottom: true }
    : snap?.sessionId === sessionId
      ? snap
      : chatScrollBySession.get(sessionId);
  chatScrollToBottomOnNextRender = false;
  if (!saved) return;
  const apply = () =>
    saved.nearBottom ? applyChatScroll(sessionId, "bottom") : applyChatScroll(sessionId, "position", saved.scrollTop);
  apply();
  window.requestAnimationFrame(apply);
}

// --- focus (morph keeps focused nodes; this covers re-created ones) ---
const FOCUSABLE_IDS = new Set(["chat-input", "jobs-q", "log-q", "wf-q", "cp-note"]);
type FocusSnapshot = { id: string; start: number | null; end: number | null } | null;

function captureFocus(): FocusSnapshot {
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el || !el.id || !FOCUSABLE_IDS.has(el.id)) return null;
  return { id: el.id, start: el.selectionStart ?? null, end: el.selectionEnd ?? null };
}

function restoreFocus(snap: FocusSnapshot): void {
  if (!snap) return;
  const el = document.getElementById(snap.id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el || el === document.activeElement) return;
  el.focus();
  if (snap.start != null) {
    try {
      el.setSelectionRange(snap.start, snap.end ?? snap.start);
    } catch {
      /* type doesn't support selection ranges — focus alone is enough */
    }
  }
}

// --- per-route data loading + polling ---
function stopPolling(): void {
  if (poll != null) clearInterval(poll);
  poll = null;
}

/** Arm a poller for the current route; it dies with the route token. */
function every(ms: number, token: number, fn: () => void | Promise<void>): void {
  stopPolling();
  poll = window.setInterval(() => {
    if (token !== routeToken) return stopPolling();
    if (document.hidden) return;
    void fn();
  }, ms);
}

async function enterRoute(): Promise<void> {
  const token = ++routeToken;
  const live = () => token === routeToken;
  stopPolling();
  const route = currentRoute();
  if (route.view !== "job") store.focusRun(null);

  if (route.view === "activity") {
    render();
    await store.loadActivity();
    if (live()) every(2000, token, () => store.loadActivity());
  } else if (route.view === "chat") {
    if (store.chatSessions === null) await store.loadChatSessions();
    if (!live()) return;
    const ids = new Set((store.chatSessions ?? []).map((s) => s.id));
    const first = store.chatSessions?.[0]?.id ?? null;
    const remembered = activeChatId && ids.has(activeChatId) ? activeChatId : null;
    const want = route.param ?? remembered ?? first;
    activeChatId = want;
    if (want) {
      await store.loadChatSession(want);
      if (!live() || store.chatMissingId === want) return render();
      // SSE `chat` frames drive updates; this slow poll only covers a dropped stream.
      every(5000, token, () => (store.conn === "live" ? undefined : store.loadChatSession(want)));
    } else {
      store.chat = null;
      store.chatMissingId = null;
      store.chatError = "";
      render();
    }
  } else if (route.view === "workspace") {
    render();
    await store.loadWorkflows();
    if (!live()) return;
    const first = store.workflows ? orderedWorkflows(store.workflows)[0] : undefined;
    const want = route.param ?? wfActive ?? (first ? wfKey(first) : null);
    if (want && (want !== wfActive || !wfDetail)) await selectWorkflow(want, false, token);
    else render();
  } else if (route.view === "settings") {
    render();
    await store.loadSettings();
  } else if (route.view === "job" && route.param) {
    const id = route.param;
    if (store.focusedRunId !== id) {
      job.selectedAi = null;
      job.reviewAi = null;
      job.zoom = 1;
      job.logLimit = LOG_PAGE;
      store.focusRun(id);
    }
    render();
    await store.loadRun(id);
    if (!live()) return;
    if (job.tab === "result") await store.loadResult(id);
    if (!live()) return;
    // Poll while the run is live; a terminal run needs no polling at all.
    every(1500, token, async () => {
      const run = store.run;
      if (run && TERMINAL.has(run.state)) return stopPolling();
      await store.loadRun(id);
      if (job.tab === "result" && store.run?.hasResult && !store.resultLoaded) await store.loadResult(id);
    });
  } else {
    render();
  }
}

async function selectWorkflow(key: string, navigate = true, token = routeToken): Promise<void> {
  wfActive = key;
  wfDetail = null;
  render();
  // key is `provider:name`; name has no colon, so split on the first one. Tolerate
  // a bare name (old bookmark) by treating the whole thing as the name.
  const i = key.indexOf(":");
  const provider = i >= 0 ? key.slice(0, i) : undefined;
  const name = i >= 0 ? key.slice(i + 1) : key;
  try {
    const detail = await api.workflow(name, provider);
    if (token !== routeToken || wfActive !== key) return;
    wfDetail = detail;
    wfActive = wfKey(detail);
  } catch {
    wfDetail = null;
  }
  render();
  if (navigate && location.hash !== `#/workspace/${encodeURIComponent(key)}`) {
    history.replaceState(null, "", `#/workspace/${encodeURIComponent(key)}`);
  }
}

function go(hash: string): void {
  if (location.hash === hash) return;
  location.hash = hash;
}

function goOrReload(hash: string): void {
  if (location.hash === hash) void enterRoute();
  else go(hash);
}

function chatRoute(id: string | null): string {
  return id ? `#/chat/${encodeURIComponent(id)}` : "#/chat";
}

function runHash(runId: string): string {
  return `#/job/${encodeURIComponent(runId)}`;
}

async function sendChat(): Promise<void> {
  const text = chatDraft.trim();
  const id = activeChatId;
  if (!id || store.chatMissingId) {
    store.chatError = "Create a session first.";
    store.emit();
    return;
  }
  if (!text) {
    chatDraft = "";
    store.chatError = "Message text is required.";
    store.emit();
    return;
  }
  if (store.chatSending) return;
  const updated = await store.sendChatMessage(id, text);
  if (updated && store.chatWanted === updated.id) {
    activeChatId = updated.id;
    chatDraft = "";
    chatScrollToBottomOnNextRender = true;
    render();
  }
}

// --- graph zoom + pan ---
function zoomTo(z: number): void {
  job.zoom = Math.min(1.6, Math.max(0.35, Math.round(z * 100) / 100));
  render();
}

function fitGraph(): void {
  const canvas = root.querySelector<HTMLElement>("[data-canvas]");
  const dag = root.querySelector<HTMLElement>(".dag");
  if (!canvas || !dag) return;
  const w = dag.offsetWidth;
  const h = dag.offsetHeight;
  const z = Math.min(1.25, (canvas.clientWidth - 48) / w, (canvas.clientHeight - 48) / h);
  zoomTo(Math.max(0.35, z));
}

let drag: { x: number; y: number; left: number; top: number; el: HTMLElement } | null = null;
root.addEventListener("pointerdown", (ev) => {
  const canvas = (ev.target as HTMLElement).closest<HTMLElement>("[data-canvas]");
  if (!canvas || ev.button !== 0) return;
  if ((ev.target as HTMLElement).closest(".node, .drawer, .canvas-tools, .legend")) return;
  drag = { x: ev.clientX, y: ev.clientY, left: canvas.scrollLeft, top: canvas.scrollTop, el: canvas };
  lastPanAt = Date.now();
  canvas.classList.add("dragging");
});
window.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  drag.el.scrollLeft = drag.left - (ev.clientX - drag.x);
  drag.el.scrollTop = drag.top - (ev.clientY - drag.y);
});
window.addEventListener("pointerup", () => {
  drag?.el.classList.remove("dragging");
  drag = null;
});
root.addEventListener(
  "wheel",
  (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    if (!(ev.target as HTMLElement).closest("[data-canvas]")) return;
    ev.preventDefault();
    lastPanAt = Date.now();
    zoomTo(job.zoom * (ev.deltaY < 0 ? 1.08 : 1 / 1.08));
  },
  { passive: false },
);

// --- click delegation ---
root.addEventListener(
  "scroll",
  (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("chat-messages")) return;
    const sessionId = messageListChatId(target, currentRoute());
    if (sessionId) chatScrollBySession.set(sessionId, snapshotChatScroll(sessionId, target));
  },
  true,
);

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => toast({ state: "done", title: tr("Copied"), body: text.length > 64 ? `${text.slice(0, 61)}…` : text, ttlMs: 1800 }),
    () => toast({ state: "failed", title: tr("Copy failed"), body: tr("The clipboard is not available here."), ttlMs: 2400 }),
  );
}

function toggleTheme(origin?: { x: number; y: number }): void {
  setTheme(resolvedTheme() === "dark" ? "light" : "dark", origin);
  render();
}

function switchLang(next: Lang): void {
  if (next === getLang()) return;
  setLang(next);
  applyDocLang();
  render();
}

root.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  // Real links: let modified clicks open a new tab, and links that leave the
  // app (docs, GitHub) navigate as usual; route plain in-app clicks ourselves.
  const link = t.closest<HTMLAnchorElement>("a[href]");
  if (link) {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
    if (!link.getAttribute("href")!.startsWith("#")) return;
    ev.preventDefault();
  }
  if (t.closest("[data-palette]")) return openPalette();
  const nav = t.closest<HTMLElement>("[data-nav]");
  if (nav) return go(nav.dataset.nav!);
  const themeBtn = t.closest<HTMLElement>("[data-theme-toggle]");
  if (themeBtn) return toggleTheme({ x: ev.clientX, y: ev.clientY });
  const setThemeEl = t.closest<HTMLElement>("[data-set-theme]");
  if (setThemeEl) {
    setTheme(setThemeEl.dataset.setTheme as ThemePref, { x: ev.clientX, y: ev.clientY });
    return render();
  }
  const setMotionEl = t.closest<HTMLElement>("[data-set-motion]");
  if (setMotionEl) {
    setMotion(setMotionEl.dataset.setMotion as MotionPref);
    job.motion = !reducedMotion();
    return render();
  }
  const langEl = t.closest<HTMLElement>("[data-lang]");
  if (langEl) return switchLang(langEl.dataset.lang as Lang);
  if (t.closest("[data-notify-toggle]")) {
    void setNotify(!prefs.notify).then(() => render());
    return;
  }
  const copyEl = t.closest<HTMLElement>("[data-copy]");
  if (copyEl) return copy(copyEl.dataset.copy!);
  const cpEl = t.closest<HTMLElement>("[data-cp]");
  if (cpEl && store.run) {
    const id = store.run.runId;
    const action = cpEl.dataset.cp as "approve" | "reject";
    const checkpointId = Number(cpEl.dataset.cpId);
    const note = job.cpNote.trim() || undefined;
    void api
      .checkpoint(id, { action, checkpointId, note })
      .then(() => {
        job.cpNote = "";
        toast({ state: action === "approve" ? "done" : "stopped", title: action === "approve" ? tr("Approved") : tr("Rejected"), body: id, ttlMs: 2400 });
        return store.loadRun(id);
      })
      .catch((err: Error) => toast({ state: "failed", title: tr("Could not resolve the checkpoint"), body: err.message }));
    return;
  }
  const stopEl = t.closest<HTMLElement>("[data-stop]");
  if (stopEl) {
    const id = stopEl.dataset.stop!;
    void api
      .control(id, "stop")
      .then(() => {
        toast({ state: "stopped", title: tr("Stop requested"), body: id, ttlMs: 2600 });
        return store.loadRun(id);
      })
      .catch((err: Error) => toast({ state: "failed", title: tr("Could not stop the run"), body: err.message }));
    return;
  }
  const filterEl = t.closest<HTMLElement>("[data-jobs-filter]");
  if (filterEl) {
    jobs.filter = filterEl.dataset.jobsFilter as JobsFilter;
    jobs.limit = HISTORY_PAGE;
    const slug = jobs.filter === "active" ? "live" : jobs.filter;
    history.replaceState(null, "", slug === "all" ? "#/jobs" : `#/jobs/${slug}`);
    return render();
  }
  if (t.closest("[data-jobs-more]")) {
    jobs.limit += HISTORY_PAGE * 2;
    return render();
  }
  const zoomEl = t.closest<HTMLElement>("[data-zoom]");
  if (zoomEl) {
    const z = zoomEl.dataset.zoom;
    if (z === "fit") return fitGraph();
    return zoomTo(job.zoom * (z === "in" ? 1.15 : 1 / 1.15));
  }
  const logType = t.closest<HTMLElement>("[data-logtype]");
  if (logType) {
    const k = logType.dataset.logtype!;
    if (job.logTypes.has(k)) job.logTypes.delete(k);
    else job.logTypes.add(k);
    return render();
  }
  if (t.closest("[data-logs-more]")) {
    job.logLimit += LOG_PAGE;
    job.follow = false; // reading history: don't yank the view back to the tail
    return render();
  }
  if (t.closest("[data-follow]")) {
    job.follow = !job.follow;
    render();
    if (job.follow) {
      const body = root.querySelector<HTMLElement>(".tab-body");
      if (body) body.scrollTop = body.scrollHeight;
    }
    return;
  }
  const runEl = t.closest<HTMLElement>("[data-run]");
  if (runEl) return go(runHash(runEl.dataset.run!));
  const wfEl = t.closest<HTMLElement>("[data-wf]");
  if (wfEl) return void selectWorkflow(wfEl.dataset.wf!);
  const chatSession = t.closest<HTMLElement>("[data-chat-session]");
  if (chatSession) {
    const id = chatSession.dataset.chatSession!;
    activeChatId = id;
    chatDraft = "";
    store.chatError = "";
    return goOrReload(chatRoute(id));
  }
  if (t.closest("[data-chat-new]") && !store.chatCreating) {
    void (async () => {
      const created = await store.createChatSession();
      if (!created) return;
      activeChatId = created.id;
      chatDraft = "";
      goOrReload(chatRoute(created.id));
    })();
    return;
  }
  const deleteChat = t.closest<HTMLElement>("[data-chat-delete]");
  if (deleteChat && !store.chatCreating && !store.chatSending) {
    const id = deleteChat.dataset.chatDelete!;
    if (!window.confirm(tr("Delete this chat session?"))) return;
    void (async () => {
      const ok = await store.deleteChatSession(id);
      if (!ok) return;
      const next = store.chatSessions?.[0]?.id ?? null;
      activeChatId = next;
      chatDraft = "";
      goOrReload(chatRoute(next));
    })();
    return;
  }
  if (t.closest("[data-chat-send]")) return void sendChat();
  const tabEl = t.closest<HTMLElement>("[data-tab]");
  if (tabEl) return selectTab(tabEl.dataset.tab as JobTab);
  const reviewEl = t.closest<HTMLElement>("[data-review]");
  if (reviewEl) return review(Number(reviewEl.dataset.review));
  const nodeEl = t.closest<HTMLElement>("[data-ai]");
  if (nodeEl) {
    const ai = Number(nodeEl.dataset.ai);
    job.selectedAi = job.selectedAi === ai ? null : ai;
    return render();
  }
  if (t.closest("[data-close]")) {
    job.selectedAi = null;
    return render();
  }
  // An in-app link no handler above claimed goes where its href says.
  if (link) go(link.getAttribute("href")!);
});

function selectTab(next: JobTab): void {
  const r = currentRoute();
  job.tab = next;
  if (r.param) {
    history.replaceState(null, "", `#/job/${encodeURIComponent(r.param)}/${next}`);
    if (next === "result") void store.loadResult(r.param);
  }
  render();
  if (next === "logs" && job.follow) {
    const body = root.querySelector<HTMLElement>(".tab-body");
    if (body) body.scrollTop = body.scrollHeight;
  }
}

// Form state must survive re-renders, so inputs write through to module state.
root.addEventListener("input", (ev) => {
  const el = ev.target as HTMLInputElement | HTMLTextAreaElement;
  switch (el.id) {
    case "chat-input":
      chatDraft = el.value;
      if (store.chatError === "Message text is required." && el.value.trim()) {
        store.chatError = "";
        root.querySelector(".chat-error")?.remove();
      }
      refreshChatComposer();
      return;
    case "jobs-q":
      jobs.query = el.value;
      jobs.limit = HISTORY_PAGE;
      return render();
    case "log-q":
      job.logQuery = el.value;
      return render();
    case "wf-q":
      wfQuery = el.value;
      return render();
    case "cp-note":
      job.cpNote = el.value;
      return;
  }
});

root.addEventListener("compositionstart", () => {
  composing = true;
});
root.addEventListener("compositionend", (ev) => {
  composing = false;
  const el = ev.target as HTMLInputElement | HTMLTextAreaElement;
  if (el.id === "chat-input") chatDraft = el.value;
  if (deferredRender) {
    deferredRender = false;
    render();
  } else if (el.id === "chat-input") refreshChatComposer();
});

root.addEventListener("keydown", (ev) => {
  const el = ev.target as HTMLElement;
  // Focusable rows, cards and graph nodes act like buttons from the keyboard.
  if ((ev.key === "Enter" || ev.key === " ") && el.getAttribute?.("tabindex") === "0" && el.getAttribute("role")) {
    ev.preventDefault();
    el.click();
    return;
  }
  if (el.id === "chat-input" && ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    void sendChat();
  }
  if (el.dataset?.notifyToggle !== undefined && (ev.key === "Enter" || ev.key === " ")) {
    ev.preventDefault();
    void setNotify(!prefs.notify).then(() => render());
  }
});

// --- keyboard shortcuts ---
let gPending = 0;
const G_TARGETS: Record<string, string> = { a: "#/activity", j: "#/jobs", w: "#/workspace", c: "#/chat", s: "#/settings" };

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return isPaletteOpen() ? closePalette() : openPalette();
  }
  if (shortcutsOpen() && e.key === "Escape") return closeShortcuts();
  if (isPaletteOpen() || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "?") {
    e.preventDefault();
    return toggleShortcuts();
  }
  if (e.key === "/") {
    e.preventDefault();
    return openPalette();
  }
  if (e.key === "Escape" && job.selectedAi != null) {
    job.selectedAi = null;
    return render();
  }
  const now = Date.now();
  if (gPending && now - gPending < 900 && G_TARGETS[e.key]) {
    gPending = 0;
    return go(G_TARGETS[e.key]!);
  }
  gPending = e.key === "g" ? now : 0;
  const route = currentRoute();
  if (route.view === "job" && /^[1-5]$/.test(e.key)) selectTab(JOB_TABS[Number(e.key) - 1]!);
  // j / k step through the agents with changes.
  if (route.view === "job" && job.tab === "changes" && store.run && (e.key === "j" || e.key === "k")) {
    const changed = changedAgents(store.run);
    const at = changed.findIndex((c) => c.ai === reviewTarget(store.run!, job.reviewAi)?.ai);
    const next = changed[at + (e.key === "j" ? 1 : -1)];
    if (next) review(next.ai);
  }
  if (route.view === "job" && job.tab === "graph") {
    if (e.key === "+" || e.key === "=") zoomTo(job.zoom * 1.15);
    else if (e.key === "-") zoomTo(job.zoom / 1.15);
    else if (e.key === "0") fitGraph();
  }
});

// --- command palette source ---
setPaletteSource((): PaletteItem[] => {
  const items: PaletteItem[] = [];
  const goTo = tr("Go to");
  const nav: Array<[string, string, string, string]> = [
    ["activity", tr("Activity"), icons.activity, "g a"],
    ["jobs", tr("Jobs"), icons.jobs, "g j"],
    ["workspace", tr("Workspace"), icons.workspace, "g w"],
    ["chat", tr("Chat Host"), icons.chat, "g c"],
    ["settings", tr("Settings"), icons.settings, "g s"],
  ];
  for (const [view, title, icon, hint] of nav) {
    items.push({ id: `nav-${view}`, group: goTo, title, icon, hint, run: () => go(`#/${view}`) });
  }
  const sorted = [...store.runs].sort(
    (a, b) => Number(ACTIVE.has(b.state)) - Number(ACTIVE.has(a.state)) || (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
  for (const r of sorted.slice(0, 80)) {
    const dur = fmtDurSec(runDurationSec(r.createdAt, r.updatedAt, TERMINAL.has(r.state)));
    items.push({
      id: `run-${r.runId}`,
      group: tr("Runs"),
      title: r.name,
      hint: `${tr(r.state)} · ${dur}`,
      icon: glyph(r.state),
      keywords: `${r.runId} ${r.description ?? ""}`,
      run: () => go(runHash(r.runId)),
    });
  }
  for (const w of store.workflows ?? []) {
    items.push({
      id: `wf-${wfKey(w)}`,
      group: tr("Workflows"),
      title: w.name,
      hint: w.rootLabel,
      icon: icons.workspace,
      keywords: w.description ?? "",
      run: () => go(`#/workspace/${encodeURIComponent(wfKey(w))}`),
    });
  }
  const act = tr("Commands");
  items.push({ id: "keys", group: act, title: tr("Keyboard shortcuts"), icon: icons.search, hint: "?", run: () => toggleShortcuts() });
  const dark = resolvedTheme() === "dark";
  items.push({
    id: "theme",
    group: act,
    title: dark ? tr("Switch to light theme") : tr("Switch to dark theme"),
    icon: dark ? icons.sun : icons.moon,
    run: () => toggleTheme(),
  });
  items.push({
    id: "lang",
    group: act,
    title: getLang() === "zh" ? "Switch to English" : "切换到中文",
    icon: icons.globe,
    run: () => switchLang(getLang() === "zh" ? "en" : "zh"),
  });
  items.push({
    id: "motion",
    group: act,
    title: reducedMotion() ? tr("Turn animations on") : tr("Reduce motion"),
    icon: icons.motion,
    run: () => {
      setMotion(reducedMotion() ? "full" : "reduced");
      job.motion = !reducedMotion();
      render();
    },
  });
  items.push({
    id: "notify",
    group: act,
    title: prefs.notify ? tr("Turn run notifications off") : tr("Notify me when runs finish"),
    icon: icons.bell,
    run: () => void setNotify(!prefs.notify).then(() => render()),
  });
  const run = currentRoute().view === "job" ? store.run : null;
  if (run) {
    items.push({ id: "copy-id", group: act, title: tr("Copy run id"), icon: icons.copy, hint: run.runId, run: () => copy(run.runId) });
    if (run.provider === "odw" && TERMINAL.has(run.state) && run.state !== "done") {
      items.push({
        id: "copy-resume",
        group: act,
        title: tr("Copy a resume command"),
        icon: icons.terminal,
        hint: "odw resume",
        run: () => copy(`odw resume ${run.runId}`),
      });
    }
    items.push({
      id: "copy-rerun",
      group: act,
      title: tr("Copy a rerun command"),
      icon: icons.terminal,
      hint: "odw rerun",
      run: () => copy(`odw rerun ${run.runId}`),
    });
    items.push({
      id: "copy-follow",
      group: act,
      title: tr("Copy a follow command"),
      icon: icons.terminal,
      run: () => copy(`odw logs ${run.runId} --follow`),
    });
  }
  return items;
});

// --- run transitions → toasts + desktop notifications ---
store.onTransition((r: RunSummary) => {
  if (r.state === "waiting") {
    const ask = {
      state: "waiting",
      title: tr("{name} is waiting for you", { name: r.name }),
      body: r.waiting?.title ?? tr("A checkpoint needs your decision."),
      href: runHash(r.runId),
      ttlMs: 12_000,
    };
    toast(ask);
    notifyDesktop(ask);
    return;
  }
  const dur = fmtDurSec(runDurationSec(r.createdAt, r.updatedAt, true));
  const title =
    r.state === "done"
      ? tr("{name} finished", { name: r.name })
      : r.state === "failed"
        ? tr("{name} failed", { name: r.name })
        : r.state === "stale"
          ? tr("{name} lost its worker", { name: r.name })
          : tr("{name} stopped", { name: r.name });
  const body = `${dur} · ${tn(r.counts.agents, "{n} agent", "{n} agents")}${r.counts.failed ? ` · ${tr("{n} failed", { n: r.counts.failed })}` : ""}`;
  const spec = { state: r.state, title, body, href: runHash(r.runId) };
  toast(spec);
  notifyDesktop(spec);
});

// When the focused run's summary moves, refresh its detail right away (SSE-driven).
let focusSig = "";
store.subscribe(() => {
  const id = store.focusedRunId;
  if (!id) return;
  const s = store.runs.find((r) => r.runId === id);
  if (!s) return;
  const sig = `${s.state}|${s.counts.running}|${s.counts.done}|${s.counts.failed}|${s.lastActivityTs}`;
  if (sig !== focusSig) {
    const first = focusSig === "";
    focusSig = sig;
    if (!first) void store.loadRun(id);
  }
});

// Re-render on any store change (SSE run list, fetched detail, etc.).
store.subscribe(render);

window.addEventListener("hashchange", () => {
  closePalette(false);
  closeShortcuts();
  void enterRoute();
});

// A one-second clock keeps elapsed times honest while anything runs.
window.setInterval(() => {
  if (document.hidden || composing || isPaletteOpen()) return;
  const view = currentRoute().view;
  if ((view === "activity" || view === "jobs" || view === "job") && activeRuns().length) render();
}, 1000);

watchSystemPrefs(() => {
  job.motion = !reducedMotion();
  render();
});

// Boot. `?snap=1` is a screenshot/CI hook: poll once instead of opening the SSE
// stream, so a headless capture's virtual clock can settle (an open stream keeps
// the network "busy" forever). Harmless in normal use — no one passes it.
const snap = new URLSearchParams(location.search).get("snap") === "1";
applyPrefs();
applyDocLang();
if (!location.hash) location.hash = "#/activity";
if (!snap) store.connect();
// Learn whether this dashboard may write (loopback) so write affordances are
// hidden on a remotely-viewed off-loopback bind rather than failing on click.
void store.loadCapabilities();
void store.loadSettings();
void store.loadRuns().then(() => enterRoute());
