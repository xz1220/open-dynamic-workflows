/** The persistent app shell: left rail, topbar (crumbs + search + live chip), status bar. */
import { icons, logoSvg } from "./icons";
import { getLang, t } from "./i18n";
import { resolvedTheme } from "./prefs";
import { store } from "./store";
import { ACTIVE, clsx, esc } from "./util";

export interface Route {
  view: "chat" | "activity" | "workspace" | "jobs" | "job" | "compare" | "evals" | "settings";
  param: string | null;
}

export function activeRuns() {
  return store.runs.filter((r) => ACTIVE.has(r.state));
}

function navItem(view: string, route: Route, icon: string, label: string, key: string, count?: number): string {
  const on = route.view === view || (view === "jobs" && (route.view === "job" || route.view === "compare"));
  const badge = count ? `<span class="count">${count}</span>` : `<kbd>g ${key}</kbd>`;
  return (
    `<a class="${clsx("navitem", on && "on")}" href="#/${view}" data-nav="#/${view}" data-key="nav-${view}"` +
    `${on ? ' aria-current="page"' : ""}>${icon}<span>${esc(label)}</span>${badge}</a>`
  );
}

/** A tiny progress ring for the rail's live-run list. */
function ring(progress: number): string {
  const c = 2 * Math.PI * 7;
  const off = c * (1 - Math.min(1, Math.max(0, progress)));
  return (
    `<svg class="ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="bg" cx="9" cy="9" r="7"/>` +
    `<circle class="fg" cx="9" cy="9" r="7" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>`
  );
}

export function rail(route: Route): string {
  const active = activeRuns();
  const mini = active
    .slice(0, 7)
    .map((r) => {
      const on = route.view === "job" && route.param === r.runId;
      return (
        `<a class="minirun ${esc(r.state)}${on ? " on" : ""}" href="#/job/${encodeURIComponent(r.runId)}" data-run="${esc(r.runId)}" data-key="mr-${esc(r.runId)}" title="${esc(r.name)} · ${esc(r.runId)}">` +
        `${ring(r.progress)}<span class="nm">${esc(r.name)}</span>` +
        `<span class="pct mono faint">${Math.round(r.progress * 100)}%</span></a>`
      );
    })
    .join("");
  const more =
    active.length > 7 ? `<a class="rail-more" href="#/jobs/live" data-nav="#/jobs/live">${t("+{n} more", { n: active.length - 7 })}</a>` : "";
  const live = active.length
    ? `<div class="rail-label"><span>${t("Live now")}</span><span class="num">${active.length}</span></div>${mini}${more}`
    : "";
  const dark = resolvedTheme() === "dark";
  return (
    `<aside class="rail">` +
    `<a class="brand" href="#/activity" data-nav="#/activity" aria-label="odw">${logoSvg(active.length > 0)}<span class="wordmark">odw</span></a>` +
    `<div class="brand-sub">${t("dynamic workflows")}</div>` +
    `<nav class="nav">` +
    navItem("activity", route, icons.activity, t("Activity"), "a") +
    navItem("jobs", route, icons.jobs, t("Jobs"), "j", active.length) +
    navItem("workspace", route, icons.workspace, t("Workspace"), "w") +
    navItem("evals", route, icons.evals, t("Evals"), "e") +
    navItem("chat", route, icons.chat, t("Chat"), "c") +
    `</nav>` +
    live +
    `<div class="spacer"></div>` +
    `<div class="rail-foot">` +
    navItem("settings", route, icons.settings, t("Settings"), "s") +
    `<div class="rail-tools">` +
    `<button class="iconbtn" data-theme-toggle aria-label="${esc(t("Toggle theme"))}" data-tip="${esc(dark ? t("Light") : t("Dark"))}">${dark ? icons.sun : icons.moon}</button>` +
    `<button class="iconbtn lang" data-lang="${getLang() === "zh" ? "en" : "zh"}" aria-label="${esc(t("Language"))}" data-tip="${getLang() === "zh" ? "English" : "中文"}">${icons.globe}</button>` +
    `</div></div>` +
    `</aside>`
  );
}

function crumbs(route: Route): string {
  const sep = `<span class="sep">/</span>`;
  const link = (hash: string, label: string) => `<a href="${hash}" data-nav="${hash}">${esc(label)}</a>`;
  switch (route.view) {
    case "job": {
      const run = store.run?.runId === route.param ? store.run : store.runs.find((r) => r.runId === route.param);
      return (
        link("#/jobs", t("Jobs")) +
        sep +
        (run ? `<span class="here">${esc(run.name)}</span>${sep}` : "") +
        `<span class="here mono">${esc(route.param ?? "")}</span>`
      );
    }
    case "compare": {
      const [a = "", b = ""] = (route.param ?? "").split("/");
      return (
        link("#/jobs", t("Jobs")) +
        sep +
        `<span class="here">${t("Compare")}</span>${sep}` +
        `<span class="here mono">${esc(a)} → ${esc(b)}</span>`
      );
    }
    case "evals": {
      if (!route.param) return `<span class="here">${t("Evals")}</span>`;
      const [name = "", id = ""] = route.param.split("/");
      return link("#/evals", t("Evals")) + sep + `<span class="here">${esc(name)}</span>${sep}<span class="here mono">${esc(id)}</span>`;
    }
    case "workspace":
      return `<span class="here">${t("Workspace")}</span>`;
    case "jobs":
      return `<span class="here">${t("Jobs")}</span>`;
    case "chat":
      return `<span class="here">${t("Chat Host")}</span>`;
    case "settings":
      return `<span class="here">${t("Settings")}</span>`;
    default:
      return `<span class="here">${t("Activity")}</span>`;
  }
}

function connChip(): string {
  const c = store.conn;
  const label = c === "live" ? t("Live") : c === "reconnecting" ? t("Reconnecting…") : t("Connecting…");
  return `<span class="conn ${c}" data-tip="${esc(t("run list over server-sent events"))}"><span class="d"></span>${label}</span>`;
}

export function topbar(route: Route): string {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  return (
    `<header class="topbar">` +
    `<div class="crumbs">${crumbs(route)}</div>` +
    `<button class="searchbtn" data-palette>${icons.search}<span>${t("Search runs, workflows and commands…")}</span><kbd>${mod} K</kbd></button>` +
    connChip() +
    `</header>`
  );
}

export function statusbar(): string {
  const active = activeRuns();
  const running = active.reduce((n, r) => n + r.counts.running, 0);
  const live = store.conn === "live";
  const settings = store.settings;
  return (
    `<footer class="statusbar">` +
    `<span><b>${active.length}</b> ${t("active")} · <b>${running}</b> ${t("agents running")}</span>` +
    `<span class="grow"></span>` +
    (settings ? `<span title="${esc(settings.runsRoot)}">${esc(settings.runsRoot)}</span>` : "") +
    `<span><span class="live-dot${live ? "" : " off"}"></span>${live ? t("live · SSE") : esc(t(store.conn))}</span>` +
    `</footer>`
  );
}
