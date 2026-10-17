import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig } from "../src/adapters/config.js";
import { waitFor } from "../src/runtime/launcher.js";
import { OdwRunSource } from "../src/runtime/odw-run-source.js";
import { RunStore } from "../src/runtime/run-store.js";
import {
  foldAgents,
  isProcessAlive,
  reconcileState,
  summarize,
  detail,
} from "../src/runtime/runs-view.js";
import { startServer, type ChatTurnRunner } from "../src/runtime/server.js";

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-serve-"));

const mockChatRunner = (prompts: string[] = []): ChatTurnRunner => async ({ prompt }, onChunk) => {
  prompts.push(prompt);
  onChunk(prompt.includes("finished with state") ? "mock codex follow-up" : "mock codex reply");
};

async function waitForChat(
  url: string,
  predicate: (session: Record<string, any>) => boolean,
  timeoutMs = 2500,
): Promise<Record<string, any>> {
  const started = Date.now();
  let last: Record<string, any> | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await fetch(url).then((r) => r.json());
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`chat did not reach expected state: ${JSON.stringify(last)}`);
}

/** One open `/api/stream` connection, read frame by frame. */
async function openSse(url: string) {
  const abort = new AbortController();
  const res = await fetch(`${url}/api/stream`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    /** Resolve the next `event` frame whose parsed data passes `predicate`. */
    async next(event: string, predicate: (data: any) => boolean = () => true, timeoutMs = 5000): Promise<any> {
      const seen: string[] = [];
      const deadline = setTimeout(() => abort.abort(), timeoutMs);
      try {
        for (;;) {
          let cut: number;
          while ((cut = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const name = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (name !== event || data === undefined) continue;
            seen.push(data.slice(0, 200));
            const parsed = JSON.parse(data);
            if (predicate(parsed)) return parsed;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          buf += decoder.decode(value, { stream: true });
        }
      } catch (err) {
        throw new Error(`no matching '${event}' frame (${(err as Error).message}); saw: ${seen.join(" | ")}`);
      } finally {
        clearTimeout(deadline);
      }
    },
    close: () => abort.abort(),
  };
}

/** Write a run directory: meta + status + a JSONL event stream. */
function seedRun(
  store: RunStore,
  fields: { name?: string; state?: string; pid?: number; phases?: { title: string }[] },
  events: Array<Record<string, unknown>>,
): string {
  const id = store.create({ script: "/demo/wf.js", args: { q: "hi" }, source: "/demo" });
  store.updateStatus(id, {
    state: fields.state ?? "running",
    name: fields.name ?? "demo",
    description: "a demo run",
    phases: fields.phases ?? [{ title: "Research" }],
    ...(fields.pid ? { pid: fields.pid } : {}),
  });
  for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  return id;
}

const A = (type: string, label: string, phase: string, ts: number, extra = {}) => ({
  ts,
  type,
  label,
  phase,
  ...extra,
});

test("foldAgents: opens a node per start, settles by label+phase, computes duration", () => {
  const agents = foldAgents([
    { ts: 100, type: "phase_started", phase: "Research" },
    A("agent_started", "alpha", "Research", 100),
    A("agent_started", "beta", "Research", 100.5),
    A("agent_finished", "alpha", "Research", 102.5, { adapter: "mock", attempts: 1 }),
    A("agent_failed", "beta", "Research", 101.5, { error: "boom" }),
  ]);
  assert.equal(agents.length, 2);
  const alpha = agents.find((a) => a.label === "alpha")!;
  const beta = agents.find((a) => a.label === "beta")!;
  assert.equal(alpha.state, "done");
  assert.equal(alpha.adapter, "mock");
  assert.equal(alpha.durationMs, 2500);
  assert.equal(beta.state, "failed");
  assert.equal(beta.error, "boom");
  assert.equal(beta.durationMs, 1000);
});

test("foldAgents: repeated label across rounds stays distinct (loop-until-dry honesty)", () => {
  const agents = foldAgents([
    A("agent_started", "finder", "Find", 1),
    A("agent_finished", "finder", "Find", 2),
    A("agent_started", "finder", "Find", 3), // a second round, same label
  ]);
  assert.equal(agents.length, 2);
  assert.equal(agents[0]!.state, "done");
  assert.equal(agents[1]!.state, "running");
});

test("reconcileState: terminal trusted; live pid stays running; dead pid → stale", async () => {
  assert.deepEqual(reconcileState("done", 999999), { state: "done", stale: false });
  // the test process itself is alive
  assert.deepEqual(reconcileState("running", process.pid), { state: "running", stale: false });
  assert.deepEqual(reconcileState("running", null), { state: "stale", stale: true });

  // spawn a process, let it exit, then its pid is provably gone
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid!;
  await new Promise<void>((r) => child.on("exit", () => r()));
  assert.equal(isProcessAlive(deadPid), false);
  assert.deepEqual(reconcileState("running", deadPid), { state: "stale", stale: true });

  // unknown pid (pending, pre-fork) is not stale
  assert.deepEqual(reconcileState("pending", null), { state: "pending", stale: false });
});

test("readEvents tolerates a torn final line (no per-line throw)", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: "/s" });
    appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 1, type: "log", message: "ok" }) + "\n");
    appendFileSync(store.eventsPath(id), '{"ts":2,"type":"agent_started","lab'); // partial write
    const events = store.readEvents(id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "log");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarize/detail derive counts, progress, and phase order from events", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = seedRun(
      store,
      { name: "deep-research", state: "running", pid: process.pid, phases: [{ title: "Research" }, { title: "Verify" }] },
      [
        { ts: 1, type: "phase_started", phase: "Research" },
        A("agent_started", "a", "Research", 1),
        A("agent_started", "b", "Research", 1),
        A("agent_finished", "a", "Research", 2, { adapter: "mock", attempts: 1 }),
        { ts: 3, type: "phase_started", phase: "Verify" },
        A("agent_started", "v", "Verify", 3),
      ],
    );

    const s = summarize(store, id);
    assert.equal(s.state, "running");
    assert.equal(s.counts.agents, 3);
    assert.equal(s.counts.running, 2);
    assert.equal(s.counts.done, 1);
    assert.equal(s.progress, 1 / 3);

    const d = detail(store, id);
    assert.deepEqual(d.phaseOrder, ["Research", "Verify"]);
    assert.equal(d.agents.length, 3);
    assert.equal(d.args && (d.args as { q: string }).q, "hi");

    // the run list (OdwRunSource) agrees with the uncached fold
    assert.deepEqual(new OdwRunSource(store).listSummaries(), [s]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarize/detail mark open agents stale when a running run has no live worker", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = seedRun(store, { name: "legacy", state: "running" }, [
      A("agent_started", "open", "Research", 1),
      A("agent_started", "settled", "Research", 2),
      A("agent_finished", "settled", "Research", 3, { adapter: "mock", attempts: 1 }),
    ]);

    const s = summarize(store, id);
    assert.equal(s.state, "stale");
    assert.equal(s.counts.running, 0);
    assert.equal(s.counts.stale, 1);
    assert.equal(s.counts.done, 1);

    const d = detail(store, id);
    assert.equal(d.agents.find((a) => a.label === "open")!.state, "stale");
    assert.equal(d.agents.find((a) => a.label === "settled")!.state, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: serves dashboard, run list, detail, control, and 404s", async () => {
  const root = tempRoot();
  const store = new RunStore(root);
  const id = seedRun(store, { name: "demo", state: "running", pid: process.pid }, [
    A("agent_started", "alpha", "Research", 1),
    A("agent_finished", "alpha", "Research", 2, { adapter: "mock", attempts: 1 }),
  ]);
  // Point the Claude source at an empty dir so this test sees only the ODW run.
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  try {
    const html = await fetch(`${handle.url}/`).then((r) => r.text());
    assert.match(html, /Open Dynamic Workflows/);

    const runs = await fetch(`${handle.url}/api/runs`).then((r) => r.json());
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, id);
    assert.equal(runs[0].provider, "odw");
    assert.equal(runs[0].counts.done, 1);

    const one = await fetch(`${handle.url}/api/runs/${id}`).then((r) => r.json());
    assert.equal(one.agents.length, 1);
    assert.equal(one.agents[0].label, "alpha");

    const missing = await fetch(`${handle.url}/api/runs/does-not-exist`);
    assert.equal(missing.status, 404);

    const events = await fetch(`${handle.url}/api/runs/${id}/events`).then((r) => r.json());
    assert.equal(events.length, 2);

    const ctl = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(ctl.status, 200);
    assert.equal(store.readControl(id), "stop");

    // Resume is written as `odw resume` writes it, so a run paused for a spent
    // quota (quotaWait) hears it as "go on now" — the dashboard's Resume now.
    const resumed = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    assert.equal(resumed.status, 200);
    assert.equal(store.readControl(id), "resume");

    const badCtl = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "explode" }),
    });
    assert.equal(badCtl.status, 400);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: events ?since/?tail window, x-total-count, and ETag/304 on polled reads", async () => {
  const root = tempRoot();
  const store = new RunStore(root);
  const id = seedRun(
    store,
    { name: "demo", state: "running", pid: process.pid },
    [1, 2, 3, 4, 5].map((ts) => ({ ts, type: "log", message: `m${ts}` })),
  );
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  const base = `${handle.url}/api/runs/${id}/events`;
  const messages = (evs: Array<{ message: string }>) => evs.map((e) => e.message);
  try {
    const all = await fetch(base);
    assert.equal(all.headers.get("x-total-count"), "5");
    assert.deepEqual(messages(await all.json()), ["m1", "m2", "m3", "m4", "m5"]);
    // ?since stays an event index (backward compatible), junk/negative → 0.
    assert.deepEqual(messages(await fetch(`${base}?since=3`).then((r) => r.json())), ["m4", "m5"]);
    assert.equal((await fetch(`${base}?since=-2`).then((r) => r.json())).length, 5);
    assert.equal((await fetch(`${base}?since=abc`).then((r) => r.json())).length, 5);
    // ?tail keeps only the last N; it composes with ?since.
    const tail = await fetch(`${base}?tail=2`);
    assert.equal(tail.headers.get("x-total-count"), "5", "the total is the whole stream, for the next ?since=");
    assert.deepEqual(messages(await tail.json()), ["m4", "m5"]);
    assert.deepEqual(await fetch(`${base}?tail=0`).then((r) => r.json()), []);
    assert.deepEqual(messages(await fetch(`${base}?since=1&tail=10`).then((r) => r.json())), ["m2", "m3", "m4", "m5"]);
    assert.equal((await fetch(`${base}?tail=-1`)).status, 400);
    assert.equal((await fetch(`${base}?tail=1.5`)).status, 400);

    // ETag: an unchanged resource answers If-None-Match with a bodiless 304 …
    for (const url of [base, `${handle.url}/api/runs/${id}`, `${handle.url}/api/runs`]) {
      const first = await fetch(url);
      const etag = first.headers.get("etag");
      assert.ok(etag, `${url} carries an ETag`);
      await first.arrayBuffer();
      const again = await fetch(url, { headers: { "if-none-match": etag! } });
      assert.equal(again.status, 304, url);
      assert.equal((await again.text()).length, 0);
    }
    // … and a changed one gets a fresh 200 with the new body.
    const etag = (await fetch(base)).headers.get("etag")!;
    appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 6, type: "log", message: "m6" }) + "\n");
    const changed = await fetch(base, { headers: { "if-none-match": etag } });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get("x-total-count"), "6");
    assert.equal((await changed.json()).length, 6);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: the SSE stream pushes a run turning stale when its worker is killed", async () => {
  const root = tempRoot();
  const store = new RunStore(root);
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const id = seedRun(store, { name: "demo", state: "running", pid: worker.pid! }, [A("agent_started", "alpha", "Research", 1)]);
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  const sse = await openSse(handle.url);
  try {
    const first = await sse.next("runs");
    assert.equal(first.find((r: any) => r.runId === id).state, "running");
    await new Promise<void>((r) => {
      worker.once("exit", () => r());
      worker.kill("SIGKILL");
    });
    // Same connection: the server must PUSH the change (no file changed, only the pid died).
    const runs = await sse.next("runs", (list) => list.some((r: any) => r.runId === id && r.state === "stale"));
    assert.deepEqual(runs.find((r: any) => r.runId === id).counts, { agents: 1, running: 0, done: 0, failed: 0, stale: 1 });
  } finally {
    sse.close();
    worker.kill("SIGKILL");
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: merges Claude Code runs into /api/runs (read-only: control → 409)", async () => {
  const root = tempRoot();
  const store = new RunStore(root);
  const odwId = seedRun(store, { name: "odw-job", state: "done" }, []);
  // A fake ~/.claude/projects with one terminal Claude run.
  const projects = join(root, "claude-projects");
  const sess = join(projects, "-tmp-proj", "sess1", "workflows");
  mkdirSync(sess, { recursive: true });
  writeFileSync(
    join(sess, "wf_abc.json"),
    JSON.stringify({ runId: "wf_abc", status: "completed", workflowName: "cc-job", startTime: 1780000000000, durationMs: 1000, workflowProgress: [] }),
  );
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: projects, claudeJobsScope: "all" });
  try {
    const runs = await fetch(`${handle.url}/api/runs`).then((r) => r.json());
    assert.equal(runs.length, 2); // ODW + Claude, merged
    const cc = runs.find((r: { runId: string }) => r.runId === "cc-wf_abc");
    const odw = runs.find((r: { runId: string }) => r.runId === odwId);
    assert.ok(cc && odw);
    assert.equal(cc.provider, "claude");
    assert.equal(odw.provider, "odw");

    // detail routes to the Claude source
    const det = await fetch(`${handle.url}/api/runs/cc-wf_abc`).then((r) => r.json());
    assert.equal(det.name, "cc-job");

    // control on a Claude run is refused with 409 (read-only), never mutating anything
    const ctl = await fetch(`${handle.url}/api/runs/cc-wf_abc/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(ctl.status, 409);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: control endpoint rejects non-JSON and cross-origin (CSRF guard)", async () => {
  const root = tempRoot();
  const store = new RunStore(root);
  const id = seedRun(store, { name: "demo", state: "running", pid: process.pid }, [
    A("agent_started", "alpha", "Research", 1),
  ]);
  const handle = await startServer({ store, port: 0, host: "127.0.0.1" });
  try {
    // A cross-site "simple request" uses text/plain to skip preflight — reject it.
    const textPlain = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(textPlain.status, 415);

    // A cross-origin POST (Origin host != bind host) is rejected.
    const crossOrigin = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(crossOrigin.status, 403);

    // Neither attempt should have written a control file.
    assert.equal(store.readControl(id), null);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: /api/workflows lists managed-dir workflows + detail with source", async () => {
  const root = tempRoot(); // runs root
  const proj = tempRoot(); // a project cwd with .odw/workflows
  const globalWf = tempRoot();
  const globalClaudeWf = tempRoot();
  mkdirSync(join(proj, ".odw", "workflows"), { recursive: true });
  mkdirSync(join(proj, ".claude", "workflows"), { recursive: true });
  writeFileSync(
    join(proj, ".odw", "workflows", "echo.js"),
    [
      "export const meta = {",
      "  name: 'echo',",
      "  description: 'Echo the input back.',",
      "  phases: [{ title: 'Echo' }],",
      "}",
      "",
      "phase('Echo')",
      "return await agent('echo: ' + args.q)",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(proj, ".claude", "workflows", "claude-audit.js"),
    [
      "export const meta = {",
      "  name: 'claude-audit',",
      "  description: 'Audit with a saved Claude workflow.',",
      "  phases: [{ title: 'Audit' }, { title: 'Report' }],",
      "}",
      "",
      "phase('Audit')",
      "return await agent('audit: ' + args.target)",
      "",
    ].join("\n"),
  );
  const store = new RunStore(root);
  const config = defaultConfig();
  config.settings.workflowsRoot = globalWf;
  config.settings.claudeWorkflowsRoot = globalClaudeWf;
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: proj,
    config,
  });
  try {
    const list = await fetch(`${handle.url}/api/workflows`).then((r) => r.json());
    const echo = (list as Array<{ name: string }>).find((w) => w.name === "echo") as
      | Record<string, unknown>
      | undefined;
    const claudeAudit = (list as Array<{ name: string }>).find((w) => w.name === "claude-audit") as
      | Record<string, unknown>
      | undefined;
    assert.ok(echo, "echo workflow is listed");
    assert.equal(echo!.origin, "project");
    assert.equal(echo!.provider, "odw");
    assert.equal(echo!.rootLabel, ".odw/workflows");
    assert.equal(echo!.description, "Echo the input back.");
    assert.deepEqual(echo!.phases, [{ title: "Echo" }]);
    assert.equal(echo!.runCount, 0);
    assert.ok(claudeAudit, "saved Claude workflow is listed");
    assert.equal(claudeAudit!.origin, "project");
    assert.equal(claudeAudit!.provider, "claude");
    assert.equal(claudeAudit!.rootLabel, ".claude/workflows");
    assert.deepEqual(claudeAudit!.phases, [{ title: "Audit" }, { title: "Report" }]);

    const det = await fetch(`${handle.url}/api/workflows/echo`).then((r) => r.json());
    assert.equal(det.name, "echo");
    assert.match(det.source, /export const meta/);
    assert.deepEqual(det.runs, []);

    const claudeDet = await fetch(`${handle.url}/api/workflows/claude-audit`).then((r) => r.json());
    assert.equal(claudeDet.name, "claude-audit");
    assert.equal(claudeDet.provider, "claude");
    assert.match(claudeDet.source, /saved Claude workflow/);

    const missing = await fetch(`${handle.url}/api/workflows/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    rmSync(globalWf, { recursive: true, force: true });
    rmSync(globalClaudeWf, { recursive: true, force: true });
  }
});

test("HTTP: /api/settings exposes the live runtime config summary", async () => {
  const root = tempRoot();
  const proj = tempRoot();
  const globalWf = tempRoot();
  const globalClaudeWf = tempRoot();
  const store = new RunStore(root);
  const config = defaultConfig();
  config.settings.workflowsRoot = globalWf;
  config.settings.claudeWorkflowsRoot = globalClaudeWf;
  config.settings.defaultAdapter = "codex";
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: proj,
    config,
    configPath: "/tmp/odw.config.json",
    claudeProjectsRoot: join(root, "no-claude"),
  });
  try {
    const settings = await fetch(`${handle.url}/api/settings`).then((r) => r.json());
    assert.equal(settings.cwd, proj);
    assert.equal(settings.runsRoot, root);
    assert.equal(settings.configPath, "/tmp/odw.config.json");
    assert.equal(settings.writable, true);
    assert.ok(settings.adapters.some((a: { name: string; command: string }) => a.name === "codex" && a.command));
    assert.ok(settings.workflowRoots.some((r: { path: string }) => r.path === globalWf));
    assert.ok(settings.workflowRoots.some((r: { path: string }) => r.path === globalClaudeWf));
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    rmSync(globalWf, { recursive: true, force: true });
    rmSync(globalClaudeWf, { recursive: true, force: true });
  }
});

test("HTTP: Chat Host sessions persist messages and link a real ODW run", async () => {
  const root = tempRoot();
  const proj = tempRoot();
  const store = new RunStore(root);
  const prompts: string[] = [];
  const mockAgent =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
    "process.stdout.write('mock ODW task result for: '+d.match(/User request:\\n([\\s\\S]*)/)?.[1].trim())})";
  const configPath = join(proj, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "mock",
      workspaceMode: "inplace",
      adapters: { mock: { command: [execPath, "-e", mockAgent], stdin: "{prompt}" } },
    }),
  );
  const config = defaultConfig();
  config.settings.defaultAdapter = "mock";
  config.settings.workspaceMode = "inplace";
  config.adapters.mock = { name: "mock", command: [execPath, "-e", mockAgent], stdin: "{prompt}" };
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: proj,
    config,
    configPath,
    claudeProjectsRoot: join(root, "no-claude"),
    chatRunner: mockChatRunner(prompts),
  });
  try {
    const created = await fetch(`${handle.url}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: proj }),
    }).then((r) => r.json());
    assert.match(created.id, /^chat_/);
    assert.equal(created.messages.length, 1);

    const updated = await fetch(`${handle.url}/api/chat/sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Use ODW workflow routing for this local turn." }),
    }).then((r) => r.json());
    assert.equal(updated.linkedRuns.length, 1);
    const runId = updated.linkedRuns[0].runId;
    assert.equal(store.exists(runId), true);
    assert.equal(store.readMeta(runId).origin, "chat");
    assert.equal(store.readMeta(runId).workflowName, "chat-host-bridge");

    await waitFor(store, runId, { timeoutMs: 5000 });

    const hydrated = await waitForChat(
      `${handle.url}/api/chat/sessions/${created.id}`,
      (session) =>
        session.messages.some((m: { kind?: string }) => m.kind === "chat.odw_result") &&
        session.messages.some((m: { role: string; text: string; status?: string }) =>
          m.role === "assistant" && m.text.includes("mock codex follow-up") && m.status === "done",
        ),
    );
    assert.equal(hydrated.state, "done");
    assert.equal(hydrated.linkedRuns[0].state, "done");
    assert.equal(hydrated.linkedRuns[0].progress, 1);
    const tool = hydrated.messages.find((m: { role: string }) => m.role === "tool");
    assert.equal(tool.tool.status, "done");
    assert.equal(tool.tool.progress, 1);
    assert.match(tool.tool.result, /mock ODW task result/);
    assert.match(tool.tool.result, /Use ODW workflow routing/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /ODW run /);
    assert.match(prompts[0]!, /mock ODW task result/);

    const list = await fetch(`${handle.url}/api/chat/sessions`).then((r) => r.json());
    assert.equal(list.length, 1);
    assert.equal(list[0].linkedRuns, 1);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("HTTP: Chat Host ignores negated workflow mentions and deletes sessions", async () => {
  const root = tempRoot();
  const proj = tempRoot();
  const store = new RunStore(root);
  const prompts: string[] = [];
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: proj,
    claudeProjectsRoot: join(root, "no-claude"),
    chatRunner: mockChatRunner(prompts),
  });
  try {
    const created = await fetch(`${handle.url}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());

    const updated = await fetch(`${handle.url}/api/chat/sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "普通消息：hello chat host，不触发 workflow" }),
    }).then((r) => r.json());
    assert.equal(updated.linkedRuns.length, 0);
    assert.equal(updated.messages.some((m: { role: string }) => m.role === "tool"), false);
    assert.equal(store.listRuns().length, 0);
    const answered = await waitForChat(
      `${handle.url}/api/chat/sessions/${created.id}`,
      (session) =>
        session.messages.some((m: { role: string; text: string; status?: string }) =>
          m.role === "assistant" && m.text.includes("mock codex reply") && m.status === "done",
        ),
    );
    assert.equal(answered.linkedRuns.length, 0);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /普通消息/);

    const deleted = await fetch(`${handle.url}/api/chat/sessions/${created.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(deleted.status, 200);

    const missing = await fetch(`${handle.url}/api/chat/sessions/${created.id}`);
    assert.equal(missing.status, 404);
    const list = await fetch(`${handle.url}/api/chat/sessions`).then((r) => r.json());
    assert.equal(list.length, 0);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("HTTP: Chat Host sidebar summary ignores empty streaming placeholders", async () => {
  const root = tempRoot();
  const proj = tempRoot();
  const store = new RunStore(root);
  let release!: () => void;
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: proj,
    claudeProjectsRoot: join(root, "no-claude"),
    chatRunner: () => new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  try {
    const created = await fetch(`${handle.url}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    const text = "调研下证券ETF看看";
    await fetch(`${handle.url}/api/chat/sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    const list = await fetch(`${handle.url}/api/chat/sessions`).then((r) => r.json());
    assert.equal(list[0].state, "running");
    assert.equal(list[0].lastMessage, text);

    release();
    await waitForChat(
      `${handle.url}/api/chat/sessions/${created.id}`,
      (session) =>
        session.messages.some((m: { role: string; status?: string }) => m.role === "assistant" && m.status === "done"),
    );
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
