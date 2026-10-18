/**
 * The container sandbox end to end (ODW extension), against a fake engine:
 * tests/fixtures/fake-docker.mjs linked onto PATH as `docker` records every
 * argv and runs the container's command directly — in a process group of its
 * own, as a daemon's container is, so only `docker kill` stops it. No real
 * engine, image or model.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { loadConfig } from "../src/adapters/config.ts";
import { killAllAgentProcesses } from "../src/adapters/runner.ts";
import { trackContainer } from "../src/adapters/sandbox.ts";
import { Bridge } from "../src/bridge.ts";
import { AdapterExecutionError, AgentError, ConfigError } from "../src/errors.ts";
import { RunStore } from "../src/runtime/run-store.ts";
import { foldAgents } from "../src/runtime/runs-view.ts";
import { executeRun } from "../src/runtime/worker.ts";
import { main } from "../src/cli.ts";
import { readNotes } from "../src/notes.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-docker.mjs", import.meta.url));

// The agent CLI "in the image": named claude, so its config is copied in.
const AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  if (d.includes("SLEEP")) {
    fs.writeFileSync(process.env.PID_DIR + "/" + process.pid, "");
    setInterval(() => {}, 1000);
    return;
  }
  const cred = process.env.HOME + "/.claude/.credentials.json";
  const seen = fs.existsSync(cred) ? fs.readFileSync(cred, "utf8") : null;
  if (seen !== null) fs.writeFileSync(cred, "overwritten by the agent");
  process.stdout.write(JSON.stringify({
    home: process.env.HOME, cred: seen, port: process.env.ODW_PORT ?? null,
    secret: process.env.SANDBOX_TEST_SECRET ?? null, path: process.env.PATH ? "set" : null, cwd: process.cwd(),
  }));
});
`;

let root = "";
let bin = "";
let state = "";
let log = "";
let pids = "";
let home = "";
const saved: Record<string, string | undefined> = {};

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "odw-sandbox-run-"))); // macOS: /var is /private/var
  bin = join(root, "bin");
  state = join(root, "state");
  pids = join(root, "pids");
  home = join(root, "home");
  log = join(root, "docker.log");
  for (const dir of [bin, state, pids, join(home, ".claude")]) mkdirSync(dir, { recursive: true });
  chmodSync(FAKE, 0o755);
  symlinkSync(FAKE, join(bin, "docker"));
  writeFileSync(join(bin, "claude"), AGENT, { mode: 0o755 });
  writeFileSync(join(home, ".claude", ".credentials.json"), "host-login-placeholder", { mode: 0o600 });
  const env: Record<string, string> = {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HOME: home,
    DOCKER_FAKE_LOG: log,
    DOCKER_FAKE_STATE: state,
    DOCKER_FAKE_IMAGES: "odw-test:1",
    PID_DIR: pids,
    SANDBOX_TEST_SECRET: "a-placeholder-secret-value",
  };
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function config(extra: Record<string, unknown> = {}, adapter: Record<string, unknown> = {}) {
  const path = join(mkdtempSync(join(root, "cfg-")), "odw.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      sandbox: { kind: "container", engine: "docker", image: "odw-test:1" },
      adapters: { boxed: { command: ["claude"], stdin: "{prompt}", ...adapter } },
      defaultAdapter: "boxed",
      ...extra,
    }),
  );
  return loadConfig(path, { quiet: true });
}

const calls = (): string[][] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    : [];

const runs = (): string[][] => calls().filter((argv) => argv[0] === "run" && argv.at(-1) !== "true");

const valuesOf = (argv: string[], flag: string): string[] => argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1]!] : []));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** No container left: the fake engine holds none, and every agent process it started is gone. */
function assertNothingLeft(): void {
  assert.deepEqual(readdirSync(state), [], "no container left running");
  for (const pid of readdirSync(pids)) assert.equal(alive(Number(pid)), false, `agent process ${pid} still alive`);
}

test("an agent runs in its container: workspace at the same path, a copy of its login, env by name, its home removed", async () => {
  const before = calls().length;
  const source = mkdtempSync(join(root, "repo-"));
  const bridge = new Bridge(config(), { source, runId: "20261018-000000-aaaaaa" });
  const outcome = await bridge.run({ prompt: "hello" }, { agentId: 3 });
  const seen = JSON.parse(outcome.text) as Record<string, string | null>;
  assert.equal(seen.cred, "host-login-placeholder", "the CLI's login was copied in");
  assert.equal(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"), "host-login-placeholder", "your own was never touched");
  assert.equal(existsSync(seen.home!), false, "the private home is gone after the run");
  assert.equal(seen.cwd, source);
  assert.match(seen.port ?? "", /^\d+$/, "ODW_PORT still reaches the agent");
  assert.equal(seen.secret, "a-placeholder-secret-value", "agentEnv's variables reach the agent");

  const argv = calls().slice(before).find((a) => a[0] === "run")!;
  assert.deepEqual(argv.slice(0, 6), ["run", "--rm", "-i", "--init", "--pull", "never"]);
  assert.match(valuesOf(argv, "--name")[0]!, /^odw-20261018-000000-aaaaaa-3-[0-9a-f]{6}$/);
  assert.deepEqual(valuesOf(argv, "--label"), ["odw.run=20261018-000000-aaaaaa"]);
  assert.deepEqual(valuesOf(argv, "--cap-drop"), ["ALL"]);
  assert.ok(argv.includes("--read-only"));
  assert.deepEqual(valuesOf(argv, "--workdir"), [source]);
  assert.ok(valuesOf(argv, "--mount").includes(`type=bind,source=${source},target=${source}`));
  assert.ok(valuesOf(argv, "--env").includes("SANDBOX_TEST_SECRET"), "passed by name");
  assert.equal(JSON.stringify(argv).includes("a-placeholder-secret-value"), false, "no secret value in the argv");
  assert.equal(valuesOf(argv, "--env").includes("PATH"), false, "the host's PATH stays home");
  assert.deepEqual(argv.slice(-2), ["odw-test:1", "claude"]);
  // A clean exit needs no kill.
  assert.equal(calls().slice(before).some((a) => a[0] === "kill"), false);
  // The image was checked once, before the first container.
  assert.ok(calls().some((a) => a.join(" ") === "image inspect --format {{.Id}} odw-test:1"));
  assertNothingLeft();
});

test("a timeout kills the container by name, not just the engine client: nothing is left", async () => {
  const bridge = new Bridge(config({ timeout: 1 }), { source: mkdtempSync(join(root, "repo-")), runId: "r-timeout" });
  const before = calls().length;
  await assert.rejects(bridge.run({ prompt: "SLEEP" }, { agentId: 1 }), (err: Error) => err instanceof AdapterExecutionError && /timed out/.test(err.message));
  const mine = calls().slice(before);
  const name = valuesOf(mine.find((a) => a[0] === "run")!, "--name")[0]!;
  assert.ok(mine.some((a) => a.join(" ") === `kill ${name}`), "docker kill <name>");
  assert.ok(mine.some((a) => a.join(" ") === `rm --force ${name}`));
  assertNothingLeft();
});

test("a stop kills the container too", async () => {
  const bridge = new Bridge(config(), { source: mkdtempSync(join(root, "repo-")), runId: "r-stop" });
  const stop = new AbortController();
  const before = calls().length;
  const started = readdirSync(pids).length;
  const running = bridge.run({ prompt: "SLEEP" }, { agentId: 2, signal: stop.signal });
  await until(() => readdirSync(pids).length > started && readdirSync(state).length > 0);
  stop.abort(new Error("stopped by test"));
  await assert.rejects(running, /stopped by test/);
  const name = valuesOf(calls().slice(before).find((a) => a[0] === "run")!, "--name")[0]!;
  assert.ok(calls().slice(before).some((a) => a.join(" ") === `kill ${name}`));
  assertNothingLeft();
});

test("a missing image or engine is a ConfigError before any container starts", async () => {
  const before = calls().length;
  const noImage = new Bridge(config({ sandbox: { kind: "container", engine: "docker", image: "not-built:1" } }), { source: root });
  await assert.rejects(noImage.run({ prompt: "hello" }), (err: Error) => err instanceof ConfigError && /image 'not-built:1' is not present in docker \(ODW never pulls\)/.test(err.message));
  await assert.rejects(noImage.checkSandbox(), ConfigError);
  assert.equal(calls().slice(before).some((a) => a[0] === "run"), false);
  // Only the fake's bin on PATH: a CI runner may well have a real podman installed.
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    const noEngine = new Bridge(config({ sandbox: { kind: "container", engine: "podman", image: "odw-test:1" } }), { source: root });
    await assert.rejects(noEngine.run({ prompt: "hello" }), /sandbox engine 'podman' is not on PATH/);
  } finally {
    process.env.PATH = path;
  }
});

test("a call may only tighten: asking for the network a sandbox has not fails before it starts", async () => {
  const bridge = new Bridge(config({ sandbox: { kind: "container", image: "odw-test:1", network: "none" } }), { source: root });
  const before = calls().length;
  await assert.rejects(bridge.run({ prompt: "hello", sandbox: { network: "default" } }), (err: Error) => err instanceof AgentError && /network "default"/.test(err.message));
  assert.equal(calls().slice(before).some((a) => a[0] === "run"), false);
  // On the host, a call can put itself in a container of its own.
  const host = new Bridge(config({ sandbox: "none" }), { source: mkdtempSync(join(root, "repo-")) });
  const at = calls().length;
  await host.run({ prompt: "hello", sandbox: { image: "odw-test:1", network: "none" } });
  assert.deepEqual(valuesOf(runs().slice(-1)[0]!, "--network"), ["none"]);
  assert.ok(calls().length > at);
});

test("a workflow run: agents and exec() steps in containers — steps offline by default — and its events say so", async () => {
  const source = mkdtempSync(join(root, "repo-"));
  const cfgDir = mkdtempSync(join(root, "cfg-"));
  const configPath = join(cfgDir, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      runsRoot: join(cfgDir, "runs"),
      sandbox: { kind: "container", engine: "docker", image: "odw-test:1" },
      adapters: { boxed: { command: ["claude"], stdin: "{prompt}" } },
      defaultAdapter: "boxed",
    }),
  );
  const script = join(source, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'boxed', description: 'd' }\n" +
      "const reply = JSON.parse(await agent('hello', { label: 'a' }))\n" +
      "const step = await exec('echo in-box', { check: true })\n" +
      "const online = await exec(['true'], { network: 'default' })\n" +
      "return { cred: reply.cred, out: step.stdout.trim(), online: online.exitCode }\n",
  );
  const store = new RunStore(join(cfgDir, "runs"));
  const before = calls().length;
  const id = store.create({ script, args: null, source, configPath });
  assert.equal(await executeRun(store.runDir(id)), "done");
  assert.deepEqual(store.readResult(id), { cred: "host-login-placeholder", out: "in-box", online: 0 });

  const mine = calls().slice(before).filter((a) => a[0] === "run");
  const agentRun = mine.find((a) => a.at(-1) === "claude")!;
  const shellStep = mine.find((a) => a.slice(-3).join(" ") === "/bin/sh -c echo in-box")!;
  const onlineStep = mine.find((a) => a.at(-1) === "true" && a.includes("odw-test:1"))!;
  assert.equal(agentRun.includes("--network"), false, "agents get the default network: they must reach their model API");
  assert.deepEqual(valuesOf(shellStep, "--network"), ["none"], "an exec() step is offline by default");
  assert.equal(onlineStep.includes("--network"), false, "network: 'default' asked for it");
  assert.match(valuesOf(shellStep, "--name")[0]!, new RegExp(`^odw-${id}-c1-`));

  const events = store.readEvents(id);
  const setup = events.find((e) => e.type === "run_started")!.setup as { settings: Record<string, unknown> };
  assert.equal((setup.settings.sandbox as { image: string }).image, "odw-test:1");
  assert.deepEqual(foldAgents(events).find((a) => a.kind === "agent")!.sandbox, {
    kind: "container",
    engine: "docker",
    image: "odw-test:1",
    network: "default",
  });
  // No `<cli> --version` probe on the host: it would name another CLI than the image's — or run yours.
  assert.equal(events.some((e) => e.type === "cli_version"), false);
  assert.equal(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"), "host-login-placeholder");
  assertNothingLeft();
});

test("--sandbox container in a run's meta puts a run with no sandbox config in one; without an image it fails at start", async () => {
  const source = mkdtempSync(join(root, "repo-"));
  const cfgDir = mkdtempSync(join(root, "cfg-"));
  const configPath = join(cfgDir, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ runsRoot: join(cfgDir, "runs"), adapters: { boxed: { command: ["claude"], stdin: "{prompt}" } }, defaultAdapter: "boxed" }));
  const script = join(source, "wf.js");
  writeFileSync(script, "export const meta = { name: 'flag', description: 'd' }\nreturn JSON.parse(await agent('hello')).cred\n");
  const store = new RunStore(join(cfgDir, "runs"));
  const id = store.create({ script, args: null, source, configPath, sandbox: { kind: "container", image: "odw-test:1" } });
  assert.equal(await executeRun(store.runDir(id)), "done");
  assert.equal(store.readResult(id), "host-login-placeholder");

  const missing = store.create({ script, args: null, source, configPath, sandbox: { kind: "container", image: "not-built:1" } });
  assert.equal(await executeRun(store.runDir(missing)), "failed");
  assert.equal(foldAgents(store.readEvents(missing)).length, 0, "no agent started");
});

test("the worker's backstop removes every container still live", async () => {
  const before = calls().length;
  const untrack = trackContainer("odw-backstop-test", "docker");
  killAllAgentProcesses();
  await until(() => calls().slice(before).some((a) => a.join(" ") === "rm --force odw-backstop-test"));
  untrack();
});

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

test("odw run|rerun --sandbox container [--sandbox-image]: the banner, the meta, and a rerun stays sandboxed", async () => {
  const dir = mkdtempSync(join(root, "cli-"));
  const configPath = join(dir, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ adapters: { boxed: { command: ["claude"], stdin: "{prompt}" } }, defaultAdapter: "boxed" }));
  const script = join(dir, "wf.js");
  writeFileSync(script, "export const meta = { name: 'cli', description: 'd' }\nreturn JSON.parse(await agent('hello')).cred\n");
  const runsRoot = join(dir, "runs");
  const flags = ["--config", configPath, "--runs-root", runsRoot, "--source", dir];
  const store = new RunStore(runsRoot);

  let r = await cli(["run", script, "--sandbox", "container", "--sandbox-image", "odw-test:1", "--wait", ...flags]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out), "host-login-placeholder");
  assert.match(r.err, /sandbox: container \(docker, image odw-test:1, network default, cli config copy, pids 512\) — agents and exec\(\) steps run in it/);
  const id = /running (\S+) \.\.\./.exec(r.err)![1]!;
  assert.deepEqual(store.readMeta(id).sandbox, { kind: "container", image: "odw-test:1" });

  r = await cli(["rerun", id, "--wait", "--runs-root", runsRoot]);
  assert.equal(r.code, 0, r.err);
  const again = /running (\S+) \.\.\./.exec(r.err)![1]!;
  assert.deepEqual(store.readMeta(again).sandbox, { kind: "container", image: "odw-test:1" });

  // Usage errors, before anything is created.
  const runs = store.listRuns().length;
  r = await cli(["run", script, "--sandbox", "vm", ...flags]);
  assert.deepEqual([r.code, r.err], [2, "odw run: --sandbox must be container; got 'vm'\n"]);
  r = await cli(["run", script, "--sandbox-image", "odw-test:1", ...flags]);
  assert.deepEqual([r.code, r.err], [2, "odw run: --sandbox-image needs --sandbox container\n"]);
  r = await cli(["run", script, "--sandbox", "container", "--detach", ...flags]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--sandbox container needs an image/);
  assert.equal(store.listRuns().length, runs);
});

test("notes in a container: the shim posts through its bound notes directory, the board is bound read-only, ODW_NOTES by name", async () => {
  const noter = fileURLToPath(new URL("./fixtures/note-agent.mjs", import.meta.url));
  chmodSync(noter, 0o755);
  if (!existsSync(join(bin, "noter"))) symlinkSync(noter, join(bin, "noter"));
  const source = mkdtempSync(join(root, "repo-"));
  const cfgDir = mkdtempSync(join(root, "cfg-"));
  const configPath = join(cfgDir, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      sandbox: { kind: "container", engine: "docker", image: "odw-test:1" },
      adapters: { boxed: { command: ["noter"], stdin: "{prompt}" } },
      defaultAdapter: "boxed",
      notes: true,
    }),
  );
  const script = join(source, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'boxed-notes', description: 'd' }\n" +
      "await agent('NOTE: the config loader now returns a Promise', { label: 'writer' })\n" +
      "return JSON.parse(await agent('go on', { label: 'reader' }))\n",
  );
  const store = new RunStore(join(cfgDir, "runs"));
  const before = calls().length;
  const id = store.create({ script, args: null, source, configPath });
  assert.equal(await executeRun(store.runDir(id)), "done");

  const runDir = store.runDir(id);
  const writerRun = calls().slice(before).find((a) => a[0] === "run" && a.at(-1) === "noter")!;
  const mounts = valuesOf(writerRun, "--mount");
  const agentDir = join(runDir, "notes", "1");
  const boardDir = join(runDir, "notes", "board");
  assert.ok(mounts.includes(`type=bind,source=${agentDir},target=${agentDir}`), "its own notes directory, read-write");
  assert.ok(mounts.includes(`type=bind,source=${boardDir},target=${boardDir},readonly`), "the board, read-only");
  assert.ok(!mounts.some((m) => m.includes(join(runDir, "notes", "2"))), "no other agent's inbox");
  assert.ok(valuesOf(writerRun, "--env").includes("ODW_NOTES"), "ODW_NOTES passed by name");

  const notes = readNotes(runDir);
  assert.deepEqual(notes.map((n) => [n.by.label, n.text]), [["writer", "the config loader now returns a Promise"]]);
  const reader = store.readResult(id) as { prompt: string; board: string };
  assert.match(reader.prompt, /#1 \[agent 1 · writer\] the config loader now returns a Promise/);
  assert.match(reader.board, /#1 \[agent 1 · writer\] the config loader now returns a Promise/);
  assertNothingLeft();
});
