import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import type { RunStore } from "../src/runtime/run-store.js";

// A real worker process (the signal handlers are process-wide) whose agent CLI
// leaves a long-lived grandchild behind, like a CLI running a tool. Killing the
// worker outright would orphan both: they lead their own process group.

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

function setup(script: string) {
  const root = mkdtempSync(join(tmpdir(), "odw-signal-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  const pids = join(root, "pids");
  const hookLog = join(root, "hook.log");
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "slow",
      adapters: { slow: { command: ["sh", "-c", `sleep 30 & echo $! >> '${pids}'; wait`] } },
      notify: { command: ["sh", "-c", `echo "$ODW_RUN_STATE" >> '${hookLog}'`] },
    }),
  );
  const { runId, store } = startRunFromSource(`export const meta = { name: 'sig', description: 'd' }\n${script}`, {
    runsRoot: join(root, "runs"),
    configPath,
    source: repo,
  });
  const worktrees = () =>
    git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((path) => path !== realpathSync(repo));
  const grandchild = () => (existsSync(pids) ? Number(readFileSync(pids, "utf8").trim().split("\n")[0]) : 0);
  return { root, store, runId, hookLog, worktrees, grandchild };
}

/** The running worker's pid, once it has recorded it. */
async function workerPid(store: RunStore, runId: string): Promise<number> {
  assert.ok(await waitUntil(() => typeof store.readStatus(runId).pid === "number", 20_000), "the worker never started");
  return store.readStatus(runId).pid as number;
}

const logged = (store: RunStore, runId: string, message: string) =>
  store.readEvents(runId).some((e) => e.type === "log" && e.message === message);

test(
  "SIGTERM stops a worker's run like odw stop: agents and grandchildren die, worktrees go, hooks fire once",
  { skip: process.platform === "win32" },
  async () => {
    const { root, store, runId, hookLog, worktrees, grandchild } = setup(
      "return await agent('work', { isolation: 'worktree' })",
    );
    try {
      assert.ok(await waitUntil(() => grandchild() > 0, 20_000), "the agent should be running");
      const tool = grandchild();
      assert.equal(worktrees().length, 1, "the agent runs in its own worktree");
      const worker = await workerPid(store, runId);

      process.kill(worker, "SIGTERM");
      const status = await waitFor(store, runId, { timeoutMs: 20_000, pollIntervalMs: 50 });
      assert.equal(status.state, "stopped");
      assert.ok(await waitUntil(() => !isRunning(tool), 5000), `grandchild ${tool} outlived the worker's stop`);
      assert.ok(await waitUntil(() => !isRunning(worker), 15_000), "the worker exits once the run is recorded");
      assert.deepEqual(worktrees(), [], "the agent's worktree was removed");

      assert.ok(logged(store, runId, "worker received SIGTERM — stopping the run"));
      const events = store.readEvents(runId);
      assert.equal(events[events.length - 1]!.type, "run_stopped");
      assert.match(String(events.find((e) => e.type === "agent_failed")?.error), /worker received SIGTERM/);
      assert.equal(readFileSync(hookLog, "utf8"), "stopped\n", "the notify hook fired once, for the stop");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a second signal makes a worker whose run will not end exit at once, recorded stopped",
  { skip: process.platform === "win32" },
  async () => {
    // The agent is never awaited and the script sleeps: aborting the agents
    // does not end the run.
    const { root, store, runId, grandchild } = setup(
      "agent('left running')\nawait new Promise((r) => setTimeout(r, 60000))\nreturn 'late'",
    );
    try {
      assert.ok(await waitUntil(() => grandchild() > 0, 20_000), "the agent should be running");
      const tool = grandchild();
      const worker = await workerPid(store, runId);

      process.kill(worker, "SIGTERM");
      assert.ok(await waitUntil(() => logged(store, runId, "worker received SIGTERM — stopping the run"), 10_000));
      assert.ok(await waitUntil(() => !isRunning(tool), 5000), `grandchild ${tool} survived the first signal`);
      assert.equal(store.readStatus(runId).state, "running", "the sleeping script keeps the run going");

      const forcedAt = Date.now();
      process.kill(worker, "SIGTERM");
      assert.ok(await waitUntil(() => !isRunning(worker), 5000), "the worker should exit at once");
      assert.ok(Date.now() - forcedAt < 5000);
      assert.equal(store.readStatus(runId).state, "stopped");
      assert.ok(logged(store, runId, "worker received SIGTERM again — killing the agents and exiting"));
      const events = store.readEvents(runId);
      assert.equal(events[events.length - 1]!.type, "run_stopped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
