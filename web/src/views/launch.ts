/**
 * Launch — the task pad (launch.md §3.4). One-shot interaction: describe a
 * task, pick an agent, point at a directory → POST /api/generate → jump to the
 * generation run's live DAG. The rest of the flow lives in the Job views.
 *
 * Form state survives re-renders (SSE pushes repaint the whole app) in a
 * module-level object that main.ts keeps updated through input delegation.
 */
import { t } from "../i18n";
import { store } from "../store";
import { esc } from "../util";

export interface LaunchFormState {
  task: string;
  adapter: string;
  source: string;
  busy: boolean;
  error: string;
}

export const launchForm: LaunchFormState = {
  task: "",
  adapter: "",
  source: "",
  busy: false,
  error: "",
};

const RECENTS_KEY = "odw.launch.recent-dirs";

export function recentDirs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function rememberDir(dir: string): void {
  if (!dir) return;
  try {
    const next = [dir, ...recentDirs().filter((d) => d !== dir)].slice(0, 6);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** Prefill the form (Regenerate from a generation run) and clear transient state. */
export function prefillLaunch(values: { task?: string; adapter?: string; source?: string }): void {
  if (values.task !== undefined) launchForm.task = values.task;
  if (values.adapter !== undefined) launchForm.adapter = values.adapter;
  if (values.source !== undefined) launchForm.source = values.source;
  launchForm.busy = false;
  launchForm.error = "";
}

/**
 * The adapter the form should act on: the user's explicit pick, else the
 * configured default IF it's installed, else the first installed adapter. Never
 * an uninstalled adapter — selecting one yields an `<option selected disabled>`
 * whose value still posts, producing a guaranteed spawn-ENOENT run. Returns ""
 * when nothing is installed.
 */
export function effectiveAdapter(): string {
  const adapters = store.adapters ?? [];
  if (launchForm.adapter && adapters.some((a) => a.name === launchForm.adapter && a.installed)) {
    return launchForm.adapter;
  }
  const def = adapters.find((a) => a.isDefault && a.installed);
  if (def) return def.name;
  return adapters.find((a) => a.installed)?.name ?? "";
}

function adapterOptions(): string {
  const adapters = store.adapters ?? [];
  if (adapters.length === 0) return `<option value="">${t("loading adapters…")}</option>`;
  const selected = effectiveAdapter();
  return adapters
    .map((a) => {
      const flag = a.installed ? "" : ` — ${t("not installed")}`;
      const sel = a.name === selected ? " selected" : "";
      const dis = a.installed ? "" : " disabled";
      return `<option value="${esc(a.name)}"${sel}${dis}>${esc(a.name)}${flag}</option>`;
    })
    .join("");
}

/** The permission line for the currently selected adapter (transparency, §3.5-4). */
function permissionLine(): string {
  const adapters = store.adapters ?? [];
  const chosen = adapters.find((a) => a.name === effectiveAdapter());
  if (!chosen) return "";
  return (
    `<div class="lf-perm"><span class="k">${t("agent permissions")}</span>` +
    `<span class="v">${esc(chosen.permissionNote)}</span></div>`
  );
}

export function renderLaunch(): string {
  // Off-loopback dashboards can't write — show the read-only truth instead of a
  // form whose Generate would 409. Mirrors the server's writeGuard.
  if (!store.capabilities.writable) {
    return (
      `<div class="content launch">` +
      `<h1 class="page-h1">${t("Launch")}</h1>` +
      `<div class="empty"><div class="gh">${t("Read-only dashboard")}</div>` +
      `<div>${t("This dashboard is served off-loopback, so it can only observe. Start runs from the local app or the CLI.")}</div>` +
      `<div class="codehint">odw run &lt;name&gt;</div></div>` +
      `</div>`
    );
  }
  const recents = recentDirs();
  const datalist = recents.length
    ? `<datalist id="recent-dirs">${recents.map((d) => `<option value="${esc(d)}"></option>`).join("")}</datalist>`
    : "";
  const err = launchForm.error
    ? `<div class="lf-error">✕ ${esc(launchForm.error)}</div>`
    : "";
  return (
    `<div class="content launch">` +
    `<h1 class="page-h1">${t("Launch")}</h1>` +
    `<p class="page-sub">${t("Describe a task. The system generates a dynamic workflow — preview it, run it, watch it live in Jobs.")}</p>` +
    `<div class="lform">` +
    `<label class="lf-label">${t("Task")}</label>` +
    `<textarea id="lf-task" class="lf-task" rows="5" placeholder="${esc(t("e.g. Review the auth module for race conditions; have a second agent verify every finding adversarially."))}">${esc(launchForm.task)}</textarea>` +
    `<div class="lf-row">` +
    `<div class="lf-col"><label class="lf-label">${t("Agent")}</label>` +
    `<select id="lf-adapter" class="lf-select">${adapterOptions()}</select></div>` +
    `<div class="lf-col grow"><label class="lf-label">${t("Source directory")}</label>` +
    `<input id="lf-source" class="lf-input" list="recent-dirs" placeholder="${esc(t("defaults to the directory odw serve runs in"))}" value="${esc(launchForm.source)}">${datalist}</div>` +
    `</div>` +
    permissionLine() +
    err +
    `<div class="lf-actions">` +
    `<span class="btn primary${launchForm.busy ? " disabled" : ""}" data-generate="1">${launchForm.busy ? t("Generating…") : t("⚡ Generate workflow")}</span>` +
    `<span class="lf-hint">${t("Generation itself runs as a workflow — you can watch it in Jobs.")}</span>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}
