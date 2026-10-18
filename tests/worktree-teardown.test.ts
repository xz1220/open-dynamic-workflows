import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { killAllAgentProcesses, runCommand } from "../src/adapters/runner.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { ConfigError, RunStopped } from "../src/errors.js";
import { formatGc, gcJson } from "../src/runtime/gc-cli.js";
import { planGc } from "../src/runtime/gc.js";
import { startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";
import { slotName, withSlot } from "../src/slot.js";
import { applyRunTrust, resolveRunTrust } from "../src/untrusted.js";
import { withWorkspace } from "../src/workspace.js";

// worktreeTeardown, ODW_SLOT / COMPOSE_PROJECT_NAME, and the compose projects
// `odw gc` reports (ODW extensions).

const POSIX_ONLY = { skip: process.platform === "win32" };
const ENV_AGENT = fileURLToPath(new URL("./fixtures/env-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-teardown-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return dir;
}

function worktrees(repo: string): number {
  return git(repo, "worktree", "list", "--porcelain").trim().split("\n\n").length;
}

async function eventually(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

interface Seen {
  cwd: string;
  tracked: boolean;
  slot: string | null;
  compose: string | null;
  agent: string | null;
}

/** A teardown argv that appends what it saw — its cwd, whether the checkout is still there, its variables — to `log`. */
function recorder(log: string): string[] {
  const body =
    "const fs = require('fs');" +
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), tracked: fs.existsSync('a.txt'),` +
    " slot: process.env.ODW_SLOT ?? null, compose: process.env.COMPOSE_PROJECT_NAME ?? null, agent: process.env.ODW_AGENT_ID ?? null }) + '\\n')";
  return [execPath, "-e", body];
}

function seen(log: string): Seen[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Seen) : [];
}

/** Run `f` with COMPOSE_PROJECT_NAME and ODW_SLOT out of this process's environment (the worker reads it). */
async function withoutComposeEnv<T>(f: () => Promise<T>): Promise<T> {
  const saved = { compose: process.env.COMPOSE_PROJECT_NAME, slot: process.env.ODW_SLOT };
  delete process.env.COMPOSE_PROJECT_NAME;
  delete process.env.ODW_SLOT;
  try {
    return await f();
  } finally {
    if (saved.compose !== undefined) process.env.COMPOSE_PROJECT_NAME = saved.compose;
    if (saved.slot !== undefined) process.env.ODW_SLOT = saved.slot;
  }
}

// --- the slot ------------------------------------------------------------------------

test("ODW_SLOT is odw-<the run id's random part>-<agent>, lowercase letters, digits and hyphens only", () => {
  assert.equal(slotName("20261018-093012-a1b2c3", 4), "odw-a1b2c3-4");
  assert.equal(slotName("20261018-093012-a1b2c3", 12), "odw-a1b2c3-12");
  assert.equal(slotName("My_Run.ID", 1), "odw-my-run-id-1", "another id's form, tidied");
  assert.equal(slotName("x".repeat(40), 2), `odw-${"x".repeat(12)}-2`, "kept short");
  assert.match(slotName(undefined, undefined), /^odw-p\d+-0$/, "outside a run, the process stands in");
  for (const name of [slotName("20261018-093012-a1b2c3", 4), slotName("A B C", "7"), slotName("--", 3)]) {
    assert.match(name, /^odw-[a-z0-9]+(?:-[a-z0-9]+)*$/, name);
  }
});

test("COMPOSE_PROJECT_NAME is the slot, over the user's own (said); an agent's inherited one is not kept", () => {
  const overridden: string[] = [];
  const said = (user: string) => overridden.push(user);
  assert.equal(withSlot({}, "odw-a1b2c3-1", said).COMPOSE_PROJECT_NAME, "odw-a1b2c3-1");
  // Kept, every agent would share the user's stack, and a teardown's `down -v` would remove it.
  assert.equal(withSlot({ COMPOSE_PROJECT_NAME: "mine" }, "odw-a1b2c3-1", said).COMPOSE_PROJECT_NAME, "odw-a1b2c3-1");
  assert.deepEqual(overridden, ["mine"]);
  assert.equal(withSlot({ COMPOSE_PROJECT_NAME: "" }, "odw-a1b2c3-1", said).COMPOSE_PROJECT_NAME, "odw-a1b2c3-1", "empty is unset");
  // A worker started by another run's agent inherits that agent's slot and project name.
  const inherited = { ODW_SLOT: "odw-ffffff-9", COMPOSE_PROJECT_NAME: "odw-ffffff-9" };
  assert.equal(withSlot(inherited, "odw-a1b2c3-1", said).COMPOSE_PROJECT_NAME, "odw-a1b2c3-1");
  assert.deepEqual(overridden, ["mine"], "neither an empty one nor an agent's is the user's");
  assert.equal("COMPOSE_PROJECT_NAME" in withSlot(inherited, undefined), false, "an agent without a slot does not keep it");
  assert.equal(withSlot({ COMPOSE_PROJECT_NAME: "mine" }, undefined).COMPOSE_PROJECT_NAME, "mine");
  assert.equal(inherited.COMPOSE_PROJECT_NAME, "odw-ffffff-9", "the base is not changed");
});

test("the bridge gives an isolated call ODW_SLOT and COMPOSE_PROJECT_NAME on every CLI run; an in-place call neither", async () => {
  const src = makeRepo();
  const cfg = defaultConfig();
  cfg.settings.defaultAdapter = "claude";
  const seenEnv: Array<Record<string, string> | undefined> = [];
  const replies = ["not json", '{"n":1}', "plain"];
  const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 });
  const bridge = new Bridge(cfg, {
    runId: "20261018-120000-abc123",
    source: src,
    runner: async (_command, options) => (seenEnv.push(options?.env), ok(replies.shift()!)),
  });
  try {
    await withoutComposeEnv(async () => {
      process.env.ODW_SLOT = process.env.COMPOSE_PROJECT_NAME = "odw-ffffff-9"; // as a worker started by an agent inherits
      const schema = { type: "object", properties: { n: { type: "number" } } };
      await bridge.run({ prompt: "x", isolation: "worktree", schema }, { agentId: 3 });
      assert.equal(seenEnv.length, 2, "a schema retry ran");
      for (const env of seenEnv) {
        assert.equal(env?.ODW_SLOT, "odw-abc123-3");
        assert.equal(env?.COMPOSE_PROJECT_NAME, "odw-abc123-3");
      }
      await bridge.run({ prompt: "y" }, { agentId: 4 });
      assert.equal(seenEnv[2]?.ODW_SLOT, undefined, "an agent in the source tree has no slot");
      assert.equal(seenEnv[2]?.COMPOSE_PROJECT_NAME, undefined, "nor the inherited project name");
    });
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a COMPOSE_PROJECT_NAME of the user's: every isolated agent gets its own slot instead, and the run says so once", async () => {
  const src = makeRepo();
  const cfg = defaultConfig();
  cfg.settings.defaultAdapter = "claude";
  const seenEnv: Array<Record<string, string> | undefined> = [];
  const notes: Array<[string, Record<string, unknown>]> = [];
  const bridge = new Bridge(cfg, {
    runId: "20261018-120000-abc123",
    source: src,
    onRunNote: (message, fields) => notes.push([message, fields]),
    runner: async (_command, options) => (
      seenEnv.push(options?.env), { returncode: 0, stdout: "ok", stderr: "", timedOut: false, duration: 0.01 }
    ),
  });
  try {
    await withoutComposeEnv(async () => {
      process.env.COMPOSE_PROJECT_NAME = "mine";
      await Promise.all([1, 2].map((agentId) => bridge.run({ prompt: "x", isolation: "worktree" }, { agentId })));
      assert.deepEqual(seenEnv.map((env) => env?.COMPOSE_PROJECT_NAME).sort(), ["odw-abc123-1", "odw-abc123-2"]);
      await bridge.run({ prompt: "y" }, { agentId: 3 });
      assert.equal(seenEnv[2]?.COMPOSE_PROJECT_NAME, "mine", "an agent without a slot keeps the user's");
    });
    assert.equal(notes.length, 1, "said once per run");
    assert.match(notes[0]![0], /COMPOSE_PROJECT_NAME=mine is set, but each isolated agent runs with its own ODW_SLOT/);
    assert.deepEqual(notes[0]![1], { composeProjectName: "mine" });
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

// --- the teardown --------------------------------------------------------------------

test("worktreeTeardown runs in the agent's workspace, worktree still whole, with its environment; then the worktree goes", async () => {
  const src = makeRepo();
  const log = join(mkdtempSync(join(tmpdir(), "odw-teardown-log-")), "seen.jsonl");
  let path = "";
  try {
    const out = await withWorkspace(src, "worktree", async (ws) => ((path = ws.path), "the reply"), {
      teardown: recorder(log),
      env: { ...process.env, ODW_SLOT: "odw-abc123-1", COMPOSE_PROJECT_NAME: "odw-abc123-1" } as Record<string, string>,
    });
    assert.equal(out, "the reply");
    const [one, ...rest] = seen(log);
    assert.deepEqual(rest, [], "once");
    assert.match(one!.cwd, /odw-wt-/, "in the worktree");
    assert.equal(one!.cwd.endsWith(path.split(/[\\/]/).pop()!), true, one!.cwd);
    assert.equal(one!.tracked, true, "the checkout was still there");
    assert.deepEqual([one!.slot, one!.compose], ["odw-abc123-1", "odw-abc123-1"]);
    assert.equal(existsSync(path), false, "removed after");
    assert.equal(worktrees(src), 1);

    // A string runs through the shell.
    const marker = join(src, "..", `${path.split(/[\\/]/).pop()}-shell-${Date.now()}`);
    await withWorkspace(src, "worktree", async () => {}, { teardown: `echo down> "${marker}"` });
    assert.equal(readFileSync(marker, "utf8").trim(), "down");
    rmSync(marker, { force: true });
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(join(log, ".."), { recursive: true, force: true });
  }
});

test("a teardown runs after a failed setup and after a stop too; a failing or hung one is noted, the call's outcome stands", async () => {
  const src = makeRepo();
  const log = join(mkdtempSync(join(tmpdir(), "odw-teardown-log-")), "seen.jsonl");
  const notes: string[] = [];
  const onNote = (m: string) => notes.push(m);
  try {
    // A setup that failed half-way may have started something: the teardown still runs.
    await assert.rejects(
      withWorkspace(src, "worktree", async () => assert.fail("never starts"), {
        command: [execPath, "-e", "process.exitCode = 3"],
        teardown: recorder(log),
      }),
      /worktreeSetup/,
    );
    assert.equal(seen(log).length, 1);

    // A stop: the call ends with the run's reason; the teardown runs anyway, not killed by the abort.
    const controller = new AbortController();
    const reason = new RunStopped("run was stopped");
    const slowRecorder = recorder(log);
    slowRecorder[2] = `setTimeout(() => { ${slowRecorder[2]} }, 300)`;
    await assert.rejects(
      withWorkspace(
        src,
        "worktree",
        async () => {
          controller.abort(reason);
          throw reason;
        },
        { teardown: slowRecorder, signal: controller.signal },
      ),
      (err) => err === reason,
    );
    assert.equal(seen(log).length, 2, "the teardown ran to its end after the stop");
    assert.equal(worktrees(src), 1);

    // A failing teardown: noted with the end of its output; the reply stands.
    const failing = [execPath, "-e", "console.error('compose: no such service'); process.exitCode = 5"];
    assert.equal(await withWorkspace(src, "worktree", async () => "fine", { teardown: failing, onNote }), "fine");
    assert.deepEqual(notes, ['the worktree teardown ("worktreeTeardown") exited with code 5; the end of its output:\ncompose: no such service']);

    // One that hangs is killed at its timeout.
    const began = Date.now();
    const hung = [execPath, "-e", "console.log('stopping'); setTimeout(() => {}, 60000)"];
    assert.equal(await withWorkspace(src, "worktree", async () => "fine", { teardown: hung, teardownTimeout: 0.5, onNote }), "fine");
    assert.ok(Date.now() - began < 15_000);
    assert.equal(notes[1], 'the worktree teardown ("worktreeTeardown") timed out after 0.5s; the end of its output:\nstopping');
    assert.equal(worktrees(src), 1);

    // In place: nothing to tear down.
    await withWorkspace(src, "inplace", async () => {}, { teardown: recorder(log) });
    assert.equal(seen(log).length, 2);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(join(log, ".."), { recursive: true, force: true });
  }
});

test("killing every agent process leaves a cleanup command running: its own timeout bounds it", POSIX_ONLY, async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-teardown-kill-"));
  const done = join(dir, "done");
  try {
    const agent = runCommand([execPath, "-e", "setTimeout(() => {}, 60000)"]);
    const cleanup = runCommand([execPath, "-e", `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(done)}, 'ok'), 400)`], {
      cleanup: true,
      timeout: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    killAllAgentProcesses();
    assert.notEqual((await agent).returncode, 0, "the agent was killed");
    assert.equal((await cleanup).returncode, 0, "the cleanup ran to its end");
    assert.equal(readFileSync(done, "utf8"), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a run ---------------------------------------------------------------------------

interface Reply {
  agentId: string | null;
  slot: string | null;
  compose: string | null;
}

test("a run's isolated agents get ODW_SLOT as their compose project; the teardown sees it, a failing one only logs", async () => {
  const src = makeRepo();
  const root = mkdtempSync(join(tmpdir(), "odw-teardown-run-"));
  const log = join(root, "seen.jsonl");
  const teardown = recorder(log);
  teardown[2] += "; if (process.env.ODW_AGENT_ID === '2') { console.error('down failed'); process.exitCode = 1 }";
  try {
    await withoutComposeEnv(async () => {
      const configPath = join(root, "odw.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          defaultAdapter: "env",
          worktreeTeardown: teardown,
          adapters: { env: { command: [execPath, ENV_AGENT], stdin: "{prompt}" } },
        }),
      );
      const script = join(root, "wf.js");
      writeFileSync(
        script,
        "export const meta = { name: 'wf', description: 'd' }\n" +
          "const r = await parallel([\n" +
          "  () => agent('one', { label: 'one', isolation: 'worktree' }),\n" +
          "  () => agent('two', { label: 'two', isolation: 'worktree' }),\n" +
          "  () => agent('three', { label: 'three' }),\n" +
          "])\nreturn r.map((x) => JSON.parse(x))\n",
      );
      const store = new RunStore(join(root, "runs"));
      const id = store.create({ script, args: null, source: src, configPath });
      assert.equal(await executeRun(store.runDir(id)), "done", "a failing teardown does not fail the run");
      const short = id.slice(-6);
      const replies = store.readResult(id) as Reply[];
      for (const r of replies.slice(0, 2)) {
        assert.equal(r.slot, `odw-${short}-${r.agentId}`);
        assert.equal(r.compose, r.slot);
      }
      assert.deepEqual([replies[2]!.slot, replies[2]!.compose], [null, null], "no slot in the source tree");
      const ran = seen(log).sort((a, b) => Number(a.agent) - Number(b.agent));
      assert.deepEqual(
        ran.map((s) => [s.slot, s.compose, s.tracked]),
        [
          [`odw-${short}-1`, `odw-${short}-1`, true],
          [`odw-${short}-2`, `odw-${short}-2`, true],
        ],
      );
      const events = store.readEvents(id);
      assert.equal(events.filter((e) => e.type === "agent_failed").length, 0);
      const note = events.find((e) => e.type === "log" && /worktreeTeardown/.test(String(e.message)));
      assert.equal(note?.message, 'two:2: the worktree teardown ("worktreeTeardown") exited with code 1; the end of its output:\ndown failed');
      assert.equal(note?.agentId, 2);
      assert.equal(worktrees(src), 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("odw stop: a stopped isolated agent's teardown still runs before its worktree goes", async () => {
  const src = makeRepo();
  const root = mkdtempSync(join(tmpdir(), "odw-teardown-stop-"));
  const log = join(root, "seen.jsonl");
  const started = join(root, "started");
  try {
    const configPath = join(root, "odw.config.json");
    const hang = `require('fs').writeFileSync(${JSON.stringify(started)}, ''); setTimeout(() => {}, 60000)`;
    writeFileSync(
      configPath,
      JSON.stringify({ defaultAdapter: "hang", worktreeTeardown: recorder(log), adapters: { hang: { command: [execPath, "-e", hang] } } }),
    );
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('work', { isolation: 'worktree' })\n");
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: src, configPath });
    const run = executeRun(store.runDir(id));
    assert.ok(await eventually(() => existsSync(started)), "the agent started");
    store.writeControl(id, "stop");
    assert.equal(await run, "stopped");
    const [one] = seen(log);
    assert.equal(one?.tracked, true, "it ran in the worktree, before it was removed");
    assert.equal(one?.slot, `odw-${id.slice(-6)}-1`);
    assert.equal(worktrees(src), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("SIGTERM to a worker: the agent dies, its worktree teardown runs, then the worktree goes", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-teardown-sig-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init"]);
  const log = join(root, "seen.jsonl");
  const pids = join(root, "pids");
  try {
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultAdapter: "slow",
        adapters: { slow: { command: ["sh", "-c", `echo $$ >> '${pids}'; sleep 30`] } },
        worktreeTeardown: recorder(log),
      }),
    );
    const { runId, store } = startRunFromSource("export const meta = { name: 'sig', description: 'd' }\nreturn await agent('work', { isolation: 'worktree' })", {
      runsRoot: join(root, "runs"),
      configPath,
      source: repo,
    });
    assert.ok(await eventually(() => existsSync(pids), 20_000), "the agent should be running");
    assert.ok(await eventually(() => typeof store.readStatus(runId).pid === "number", 20_000));
    process.kill(store.readStatus(runId).pid as number, "SIGTERM");
    const status = await waitFor(store, runId, { timeoutMs: 20_000, pollIntervalMs: 50 });
    assert.equal(status.state, "stopped");
    assert.ok(await eventually(() => seen(log).length === 1, 10_000), "the teardown ran");
    assert.equal(seen(log)[0]!.tracked, true);
    assert.equal(seen(log)[0]!.slot, `odw-${runId.slice(-6)}-1`);
    assert.equal(worktrees(repo), 1, "the worktree went after it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- trust and configuration ---------------------------------------------------------

test("an untrusted run drops the worktreeTeardown the repository's own config sets, and says so", () => {
  const src = makeRepo();
  const mine = mkdtempSync(join(tmpdir(), "odw-teardown-mine-"));
  try {
    const repoConfig = join(src, "odw.config.json");
    const userConfig = join(mine, "config.json");
    writeFileSync(repoConfig, JSON.stringify({ worktreeTeardown: "touch pwned" }));
    writeFileSync(userConfig, JSON.stringify({ worktreeTeardown: "docker compose down -v" }));
    const theirs = loadConfig(repoConfig, { quiet: true });
    const untrusted = applyRunTrust(theirs, resolveRunTrust({ flag: "untrusted", config: theirs, configPath: repoConfig, source: src }));
    assert.equal(untrusted.config.settings.worktreeTeardown, null);
    assert.ok(
      untrusted.notes.some((n) => n.startsWith(`untrusted run: not running the worktreeTeardown that the repository's own config (${repoConfig}) sets`)),
    );
    const ours = loadConfig(userConfig, { quiet: true });
    const kept = applyRunTrust(ours, resolveRunTrust({ flag: "untrusted", config: ours, configPath: userConfig, source: src }));
    assert.equal(kept.config.settings.worktreeTeardown, "docker compose down -v", "the user's own still runs");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(mine, { recursive: true, force: true });
  }
});

test("a run with untrusted input drops the repository's own worktreeSetup and worktreeTeardown too, and says so (review fix)", () => {
  const src = makeRepo();
  try {
    const repoConfig = join(src, "odw.config.json");
    writeFileSync(repoConfig, JSON.stringify({ worktreeSetup: "touch pwned", worktreeTeardown: "touch pwned" }));
    const theirs = loadConfig(repoConfig, { quiet: true });
    const trust = resolveRunTrust({ flag: null, config: theirs, configPath: repoConfig, source: src });
    assert.equal(trust.trust, "trusted");
    const input = applyRunTrust(theirs, trust, { untrustedInput: true });
    assert.equal(input.config.settings.worktreeSetup, null);
    assert.equal(input.config.settings.worktreeTeardown, null);
    assert.deepEqual(
      input.notes.map((n) => n.slice(0, n.indexOf(" that"))),
      ["untrusted input: not running the worktreeSetup", "untrusted input: not running the worktreeTeardown"],
    );
    // The user's own input: the repository's config is the user's choice, as before.
    const own = applyRunTrust(theirs, trust);
    assert.equal(own.config.settings.worktreeTeardown, "touch pwned");
    assert.deepEqual(own.notes, []);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("under untrusted input, worktreeSetup and worktreeTeardown run without secret-named variables, docker's kept (review fix)", POSIX_ONLY, async () => {
  const src = makeRepo();
  const out = mkdtempSync(join(tmpdir(), "odw-setup-env-"));
  const dump = (name: string) => [execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(join(out, name))}, JSON.stringify(process.env))`];
  const saved = { GH_TOKEN: process.env.GH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, DOCKER_HOST: process.env.DOCKER_HOST };
  const run = async (withholdSecrets: boolean) => {
    const cfg = defaultConfig();
    cfg.settings.defaultAdapter = "claude";
    cfg.settings.worktreeSetup = dump(`setup-${withholdSecrets}.json`);
    cfg.settings.worktreeTeardown = dump(`teardown-${withholdSecrets}.json`);
    const bridge = new Bridge(cfg, {
      runId: "20261018-120000-abc123",
      source: src,
      withholdSecrets,
      runner: async () => ({ returncode: 0, stdout: "ok", stderr: "", timedOut: false, duration: 0.01 }),
    });
    await bridge.run({ prompt: "x", isolation: "worktree" }, { agentId: 1 });
  };
  const env = (name: string) => JSON.parse(readFileSync(join(out, name), "utf8")) as Record<string, string>;
  try {
    Object.assign(process.env, { GH_TOKEN: "not-a-real-token", ANTHROPIC_API_KEY: "not-a-real-key", DOCKER_HOST: "unix:///tmp/odw-test.sock" });
    await run(true);
    for (const name of ["setup-true.json", "teardown-true.json"]) {
      const seenEnv = env(name);
      assert.equal(seenEnv.GH_TOKEN, undefined, name);
      assert.equal(seenEnv.ANTHROPIC_API_KEY, undefined, name);
      assert.equal(seenEnv.DOCKER_HOST, "unix:///tmp/odw-test.sock", name);
      assert.equal(seenEnv.PATH, process.env.PATH, name);
      assert.equal(seenEnv.ODW_SLOT, "odw-abc123-1", name);
    }
    await run(false);
    assert.equal(env("setup-false.json").GH_TOKEN, "not-a-real-token", "the user's own input: as before");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("worktreeTeardown and worktreeTeardownTimeout load, default, and reject malformed values", () => {
  const defaults = defaultConfig().settings;
  assert.equal(defaults.worktreeTeardown, null);
  assert.equal(defaults.worktreeTeardownTimeout, 120);
  const dir = mkdtempSync(join(tmpdir(), "odw-teardown-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    const load = (raw: Record<string, unknown>) => {
      writeFileSync(p, JSON.stringify(raw));
      return loadConfig(p, { quiet: true }).settings;
    };
    const loaded = load({ worktreeTeardown: ["docker", "compose", "down", "-v"], worktreeTeardownTimeout: 30 });
    assert.deepEqual(loaded.worktreeTeardown, ["docker", "compose", "down", "-v"]);
    assert.equal(loaded.worktreeTeardownTimeout, 30);
    assert.equal(load({ worktreeTeardown: "docker compose down -v" }).worktreeTeardown, "docker compose down -v");
    for (const [raw, message] of [
      [{ worktreeTeardown: " " }, /"worktreeTeardown" must be a command string/],
      [{ worktreeTeardown: [] }, /"worktreeTeardown".*got an empty list$/],
      [{ worktreeTeardownTimeout: 0 }, /"worktreeTeardownTimeout" must be a positive number of seconds; got 0/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      assert.throws(() => load(raw), (err: Error) => err instanceof ConfigError && message.test(err.message), JSON.stringify(raw));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(collectConfigWarnings({ worktreeTeardown: "x", worktreeTeardownTimeout: 5 }), []);
});

// --- odw gc: compose projects ----------------------------------------------------------

test("odw gc reports leftover odw-* compose projects — by run, never those of an active run — and removes none", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-teardown-gc-"));
  try {
    const store = new RunStore(join(root, "runs"));
    const ended = store.create({ script: "/x.js", args: null, source: root, configPath: null });
    store.updateStatus(ended, { state: "done" });
    const live = store.create({ script: "/x.js", args: null, source: root, configPath: null });
    store.updateStatus(live, { state: "running", pid: process.pid });
    const calls = join(root, "calls");
    const projects = [
      { Name: `odw-${ended.slice(-6)}-1`, Status: "running(2)", ConfigFiles: "/w/compose.yaml" },
      { Name: `odw-${live.slice(-6)}-2`, Status: "running(1)", ConfigFiles: "/w/compose.yaml" },
      { Name: "odw-0a0a0a-3", Status: "exited(1)", ConfigFiles: "/w/compose.yaml" },
      { Name: "myapp-odw-x", Status: "running(1)", ConfigFiles: "/w/compose.yaml" },
    ];
    const docker = join(root, "docker");
    writeFileSync(
      docker,
      `#!${execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\n` +
        `process.stdout.write(${JSON.stringify(JSON.stringify(projects))})\n`,
    );
    chmodSync(docker, 0o755);

    const plan = await planGc({ store, olderThanDays: 30, transcripts: true, tmpRoot: join(root, "tmp"), docker });
    assert.equal(readFileSync(calls, "utf8"), "compose ls --all --format json --filter name=odw-\n", "it only lists");
    assert.deepEqual(plan.compose, {
      leftover: [
        { name: `odw-${ended.slice(-6)}-1`, status: "running(2)", run: ended },
        { name: "odw-0a0a0a-3", status: "exited(1)", run: null },
      ],
      inUse: 1,
    });
    const text = formatGc(plan, null);
    assert.match(text, /Compose projects {2}2 {2}reported only — odw never removes them/);
    assert.match(text, new RegExp(`odw-${ended.slice(-6)}-1  running\\(2\\) · run ${ended} · docker compose -p odw-${ended.slice(-6)}-1 down -v`));
    assert.match(text, /nothing to reclaim/, "they are not counted as something gc deletes");
    assert.deepEqual((gcJson(plan, null).composeProjects as unknown[]).length, 2);

    // No docker, or one that cannot answer: not looked at, nothing said.
    const none = await planGc({ store, olderThanDays: 30, transcripts: true, tmpRoot: join(root, "tmp"), docker: join(root, "no-docker") });
    assert.equal(none.compose, null);
    assert.doesNotMatch(formatGc(none, null), /Compose projects/);
    assert.equal(gcJson(none, null).composeProjects, null);
    assert.equal((await planGc({ store, olderThanDays: 30, transcripts: true, tmpRoot: join(root, "tmp") })).compose, null, "not asked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
