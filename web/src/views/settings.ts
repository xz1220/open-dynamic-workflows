/**
 * Settings — adapters and paths (read from `/api/settings`), plus presentation
 * preferences: theme, motion, language, and run notifications. Preferences are
 * client-only; nothing here starts or controls a run.
 */
import { glyph } from "../components/glyph";
import { icons } from "../icons";
import { getLang, t } from "../i18n";
import { notificationsAvailable, prefs } from "../prefs";
import type { SettingsSnapshot } from "../types";
import { esc } from "../util";

function row(title: string, sub: string, control = "", cls = ""): string {
  const subClass = /^[~/.]|^[A-Za-z]:\\/.test(sub) ? "path" : "d";
  return (
    `<div class="setrow ${cls}"><div class="body"><h4>${title}</h4>` +
    (sub ? `<div class="${subClass}">${esc(sub)}</div>` : "") +
    `</div>${control}</div>`
  );
}

function seg(attr: string, current: string, options: Array<[string, string, string?]>): string {
  return (
    `<span class="seg">` +
    options
      .map(([v, label, icon]) => `<b class="${current === v ? "on" : ""}" data-${attr}="${v}">${icon ?? ""}${esc(label)}</b>`)
      .join("") +
    `</span>`
  );
}

/**
 * Run-completion hooks from the config's `notify` key, as the server reports
 * them (a webhook is shown as scheme + host only — never its token-bearing path).
 */
function hooksCard(settings: SettingsSnapshot | null): string {
  if (!settings) return "";
  // Older servers have no notify block at all.
  const notify: SettingsSnapshot["notify"] | undefined = settings.notify;
  const on = notify?.on?.length ? notify.on.map((s) => t(s)).join(" · ") : "";
  const body = notify && (notify.command || notify.webhook)
    ? (notify.command ? row(t("Command hook"), t("runs on {on}", { on }), `<span class="tag sig">${t("on")}</span>`) : "") +
      (notify.webhook ? row(t("Webhook"), `${notify.webhook} · ${t("runs on {on}", { on })}`, `<span class="tag sig">${t("on")}</span>`) : "")
    : `<p class="dim" style="margin:6px 0 14px;font-size:12.5px">${t("No hooks configured. Add a notify block to odw.config.json to run a command or post to a webhook when a run finishes.")}</p>` +
      `<pre class="code" style="padding:12px 16px;font-size:11.5px">{ "notify": { "webhook": "https://hooks.example/…", "on": ["done", "failed"] } }</pre>`;
  return `<section class="card setcard"><div class="card-head"><h3>${t("Run hooks")}</h3><span class="eyebrow">notify</span></div>${body}</section>`;
}

export function renderSettings(settings: SettingsSnapshot | null): string {
  const adapters = (settings?.adapters ?? [])
    .map((a) =>
      row(
        `${a.installed ? glyph("done") : glyph("pending")}${esc(a.label)}${a.isDefault ? ` <span class="tag sig">${t("default")}</span>` : ""}`,
        `${a.command} · ${a.permissionNote}`,
        `<span class="tag${a.installed ? "" : " warn"}">${a.installed ? t("available") : t("not found")}</span>`,
        a.installed ? "" : "missing",
      ),
    )
    .join("");
  const roots = (settings?.workflowRoots ?? [])
    .map((r) => row(`${esc(r.label)} <span class="tag${r.provider === "claude" ? " cc" : ""}">${esc(r.provider)}</span>`, r.path))
    .join("");
  const loading = `<div class="empty" style="min-height:120px"><div class="spinner"></div></div>`;
  const notify = notificationsAvailable()
    ? `<span class="switch${prefs.notify ? " on" : ""}" role="switch" aria-checked="${prefs.notify}" data-notify-toggle tabindex="0"></span>`
    : `<span class="tag">${t("unsupported")}</span>`;

  return (
    `<div class="page">` +
    `<header class="page-head"><div><div class="eyebrow">${t("Settings")}</div><h1 class="display">${t("How odw <em>reads</em> your machine.")}</h1>` +
    `<p class="lede" style="margin-top:12px">${t("Adapters and paths come from your config. Preferences below only change this dashboard.")}</p></div></header>` +
    `<div class="settings-grid">` +
    `<section class="card setcard"><div class="card-head"><h3>${t("Adapters")}</h3><span class="eyebrow">${t("CLIs odw can drive")}</span></div>${adapters || loading}</section>` +
    `<div style="display:flex;flex-direction:column;gap:20px">` +
    `<section class="card setcard"><div class="card-head"><h3>${t("Appearance")}</h3></div>` +
    row(t("Theme"), t("Paper by day, carbon by night."), seg("set-theme", prefs.theme, [["system", t("System")], ["light", t("Light"), icons.sun], ["dark", t("Dark"), icons.moon]])) +
    row(t("Motion"), t("Live animation — or keep it still."), seg("set-motion", prefs.motion, [["system", t("System")], ["full", t("Full")], ["reduced", t("Reduced")]])) +
    row(t("Language"), t("switch the interface language"), seg("lang", getLang(), [["en", "EN"], ["zh", "中文"]])) +
    row(t("Run notifications"), t("A system notification when a run finishes while this tab is in the background."), notify) +
    `</section>` +
    hooksCard(settings) +
    `<section class="card setcard"><div class="card-head"><h3>${t("Paths")}</h3></div>` +
    (settings
      ? row(t("Run directory"), settings.runsRoot) +
        row(t("Current project"), settings.cwd) +
        row(t("Config file"), settings.configPath ?? t("built-in defaults"))
      : loading) +
    `</section>` +
    `<section class="card setcard"><div class="card-head"><h3>${t("Workflow directories")}</h3></div>${roots || loading}</section>` +
    `</div></div>` +
    `<div class="note-banner">${icons.terminal}<span>${t("Runs start from your agent via {cmd}. Claude Code runs stay strictly read-only.", { cmd: "<code>odw run &lt;name&gt;</code>" })}</span></div>` +
    `</div>`
  );
}
