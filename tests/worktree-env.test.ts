import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { ConfigError } from "../src/errors.js";
import { PortPool } from "../src/ports.js";
import { createPrimitives } from "../src/primitives.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// Every agent's ODW_RUN_ID / ODW_AGENT_ID / ODW_PORT.

const ENV_AGENT = fileURLToPath(new URL("./fixtures/env-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A repo with `committed` in its one commit, and `extra` written over it afterwards (untracked or edited). */
function makeRepo(committed: Record<string, string>, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-wtenv-"));
  git(dir, "init", "-q");
  write(dir, committed);
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  write(dir, extra);
  return dir;
}

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

// --- end to end: a run's agents ------------------------------------------------------

interface Reply {
  runId: string | null;
  agentId: string | null;
  port: string | null;
  cwd: string;
  files: Record<string, string | null>;
}

/** Run `body` as a workflow over `source`, with the env-reporting agent as the default adapter. */
async function runFlow(
  root: string,
  source: string,
  config: Record<string, unknown>,
  agentArgs: string[],
  body: string,
): Promise<{ id: string; state: string; store: RunStore }> {
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "env",
      ...config,
      adapters: { env: { command: [execPath, ENV_AGENT, ...agentArgs], stdin: "{prompt}" } },
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source, configPath });
  return { id, state: await executeRun(store.runDir(id)), store };
}

test("every agent process gets ODW_RUN_ID, its own ODW_AGENT_ID, and a port no other running agent holds", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-wtenv-run-"));
  try {
    const { id, state, store } = await runFlow(
      root,
      src,
      { concurrency: 6 },
      ["--barrier", join(root, "barrier"), "6"],
      "const replies = await parallel([1, 2, 3, 4, 5, 6].map((n) => () =>\n" +
        "  agent('report ' + n, { label: 'a' + n, isolation: n % 2 ? 'worktree' : undefined })))\n" +
        "return replies.map((r) => JSON.parse(r))\n",
    );
    assert.equal(state, "done");
    const replies = store.readResult(id) as Reply[];
    const ids = new Map(
      store
        .readEvents(id)
        .filter((e) => e.type === "agent_started")
        .map((e) => [e.label, String(e.agentId)]),
    );
    const source = realpathSync(src);
    replies.forEach((reply, i) => {
      assert.equal(reply.runId, id);
      assert.equal(reply.agentId, ids.get(`a${i + 1}`), "ODW_AGENT_ID is the agentId of its events");
      const port = Number(reply.port);
      assert.ok(port >= 41000 && port <= 41999, `a port from the default portRange: ${reply.port}`);
      if (i % 2 === 0) assert.match(reply.cwd, /odw-wt-/, "isolated agents get them in their worktree");
      else assert.equal(reply.cwd, source, "agents in the source tree get them too");
    });
    assert.equal(new Set(replies.map((r) => r.port)).size, 6, "six agents at once, six ports");
    assert.equal(new Set(replies.map((r) => r.agentId)).size, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("an agent left without a port to spare runs without ODW_PORT, and the run's log says so", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-wtenv-run-"));
  try {
    const { id, state, store } = await runFlow(
      root,
      src,
      { concurrency: 2, portRange: [41500, 41500] },
      ["--barrier", join(root, "barrier"), "2"],
      "const replies = await parallel([\n" +
        "  () => agent('iso', { label: 'iso', isolation: 'worktree' }),\n" +
        "  () => agent('here', { label: 'here' }),\n" +
        "])\n" +
        "return replies.map((r) => JSON.parse(r))\n",
    );
    assert.equal(state, "done");
    const [iso, here] = store.readResult(id) as Reply[];
    assert.deepEqual([iso!.port, here!.port].sort(), ["41500", null].sort(), "one port, two agents at once");
    const logs = store.readEvents(id).filter((e) => e.type === "log");
    const portless = iso!.port === null ? "iso:1" : "here:2";
    assert.ok(
      logs.some(
        (e) =>
          e.message ===
          `${portless}: no ODW_PORT for this agent: every port of portRange [41500, 41500] is held by another running agent of this run`,
      ),
      JSON.stringify(logs),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

// --- ports and the bridge ------------------------------------------------------------

test("a port pool hands each port to one holder at a time and takes it back on release", async () => {
  const pool = new PortPool(45000, 45003);
  const ports = await Promise.all([1, 2, 3, 4].map(() => pool.acquire()));
  assert.deepEqual([...ports].sort(), [45000, 45001, 45002, 45003], "concurrent claims never collide");
  assert.equal(await pool.acquire(), null, "every port is held");
  pool.release(45002);
  assert.equal(await pool.acquire(), 45002);
});

/** Listen on a loopback port (0: any free one); null when it is taken. */
function listen(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen({ port, host: "127.0.0.1" }, () => resolve(server));
  });
}

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

test("a port pool passes over a port something already listens on, while another is free", async () => {
  // Occupy a free port whose neighbour is free too.
  let busy: Server | null = null;
  let port = 0;
  for (let tries = 0; tries < 20 && !busy; tries++) {
    const server = (await listen(0))!;
    port = (server.address() as { port: number }).port;
    const neighbour = port < 65535 ? await listen(port + 1) : null;
    if (neighbour) {
      await close(neighbour);
      busy = server;
    } else {
      await close(server);
    }
  }
  assert.ok(busy, "found a free pair of ports");
  try {
    const pool = new PortPool(port, port + 1);
    assert.equal(await pool.acquire(), port + 1, "the busy port is passed over");
    assert.equal(await pool.acquire(), port, "but still handed out when nothing else is left");
  } finally {
    await close(busy!);
  }
});

test("the bridge gives every CLI run of a call the same ODW_* variables, over the adapter's and the worker's", async () => {
  const cfg = defaultConfig();
  cfg.settings.defaultAdapter = "claude";
  cfg.settings.portRange = [45100, 45100];
  cfg.adapters.claude = { ...cfg.adapters.claude!, env: { ODW_PORT: "1", ODW_AGENT_ID: "adapter", MY_VAR: "kept" } };
  const seen: Array<Record<string, string> | undefined> = [];
  const replies = ["not json", '{"n":1}', "plain"];
  const bridge = new Bridge(cfg, {
    runId: "20261017-120000-abc123",
    runner: async (_command, options) => {
      seen.push(options?.env);
      return ok(replies.shift()!);
    },
  });
  const outer = process.env.ODW_RUN_ID;
  process.env.ODW_RUN_ID = "an-outer-run"; // as a worker started by another run's agent inherits
  try {
    await bridge.run({ prompt: "x", schema: { type: "object", properties: { n: { type: "number" } } } }, { agentId: 4 });
    assert.equal(seen.length, 2, "a schema retry ran");
    for (const env of seen) {
      assert.equal(env?.ODW_RUN_ID, "20261017-120000-abc123");
      assert.equal(env?.ODW_AGENT_ID, "4");
      assert.equal(env?.ODW_PORT, "45100", "the same port on every attempt");
      assert.equal(env?.MY_VAR, "kept", "the adapter's env still applies");
    }
    // The port came back when the call settled.
    await bridge.run({ prompt: "y" }, { agentId: 5 });
    assert.equal(seen[2]?.ODW_PORT, "45100");
    assert.equal(seen[2]?.ODW_AGENT_ID, "5");

    // Without a run id or an agent id, nothing inherited stands in for them.
    const bare = new Bridge(cfg, { runner: async (_command, options) => (seen.push(options?.env), ok("hi")) });
    await bare.run({ prompt: "z" });
    assert.equal(seen[3]?.ODW_RUN_ID, undefined);
    assert.equal(seen[3]?.ODW_AGENT_ID, undefined);
  } finally {
    if (outer === undefined) delete process.env.ODW_RUN_ID;
    else process.env.ODW_RUN_ID = outer;
  }
});

test("exec() commands get the run's ODW_RUN_ID; their own env can still override it", async () => {
  const source = mkdtempSync(join(tmpdir(), "odw-wtenv-exec-"));
  try {
    const cfg = defaultConfig();
    cfg.settings.defaultAdapter = "claude";
    const prims = createPrimitives(buildContext(cfg, { source, runId: "20261017-120000-def456" }));
    const print = [execPath, "-e", "process.stdout.write(String(process.env.ODW_RUN_ID))"];
    assert.equal((await prims.exec(print)).stdout, "20261017-120000-def456");
    assert.equal((await prims.exec(print, { env: { ODW_RUN_ID: "mine" } })).stdout, "mine");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

// --- configuration -------------------------------------------------------------------

test("portRange loads, defaults, and rejects malformed values", () => {
  assert.deepEqual(defaultConfig().settings.portRange, [41000, 41999]);
  const example = loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true }).settings;
  assert.deepEqual(example.portRange, [41000, 41999]);

  const dir = mkdtempSync(join(tmpdir(), "odw-wtenv-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    const load = (raw: Record<string, unknown>) => {
      writeFileSync(p, JSON.stringify(raw));
      return loadConfig(p, { quiet: true }).settings;
    };
    assert.deepEqual(load({ portRange: [3000, 3009] }).portRange, [3000, 3009]);
    assert.deepEqual(load({ portRange: null }).portRange, [41000, 41999]);

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ portRange: 41000 }, /"portRange" must be \[first, last\]: two whole port numbers from 1 to 65535, first <= last; got 41000/],
      [{ portRange: [5000, 4000] }, /"portRange".*got \[5000,4000\]/],
      [{ portRange: [0, 10] }, /"portRange"/],
      [{ portRange: [65000, 70000] }, /"portRange"/],
      [{ portRange: [1.5, 10] }, /"portRange"/],
      [{ portRange: [1, 2, 3] }, /"portRange"/],
    ];
    for (const [raw, message] of cases) {
      assert.throws(
        () => load(raw),
        (err: Error) => err instanceof ConfigError && message.test(err.message),
        JSON.stringify(raw),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(collectConfigWarnings({ portRange: [1, 2] }), []);
  assert.match(collectConfigWarnings({ portRang: [1, 2] })[0]!, /did you mean "portRange"/);
});
