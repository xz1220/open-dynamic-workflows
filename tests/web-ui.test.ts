/**
 * Pure rendering helpers of the web client — layout, charts, outline, matching.
 * They are string-in / string-out, so they run under node:test without a DOM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderJson } from "../web/src/components/json.ts";
import { renderPulse } from "../web/src/components/pulse.ts";
import { highlightSource, outlineSource } from "../web/src/components/source.ts";
import { renderTimeline } from "../web/src/components/timeline.ts";
import { renderDag } from "../web/src/dag.ts";
import type { ActivityEvent, AgentView, RunDetail, RunSummary } from "../web/src/types.ts";
import { esc, fmtDurSec, fuzzy, markHits } from "../web/src/util.ts";

const NOW = 1_800_000_000;

function agent(label: string, phase: string, state: AgentView["state"], extra: Partial<AgentView> = {}): AgentView {
  return {
    label,
    phase,
    state,
    adapter: "codex",
    attempts: state === "done" ? 1 : null,
    error: state === "failed" ? "exit 1" : null,
    startedAt: NOW - 100,
    finishedAt: state === "running" ? null : NOW - 40,
    durationMs: state === "running" ? null : 60_000,
    ...extra,
  };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "20260101-000000-aaaaaa",
    provider: "odw",
    state: "running",
    rawState: "running",
    stale: false,
    name: "demo",
    description: null,
    phases: [{ title: "Plan" }, { title: "Search" }, { title: "Report" }],
    source: null,
    pid: 1,
    createdAt: NOW - 120,
    updatedAt: NOW - 1,
    counts: { agents: 0, running: 0, done: 0, failed: 0, stale: 0 },
    progress: 0.5,
    lastActivityTs: NOW - 1,
    ...over,
  };
}

function detail(agents: AgentView[], over: Partial<RunDetail> = {}): RunDetail {
  return {
    ...summary(),
    script: null,
    args: null,
    agents,
    phaseOrder: ["Plan", "Search", "Report"],
    hasResult: false,
    error: null,
    origin: null,
    adapter: null,
    workflowName: "demo",
    ...over,
  };
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

test("fuzzy: ordered subsequence with contiguous and word-start bonuses", () => {
  assert.equal(fuzzy("xyz", "deep-research"), null);
  const hit = fuzzy("dr", "deep-research")!;
  assert.deepEqual(hit.hits, [0, 5]);
  // Contiguous runs outscore scattered hits.
  assert.ok(fuzzy("dee", "deep-research")!.score > fuzzy("dpe", "deep-research")!.score);
  assert.deepEqual(fuzzy("", "anything"), { score: 0, hits: [] });
});

test("markHits escapes text and wraps only the matched characters", () => {
  assert.equal(markHits("<a>", [1]), "&lt;<mark>a</mark>&gt;");
  assert.equal(markHits("x&y", []), esc("x&y"));
});

test("fmtDurSec spans milliseconds to hours", () => {
  assert.equal(fmtDurSec(0.25), "250ms");
  assert.equal(fmtDurSec(75), "1m15s");
  assert.equal(fmtDurSec(3_900), "1h05m");
  assert.equal(fmtDurSec(null), "—");
});

test("renderDag fans one→many, rails equal lanes, funnels many→one", () => {
  const run = detail([
    agent("plan", "Plan", "done"),
    ...[1, 2, 3].map((i) => agent(`search:${i}`, "Search", "running")),
    agent("report", "Report", "running"),
  ]);
  const { html } = renderDag(run, null, { nowSec: NOW, zoom: 1, motion: true, currentPhase: "Search" });
  assert.equal(count(html, /class="node /g), 5);
  // 1→3 fan-out plus 3→1 fan-in = 6 edges, each keyed by its endpoints.
  assert.equal(count(html, /class="edge /g), 6);
  assert.match(html, /data-key="e-0-1"/);
  assert.match(html, /data-key="e-3-4"/);
  // Running downstream agents carry a marching flow and a spark when motion is on.
  assert.equal(count(html, /class="flow"/g), 6);
  assert.equal(count(html, /class="spark"/g), 6);
  const still = renderDag(run, null, { nowSec: NOW, zoom: 1, motion: false, currentPhase: null }).html;
  assert.equal(count(still, /class="spark"/g), 0);
});

test("renderDag maps unequal lanes proportionally and caps tall lanes", () => {
  const many = Array.from({ length: 14 }, (_, i) => agent(`draft:${i}`, "Plan", "done"));
  const run = detail([...many, agent("a", "Search", "done"), agent("b", "Search", "done")]);
  const { html } = renderDag(run, 3, { nowSec: NOW, zoom: 0.5, motion: true, currentPhase: null });
  // Twelve shown + an overflow card for the remaining two.
  assert.equal(count(html, /data-key="n-/g), 14);
  assert.match(html, /\+2<\/b>/);
  // Every shown upstream node keeps an outgoing edge.
  for (let i = 0; i < 12; i++) assert.match(html, new RegExp(`data-key="e-${i}-1[45]"`));
  assert.match(html, /transform:scale\(0\.5\)/);
  assert.match(html, /node done selected/);
});

test("renderPulse frames live runs and keeps at most nine traces", () => {
  const runs = Array.from({ length: 12 }, (_, i) =>
    summary({ runId: `r${i}`, name: `wf-${i}`, state: i < 2 ? "running" : "done", createdAt: NOW - 90 - i, lastActivityTs: NOW - i }),
  );
  const events: ActivityEvent[] = Array.from({ length: 30 }, (_, i) => ({
    ts: NOW - (i % 60),
    type: "agent_started",
    runId: i % 2 ? "r0" : "r1",
    run: "wf",
    adapter: "codex",
  }));
  const p = renderPulse(runs, events, NOW);
  assert.equal(p.rows, 9);
  assert.equal(p.span, "2m");
  assert.match(p.svg, /class="ridge running"/);
  assert.match(p.svg, /data-run="r0"/);
  assert.equal(renderPulse([], [], NOW).rows, 0);
});

test("renderTimeline draws one bar per started agent and a now marker while live", () => {
  const run = detail([
    agent("plan", "Plan", "done"),
    agent("s1", "Search", "running", { startedAt: NOW - 30 }),
    agent("queued", "Search", "running", { startedAt: null }),
  ]);
  const html = renderTimeline(run, null, NOW);
  assert.equal(count(html, /class="tl-bar /g), 2);
  assert.match(html, /class="tl-now"/);
  assert.match(renderTimeline(detail([]), null, NOW), /class="empty"/);
});

test("outlineSource splits by phase() and counts primitives outside comments", () => {
  const src = [
    "export const meta = { name: 'x', phases: [{ title: 'Plan' }, { title: 'Act' }, { title: 'Ship' }] }",
    "phase('Plan')",
    "const plan = await agent('plan it') // agent( in a comment does not count",
    "phase(\"Act\")",
    "const out = await parallel(items.map((i) => () => agent(i)))",
    "/* pipeline( */",
  ].join("\n");
  const outline = outlineSource(src, ["Plan", "Act", "Ship"]);
  assert.deepEqual(
    outline.map((p) => [p.title, p.ops.map((o) => `${o.kind}×${o.n}`).join(",")]),
    [
      ["Plan", "agent×1"],
      ["Act", "parallel×1,agent×1"],
      ["Ship", ""],
    ],
  );
});

test("highlightSource keeps one line per source line and escapes markup", () => {
  const html = highlightSource("const a = '<b>'\n// note\nawait agent(a)");
  assert.equal(count(html, /class="ln"/g), 3);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /class="tk-f">agent/);
  assert.match(html, /class="tk-c">\/\/ note/);
});

test("renderJson builds a collapsible, escaped tree and reads strings as prose", () => {
  const html = renderJson({ a: [1, "<x>"], b: { c: null } });
  assert.match(html, /<details data-key="j\$"/);
  assert.match(html, /data-preserve="open"/);
  assert.match(html, /&lt;x&gt;/);
  assert.match(renderJson("plain text"), /class="prose"/);
});
