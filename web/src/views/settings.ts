/**
 * Settings — adapters + app preferences. Read-only this iteration: the values
 * shown are illustrative of what the runtime config exposes; nothing here starts
 * or controls a run. (A narrow /api/config read endpoint can back this later.)
 */
import { esc } from "../util";

function setRow(title: string, sub: string, control: string): string {
  return (
    `<div class="setrow"><div class="body"><h4>${title}</h4>` +
    (sub ? `<div class="${sub.startsWith("/") || sub.startsWith("~") ? "path" : "d"}">${esc(sub)}</div>` : "") +
    `</div>${control}</div>`
  );
}

function toggle(on: boolean): string {
  return `<span class="toggle ${on ? "" : "off"}"><i></i></span>`;
}

const adapters = [
  { name: "claude", path: "/usr/local/bin/claude · sonnet", def: true, found: true },
  { name: "codex", path: "/opt/homebrew/bin/codex", def: false, found: true },
  { name: "gemini", path: "/usr/local/bin/gemini", def: false, found: true },
  { name: "qwen", path: "/usr/local/bin/qwen", def: false, found: true },
  { name: "kimi", path: "add a path in odw.config.json", def: false, found: false },
];

export function renderSettings(): string {
  const adapterRows = adapters
    .map((a) => {
      const title = a.found
        ? `${esc(a.name)}${a.def ? ` <span style="font-weight:400;color:var(--green-deep);font-size:12px;">· default</span>` : ""}`
        : `<span style="color:var(--muted)">${esc(a.name)} <span style="color:var(--faint);font-weight:400;">· not found</span></span>`;
      return setRow(title, a.path, `<span class="btn secondary sm">test</span>`);
    })
    .join("");

  return (
    `<div class="content">` +
    `<h1 class="page-h1">Settings</h1>` +
    `<p class="page-sub">CLI adapters and app preferences. The client never starts runs — these only tell it how to read and which CLIs exist.</p>` +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:44px;margin-top:24px;">` +
    `<div><div class="section-label" style="margin:0 0 6px;">Adapters</div>${adapterRows}</div>` +
    `<div>` +
    `<div class="section-label" style="margin:0 0 6px;">Reading</div>` +
    setRow("Run directory", "~/.odw/runs · reveal in Finder", "") +
    setRow("Workflow directories", "~/.odw/workflows · .odw/workflows", "") +
    `<div class="section-label" style="margin:22px 0 6px;">App</div>` +
    setRow("Launch at login", "keep watching runs in the background", toggle(true)) +
    setRow("Dock badge — active run count", "", toggle(true)) +
    setRow("Native notification on run finish / fail", "", toggle(true)) +
    setRow("Notify only on failure", "", toggle(false)) +
    `</div>` +
    `</div>` +
    `<div class="note-banner"><span style="font-family:var(--mono);color:var(--green-deep);">ⓘ</span> This build is read-only. To start a run, your agent uses <code>odw run &lt;name&gt;</code> — there is no run button by design.</div>` +
    `</div>`
  );
}
