/**
 * Evals — the kept `odw eval` reports. The list is a card per eval: its
 * latest pass rate as a dial, and the reports before it as a row of ticks
 * whose height is their pass rate. A report is a matrix — a tile per case ×
 * adapter, tinted from alarm to signal by its pass rate, holding a square
 * per run that opens it — then what failed, and how it stood against its
 * baseline.
 */
import { glyph } from "../components/glyph";
import { icons } from "../icons";
import { t, tn } from "../i18n";
import { store } from "../store";
import type { EvalBaseline, EvalCell, EvalReport, EvalReportSummary } from "../types";
import { esc, fmtDurMs, fmtTokens, fmtUsd } from "../util";
import { emptyArt } from "./activity";
import { compareHash } from "./compare";

const pct = (r: number): string => `${Math.round(r * 100)}%`;

/** A pass rate's tint: alarm at 0, amber half way, signal at 1. */
export function rateColor(rate: number): string {
  const r = Math.max(0, Math.min(1, rate));
  return r >= 0.5
    ? `color-mix(in oklab, var(--sig) ${Math.round((r - 0.5) * 200)}%, var(--amber))`
    : `color-mix(in oklab, var(--amber) ${Math.round(r * 200)}%, var(--alarm))`;
}

/** The latest pass rate as a ring that draws to its share. */
function dial(rate: number): string {
  const c = 2 * Math.PI * 26;
  return (
    `<svg class="ev-dial" viewBox="0 0 64 64" aria-hidden="true" style="--c:${rateColor(rate)}">` +
    `<circle class="bg" cx="32" cy="32" r="26"/>` +
    `<circle class="fg" cx="32" cy="32" r="26" stroke-dasharray="${c.toFixed(2)}" style="--off:${(c * (1 - rate)).toFixed(2)};--full:${c.toFixed(2)}"/>` +
    `</svg><span class="ev-pct num">${pct(rate)}</span>`
  );
}

export function renderEvals(param: string | null): string {
  if (param) return renderReport(param);
  const all = store.evals;
  if (!all) return `<div class="evals"><div class="empty"><div class="spinner"></div><p>${t("Loading evals…")}</p></div></div>`;
  const head =
    `<header class="page-head"><div><div class="eyebrow">${t("Evals")}</div>` +
    `<h1 class="display">${t("Does it still <em>work</em>?")}</h1>` +
    `<p class="lede">${t("Each eval runs a workflow over its cases, on each adapter, a few times — pass rate, cost and time, kept to compare.")}</p></div></header>`;
  if (!all.length) {
    return (
      `<div class="evals">${head}` +
      emptyArt(t("No eval reports yet"), esc(t("Write .odw/evals/<name>.json, then run odw eval <name>.")), `<code class="ev-cmd">odw eval routing</code>`) +
      `</div>`
    );
  }
  const byName = new Map<string, EvalReportSummary[]>();
  for (const r of all) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  const cards = [...byName.entries()]
    .map(([name, reports], i) => {
      const latest = reports[0]!;
      const trend = reports
        .slice(0, 24)
        .reverse()
        .map(
          (r) =>
            `<a class="tick${r === latest ? " on" : ""}" href="#/evals/${encodeURIComponent(name)}/${encodeURIComponent(r.id)}" style="--h:${Math.max(0.06, r.totals.passRate)};--c:${rateColor(r.totals.passRate)}" title="${esc(`${r.id} · ${pct(r.totals.passRate)}`)}"></a>`,
        )
        .join("");
      const regressed = latest.regressed ? `<span class="tag newly-failed">${tn(latest.regressed, "{n} regressed", "{n} regressed")}</span>` : "";
      return (
        // A card, not a link: its ticks are links of their own; the title's link stretches over the rest.
        `<div class="card ev-card" data-key="evc-${esc(name)}" style="--i:${i}">` +
        `<div class="ev-top"><div class="ev-meter">${dial(latest.totals.passRate)}</div>` +
        `<div class="ev-id"><h3><a class="ev-open" href="#/evals/${encodeURIComponent(name)}/${encodeURIComponent(latest.id)}">${esc(name)}</a></h3><span class="dim mono">${esc(latest.workflow)}</span>${latest.description ? `<p>${esc(latest.description)}</p>` : ""}</div></div>` +
        `<div class="ev-trend" aria-label="${esc(t("pass rate of the last reports"))}">${trend}</div>` +
        `<div class="ev-foot"><span>${tn(latest.cases, "{n} case", "{n} cases")} × ${esc(latest.adapters.join(", ") || "—")}</span>` +
        `<span>${latest.totals.passed}/${latest.totals.runs} ${t("passed")}</span>` +
        (latest.totals.costUsd != null ? `<span>${fmtUsd(latest.totals.costUsd)}</span>` : "") +
        `<span class="dim">${esc(latest.startedAt.slice(0, 16).replace("T", " "))}</span>${regressed}</div>` +
        `</div>`
      );
    })
    .join("");
  return `<div class="evals">${head}<div class="ev-grid">${cards}</div></div>`;
}

function tile(c: EvalCell, report: EvalReport, base: EvalBaseline["cells"][number] | undefined, i: number): string {
  const runs = report.runs.filter((r) => r.case === c.case && r.adapter === c.adapter);
  const squares = runs
    .map(
      (r) =>
        `<a class="sq ${r.passed ? "ok" : "bad"}" href="#/job/${encodeURIComponent(r.runId)}" title="${esc(`#${r.repeat} · ${r.runId}${r.failures[0] ? ` · ${r.failures[0].check}: ${r.failures[0].message}` : ""}`)}"></a>`,
    )
    .join("");
  const pair = c.runIds.length >= 2 ? `<a class="ev-pair" href="${compareHash(c.runIds[0]!, c.runIds[c.runIds.length - 1]!)}" title="${esc(t("compare its first and last run"))}">${icons.compare}</a>` : "";
  const delta =
    base && base.status !== "unchanged" && base.status !== "missing"
      ? `<span class="ev-base ${base.status}">${base.status === "new" ? t("new") : base.passRate.delta != null ? `${base.passRate.delta > 0 ? "▲" : "▼"} ${pct(Math.abs(base.passRate.delta))}` : esc(t(base.status))}</span>`
      : "";
  return (
    `<div class="ev-tile${base?.status === "regressed" ? " regressed" : ""}" style="--c:${rateColor(c.passRate)};--i:${i}" data-key="evt-${esc(c.case)}-${esc(c.adapter)}">` +
    `<div class="ev-tile-top"><span class="ev-rate num">${pct(c.passRate)}</span>${delta}${pair}</div>` +
    `<div class="ev-squares">${squares}</div>` +
    `<div class="ev-tile-foot"><span>${c.passed}/${c.runs}</span><span>${c.medianMs != null ? fmtDurMs(c.medianMs) : "—"}</span>` +
    `<span>${c.meanCostUsd != null ? fmtUsd(c.meanCostUsd) : c.meanTokens != null ? `${fmtTokens(c.meanTokens)} tok` : "—"}</span></div>` +
    `</div>`
  );
}

function renderReport(param: string): string {
  const [name = "", id = ""] = param.split("/");
  const cur = store.evalReport;
  if (!cur || cur.key !== `${name}/${id}` || (!cur.value && !cur.error)) {
    return `<div class="evals"><div class="empty"><div class="spinner"></div><p>${t("Loading the report…")}</p></div></div>`;
  }
  if (!cur.value) return `<div class="evals">${emptyArt(t("This report can't be shown"), esc(cur.error ?? ""))}</div>`;
  const r = cur.value;
  const adapters = [...new Set(r.cells.map((c) => c.adapter))];
  const cases = [...new Set(r.cells.map((c) => c.case))];
  const cell = (cs: string, ad: string) => r.cells.find((c) => c.case === cs && c.adapter === ad);
  const base = (cs: string, ad: string) => r.baseline?.cells.find((c) => c.case === cs && c.adapter === ad);
  let n = 0;
  const matrix =
    `<div class="ev-matrix" style="--cols:${adapters.length}">` +
    `<span></span>${adapters.map((a) => `<span class="ev-col mono">${esc(a)}</span>`).join("")}` +
    cases
      .map(
        (cs) =>
          `<span class="ev-row">${esc(cs)}</span>` +
          adapters
            .map((ad) => {
              const c = cell(cs, ad);
              return c ? tile(c, r, base(cs, ad), n++) : `<span class="ev-tile none"></span>`;
            })
            .join(""),
      )
      .join("") +
    `</div>`;
  const failures = r.runs.filter((x) => !x.passed);
  const failList = failures.length
    ? `<section class="cmp-sec"><h3 class="cmp-h">${t("What failed")}<span class="tag newly-failed">${failures.length}</span></h3><div class="ev-fails">` +
      failures
        .map(
          (f) =>
            `<a class="ev-fail" href="#/job/${encodeURIComponent(f.runId)}">${glyph("failed")}<span class="who">${esc(f.case)} · ${esc(f.adapter)} · #${f.repeat}</span>` +
            `<span class="why">${esc(f.failures.map((x) => `${x.check}: ${x.message}`).join(" — ") || f.error || t(f.state))}</span><span class="mono dim">${esc(f.runId)}</span></a>`,
        )
        .join("") +
      `</div></section>`
    : "";
  const versions = Object.entries(r.cliVersions)
    .map(([ad, vs]) => `<span class="tag">${esc(ad)} ${esc(vs.join(", "))}</span>`)
    .join("");
  const T = r.totals;
  const fig = (k: string, v: string, sub = "") => `<div class="cmp-fig"><span class="k">${esc(k)}</span><span class="v num">${v}</span>${sub ? `<span class="was" style="text-decoration:none">${sub}</span>` : ""}</div>`;
  return (
    `<div class="evals" data-key="evr-${esc(r.name)}-${esc(r.id)}">` +
    `<header class="cmp-head"><div class="eyebrow"><span>${t("Eval")}</span><span class="mono" style="text-transform:none;letter-spacing:0">${esc(r.workflow.ref)}</span></div>` +
    `<h1 class="display">${esc(r.name)}</h1>${r.description ? `<p class="lede">${esc(r.description)}</p>` : ""}` +
    `<div class="cmp-tools"><span class="tag">${esc(r.id)}</span><span class="tag">odw ${esc(r.odwVersion)}</span>${versions}` +
    `<button class="btn sm ghost" data-copy="odw eval ${esc(r.name)}">${icons.terminal}${t("Run it again")}</button></div>` +
    (r.baseline && !r.baseline.sameDefinition ? `<div class="cmp-notes"><p>${t("Its baseline ran a different definition.")}</p></div>` : "") +
    `</header>` +
    `<section class="cmp-figs">` +
    fig(t("pass rate"), pct(T.passRate), `${T.passed}/${T.runs}`) +
    fig(t("wall time"), fmtDurMs(r.wallMs)) +
    (T.costUsd != null ? fig(t("cost"), fmtUsd(T.costUsd)) : "") +
    (T.inputTokens != null || T.outputTokens != null ? fig(t("tokens"), fmtTokens((T.inputTokens ?? 0) + (T.outputTokens ?? 0))) : "") +
    (r.baseline ? fig(t("regressed"), String(r.baseline.regressed.length), esc(t("against {id}", { id: r.baseline.id }))) : "") +
    `</section>` +
    `<section class="cmp-sec"><h3 class="cmp-h">${t("Cases × adapters")}</h3>${matrix}</section>` +
    failList +
    `</div>`
  );
}
