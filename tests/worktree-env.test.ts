import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { runCommand } from "../src/adapters/runner.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { ConfigError, RunStopped, isFatalError } from "../src/errors.js";
import { PortPool } from "../src/ports.js";
import { createPrimitives } from "../src/primitives.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";
import { withWorkspace } from "../src/workspace.js";
import { MAX_INCLUDE_FILE_BYTES, WorktreeSetupError, parseWorktreeInclude } from "../src/worktree-setup.js";

// Ready-to-work worktrees: .worktreeinclude, worktreeSetup, and every agent's
// ODW_RUN_ID / ODW_AGENT_ID / ODW_PORT.

const POSIX_ONLY = { skip: process.platform === "win32" };
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

function worktrees(repo: string): number {
  return git(repo, "worktree", "list", "--porcelain").trim().split("\n\n").length;
}

/** A file's text, or null when it does not exist. */
function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** A file whose size says it is just over the copy limit, without writing 100 MB. */
function hugeFile(path: string): void {
  writeFileSync(path, "");
  truncateSync(path, MAX_INCLUDE_FILE_BYTES + 1);
}

async function eventually(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

// --- .worktreeinclude -------------------------------------------------------------

test(".worktreeinclude parses like a .gitignore, with symlink: lines apart", () => {
  const text = [
    "# secrets",
    ".env\r",
    "",
    "notes.md   ",
    "trailing\\ ",
    "\\#literal",
    "!drop.local",
    "symlink: node_modules",
    "symlink:.venv/lib",
    "symlink:",
  ].join("\n");
  assert.deepEqual(parseWorktreeInclude(text), {
    copy: [".env", "notes.md", "trailing\\ ", "\\#literal", "!drop.local"],
    link: ["node_modules", ".venv/lib"],
  });
});

test(".worktreeinclude copies what git does not track into a new worktree, by .gitignore rules", async () => {
  const src = makeRepo(
    { "a.txt": "committed\n", ".gitignore": "node_modules/\n.env\n*.log\n", "config/app.json": "{}\n" },
    {
      ".worktreeinclude": [
        "# what a fresh checkout lacks",
        ".env",
        "notes.md   ",
        "config/secrets.json",
        ".cache",
        "*.local",
        "!drop.local",
        "a.txt",
        "vendor",
        "*.env",
        "cache",
      ].join("\n"),
      ".env": "SECRET=1\n",
      "notes.md": "untracked, not ignored\n",
      "config/secrets.json": '{"key":1}\n',
      ".cache/deep/b.txt": "cached\n",
      "keep.local": "keep\n",
      "drop.local": "drop\n",
      "debug.log": "matched by no line\n",
      "a.txt": "an uncommitted edit\n",
      "vendor/lib/x.txt": "vendored\n",
      // Matches inside an untracked directory that no line matches.
      "scratch/notes.txt": "matched by no line\n",
      "scratch/local.env": "nested\n",
      "scratch/cache/c.bin": "cached too\n",
    },
  );
  git(join(src, "vendor", "lib"), "init", "-q"); // a nested repository: its files come along, its .git never
  try {
    await withWorkspace(src, "worktree", async (ws) => {
      const at = (path: string) => read(join(ws.path, path));
      assert.equal(at(".env"), "SECRET=1\n", "an ignored file is copied");
      assert.equal(lstatSync(join(ws.path, ".env")).isSymbolicLink(), false, "copied, not linked");
      assert.equal(at("notes.md"), "untracked, not ignored\n", "so is a merely untracked one");
      assert.equal(at("config/secrets.json"), '{"key":1}\n', "next to tracked files too");
      assert.equal(at(".cache/deep/b.txt"), "cached\n", "a directory comes whole");
      assert.equal(at("keep.local"), "keep\n");
      assert.equal(at("drop.local"), null, "a negated pattern is left out");
      assert.equal(at("debug.log"), null, "only what a line matches is copied");
      assert.equal(at("a.txt"), "committed\n", "a tracked file keeps its checked-out content");
      assert.equal(at("vendor/lib/x.txt"), "vendored\n");
      assert.equal(existsSync(join(ws.path, "vendor", "lib", ".git")), false, ".git is never copied");
      assert.equal(at("scratch/local.env"), "nested\n", "a match inside an untracked directory");
      assert.equal(at("scratch/cache/c.bin"), "cached too\n");
      assert.equal(at("scratch/notes.txt"), null);
    });
    assert.equal(read(join(src, ".env")), "SECRET=1\n", "the source keeps its files");
    assert.equal(worktrees(src), 1, "the worktree is gone");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a symlink: line links a heavy directory to the source; removing the worktree never reaches through it", async () => {
  const src = makeRepo(
    { "a.txt": "x\n", ".gitignore": "node_modules/\n.venv/\n" },
    {
      ".worktreeinclude": "symlink: node_modules\n.venv\nsymlink:.venv/lib\n",
      "node_modules/pkg/index.js": "module.exports = 1\n",
      ".venv/bin/python": "#!/bin/sh\n",
      ".venv/lib/site.py": "site\n",
    },
  );
  try {
    await withWorkspace(src, "worktree", async (ws) => {
      const modules = join(ws.path, "node_modules");
      assert.equal(realpathSync(modules), realpathSync(join(src, "node_modules")), "the source's own node_modules");
      if (process.platform !== "win32") assert.ok(lstatSync(modules).isSymbolicLink());
      assert.equal(read(join(modules, "pkg", "index.js")), "module.exports = 1\n");
      // A copied directory with something linked inside it.
      assert.equal(lstatSync(join(ws.path, ".venv")).isSymbolicLink(), false, ".venv itself is copied");
      assert.equal(read(join(ws.path, ".venv", "bin", "python")), "#!/bin/sh\n");
      assert.equal(read(join(ws.path, ".venv", "lib", "site.py")), "site\n");
      if (process.platform !== "win32") {
        const site = join(ws.path, ".venv", "lib", "site.py");
        assert.equal(realpathSync(site), realpathSync(join(src, ".venv", "lib", "site.py")), "linked, not copied");
      }
    });
    assert.equal(read(join(src, "node_modules", "pkg", "index.js")), "module.exports = 1\n", "the linked source survives");
    assert.equal(read(join(src, ".venv", "lib", "site.py")), "site\n");
    assert.equal(worktrees(src), 1);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a file over 100 MB is left out of the copy, with a note naming it", async () => {
  const src = makeRepo({ "a.txt": "x\n" }, { ".worktreeinclude": "data/\n", "data/small.txt": "small\n" });
  hugeFile(join(src, "data", "huge.bin"));
  const notes: string[] = [];
  try {
    await withWorkspace(
      src,
      "worktree",
      async (ws) => {
        assert.equal(read(join(ws.path, "data", "small.txt")), "small\n");
        assert.equal(existsSync(join(ws.path, "data", "huge.bin")), false);
      },
      { onNote: (note) => notes.push(note) },
    );
    assert.deepEqual(notes, [
      '.worktreeinclude left out files over 100 MB (a "symlink:" line shares a big file instead): data/huge.bin (100.0 MB)',
    ]);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("symlinks in a copied directory point into the worktree, or stay pinned where they pointed", POSIX_ONLY, async () => {
  const outside = mkdtempSync(join(tmpdir(), "odw-wtenv-outside-"));
  writeFileSync(join(outside, "shared.env"), "shared\n");
  const src = makeRepo({ "a.txt": "x\n" }, { ".worktreeinclude": ".tools\n", ".tools/real.sh": "echo real\n" });
  symlinkSync("real.sh", join(src, ".tools", "inside"));
  symlinkSync(relative(join(src, ".tools"), join(outside, "shared.env")), join(src, ".tools", "outside"));
  try {
    await withWorkspace(src, "worktree", async (ws) => {
      assert.equal(readlinkSync(join(ws.path, ".tools", "inside")), "real.sh", "a link inside the repository is kept");
      const pinned = readlinkSync(join(ws.path, ".tools", "outside"));
      assert.ok(isAbsolute(pinned), `a link that climbs out of the repository is made absolute: ${pinned}`);
      assert.equal(read(join(ws.path, ".tools", "outside")), "shared\n");
    });
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// --- worktreeSetup ----------------------------------------------------------------

test("worktreeSetup runs in the agent's workspace after .worktreeinclude, with the environment it is given", async () => {
  const src = makeRepo(
    { "packages/app/index.js": "1\n" },
    { ".worktreeinclude": "packages/app/.env\n", "packages/app/.env": "TOKEN=t\n" },
  );
  const setup = [
    execPath,
    "-e",
    "const fs = require('fs'); fs.writeFileSync('setup.txt', [fs.readFileSync('.env', 'utf8').trim(), process.env.ODW_PORT].join('|'))",
  ];
  try {
    await withWorkspace(
      join(src, "packages", "app"),
      "worktree",
      async (ws) => {
        assert.ok(ws.path.endsWith(join("packages", "app")), ws.path);
        assert.equal(read(join(ws.path, "setup.txt")), "TOKEN=t|41234", "the .env was there, and so was ODW_PORT");
      },
      { command: setup, env: { ...process.env, ODW_PORT: "41234" } as Record<string, string> },
    );
    assert.equal(existsSync(join(src, "packages", "app", "setup.txt")), false, "the setup ran in the worktree");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a string worktreeSetup runs through the platform shell", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  try {
    await withWorkspace(
      src,
      "worktree",
      async (ws) => {
        assert.equal(read(join(ws.path, "one.txt"))?.trim(), "one");
        assert.equal(read(join(ws.path, "two.txt"))?.trim(), "two");
      },
      { command: "echo one> one.txt && echo two> two.txt" },
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a failing worktreeSetup fails the call, recoverably, quoting the end of its output; the worktree still goes", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const setup =
    "console.log('resolving'); setTimeout(() => { for (let i = 1; i <= 300; i++) console.error('npm WARN step ' + i);" +
    " console.error('npm ERR! the real cause'); process.exitCode = 3 }, 200)";
  let started = false;
  try {
    await assert.rejects(
      withWorkspace(src, "worktree", async () => void (started = true), { command: [execPath, "-e", setup] }),
      (err: Error) => {
        assert.ok(err instanceof WorktreeSetupError, String(err));
        assert.equal(isFatalError(err), false, "it fails the agent, not the run");
        assert.match(err.message, /^the worktree setup \("worktreeSetup"\) exited with code 3; the end of its output:\n…/);
        assert.match(err.message, /npm WARN step 300\nnpm ERR! the real cause$/);
        assert.doesNotMatch(err.message, /resolving/, "only the tail");
        assert.ok(err.message.length < 2200, `bounded: ${err.message.length} characters`);
        return true;
      },
    );
    assert.equal(started, false, "the agent never started");
    assert.equal(worktrees(src), 1);

    // Short output: both streams, as they came.
    const both = "console.log('from stdout'); setTimeout(() => { console.error('from stderr'); process.exitCode = 2 }, 200)";
    await assert.rejects(
      withWorkspace(src, "worktree", async () => {}, { command: [execPath, "-e", both] }),
      /exited with code 2; the end of its output:\nfrom stdout\nfrom stderr$/,
    );
    await assert.rejects(
      withWorkspace(src, "worktree", async () => {}, { command: ["odw-no-such-setup-program"] }),
      /exited with code 127; the end of its output:\nfailed to launch 'odw-no-such-setup-program'/,
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a worktreeSetup that outlives worktreeSetupTimeout is killed, and the call fails saying so", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const began = Date.now();
  try {
    await assert.rejects(
      withWorkspace(src, "worktree", async () => assert.fail("the agent must not start"), {
        command: [execPath, "-e", "console.log('installing'); setTimeout(() => {}, 60000)"],
        timeout: 0.5,
      }),
      (err: Error) =>
        err instanceof WorktreeSetupError &&
        /^the worktree setup \("worktreeSetup"\) timed out after 0\.5s; the end of its output:\ninstalling$/.test(err.message),
    );
    assert.ok(Date.now() - began < 15_000, "killed at its timeout, not left to run");
    assert.equal(worktrees(src), 1);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a stop during worktreeSetup kills it and ends the call with the run's reason", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const marker = join(mkdtempSync(join(tmpdir(), "odw-wtenv-mark-")), "setup-started");
  const controller = new AbortController();
  const reason = new RunStopped("run was stopped");
  try {
    const call = withWorkspace(src, "worktree", async () => assert.fail("the agent must not start"), {
      command: [execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, ''); setTimeout(() => {}, 60000)`],
      signal: controller.signal,
    });
    assert.ok(await eventually(() => existsSync(marker)), "the setup started");
    controller.abort(reason);
    await assert.rejects(call, (err) => err === reason);
    assert.equal(worktrees(src), 1);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dirname(marker), { recursive: true, force: true });
  }
});

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

test("a failing worktree setup fails that agent, not the run, with the end of its output in agent_failed", async () => {
  const src = makeRepo({ "a.txt": "x\n" }, { ".worktreeinclude": ".env\n", ".env": "K=v\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-wtenv-run-"));
  const setup = [
    execPath,
    "-e",
    "const fs = require('fs'); if (process.env.ODW_AGENT_ID === '1') { console.error('setup broke for agent 1'); process.exitCode = 4 }" +
      " else fs.writeFileSync('ready.txt', fs.readFileSync('.env', 'utf8').trim() + ' on ' + process.env.ODW_PORT)",
  ];
  try {
    const { id, state, store } = await runFlow(
      root,
      src,
      { worktreeSetup: setup },
      ["ready.txt", ".env"],
      "return await parallel([\n" +
        "  () => agent('one', { label: 'one', isolation: 'worktree' }),\n" +
        "  () => agent('two', { label: 'two', isolation: 'worktree' }),\n" +
        "  () => agent('three', { label: 'three' }),\n" +
        "])\n",
    );
    assert.equal(state, "done", "a broken setup is the agent's failure, not the run's");
    const [one, two, three] = store.readResult(id) as Array<string | null>;
    assert.equal(one, null);
    const ready = JSON.parse(two!) as Reply;
    assert.equal(ready.files["ready.txt"], `K=v on ${ready.port}`, "the setup ran before the agent, after the include");
    assert.equal((JSON.parse(three!) as Reply).files["ready.txt"], null, "no setup for an agent in the source tree");
    const failed = store.readEvents(id).filter((e) => e.type === "agent_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.agentId, 1);
    assert.equal(
      failed[0]!.error,
      'WorktreeSetupError: the worktree setup ("worktreeSetup") exited with code 4; the end of its output:\nsetup broke for agent 1',
    );
    assert.equal(worktrees(src), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("what preparing an agent left undone — no port to spare, a file left out — is logged against that agent", async () => {
  const src = makeRepo({ "a.txt": "x\n" }, { ".worktreeinclude": "data/\n", "data/small.txt": "s\n" });
  hugeFile(join(src, "data", "huge.bin"));
  const root = mkdtempSync(join(tmpdir(), "odw-wtenv-run-"));
  try {
    const { id, state, store } = await runFlow(
      root,
      src,
      { concurrency: 2, portRange: [41500, 41500] },
      ["--barrier", join(root, "barrier"), "2", "data/small.txt"],
      "const replies = await parallel([\n" +
        "  () => agent('iso', { label: 'iso', isolation: 'worktree' }),\n" +
        "  () => agent('here', { label: 'here' }),\n" +
        "])\n" +
        "return replies.map((r) => JSON.parse(r))\n",
    );
    assert.equal(state, "done");
    const [iso, here] = store.readResult(id) as Reply[];
    assert.equal(iso!.files["data/small.txt"], "s");
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
    const leftOut = logs.find((e) => /left out files over 100 MB/.test(String(e.message)));
    assert.equal(
      leftOut?.message,
      'iso:1: .worktreeinclude left out files over 100 MB (a "symlink:" line shares a big file instead): data/huge.bin (100.0 MB)',
    );
    assert.equal(leftOut?.agentId, 1);
    assert.equal(leftOut?.label, "iso");
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
  const outer = { id: process.env.ODW_RUN_ID, port: process.env.ODW_PORT };
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
    if (outer.id === undefined) delete process.env.ODW_RUN_ID;
    else process.env.ODW_RUN_ID = outer.id;
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

// --- configuration and the runner ----------------------------------------------------

test("worktreeSetup, worktreeSetupTimeout and portRange load, default, and reject malformed values", () => {
  const defaults = defaultConfig().settings;
  assert.equal(defaults.worktreeSetup, null);
  assert.equal(defaults.worktreeSetupTimeout, 600);
  assert.deepEqual(defaults.portRange, [41000, 41999]);
  const example = loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true }).settings;
  assert.equal(example.worktreeSetup, null);
  assert.equal(example.worktreeSetupTimeout, 600);
  assert.deepEqual(example.portRange, [41000, 41999]);

  const dir = mkdtempSync(join(tmpdir(), "odw-wtenv-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    const load = (raw: Record<string, unknown>) => {
      writeFileSync(p, JSON.stringify(raw));
      return loadConfig(p, { quiet: true }).settings;
    };
    const loaded = load({ worktreeSetup: ["npm", "ci"], worktreeSetupTimeout: 90, portRange: [3000, 3009] });
    assert.deepEqual(loaded.worktreeSetup, ["npm", "ci"]);
    assert.equal(loaded.worktreeSetupTimeout, 90);
    assert.deepEqual(loaded.portRange, [3000, 3009]);
    assert.equal(load({ worktreeSetup: "npm ci && npm run build" }).worktreeSetup, "npm ci && npm run build");
    assert.equal(load({ worktreeSetup: null, worktreeSetupTimeout: null }).worktreeSetupTimeout, 600);

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ worktreeSetup: "  " }, /"worktreeSetup" must be a command string .* or a non-empty array of strings .*; got a string$/],
      [{ worktreeSetup: [] }, /"worktreeSetup".*got an empty list$/],
      [{ worktreeSetup: ["", "x"] }, /"worktreeSetup"/],
      [{ worktreeSetup: ["npm", 1] }, /"worktreeSetup"/],
      [{ worktreeSetup: { run: "npm ci" } }, /"worktreeSetup".*got an object$/],
      [{ worktreeSetupTimeout: 0 }, /"worktreeSetupTimeout" must be a positive number of seconds; got 0/],
      [{ worktreeSetupTimeout: "long" }, /"worktreeSetupTimeout"/],
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
  assert.deepEqual(collectConfigWarnings({ worktreeSetup: "npm ci", worktreeSetupTimeout: 60, portRange: [1, 2] }), []);
  assert.match(collectConfigWarnings({ portRang: [1, 2] })[0]!, /did you mean "portRange"/);
});

test("the runner can run a command line through the shell and report stderr as it arrives", async () => {
  const shell = await runCommand(["echo one&& echo two"], { shell: true });
  assert.equal(shell.returncode, 0);
  assert.deepEqual(shell.stdout.trim().split(/\r?\n/), ["one", "two"]);

  const chunks: string[] = [];
  const r = await runCommand([execPath, "-e", "process.stderr.write('warn 1\\n'); process.exitCode = 5"], {
    onStderr: (chunk) => chunks.push(chunk),
  });
  assert.equal(r.returncode, 5);
  assert.equal(chunks.join(""), "warn 1\n");
  assert.equal(r.stderr, "warn 1\n", "the result keeps its tail as before");
});
