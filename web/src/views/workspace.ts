/** Workspace — managed-dir workflows: list + phases + structure + source. Read-only. */
import { store } from "../store";
import type { WorkflowDetail, WorkflowSummary } from "../types";
import { esc } from "../util";

// Very light source highlighting for the dark source view (string/keyword/comment).
function highlight(src: string): string {
  const escaped = esc(src);
  return escaped
    .replace(/(\/\/[^\n]*)/g, '<span style="color:#5c6a62">$1</span>')
    .replace(/(&#39;[^&]*?&#39;|&quot;[^&]*?&quot;)/g, '<span style="color:#7ee787">$1</span>')
    .replace(
      /\b(export|const|let|await|async|return|for|of|if|else|function|new)\b/g,
      '<span style="color:#79c0ff">$1</span>',
    )
    .replace(/\b(agent|parallel|pipeline|phase|log)\b(?=\()/g, '<span style="color:#d2a8ff">$1</span>');
}

/**
 * A workflow's stable identity for selection + detail routing. Two providers can
 * own the same name (e.g. an ODW and a Claude `deep-research`), so name alone is
 * ambiguous; `provider:name` is unique (name excludes `:`).
 */
export function wfKey(w: { provider: string; name: string }): string {
  return `${w.provider}:${w.name}`;
}

function listItem(w: WorkflowSummary, activeKey: string | null): string {
  const key = wfKey(w);
  const badgeClass = w.origin === "global" ? "srcbadge global" : "srcbadge";
  const badge = `<span class="${badgeClass}">${esc(w.rootLabel)}</span>`;
  const shadow = w.shadowed
    ? `<span class="shadow" title="name shadowed — odw run ${esc(w.name)} runs a higher-precedence workflow">shadowed</span>`
    : "";
  return (
    `<div class="wfitem ${key === activeKey ? "on" : ""}" data-wf="${esc(key)}">` +
    `<h4>${esc(w.name)}</h4>` +
    (w.description ? `<div class="ds">${esc(w.description)}</div>` : "") +
    `<div class="mini">${badge}<span>${w.phases.length} phases</span>${w.runCount ? `<span>· ${w.runCount} runs</span>` : ""}${shadow}</div>` +
    `</div>`
  );
}

/** Infer a coarse structure row per phase, by name heuristic (display-only). */
function structureLane(title: string, i: number): string {
  const t = title.toLowerCase();
  const fanout = /search|extract|vote|draft|generate|compete|verify|find|discover|map/.test(t);
  const pipe = /filter|judge|grade|handle|route|synth|report|reduce|rank/.test(t);
  const kind = fanout ? "par" : pipe ? "pipe" : "";
  const kindLabel = fanout ? "parallel · fan-out" : pipe ? "pipeline" : "agent";
  const group = fanout ? `<div class="sgroup">× N</div>` : "";
  return (
    `<div class="slane"><div class="sh"><span class="ix">${i + 1}</span>${esc(title)}</div>` +
    `<div class="snode ${kind}"><span class="kd">${kindLabel}</span>${esc(title.toLowerCase())}</div>${group}</div>`
  );
}

function detailPane(d: WorkflowDetail): string {
  const phasePills = d.phases.length
    ? d.phases
        .map((p, i) => `<span class="ppill"><span class="ix">${i + 1}</span>${esc(p.title)}</span>`)
        .join(`<span class="ar"> → </span>`)
    : `<span style="color:var(--muted)">no declared phases</span>`;

  const structure = d.phases.length
    ? `<div class="rsec">Structure</div><div class="structure">${d.phases
        .map((p, i) => structureLane(p.title, i))
        .join("")}</div>`
    : "";

  const runs = d.runs.length
    ? `<div class="rsec">Recent runs</div>` +
      d.runs
        .slice(0, 6)
        .map(
          (r) =>
            `<div class="runmini" data-run="${esc(r.runId)}"><span class="rid">${esc(r.runId)}</span><span class="when">view →</span></div>`,
        )
        .join("")
    : "";

  const badgeClass = d.origin === "global" ? "srcbadge global" : "srcbadge";
  const runNote = d.shadowed
    ? `<span class="note">— shadowed; this runs a higher-precedence ${esc(d.name)}</span>`
    : `<span class="note">— started by your agent, not here</span>`;

  return (
    `<div class="wfdetail">` +
    `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;">` +
    `<div><h1 class="page-h1">${esc(d.name)}</h1>` +
    `<div class="wfmeta"><span class="${badgeClass}">${esc(d.rootLabel)}</span>${d.shadowed ? `<span class="shadow">shadowed</span>` : ""}</div>` +
    (d.description ? `<p class="page-sub" style="max-width:64ch;">${esc(d.description)}</p>` : "") +
    `</div></div>` +
    `<div style="margin-top:14px;"><span class="clihint"><span class="p">$</span> odw run ${esc(d.name)}${runNote}</span></div>` +
    `<div class="rsec">Phases</div><div class="phasepills">${phasePills}</div>` +
    structure +
    `<div class="rsec">Source — ${esc(d.name)}.js</div><div class="srcview">${highlight(d.source)}</div>` +
    runs +
    `</div>`
  );
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

export function renderWorkspace(activeKey: string | null, detail: WorkflowDetail | null): string {
  const list = store.workflows;
  if (list === null) {
    return `<div class="empty"><div class="spinner"></div><div>Loading workflows…</div></div>`;
  }
  if (list.length === 0) {
    return (
      `<div class="empty"><div class="gh">No workflows yet</div>` +
      `<div>Your agent writes workflows into the managed directories.</div>` +
      `<div class="codehint">.odw/workflows · .claude/workflows · ~/.odw/workflows · ~/.claude/workflows</div></div>`
    );
  }
  // Group by provider so Claude Code's saved workflows read as their own section,
  // visible even when a name collides with an ODW workflow.
  const sections = PROVIDER_GROUPS.map((g) => ({
    ...g,
    items: list.filter((w) => w.provider === g.provider),
  }))
    .filter((g) => g.items.length > 0)
    .map(
      (g) =>
        `<div class="wfgroup"><span class="gt">${esc(g.title)}</span><span class="gc">${g.items.length}</span></div>` +
        g.items.map((w) => listItem(w, activeKey)).join(""),
    )
    .join("");
  const pane = detail
    ? detailPane(detail)
    : `<div class="wfdetail"><div class="empty"><div>Select a workflow to see its structure and source.</div></div></div>`;
  return (
    `<div class="wsplit">` +
    `<div class="wflist"><div class="lh"><span class="t">Workflows</span><span class="c">${list.length} · managed dirs</span></div>${sections}</div>` +
    pane +
    `</div>`
  );
}
