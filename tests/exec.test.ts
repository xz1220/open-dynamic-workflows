import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { defaultConfig, resolveAdapter } from "../src/adapters/config.js";
import type { Bridge } from "../src/bridge.js";
import { buildContext, type RunContext } from "../src/context.js";
import { MemoryControl } from "../src/control.js";
import { RunStopped, WorkflowScriptError, isFatalError } from "../src/errors.js";
import { COMMAND_FAILED, COMMAND_FINISHED, COMMAND_STARTED, LOG, MemorySink, type WorkflowEvent } from "../src/events.js";
import { ExecError, type ExecOptions, type ExecResult } from "../src/exec.js";
import { loadWorkflowScript, maskCode, scanDualCompat } from "../src/loader.js";
import { createPrimitives, type WorkflowGlobals } from "../src/primitives.js";
import { activityView } from "../src/runtime/activity-view.js";
import { attachRun, formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import type { RunSource } from "../src/runtime/run-source.js";
import { countAgents, detail, foldAgents, summarize, type RunSummary } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { FakeTerm } from "./fake-term.js";

// exec(): a managed command step that launches no model (issue #31, ODW extension).

const POSIX_ONLY = { skip: process.platform === "win32" };
const META = "export const meta = { name: 'x', description: 'd' }\n";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function eventually(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** Whether `pid` is a live (non-zombie) process. POSIX only. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

interface Harness {
  source: string;
  sink: MemorySink;
  ctx: RunContext;
  prims: WorkflowGlobals;
}

/** A real run context (scheduler, control, events) over a throwaway source directory. */
async function withHarness(
  options: { control?: MemoryControl; concurrency?: number; maxAgents?: number },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const source = mkdtempSync(join(tmpdir(), "odw-exec-"));
  try {
    const config = defaultConfig();
    config.settings.defaultAdapter = "claude";
    if (options.concurrency !== undefined) config.settings.concurrency = options.concurrency;
    if (options.maxAgents !== undefined) config.settings.maxAgents = options.maxAgents;
    const sink = new MemorySink();
    const ctx = buildContext(config, { source, sink, control: options.control });
    await body({ source, sink, ctx, prims: createPrimitives(ctx) });
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

/** Node one-liners as argv, so the cross-platform tests need no shell. */
const node = (script: string, ...rest: string[]): string[] => [execPath, "-e", script, ...rest];

// --- running commands ------------------------------------------------------------

test("a string command runs through the shell", POSIX_ONLY, async () => {
  await withHarness({}, async ({ prims }) => {
    const r = await prims.exec('echo "$ODW_EXEC_PROBE" | tr a-z A-Z; exit 4', { env: { ODW_EXEC_PROBE: "piped" } });
    assert.equal(r.stdout, "PIPED\n");
    assert.equal(r.exitCode, 4);
  });
});

test("an argv array runs without a shell: no element is interpreted", async () => {
  await withHarness({}, async ({ prims }) => {
    const r = await prims.exec(node("process.stdout.write(process.argv.slice(1).join('|'))", "$HOME", "a b", "x; echo y", "*"));
    assert.equal(r.stdout, "$HOME|a b|x; echo y|*");
    assert.equal(r.exitCode, 0);
  });
});

test("env is layered over the worker's environment", async () => {
  await withHarness({}, async ({ prims }) => {
    const r = await prims.exec(node("process.stdout.write(process.env.ODW_EXEC_PROBE + '|' + Boolean(process.env.PATH))"), {
      env: { ODW_EXEC_PROBE: "set" },
    });
    assert.equal(r.stdout, "set|true");
  });
});

test("cwd defaults to the run's source directory; a relative cwd resolves against it", async () => {
  await withHarness({}, async ({ prims, source }) => {
    const pwd = node("process.stdout.write(process.cwd())");
    assert.equal((await prims.exec(pwd)).stdout, realpathSync(source), "not the worker's own cwd");
    mkdirSync(join(source, "pkg", "sub"), { recursive: true });
    assert.equal((await prims.exec(pwd, { cwd: "pkg/sub" })).stdout, realpathSync(join(source, "pkg", "sub")));
    const elsewhere = mkdtempSync(join(tmpdir(), "odw-exec-abs-"));
    try {
      assert.equal((await prims.exec(pwd, { cwd: elsewhere })).stdout, realpathSync(elsewhere));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test("stdin, stdout, stderr and the exit code come back; a non-zero exit is a result, not an error", async () => {
  await withHarness({}, async ({ prims, sink }) => {
    const r = await prims.exec(
      node("let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write('out:'+d);process.stderr.write('err:'+d);process.exit(3)})"),
      { input: "hello", label: "echo-exit" },
    );
    assert.ok(r.durationMs >= 0);
    assert.deepEqual(
      { ...r, durationMs: 0 },
      { stdout: "out:hello", stderr: "err:hello", exitCode: 3, signal: null, timedOut: false, truncated: false, durationMs: 0 },
    );
    const [failed] = sink.ofType(COMMAND_FAILED);
    assert.equal(failed!.exitCode, 3);
    assert.equal(failed!.error, "exited with code 3");
    assert.equal(failed!.label, "echo-exit");
  });
});

test("a program that cannot be found exits 127, as from a shell, without throwing", async () => {
  await withHarness({}, async ({ prims, sink }) => {
    const r = await prims.exec(["odw-no-such-program"]);
    assert.equal(r.exitCode, 127);
    assert.equal(r.signal, null);
    assert.match(r.stderr, /failed to launch 'odw-no-such-program'/);
    assert.match(String(sink.ofType(COMMAND_FAILED)[0]!.error), /failed to launch/);
  });
});

test("misuse is a recoverable script error, raised before anything starts", async () => {
  await withHarness({}, async ({ prims, sink, source }) => {
    writeFileSync(join(source, "file.txt"), "x");
    const cases: Array<[unknown, unknown, RegExp]> = [
      [42, undefined, /takes a command string .* or an argv array/],
      ["  ", undefined, /command string is empty/],
      [[], undefined, /needs a program/],
      [["node", 3], undefined, /argv element 1 is 3/],
      ["true", "fast", /options must be an object/],
      ["true", { cwd: "missing-dir" }, /cwd .*missing-dir does not exist/],
      ["true", { cwd: "file.txt" }, /is not a directory/],
      ["true", { timeout: 0 }, /timeout must be a positive number/],
      ["true", { timeout: Number.NaN }, /timeout must be a positive number/],
      ["true", { maxOutputBytes: -1 }, /maxOutputBytes/],
      ["true", { env: "A=1" }, /env must be an object/],
      ["true", { input: 5 }, /input must be a string/],
    ];
    for (const [command, opts, message] of cases) {
      await assert.rejects(
        () => prims.exec(command as string, opts as ExecOptions),
        (err: unknown) => err instanceof WorkflowScriptError && !isFatalError(err) && message.test(err.message),
        `${JSON.stringify(command)} with ${JSON.stringify(opts)}`,
      );
    }
    assert.equal(sink.ofType(COMMAND_STARTED).length, 0, "nothing started");
  });
});

// --- check, timeout, output cap ---------------------------------------------------

test("check: true turns a failed command into a recoverable ExecError carrying the result", async () => {
  await withHarness({}, async ({ prims, sink, ctx }) => {
    const failing = node("process.stderr.write('3 tests failed'); process.exit(1)");
    const err = await prims.exec(failing, { check: true }).catch((e: unknown) => e);
    assert.ok(err instanceof ExecError, String(err));
    assert.equal(isFatalError(err), false);
    assert.equal(err.result.exitCode, 1);
    assert.equal(err.result.stderr, "3 tests failed");
    assert.match(err.message, /exited with code 1: 3 tests failed/);
    assert.equal((await prims.exec(node(""), { check: true })).exitCode, 0, "exit 0 passes the check");

    // parallel() turns it into a null slot, reported once (command_failed) and not logged again.
    const logs = sink.ofType(LOG).length;
    const slots = await prims.parallel([() => prims.exec(failing, { check: true }), () => prims.exec(node(""))]);
    assert.equal(slots[0], null);
    assert.equal((slots[1] as ExecResult).exitCode, 0);
    assert.equal(sink.ofType(LOG).length, logs);

    // ...and a try/catch in the script handles it like any agent failure.
    const wf = loadWorkflowScript(
      META +
        `try { await exec(${JSON.stringify(node("process.exit(2)"))}, { check: true }) }\n` +
        "catch (e) { return e.name + ':' + e.result.exitCode }",
      "wf.js",
    );
    assert.equal(await wf.run(prims, null), "ExecError:2");
    assert.equal(ctx.scheduler.fatalError, undefined, "the run carries on");
  });
});

test("a timeout kills the command's whole process group, grandchildren included", POSIX_ONLY, async () => {
  await withHarness({}, async ({ prims, sink }) => {
    const started = Date.now();
    // The shell waits on a background grandchild that shares its stdout pipe.
    const r = await prims.exec("sleep 30 & echo $!; wait", { timeout: 0.3 });
    assert.ok(Date.now() - started < 5000, "the timeout was not honoured promptly");
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.equal(r.signal, "SIGKILL");
    const grandchild = Number(r.stdout.trim());
    assert.ok(grandchild > 0, `expected the grandchild pid on stdout, got ${JSON.stringify(r.stdout)}`);
    assert.ok(await eventually(() => !isRunning(grandchild)), `grandchild ${grandchild} survived the timeout`);
    assert.equal(sink.ofType(COMMAND_FAILED)[0]!.error, "timed out after 0.3s");
  });
});

test("output beyond maxOutputBytes is truncated per stream; the command still runs to completion", async () => {
  await withHarness({}, async ({ prims, source }) => {
    const r = await prims.exec(
      node(
        "process.stdout.write('o'.repeat(65536)); process.stderr.write('e'.repeat(300));" +
          "require('fs').writeFileSync('finished', 'yes')",
      ),
      { maxOutputBytes: 1000 },
    );
    assert.equal(r.exitCode, 0, "not killed for its output");
    assert.equal(readFileSync(join(source, "finished"), "utf8"), "yes");
    assert.equal(r.stdout, "o".repeat(1000), "the first maxOutputBytes are kept");
    assert.equal(r.stderr, "e".repeat(300), "each stream has its own cap");
    assert.equal(r.truncated, true);

    // A cut through a multi-byte character drops it rather than garbling it.
    const utf8 = await prims.exec(node("process.stdout.write('é'.repeat(100))"), { maxOutputBytes: 5 });
    assert.equal(utf8.stdout, "éé");
    assert.equal(utf8.truncated, true);
    const fits = await prims.exec(node("process.stdout.write('é'.repeat(100))"), { maxOutputBytes: 200 });
    assert.equal(fits.stdout, "é".repeat(100));
    assert.equal(fits.truncated, false);
  });
});

// --- pause, stop, limits ----------------------------------------------------------

test("a paused run holds exec at the checkpoint; it starts on resume", async () => {
  const control = new MemoryControl();
  await withHarness({ control }, async ({ prims, sink }) => {
    control.pause();
    const held = prims.exec(node("process.stdout.write('ran')"));
    for (let i = 0; i < 5; i++) await nextTurn();
    assert.equal(sink.ofType(COMMAND_STARTED).length, 0, "nothing starts while paused");
    control.resume();
    assert.equal((await held).stdout, "ran");
    assert.equal(sink.ofType(COMMAND_STARTED).length, 1);
  });
});

test("a stop kills a running exec's process group at once, even with no agent running", POSIX_ONLY, async () => {
  const control = new MemoryControl();
  await withHarness({ control }, async ({ prims, sink, source, ctx }) => {
    const running = prims.exec("sleep 30 & echo $! > sleeper.pid; wait");
    const pidFile = join(source, "sleeper.pid");
    assert.ok(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""));
    const sleeper = Number(readFileSync(pidFile, "utf8").trim());
    const stoppedAt = Date.now();
    control.stop();
    await assert.rejects(running, RunStopped);
    assert.ok(Date.now() - stoppedAt < 5000, "the stop was not honoured promptly");
    assert.ok(await eventually(() => !isRunning(sleeper)), `sleeper ${sleeper} survived the stop`);
    assert.ok(ctx.scheduler.fatalError instanceof RunStopped, "the stop is the run's outcome");
    assert.match(String(sink.ofType(COMMAND_FAILED)[0]!.error), /^aborted: run was stopped/);
    await assert.rejects(prims.exec(node("")), RunStopped, "later steps fail fast");
    assert.equal(sink.ofType(COMMAND_STARTED).length, 1);
  });
});

test("exec takes no agent slot and does not count toward maxAgents", async () => {
  await withHarness({ concurrency: 1, maxAgents: 1 }, async ({ prims, ctx }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    ctx.bridge = {
      adapterFor: (name?: string | null) => resolveAdapter(ctx.config, name),
      run: async () => {
        calls++;
        await held;
        return { value: "fixed", text: "fixed", adapter: "claude", attempts: 1, notes: [] };
      },
    } as unknown as Bridge;
    const agentDone = prims.agent("hold the only slot");
    assert.ok(await eventually(() => calls === 1));
    const r = await prims.exec(node("process.stdout.write('beside the agent')"));
    assert.equal(r.stdout, "beside the agent", "ran while the agent held the only slot");
    release();
    assert.equal(await agentDone, "fixed");
    assert.equal(ctx.scheduler.dispatched, 1, "commands are not dispatches");
    assert.equal((await prims.exec(node(""))).exitCode, 0, "the spent backstop does not stop commands");
    assert.equal(await ctx.scheduler.drain(1000), true);
  });
});

// --- events -----------------------------------------------------------------------

test("events carry commandId (in call order), label, phase and the command, clipped for display", async () => {
  await withHarness({}, async ({ prims, sink, ctx }) => {
    prims.phase("Test");
    await prims.exec(node("", "x".repeat(300)));
    await prims.exec(node("", "it's here"), { label: "smoke", phase: "Verify" });
    const started = sink.ofType(COMMAND_STARTED);
    assert.deepEqual(started.map((e) => e.commandId), [1, 2]);
    const [long, labelled] = started as [WorkflowEvent, WorkflowEvent];
    assert.equal(long.phase, "Test");
    assert.equal(Array.from(String(long.command)).length, 200, "the command is clipped to 200 characters");
    assert.ok(String(long.command).endsWith("…"));
    assert.equal(Array.from(String(long.label)).length, 40, "the default label is the command's first 40");
    assert.ok(String(long.command).startsWith(String(long.label).slice(0, -1)));
    assert.equal(labelled.label, "smoke");
    assert.equal(labelled.phase, "Verify");
    assert.ok(String(labelled.command).endsWith(` -e '' 'it'\\''s here'`), "argv is shown shell-quoted");
    const finished = sink.ofType(COMMAND_FINISHED);
    assert.deepEqual(finished.map((e) => [e.commandId, e.exitCode]), [[1, 0], [2, 0]]);
    assert.ok(finished.every((e) => typeof e.durationMs === "number"));
    assert.equal(ctx.seq.value, 0, "agent ids are a sequence of their own");
  });
});

// --- through the worker -------------------------------------------------------------

function workerRun(source: string, body: string): { store: RunStore; id: string } {
  const store = new RunStore(join(source, "runs"));
  const script = join(source, "wf.js");
  writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\n" + body);
  return { store, id: store.create({ script, args: null, source, configPath: null }) };
}

test("a run's exec steps land in its events, fold into command nodes, and are drained before it ends", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-exec-run-"));
  try {
    const { store, id } = workerRun(
      root,
      [
        "phase('Build')",
        `const ok = await exec(${JSON.stringify(node("process.stdout.write('built')"))}, { label: 'build' })`,
        `const bad = await exec(${JSON.stringify(node("process.exit(2)"))}, { label: 'lint' })`,
        "// started, never awaited: still this run's work",
        `exec(${JSON.stringify(node("setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 200)"))}, { label: 'late' })`,
        "return { out: ok.stdout, code: bad.exitCode }",
      ].join("\n"),
    );
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readResult(id), { out: "built", code: 2 });
    assert.ok(existsSync(join(root, "late.txt")), "the un-awaited step finished before the run was recorded");
    const types = store.readEvents(id).map((e) => e.type);
    assert.ok(types.lastIndexOf("command_finished") < types.indexOf("run_finished"));

    const d = detail(store, id);
    assert.deepEqual(
      d.agents.map((a) => [a.kind, a.label, a.phase, a.state, a.exitCode]),
      [
        ["command", "build", "Build", "done", 0],
        ["command", "lint", "Build", "failed", 2],
        ["command", "late", "Build", "done", 0],
      ],
    );
    assert.deepEqual(d.counts, { agents: 3, running: 0, done: 2, failed: 1, stale: 0 });
    assert.equal(store.readStatus(id).dispatched, 0, "no agent was dispatched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested workflow()'s exec runs in the child's phase lane and shares the run's command ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-exec-run-"));
  try {
    writeFileSync(
      join(root, "child.js"),
      "export const meta = { name: 'child', description: 'd' }\nphase('Check')\n" +
        `return (await exec(${JSON.stringify(node("process.stdout.write('from the child')"))})).stdout`,
    );
    const { store, id } = workerRun(
      root,
      `await exec(${JSON.stringify(node(""))}, { label: 'parent' })\nreturn await workflow({ scriptPath: 'child.js' })`,
    );
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.equal(store.readResult(id), "from the child");
    const started = store.readEvents(id).filter((e) => e.type === "command_started");
    assert.deepEqual(
      started.map((e) => [e.commandId, e.phase]),
      [
        [1, null],
        [2, "▸ child · Check"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw stop reaches a running exec through the run's control file", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-exec-run-"));
  try {
    const { store, id } = workerRun(root, "await exec('sleep 30 & echo $! > sleeper.pid; wait')\nreturn 'never'");
    const run = executeRun(store.runDir(id));
    const pidFile = join(root, "sleeper.pid");
    assert.ok(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 10_000));
    const sleeper = Number(readFileSync(pidFile, "utf8").trim());
    store.writeControl(id, "stop");
    assert.equal(await run, "stopped");
    assert.ok(await eventually(() => !isRunning(sleeper)), `sleeper ${sleeper} survived the stop`);
    assert.equal(detail(store, id).agents[0]!.state, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing script kills the commands it left running", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-exec-run-"));
  try {
    const { store, id } = workerRun(
      root,
      [
        "exec('sleep 30 & echo $! > sleeper.pid; wait', { label: 'sleeper' })",
        "for (let i = 0; i < 500 && (await exec('test -s sleeper.pid')).exitCode !== 0; i++) {}",
        "throw new Error('boom')",
      ].join("\n"),
    );
    const started = Date.now();
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.ok(Date.now() - started < 10_000, "the left-over command did not hold the run open");
    const sleeper = Number(readFileSync(join(root, "sleeper.pid"), "utf8").trim());
    assert.ok(await eventually(() => !isRunning(sleeper)), `sleeper ${sleeper} outlived its run`);
    const failed = store.readEvents(id).find((e) => e.type === "command_failed" && e.label === "sleeper");
    assert.match(String(failed?.error), /^aborted: the workflow failed: boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- read models: fold, counts, activity ----------------------------------------------

const cmd = (type: string, commandId: number, ts: number, extra: Record<string, unknown> = {}): WorkflowEvent => ({
  ts,
  type,
  commandId,
  label: "npm test",
  phase: "Test",
  command: "npm test",
  ...extra,
});

test("command events fold into kind: 'command' nodes, counted with the agents", () => {
  const nodes = foldAgents([
    { ts: 1, type: "phase_started", phase: "Test" },
    cmd("command_started", 1, 1),
    { ts: 1.5, type: "agent_started", agentId: 1, label: "fixer", phase: "Fix", adapter: "mock" },
    cmd("command_failed", 1, 3, { exitCode: 1, durationMs: 1987, error: "exited with code 1" }),
    { ts: 4, type: "agent_finished", agentId: 1, label: "fixer", phase: "Fix", adapter: "mock", attempts: 1 },
    cmd("command_started", 2, 5),
    cmd("command_finished", 2, 6, { exitCode: 0, durationMs: 1000 }),
    cmd("command_started", 3, 7, { label: "lint", command: "npm run lint" }),
  ]);
  assert.deepEqual(
    nodes.map((n) => [n.kind, n.label, n.state, n.exitCode]),
    [
      ["command", "npm test", "failed", 1],
      ["agent", "fixer", "done", undefined],
      ["command", "npm test", "done", 0],
      ["command", "lint", "running", null],
    ],
  );
  const [first, agent, second] = nodes as [(typeof nodes)[0], (typeof nodes)[0], (typeof nodes)[0]];
  assert.equal(first.durationMs, 1987, "the command's own measurement wins over the timestamps");
  assert.equal(first.error, "exited with code 1");
  assert.deepEqual([first.agentId, first.commandId, first.adapter, first.attempts], [null, 1, null, null]);
  assert.equal(second.error, null);
  assert.equal(agent.agentId, 1);
  assert.equal(agent.commandId, undefined, "agents carry no command fields");
  assert.deepEqual(countAgents(nodes), { agents: 4, running: 1, done: 2, failed: 1, stale: 0 });
});

test("legacy agent events never settle a command node with the same label", () => {
  const nodes = foldAgents([
    cmd("command_started", 1, 1, { label: "build" }),
    { ts: 2, type: "agent_started", label: "build", phase: "Test" },
    { ts: 3, type: "agent_finished", label: "build", phase: "Test", adapter: "x", attempts: 1 },
  ]);
  assert.deepEqual(
    nodes.map((n) => [n.kind, n.state]),
    [
      ["command", "running"],
      ["agent", "done"],
    ],
  );
});

test("run summaries count command nodes; a dead worker leaves open commands stale", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-exec-view-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: root });
    store.updateStatus(id, { state: "running" }); // no pid: the worker is gone
    for (const ev of [
      cmd("command_started", 1, 1),
      cmd("command_finished", 1, 2, { exitCode: 0, durationMs: 900 }),
      cmd("command_started", 2, 3),
    ]) {
      appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
    }
    const s = summarize(store, id);
    assert.equal(s.state, "stale");
    assert.deepEqual(s.counts, { agents: 2, running: 0, done: 1, failed: 0, stale: 1 });
    assert.equal(s.progress, 0.5);
    assert.deepEqual(
      detail(store, id).agents.map((a) => [a.kind, a.state, a.exitCode]),
      [
        ["command", "done", 0],
        ["command", "stale", null],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the activity fleet counts running agents only, not running commands", () => {
  const nodes = foldAgents([
    { ts: 1, type: "agent_started", agentId: 1, label: "a", adapter: "codex" },
    cmd("command_started", 1, 1),
  ]);
  const run = { runId: "r1", name: "wf", state: "running", provider: "odw", counts: countAgents(nodes) } as RunSummary;
  const source = {
    owns: () => true,
    eventLog: () => [],
    detail: () => ({ agents: nodes }),
  } as unknown as RunSource;
  assert.deepEqual(activityView([source], [run], 10).fleet, { codex: 1 });
});

// --- CLI: odw logs and the live view -------------------------------------------------------

test("odw logs narrates command steps: what ran, then how it ended", () => {
  const line = (ev: WorkflowEvent) => formatEvent(ev).replace(/^\[[^\]]*\] /, "");
  assert.equal(line(cmd("command_started", 1, 1)), "command_started (Test) $ npm test");
  assert.equal(
    line(cmd("command_started", 2, 1, { label: "tests r2", command: "npm test -- --bail" })),
    "command_started (Test) tests r2 — $ npm test -- --bail",
  );
  assert.equal(
    line(cmd("command_finished", 1, 2, { exitCode: 0, durationMs: 3200 })),
    "command_finished (Test) $ npm test — exit 0 (3.2s)",
  );
  assert.equal(
    line(cmd("command_failed", 2, 2, { label: "tests r2", exitCode: null, durationMs: 600_000, error: "timed out after 600s" })),
    "command_failed  (Test) tests r2 — timed out after 600s (10:00)",
  );
  // A default label is the command clipped: shown once, in full.
  const long = "npm run test -- --reporter=dot --coverage --maxWorkers=2";
  assert.equal(
    line(cmd("command_started", 3, 1, { label: long.slice(0, 39) + "…", command: long })),
    `command_started (Test) $ ${long}`,
  );
});

test("attachRun (live): command steps settle with a $ prompt and their failure reason", async () => {
  const store = new RunStore(mkdtempSync(join(tmpdir(), "odw-exec-live-")));
  try {
    const runId = store.create({ script: "/tmp/never-read/wf.js", args: null, source: process.cwd(), workflowName: "loop" });
    store.updateStatus(runId, { state: "running", pid: process.pid, name: "loop" });
    for (const ev of [
      { ts: 100, type: "run_started", runId },
      { ts: 100, type: "phase_started", phase: "Test" },
      cmd("command_started", 1, 100),
      cmd("command_failed", 1, 102, { exitCode: 1, durationMs: 2000, error: "exited with code 1" }),
      { ts: 102, type: "agent_started", agentId: 1, label: "fixer", phase: "Test", adapter: "fake" },
      { ts: 110, type: "agent_finished", agentId: 1, label: "fixer", phase: "Test", adapter: "fake", attempts: 1 },
      cmd("command_started", 2, 110),
      cmd("command_finished", 2, 111, { exitCode: 0, durationMs: 1000 }),
      { ts: 111, type: "run_finished", runId },
    ]) {
      appendFileSync(store.eventsPath(runId), JSON.stringify(ev) + "\n");
    }
    store.writeResult(runId, { passed: true });
    store.updateStatus(runId, { state: "done" });

    const term = new FakeTerm(100);
    const out = { text: "", isTTY: false, write(s: string) { this.text += s; } };
    const env = { TERM: "xterm", LANG: "en_US.UTF-8" };
    assert.equal(await attachRun(store, runId, { out, err: term, live: true, pollMs: 10, signals: false, env }), 0);
    const screen = term.text();
    assert.match(screen, /✖ \$ npm test\s+2\.0s\n\s+exited with code 1/);
    assert.match(screen, /✔ fixer/);
    assert.match(screen, /✔ \$ npm test\s+1\.0s/);
    assert.match(screen, /✔ done\s+.*1 agents.*2 commands/);
    assert.deepEqual(JSON.parse(out.text), { passed: true });
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});

// --- authoring: injection, portability, SEA ----------------------------------------------

test("exec is injected unless the script declares its own (which then wins, as on Claude Code)", async () => {
  const seen: unknown[] = [];
  const globals = {
    agent: async () => "",
    parallel: async () => [],
    pipeline: async () => [],
    phase: () => {},
    log: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    workflow: async () => null,
    validate: () => ({ ok: true, errors: [], warnings: [] }),
    exec: async (command: unknown) => {
      seen.push(command);
      return { stdout: "OUT" } as ExecResult;
    },
  } as unknown as WorkflowGlobals;
  assert.equal(await loadWorkflowScript(META + "return (await exec('npm test')).stdout", "wf.js").run(globals, null), "OUT");
  assert.deepEqual(seen, ["npm test"]);
  const own = loadWorkflowScript(META + "const exec = (c) => 'own:' + c\nreturn exec('x')", "wf.js");
  assert.equal(await own.run(globals, null), "own:x");
  // Each extension is injected on its own: declaring validate leaves exec in place.
  const mixed = loadWorkflowScript(
    META + "function validate() { return 'mine' }\nreturn validate() + ':' + (await exec('y')).stdout",
    "wf.js",
  );
  assert.equal(await mixed.run(globals, null), "mine:OUT");
});

test("the dual-compat scan flags exec() as not portable to Claude Code", () => {
  const flagged = (body: string) => scanDualCompat(META + body).filter((w) => /exec\(\)/.test(w));
  assert.equal(flagged("await exec('npm test')\nreturn 1").length, 1);
  assert.equal(flagged("const r = await exec(['npm', 'test'], { check: true })").length, 1);
  assert.equal(flagged("log(`${(await exec('date')).stdout}`)").length, 1, "an interpolation is still code");
  for (const portable of [
    "const m = /a(b)/.exec('ab')\nreturn m",
    "const m = re . exec('ab')",
    "const m = re?.exec('ab')",
    "// await exec('npm test')\nreturn 1",
    "log('exec(npm test)')",
    "myexec(1); $exec(2)",
    "const exec = (c) => c\nreturn exec('mine')",
    "function exec(c) { return c }\nreturn exec('mine')",
  ]) {
    assert.deepEqual(flagged(portable), [], portable);
  }
  const report = createPrimitives(buildContext(defaultConfig())).validate(META + "return await exec('npm test')");
  assert.equal(report.ok, true, "a warning, not an error: odw runs it");
  assert.match(report.warnings.join("\n"), /exec\(\) is an ODW extension, not portable to Claude Code/);
});

test("SEA-safe: child_process is only ever imported statically", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = (readdirSync(srcDir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(srcDir, f))
    .filter((f) => statSync(f).isFile());
  assert.ok(files.length > 20);
  for (const file of files) {
    const code = maskCode(readFileSync(file, "utf8")); // comments and strings blanked
    assert.doesNotMatch(code, /\bimport\s*\(|\brequire\s*\(/, `${file}: dynamic import() or require()`);
  }
  const exec = readFileSync(join(srcDir, "exec.ts"), "utf8");
  assert.match(exec, /^import \{ spawn, type ChildProcess \} from "node:child_process";$/m);
});
