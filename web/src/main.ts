/**
 * App entry: hash router + a route-aware poller, all read-only.
 *
 * The run list stays live over SSE (store.connect). The focused data for the
 * current route — a run's DAG/logs, the Activity firehose, the Workspace list —
 * is refreshed on a gentle interval while that route is shown. Rendering is a
 * full innerHTML swap of the active view; the shell (toolbar/rail/status) and the
 * view are recomputed from store state on every emit. A click layer delegates
 * navigation and the few read-only affordances (select node, copy id, tabs).
 */
import { rail, statusbar, toolbar, type Route } from "./shell";
import { store } from "./store";
import { renderActivity } from "./views/activity";
import { renderJob, type JobTab } from "./views/job";
import { renderJobs } from "./views/jobs";
import { renderSettings } from "./views/settings";
import { orderedWorkflows, renderWorkspace, wfKey } from "./views/workspace";
import type { WorkflowDetail } from "./types";
import { api } from "./api";
import { syncNative, isNative } from "./native";
import { getLang, setLang, t as tr, type Lang } from "./i18n";

/** Reflect the chosen language on <html lang> (a11y + correct CJK shaping). */
function applyDocLang(): void {
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
}

const root = document.getElementById("app")!;

// --- view-local UI state (not in the store) ---
let jobTab: JobTab = "graph";
let selectedAi: number | null = null;
let wfActive: string | null = null;
let wfDetail: WorkflowDetail | null = null;
let poll: number | null = null;

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [view, ...rest] = h.split("/");
  switch (view) {
    case "workspace":
      return { view: "workspace", param: rest.length ? decodeURIComponent(rest[0]!) : null };
    case "jobs":
      return { view: "jobs", param: null };
    case "job": {
      // #/job/<runId>[/<tab>] — the trailing tab segment is optional.
      const last = rest[rest.length - 1];
      if (last === "logs" || last === "result" || last === "graph") {
        jobTab = last;
        return { view: "job", param: rest.slice(0, -1).join("/") || null };
      }
      jobTab = "graph";
      return { view: "job", param: rest.join("/") || null };
    }
    case "settings":
      return { view: "settings", param: null };
    default:
      return { view: "activity", param: null };
  }
}

function currentRoute(): Route {
  return parseHash();
}

function viewHtml(route: Route): string {
  switch (route.view) {
    case "activity":
      return renderActivity();
    case "workspace":
      return renderWorkspace(wfActive, wfDetail);
    case "jobs":
      return renderJobs();
    case "job":
      return renderJob(jobTab, selectedAi);
    case "settings":
      return renderSettings();
  }
}

function render(): void {
  const route = currentRoute();
  syncNative(store.runs); // drive Dock badge + native notifications when wrapped
  root.innerHTML =
    `<div class="app">` +
    toolbar(route) +
    rail(route) +
    `<div class="main">${viewHtml(route)}</div>` +
    statusbar() +
    `</div>`;
}

// --- per-route data loading + polling ---
async function enterRoute(): Promise<void> {
  const route = currentRoute();
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
  if (route.view === "activity") {
    await store.loadActivity();
    poll = window.setInterval(() => store.loadActivity(), 1500);
  } else if (route.view === "workspace") {
    if (store.workflows === null) await store.loadWorkflows();
    // Default-select the first workflow (or the routed one). Keys are provider:name.
    // Use render order so the default highlight matches the visually-first row.
    const first = store.workflows ? orderedWorkflows(store.workflows)[0] : undefined;
    const want = route.param ?? wfActive ?? (first ? wfKey(first) : null);
    if (want && want !== wfActive) await selectWorkflow(want, false);
    else render();
  } else if (route.view === "jobs") {
    render();
  } else if (route.view === "job" && route.param) {
    if (store.run?.runId !== route.param) {
      store.clearRun();
      selectedAi = null;
      render();
    }
    await store.loadRun(route.param);
    if (jobTab === "result") await store.loadResult(route.param);
    poll = window.setInterval(async () => {
      const r = currentRoute();
      if (r.view !== "job" || r.param !== route.param) return;
      await store.loadRun(route.param!);
      if (jobTab === "result" && !store.resultLoaded) await store.loadResult(route.param!);
    }, 1200);
  } else {
    render();
  }
}

async function selectWorkflow(key: string, navigate = true): Promise<void> {
  wfActive = key;
  wfDetail = null;
  render();
  // key is `provider:name`; name has no colon, so split on the first one. Tolerate
  // a bare name (old bookmark) by treating the whole thing as the name.
  const i = key.indexOf(":");
  const provider = i >= 0 ? key.slice(0, i) : undefined;
  const name = i >= 0 ? key.slice(i + 1) : key;
  try {
    wfDetail = await api.workflow(name, provider);
    // Normalize to the canonical provider:name so a bare-name (old-bookmark) key
    // still highlights its list row, which compares against wfKey(w).
    if (wfDetail) wfActive = wfKey(wfDetail);
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

// --- click delegation (read-only affordances only) ---
root.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const nav = t.closest<HTMLElement>("[data-nav]");
  if (nav) {
    go(nav.dataset.nav!);
    return;
  }
  const runEl = t.closest<HTMLElement>("[data-run]");
  if (runEl) {
    go(`#/job/${encodeURIComponent(runEl.dataset.run!)}`);
    return;
  }
  const wfEl = t.closest<HTMLElement>("[data-wf]");
  if (wfEl) {
    void selectWorkflow(wfEl.dataset.wf!);
    return;
  }
  const tabEl = t.closest<HTMLElement>("[data-tab]");
  if (tabEl) {
    const nextTab = tabEl.dataset.tab as JobTab;
    const r = currentRoute();
    jobTab = nextTab;
    if (r.param) {
      history.replaceState(null, "", `#/job/${encodeURIComponent(r.param)}/${nextTab}`);
      if (nextTab === "result") void store.loadResult(r.param);
    }
    render();
    return;
  }
  const langEl = t.closest<HTMLElement>("[data-lang]");
  if (langEl) {
    const next = langEl.dataset.lang as Lang;
    if (next !== getLang()) {
      setLang(next);
      applyDocLang();
      render();
    }
    return;
  }
  const nodeEl = t.closest<HTMLElement>("[data-ai]");
  if (nodeEl) {
    const ai = Number(nodeEl.dataset.ai);
    selectedAi = selectedAi === ai ? null : ai;
    render();
    return;
  }
  if (t.closest("[data-close]")) {
    selectedAi = null;
    render();
    return;
  }
  const copyEl = t.closest<HTMLElement>("[data-copy]");
  if (copyEl) {
    void navigator.clipboard?.writeText(copyEl.dataset.copy!).catch(() => {});
    copyEl.textContent = tr("✓ copied");
    setTimeout(() => render(), 900);
    return;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectedAi != null) {
    selectedAi = null;
    render();
  }
});

window.addEventListener("hashchange", () => {
  void enterRoute();
});

// Re-render on any store change (SSE run list, fetched detail, etc.).
store.subscribe(render);

// Boot. `?snap=1` is a screenshot/CI hook: poll once instead of opening the SSE
// stream, so a headless capture's virtual clock can settle (an open stream keeps
// the network "busy" forever). Harmless in normal use — no one passes it.
const snap = new URLSearchParams(location.search).get("snap") === "1";
// In the Tauri shell the OS draws real traffic lights (Overlay titlebar), so drop
// our decorative ones and inset the toolbar to clear them (see .is-native in CSS).
document.body.classList.toggle("is-native", isNative());
applyDocLang();
if (!location.hash) location.hash = "#/activity";
if (!snap) store.connect();
void store.loadRuns().then(() => enterRoute());
