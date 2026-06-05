#!/usr/bin/env node
/**
 * Seed a throwaway runs root + managed workflow dir with realistic fixtures so
 * the read-only client can be exercised without launching real agents.
 *
 *   node web/demo-fixtures.mjs <runsRoot> <projectDir>
 *
 * Writes runs in the real on-disk layout (runs/<workflow-slug>/<runId>/ with
 * meta.json + status.json + events.jsonl [+ result.json/error.json]) and a few
 * `.odw/workflows/*.js` scripts so /api/workflows has content. Pure fs — no deps.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [, , runsRoot, projDir] = process.argv;
if (!runsRoot || !projDir) {
  console.error("usage: demo-fixtures.mjs <runsRoot> <projectDir>");
  process.exit(2);
}

const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "_workflow";
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));
let clock = Math.floor(Date.now() / 1000) - 6000;
const t = (dt = 1) => (clock += dt);

function runId(when) {
  const d = new Date(when * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${stamp}-${rand}`;
}

function makeRun({ name, state, phases, agents, args, result, error, pid }) {
  const created = t(120);
  const id = runId(created);
  const dir = join(runsRoot, slug(name), id);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "meta.json"), {
    runId: id,
    script: `/demo/${name}.js`,
    args: args ?? null,
    source: projDir,
    workflowName: name,
    createdAt: created,
  });
  const status = { runId: id, state, name, description: descOf(name), phases, updatedAt: created + 1 };
  if (pid) status.pid = pid;
  writeJson(join(dir, "status.json"), status);

  const ev = [];
  let ts = created;
  ev.push({ ts: (ts += 1), type: "run_started", name, args: args ?? null });
  const byPhase = {};
  for (const a of agents) (byPhase[a.phase] ??= []).push(a);
  for (const ph of phases.map((p) => p.title)) {
    if (!byPhase[ph]) continue;
    ev.push({ ts: (ts += 1), type: "phase_started", phase: ph });
    for (const a of byPhase[ph]) {
      ev.push({ ts: (ts += 1), type: "agent_started", label: a.label, phase: ph, adapter: a.adapter });
    }
    for (const a of byPhase[ph]) {
      if (a.state === "running") continue;
      if (a.state === "failed") {
        ev.push({ ts: (ts += a.dur ?? 5), type: "agent_failed", label: a.label, phase: ph, error: a.error });
      } else {
        ev.push({
          ts: (ts += a.dur ?? 20),
          type: "agent_finished",
          label: a.label,
          phase: ph,
          adapter: a.adapter,
          attempts: a.attempts ?? 1,
        });
      }
    }
  }
  if (state === "done") ev.push({ ts: (ts += 2), type: "run_finished" });
  if (state === "failed") ev.push({ ts: (ts += 2), type: "run_failed" });
  if (state === "stopped") ev.push({ ts: (ts += 2), type: "run_stopped", by: "user" });
  for (const e of ev) appendFileSync(join(dir, "events.jsonl"), JSON.stringify(e) + "\n");

  if (result !== undefined) writeJson(join(dir, "result.json"), { value: result });
  if (error) writeJson(join(dir, "error.json"), error);
  return id;
}

function descOf(name) {
  return {
    "deep-research": "Fan-out web research that cross-checks cited claims by vote and returns a sourced report.",
    "agent-daily-digest": "Pull channels, summarize, and verify a daily digest.",
    routing: "Classify the request, route it to the matching specialist, then grade the result.",
    "fan-out-reduce": "Draft N answers in parallel, then synthesize the single best one.",
    tournament: "N agents attempt a task with different approaches; a pairwise bracket picks a winner.",
  }[name] ?? null;
}

const A = (label, phase, state, adapter, extra = {}) => ({ label, phase, state, adapter, ...extra });

// --- a live deep-research run (the hero) ---
makeRun({
  name: "deep-research",
  state: "running",
  args: { question: "How is solid-state battery tech progressing in 2026?", maxAngles: 4 },
  phases: [{ title: "Plan" }, { title: "Search" }, { title: "Extract" }, { title: "Vote" }, { title: "Report" }],
  agents: [
    A("plan", "Plan", "done", "claude", { dur: 22 }),
    A("search:angle-1", "Search", "done", "codex", { dur: 64 }),
    A("search:angle-2", "Search", "done", "codex", { dur: 71 }),
    A("search:angle-3", "Search", "done", "codex", { dur: 58 }),
    A("search:angle-4", "Search", "running", "gemini"),
    A("extract:angle-1", "Extract", "running", "claude"),
    A("extract:angle-2", "Extract", "failed", "claude", { error: "exit 1 · malformed JSON under schema", dur: 7 }),
    A("extract:angle-3", "Extract", "running", "claude"),
    A("vote:claim-1", "Vote", "running", "claude"),
    A("vote:claim-2", "Vote", "running", "claude"),
  ],
});

// --- a live agent-daily-digest run ---
makeRun({
  name: "agent-daily-digest",
  state: "running",
  phases: [{ title: "Discover" }, { title: "Extract" }, { title: "Synthesize" }, { title: "Verify" }],
  agents: [
    A("discover", "Discover", "done", "codex", { dur: 18 }),
    A("extract:slack-1", "Extract", "done", "codex", { dur: 30 }),
    A("extract:slack-2", "Extract", "running", "codex"),
    A("extract:slack-3", "Extract", "running", "codex"),
  ],
});

// --- a done tournament ---
makeRun({
  name: "tournament",
  state: "done",
  result: "Winner: approach C (risk-first). 7 attempts, 3 judging rounds.",
  phases: [{ title: "Compete" }, { title: "Judge" }],
  agents: [
    A("attempt:A", "Compete", "done", "claude", { dur: 40 }),
    A("attempt:B", "Compete", "done", "claude", { dur: 44 }),
    A("attempt:C", "Compete", "done", "claude", { dur: 39 }),
    A("judge:round-1", "Judge", "done", "claude", { dur: 20 }),
    A("judge:final", "Judge", "done", "claude", { dur: 18 }),
  ],
});

// --- a failed routing run ---
makeRun({
  name: "routing",
  state: "failed",
  error: { error: "executable not found: gemini", stack: "AdapterError: spawn gemini ENOENT\n  at route:specialist" },
  phases: [{ title: "Classify" }, { title: "Handle" }, { title: "Grade" }],
  agents: [
    A("classify", "Classify", "done", "codex", { dur: 8 }),
    A("route:specialist", "Handle", "failed", "gemini", { error: "exit 127 · executable not found: gemini", dur: 1 }),
  ],
});

// --- a done fan-out-reduce ---
makeRun({
  name: "fan-out-reduce",
  state: "done",
  result: { best: "Answer #3", drafts: 8 },
  phases: [{ title: "Draft" }, { title: "Synthesize" }],
  agents: [
    ...Array.from({ length: 6 }, (_, i) => A(`draft:${i + 1}`, "Draft", "done", "gemini", { dur: 15 + i })),
    A("synthesize", "Synthesize", "done", "gemini", { dur: 22 }),
  ],
});

// --- a stale deep-research (killed worker) ---
makeRun({
  name: "deep-research",
  state: "running",
  pid: 999999, // a pid that's provably gone → reconciles to "stale"
  phases: [{ title: "Plan" }, { title: "Search" }, { title: "Extract" }, { title: "Vote" }, { title: "Report" }],
  agents: [
    A("plan", "Plan", "done", "claude", { dur: 20 }),
    A("search:angle-1", "Search", "running", "claude"),
  ],
});

// --- managed-dir workflow scripts (for /api/workflows) ---
const wfDir = join(projDir, ".odw", "workflows");
mkdirSync(wfDir, { recursive: true });
const wf = (name, desc, phases, body) =>
  writeFileSync(
    join(wfDir, `${name}.js`),
    `export const meta = {\n  name: '${name}',\n  description: ${JSON.stringify(desc)},\n  phases: [${phases.map((p) => `{ title: '${p}' }`).join(", ")}],\n}\n\n${body}\n`,
  );

wf(
  "deep-research",
  descOf("deep-research"),
  ["Plan", "Search", "Extract", "Vote", "Report"],
  `phase('Plan')\nconst plan = await agent(planPrompt(args.question))\n\nphase('Search')\nconst hits = await parallel(plan.angles.map((a) => () => agent(searchPrompt(a))))\n\nphase('Extract')\nconst claims = await parallel(hits.map((h) => () => agent(extractPrompt(h))))\n\nphase('Vote')\nconst voted = await parallel(claims.map((c) => () => agent(votePrompt(c))))\n\nphase('Report')\nreturn await agent(reportPrompt(voted))`,
);
wf(
  "agent-daily-digest",
  descOf("agent-daily-digest"),
  ["Discover", "Extract", "Synthesize", "Verify"],
  `phase('Discover')\nconst channels = await agent(discoverPrompt)\n\nphase('Extract')\nconst items = await parallel(channels.map((c) => () => agent(extractPrompt(c))))\n\nphase('Synthesize')\nconst digest = await agent(synthPrompt(items))\n\nphase('Verify')\nreturn await parallel(digest.claims.map((c) => () => agent(verifyPrompt(c))))`,
);
wf(
  "routing",
  descOf("routing"),
  ["Classify", "Handle", "Grade"],
  `phase('Classify')\nconst kind = await agent(classifyPrompt(args.request))\n\nphase('Handle')\nconst out = await agent(specialists[kind].prompt)\n\nphase('Grade')\nreturn await agent(gradePrompt(out))`,
);
wf(
  "fan-out-reduce",
  descOf("fan-out-reduce"),
  ["Draft", "Synthesize"],
  `phase('Draft')\nconst drafts = await parallel(range(args.n).map((i) => () => agent(draftPrompt(i))))\n\nphase('Synthesize')\nreturn await agent(synthesizePrompt(drafts))`,
);
wf(
  "tournament",
  descOf("tournament"),
  ["Compete", "Judge"],
  `phase('Compete')\nconst solutions = await parallel(args.approaches.map((a) => () => agent(attemptPrompt(a))))\n\nphase('Judge')\nreturn await bracket(solutions, (x, y) => agent(judgePrompt(x, y)))`,
);

console.error(`seeded demo fixtures → runs:${runsRoot}  project:${projDir}`);
