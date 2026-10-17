#!/usr/bin/env node
/**
 * Seed a throwaway runs root + managed workflow dir with realistic fixtures so
 * the client can be exercised without launching real agents.
 *
 *   node web/demo-fixtures.mjs <runsRoot> <projectDir> [--live]
 *
 * Writes runs in the real on-disk layout (runs/<workflow-slug>/<runId>/ with
 * meta.json + status.json + events.jsonl [+ result.json/error.json]) and a few
 * `.odw/workflows/*.js` scripts so /api/workflows has content. Pure fs — no deps.
 *
 * `--live` then keeps a small fleet of simulated runs moving — agents start,
 * finish and occasionally fail, phases advance, runs complete and new ones
 * begin — with this process's pid as the "worker", so the dashboard shows real
 * running state (and, once you Ctrl-C, real staleness). For UI work and demos.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [, , runsRoot, projDir, mode] = process.argv;
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
    "code-review-swarm": "Map a pull request, review it from several angles in parallel, verify each finding, then summarize.",
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
  "code-review-swarm",
  descOf("code-review-swarm"),
  ["Map", "Review", "Verify", "Summarize"],
  `phase('Map')\nconst map = await agent(mapPrompt(args.pr), { schema: MAP })\n\nphase('Review')\nconst findings = await parallel(LENSES.map((lens) => () =>\n  agent(reviewPrompt(map, lens), { schema: FINDINGS, label: \`review:\${lens}\` })))\n\nphase('Verify')\nconst verified = await pipeline(findings.flat(), (f) => agent(verifyPrompt(f), { schema: VERDICT }))\n\nphase('Summarize')\nlog(\`\${verified.filter((v) => v.real).length} findings confirmed\`)\nreturn await agent(summaryPrompt(verified))`,
);
wf(
  "tournament",
  descOf("tournament"),
  ["Compete", "Judge"],
  `phase('Compete')\nconst solutions = await parallel(args.approaches.map((a) => () => agent(attemptPrompt(a))))\n\nphase('Judge')\nreturn await bracket(solutions, (x, y) => agent(judgePrompt(x, y)))`,
);

console.error(`seeded demo fixtures → runs:${runsRoot}  project:${projDir}`);

if (mode === "--live") startLive();

// ---------------------------------------------------------------------------
// --live: a deterministic-enough simulator writing the real on-disk layout.
// ---------------------------------------------------------------------------
function startLive() {
  const now = () => Date.now() / 1000;
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  const TEMPLATES = [
    {
      name: "deep-research",
      args: { question: "Which battery chemistries will ship in 2027 EVs?" },
      phases: [
        ["Plan", 1, ["claude"]],
        ["Search", 5, ["codex", "gemini"]],
        ["Extract", 5, ["claude"]],
        ["Vote", 3, ["claude", "codex"]],
        ["Report", 1, ["claude"]],
      ],
      result: { report: "Sodium-ion for entry trims; LFP stays dominant; semi-solid-state in two flagships.", sources: 14 },
    },
    {
      name: "code-review-swarm",
      args: { pr: 482 },
      phases: [
        ["Map", 1, ["codex"]],
        ["Review", 6, ["claude", "codex", "gemini"]],
        ["Verify", 4, ["codex"], [{ label: "npm test", dur: 4, exit: 0 }]],
        ["Summarize", 1, ["claude"]],
      ],
      result: { findings: 5, confirmed: 3, verdict: "request-changes" },
    },
    {
      name: "fan-out-reduce",
      args: { n: 8 },
      phases: [
        ["Draft", 8, ["gemini", "qwen"]],
        ["Synthesize", 1, ["claude"]],
      ],
      result: { best: "Draft #5", drafts: 8 },
    },
    {
      name: "tournament",
      args: { approaches: ["risk-first", "speed-first", "cost-first", "simplest"] },
      phases: [
        ["Compete", 4, ["claude", "codex"]],
        ["Judge", 3, ["claude"]],
      ],
      result: "Winner: risk-first (3–0 in the bracket).",
    },
  ];
  const LOGS = [
    "planner proposed 5 angles",
    "dedup: 3 overlapping sources merged",
    "schema ok after 1 retry",
    "budget: 41% of cap used",
    "worktree isolated · 3 files changed",
    "cache hit for an unchanged prompt",
  ];
  const live = new Map();

  /** A plausible saved value for an agent, by what its label says it did. */
  function valueFor(a) {
    const kind = a.label.split(":")[0];
    switch (kind) {
      case "plan":
        return { angles: ["chemistry roadmaps", "OEM announcements", "supply chain", "cost curves", "regulation"] };
      case "search":
        return { sources: 3 + Math.floor(Math.random() * 6), claims: ["LFP share rises in entry trims", "sodium-ion pilots ship in 2027"] };
      case "extract":
        return { claims: [{ text: "Two flagships adopt semi-solid-state cells", source: "maker-briefing-2026" }] };
      case "vote":
        return { verdict: Math.random() < 0.8 ? "supported" : "disputed", votes: [true, true, Math.random() < 0.5] };
      case "review":
        return { findings: [{ title: "Unchecked error on retry path", severity: "medium", file: "src/client.ts", line: 88 }] };
      case "verify":
        return { real: Math.random() < 0.7, reason: "Reproduced by reading the retry loop" };
      case "map":
        return { summary: "Adds retries with backoff to the HTTP client", files: ["src/client.ts", "src/retry.ts"] };
      default:
        return `Draft from ${a.adapter}: a concise answer for ${a.label}.`;
    }
  }

  function begin(tpl) {
    const created = now();
    const id = runId(created);
    const dir = join(runsRoot, slug(tpl.name), id);
    mkdirSync(dir, { recursive: true });
    const phases = tpl.phases.map(([title]) => ({ title }));
    writeJson(join(dir, "meta.json"), {
      runId: id, script: `/demo/${tpl.name}.js`, args: tpl.args, source: projDir, workflowName: tpl.name, createdAt: created,
    });
    const run = {
      tpl, id, dir, phases, phaseIx: -1, agents: [], nextAgentId: 0,
      status: { runId: id, state: "running", name: tpl.name, description: descOf(tpl.name) ?? "A simulated live run.", phases, pid: process.pid, updatedAt: created },
    };
    writeJson(join(dir, "status.json"), run.status);
    emit(run, { type: "run_started", name: tpl.name, args: tpl.args });
    live.set(id, run);
    enterPhase(run);
  }

  function emit(run, ev) {
    appendFileSync(join(run.dir, "events.jsonl"), JSON.stringify({ ts: now(), ...ev }) + "\n");
    run.status.updatedAt = now();
    writeJson(join(run.dir, "status.json"), run.status);
  }

  function enterPhase(run) {
    run.phaseIx++;
    const spec = run.tpl.phases[run.phaseIx];
    if (!spec) return finish(run);
    const [title, n, adapters, commands = []] = spec;
    emit(run, { type: "phase_started", phase: title });
    // exec() steps: a command node that settles on its own clock.
    for (const c of commands) {
      const commandId = (run.nextCommandId = (run.nextCommandId ?? -1) + 1);
      emit(run, { type: "command_started", commandId, label: c.label, phase: title, command: c.label });
      setTimeout(() => {
        const done = { commandId, label: c.label, phase: title, command: c.label, exitCode: c.exit, durationMs: c.dur * 1000 };
        emit(run, c.exit === 0 ? { type: "command_finished", ...done } : { type: "command_failed", ...done, error: `exit ${c.exit}` });
      }, c.dur * 1000);
    }
    const prefix = title.toLowerCase();
    run.pending = Array.from({ length: n }, (_, i) => ({
      label: n === 1 ? prefix : `${prefix}:${i + 1}`, phase: title, adapter: pick(adapters),
    }));
  }

  function finish(run) {
    const failed = run.agents.some((a) => a.state === "failed") && Math.random() < 0.25;
    if (failed) {
      writeJson(join(run.dir, "error.json"), { error: "synthesis rejected: 2 of 3 votes missing", stack: "WorkflowError: synthesis rejected\n    at Report (deep-research.js:41:9)" });
      run.status.state = "failed";
      emit(run, { type: "run_failed" });
    } else {
      writeJson(join(run.dir, "result.json"), { value: run.tpl.result });
      run.status.state = "done";
      emit(run, { type: "run_finished" });
    }
    live.delete(run.id);
    setTimeout(() => begin(pick(TEMPLATES)), 4000 + Math.random() * 5000);
  }

  function step(run) {
    const t = now();
    for (const a of run.agents) {
      if (a.state !== "running" || t < a.doneAt) continue;
      if (Math.random() < 0.07) {
        a.state = "failed";
        emit(run, { type: "agent_failed", agentId: a.agentId, label: a.label, phase: a.phase, error: "exit 1 · malformed JSON under schema (2 attempts)" });
      } else {
        a.state = "done";
        const attempts = Math.random() < 0.15 ? 2 : 1;
        mkdirSync(join(run.dir, "agents"), { recursive: true });
        writeJson(join(run.dir, "agents", `${a.agentId}.json`), {
          agentId: a.agentId, key: `demo-${a.agentId}`, label: a.label, phase: a.phase, adapter: a.adapter,
          attempts, startedAt: a.startedAt, finishedAt: now(), value: valueFor(a),
        });
        emit(run, { type: "agent_finished", agentId: a.agentId, label: a.label, phase: a.phase, adapter: a.adapter, attempts, saved: true });
      }
    }
    const running = run.agents.filter((a) => a.state === "running").length;
    if (run.pending.length && running < 4 && Math.random() < 0.65) {
      const a = run.pending.shift();
      Object.assign(a, { state: "running", agentId: run.nextAgentId++, startedAt: t, doneAt: t + 3 + Math.random() * 11 });
      run.agents.push(a);
      emit(run, { type: "agent_started", agentId: a.agentId, label: a.label, phase: a.phase, adapter: a.adapter });
    }
    if (Math.random() < 0.05) emit(run, { type: "log", message: pick(LOGS) });
    const phase = run.tpl.phases[run.phaseIx]?.[0];
    const inPhase = run.agents.filter((a) => a.phase === phase);
    if (!run.pending.length && inPhase.length && inPhase.every((a) => a.state !== "running")) enterPhase(run);
  }

  begin(TEMPLATES[0]);
  setTimeout(() => begin(TEMPLATES[1]), 2500);
  setTimeout(() => begin(TEMPLATES[2]), 6000);
  setInterval(() => {
    for (const run of [...live.values()]) step(run);
  }, 650);
  console.error(`live simulation running (pid ${process.pid}) — Ctrl-C to stop`);
}
