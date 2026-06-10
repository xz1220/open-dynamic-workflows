/** The persistent app shell: unified toolbar, left rail, bottom status bar. */
import { icons, logoSvg } from "./icons";
import { t } from "./i18n";
import { store } from "./store";
import { ACTIVE, clsx, esc } from "./util";

export interface Route {
  view: "activity" | "workspace" | "jobs" | "job" | "settings" | "launch";
  param: string | null;
}

export function activeRuns() {
  return store.runs.filter((r) => ACTIVE.has(r.state));
}

function connChip(): string {
  const c = store.conn;
  const label = c === "live" ? t("Live") : c === "reconnecting" ? t("Reconnecting…") : t("Connecting…");
  return `<span class="conn ${c}"><span class="d"></span>${label}</span>`;
}

function crumb(_route: Route): string {
  // No toolbar title on any page — the left rail already shows the active section,
  // and detail pages carry their own heading.
  return "";
}

export function toolbar(route: Route): string {
  // `data-tauri-drag-region="deep"` makes the whole top bar a window-drag handle in
  // the native (Tauri) shell: it calls the real `start_dragging`, which WKWebView
  // honors, and the "deep" mode drags on a click anywhere in the subtree while
  // Tauri's runtime still auto-excludes real controls (<a>/<button>/<input>…). In a
  // plain browser (`odw serve`) it's just an inert data-attribute — no behavior change.
  return (
    `<div class="toolbar" data-tauri-drag-region="deep">` +
    `<div style="display:flex;align-items:center;"><div class="tl"><i class="r"></i><i class="y"></i><i class="g"></i></div>${crumb(route)}</div>` +
    `<div class="tr"><span class="kbd">⌘K</span>${connChip()}</div>` +
    `</div>`
  );
}

function navItem(view: string, route: Route, icon: string, label: string, count?: number): string {
  const on = route.view === view || (view === "jobs" && route.view === "job");
  const badge = count ? `<span class="count">${count}</span>` : "";
  return `<a class="${clsx("navitem", on && "on")}" data-nav="#/${view}">${icon}${esc(label)}${badge}</a>`;
}

export function rail(route: Route): string {
  const active = activeRuns();
  const mini = active
    .slice(0, 6)
    .map((r) => {
      const paused = r.state === "paused";
      return (
        `<a class="minirun" data-run="${esc(r.runId)}">` +
        `<span class="dot${paused ? " paused" : ""}"></span>` +
        `<span class="nm">${esc(r.name)}</span>` +
        (r.provider === "claude" ? `<span class="ccmini" title="Claude Code">CC</span>` : "") +
        `<span class="ph">${Math.round(r.progress * 100)}%</span></a>`
      );
    })
    .join("");
  const liveSection = active.length
    ? `<div class="divider"></div><div class="section-label"><span>${t("Live now")}</span><span class="num">${active.length}</span></div>${mini}`
    : "";
  return (
    `<div class="rail">` +
    `<div class="brand">${logoSvg}<span class="wm">odw</span></div>` +
    `<div class="tagline">${t("fan out coding agents")}</div>` +
    navItem("launch", route, icons.launch, t("Launch")) +
    navItem("activity", route, icons.activity, t("Activity")) +
    navItem("workspace", route, icons.workspace, t("Workspace")) +
    navItem("jobs", route, icons.jobs, t("Jobs"), active.length) +
    liveSection +
    `<div class="spacer"></div>` +
    navItem("settings", route, icons.settings, t("Settings")) +
    `</div>`
  );
}

export function statusbar(): string {
  const active = activeRuns();
  const running = active.reduce((n, r) => n + r.counts.running, 0);
  const live = store.conn === "live";
  return (
    `<div class="statusbar">` +
    `<span>${t("{a} active · {r} running", { a: active.length, r: running })}</span>` +
    `<span>runs/&lt;workflow&gt;/&lt;runId&gt;</span>` +
    `<span style="display:inline-flex;align-items:center;gap:7px;"><span class="live-dot${live ? "" : " off"}"></span> ${live ? t("live · SSE") : t(store.conn)}</span>` +
    `</div>`
  );
}
