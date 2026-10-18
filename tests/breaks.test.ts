import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyArgsEdit, Breaks, parseBreakNames, runSoFar } from "../src/breaks.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { META, callsOf, cli, project, stopProcessRun, until, type Project } from "./checkpoint-project.js";

// `odw run --break <phase|label>[,…]` and `--step` (ODW extension): an
// implicit checkpoint before the named phases and agents, or every phase —
// answered like any checkpoint: approve goes on, reject stops the run, an
// approval with edited args changes `args` for the rest of the run.

const THREE_PHASES =
  "phase('Plan')\n" +
  "const plan = await agent('TASK:plan ' + (args?.topic ?? ''), { label: 'plan' })\n" +
  "phase('Build')\n" +
  "const built = await agent('TASK:build-' + args?.topic, { label: 'build' })\n" +
  "phase('Ship')\n" +
  "const shipped = await agent('TASK:ship', { label: 'ship' })\n" +
  "return { plan, built, shipped, topic: args?.topic ?? null }\n";

/** The one checkpoint the run waits at, once it does. */
async function waitingAt(p: Project, id: string): Promise<{ checkpointId: number; title: string; payload: Record<string, unknown> }> {
  let cp: { checkpointId: number; title: string; payload: unknown } | undefined;
  await until(() => (cp = detail(p.store, id).pendingCheckpoints?.[0]) !== undefined);
  return cp as { checkpointId: number; title: string; payload: Record<string, unknown> };
}

const flags = (p: Project) => ["--runs-root", p.runsRoot];

test("--break <phase>: the phase's work waits for a decision, with the run so far as the payload; approve goes on", async () => {
  const p = project();
  try {
    const { id, run } = p.start(THREE_PHASES, { breaks: { at: ["Build"], step: false }, args: { topic: "auth" } });
    const cp = await waitingAt(p, id);
    assert.equal(cp.title, "Break before phase Build");
    assert.deepEqual(callsOf(p), ["plan"], "nothing of Build ran before the answer");
    assert.deepEqual(cp.payload.before, { phase: "Build" });
    assert.deepEqual(cp.payload.phasesDone, ["Plan"]);
    assert.deepEqual(cp.payload.agents, { done: 1, failed: 0, running: 0 });
    assert.deepEqual(cp.payload.results, [{ agentId: 1, label: "plan", phase: "Plan", state: "done", reply: "done:plan" }]);
    assert.deepEqual(cp.payload.args, { topic: "auth" });
    const requested = p.store.readEvents(id).find((ev) => ev.type === "checkpoint_requested")!;
    assert.equal(requested.phase, "Build", "the break heads the phase's lane");

    const r = await cli(["approve", id, ...flags(p)]);
    assert.equal(r.code, 0, r.err);
    assert.equal(await run, "done");
    assert.deepEqual(callsOf(p), ["plan", "build-auth", "ship"]);
    const logs = p.store.readEvents(id).filter((ev) => ev.type === "log").map((ev) => String(ev.message));
    assert.ok(logs.some((m) => m.startsWith("--break: the run stops for a decision before the phases titled, and the agents labelled, \"Build\"")), logs.join("\n"));
  } finally {
    await p.cleanup();
  }
});

test("--step: a break before every phase, in order, each answered before that phase's agents start", async () => {
  const p = project();
  try {
    const { id, run } = p.start(THREE_PHASES, { breaks: { at: [], step: true }, args: { topic: "x" } });
    for (const [n, phase, ran] of [[1, "Plan", []], [2, "Build", ["plan"]], [3, "Ship", ["plan", "build-x"]]] as const) {
      const cp = await waitingAt(p, id);
      assert.equal(cp.checkpointId, n);
      assert.equal(cp.title, `Break before phase ${phase}`);
      assert.deepEqual(callsOf(p), ran);
      const r = await cli(["approve", id, "--checkpoint", String(n), ...flags(p)]);
      assert.equal(r.code, 0, r.err);
      await until(() => (detail(p.store, id).pendingCheckpoints ?? []).every((c) => c.checkpointId !== n));
    }
    assert.equal(await run, "done");
    assert.deepEqual(callsOf(p), ["plan", "build-x", "ship"]);
  } finally {
    await p.cleanup();
  }
});

test("reject at a break stops the run, the break and the note in the reason; the phase never runs", async () => {
  const p = project();
  try {
    const { id, run } = p.start(THREE_PHASES, { breaks: { at: ["Build"], step: false } });
    await waitingAt(p, id);
    const r = await cli(["reject", id, "--note", "plan looks wrong", ...flags(p)]);
    assert.equal(r.code, 0, r.err);
    assert.equal(await run, "stopped");
    assert.deepEqual(callsOf(p), ["plan"]);
    const stopped = p.store.readEvents(id).some((ev) => ev.type === "run_stopped");
    assert.ok(stopped);
    const status = p.store.readStatus(id);
    assert.equal(status.state, "stopped");
  } finally {
    await p.cleanup();
  }
});

test("odw stop while a break waits ends the run as stopped", async () => {
  const p = project();
  try {
    const { id, run } = p.start(THREE_PHASES, { breaks: { at: ["Ship"], step: false } });
    await waitingAt(p, id);
    p.store.writeControl(id, "stop");
    assert.equal(await run, "stopped");
    assert.deepEqual(callsOf(p), ["plan", "build-undefined"]);
  } finally {
    await p.cleanup();
  }
});

test("approve with edited args: what the run reads from then on sees them; what it read before keeps its value", async () => {
  const p = project();
  try {
    const body =
      "const early = args.topic\n" +
      "phase('Plan')\n" +
      "await agent('TASK:plan-' + args.topic, { label: 'plan' })\n" +
      "phase('Build')\n" +
      // Built before the break is answered: phase() returns at once, the call waits.
      "await agent('TASK:build-' + args.topic, { label: 'build' })\n" +
      "await agent('TASK:test-' + args.topic + '-' + (args.extra ?? 'none'), { label: 'test' })\n" +
      "return { early, topic: args.topic, extra: args.extra, gone: 'drop' in args }\n";
    const { id, run } = p.start(body, { breaks: { at: ["Build"], step: false }, args: { topic: "auth", drop: 1 } });
    const cp = await waitingAt(p, id);
    const edited = { ...cp.payload, args: { topic: "billing", extra: "fast" } };
    const r = await cli(["approve", id, "--payload", JSON.stringify(edited), ...flags(p)]);
    assert.equal(r.code, 0, r.err);
    assert.equal(await run, "done");
    assert.deepEqual(p.store.readResult(id), { early: "auth", topic: "billing", extra: "fast", gone: false });
    assert.deepEqual(callsOf(p), ["plan-auth", "build-auth", "test-billing-fast"]);
    const line = p.store.readEvents(id).find((ev) => ev.type === "log" && Array.isArray(ev.argsEdited))!;
    assert.match(String(line.message), /Break before phase Build: approved with edited args — what the script reads from now on sees args\.topic, args\.drop, args\.extra changed/);
    // meta.json keeps the args the run started with: rerun and resume start from them.
    assert.deepEqual(p.store.readMeta(id).args, { topic: "auth", drop: 1 });
  } finally {
    await p.cleanup();
  }
});

test("an edit of args that cannot be taken in place is refused with a line; the run goes on as it was", async () => {
  const p = project();
  try {
    const body = "phase('Build')\nreturn await agent('TASK:build-' + args, { label: 'build' })\n";
    const { id, run } = p.start(body, { breaks: { at: ["Build"], step: false }, args: "plain" });
    const cp = await waitingAt(p, id);
    const r = await cli(["approve", id, "--payload", JSON.stringify({ ...cp.payload, args: { now: "object" } }), ...flags(p)]);
    assert.equal(r.code, 0, r.err);
    assert.equal(await run, "done");
    assert.deepEqual(callsOf(p), ["build-plain"]);
    const logs = p.store.readEvents(id).filter((ev) => ev.type === "log").map((ev) => String(ev.message));
    assert.ok(logs.some((m) => /approved with an edit, but its args were not taken — the run's args is a string and the edit makes it an object/.test(m)), logs.join("\n"));
  } finally {
    await p.cleanup();
  }
});

test("--break <label>: agents of that label wait for one break — a parallel() of them shares it; others go on; a name never matched is said", async () => {
  const p = project();
  try {
    const body =
      "const first = await agent('TASK:solo', { label: 'solo' })\n" +
      "const twins = await parallel([() => agent('TASK:w1', { label: 'w' }), () => agent('TASK:w2', { label: 'w' })])\n" +
      "return { first, twins }\n";
    const { id, run } = p.start(body, { breaks: { at: ["w", "nowhere"], step: false } });
    const cp = await waitingAt(p, id);
    assert.equal(cp.title, "Break before agent w");
    assert.deepEqual(cp.payload.before, { agent: "w" });
    assert.deepEqual(callsOf(p), ["solo"]);
    assert.equal((await cli(["approve", id, ...flags(p)])).code, 0);
    assert.equal(await run, "done");
    assert.deepEqual(callsOf(p).sort(), ["solo", "w1", "w2"]);
    const requested = p.store.readEvents(id).filter((ev) => ev.type === "checkpoint_requested");
    assert.equal(requested.length, 1, "one break for both");
    const logs = p.store.readEvents(id).filter((ev) => ev.type === "log").map((ev) => String(ev.message));
    assert.ok(logs.includes('--break "nowhere": no phase title and no agent label of this run matched it'), logs.join("\n"));
    assert.ok(!logs.some((m) => m.includes('--break "w"')));
  } finally {
    await p.cleanup();
  }
});

test("a break also holds exec(), checkpoint() and workflow() calls, and keeps the phase each call was made in", async () => {
  const p = project();
  try {
    const body =
      "phase('Build')\n" +
      "const step = exec(['node', '-e', 'process.stdout.write(\"ran\")'])\n" +
      "phase('Later')\n" +
      "const r = await step\n" +
      "return r.stdout\n";
    const { id, run } = p.start(body, { breaks: { at: ["Build"], step: false } });
    await waitingAt(p, id);
    assert.equal(p.store.readEvents(id).filter((ev) => ev.type === "command_started").length, 0, "the command waits");
    assert.equal((await cli(["approve", id, ...flags(p)])).code, 0);
    assert.equal(await run, "done");
    assert.equal(p.store.readResult(id), "ran");
    const started = p.store.readEvents(id).find((ev) => ev.type === "command_started")!;
    assert.equal(started.phase, "Build");
  } finally {
    await p.cleanup();
  }
});

test("odw run --break/--step: recorded in meta.json, and usage mistakes exit 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-break-cli-"));
  const store = new RunStore(join(root, "runs"));
  const script = join(root, "gate.js");
  writeFileSync(script, META + "phase('A')\nreturn 1\n");
  let runId = "";
  try {
    let r = await cli(["run", script, "--break", "  ,", "-d", "--runs-root", store.root]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--break needs a phase title or an agent label/);
    r = await cli(["run", script, "--break", "A,B", "--break", "C", "--step", "-d", "--runs-root", store.root]);
    assert.equal(r.code, 0, r.err);
    runId = r.out.trim();
    assert.deepEqual(store.readMeta(runId).breaks, { at: ["A", "B", "C"], step: true });
    r = await cli(["run", script, "--step", "--on", "ssh://example.invalid", "--runs-root", store.root]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--break and --step run here/);
  } finally {
    if (runId) await stopProcessRun(store, runId);
    rmSync(root, { recursive: true, force: true });
  }
});

test("breaks, the parts: names, matching, args edits, the run so far", () => {
  assert.deepEqual(parseBreakNames(["a, b", "b,c", ""]), ["a", "b", "c"]);
  assert.throws(() => parseBreakNames([" , "]), /needs a phase title/);

  const b = new Breaks({ at: ["Build", "child · Fix", "w"], step: false });
  assert.equal(b.atPhase("Plan", "Plan"), false);
  assert.equal(b.atPhase("Build", "Build"), true);
  assert.equal(b.atPhase("Fix", "child · Fix"), true, "a nested workflow's phase by its lane title");
  assert.equal(b.atLabel("w"), true);
  assert.equal(b.atLabel(undefined), false);
  assert.deepEqual(b.unmatched(), []);
  assert.equal(new Breaks({ at: [], step: true }).atPhase("Any", "Any"), true);
  assert.equal(b.before(undefined, async () => {}), null, "nothing holds a call before any break");

  const args: Record<string, unknown> = { a: 1, b: 2 };
  assert.deepEqual(applyArgsEdit(args, { args: { a: 1, b: 3, c: 4 } }), { changed: ["b", "c"] });
  assert.deepEqual(args, { a: 1, b: 3, c: 4 });
  assert.deepEqual(applyArgsEdit(args, { args: { a: 1, b: 3, c: 4 } }), { changed: [] });
  const list = [1, 2];
  assert.deepEqual(applyArgsEdit(list, { args: [1, 5, 6] }), { changed: ["1", "2"] });
  assert.deepEqual(list, [1, 5, 6]);
  assert.ok("refused" in applyArgsEdit(null, { args: {} }));
  assert.ok("refused" in applyArgsEdit({}, "not an object"));

  const so = runSoFar(
    [
      { ts: 1, type: "phase_started", phase: "A" },
      { ts: 2, type: "agent_started", agentId: 1, label: "x", phase: "A" },
      { ts: 3, type: "agent_finished", agentId: 1, label: "x", phase: "A" },
      { ts: 4, type: "agent_started", agentId: 2, label: "y", phase: "A" },
      { ts: 5, type: "agent_failed", agentId: 2, label: "y", phase: "A", error: "boom" },
      { ts: 6, type: "agent_started", agentId: 3, label: "z", phase: "A" },
      { ts: 7, type: "phase_started", phase: "B" },
    ],
    [{ agentId: 1, key: "k", label: "x", phase: "A", adapter: "m", attempts: 1, startedAt: 2, finishedAt: 3, value: { long: "v".repeat(400) } }],
  );
  assert.deepEqual(so.phasesDone, ["A"]);
  assert.deepEqual(so.agents, { done: 1, failed: 1, running: 1 });
  assert.equal(so.results[0]!.reply!.length, 300);
  assert.equal(so.results[1]!.error, "boom");
});
