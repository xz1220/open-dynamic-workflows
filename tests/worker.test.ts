import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "odw-wt-"));
  return { root, store: new RunStore(root) };
}

test("executeRun runs a no-agent workflow to done with a result", async () => {
  const { root, store } = setup();
  try {
    const script = join(root, "wf.js");
    writeFileSync(
      script,
      "export const meta = { name: 't', description: 'd' }\nlog('hi')\nreturn { ok: args.n + 1 }",
    );
    const id = store.create({ script, args: { n: 41 }, source: root });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "done");
    assert.equal(store.readStatus(id).state, "done");
    assert.deepEqual(store.readResult(id), { ok: 42 });
    assert.equal(store.readStatus(id).name, "t");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun captures a thrown workflow as failed", async () => {
  const { root, store } = setup();
  try {
    const script = join(root, "boom.js");
    writeFileSync(script, "export const meta = { name: 'b', description: 'd' }\nthrow new Error('kaboom')");
    const id = store.create({ script, args: null, source: root });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "failed");
    assert.match(String(store.readError(id)?.error), /kaboom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun records a workflow that throws a non-Error value as failed", async () => {
  const { root, store } = setup();
  try {
    for (const thrown of ["null", "undefined", "'plain string'", "42"]) {
      const script = join(root, "odd.js");
      writeFileSync(script, `export const meta = { name: 'o', description: 'd' }\nthrow ${thrown}`);
      const id = store.create({ script, args: null, source: root });
      const state = await executeRun(store.runDir(id));
      assert.equal(state, "failed", `throw ${thrown}`);
      assert.equal(typeof store.readError(id)?.error, "string", `throw ${thrown}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun drives a real agent call through a mock adapter", async () => {
  const { root, store } = setup();
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "mock",
        workspaceMode: "inplace",
        adapters: {
          mock: {
            command: [
              execPath,
              "-e",
              "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('echo:'+d))",
            ],
            stdin: "{prompt}",
          },
        },
      }),
    );
    const script = join(root, "agentwf.js");
    writeFileSync(
      script,
      "export const meta = { name: 'a', description: 'd' }\nconst r = await agent('PING')\nreturn r",
    );
    const id = store.create({ script, args: null, source: root, configPath: config });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "done");
    const r = String(store.readResult(id));
    assert.match(r, /echo:/);
    assert.match(r, /PING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun logs a meta.name / filename divergence as an event", async () => {
  const { root, store } = setup();
  try {
    const script = join(root, "ai-news.js"); // stem 'ai-news' ≠ meta.name
    writeFileSync(script, "export const meta = { name: 'ai-news-v2', description: 'd' }\nreturn 1");
    const id = store.create({ script, args: null, source: root });
    await executeRun(store.runDir(id));
    const logs = store.readEvents(id).filter((e) => e.type === "log");
    assert.ok(
      logs.some((e) => /declares meta\.name 'ai-news-v2'/.test(String(e.message))),
      "divergence note should be emitted through the event stream",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent that fails before the script awaits it does not crash the worker", async () => {
  const { root, store } = setup();
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "mock",
        adapters: {
          mock: { command: [execPath, "-e", "setTimeout(() => process.stdout.write('ok'), 300)"] },
          broken: { command: [execPath, "-e", "process.exit(3)"] },
        },
      }),
    );
    const run = (body: string) => {
      const script = join(root, "wf.js");
      writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
      const id = store.create({ script, args: null, source: root, configPath: config });
      return { id, state: executeRun(store.runDir(id)) };
    };

    // The early agent fails (recoverably) while `agent('b')` is still running.
    const recoverable = run(
      "const early = agent('a', { adapter: 'broken' })\nconst b = await agent('b')\n" +
        "try { await early } catch {}\nreturn b",
    );
    assert.equal(await recoverable.state, "done");
    assert.equal(store.readResult(recoverable.id), "ok");

    // The review's reproduction. An unknown adapter is a fatal config error:
    // the run ends failed (recorded, not stuck at "running").
    const fatal = run(
      "const early = agent('a', { adapter: 'bad' })\nawait agent('b')\ntry { await early } catch {}\nreturn 'finished'",
    );
    const state = await fatal.state;
    assert.ok(TERMINAL_STATES.has(state));
    assert.equal(state, "failed");
    assert.equal(store.readStatus(fatal.id).state, "failed");
    assert.match(String(store.readError(fatal.id)?.error), /unknown adapter 'bad'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stray rejection or exception fails the run instead of killing the worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-crash-"));
  try {
    const cases: Array<[string, RegExp]> = [
      [
        "Promise.reject(new Error('stray'))\nawait new Promise((r) => setTimeout(r, 200))\nreturn 1",
        /crashed with an unhandled promise rejection: stray/,
      ],
      [
        "setTimeout(() => { throw new Error('timer boom') }, 0)\nawait new Promise((r) => setTimeout(r, 200))\nreturn 1",
        /crashed with an uncaught exception: timer boom/,
      ],
    ];
    for (const [body, expected] of cases) {
      // A real worker process: the guard is process-wide, and this test
      // process has listeners of its own.
      const { runId, store } = startRunFromSource(`export const meta = { name: 'crash', description: 'd' }\n${body}`, {
        runsRoot: root,
      });
      const status = await waitFor(store, runId, { timeoutMs: 20_000, pollIntervalMs: 50 });
      assert.equal(status.state, "failed", JSON.stringify(status));
      assert.equal(store.readStatus(runId).state, "failed", "the worker recorded it itself");
      assert.match(String(store.readError(runId)?.error), expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test(
  "a stop request kills running agents, removes their worktrees, and ends the run stopped",
  { skip: process.platform === "win32" },
  async () => {
    const { root, store } = setup();
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      writeFileSync(join(repo, "a.txt"), "a\n");
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      git("init", "-q");
      git("add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
      // Each agent leaves a grandchild behind that shares its pipes, like a CLI
      // running a tool; its pid lands in `pids`.
      const pids = join(root, "pids");
      const config = join(root, "odw.config.json");
      writeFileSync(
        config,
        JSON.stringify({
          defaultAdapter: "slow",
          concurrency: 2, // auto concurrency is 1 on a small machine
          adapters: { slow: { command: ["sh", "-c", `sleep 30 & echo $! >> '${pids}'; wait`] } },
        }),
      );
      const script = join(root, "wf.js");
      writeFileSync(
        script,
        "export const meta = { name: 'wf', description: 'd' }\n" +
          "return await parallel([() => agent('a', { isolation: 'worktree' }), () => agent('b', { isolation: 'worktree' })])\n",
      );
      const id = store.create({ script, args: null, source: repo, configPath: config });
      const run = executeRun(store.runDir(id));

      const recorded = () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : []);
      assert.ok(await waitUntil(() => recorded().length === 2, 15_000), "both agents should be running");
      const worktrees = git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .filter((path) => path !== realpathSync(repo));
      assert.equal(worktrees.length, 2);

      const stoppedAt = Date.now();
      store.writeControl(id, "stop");
      assert.equal(await run, "stopped");
      assert.ok(Date.now() - stoppedAt < 5000, `the stop took ${Date.now() - stoppedAt}ms to take effect`);
      assert.equal(store.readStatus(id).state, "stopped");

      for (const pid of recorded()) {
        assert.ok(await waitUntil(() => !isRunning(pid), 2000), `agent process ${pid} outlived the stop`);
      }
      for (const path of worktrees) assert.equal(existsSync(path), false, `worktree ${path} was left behind`);
      assert.equal(git("worktree", "list", "--porcelain").trim().split("\n\n").length, 1, "no stale registrations");

      // No agent is left displayed as running.
      const events = store.readEvents(id);
      const ids = (type: string) => events.filter((e) => e.type === type).map((e) => e.agentId).sort();
      assert.deepEqual(ids("agent_failed"), ids("agent_started"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("agents a script never awaited finish before the run is recorded done", async () => {
  const { root, store } = setup();
  try {
    const marker = join(root, "finished");
    const config = join(root, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "late",
        adapters: {
          late: {
            command: [
              execPath,
              "-e",
              `setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('ok') }, 300)`,
            ],
          },
        },
      }),
    );
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nagent('fire and forget')\nreturn 'early'");
    const id = store.create({ script, args: null, source: root, configPath: config });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.ok(existsSync(marker), "the agent ran to completion");
    const types = store.readEvents(id).map((e) => e.type);
    assert.ok(types.indexOf("agent_finished") < types.indexOf("run_finished"), types.join(","));
    assert.equal(store.readResult(id), "early");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing script kills the agents it left running", async () => {
  const { root, store } = setup();
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "hang",
        adapters: { hang: { command: [execPath, "-e", "setTimeout(() => {}, 30000)"] } },
      }),
    );
    const script = join(root, "wf.js");
    writeFileSync(
      script,
      "export const meta = { name: 'wf', description: 'd' }\n" +
        "agent('left running')\n" +
        "await new Promise((r) => setTimeout(r, 200))\n" +
        "throw new Error('boom')\n",
    );
    const id = store.create({ script, args: null, source: root, configPath: config });
    const started = Date.now();
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.ok(Date.now() - started < 5000, "the run waited on its abandoned agent");
    assert.match(String(store.readError(id)?.error), /boom/);
    const failed = store.readEvents(id).filter((e) => e.type === "agent_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]!.error), /the workflow failed: boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A run whose agents reply with 40 characters (10 estimated tokens) each. */
function swallowRun(root: string, store: RunStore, body: string, options: { maxAgents?: number; budgetTotal?: number; slow?: boolean } = {}) {
  const config = join(root, "odw.config.json");
  const reply = options.slow ? "setTimeout(() => {}, 30000)" : "process.stdout.write('x'.repeat(40))";
  writeFileSync(
    config,
    JSON.stringify({
      defaultAdapter: "mock",
      ...(options.maxAgents ? { maxAgents: options.maxAgents } : {}),
      adapters: { mock: { command: [execPath, "-e", reply] } },
    }),
  );
  const script = join(root, `wf-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const id = store.create({ script, args: null, source: root, configPath: config, budgetTotal: options.budgetTotal ?? null });
  return id;
}

const discardedNote = (store: RunStore, id: string) =>
  store.readEvents(id).some((e) => e.type === "log" && /returned after the run ended.*discarded/.test(String(e.message)));

test("a swallowed budget or cap error still fails the run, without a result", async () => {
  const { root, store } = setup();
  try {
    const budget = swallowRun(root, store, "await agent('one')\ntry { await agent('two') } catch {}\nreturn 'partial'", {
      budgetTotal: 1,
    });
    assert.equal(await executeRun(store.runDir(budget)), "failed");
    assert.match(String(store.readError(budget)?.error), /budget ceiling/);
    assert.equal(store.hasResult(budget), false, "result.json is for successful runs only");
    assert.ok(discardedNote(store, budget));

    const cap = swallowRun(root, store, "await agent('a')\ntry { await agent('b') } catch {}\nreturn 'x'", { maxAgents: 1 });
    assert.equal(await executeRun(store.runDir(cap)), "failed");
    assert.match(String(store.readError(cap)?.error), /cap of 1 agent dispatches/);
    assert.equal(store.readStatus(cap).state, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a swallowed stop still ends the run stopped", async () => {
  const { root, store } = setup();
  try {
    const id = swallowRun(root, store, "try { await agent('slow') } catch {}\nreturn 'swallowed'", { slow: true });
    const run = executeRun(store.runDir(id));
    const started = () => store.readEvents(id).some((e) => e.type === "agent_started");
    assert.ok(await waitUntil(started, 10_000), "the agent should be running");
    store.writeControl(id, "stop");
    assert.equal(await run, "stopped");
    assert.equal(store.readStatus(id).state, "stopped");
    assert.equal(store.hasResult(id), false);
    assert.ok(discardedNote(store, id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first fatal error stays the outcome when the script then fails differently", async () => {
  const { root, store } = setup();
  try {
    const id = swallowRun(
      root,
      store,
      "await agent('a')\ntry { await agent('b') } catch {}\nthrow new TypeError('later bug')",
      { maxAgents: 1 },
    );
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.match(String(store.readError(id)?.error), /cap of 1 agent dispatches/);
    assert.ok(
      store.readEvents(id).some((e) => e.type === "log" && /also failed: later bug/.test(String(e.message))),
      "the script's own error is still reported",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun stays quiet when meta.name matches the filename stem", async () => {
  const { root, store } = setup();
  try {
    const script = join(root, "match.js");
    writeFileSync(script, "export const meta = { name: 'match', description: 'd' }\nreturn 1");
    const id = store.create({ script, args: null, source: root });
    await executeRun(store.runDir(id));
    const logs = store.readEvents(id).filter((e) => e.type === "log");
    assert.equal(
      logs.some((e) => /declares meta\.name/.test(String(e.message))),
      false,
      "no divergence note when name === stem",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
