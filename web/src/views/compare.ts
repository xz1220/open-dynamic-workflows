/**
 * Compare — what changed between two of ODW's runs (B against A), from
 * `GET /api/compare`: the figures with their deltas, what the runs ran with
 * that differs, and a row per agent with its outcome, its time as a bar that
 * leans left when B got faster and right when it got slower, and — opened —
 * how its reply changed.
 */
import { glyph, pill } from "../components/glyph";
import { reasonLabel } from "../dag";
import { icons } from "../icons";
import { t, tn } from "../i18n";
import { store } from "../store";
import type { AgentComparison, CompareAgentFacts, CompareMetric, RunComparison, RunSummary } from "../types";
import { esc, fmtClock, fmtDurMs, fmtTokens, fmtUsd } from "../util";
import { emptyArt } from "./activity";

/** Changes within this share of A's figure are noise, not better or worse. */
const SAME = 0.05;

/** The run of the same workflow that came just before `run`, to compare it with. */
export function previousRun(run: Pick<RunSummary, "runId" | "name" | "provider" | "createdAt">): RunSummary | null {
  if (run.provider !== "odw") return null;
  let best: RunSummary | null = null;
  for (const r of store.runs) {
    if (r.provider !== "odw" || r.runId === run.runId || r.name !== run.name) continue;
    if (run.createdAt != null && (r.createdAt == null || r.createdAt >= run.createdAt)) continue;
    if (!best || (r.createdAt ?? 0) > (best.createdAt ?? 0)) best = r;
  }
  return best;
}

export const compareHash = (a: string, b: string): string => `#/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}`;

/** Better, worse or the same, for a figure where `lower` is better (time, tokens, cost, failures) or not. */
export function verdict(m: CompareMetric, lower = true): "better" | "worse" | "same" | "unknown" {
  if (m.delta == null || m.a == null) return "unknown";
  if (m.delta === 0) return "same";
  if (m.a !== 0 && Math.abs(m.delta / m.a) < SAME) return "same";
  return (m.delta < 0) === lower ? "better" : "worse";
}

function deltaText(m: CompareMetric, fmt: (n: number) => string): string {
  if (m.delta == null) return "";
  if (m.delta === 0) return "±0";
  const sign = m.delta > 0 ? "+" : "−";
  if (m.a) return `${sign}${Math.round(Math.abs(m.delta / m.a) * 100)}%`;
  return `${sign}${fmt(Math.abs(m.delta))}`;
}

function figure(key: string, label: string, m: CompareMetric, fmt: (n: number) => string, lower = true, est = false): string {
  const v = verdict(m, lower);
  return (
    `<div class="cmp-fig" data-key="cf-${key}">` +
    `<span class="k">${esc(label)}</span>` +
    `<span class="v num">${m.b != null ? fmt(m.b) : "—"}${est ? "~" : ""}</span>` +
    `<span class="was">${t("was {v}", { v: m.a != null ? fmt(m.a) : "—" })}</span>` +
    (m.delta != null ? `<span class="dlt ${v}">${esc(deltaText(m, fmt))}</span>` : "") +
    `</div>`
  );
}

const fmtCount = (n: number): string => String(Math.round(n));
const fmtDur = (ms: number): string => fmtDurMs(ms);

/** A setup field in words: `cliVersion.claude` → "claude version". */
function fieldLabel(field: string): string {
  const [head, rest] = [field.split(".")[0]!, field.split(".").slice(1).join(".")];
  switch (head) {
    case "source":
      return t("workflow source");
    case "script":
      return t("script");
    case "args":
      return t("args");
    case "odwVersion":
      return t("odw version");
    case "cliVersion":
      return t("{cli} version", { cli: rest });
    case "settings":
      return rest;
    case "adapterDefinition":
      return t("{adapter} adapter config", { adapter: rest });
    case "agentDefinition":
      return t("{agent} agent definition", { agent: rest });
    case "adaptersUsed":
      return t("adapters used");
    case "modelsUsed":
      return t("models used");
    case "modelsServed":
      return t("models served");
    default:
      return field;
  }
}

function value(v: unknown): string {
  if (v == null) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

function setupSection(c: RunComparison): string {
  if (!c.setup.length) {
    // A run from before odw recorded its setup has nothing to set beside the other's.
    const known = c.a.sourceHash != null && c.b.sourceHash != null;
    return `<p class="cmp-same">${known ? t("Both ran with the same workflow, settings and CLIs.") : t("One of the runs recorded no setup, so there is nothing to set side by side.")}</p>`;
  }
  return (
    `<div class="cmp-setup">` +
    c.setup
      .map(
        (s, i) =>
          `<div class="set-row" data-key="cs-${i}" style="--i:${i}"><span class="k">${esc(fieldLabel(s.field))}</span>` +
          `<span class="a mono" title="${esc(value(s.a))}">${esc(value(s.a))}</span><span class="arr">→</span>` +
          `<span class="b mono" title="${esc(value(s.b))}">${esc(value(s.b))}</span></div>`,
      )
      .join("") +
    `</div>`
  );
}

function side(f: CompareAgentFacts | null, which: "a" | "b"): string {
  if (!f) return `<span class="cmp-side ${which} none">${t("not in this run")}</span>`;
  const what = [f.adapter, f.model].filter(Boolean).join(" · ");
  // Served by another model than it asked for (ODW extension): which one, flagged.
  const swapped =
    f.substituted && f.servedModel?.length
      ? ` <span class="tag warn" title="${esc(t("its CLI said another model served it than the one it asked for"))}">${esc(t("served by {model}", { model: f.servedModel.join(", ") }))}</span>`
      : "";
  const extra = (f.replayed ? ` <span class="tag">${t("replayed")}</span>` : "") + swapped;
  return `<span class="cmp-side ${which}">${glyph(f.state)}<span class="w">${esc(what || "—")}</span>${extra}</span>`;
}

/** B's time against A's as a bar from the centre: left when faster, right when slower. */
function timeBar(row: AgentComparison, most: number): string {
  const d = row.delta.durationMs;
  if (d == null || most <= 0) return `<span class="dv none"></span>`;
  const share = Math.min(1, Math.abs(d) / most);
  const m: CompareMetric = { a: row.a?.durationMs ?? null, b: row.b?.durationMs ?? null, delta: d };
  const v = verdict(m);
  return (
    `<span class="dv ${d < 0 ? "left" : "right"} ${v}" style="--w:${(share * 50).toFixed(2)}%" title="${esc(`${fmtDur(m.a ?? 0)} → ${fmtDur(m.b ?? 0)}`)}"><i></i></span>` +
    `<span class="dvt ${v}">${d === 0 ? "±0" : `${d > 0 ? "+" : "−"}${fmtDur(Math.abs(d))}`}</span>`
  );
}

function signed(n: number | null, fmt: (n: number) => string): string {
  if (n == null) return "—";
  if (n === 0) return "±0";
  return `${n > 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
}

function replyChip(row: AgentComparison): string {
  const r = row.reply;
  if (r.status === "identical") return `<span class="rchip same">${t("same reply")}</span>`;
  if (r.status === "none") return `<span class="rchip none">—</span>`;
  const n =
    r.kind === "json"
      ? tn(r.changed ?? r.paths?.length ?? 0, "{n} path", "{n} paths")
      : `<b class="ins">+${r.added ?? 0}</b><b class="del">−${r.removed ?? 0}</b>`;
  return `<span class="rchip differs">${t("differs")} ${n}</span>`;
}

function replyBody(c: RunComparison, row: AgentComparison): string {
  const r = row.reply;
  const failed = [row.a, row.b]
    .map((f, i) =>
      f?.state === "failed"
        ? `<div class="cmp-err"><span class="tag-ab">${i ? "B" : "A"}</span>${f.failureReason ? `<span class="tag warn">${esc(reasonLabel(f.failureReason))}</span>` : ""}${esc(f.error ?? "")}</div>`
        : "",
    )
    .join("");
  let diff = "";
  if (r.status === "identical") diff = `<p class="dim">${t("Both runs saved the same reply.")}</p>`;
  else if (r.status === "none") diff = `<p class="dim">${t("One of the runs saved no reply for it.")}</p>`;
  else if (r.kind === "json") {
    diff =
      `<div class="cmp-paths">` +
      (r.paths ?? [])
        .map(
          (p) =>
            `<div class="cp-row ${p.op}"><span class="p mono">${esc(p.path)}</span>` +
            `<span class="a mono">${p.a != null ? esc(p.a) : ""}</span><span class="arr">→</span><span class="b mono">${p.b != null ? esc(p.b) : ""}</span></div>`,
        )
        .join("") +
      `</div>`;
  } else {
    diff =
      `<pre class="cmp-diff">` +
      (r.diff ?? [])
        .map((l) => `<span class="${l.startsWith("@@") ? "hh" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx"}">${esc(l)}</span>`)
        .join("\n") +
      `</pre>`;
  }
  const cmd = `odw compare ${c.a.runId} ${c.b.runId} --agent ${row.label}`;
  return (
    `<div class="cmp-body">${failed}${diff}` +
    (r.truncated ? `<p class="dnote">${t("Cut short here — the whole diff:")} <code>${esc(cmd)}</code></p>` : "") +
    `<button class="btn sm ghost" data-copy="${esc(cmd)}">${icons.terminal}${t("In terminal")}</button></div>`
  );
}

const MARK: Record<AgentComparison["outcome"], string> = {
  unchanged: "",
  "newly-failed": "newly failed",
  fixed: "fixed",
  "only-a": "only in A",
  "only-b": "only in B",
};

function agentRows(c: RunComparison): string {
  const most = Math.max(0, ...c.agents.map((r) => Math.abs(r.delta.durationMs ?? 0)));
  return c.agents
    .map((row, i) => {
      const mark = MARK[row.outcome];
      return (
        `<details class="cmp-row ${row.outcome}" data-key="cr-${i}-${esc(row.label)}" data-preserve="open" style="--i:${Math.min(i, 24)}">` +
        `<summary>` +
        `<span class="mk" aria-hidden="true"></span>` +
        `<span class="lbl"><span class="t">${esc(row.label)}</span>${mark ? `<span class="tag ${row.outcome}">${esc(t(mark))}</span>` : ""}${row.phase ? `<span class="ph">${esc(row.phase)}</span>` : ""}</span>` +
        side(row.a, "a") +
        side(row.b, "b") +
        `<span class="tm">${timeBar(row, most)}</span>` +
        `<span class="nn num">${signed(
          row.delta.inputTokens != null || row.delta.outputTokens != null ? (row.delta.inputTokens ?? 0) + (row.delta.outputTokens ?? 0) : null,
          fmtTokens,
        )}</span>` +
        `<span class="nn num">${signed(row.delta.costUsd, fmtUsd)}</span>` +
        replyChip(row) +
        `</summary>` +
        replyBody(c, row) +
        `</details>`
      );
    })
    .join("");
}

function runChip(which: "a" | "b", r: RunComparison["a"]): string {
  return (
    `<a class="cmp-run ${which}" href="#/job/${encodeURIComponent(r.runId)}" data-key="crun-${which}">` +
    `<span class="tag-ab">${which.toUpperCase()}</span><span class="mono">${esc(r.runId)}</span>${pill(r.state)}` +
    (r.createdAt != null ? `<span class="dim">${fmtClock(r.createdAt)}</span>` : "") +
    `</a>`
  );
}

/** Other runs of the workflow, to put in A's place. */
function picker(c: RunComparison): string {
  const runs = store.runs
    .filter((r) => r.provider === "odw" && r.name === c.b.name && r.runId !== c.b.runId)
    .sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))
    .slice(0, 40);
  if (runs.length < 2) return "";
  return (
    `<label class="cmp-pick">${t("compare with")}<select data-cmp-pick="${esc(c.b.runId)}">` +
    runs.map((r) => `<option value="${esc(r.runId)}"${r.runId === c.a.runId ? " selected" : ""}>${esc(r.runId)} · ${esc(t(r.state))}</option>`).join("") +
    `</select></label>`
  );
}

export function renderCompare(param: string | null): string {
  const [a = "", b = ""] = (param ?? "").split("/");
  const cur = store.comparison;
  if (!a || !b) {
    return `<div class="cmp">${emptyArt(t("Pick two runs to compare"), esc(t("Open a run and use Compare, or run odw compare <runA> <runB>.")))}</div>`;
  }
  if (!cur || cur.key !== `${a}/${b}` || (!cur.value && !cur.error)) {
    return `<div class="cmp"><div class="empty"><div class="spinner"></div><p>${t("Comparing…")}</p></div></div>`;
  }
  if (!cur.value) {
    return `<div class="cmp">${emptyArt(t("These runs can't be compared"), esc(cur.error ?? ""))}</div>`;
  }
  const c = cur.value;
  const T = c.totals;
  const counts = (o: AgentComparison["outcome"]) => c.agents.filter((r) => r.outcome === o).length;
  const chips = (["newly-failed", "fixed", "only-a", "only-b"] as const)
    .map((o) => (counts(o) ? `<span class="tag ${o}">${esc(t(MARK[o]))} · ${counts(o)}</span>` : ""))
    .join("");
  const tokens = (m: "a" | "b") => (T.inputTokens[m] != null || T.outputTokens[m] != null ? (T.inputTokens[m] ?? 0) + (T.outputTokens[m] ?? 0) : null);
  const tok: CompareMetric = { a: tokens("a"), b: tokens("b"), delta: tokens("a") != null && tokens("b") != null ? tokens("b")! - tokens("a")! : null };
  return (
    `<div class="cmp" data-key="cmp-${esc(a)}-${esc(b)}">` +
    `<header class="cmp-head">` +
    `<div class="eyebrow"><span>${t("Compare")}</span><span class="mono" style="text-transform:none;letter-spacing:0">${esc(c.b.workflowName ?? c.b.name)}</span></div>` +
    `<h1 class="display">${t("What changed in <em>{name}</em>", { name: esc(c.b.name) })}</h1>` +
    `<div class="cmp-runs">${runChip("a", c.a)}<span class="cmp-arrow" aria-hidden="true"></span>${runChip("b", c.b)}</div>` +
    `<div class="cmp-tools">${picker(c)}` +
    `<a class="btn sm ghost" href="${compareHash(c.b.runId, c.a.runId)}">⇄ ${t("Swap")}</a>` +
    `<button class="btn sm ghost" data-copy="odw compare ${esc(c.a.runId)} ${esc(c.b.runId)}">${icons.terminal}${t("In terminal")}</button></div>` +
    (c.notes.length ? `<div class="cmp-notes">${c.notes.map((n) => `<p>${esc(n)}</p>`).join("")}</div>` : "") +
    `</header>` +
    `<section class="cmp-figs">` +
    figure("wall", t("wall time"), T.wallMs, fmtDur) +
    figure("tok", t("tokens"), tok, fmtTokens, true, T.estimated.b) +
    (T.costUsd.a != null || T.costUsd.b != null ? figure("usd", t("cost"), T.costUsd, fmtUsd) : "") +
    figure("done", t("done"), T.done, fmtCount, false) +
    figure("failed", t("failed"), T.failed, fmtCount) +
    `</section>` +
    `<section class="cmp-sec"><h3 class="cmp-h">${t("What it ran with")}</h3>${setupSection(c)}</section>` +
    `<section class="cmp-sec"><h3 class="cmp-h">${t("Agents")}<span class="cmp-chips">${chips}</span></h3>` +
    `<div class="cmp-cols"><span></span><span>${t("agent")}</span><span>A</span><span>B</span><span>${t("time")}</span><span>${t("tokens")}</span><span>${t("cost")}</span><span>${t("reply")}</span></div>` +
    `<div class="cmp-rows">${agentRows(c) || `<p class="dim">${t("Neither run called an agent.")}</p>`}</div></section>` +
    `</div>`
  );
}
