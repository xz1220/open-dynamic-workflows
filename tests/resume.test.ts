import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { startRun, startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { RunStore } from "../src/runtime/run-store.js";
import { isProcessAlive } from "../src/runtime/runs-view.js";
import { startServer } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";

// Issue #24 end to end: a finished agent's result is saved the moment it lands
// — readable through the store, the CLI and the API while other lanes still
// run, and still there after the worker is stopped or killed — and `odw
// resume` replays the calls a run already completed instead of paying for them
// again. The counting mock adapter appends one line per real invocation.

const FIXTURE = fileURLToPath(new URL("./fixtures/counting-agent.mjs", import.meta.url));

interface Project {
  root: string;
  runsRoot: string;
  /** The mock adapter's invocation log: one TASK name per real run. */
  calls: string;
  config: string;
  store: RunStore;
  /** Write (or rewrite) a workflow script; returns its path. */
  script(name: string, body: string): string;
}

function project(): Project {
  const root = mkdtempSync(join(tmpdir(), "odw-resume-"));
  const calls = join(root, "calls.log");
  const config = join(root, "odw.config.json");
  const adapter = { command: [execPath, FIXTURE, calls], stdin: "{prompt}" };
  // Two lanes must run at once; the auto concurrency is 1 on a small machine.
  writeFileSync(config, JSON.stringify({ defaultAdapter: "count", concurrency: 4, adapters: { count: adapter, other: adapter } }));
  const runsRoot = join(root, "runs");
  return {
    root,
    runsRoot,
    calls,
    config,
    store: new RunStore(runsRoot),
    script(name, body) {
      const path = join(root, `${name}.js`);
      writeFileSync(path, `export const meta = { name: '${name}', description: 'd' }\n${body}`);
      return path;
    },
  };
}

const callsOf = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** Run the CLI with stdout/stderr captured (node:test's own buffer writes pass through). */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** Create a run that resumes `source`, the way `odw resume` does, and execute it in-process. */
async function resumeInProcess(p: Project, script: string, source: string, extra: { adapter?: string } = {}) {
  const id = p.store.create({
    script,
    args: null,
    source: p.root,
    configPath: p.config,
    adapter: extra.adapter ?? null,
    resumedFrom: { runId: source, dir: p.store.runDir(source) },
  });
  return { id, state: await executeRun(p.store.runDir(id)) };
}

const LANES =
  "const [fast, slow] = await parallel([\n" +
  "  () => agent('TASK:fast', { label: 'fast' }),\n" +
  "  () => agent('TASK:block-slow', { label: 'slow' }),\n" +
  "])\n" +
  "return { fast, slow }\n";

test(
  "#24: a finished lane is readable while another is blocked, survives a killed worker, and resume replays it",
  async () => {
    const p = project();
    try {
      const script = p.script("lanes", LANES);
      // A real detached worker: the one thing a test can kill -9.
      const { runId, store } = startRun(script, { source: p.root, runsRoot: p.runsRoot, configPath: p.config });
      // The record is written just before agent_finished: wait for both.
      await until(
        () =>
          store.readAgentResult(runId, 1) !== null &&
          callsOf(p.calls).includes("block-slow") &&
          store.readEvents(runId).some((e) => e.type === "agent_finished" && e.agentId === 1),
      );
      assert.equal(store.readStatus(runId).state, "running", "the run is still going");

      // The store: the fast lane's record, the blocked lane none.
      const fast = store.readAgentResult(runId, 1)!;
      assert.equal(fast.value, "done:fast");
      assert.equal(fast.label, "fast");
      assert.equal(fast.adapter, "count");
      assert.match(fast.key, /^[0-9a-f]{64}$/);
      assert.equal(store.readAgentResult(runId, 2), null);
      const finished = store.readEvents(runId).find((e) => e.type === "agent_finished");
      assert.equal(finished?.agentId, 1);
      assert.equal(finished?.saved, true, "the event references the saved result");
      assert.equal(finished && "value" in finished, false);

      // The CLI, mid-run.
      let r = await cli(["result", runId, "--agent", "fast", "--runs-root", p.runsRoot]);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out), "done:fast");
      r = await cli(["result", runId, "--agent", "slow", "--runs-root", p.runsRoot]);
      assert.equal(r.code, 1);
      assert.match(r.err, /agent 2 \(slow\) is running: no result yet/);
      r = await cli(["agents", runId, "--json", "--runs-root", p.runsRoot]);
      assert.deepEqual(
        JSON.parse(r.out).map((a: Record<string, unknown>) => [a.agentId, a.label, a.state, a.saved, a.preview]),
        [
          [1, "fast", "done", true, "done:fast"],
          [2, "slow", "running", false, null],
        ],
      );

      // The API, mid-run.
      const handle = await startServer({
        store: new RunStore(p.runsRoot),
        port: 0,
        host: "127.0.0.1",
        claudeProjectsRoot: join(p.root, "no-claude"),
      });
      try {
        const list = await fetch(`${handle.url}/api/runs/${runId}/agents`).then((res) => res.json());
        assert.deepEqual(list, [
          { agentId: 1, label: "fast", phase: null, adapter: "count", cached: false, finishedAt: fast.finishedAt },
        ]);
        const one = await fetch(`${handle.url}/api/runs/${runId}/agents/1`).then((res) => res.json());
        assert.deepEqual(one, fast);
        assert.equal((await fetch(`${handle.url}/api/runs/${runId}/agents/2`)).status, 404);
      } finally {
        await handle.close();
      }

      // kill -9 the worker: no cleanup runs, yet the saved result stays.
      const pid = store.readStatus(runId).pid as number;
      process.kill(pid, "SIGKILL");
      await until(() => isProcessAlive(pid) === false);
      assert.deepEqual(store.readAgentResult(runId, 1), fast);
      r = await cli(["result", runId, "--agent", "1", "--runs-root", p.runsRoot]);
      assert.equal(JSON.parse(r.out), "done:fast");
      r = await cli(["agents", runId, "--json", "--runs-root", p.runsRoot]);
      assert.equal(JSON.parse(r.out)[1].state, "stale", "the blocked lane will never settle");

      // Resuming the dead run replays the finished lane; only the blocked one runs again.
      writeFileSync(`${p.calls}.release`, "");
      r = await cli(["resume", runId, "--wait", "--runs-root", p.runsRoot]);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(JSON.parse(r.out), { fast: "done:fast", slow: "done:block-slow" });
      assert.deepEqual(callsOf(p.calls).filter((t) => t === "fast"), ["fast"], "the fast lane never ran again");
    } finally {
      writeFileSync(`${p.calls}.release`, ""); // lets the orphaned blocked agent exit
      rmSync(p.root, { recursive: true, force: true });
    }
  },
);

test("#24: a result saved before a stop survives the stopped run", async () => {
  const p = project();
  try {
    const script = p.script("lanes", LANES);
    const id = p.store.create({ script, args: null, source: p.root, configPath: p.config });
    const run = executeRun(p.store.runDir(id));
    await until(() => p.store.readAgentResult(id, 1) !== null && callsOf(p.calls).includes("block-slow"));
    p.store.writeControl(id, "stop");
    assert.equal(await run, "stopped");

    assert.equal(p.store.readAgentResult(id, 1)?.value, "done:fast");
    const r = await cli(["agents", id, "--json", "--runs-root", p.runsRoot]);
    assert.deepEqual(
      JSON.parse(r.out).map((a: Record<string, unknown>) => [a.label, a.state, a.saved]),
      [
        ["fast", "done", true],
        ["slow", "failed", false],
      ],
    );
  } finally {
    writeFileSync(`${p.calls}.release`, "");
    rmSync(p.root, { recursive: true, force: true });
  }
});

const V1 =
  "const SCHEMA = { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] }\n" +
  "const a = await agent('TASK:a about ' + args.topic, { label: 'a' })\n" +
  "const b = await agent('TASK:b', { label: 'b', schema: SCHEMA })\n" +
  "const votes = await parallel([1, 2].map(() => () => agent('TASK:vote', { label: 'vote' })))\n";

test("odw resume replays unchanged calls without the adapter; edited and new calls run", async () => {
  const p = project();
  try {
    const script = p.script("resumable", V1 + "return { a, b, votes }\n");
    const first = p.store.create({ script, args: { topic: "caching" }, source: p.root, configPath: p.config });
    assert.equal(await executeRun(p.store.runDir(first)), "done");
    assert.deepEqual(callsOf(p.calls).sort(), ["a", "b", "vote", "vote"]);

    // Edit one prompt and add a call, then resume the finished run.
    const v2 = V1.replace("'TASK:b'", "'TASK:b2'") + "const c = await agent('TASK:c', { label: 'c' })\n";
    writeFileSync(script, `export const meta = { name: 'resumable', description: 'd' }\n${v2}return { a, b, votes, c }\n`);
    const r = await cli(["resume", first, "--wait", "--runs-root", p.runsRoot]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), {
      a: "done:a",
      b: { task: "b2" },
      votes: ["done:vote", "done:vote"],
      c: "done:c",
    });
    assert.deepEqual(callsOf(p.calls).sort(), ["a", "b", "b2", "c", "vote", "vote"], "only b2 and c reached the adapter");

    const second = /running (\S+) \.\.\./.exec(r.err)![1]!;
    const meta = p.store.readMeta(second);
    assert.equal(meta.resumedFrom, first);
    assert.deepEqual(meta.args, { topic: "caching" }, "same args");
    assert.equal(meta.script, script, "same script");
    // Replayed calls are marked in the new run's records and events; the rest are fresh.
    const records = p.store.listAgentResults(second);
    assert.deepEqual(
      records.map((rec) => [rec.label, rec.cached === true, rec.sourceRunId ?? null]),
      [
        ["a", true, first],
        ["b", false, null],
        ["vote", true, first],
        ["vote", true, first],
        ["c", false, null],
      ],
    );
    const events = p.store.readEvents(second);
    assert.equal(events.filter((e) => e.type === "agent_finished" && e.cached === true).length, 3);
    assert.ok(events.some((e) => e.type === "log" && /resuming .*replay its 4 saved result/.test(String(e.message))));
    // Replays are not dispatches: status counts only the two real ones.
    const status = await cli(["status", second, "--runs-root", p.runsRoot]);
    assert.match(status.out, /dispatched: 2 agent\(s\)/);
    assert.match(status.out, new RegExp(`resumed from: ${first} \\(3 agent result\\(s\\) replayed\\)`));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("resumes chain: a resume of a resume replays both runs' results", async () => {
  const p = project();
  try {
    const write = (tasks: string[]) =>
      p.script("chain", tasks.map((t) => `await agent('TASK:${t}', { label: '${t}' })`).join("\n") + "\nreturn 'ok'\n");
    const script = write(["a", "b"]);
    const run0 = p.store.create({ script, args: null, source: p.root, configPath: p.config });
    assert.equal(await executeRun(p.store.runDir(run0)), "done");

    write(["a", "b", "c"]);
    const run1 = await resumeInProcess(p, script, run0);
    assert.equal(run1.state, "done");
    write(["a", "b", "c", "d"]);
    const run2 = await resumeInProcess(p, script, run1.id);
    assert.equal(run2.state, "done");

    assert.deepEqual(callsOf(p.calls), ["a", "b", "c", "d"], "every call ran exactly once across three runs");
    assert.deepEqual(
      p.store.listAgentResults(run2.id).map((rec) => [rec.label, rec.cached === true, rec.sourceRunId ?? null]),
      [
        ["a", true, run0], // replayed twice: still points at the run that produced it
        ["b", true, run0],
        ["c", true, run1.id],
        ["d", false, null],
      ],
    );
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a resume on another default adapter still replays the calls that named none", async () => {
  const p = project();
  try {
    const body = "const x = await agent('TASK:bare')\nconst y = await agent('TASK:named', { adapter: 'count' })\nreturn [x, y]\n";
    const script = p.script("adapters", body);
    const run0 = p.store.create({ script, args: null, source: p.root, configPath: p.config });
    assert.equal(await executeRun(p.store.runDir(run0)), "done");

    // The key holds the adapter AS REQUESTED: a new run-level default changes nothing.
    const run1 = await resumeInProcess(p, script, run0, { adapter: "other" });
    assert.equal(run1.state, "done");
    assert.deepEqual(callsOf(p.calls), ["bare", "named"]);

    // Naming a different adapter is a different call: it runs again, on that adapter.
    p.script("adapters", body.replace("adapter: 'count'", "adapter: 'other'"));
    const run2 = await resumeInProcess(p, script, run1.id, { adapter: "other" });
    assert.equal(run2.state, "done");
    assert.deepEqual(callsOf(p.calls), ["bare", "named", "named"]);
    const finished = p.store.readEvents(run2.id).filter((e) => e.type === "agent_finished");
    assert.deepEqual(
      finished.map((e) => [e.cached === true, e.adapter]),
      [
        [true, "count"],
        [false, "other"],
      ],
    );
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a nested workflow()'s agents replay like the parent's", async () => {
  const p = project();
  try {
    const wfDir = join(p.root, ".odw", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "child.js"),
      "export const meta = { name: 'child', description: 'd' }\nreturn await agent('TASK:inner', { label: 'inner' })\n",
    );
    const script = p.script("parent", "const o = await agent('TASK:outer')\nconst c = await workflow('child')\nreturn { o, c }\n");
    const run0 = p.store.create({ script, args: null, source: p.root, configPath: p.config });
    assert.equal(await executeRun(p.store.runDir(run0)), "done");
    const run1 = await resumeInProcess(p, script, run0);
    assert.equal(run1.state, "done");
    assert.deepEqual(p.store.readResult(run1.id), { o: "done:outer", c: "done:inner" });
    assert.deepEqual(callsOf(p.calls), ["outer", "inner"], "nothing ran twice");
    const replayed = p.store.readEvents(run1.id).filter((e) => e.type === "agent_finished" && e.cached === true);
    assert.deepEqual(replayed.map((e) => e.phase), [null, "▸ child"]);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("odw resume releases a paused run in place and refuses a running one unless --force", async () => {
  const p = project();
  try {
    const script = p.script("quick", "return 'ok'\n");
    const live = (state: string) => {
      const id = p.store.create({ script, args: null, source: p.root, configPath: p.config });
      p.store.updateStatus(id, { state, pid: process.pid }); // this test process: alive
      return id;
    };
    const args = (id: string, ...flags: string[]) => ["resume", id, ...flags, "--runs-root", p.runsRoot];

    // Paused: the control verb, unchanged — no new run.
    const paused = live("paused");
    let r = await cli(args(paused));
    assert.deepEqual([r.code, r.err], [0, `resume requested for ${paused}\n`]);
    assert.equal(p.store.readControl(paused), "resume");
    // Asked to pause but not at a checkpoint yet: still the control verb.
    const pausing = live("running");
    p.store.writeControl(pausing, "pause");
    r = await cli(args(pausing));
    assert.equal(r.code, 0);
    assert.equal(p.store.readControl(pausing), "resume");
    // New-run flags make no sense for a run that continues in place.
    r = await cli(args(paused, "--wait"));
    assert.equal(r.code, 2);
    assert.match(r.err, /is paused, so resume continues it in place — --wait applies only when resume starts a new run/);

    // Running and not paused: refused, nothing written, no new run.
    const running = live("running");
    r = await cli(args(running));
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`run ${running} is still running — only a paused run continues in place`));
    assert.match(r.err, /pass --force/);
    assert.equal(p.store.readControl(running), null);
    assert.equal(p.store.listRuns().length, 3);

    // --force: a replaying resume next to the live run (which is left alone).
    r = await cli(args(running, "--force", "-d"));
    assert.equal(r.code, 0, r.err);
    const forced = r.out.trim();
    assert.match(r.err, new RegExp(`resuming ${running} \\(0 saved agent result\\(s\\) to replay\\) as ${forced}`));
    assert.equal(p.store.readMeta(forced).resumedFrom, running);
    assert.equal(p.store.readStatus(running).state, "running");
    assert.equal((await waitFor(p.store, forced, { timeoutMs: 15_000, pollIntervalMs: 20 })).state, "done");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("odw resume of a stale run (its worker is gone) replays without --force", async () => {
  const p = project();
  try {
    const script = p.script("quick", "return 'ok'\n");
    const dead = spawnSync(execPath, ["-e", ""]);
    const id = p.store.create({ script, args: null, source: p.root, configPath: p.config });
    p.store.updateStatus(id, { state: "running", pid: dead.pid });
    const r = await cli(["resume", id, "-d", "--runs-root", p.runsRoot]);
    assert.equal(r.code, 0, r.err);
    const resumed = r.out.trim();
    assert.equal(p.store.readMeta(resumed).resumedFrom, id);
    assert.equal(p.store.readMeta(resumed).resumedFromDir, p.store.runDir(id));
    assert.equal((await waitFor(p.store, resumed, { timeoutMs: 15_000, pollIntervalMs: 20 })).state, "done");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("an inline-launched run resumes from its archived source", async () => {
  const p = project();
  try {
    const source = "export const meta = { name: 'inline-job', description: 'd' }\nreturn await agent('TASK:inline')\n";
    const { runId } = startRunFromSource(source, { source: p.root, runsRoot: p.runsRoot, configPath: p.config });
    assert.equal((await waitFor(p.store, runId, { timeoutMs: 15_000, pollIntervalMs: 20 })).state, "done");
    const r = await cli(["resume", runId, "--wait", "--runs-root", p.runsRoot]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "done:inline");
    assert.deepEqual(callsOf(p.calls), ["inline"], "replayed, not run again");
    const resumed = /running (\S+) \.\.\./.exec(r.err)![1]!;
    const meta = p.store.readMeta(resumed);
    assert.equal(meta.inline, true, "re-archived into the new run, like rerun does");
    assert.notEqual(meta.script, p.store.readMeta(runId).script);
    assert.equal(meta.resumedFrom, runId);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("odw resume fails clearly without a script, like rerun", async () => {
  const p = project();
  try {
    const noScript = p.store.create({ script: "", args: null, source: p.root });
    p.store.updateStatus(noScript, { state: "failed" });
    let r = await cli(["resume", noScript, "--runs-root", p.runsRoot]);
    assert.deepEqual([r.code, r.err], [1, `run ${noScript} has no script to resume\n`]);

    const inline = p.store.create({
      script: "",
      inlineSource: "export const meta = { name: 'gone', description: 'd' }\nreturn 1\n",
      args: null,
      source: p.root,
    });
    p.store.updateStatus(inline, { state: "done" });
    rmSync(p.store.readMeta(inline).script as string);
    r = await cli(["resume", inline, "--runs-root", p.runsRoot]);
    assert.deepEqual([r.code, r.err], [1, `run ${inline}: its archived script is gone, cannot resume\n`]);

    r = await cli(["resume", "no-such-run", "--runs-root", p.runsRoot]);
    assert.deepEqual([r.code, r.err], [1, "no such run: no-such-run\n"]);
    r = await cli(["resume"]);
    assert.deepEqual([r.code, r.err], [2, "odw resume: missing <run_id>\n"]);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("rerun and resume keep the source run's adapter; --adapter overrides it", async () => {
  const p = project();
  try {
    const script = p.script("quick", "return 'ok'\n");
    const source = p.store.create({ script, args: null, source: p.root, configPath: p.config, adapter: "other" });
    p.store.updateStatus(source, { state: "done" });
    const started: string[] = [];
    for (const [cmd, flags, adapter] of [
      ["rerun", [], "other"],
      ["rerun", ["--adapter", "count"], "count"],
      ["resume", [], "other"],
      ["resume", ["--adapter", "count"], "count"],
    ] as const) {
      const r = await cli([cmd, source, ...flags, "-d", "--runs-root", p.runsRoot]);
      assert.equal(r.code, 0, r.err);
      const id = r.out.trim();
      started.push(id);
      assert.equal(p.store.readMeta(id).adapter, adapter, `${cmd} ${flags.join(" ")}`);
      assert.equal(p.store.readMeta(id).resumedFrom, cmd === "resume" ? source : null);
    }
    // An unknown adapter fails up front, before any run is created.
    const r = await cli(["resume", source, "--adapter", "nope", "-d", "--runs-root", p.runsRoot]);
    assert.equal(r.code, 1);
    assert.match(r.err, /nope/);
    for (const id of started) await waitFor(p.store, id, { timeoutMs: 15_000, pollIntervalMs: 20 });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});
