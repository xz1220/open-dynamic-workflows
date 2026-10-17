/**
 * Pure rendering helpers of the web client — layout, charts, outline, matching.
 * They are string-in / string-out, so they run under node:test without a DOM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderJson } from "../web/src/components/json.ts";
import { transcriptEntries } from "../web/src/components/transcript.ts";
import { renderPulse } from "../web/src/components/pulse.ts";
import { highlightSource, outlineSource } from "../web/src/components/source.ts";
import { renderTimeline } from "../web/src/components/timeline.ts";
import { renderDag } from "../web/src/dag.ts";
import { applyRunsDelta, store } from "../web/src/store.ts";
import { renderActivity } from "../web/src/views/activity.ts";
import { renderJob, type JobViewState } from "../web/src/views/job.ts";
import { renderJobs } from "../web/src/views/jobs.ts";
import type { ActivityEvent, AgentView, RunDetail, RunSummary } from "../web/src/types.ts";
import { cronWords, esc, fmtDurSec, fmtTokens, fmtUsd, fuzzy, markHits } from "../web/src/util.ts";

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
  store.focusRun(null);
});
