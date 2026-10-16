/** Workspace — the managed workflows: a searchable list, and per workflow its outline, source and runs. */
import { glyph } from "../components/glyph";
import { highlightSource, outlineSource } from "../components/source";
import { icons } from "../icons";
import { t, tn } from "../i18n";
import { store } from "../store";
import type { WorkflowDetail, WorkflowSummary } from "../types";
import { esc, fmtAgo } from "../util";
import { emptyArt } from "./activity";

/**
 * A workflow's stable identity for selection + detail routing. Two providers can
 * own the same name (e.g. an ODW and a Claude `deep-research`), so name alone is
 * ambiguous; `provider:name` is unique (name excludes `:`).
 */
export function wfKey(w: { provider: string; name: string }): string {
  return `${w.provider}:${w.name}`;
}

/** Provider sections, in display order. A provider with no workflows is dropped. */
const PROVIDER_GROUPS: Array<{ provider: WorkflowSummary["provider"]; title: string }> = [
  { provider: "odw", title: "ODW" },
  { provider: "claude", title: "Claude Code" },
];

/**
 * Workflows in the exact order the Workspace paints them (provider groups, in
 * order). The single source of truth for "first visible row", so default
 * selection in main.ts can't disagree with what the user sees.
 */
export function orderedWorkflows(list: WorkflowSummary[]): WorkflowSummary[] {
  return PROVIDER_GROUPS.flatMap((g) => list.filter((w) => w.provider === g.provider));
}

function listItem(w: WorkflowSummary, activeKey: string | null): string {
  const key = wfKey(w);
  const shadow = w.shadowed
    ? `<span class="tag warn" title="${esc(t("name shadowed — odw run {name} runs a higher-precedence workflow", { name: w.name }))}">${t("shadowed")}</span>`
    : "";
  return (
    `<a class="wf-item${key === activeKey ? " on" : ""}" data-wf="${esc(key)}" data-key="wf-${esc(key)}">` +
    `<h4>${esc(w.name)}</h4>` +
    (w.description ? `<div class="ds">${esc(w.description)}</div>` : "") +
    `<div class="mini"><span class="tag${w.provider === "claude" ? " cc" : ""}">${esc(w.rootLabel)}</span>` +
    `<span class="tag">${tn(w.phases.length, "{n} phase", "{n} phases")}</span>` +
    (w.runCount ? `<span class="tag sig">${tn(w.runCount, "{n} run", "{n} runs")}</span>` : "") +
    shadow +
    `</div></a>`
  );
}

const OP_LABEL: Record<string, string> = {
  agent: "agent",
  parallel: "parallel",
  pipeline: "pipeline",
  workflow: "workflow",
  log: "log",
};
const OP_CLASS: Record<string, string> = { parallel: "par", pipeline: "pipe", workflow: "wf", log: "cmd", agent: "" };

function outline(d: WorkflowDetail): string {
  const phases = outlineSource(d.source, d.phases.map((p) => p.title));
  if (!phases.length) return `<p class="dim">${t("no declared phases")}</p>`;
  return (
    `<div class="outline">` +
    phases
      .map(
        (p, i) =>
          `<div class="ol-phase" data-key="ol-${i}" style="animation-delay:${i * 45}ms"><span class="ix">${String(i + 1).padStart(2, "0")}</span><div>` +
          `<h4>${esc(p.title)}</h4><div class="ol-ops">` +
          (p.ops.length
            ? p.ops
                .map((o) => `<span class="op ${OP_CLASS[o.kind] ?? ""}"><i></i>${OP_LABEL[o.kind]}()${o.n > 1 ? ` ×${o.n}` : ""}</span>`)
                .join("")
            : `<span class="dim" style="font-size:12px">${t("declared — no calls found in this phase")}</span>`) +
          `</div></div></div>`,
      )
      .join("") +
    `</div>`
  );
}

function detailPane(d: WorkflowDetail): string {
  const runs = d.runs.slice(0, 12).map((r) => {
    const summary = store.runs.find((x) => x.runId === r.runId);
    const state = summary?.state ?? "done";
    return (
      `<a class="wf-run" data-run="${esc(r.runId)}" data-key="wr-${esc(r.runId)}">${glyph(state)}<span>${esc(r.runId)}</span>` +
      `<span class="faint">${summary ? fmtAgo(summary.createdAt) : ""}</span>${icons.arrow}</a>`
    );
  });
  const runNote = d.shadowed
    ? t("Shadowed: odw run {name} runs a higher-precedence workflow.", { name: d.name })
    : t("Runs start from your agent or terminal — not from here.");
  return (
    `<div class="page" data-key="wfd-${esc(wfKey(d))}">` +
    `<div class="eyebrow"><span class="tag${d.provider === "claude" ? " cc" : ""}">${esc(d.rootLabel)}</span><span class="mono" style="text-transform:none;letter-spacing:0">${esc(d.path)}</span></div>` +
    `<h1 class="display">${esc(d.name)}</h1>` +
    (d.description ? `<p class="lede">${esc(d.description)}</p>` : "") +
    `<div style="display:flex;align-items:center;gap:14px;margin-top:20px;flex-wrap:wrap">` +
    `<span class="cmd"><span class="p">$</span>odw run ${esc(d.name)}<button class="iconbtn" data-copy="odw run ${esc(d.name)}" aria-label="${esc(t("Copy"))}">${icons.copy}</button></span>` +
    `<span class="dim" style="font-size:12.5px">${esc(runNote)}</span></div>` +
    `<div class="section-title"><h2>${t("Outline")}</h2><span class="eyebrow">${t("read statically from the source")}</span></div>` +
    outline(d) +
    (runs.length
      ? `<div class="section-title"><h2>${t("Recent runs")}</h2><span class="eyebrow">${tn(d.runs.length, "{n} run", "{n} runs")}</span></div><div class="wf-runs">${runs.join("")}</div>`
      : "") +
    `<div class="section-title"><h2>${t("Source")}</h2><span class="eyebrow">${esc(d.name)}.js</span></div>` +
    `<pre class="code">${highlightSource(d.source)}</pre>` +
    `</div>`
  );
}

export function renderWorkspace(activeKey: string | null, detail: WorkflowDetail | null, query: string): string {
  const list = store.workflows;
  if (list === null) {
    return `<div class="empty" style="height:100%"><div class="spinner"></div><p>${t("Loading workflows…")}</p></div>`;
  }
  if (list.length === 0) {
    return (
      `<div class="page">` +
      emptyArt(
        t("No workflows yet"),
        t("Have your agent write one into the managed directories."),
        `<div class="cmd">.odw/workflows · .claude/workflows · ~/.odw/workflows</div>`,
      ) +
      `</div>`
    );
  }
  const q = query.trim().toLowerCase();
  const filtered = q
    ? list.filter((w) => w.name.toLowerCase().includes(q) || (w.description ?? "").toLowerCase().includes(q))
    : list;
  const sections = PROVIDER_GROUPS.map((g) => ({ ...g, items: filtered.filter((w) => w.provider === g.provider) }))
    .filter((g) => g.items.length > 0)
    .map(
      (g) =>
        `<div class="wf-group" data-key="wg-${g.provider}"><span>${esc(g.title)}</span><span>${g.items.length}</span></div>` +
        g.items.map((w) => listItem(w, activeKey)).join(""),
    )
    .join("");
  const pane = detail
    ? detailPane(detail)
    : activeKey
      ? `<div class="empty" style="height:100%"><div class="spinner"></div></div>`
      : `<div class="empty" style="height:100%"><p>${t("Select a workflow to see its structure and source.")}</p></div>`;
  return (
    `<div class="split">` +
    `<aside class="wf-list"><div class="wf-list-head"><div class="eyebrow">${t("Workspace")}</div><h2 class="display">${t("Workflows")}</h2>` +
    `<label class="field">${icons.search}<input id="wf-q" placeholder="${esc(t("Filter workflows"))}" value="${esc(query)}" autocomplete="off"/></label></div>` +
    `<div class="wf-items">${sections || `<p class="dim" style="padding:12px">${t("No workflows match.")}</p>`}</div></aside>` +
    `<section class="wf-detail">${pane}</section>` +
    `</div>`
  );
}
