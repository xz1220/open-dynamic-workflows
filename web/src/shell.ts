/** The persistent app shell: unified toolbar, left rail, bottom status bar. */
import { icons, logoSvg } from "./icons";
import { store } from "./store";
import { clsx, esc } from "./util";

export interface Route {
  view: "activity" | "workspace" | "jobs" | "job" | "settings";
  param: string | null;
}

const ACTIVE = new Set(["running", "paused", "pending"]);

export function activeRuns() {
  return store.runs.filter((r) => ACTIVE.has(r.state));
}

function connChip(): string {
  const c = store.conn;
  const label = c === "live" ? "Live · 实时" : c === "reconnecting" ? "Reconnecting…" : "Connecting…";
  return `<span class="conn ${c}"><span class="d"></span>${label}</span>`;
}

function crumb(route: Route): string {
  if (route.view === "job") {
    const id = route.param ?? "";
    const name = store.run?.name ?? "run";
    return `<div class="crumb"><span class="s">Jobs</span><span class="sep">/</span><span class="cur">${esc(name)}</span><span class="idchip">${esc(id)}</span></div>`;
  }
  if (route.view === "workspace" && route.param) {
    return `<div class="crumb"><span class="s">Workspace</span><span class="sep">/</span><span class="cur">${esc(route.param)}</span></div>`;
  }
  const title = route.view[0]!.toUpperCase() + route.view.slice(1);
  return `<div class="crumb"><span class="cur">${esc(title)}</span></div>`;
}

export function toolbar(route: Route): string {
  return (
    `<div class="toolbar">` +
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
        `<span class="ph">${Math.round(r.progress * 100)}%</span></a>`
      );
    })
    .join("");
  const liveSection = active.length
    ? `<div class="divider"></div><div class="section-label"><span>Live now</span><span class="num">${active.length}</span></div>${mini}`
    : "";
  return (
    `<div class="rail">` +
    `<div class="brand">${logoSvg}<span class="wm">odw</span></div>` +
    `<div class="tagline">fan out coding agents</div>` +
    navItem("activity", route, icons.activity, "Activity") +
    navItem("workspace", route, icons.workspace, "Workspace") +
    navItem("jobs", route, icons.jobs, "Jobs", active.length) +
    liveSection +
    `<div class="spacer"></div>` +
    navItem("settings", route, icons.settings, "Settings") +
    `</div>`
  );
}

export function statusbar(): string {
  const active = activeRuns().length;
  const running = store.runs.reduce((n, r) => n + r.counts.running, 0);
  const live = store.conn === "live";
  return (
    `<div class="statusbar">` +
    `<span>${active} active · ${running} running</span>` +
    `<span>runs/&lt;workflow&gt;/&lt;runId&gt;</span>` +
    `<span style="display:inline-flex;align-items:center;gap:7px;"><span class="live-dot${live ? "" : " off"}"></span> ${live ? "live · SSE" : store.conn}</span>` +
    `</div>`
  );
}
