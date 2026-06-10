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
import { renderJob, saveForm, type JobTab } from "./views/job";
import { renderJobs } from "./views/jobs";
import { launchForm, prefillLaunch, rememberDir, renderLaunch } from "./views/launch";
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
    case "launch":
      return { view: "launch", param: null };
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
    case "launch":
      return renderLaunch();
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
  } else if (route.view === "launch") {
    render();
    if (store.adapters === null) await store.loadAdapters();
  } else if (route.view === "job" && route.param) {
    if (store.run?.runId !== route.param) {
      store.clearRun();
      selectedAi = null;
      saveForm.savedPath = "";
      saveForm.error = "";
      saveForm.name = "";
      render();
    }
    if (store.adapters === null) void store.loadAdapters();
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
  if (t.closest("[data-generate]") && !launchForm.busy) {
    void (async () => {
      launchForm.busy = true;
      launchForm.error = "";
      render();
      try {
        // Read the live DOM values: the select's preselected default counts even
        // when the user never touched it (module state only tracks edits).
        const adapterEl = document.getElementById("lf-adapter") as HTMLSelectElement | null;
        const sourceEl = document.getElementById("lf-source") as HTMLInputElement | null;
        const adapter = (adapterEl?.value ?? launchForm.adapter).trim();
        const source = (sourceEl?.value ?? launchForm.source).trim();
        const body: { task: string; adapter?: string; source?: string } = { task: launchForm.task.trim() };
        if (adapter) body.adapter = adapter;
        if (source) body.source = source;
        const { runId } = await api.generate(body);
        rememberDir(body.source ?? "");
        launchForm.busy = false;
        go(`#/job/${encodeURIComponent(runId)}`);
      } catch (err) {
        launchForm.busy = false;
        launchForm.error = (err as Error).message;
        render();
      }
    })();
    return;
  }
  const stopEl = t.closest<HTMLElement>("[data-stop]");
  if (stopEl) {
    void api
      .control(stopEl.dataset.stop!, "stop")
      .then(() => store.loadRun(stopEl.dataset.stop!))
      .catch(() => {});
    return;
  }
  if (t.closest("[data-run-generated]")) {
    const run = store.run;
    const gen = store.result as { script?: unknown } | undefined;
    if (!run || !gen || typeof gen.script !== "string") return;
    void (async () => {
      try {
        const body: { script: string; adapter?: string; source?: string } = { script: gen.script as string };
        if (run.adapter) body.adapter = run.adapter;
        if (run.source) body.source = run.source;
        const { runId } = await api.launchRun(body);
        go(`#/job/${encodeURIComponent(runId)}`);
      } catch (err) {
        alert((err as Error).message);
      }
    })();
    return;
  }
  if (t.closest("[data-regenerate]")) {
    const run = store.run;
    const args = (run?.args ?? {}) as { task?: unknown };
    prefillLaunch({
      task: typeof args.task === "string" ? args.task : "",
      adapter: run?.adapter ?? "",
      source: run?.source ?? "",
    });
    go("#/launch");
    return;
  }
  if (t.closest("[data-save]") && !saveForm.busy) {
    const run = store.run;
    if (!run) return;
    const nameInput = document.getElementById("save-name") as HTMLInputElement | null;
    const name = (nameInput?.value ?? saveForm.name ?? "").trim();
    void (async () => {
      saveForm.busy = true;
      saveForm.error = "";
      render();
      try {
        const { path } = await api.saveWorkflow({
          name,
          fromRun: run.runId,
          scope: saveForm.scope,
          ...(saveForm.scope === "project" && run.source ? { projectDir: run.source } : {}),
        });
        saveForm.savedPath = path;
        // The Workspace list has a new entry now; refresh its cache.
        void store.loadWorkflows();
      } catch (err) {
        saveForm.error = (err as Error).message;
      }
      saveForm.busy = false;
      render();
    })();
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

// Form state must survive full innerHTML re-renders (SSE pushes repaint the
// app), so inputs write through to module state as the user types.
root.addEventListener("input", (ev) => {
  const el = ev.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (el.id === "lf-task") launchForm.task = el.value;
  else if (el.id === "lf-adapter") {
    launchForm.adapter = el.value;
    render(); // the permission line tracks the selected adapter
  } else if (el.id === "lf-source") launchForm.source = el.value;
  else if (el.id === "save-name") saveForm.name = el.value;
  else if (el.id === "save-scope") saveForm.scope = el.value === "project" ? "project" : "global";
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
