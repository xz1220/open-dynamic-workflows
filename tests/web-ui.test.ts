/**
 * Pure rendering helpers of the web client — layout, charts, outline, matching.
 * They are string-in / string-out, so they run under node:test without a DOM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { withCheckpoints } from "../web/src/checkpoints.ts";
import { renderJson } from "../web/src/components/json.ts";
import { transcriptEntries } from "../web/src/components/transcript.ts";
import { renderPulse } from "../web/src/components/pulse.ts";
import { highlightSource, outlineSource } from "../web/src/components/source.ts";
import { renderTimeline } from "../web/src/components/timeline.ts";
import { reasonLabel, renderDag } from "../web/src/dag.ts";
import { applyRunsDelta, store } from "../web/src/store.ts";
import { renderActivity } from "../web/src/views/activity.ts";
import { renderJob, type JobViewState } from "../web/src/views/job.ts";
import { renderJobs } from "../web/src/views/jobs.ts";
import { spendOf } from "../web/src/views/spend.ts";
import { orderedWorkflows, parseWfKey, renderWorkspace, wfKey } from "../web/src/views/workspace.ts";
import type { ActivityEvent, AgentView, RunDetail, RunSummary, WorkflowSummary } from "../web/src/types.ts";
import { cronWords, esc, fmtDurSec, fmtTokens, fmtUsd, fuzzy, markHits, markRedactions } from "../web/src/util.ts";

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

test("applyRunsDelta upserts, removes and keeps newest-first order", () => {
  const a = summary({ runId: "a", createdAt: 10 });
  const b = summary({ runId: "b", createdAt: 20 });
  const c = summary({ runId: "c", createdAt: 30 });
  const next = applyRunsDelta([b, a], [c, { ...a, state: "done" }], ["b"]);
  assert.deepEqual(
    next.map((r) => [r.runId, r.state]),
    [
      ["c", "running"],
      ["a", "done"],
    ],
  );
});

test("renderDag draws exec() steps as terminal cards with their exit code", () => {
  const run = detail([
    agent("plan", "Plan", "done"),
    agent("npm test", "Search", "done", { kind: "command", exitCode: 1, adapter: null }),
  ]);
  const { html } = renderDag(run, null, { nowSec: NOW, zoom: 1, motion: false, currentPhase: null });
  assert.match(html, /class="node done cmd/);
  assert.match(html, /<span class="prompt">\$<\/span> npm test/);
  assert.match(html, /command · exit 1/);
});

test("token and dollar formatting stay compact", () => {
  assert.equal(fmtTokens(812), "812");
  assert.equal(fmtTokens(12_400), "12k");
  assert.equal(fmtTokens(3_100_000), "3.1M");
  assert.equal(fmtUsd(0.0042), "$0.0042");
  assert.equal(fmtUsd(1.23456), "$1.235");
  assert.equal(fmtTokens(undefined), "—");
});

test("a run view shows pending checkpoints, usage and failure reasons when the server reports them", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 1,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail(
    [
      agent("plan", "Plan", "done", { usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.012 } }),
      agent("search:1", "Search", "failed", { failureReason: "rate_limit", error: "429 too many requests" }),
    ],
    {
      state: "waiting",
      usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.012 },
      pendingCheckpoints: [{ checkpointId: 0, title: "Approve the plan?", payload: { angles: 4 }, since: NOW - 30 }],
    },
  );
  store.runEvents = [{ type: "agent_failed", ts: NOW - 30, label: "search:1", reason: "rate_limit", retryAfter: 630 }];
  const html = renderJob(view, NOW);
  assert.match(html, /lifts in 10m00s · /, "the drawer says when the limit lifts");
  store.runEvents = [];
  assert.match(html, /class="card checkpoint/);
  assert.match(html, /Approve the plan\?/);
  assert.match(html, /data-cp="approve" data-cp-id="0"/);
  assert.match(html, /1\.5k<\/span><span class="k">tokens/);
  assert.match(html, /\$0\.012/);
  assert.match(html, /rate limit/); // the failed node and the drawer name the class
  store.focusRun(null);
});

test("the Job header: Share copies `odw bundle <run>`; a shared bundle is tagged and has no Share", async () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: null,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([], { state: "done" });
  const html = renderJob(view, NOW);
  assert.match(html, /data-copy="odw bundle 20260101-000000-aaaaaa"[^>]*>[\s\S]*?Share<\/button>/);
  assert.doesNotMatch(html, /shared bundle/);
  store.run = detail([], { state: "done", bundle: { bundledAt: NOW - 60, odwVersion: "0.5.0" } });
  const shared = renderJob(view, NOW);
  assert.match(shared, /<span class="tag bundle">shared bundle · read-only<\/span>/);
  assert.doesNotMatch(shared, /data-copy="odw bundle/);
  store.focusRun(null);

  // The token screen of `odw serve --token`: a form for the token, and why the last one was refused.
  const { renderTokenScreen } = await import("../web/src/views/token.ts");
  assert.match(renderTokenScreen(null), /<form [^>]*data-token-form[\s\S]*type="password" name="token"/);
  assert.doesNotMatch(renderTokenScreen(null), /role="alert"/);
  assert.match(renderTokenScreen("wrong"), /That token was refused/);
  assert.match(renderTokenScreen("locked"), /Too many wrong tokens/);
});

test("the Logs tab paints the newest events and pages older ones in", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "logs",
    selectedAi: null,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent", "phase", "log", "run"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([]);
  store.runEvents = Array.from({ length: 1500 }, (_, i) => ({ ts: NOW - 1500 + i, type: "log", message: `line ${i}` }));
  const html = renderJob(view, NOW);
  assert.equal((html.match(/class="logrow"/g) ?? []).length, 600);
  assert.match(html, /line 1499/);
  assert.doesNotMatch(html, /line 899</);
  assert.match(html, /data-logs-more/);
  assert.match(html, /900 older events hidden/);
  store.focusRun(null);
});

test("exec() steps read as commands in the outline, the logs and the drawer", async () => {
  const { commandDetail } = await import("../web/src/views/activity.ts");
  assert.equal(commandDetail({ type: "command_started", label: "npm test" }), "npm test");
  assert.equal(commandDetail({ type: "command_failed", label: "npm test", exitCode: 1, durationMs: 4200 }), "npm test · exit 1 · 4.2s");
  const outline = outlineSource("phase('Test')\nconst r = await exec('npm test')\nawait agent('fix')\n", ["Test"]);
  assert.deepEqual(outline[0]!.ops.map((o) => o.kind), ["agent", "exec"]);
  assert.match(highlightSource("await exec('ls')"), /class="tk-f">exec/);
});

test("the Changes tab lists agents that left a diff and freezes a host for the diff itself", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "changes",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail(
    [
      agent("fix:auth", "Fix", "done", { agentId: 1, changes: { files: 2, insertions: 40, deletions: 3 }, branch: "odw/r/1-fix-auth" }),
      agent("survey", "Plan", "done", { agentId: 2 }),
      agent("fix:cache", "Fix", "done", { agentId: 3, changes: { files: 1, insertions: 0, deletions: 12, truncated: true } }),
    ],
    { state: "done" },
  );
  const html = renderJob(view, NOW);
  assert.match(html, /data-tab="changes"[^>]*>.*?<span class="n">2<\/span>/, "the tab counts agents with changes");
  assert.equal(count(html, /class="rv-item/g), 2, "an agent that changed nothing is not listed");
  assert.match(html, /class="rv-item on" data-review="0"/, "the first agent with changes is reviewed by default");
  assert.match(html, /data-copy="odw apply 20260101-000000-aaaaaa --agent 1"/);
  assert.match(html, /data-copy="odw apply 20260101-000000-aaaaaa --agent 1 --check"/, "a preview that changes nothing");
  assert.match(html, /data-copy="odw apply 20260101-000000-aaaaaa --all --check"/, "every agent previewed, stacked");
  assert.match(html, /data-copy="odw apply 20260101-000000-aaaaaa --all"/);
  assert.match(html, /data-copy="git switch odw\/r\/1-fix-auth"/, "a kept branch can be checked out");
  assert.match(html, /<div class="diff-host"[^>]*data-morph="skip" data-v="20260101-000000-aaaaaa:1\|loading\|en"/);
  assert.match(html, /<b class="ins">\+40<\/b><b class="del">−15<\/b><\/span><span class="k">lines changed/);

  view.reviewAi = 2;
  const second = renderJob(view, NOW);
  assert.match(second, /class="rv-item on" data-review="2"/);
  assert.match(second, /class="tag warn">truncated/);

  // The drawer, on the graph, summarizes and links to the review.
  view.tab = "graph";
  const drawer = renderJob(view, NOW);
  assert.match(drawer, /<button class="btn sm chg-go" data-review="0">/);
  assert.match(drawer, /class="ndelta"/, "graph nodes carry their diffstat");

  // A run with no diffs keeps the tab out of the way.
  store.run = detail([agent("survey", "Plan", "done", { agentId: 2 })], { state: "done" });
  view.tab = "graph";
  assert.ok(!renderJob(view, NOW).includes('data-tab="changes"'));
  view.tab = "changes";
  assert.match(renderJob(view, NOW), /No changes recorded/);
  store.focusRun(null);
});

test("Activity puts waiting checkpoints and the day's failures in front of the person", () => {
  const prev = store.runs;
  const counts = { agents: 4, running: 0, done: 2, failed: 2, stale: 0 };
  const failed = (id: string, ago: number, over: Partial<RunSummary> = {}) =>
    summary({ runId: id, name: `wf-${id}`, state: "failed", updatedAt: NOW - ago, counts, ...over });
  store.runs = [
    summary({ runId: "r-wait", name: "plan-approve", state: "waiting", waiting: { checkpointId: 1, title: "Ship <it>?", since: NOW - 60 } }),
    failed("r-f1", 100),
    failed("r-f2", 200),
    summary({ runId: "r-st", name: "wf-stale", state: "stale", stale: true, updatedAt: NOW - 300 }),
    failed("r-f3", 400),
    failed("r-old", 200_000),
    failed("r-cc", 10, { provider: "claude" }),
  ];
  const html = renderActivity(NOW);
  assert.match(html, /<section class="needs"/);
  assert.match(html, /class="ticket waiting"[\s\S]*?asks: Ship &lt;it&gt;\?/, "the checkpoint question is shown, escaped");
  assert.equal(count(html, /class="ticket /g), 4, "the waiting run and the three newest of the day's failures");
  assert.match(html, /data-copy="odw resume r-f1"/);
  assert.match(html, /class="ticket stale"[\s\S]*?lost its worker/);
  assert.ok(!/nt-r-old|nt-r-cc/.test(html), "old failures and Claude runs are not offered for resume");
  assert.match(html, /\+1 more failed in the last day/);
  assert.match(html, /<span class="n">5<\/span>/, "the count covers everything that needs a person");

  store.runs = [summary({ state: "done" })];
  assert.ok(!renderActivity(NOW).includes('class="needs"'), "nothing to do, nothing drawn");
  store.runs = prev;
});

test("checkpoint() gates join the graph, the timeline and the drawer", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: null,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("planner", "Plan", "done", { agentId: 1 })], {
    state: "waiting",
    phaseOrder: ["Plan", "Approve", "Execute"],
  });
  store.runEvents = [
    { type: "checkpoint_requested", ts: NOW - 90, checkpointId: 1, title: "Ship <it>?", payload: { steps: 3 }, phase: "Approve" },
  ];
  let html = renderJob(view, NOW);
  assert.match(html, /<div class="node waiting cp" data-ai="1"/, "the gate follows the agents, so their indexes stay put");
  assert.match(html, /Ship &lt;it&gt;\?/);
  assert.match(html, /waiting for a person · 1m30s/);
  assert.match(html, /class="flow wait"/, "the edge into a waiting gate marches in amber");

  store.runEvents = [
    ...store.runEvents,
    { type: "checkpoint_resolved", ts: NOW - 30, checkpointId: 1, approved: false, note: "scope it down", by: "dashboard" },
  ];
  store.run = { ...store.run!, state: "done" };
  view.selectedAi = 1;
  html = renderJob(view, NOW);
  assert.match(html, /<div class="node stopped cp/);
  assert.match(html, /rejected · dashboard · “scope it down”/);
  assert.match(html, /class="pill s-stopped">[\s\S]*?<span>rejected<\/span>/, "the drawer names the answer");
  assert.match(html, /<span class="k">waited<\/span><span class="v">1m00s<\/span>/);
  view.tab = "timeline";
  assert.match(renderJob(view, NOW), /class="tl-bar stopped"/);
  store.runEvents = [];
  store.focusRun(null);
});

test("the store announces a run that starts waiting, and a run that ends", () => {
  const seen: string[] = [];
  store.onTransition((r, prev) => seen.push(`${r.runId}:${prev}→${r.state}`));
  const setRuns = (runs: RunSummary[]) => (store as unknown as { setRuns(r: RunSummary[]): void }).setRuns(runs);
  const prev = store.runs;
  setRuns([summary({ runId: "r1", state: "running" })]);
  setRuns([summary({ runId: "r1", state: "running" })]);
  setRuns([summary({ runId: "r1", state: "waiting" }), summary({ runId: "r2", state: "waiting" })]);
  setRuns([summary({ runId: "r1", state: "waiting" }), summary({ runId: "r2", state: "running" })]);
  setRuns([summary({ runId: "r1", state: "done" }), summary({ runId: "r2", state: "waiting" })]);
  assert.deepEqual(seen, ["r1:running→waiting", "r2:pending→waiting", "r1:waiting→done", "r2:running→waiting"]);
  store.runs = prev;
});

test("the outline and the highlighter know checkpoint()", () => {
  const src = "phase('Plan')\nconst p = await agent('plan')\nphase('Approve')\nconst ok = await checkpoint('Run it?', { payload: p })\n// checkpoint('in a comment')\n";
  const phases = outlineSource(src, ["Plan", "Approve"]);
  assert.deepEqual(phases.find((p) => p.title === "Approve")?.ops, [{ kind: "checkpoint", n: 1 }]);
  assert.match(highlightSource(src), /<span class="tk-f">checkpoint<\/span>/);
});

test("cronWords says the common schedules in words and leaves the rest alone", () => {
  assert.equal(cronWords("15 2 * * 1-5"), "02:15 on weekdays");
  assert.equal(cronWords("*/30 * * * *"), "every 30 minutes");
  assert.equal(cronWords("5 * * * *"), "hourly at :05");
  assert.equal(cronWords("0 9 * * *"), "09:00 daily");
  assert.equal(cronWords("0 9 * * 1,3"), "09:00 on Mon, Wed");
  assert.equal(cronWords("0 9 * * 0,6"), "09:00 on weekends");
  assert.equal(cronWords("0 9 1 * *"), null, "a day of month: shown as the expression");
  assert.equal(cronWords("0 9-17 * * *"), null);
});

test("Jobs lists what odw schedule starts next, soonest first", () => {
  const prevRuns = store.runs;
  const prevSchedules = store.schedules;
  store.runs = [summary({ runId: "r-old", state: "done" })];
  const at = (sec: number) => new Date((NOW + sec) * 1000).toISOString();
  store.schedules = [
    { name: "weekly", workflow: "/p/digest.js", cron: "0 9 * * 1", backend: "cron", cwd: "/p", installed: false, lastRun: null, nextRun: at(3 * 86_400) },
    { name: "triage", workflow: "/p/survey.js", cron: "*/30 * * * *", backend: "systemd", cwd: "/p", installed: true, lastRun: { runId: "20260101-000000-bbbbbb", state: "done", at: at(-600) }, nextRun: at(420) },
  ];
  const html = renderJobs({ filter: "all", query: "", limit: 100 }, NOW);
  assert.match(html, /<h2>Upcoming<\/h2>/);
  assert.ok(html.indexOf("sc-triage") < html.indexOf("sc-weekly"), "soonest first");
  assert.match(html, /in 7m/);
  assert.match(html, /every 30 minutes/);
  assert.match(html, /href="#\/job\/20260101-000000-bbbbbb"/, "the last run links to its job");
  assert.match(html, /class="card sched missing"[\s\S]*?Its cron entry is missing: odw schedule remove weekly/);
  assert.match(html, /never ran/);
  assert.ok(!renderJobs({ filter: "failed", query: "", limit: 100 }, NOW).includes("Upcoming"), "only on the All view");
  assert.ok(!renderJobs({ filter: "all", query: "zzz", limit: 100 }, NOW).includes("Upcoming"), "the filter applies");
  store.runs = [];
  assert.match(renderJobs({ filter: "all", query: "", limit: 100 }, NOW), /<h2>Upcoming<\/h2>[\s\S]*No runs yet/, "schedules show before the first run");
  store.runs = prevRuns;
  store.schedules = prevSchedules;
});

test("transcript entries read as a log: prose, tool chips, results, retries", () => {
  const html = transcriptEntries([
    { i: 0, kind: "raw", text: "model x · 2 tools: Read, Bash" },
    { i: 1, kind: "text", text: "Let me <check>.", thinking: true },
    { i: 2, kind: "text", text: "Checking the tests." },
    { i: 3, kind: "tool_call", tool: "Bash", text: "npm test", input: { command: "npm test", description: "run" } },
    { i: 4, kind: "tool_result", tool: "Bash", text: "exit 1, 3 lines", output: "✗ 1 failing", isError: true },
    { i: 5, kind: "attempt", n: 2, reason: "schema" },
    { i: 6, kind: "result", turns: 4, costUsd: 0.0123 },
    { i: 7, kind: "truncated", bytes: 5_000_000 },
  ]);
  assert.match(html, /class="tx tx-think"[\s\S]*?Let me &lt;check&gt;\./, "escaped, marked as thinking");
  assert.match(html, /<span class="tx-tool">▸ Bash<\/span><code class="tx-what">npm test<\/code>/);
  assert.match(html, /<details class="tx-fold"><summary>input<\/summary><pre>\{\n {2}&quot;command&quot;/, "the input is folded away");
  assert.match(html, /class="tx tx-res err"[\s\S]*?<details class="tx-fold" open><summary>output/, "a failed tool's output starts open");
  assert.match(html, /attempt 2 · schema retry/);
  assert.match(html, /done · 4 turns · \$0\.012/);
  assert.match(html, /maxTranscriptBytes/);
});

test("the transcript sheet opens over the graph and freezes its host for appends", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    transcriptAi: 0,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("search:1", "Search", "running", { agentId: 7 })], { state: "running" });
  store.transcripts.set("20260101-000000-aaaaaa:7", { entries: [{ i: 0, kind: "text", text: "hi" }], next: 1, dropped: 0, truncated: false, replayed: false, missing: false });
  const html = renderJob(view, NOW);
  assert.match(html, /<button class="btn sm tx-open" data-transcript="0">/, "the drawer offers the transcript");
  assert.match(html, /<aside class="sheet" data-key="tx-sheet"/);
  assert.match(html, /1 entry · following/);
  assert.match(html, /data-copy="odw logs 20260101-000000-aaaaaa --agent 7 --follow"/);
  assert.match(html, /<div class="tx-host"[^>]*data-morph="skip"[^>]*data-tx="20260101-000000-aaaaaa:7"/);
  assert.match(html, /class="tx-wait"/, "a live agent shows it is working");
  store.transcripts.clear();
  store.focusRun(null);
});

test("the drawer names an agent's permission tier", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("review:1", "Review", "done", { agentId: 1, permissions: "read" })], { state: "done" });
  assert.match(renderJob(view, NOW), /<span class="k">permissions<\/span><span class="v"><span class="tag perm-read" title="reads and searches; no edits, no commands">read<\/span>/);
  assert.doesNotMatch(renderJob(view, NOW), /trust-untrusted/, "a trusted agent shows no trust row");
  // An agent whose CLI ran untrusted (ODW extension: --untrusted) says so beside its tier.
  store.run = detail([agent("review:1", "Review", "done", { agentId: 1, permissions: "read", trust: "untrusted" })], { state: "done" });
  assert.match(renderJob(view, NOW), /<span class="k">trust<\/span><span class="v"><span class="tag trust-untrusted" title="[^"]+">untrusted<\/span>/);
  store.focusRun(null);
});

test("the drawer names the agent definition an agent ran as (ODW extension: agentType)", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("review:1", "Review", "done", { agentId: 1 })], { state: "done" });
  assert.doesNotMatch(renderJob(view, NOW), /agent-type-path/, "no definition, no row");
  const agentType = { name: "reviewer", source: "project", path: "/repo/.claude/agents/reviewer.md", sha256: "ab".repeat(32) };
  store.run = detail([agent("review:1", "Review", "done", { agentId: 1, agentType })], { state: "done" });
  const html = renderJob(view, NOW);
  assert.match(html, /<span class="k">agent type<\/span><span class="v"><span class="tag" title="[^"]+">reviewer<\/span>/);
  assert.match(html, /<span class="mono dim agent-type-path" title="\/repo\/\.claude\/agents\/reviewer\.md · sha256 (ab)+">\.claude\/agents\/reviewer\.md<\/span>/);
  store.focusRun(null);
});

test("an agent that fell back shows its chain in the graph, the drawer and the transcript", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("search:3", "Search", "done", { agentId: 3, adapter: "claude", fellBackFrom: ["codex"] })], { state: "done" });
  const html = renderJob(view, NOW);
  assert.match(html, /<div class="sub">codex → claude · 1m00s<\/div>/, "the node names the chain");
  assert.match(html, /<span class="v">claude <span class="tag warn"[^>]*>after codex<\/span><\/span>/, "the drawer names what it replaced");
  assert.match(transcriptEntries([{ i: 4, kind: "attempt", n: 2, reason: "fallback", adapter: "claude" }]), /class="tx tx-sep fallback"[^>]*><span>attempt 2 · fallback → claude<\/span>/);
  // A fallback that handed the work over (ODW extension): a separator, its brief folded under it.
  const handoff = transcriptEntries([{ i: 3, kind: "handoff", from: "codex", adapter: "claude", reason: "quota", bytes: 812, output: "## Handoff <b>" }]);
  assert.match(handoff, /class="tx tx-sep fallback handoff"[^>]*><span>handoff · codex → claude · brief of 812 bytes<\/span>/);
  assert.match(handoff, /<details class="tx-fold"><summary>handoff brief<\/summary><pre>## Handoff &lt;b&gt;<\/pre><\/details>/);
  store.focusRun(null);
});

test("the drawer shows what an agent's work missed and the tool calls its CLI refused", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail(
    [
      agent("fix", "Fix", "failed", { agentId: 1, failureReason: "unmet_expectation", misses: ["command failed: npm test (exit 1)", "no files changed"] }),
      agent("review", "Fix", "done", { agentId: 2, denied: ["Bash (npm test)", "Bash (pnpm lint)"] }),
      agent("npm test", "Fix", "failed", { kind: "command", commandId: 1, agentId: null, forAgentId: 1, exitCode: 1 }),
    ],
    { state: "failed" },
  );
  let html = renderJob(view, NOW);
  assert.match(html, /unmet expectation/);
  assert.match(html, /<ul class="misses"><li>command failed: npm test \(exit 1\)<\/li><li>no files changed<\/li><\/ul>/);
  view.selectedAi = 1;
  html = renderJob(view, NOW);
  assert.match(html, /<ul class="denied"><li>Bash \(npm test\)<\/li><li>Bash \(pnpm lint\)<\/li><\/ul>/);
  assert.match(html, /<span class="ndeny" title="2 tool calls refused">⚠2<\/span>/, "the node carries the warning");
  view.selectedAi = 2;
  assert.match(renderJob(view, NOW), /<span class="k">checks<\/span><span class="v">agent #1's work<\/span>/);
  store.focusRun(null);
});

test("redaction markers render as ink bars, and redacted outputs are tagged", () => {
  assert.equal(
    markRedactions(esc("key=«redacted:env:OPENAI_API_KEY» <b>")),
    'key=<span class="redact" title="redacted">env:OPENAI_API_KEY</span> &lt;b&gt;',
  );
  assert.match(renderJson({ token: "Bearer «redacted:bearer»" }), /<span class="redact" title="redacted">bearer<\/span>/);
  assert.match(renderJson({ "«redacted:x»": 1 }), /data-key="j\$"/, "attributes never carry markup");
  const tx = transcriptEntries([{ i: 0, kind: "text", text: "export KEY=«redacted:env:KEY»", redacted: true }]);
  assert.match(tx, /<span class="redact" title="redacted">env:KEY<\/span>/);
  assert.match(tx, /<span class="tx-clip"[^>]*>redacted<\/span>/);
});

test("a run waiting out a spent quota says until when, and offers to go on now", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: null,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  const resumeAt = NOW + 3600 + 12 * 60;
  const pausedFor = { reason: "quota" as const, adapter: "codex", resumeAt };
  store.capabilities = { writable: true };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("search:1", "Search", "running", { agentId: 1 })], { state: "paused", pausedFor });
  const html = renderJob(view, NOW);
  assert.match(html, /<section class="card qpause"/);
  assert.match(html, /codex is out of quota/);
  assert.match(html, /in 1h12m/);
  assert.match(html, /data-resume-run="20260101-000000-aaaaaa"/);
  const prev = store.runs;
  store.runs = [summary({ runId: "r-q", name: "nightly", state: "paused", pausedFor })];
  assert.match(renderActivity(NOW), /class="ticket paused"[\s\S]*?codex is out of quota — resumes at/);
  store.runs = prev;
  store.focusRun(null);
});

test("spend: phases in declared order with outsiders last, shares of cost, top spenders, and nothing before any usage", () => {
  const u = (inputTokens: number, outputTokens: number, costUsd?: number) => ({ inputTokens, outputTokens, ...(costUsd != null ? { costUsd } : {}) });
  const run = detail([
    agent("search:1", "Search", "done", { adapter: "claude", usage: u(4000, 1000, 0.3) }),
    agent("plan", "Plan", "done", { adapter: "claude", usage: u(1000, 500, 0.05) }),
    agent("loose", undefined as unknown as string, "done", { adapter: "claude", phase: undefined, usage: u(100, 100, 0.01) }),
    agent("search:2", "Search", "running", { adapter: "claude" }),
    agent("$ npm test", "Search", "done", { kind: "command" }),
  ]);
  const sp = spendOf(run)!;
  assert.equal(sp.by, "cost");
  assert.deepEqual(
    sp.phases.map((l) => [l.key, l.agents, l.running, l.tokens, l.costUsd]),
    [
      ["Plan", 1, 0, 1500, 0.05],
      ["Search", 2, 1, 5000, 0.3],
      ["Report", 0, 0, 0, null],
      ["", 1, 0, 200, 0.01],
    ],
    "declared phases keep their order (one not started yet included), commands spend nothing, outsiders close the list",
  );
  assert.deepEqual(sp.top.map((x) => x.a.label), ["search:1", "plan", "loose"]);
  assert.equal(sp.tokens, 6700);
  assert.ok(Math.abs(sp.costUsd! - 0.36) < 1e-9);
  assert.equal(sp.running, 1);

  // A codex agent reports tokens but no dollars: the shares are of tokens.
  const mixed = spendOf(detail([agent("a", "Plan", "done", { adapter: "claude", usage: u(10, 10, 0.5) }), agent("b", "Plan", "done", { adapter: "codex", usage: u(900, 100) })]))!;
  assert.equal(mixed.by, "tokens");
  assert.deepEqual(mixed.adapters.map((l) => l.key), ["codex", "claude"], "adapters biggest first");
  assert.deepEqual(mixed.top.map((x) => x.a.label), ["b", "a"]);

  assert.equal(spendOf(detail([agent("a", "Plan", "running")])), null, "no receipt before an agent reports usage");
});

test("spend: the tokens and cost unfold a receipt by phase, adapter and agent", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "logs",
    selectedAi: null,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail(
    [
      agent("plan", "Plan", "done", { adapter: "claude", usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 } }),
      agent("search:1", "Search", "done", { adapter: "codex", usage: { inputTokens: 8000, outputTokens: 1000, estimated: true } }),
    ],
    { state: "running", usage: { inputTokens: 9000, outputTokens: 1500, costUsd: 0.05, estimated: true } },
  );
  store.runEvents = [];
  const closed = renderJob(view, NOW);
  assert.match(closed, /<button class="spend-btn" data-spend aria-expanded="false"/, "tokens and cost are one button");
  assert.doesNotMatch(closed, /class="receipt"/);

  const html = renderJob({ ...view, spend: true }, NOW);
  assert.match(html, /<button class="spend-btn on" data-spend aria-expanded="true"/);
  assert.match(html, /<section class="receipt"/);
  assert.match(html, /Where this run spent/);
  assert.equal(count(html, /<li class="rc-line/g), 3, "Plan, Search, and Report not started yet");
  assert.match(html, /data-key="rc-Report"[^>]*>.*?not started/s);
  assert.match(html, /share of tokens/, "codex reported no dollars, so shares are of tokens");
  assert.match(html, /Not every agent reported dollars/);
  assert.match(html, /partly estimated/);
  assert.match(html, /class="rc-split"/, "two adapters: a split bar");
  assert.match(html, /--c:var\(--clay\)/, "claude in its provenance colour");
  assert.match(html, /data-spend-ai="1"[\s\S]*data-spend-ai="0"/, "top spenders biggest first");
  store.focusRun(null);
});

test("an agent waiting out a spent quota is drawn waiting — amber node, until when, and why in its drawer", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("scan", "Plan", "running", { quotaWait: { adapter: "codex", resumeAt: NOW + 3600 } })], { state: "running" });
  store.runEvents = [];
  const html = renderJob(view, NOW);
  assert.match(html, /class="node waiting qwait/);
  assert.match(html, /waits for codex quota · /);
  assert.match(html, /<span class="pill s-waiting">.*?quota wait/s);
  assert.match(html, /Waiting for codex&#39;s quota to reset at .* \(in 1h00m\)|Waiting for codex's quota to reset at .* \(in 1h00m\)/);
  store.focusRun(null);
});

test("compare: figures with their deltas, what changed in the setup, and a row per agent that opens on its reply diff", async () => {
  const { renderCompare, verdict } = await import("../web/src/views/compare.ts");
  const facts = (over: Record<string, unknown> = {}) => ({
    agentId: 1, label: "plan", phase: "Plan", state: "done", adapter: "claude", model: null, attempts: 1, durationMs: 10_000,
    inputTokens: 1000, outputTokens: 200, costUsd: 0.01, estimated: false, replayed: false, failureReason: null, error: null, changes: null, ...over,
  });
  const run = (runId: string) => ({ runId, name: "demo", workflowName: "demo", state: "done", live: false, createdAt: NOW, odwVersion: "0.5.0", sourceHash: null, resumedFrom: null });
  const m = (a: number, b: number) => ({ a, b, delta: b - a });
  store.comparison = {
    key: "A/B",
    error: null,
    value: {
      version: 1,
      a: run("A"),
      b: run("B"),
      notes: [],
      setup: [{ field: "cliVersion.claude", a: "2.1.300", b: "2.1.302" }],
      totals: { wallMs: m(60_000, 30_000), inputTokens: m(1000, 1100), outputTokens: m(200, 200), costUsd: m(0.01, 0.02), agents: m(2, 2), done: m(2, 1), failed: m(0, 1), estimated: { a: false, b: false } },
      agents: [
        { match: "label", outcome: "unchanged", label: "plan", phase: "Plan", a: facts(), b: facts({ durationMs: 4000 }),
          delta: { durationMs: -6000, inputTokens: 0, outputTokens: 0, costUsd: 0, attempts: 0 },
          reply: { status: "differs", kind: "text", diff: ["@@ -1 +1 @@", "-old line", "+new line"], added: 1, removed: 1, truncated: false } },
        { match: "label", outcome: "newly-failed", label: "check", phase: "Plan", a: facts({ label: "check" }), b: facts({ label: "check", state: "failed", failureReason: "timeout", error: "timed out" }),
          delta: { durationMs: 20_000, inputTokens: 100, outputTokens: 0, costUsd: 0.01, attempts: 1 },
          reply: { status: "none", kind: null, truncated: false } },
      ],
    },
  } as never;
  const html = renderCompare("A/B");
  assert.match(html, /What changed in <em>demo<\/em>/);
  assert.match(html, /data-key="cf-wall"[\s\S]*?dlt better">−50%/, "half the wall time is better");
  assert.match(html, /data-key="cf-usd"[\s\S]*?dlt worse">\+100%/);
  assert.match(html, /claude version<\/span><span class="a mono" title="2\.1\.300">/);
  assert.match(html, /<details class="cmp-row newly-failed"/);
  assert.match(html, /class="dv left better"/, "faster leans left");
  assert.match(html, /class="dv right worse"/);
  assert.match(html, /<span class="del">-old line<\/span>\n<span class="add">\+new line<\/span>/);
  assert.match(html, /data-copy="odw compare A B --agent check"/);
  assert.equal(verdict({ a: 100, b: 103, delta: 3 }), "same", "within 5% is noise");
  assert.equal(verdict({ a: 2, b: 1, delta: -1 }, false), "worse", "fewer done is worse");
  store.comparison = null;
});

test("a checkpoint approved with edits says so, and the drawer shows what was approved", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 1,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("planner", "Plan", "done", { agentId: 1 })], { state: "done", phaseOrder: ["Plan", "Approve"] });
  store.runEvents = [
    { type: "checkpoint_requested", ts: NOW - 90, checkpointId: 1, title: "Ship it?", payload: { steps: ["a", "b"] }, phase: "Approve" },
    { type: "checkpoint_resolved", ts: NOW - 30, checkpointId: 1, approved: true, note: null, by: "cli", edited: true, payload: { steps: ["only-b"] } },
  ];
  const html = renderJob(view, NOW);
  assert.match(html, /approved with edits · cli/, "the graph node");
  assert.match(html, /class="pill s-done">[\s\S]*?<span>approved with edits<\/span>/, "the drawer's pill");
  assert.match(html, /Approved payload \(edited\)[\s\S]*?only-b[\s\S]*?Payload/, "the approved payload, then what was asked");
  store.runEvents = [];
  store.focusRun(null);
});

test("a checkpoint's payload can be edited before approving: valid, changed, invalid, and never when it was cut or redacted", async () => {
  const { cpEditState } = await import("../web/src/views/job.ts");
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: null,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.capabilities = { ...store.capabilities, writable: true };
  const asked = { steps: ["a", "b"] };
  store.run = detail([], {
    state: "waiting",
    pendingCheckpoints: [
      { checkpointId: 0, title: "Run this plan?", payload: asked, since: NOW - 5 },
      { checkpointId: 1, title: "Cut", payload: "{\"x\":", truncated: true, since: NOW - 5 },
    ],
  });
  store.runEvents = [];
  const closed = renderJob(view, NOW);
  assert.equal(count(closed, /data-cp-edit="/g), 1, "only the whole payload can be edited");

  const same = renderJob({ ...view, cpEdit: { id: 0, text: JSON.stringify(asked, null, 2) } }, NOW);
  assert.match(same, /<textarea id="cp-payload"/);
  assert.match(same, /valid JSON · unchanged/);
  assert.match(same, /data-cp="approve" data-cp-id="0">Approve</);

  const edited = renderJob({ ...view, cpEdit: { id: 0, text: '{"steps":["a"]}' } }, NOW);
  assert.match(edited, /valid JSON · edited/);
  assert.match(edited, /data-cp="approve" data-cp-id="0">Approve with edits</);

  const broken = renderJob({ ...view, cpEdit: { id: 0, text: '{"steps":' } }, NOW);
  assert.match(broken, /class="cpv bad">not valid JSON/);
  assert.match(broken, /data-cp="approve" data-cp-id="0" disabled>/);

  assert.deepEqual(cpEditState(asked, ' { "steps" : ["a","b"] } '), { ok: true, changed: false, error: null, value: asked }, "whitespace is no edit");
  store.focusRun(null);
});

test("an agent whose MCP servers did not start lists them in its drawer", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("fix", "Plan", "failed", { adapter: "claude", failureReason: "mcp_unavailable", mcp: [{ name: "github", status: "failed" }] })]);
  store.runEvents = [];
  const html = renderJob(view, NOW);
  assert.match(html, /MCP servers<\/div><ul class="mcp"><li><span class="tag warn">failed<\/span><span class="mono">github<\/span>/);
  assert.match(html, /MCP unavailable/);
  store.focusRun(null);
});

test("an agent that left background work running lists it in its drawer, and the reason has words", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("serve", "Plan", "done", { adapter: "claude", orphaned: ["Bash (Start the dev server)", "Explore (<survey>)"] })]);
  store.runEvents = [];
  const html = renderJob(view, NOW);
  assert.match(html, /Left running<\/div><ul class="denied orphaned"><li>Bash \(Start the dev server\)<\/li><li>Explore \(&lt;survey&gt;\)<\/li><\/ul>/);
  assert.match(html, /it died when the CLI exited/);
  assert.equal(reasonLabel("orphaned_background"), "orphaned background work");
  store.focusRun(null);
});

test("an agent's drawer sets the model it asked for beside the one that served it: substituted flagged, not reported said so", async () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.runEvents = [];
  const swapped = { requested: "opus", served: ["claude-sonnet-4-5"] };
  store.run = detail([agent("review", "Plan", "done", { adapter: "claude", model: "opus", servedModel: ["claude-sonnet-4-5"], substituted: swapped })]);
  let html = renderJob(view, NOW);
  assert.match(html, /<span class="k">model<\/span><span class="v mono">opus<\/span>/);
  assert.match(html, /<span class="k">served by<\/span><span class="v"><span class="mono">claude-sonnet-4-5<\/span> <span class="tag warn served-swap"[^>]*>substituted<\/span>/);

  // Served as asked: no flag.
  store.run = detail([agent("review", "Plan", "done", { adapter: "claude", model: "sonnet", servedModel: ["claude-sonnet-4-5"] })]);
  html = renderJob(view, NOW);
  assert.match(html, /served by<\/span><span class="v"><span class="mono">claude-sonnet-4-5<\/span><\/span>/);
  assert.doesNotMatch(html, /served-swap/);

  // A CLI that names no model: "not reported", never a guess; the CLI's default when none was asked for.
  store.run = detail([agent("review", "Plan", "done", { adapter: "codex" })]);
  html = renderJob(view, NOW);
  assert.match(html, /<span class="k">model<\/span><span class="v mono">CLI default<\/span>/);
  assert.match(html, /served by<\/span><span class="v"><span class="dim"[^>]*>not reported<\/span>/);
  assert.equal(reasonLabel("model_substituted"), "served by another model");
  store.focusRun(null);

  // odw compare's agent row flags the side another model served.
  const { renderCompare } = await import("../web/src/views/compare.ts");
  const facts = (over: Record<string, unknown> = {}) => ({
    agentId: 1, label: "review", phase: "Plan", state: "done", adapter: "claude", model: "opus", servedModel: ["claude-opus-5-5"], substituted: false, attempts: 1,
    durationMs: 10_000, inputTokens: 1000, outputTokens: 200, costUsd: 0.01, estimated: false, replayed: false, failureReason: null, error: null, changes: null, ...over,
  });
  const run = (runId: string) => ({ runId, name: "demo", workflowName: "demo", state: "done", live: false, createdAt: NOW, odwVersion: "0.5.0", sourceHash: null, resumedFrom: null });
  const m = (a: number, b: number) => ({ a, b, delta: b - a });
  store.comparison = {
    key: "A/B",
    error: null,
    value: {
      version: 1,
      a: run("A"),
      b: run("B"),
      notes: [],
      setup: [{ field: "modelsServed", a: ["claude-opus-5-5"], b: ["claude-sonnet-4-5"] }],
      totals: { wallMs: m(1, 1), inputTokens: m(1, 1), outputTokens: m(1, 1), costUsd: m(1, 1), agents: m(1, 1), done: m(1, 1), failed: m(0, 0), estimated: { a: false, b: false } },
      agents: [
        { match: "label", outcome: "unchanged", label: "review", phase: "Plan", a: facts(), b: facts({ servedModel: ["claude-sonnet-4-5"], substituted: true }),
          delta: { durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, attempts: 0 },
          reply: { status: "identical", kind: null, truncated: false } },
      ],
    },
  } as never;
  const cmp = renderCompare("A/B");
  assert.match(cmp, /<span class="k">models served<\/span><span class="a mono"[^>]*>\[&quot;claude-opus-5-5&quot;\]<\/span>/);
  assert.equal(count(cmp, /<span class="tag warn"[^>]*>served by claude-sonnet-4-5<\/span>/g), 1, "only the side another model served");
  store.comparison = null;
});

test("an agent's destructive git commands are marked on its node and listed in its drawer, with odw restore when the run has a snapshot", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  const hits = [{ command: "cd x && git reset --hard <HEAD>", what: "git reset --hard" }];
  const snapshot = { ref: "refs/odw/safety/20260101-000000-aaaaaa", commit: "c".repeat(40), head: "h".repeat(40), tracked: 2, untracked: 1, at: NOW - 110 };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("fix", "Plan", "done", { adapter: "claude", destructiveGit: hits })], { safetySnapshot: snapshot });
  store.runEvents = [];
  const html = renderJob(view, NOW);
  assert.match(html, /Destructive git commands<\/div><ul class="denied destructive-git"><li><span class="tag">git reset --hard<\/span> cd x &amp;&amp; git reset --hard &lt;HEAD&gt;<\/li><\/ul>/);
  assert.match(html, /<code>odw restore 20260101-000000-aaaaaa<\/code> puts it back/);
  assert.match(html, /data-copy="odw restore 20260101-000000-aaaaaa">/);
  assert.match(html, /<span class="ndeny ngit" title="ran 1 destructive git command\(s\)">git!<\/span>/);
  // The run's head carries the snapshot as a chip that copies the restore command.
  assert.match(html, /<span class="tag safety" role="button" tabindex="0" data-copy="odw restore 20260101-000000-aaaaaa" title="2 changed and 1 untracked file\(s\) kept at refs\/odw\/safety\/20260101-000000-aaaaaa/);
  // Without a snapshot the drawer says where the work may still be.
  store.run = detail([agent("fix", "Plan", "failed", { adapter: "claude", destructiveGit: hits, failureReason: "destructive_git" })]);
  const bare = renderJob(view, NOW);
  assert.match(bare, /No snapshot of the working tree was taken for this run/);
  assert.doesNotMatch(bare, /tag safety/);
  assert.equal(reasonLabel("destructive_git"), "ran a destructive git command");
  store.focusRun(null);
});

test("evals: a card per eval with its pass-rate dial and trend, and a report as a case × adapter matrix", async () => {
  const { renderEvals, rateColor } = await import("../web/src/views/evals.ts");
  const totals = (passed: number, runs: number) => ({ runs, passed, failed: runs - passed, passRate: passed / runs, costUsd: 0.5, inputTokens: 1000, outputTokens: 100 });
  const summary = (id: string, passed: number) => ({ name: "triage", id, description: "labels", workflow: "triage", evalHash: "h", startedAt: "2026-10-18T05:00:00Z", finishedAt: "2026-10-18T05:01:00Z", totals: totals(passed, 4), adapters: ["claude"], cases: 2, regressed: null });
  store.evals = [summary("20261018-050100-bbbbbb", 3), summary("20261018-050000-aaaaaa", 2)];
  const list = renderEvals(null);
  assert.equal(count(list, /class="card ev-card"/g), 1, "one card per eval name");
  assert.equal(count(list, /class="tick/g), 2);
  assert.match(list, /<a class="tick on" href="#\/evals\/triage\/20261018-050100-bbbbbb"/, "the latest report is lit");
  assert.doesNotMatch(list, /<a class="card/, "no link nests a link");
  assert.match(list, /75%/);

  const run = (c: string, repeat: number, passed: boolean) => ({ runId: `r-${c}-${repeat}`, case: c, adapter: "claude", repeat, state: "done", passed, timedOut: false, wallMs: 1000, inputTokens: 1, outputTokens: 1, costUsd: 0.1, estimated: false, cliVersions: {}, error: null, failures: passed ? [] : [{ check: "label equals \"bug\"", message: "label is \"question\"" }] });
  const cell = (c: string, passed: number) => ({ case: c, adapter: "claude", runs: 2, passed, passRate: passed / 2, medianMs: 1000, costUsd: 0.2, meanCostUsd: 0.1, meanTokens: 2, runIds: [`r-${c}-1`, `r-${c}-2`] });
  store.evalReport = {
    key: "triage/X",
    error: null,
    value: {
      version: 1, name: "triage", id: "X", file: "/p/.odw/evals/triage.json", description: null, evalHash: "h",
      definition: { workflow: "triage", cases: [], adapters: ["claude"], repeats: 2, concurrency: 1, budget: null, timeout: null },
      workflow: { ref: "triage", script: "/p/triage.js", sourceHash: null }, odwVersion: "0.5.0", cliVersions: { claude: ["2.1.302"] },
      startedAt: "", finishedAt: "", wallMs: 4000, totals: totals(3, 4),
      cells: [cell("crash", 2), cell("how-to", 1)],
      runs: [run("crash", 1, true), run("crash", 2, true), run("how-to", 1, true), run("how-to", 2, false)],
      baseline: { file: "b.json", name: "triage", id: "W", evalHash: "h", sameDefinition: true, regressed: [{ case: "how-to", adapter: "claude" }],
        cells: [{ case: "how-to", adapter: "claude", status: "regressed", passRate: { a: 1, b: 0.5, delta: -0.5 }, meanCostUsd: { a: 0.1, b: 0.1, delta: 0 }, medianMs: { a: 1, b: 1, delta: 0 } }] },
    },
  } as never;
  const report = renderEvals("triage/X");
  assert.equal(count(report, /class="ev-tile[ "]/g), 2);
  assert.match(report, /class="ev-tile regressed"/);
  assert.match(report, /▼ 50%/);
  assert.equal(count(report, /class="sq ok"/g), 3);
  assert.match(report, /href="#\/job\/r-how-to-2"/);
  assert.match(report, /label equals &quot;bug&quot;: label is &quot;question&quot;|label equals "bug": label is "question"/);
  assert.match(report, /claude 2\.1\.302/);
  assert.match(rateColor(1), /var\(--sig\) 100%/);
  assert.match(rateColor(0), /var\(--amber\) 0%, var\(--alarm\)/);
  store.evals = null;
  store.evalReport = null;
});

test("the Workspace groups a Claude Code plugin's workflows on their own, and their keys round-trip", () => {
  const wf = (name: string, provider: WorkflowSummary["provider"], origin: WorkflowSummary["origin"] = "project"): WorkflowSummary => ({
    name,
    origin,
    provider,
    rootLabel: provider.startsWith("claude-plugin:") ? "Claude Code plugin acme-tools@market 1.0.0 (user scope)" : ".odw/workflows",
    path: `/x/${name}.js`,
    description: null,
    phases: [],
    runCount: 0,
    shadowed: false,
  });
  const list = [wf("acme-tools:audit", "claude-plugin:acme-tools", "plugin"), wf("audit", "claude"), wf("echo", "odw")];
  assert.deepEqual(orderedWorkflows(list).map((w) => w.name), ["echo", "audit", "acme-tools:audit"]);
  const key = wfKey(list[0]!);
  assert.equal(key, "claude-plugin:acme-tools:acme-tools:audit");
  assert.deepEqual(parseWfKey(key), { provider: "claude-plugin:acme-tools", name: "acme-tools:audit" });
  assert.deepEqual(parseWfKey("odw:echo"), { provider: "odw", name: "echo" });
  assert.deepEqual(parseWfKey("echo"), { name: "echo" });
  const saved = store.workflows;
  store.workflows = list;
  try {
    assert.match(renderWorkspace(key, null, ""), /<span>Claude Code plugins<\/span><span>1<\/span>/);
  } finally {
    store.workflows = saved;
  }
});

test("an agent that ran in a container says which, and whether it was offline", () => {
  const view: JobViewState = { cpNote: "", tab: "graph", selectedAi: 0, reviewAi: null, zoom: 1, logQuery: "", logTypes: new Set(["agent"]), logLimit: 600, follow: true, motion: false };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("fix", "Plan", "done", { sandbox: { kind: "container", engine: "docker", image: "odw-agents:1", network: "none" } } as Partial<AgentView>)]);
  store.runEvents = [];
  const html = renderJob(view, NOW);
  assert.match(html, /sandbox<\/span><span class="v"><span class="tag" title="odw-agents:1">docker<\/span> <span class="mono dim">odw-agents:1<\/span> <span class="tag">offline<\/span>/);
  store.focusRun(null);
});

test("a run whose agents posted notes gets a Notes tab of pinned slips; interface notes read as code", () => {
  const view: JobViewState = { cpNote: "", tab: "notes", selectedAi: null, reviewAi: null, zoom: 1, logQuery: "", logTypes: new Set(["agent"]), logLimit: 600, follow: true, motion: false };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("lane", "Plan", "done")]);
  store.runEvents = [{ type: "note_added", ts: NOW - 5 }, { type: "note_added", ts: NOW - 4 }];
  store.notes.set("20260101-000000-aaaaaa", [
    { noteId: 1, ts: NOW - 5, by: { agentId: 1, label: "lane:parser" }, text: "renamed parseX → parse", kind: "note" },
    { noteId: 2, ts: NOW - 4, by: { agentId: 1, label: "lane:parser" }, text: "1 file, +2 −1\n+export function parse(", kind: "interface" },
  ]);
  const html = renderJob(view, NOW);
  assert.match(html, /data-tab="notes"[^>]*>.*?Notes<span class="n">2<\/span>/s);
  assert.equal(count(html, /<article class="slip/g), 2);
  assert.match(html, /<article class="slip interface"[\s\S]*?<pre class="slip-code">1 file, \+2 −1\n\+export function parse\(<\/pre>/);
  store.notes.clear();
  store.runEvents = [];
});

test("an agent killed at one of its limits shows its limits, the one it hit, and the evidence", () => {
  const view: JobViewState = { cpNote: "", tab: "graph", selectedAi: 0, reviewAi: null, zoom: 1, logQuery: "", logTypes: new Set(["agent"]), logLimit: 600, follow: true, motion: false };
  store.focusRun("20260101-000000-aaaaaa");
  const hit = { limit: "repeat" as const, max: 5, value: 5, evidence: "Bash `npm test` ×5 in a row" };
  store.run = detail([agent("fix", "Plan", "failed", { failureReason: "runaway", limits: { toolCalls: 40, costUsd: 2, repeat: 5, hit } })]);
  store.runEvents = [];
  const html = renderJob(view, NOW);
  assert.match(html, /limits<\/span><span class="v"><span class="mono dim">toolCalls 40<\/span> <span class="mono dim">costUsd \$2\.000<\/span> <span class="tag warn" title="Bash `npm test` ×5 in a row">repeat 5<\/span><\/span>/);
  assert.match(html, /<span class="tag warn">runaway<\/span>/);
  assert.match(html, /Stopped at a limit<\/div><p class="dnote"><span class="mono">Bash `npm test` ×5 in a row<\/span><\/p>/);
  store.focusRun(null);
});

test("an allowlisted sandbox says how many hosts it allows; runs linked by apply --resolve link to each other", () => {
  const view: JobViewState = { cpNote: "", tab: "graph", selectedAi: 0, reviewAi: null, zoom: 1, logQuery: "", logTypes: new Set(["agent"]), logLimit: 600, follow: true, motion: false };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([agent("fix", "Plan", "done", { sandbox: { kind: "container", engine: "docker", image: "img:1", network: "allowlist", allow: ["api.anthropic.com", "claude.ai"] } } as Partial<AgentView>)], {
    resolvedBy: [{ runId: "20260101-010101-bbbbbb", agentId: 2 }],
  });
  store.runEvents = [];
  const html = renderJob(view, NOW);
  assert.match(html, /<span class="tag" title="api\.anthropic\.com, claude\.ai">2 hosts allowed<\/span>/);
  assert.match(html, /<a class="rlink" href="#\/job\/20260101-010101-bbbbbb">.*agent #2(&#39;|')s conflict resolved by/s);
  store.focusRun(null);
});

test("a dry run is tagged as one in its header", () => {
  const view: JobViewState = { cpNote: "", tab: "graph", selectedAi: null, reviewAi: null, zoom: 1, logQuery: "", logTypes: new Set(["agent"]), logLimit: 600, follow: true, motion: false };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([], { dry: true });
  store.runEvents = [];
  assert.match(renderJob(view, NOW), /<span class="tag dry"[^>]*>dry run<\/span>/);
  store.focusRun(null);
});

test("a run with untrusted input has a trust line in its header: what said so, its args, the agents' tier, an alarm without a sandbox", async () => {
  const { trustLine } = await import("../web/src/views/job.ts");
  assert.equal(trustLine({}), "");
  const line = trustLine({ untrustedInput: { why: "trigger:gh", args: ["issue", "body"], approve: true, permissions: "edit", sandboxed: false } });
  assert.match(line, /^<p class="trust-line"><span class="tag input-untrusted" title="[^"]+">untrusted input<\/span>/);
  assert.match(line, /<span class="mono">trigger:gh<\/span>.*<span>args: issue, body<\/span>.*<span>agents edit<\/span>/);
  assert.match(line, /<span class="unboxed" title="[^"]+">no sandbox<\/span>.*<span>writes ask first<\/span>/);
  // Before its worker started: no tier, no sandbox word; read-only agents have nothing to ask.
  const pending = trustLine({ untrustedInput: { why: "--untrusted-input", args: ["*"], approve: true, permissions: null, sandboxed: null } });
  assert.match(pending, /<span>args: all args<\/span><\/p>$/);
  assert.doesNotMatch(pending, /agents|sandbox|ask/);
  const view: JobViewState = { cpNote: "", tab: "graph", selectedAi: null, reviewAi: null, zoom: 1, logQuery: "", logTypes: new Set(["agent"]), logLimit: 600, follow: true, motion: false };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([], { untrustedInput: { why: "trigger:gh", args: ["issue"], approve: true, permissions: "read", sandboxed: true } });
  store.runEvents = [];
  assert.match(renderJob(view, NOW), /<p class="trust-line">.*<span>agents read<\/span>.*<span>sandboxed<\/span><\/p>/);
  store.focusRun(null);
});

test("a run whose body ran in a strict script context says so on the trust line, alone or after its untrusted input", async () => {
  const { trustLine } = await import("../web/src/views/job.ts");
  const alone = trustLine({ scriptContext: "strict" });
  assert.match(alone, /^<p class="trust-line"><span class="tag script-strict" title="[^"]*not a security boundary">strict script context<\/span><\/p>$/);
  const both = trustLine({ scriptContext: "strict", untrustedInput: { why: "trigger:gh", args: ["*"], approve: true, permissions: "read", sandboxed: true } });
  assert.match(both, /untrusted input<\/span>.*<span>sandboxed<\/span><span class="sep">·<\/span><span class="tag script-strict"[^>]*>strict script context<\/span><\/p>$/);
  const view: JobViewState = { cpNote: "", tab: "graph", selectedAi: null, reviewAi: null, zoom: 1, logQuery: "", logTypes: new Set(["agent"]), logLimit: 600, follow: true, motion: false };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([], { scriptContext: "strict" });
  store.runEvents = [];
  assert.match(renderJob(view, NOW), /<p class="trust-line"><span class="tag script-strict"/);
  store.run = detail([]);
  assert.doesNotMatch(renderJob(view, NOW), /script-strict/);
  store.focusRun(null);
});

test("a pinned run, and one whose transcripts odw gc trimmed, say so in the header", () => {
  const view: JobViewState = { cpNote: "", tab: "graph", selectedAi: null, reviewAi: null, zoom: 1, logQuery: "", logTypes: new Set(["agent"]), logLimit: 600, follow: true, motion: false };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([], { pinned: { at: 1, by: "cli:ada" }, trimmed: { at: 2, files: 3 } });
  store.runEvents = [];
  const html = renderJob(view, NOW);
  assert.match(html, /<span class="tag pinned" title="odw gc skips this run \(odw pin 20260101-000000-aaaaaa --remove undoes it\)\npinned by cli:ada">pinned<\/span>/);
  assert.match(html, /<span class="tag trimmed" title="odw gc removed 3 transcript and stderr file\(s\); events, results and diffs stay">transcripts trimmed<\/span>/);
  store.run = detail([]);
  const plain = renderJob(view, NOW);
  assert.doesNotMatch(plain, /tag pinned|tag trimmed/);
  store.focusRun(null);
});

test("a run whose CLI or model changed since the workflow's last run says so in a chip that lists it", async () => {
  const { driftChip } = await import("../web/src/views/job.ts");
  const html = driftChip({ drift: { since: "20260101-000000-zzzzzz", changes: [
    { kind: "cli", adapter: "claude", from: "2.1.302", to: "2.1.330" },
    { kind: "model", adapter: "codex", label: "review", from: null, to: "gpt-6" },
  ] } });
  assert.match(html, /<span class="tag drift" title="since 20260101-000000-zzzzzz\nclaude CLI 2\.1\.302 → 2\.1\.330\nreview on codex: model default → gpt-6">2 changes since last run<\/span>/);
  assert.equal(driftChip({}), "");
});

test("a workflow's memory lists newest first, strikes the stale entries, and offers a prune only when some are stale", async () => {
  const { memorySection } = await import("../web/src/views/workspace.ts");
  const { store } = await import("../web/src/store.ts");
  const at = new Date().toISOString();
  store.memories.set("mem-wf", [
    { id: 1, text: "Fixtures are <generated>", kind: "correction", paths: ["tests/data/**"], commit: "abc", run: "20260101-000000-aaaaaa", agent: "fix", at, stale: false },
    { id: 2, text: "Lint with --cache", kind: "lesson", paths: ["README.md"], commit: "abc", run: null, at, stale: true },
  ]);
  const html = memorySection("mem-wf");
  assert.ok(html.indexOf('data-key="mem-2"') < html.indexOf('data-key="mem-1"'), "newest first");
  assert.match(html, /<li class="mem stale"[^>]*data-key="mem-2">/);
  assert.match(html, /Fixtures are &lt;generated&gt;/);
  assert.match(html, /href="#\/job\/20260101-000000-aaaaaa">20260101-000000-aaaaaa<\/a> · fix/);
  assert.match(html, /1 of 2 recalled/);
  assert.match(html, /odw memory prune mem-wf --stale/);
  store.memories.set("mem-wf", [{ id: 1, text: "x", kind: "note", paths: [], commit: null, run: null, at, stale: false }]);
  assert.doesNotMatch(memorySection("mem-wf"), /prune/);
  store.memories.set("mem-wf", []);
  assert.equal(memorySection("mem-wf"), "");
});

test("who did what (ODW extension): the Job header says who launched it; Jobs filters mine and team; a decision names who", () => {
  const prevRuns = store.runs;
  const prevCaps = store.capabilities;
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: null,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([], { state: "done", launchedBy: "trigger:gh" });
  assert.match(renderJob(view, NOW), /<p class="dim launched-by">launched by trigger:gh<\/p>/);
  store.run = detail([], { state: "done" });
  assert.doesNotMatch(renderJob(view, NOW), /launched by/);
  store.focusRun(null);

  store.runs = [
    summary({ runId: "r-mine", state: "done", launchedBy: "Alice" }),
    summary({ runId: "r-bob", state: "done", launchedBy: "bob" }),
    summary({ runId: "r-old", state: "done" }),
  ];
  // No `you` (an unnamed token, an older server): no owner chips, every run.
  store.capabilities = { writable: false, you: null };
  const all = renderJobs({ filter: "all", query: "", limit: 100 }, NOW);
  assert.doesNotMatch(all, /data-jobs-owner/);
  assert.match(all, /r-mine · Alice/, "a row says who launched it");
  store.capabilities = { writable: false, you: "alice" };
  const owners = renderJobs({ filter: "all", query: "", limit: 100 }, NOW);
  assert.match(owners, /data-jobs-owner="mine"[^>]*>Mine<span class="n">1<\/span>/);
  assert.match(owners, /data-jobs-owner="team"[^>]*>Team<span class="n">2<\/span>/);
  const mine = renderJobs({ filter: "all", owner: "mine", query: "", limit: 100 }, NOW);
  assert.ok(mine.includes("h-r-mine") && !mine.includes("h-r-bob") && !mine.includes("h-r-old"));
  const team = renderJobs({ filter: "all", owner: "team", query: "", limit: 100 }, NOW);
  assert.ok(!team.includes("h-r-mine") && team.includes("h-r-bob") && team.includes("h-r-old"));
  store.runs = prevRuns;
  store.capabilities = prevCaps;

  const events = [
    { type: "checkpoint_requested", ts: NOW - 10, checkpointId: 1, title: "Ship?" },
    { type: "checkpoint_resolved", ts: NOW - 5, checkpointId: 1, approved: true, note: null, by: "link", who: "bob" },
  ];
  const gate = withCheckpoints(detail([], { state: "done" }), events).agents.at(-1)!;
  assert.deepEqual(gate.decision, { approved: true, note: null, by: "link", who: "bob" });
});

test("the spend trend buckets a fortnight by local day, stacks the top workflows, leaves dry runs out and compares with the fortnight before", async () => {
  const { spendTrend, renderTrend } = await import("../web/src/components/trend.ts");
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const now = Math.floor(noon.getTime() / 1000);
  const day = 86400;
  const run = (name: string, ago: number, costUsd: number, extra: Record<string, unknown> = {}) =>
    ({ runId: `r-${name}-${ago}-${costUsd}`, name, state: "done", createdAt: now - ago * day, usage: { costUsd }, counts: { agents: 1 }, ...extra }) as never;
  const runs = [
    run("a", 0, 2), run("b", 0, 1), run("c", 1, 0.5), run("d", 1, 0.25), run("e", 2, 0.1),
    run("a", 0, 100, { dry: true }),
    run("a", 20, 1), // the fortnight before
    run("a", 40, 9), // older still
  ];
  const tr = spendTrend(runs, now)!;
  assert.equal(tr.by, "cost");
  assert.equal(tr.days.length, 14);
  assert.equal(tr.days[13].total, 3);
  assert.equal(tr.days[13].runs, 2);
  assert.ok(Math.abs(tr.total - 3.85) < 1e-9);
  assert.equal(tr.previous, 1);
  assert.deepEqual(tr.top, ["a", "b", "c"]);
  assert.ok(Math.abs((tr.days[12].parts.get("") ?? 0) - 0.25) < 1e-9, "d falls into the rest");
  const html = renderTrend(runs, now);
  assert.match(html, /class="tr-col today"/);
  assert.match(html, /↑ 285%/);
  assert.equal(spendTrend([run("a", 0, 5, { dry: true })], now), null);
  assert.equal(renderTrend([], now), "");
});

test("an agent's question: a card to answer it, its own ticket on Activity, and an unanswered one in the drawer", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "graph",
    selectedAi: 0,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  const question = {
    agentId: 1,
    label: "cache",
    adapter: "claude",
    questions: [{ question: "Which <db>?", header: "Database", options: ["SQLite", "Postgres"] }],
  };
  const prevCaps = store.capabilities;
  store.focusRun("20260101-000000-aaaaaa");
  store.capabilities = { ...store.capabilities, writable: true };
  store.run = detail([agent("cache", "Plan", "running", { adapter: "claude" })], {
    state: "waiting",
    pendingCheckpoints: [{ checkpointId: 1, title: "cache asks: Which <db>?", payload: { answer: "" }, since: NOW - 30, question }],
  });
  store.runEvents = [];
  let html = renderJob(view, NOW);
  assert.match(html, /class="card checkpoint question marked"/);
  assert.match(html, /Agent question · cache:1 · claude/);
  assert.match(html, /<span class="tag">Database<\/span><span class="q">Which &lt;db&gt;\?<\/span>/);
  assert.match(html, /<button class="opt" data-cp-option="SQLite">SQLite<\/button><button class="opt" data-cp-option="Postgres">Postgres<\/button>/);
  assert.match(html, /placeholder="Your answer — the agent runs again, told it"/);
  assert.match(html, /data-cp="approve" data-cp-id="1">Answer<\/button>/);
  assert.match(html, /data-cp="reject" data-cp-id="1">Decline<\/button>/);
  assert.ok(!html.includes("Edit before approving"), "answered with the note, not a payload edit");

  // Failed with needs_input: the drawer lists what it asked, and the reason has words.
  store.run = detail([agent("cache", "Plan", "failed", { adapter: "claude", failureReason: "needs_input", questions: ["Which <db>? (options: SQLite / Postgres)"] })]);
  html = renderJob(view, NOW);
  assert.match(html, /Asked, unanswered<\/div><ul class="misses asked"><li>Which &lt;db&gt;\? \(options: SQLite \/ Postgres\)<\/li><\/ul>/);
  assert.equal(reasonLabel("needs_input"), "needs input");
  store.focusRun(null);
  store.capabilities = prevCaps;

  // Activity: a question reads as one and is answered; a run whose agent's question went unanswered says so.
  const prev = store.runs;
  store.runs = [
    summary({
      runId: "r-ask",
      name: "cache-wf",
      state: "waiting",
      waiting: { checkpointId: 1, title: "cache asks: Which <db>?", since: NOW - 60, question: { agentId: 1, label: "cache", adapter: "claude" } },
    }),
    summary({ runId: "r-ni", name: "wf-ni", state: "failed", updatedAt: NOW - 100, needsInput: 1, counts: { agents: 1, running: 0, done: 0, failed: 1, stale: 0 } }),
  ];
  const activity = renderActivity(NOW);
  assert.match(activity, /class="ticket waiting"[\s\S]*?an agent has a question — cache asks: Which &lt;db&gt;\?[\s\S]*?>Answer<\/a>/);
  assert.match(activity, /class="ticket failed"[\s\S]*?failed · 1 agent\(s\) asked a question nobody answered/);
  store.runs = prev;
});

test("Activity flags a day's run whose agents ran destructive git, offering odw restore --check when a snapshot can put the tree back", () => {
  const prev = store.runs;
  store.runs = [
    summary({ runId: "r-git", name: "fixer", state: "done", updatedAt: NOW - 50, destructiveGit: { agents: 2, restorable: true } }),
    summary({ runId: "r-git2", name: "pusher", state: "done", updatedAt: NOW - 60, destructiveGit: { agents: 1, restorable: false } }),
    summary({ runId: "r-old-git", name: "old", state: "done", updatedAt: NOW - 200_000, destructiveGit: { agents: 1, restorable: true } }),
  ];
  const html = renderActivity(NOW);
  assert.match(html, /data-key="nt-r-git"[\s\S]*?2 agent\(s\) ran a destructive git command[\s\S]*?data-copy="odw restore r-git --check"/);
  assert.match(html, /data-key="nt-r-git2"[\s\S]*?href="#\/job\/r-git2">Review</);
  assert.ok(!html.includes("nt-r-old-git"), "only the last day's");
  assert.match(html, /<span class="n">2<\/span>/);
  store.runs = prev;
});

test("Review (ODW extension): kept diffs riskiest first, each reason shown; marks only where writable; Activity's Needs you counts the queue", async () => {
  const { renderReview } = await import("../web/src/views/review.ts");
  const prevReview = store.review;
  const prevAll = store.reviewAll;
  const prevCaps = store.capabilities;
  const entry = (over: Record<string, unknown>) => ({
    runId: "r-1",
    run: "fixer",
    runState: "done",
    createdAt: NOW - 500,
    agentId: 2,
    label: "fix <auth>",
    phase: "Fix",
    adapter: "claude",
    agentState: "done",
    finishedAt: NOW - 400,
    changes: { files: 3, insertions: 40, deletions: 5, truncated: false },
    branch: null,
    categories: ["ci", "auth"],
    score: 7,
    risk: "high" as const,
    factors: [
      { key: "ci", points: 3, why: "touches CI: .github/workflows/ci.yml" },
      { key: "auth", points: 3, why: "touches auth or security code: src/auth.ts" },
      { key: "expect-retry", points: 1, why: "met its expect only after 1 retry" },
      { key: "checked", points: -1, why: "its expect.command check passed" },
    ],
    review: null,
    ...over,
  });
  store.reviewAll = false;
  store.review = { entries: [entry({}), entry({ runId: "r-0", agentId: 0, label: "tidy", score: 0, risk: "low", factors: [], categories: [] })], open: 2, marked: 1 };
  store.capabilities = { writable: true };
  const html = renderReview();
  assert.match(html, /What to look at <em>first<\/em>/);
  assert.match(html, /data-review-all="0">To review<span class="num">2<\/span>/);
  assert.match(html, /data-review-all="1">All<span class="num">3<\/span>/);
  assert.ok(html.indexOf('data-key="rq-r-1/2"') < html.indexOf('data-key="rq-r-0/0"'), "the order the server ranked");
  assert.match(html, /class="card rq-item high"[\s\S]*?<span class="rq-score num">7<\/span><span class="rq-level">high<\/span>/);
  assert.equal(count(html.slice(0, html.indexOf('data-key="rq-r-0/0"')), /<i class="on"><\/i>/g), 7, "a mark per point");
  assert.match(html, /<b>fix &lt;auth&gt;<\/b>/, "labels are escaped");
  assert.match(html, /<span class="pt num">\+3<\/span><span class="why">touches CI: \.github\/workflows\/ci\.yml<\/span>/);
  assert.match(html, /<li class="for"><span class="pt num">-1<\/span><span class="why">its expect\.command check passed<\/span>/);
  assert.match(html, /href="#\/job\/r-1\/changes" data-review-open="r-1\/2"/);
  assert.match(html, /data-review-mark="r-1\/2" data-state="reviewed"/);
  assert.match(html, /data-review-mark="r-1\/2" data-state="dismissed"/);
  assert.match(html, /data-copy="odw apply r-1 --agent 2 --check"/);
  assert.match(html, /Small, and nothing on record against it\./, "an entry without factors says so");

  // Read-only: no marks, the command still there.
  store.capabilities = { writable: false };
  const ro = renderReview();
  assert.doesNotMatch(ro, /data-review-mark/);
  assert.match(ro, /data-copy="odw apply r-1 --agent 2 --check"/);

  // Under All, a marked entry says who marked it, and can go back on the queue.
  store.capabilities = { writable: true };
  store.reviewAll = true;
  store.review = { entries: [entry({ review: { ts: NOW - 60, agentId: 2, state: "applied", by: "cli:dan", via: "apply" } })], open: 0, marked: 1 };
  const all = renderReview();
  assert.match(all, /Nothing <em>waits<\/em> for review/);
  assert.match(all, /class="card rq-item high dealt"/);
  assert.match(all, /<span class="rq-mark applied">applied · cli:dan · /);
  assert.match(all, /data-review-mark="r-1\/2" data-state="open">Back on the queue/);

  // Nothing on record: the empty state.
  store.review = { entries: [], open: 0, marked: 0 };
  assert.match(renderReview(), /Nothing to review/);

  // Activity: one ticket for the queue, tinted by its riskiest entry, counted in Needs you.
  const prevRuns = store.runs;
  store.runs = [summary({ state: "done" })];
  store.review = { entries: [entry({})], open: 3, marked: 0 };
  const activity = renderActivity(NOW);
  assert.match(activity, /class="ticket rq-ticket high" data-key="nt-review"[\s\S]*?3 kept diffs wait for review — the riskiest is high[\s\S]*?href="#\/review"/);
  assert.match(activity, /<span class="n">1<\/span>/);
  store.review = { entries: [], open: 0, marked: 2 };
  assert.doesNotMatch(renderActivity(NOW), /nt-review/, "nothing open, no ticket");

  store.runs = prevRuns;
  store.review = prevReview;
  store.reviewAll = prevAll;
  store.capabilities = prevCaps;
});

test("Outcomes (ODW extension): the Review page's card — applied of kept, a stacked column per week, what moved, a line per workflow", async () => {
  const { outcomesCard, renderReview } = await import("../web/src/views/review.ts");
  const row = (key: string, over: Record<string, unknown> = {}) => ({
    key, runs: 0, runsDone: 0, runsFailed: 0, runReasons: {}, replays: 0, agents: 0, agentsFailed: 0, agentReasons: {},
    kept: 0, applied: 0, dismissed: 0, reviewed: 0, left: 0, acceptRate: null, retries: 0, retried: 0, handedOff: 0, resolved: 0,
    reworked: 0, reworkRate: null, unmet: 0, untouched: 0, outOfScope: 0, costUsd: null, tokens: 0, estimated: false,
    costPerApplied: null, tokensPerApplied: null, ...over,
  });
  const o = {
    version: 1 as const,
    since: NOW - 30 * 86_400,
    until: NOW,
    workflow: null,
    total: row("total", { runs: 6, runsFailed: 2, kept: 4, applied: 2, dismissed: 1, left: 1, acceptRate: 0.5, costUsd: 5, costPerApplied: 2.5 }),
    previous: row("previous", { runs: 6 }),
    shifts: [{ metric: "acceptRate" as const, before: 0.8, after: 0.5, direction: "worse" as const }],
    weeks: [
      { ...row("2026-09-28"), start: NOW - 21 * 86_400 },
      { ...row("2026-10-05", { runs: 3, kept: 2, applied: 2 }), start: NOW - 14 * 86_400 },
      { ...row("2026-10-12", { runs: 3, kept: 2, dismissed: 1, left: 1 }), start: NOW - 7 * 86_400 },
    ],
    workflows: [row("fix <it>", { runs: 4, runsFailed: 1, kept: 3, applied: 1, acceptRate: 1 / 3, costPerApplied: 4 }), row("docs", { runs: 2, kept: 1, applied: 1, acceptRate: 1, tokensPerApplied: 1200 })],
    adapters: [],
    models: [],
  };
  const html = outcomesCard(o);
  assert.match(html, /class="card oc-card" data-key="outcomes"/);
  assert.match(html, /Outcomes · last 30 days/);
  assert.match(html, /<span class="v num">2<span class="of">\/4<\/span><\/span><span class="k">kept diffs applied<\/span>/);
  assert.match(html, /<span class="v num">50%<\/span><span class="k">applied share<\/span>/);
  assert.match(html, /class="rs bad"><span class="v num">2<span class="of">\/6<\/span>/, "failed runs in alarm");
  assert.match(html, /<span class="v num">\$2\.500<\/span><span class="k">per applied change<\/span>/);
  assert.equal(count(html, /<li class="oc-week/g), 3);
  assert.match(html, /<li class="oc-week idle"/, "a week without runs keeps its place");
  assert.match(html, /<i class="ap" style="--h:1\.0000"><\/i>/, "the fullest week fills its column");
  assert.match(html, /<i class="dm" style="--h:0\.5000"><\/i><i class="lf" style="--h:0\.5000"><\/i>/);
  assert.match(html, /<span class="tag warn">applied share 80% → 50%<\/span>/);
  assert.match(html, /<td class="nm">fix &lt;it&gt;<\/td><td class="num">4<\/td><td class="num bad">1<\/td><td class="num">1\/3<\/td><td class="num">33%<\/td><td class="num">\$4\.000<\/td>/);
  assert.match(html, /<td class="nm">docs<\/td>[\s\S]*?<td class="num">1\.2k tokens<\/td>/, "tokens when no dollars were reported");
  // Nothing to show: no card.
  assert.equal(outcomesCard(null), "");
  assert.equal(outcomesCard({ ...o, total: row("total") }), "");
  // On the page, above the queue — and above the empty state too.
  const prev = [store.review, store.outcomes];
  store.outcomes = o;
  store.review = { entries: [], open: 0, marked: 0 };
  const page = renderReview();
  assert.ok(page.indexOf('data-key="outcomes"') > 0 && page.indexOf('data-key="outcomes"') < page.indexOf("Nothing to review"));
  [store.review, store.outcomes] = prev as [typeof store.review, typeof store.outcomes];
});

test("fan-out health (ODW extension): a chip on the run's head, amber when one came back mostly null; a line in the logs", () => {
  const view: JobViewState = {
    cpNote: "",
    tab: "logs",
    selectedAi: null,
    reviewAi: null,
    zoom: 1,
    logQuery: "",
    logTypes: new Set(["agent", "phase", "log", "run"]),
    logLimit: 600,
    follow: true,
    motion: false,
  };
  const healthy = { call: "pipeline()" as const, phase: null, total: 4, ok: 4, failed: 0, null: 0, reasons: {}, at: NOW - 60 };
  const sick = { call: "parallel()" as const, phase: "Review", total: 10, ok: 3, failed: 6, null: 1, reasons: { rate_limit: 4, timeout: 2 }, required: 8, belowMinOk: true, at: NOW - 30 };
  store.focusRun("20260101-000000-aaaaaa");
  store.run = detail([], { fanOuts: [healthy] });
  store.runEvents = [];
  let html = renderJob(view, NOW);
  assert.match(html, /<span class="tag fanout" title="pipeline\(\) — 4\/4 ok">1 fan-out: 4\/4 ok<\/span>/);
  store.run = detail([], { fanOuts: [healthy, sick] });
  store.runEvents = [{ ts: NOW - 30, type: "fanout_done", call: "parallel()", phase: "Review", total: 10, ok: 3, failed: 6, null: 1, reasons: { rate_limit: 4, timeout: 2 }, required: 8, belowMinOk: true }];
  html = renderJob(view, NOW);
  assert.match(
    html,
    /<span class="tag fanout warn" title="pipeline\(\) — 4\/4 ok\nparallel\(\) · Review — 3\/10 ok · 6 failed \(rate_limit 4, timeout 2\) · 1 null · below minOk \(8 needed\)">2 fan-outs: 7\/14 ok<\/span>/,
  );
  assert.match(html, /<span class="msg">parallel\(\) · Review — 3\/10 ok · 6 failed \(rate_limit 4, timeout 2\) · 1 null · below minOk \(8 needed\)<\/span>/);
  store.run = detail([]);
  assert.doesNotMatch(renderJob(view, NOW), /tag fanout/, "no fan-outs, no chip");
  store.focusRun(null);
});
