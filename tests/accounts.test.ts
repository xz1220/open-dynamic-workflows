/**
 * Several accounts of one CLI in one run (ODW extension; see
 * src/adapters/accounts.ts): `accounts` expands into an adapter per account,
 * each with its own config dir; a call on the adapter runs on any account,
 * ordered by headroom, and hands its work over when one runs out. The CLI is
 * tests/fixtures/account-agent.mjs behind a `claude` wrapper, its login the
 * directory $CLAUDE_CONFIG_DIR points to. No real model CLI runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { byHeadroom, loginCheckArgv } from "../src/adapters/accounts.js";
import { collectConfigWarnings, loadConfig, resolveAdapterConcurrency } from "../src/adapters/config.js";
import type { AgentView } from "../src/runtime/runs-view.js";
import { Bridge } from "../src/bridge.js";
import { loginCheck, runDoctor } from "../src/doctor.js";
import { ConfigError } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { resolveModel } from "../src/routing.js";
import { accountLines } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

const POSIX_ONLY = { skip: process.platform === "win32" };
const AGENT = fileURLToPath(new URL("./fixtures/account-agent.mjs", import.meta.url));

interface Setup {
  root: string;
  /** The `claude` wrapper around the fixture. */
  claude: string;
  /** Each account's config dir, by name. */
  dirs: Record<string, string>;
}

/** A temp root with a `claude` wrapper and a config dir per account; `logged` ones have a login, `spent` ones a spent quota. */
function setup(names: string[], opts: { logged?: string[]; spent?: string[] } = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), "odw-accounts-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec "${execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 });
  const dirs: Record<string, string> = {};
  for (const name of names) {
    dirs[name] = join(root, `claude-${name}`);
    mkdirSync(dirs[name]!);
    if (opts.logged?.includes(name)) writeFileSync(join(dirs[name]!, ".credentials.json"), "placeholder-login");
    if (opts.spent?.includes(name)) writeFileSync(join(dirs[name]!, "quota"), "");
  }
  return { root, claude, dirs };
}

function writeConfig(s: Setup, extra: Record<string, unknown> = {}): string {
  const path = join(s.root, "odw.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      defaultAdapter: "claude",
      adapters: { claude: { command: [s.claude], stdin: "{prompt}" } },
      accounts: { claude: Object.entries(s.dirs).map(([name, configDir]) => ({ name, configDir })) },
      ...extra,
    }),
  );
  return path;
}

function configError(raw: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "odw-accounts-cfg-"));
  try {
    const path = join(root, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    assert.throws(() => loadConfig(path, { quiet: true }), ConfigError);
    try {
      loadConfig(path, { quiet: true });
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-accounts-src-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "repo\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return dir;
}

async function runFlow(s: Setup, source: string, body: string, extra: Record<string, unknown> = {}) {
  const configPath = writeConfig(s, extra);
  const script = join(s.root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const store = new RunStore(join(s.root, "runs"));
  const id = store.create({ script, args: null, source, configPath });
  const state = await executeRun(store.runDir(id));
  const ofType = (type: string): WorkflowEvent[] => store.readEvents(id).filter((e) => e.type === type);
  return { id, state, store, ofType };
}

// --- expansion and validation ------------------------------------------------------

test("accounts: each entry becomes <adapter>@<name> — its config-dir variable, its own cap, the same definition", () => {
  const s = setup([]);
  try {
    const path = join(s.root, "odw.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        concurrency: 8,
        adapters: { claude: { concurrency: 2 } },
        accounts: {
          claude: [
            { name: "work", configDir: "~/.claude-work" },
            { name: "home", configDir: join(s.root, "home"), concurrency: 1, label: "Home" },
          ],
          codex: [{ name: "team", configDir: join(s.root, "codex-team") }],
        },
        fallback: { "claude@work": ["codex@team"] },
      }),
    );
    const config = loadConfig(path, { quiet: true });
    const work = config.adapters["claude@work"]!;
    assert.deepEqual(work.account, { adapter: "claude", name: "work", configDir: join(homedir(), ".claude-work"), dirEnv: "CLAUDE_CONFIG_DIR" });
    assert.equal(work.env?.CLAUDE_CONFIG_DIR, join(process.env.HOME?.trim() || homedir(), ".claude-work"), "~ expanded");
    assert.deepEqual(work.command, config.adapters.claude!.command, "the same command");
    assert.deepEqual(work.output, config.adapters.claude!.output, "the same output decoding");
    assert.equal(work.label, "Claude Code (work)");
    assert.equal(config.adapters["claude@home"]!.label, "Home");
    assert.equal(config.adapters["codex@team"]!.env?.CODEX_HOME, join(s.root, "codex-team"));
    assert.deepEqual(config.accounts, { claude: ["claude@work", "claude@home"], codex: ["codex@team"] });
    // Each account has a concurrency cap of its own: its adapter's, or the one it sets.
    const caps = resolveAdapterConcurrency(config);
    assert.deepEqual([caps.claude, caps["claude@work"], caps["claude@home"]], [2, 2, 1]);
    assert.deepEqual(config.settings.fallback, { "claude@work": ["codex@team"] }, "accounts are adapters a fallback may name");
    assert.deepEqual(collectConfigWarnings({ accounts: {} }), [], "accounts is a known key");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("accounts: a CLI without a config-dir variable, and malformed entries, are refused", () => {
  assert.match(configError({ accounts: { gemini: [{ name: "a", configDir: "/tmp/a" }] } }), /no config-dir variable of 'gemini'.*CLAUDE_CONFIG_DIR.*CODEX_HOME/);
  assert.match(configError({ accounts: { nope: [{ name: "a", configDir: "/tmp/a" }] } }), /"accounts.nope" names unknown adapter 'nope'/);
  assert.match(configError({ accounts: { claude: [] } }), /non-empty list/);
  assert.match(configError({ accounts: { claude: [{ name: "a b", configDir: "/tmp/a" }] } }), /accounts.claude"\[0\]\.name must be/);
  assert.match(configError({ accounts: { claude: [{ name: "a" }] } }), /configDir must be/);
  assert.match(configError({ accounts: { claude: [{ name: "a", configDir: "rel/dir" }] } }), /absolute path/);
  assert.match(configError({ accounts: { claude: [{ name: "a", configDir: "/tmp/a", dir: "x" }] } }), /takes name, configDir, concurrency, label; got "dir"/);
  assert.match(
    configError({ accounts: { claude: [{ name: "a", configDir: "/tmp/a" }, { name: "a", configDir: "/tmp/b" }] } }),
    /adapter 'claude@a' is already configured/,
  );
  assert.match(configError({ accounts: { claude: [{ name: "a", configDir: "/tmp/a", concurrency: 0 }] } }), /concurrency must be a positive integer/);
  assert.match(configError({ accounts: [] }), /"accounts" must be an object/);
  assert.match(configError({ fallback: { claude: ["claude@nope"] } }), /unknown adapter 'claude@nope'/);
});

test("accounts: a model tier without an id for the account uses its adapter's", () => {
  const s = setup(["work"]);
  try {
    const config = loadConfig(writeConfig(s, { models: { fast: { claude: "claude-fast" } } }), { quiet: true });
    const notes: string[] = [];
    assert.equal(resolveModel("@fast", config.adapters["claude@work"]!, config.settings, notes), "claude-fast");
    assert.deepEqual(notes, []);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

// --- routing ------------------------------------------------------------------------

test("byHeadroom: not paused first, then fewest quota failures, then fewest running; ties keep config order", () => {
  const seen: Record<string, { out: boolean; quotaFailures: number; running: number }> = {
    a: { out: true, quotaFailures: 0, running: 0 },
    b: { out: false, quotaFailures: 2, running: 0 },
    c: { out: false, quotaFailures: 0, running: 3 },
    d: { out: false, quotaFailures: 0, running: 1 },
    e: { out: false, quotaFailures: 0, running: 1 },
  };
  assert.deepEqual(byHeadroom(["a", "b", "c", "d", "e"], (n) => seen[n]!), ["d", "e", "c", "b", "a"]);
});

test("a call on the adapter means any account: routed calls spread by running, a release frees the account", () => {
  const s = setup(["a", "b", "c"]);
  try {
    const bridge = new Bridge(loadConfig(writeConfig(s), { quiet: true }), { source: s.root });
    const first = bridge.route("claude");
    assert.deepEqual(first.chain.map((a) => a.name), ["claude@a", "claude@b", "claude@c"]);
    assert.equal(first.pooled, true);
    const second = bridge.route("claude");
    const third = bridge.route(undefined); // the default adapter is the pool too
    assert.deepEqual([second, third].map((r) => r.chain[r.start]!.name), ["claude@b", "claude@c"]);
    assert.deepEqual(bridge.headroom("claude@a"), { out: false, quotaFailures: 0, running: 1 });
    bridge.releaseRoute(second);
    bridge.releaseRoute(second); // idempotent
    assert.equal(bridge.route("claude").chain[0]!.name, "claude@b");
    // Naming one account runs on that one alone.
    const named = bridge.route("claude@c");
    assert.deepEqual([named.chain.map((a) => a.name), named.pooled], [["claude@c"], undefined]);
    // A list expands each adapter with accounts in place.
    assert.deepEqual(bridge.chainFor(["claude@c", "claude"]).map((a) => a.name), ["claude@c", "claude@a", "claude@b"]);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("each account's CLI gets its own config dir; a spent account counts against its headroom", POSIX_ONLY, async () => {
  const s = setup(["a", "b"], { spent: ["a"] });
  try {
    const bridge = new Bridge(loadConfig(writeConfig(s), { quiet: true }), { source: s.root });
    const direct = await bridge.run({ prompt: "hi", adapter: "claude@b" });
    assert.match(direct.text, new RegExp(`^dir=${s.dirs.b} `), "claude@b ran with its own CLAUDE_CONFIG_DIR");
    const pooled = await bridge.run({ prompt: "hi" });
    assert.match(pooled.text, new RegExp(`^dir=${s.dirs.b} `), "moved from the spent account to the next");
    assert.deepEqual(pooled.fellBackFrom, ["claude@a"]);
    assert.deepEqual(bridge.headroom("claude@a"), { out: false, quotaFailures: 1, running: 0 });
    // The account that failed now comes last.
    assert.deepEqual(bridge.chainFor("claude").map((a) => a.name), ["claude@b", "claude@a"]);
    const again = await bridge.run({ prompt: "hi" });
    assert.equal(again.fellBackFrom, undefined, "started on the account with headroom");
    assert.equal(readFileSync(join(s.dirs.a!, "runs.log"), "utf8").split("\n").filter(Boolean).length, 1);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a workflow run: a spent account hands the work over to the next one, and the events name both accounts", POSIX_ONLY, async () => {
  const s = setup(["a", "b"], { spent: ["a"] });
  const src = makeRepo();
  try {
    const flow = await runFlow(s, src, "return await agent('build it', { isolation: 'worktree' })\n");
    assert.equal(flow.state, "done");
    // Handoff is on for an account chain without any `fallback.handoff`: b found a's edits and the brief.
    assert.equal(flow.store.readResult(flow.id), `dir=${s.dirs.b} partial=yes brief=yes`);
    const [started] = flow.ofType("agent_started");
    assert.equal(started!.adapter, "claude@a");
    const [handoff] = flow.ofType("handoff");
    assert.deepEqual([handoff!.from, handoff!.to, handoff!.reason], ["claude@a", "claude@b", "quota"]);
    const [finished] = flow.ofType("agent_finished");
    assert.deepEqual([finished!.adapter, finished!.fellBackFrom], ["claude@b", ["claude@a"]]);

    // An agent()'s own handoff: false starts the work over instead.
    const fresh = await runFlow(s, src, "return await agent('build it', { isolation: 'worktree', handoff: false })\n");
    assert.equal(fresh.state, "done");
    // A new run: a is first again, fails, and b starts over in a fresh worktree.
    assert.equal(fresh.store.readResult(fresh.id), `dir=${s.dirs.b} partial=no brief=no`);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("a fan-out spreads over the accounts, each under its own concurrency cap", POSIX_ONLY, async () => {
  const s = setup(["a", "b"]);
  const src = makeRepo();
  try {
    const flow = await runFlow(s, src, "return await parallel([1, 2, 3, 4].map((i) => () => agent('job ' + i)))\n", {
      adapters: { claude: { command: [s.claude], stdin: "{prompt}", concurrency: 1 } },
    });
    assert.equal(flow.state, "done");
    const on = flow.ofType("agent_started").map((e) => e.adapter as string).sort();
    assert.deepEqual(on, ["claude@a", "claude@a", "claude@b", "claude@b"]);
    const results = flow.store.readResult(flow.id) as string[];
    assert.deepEqual(results.map((r) => r.split(" ")[0]).sort(), [`dir=${s.dirs.a}`, `dir=${s.dirs.a}`, `dir=${s.dirs.b}`, `dir=${s.dirs.b}`]);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

// --- doctor ------------------------------------------------------------------------

test("odw doctor checks each account's login without a model call; --smoke probes each account", POSIX_ONLY, async () => {
  const s = setup(["a", "b"], { logged: ["a"], spent: ["b"] });
  try {
    const config = loadConfig(writeConfig(s), { quiet: true });
    const report = await runDoctor({ config, configPath: null, cwd: s.root, smoke: ["claude"], env: process.env });
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    const a = byId.get("login:claude@a")!;
    assert.equal(a.status, "ok");
    assert.match(a.detail, new RegExp(`CLAUDE_CONFIG_DIR=${s.dirs.a} · logged in \\(\`auth status\`\\)`));
    const b = byId.get("login:claude@b")!;
    assert.equal(b.status, "warn");
    assert.match(b.detail, /not logged in \(`auth status` exited 1: Not logged in\)/);
    assert.match(b.hint!, new RegExp(`CLAUDE_CONFIG_DIR=${s.dirs.b} ${s.claude} auth login`));
    // --smoke on the adapter is a smoke run per account: a answers, b's quota is spent.
    assert.equal(byId.get("smoke:claude@a")!.status, "ok");
    assert.equal(byId.get("smoke:claude@b")!.status, "fail");
    assert.equal(byId.has("smoke:claude"), false);
    // No --version run per account: their CLI is their adapter's.
    assert.equal(byId.has("adapter:claude@a"), false);
    assert.equal(byId.get("adapter:claude")!.status, "ok");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("loginCheck: the CLIs' own status commands, and 'not checked' for a CLI without one", async () => {
  const base = { command: ["/opt/bin/codex", "exec"] };
  assert.deepEqual(loginCheckArgv({ name: "codex@x", ...base }), ["/opt/bin/codex", "login", "status"]);
  assert.deepEqual(loginCheckArgv({ name: "claude@x", command: ["claude", "-p"] }), ["claude", "auth", "status"]);
  const other = { name: "other@x", command: ["other"], account: { adapter: "other", name: "x", configDir: "/x", dirEnv: "OTHER_HOME" } };
  let ran = false;
  const check = await loginCheck(other, async () => {
    ran = true;
    return { returncode: 0, stdout: "", stderr: "", timedOut: false, duration: 0 };
  });
  assert.equal(ran, false);
  assert.deepEqual([check.status, check.detail], ["skip", "OTHER_HOME=/x · login not checked — ODW knows no login check of other"]);
});

// --- odw status ----------------------------------------------------------------------

test("odw status groups agents by account", () => {
  const agent = (adapter: string, state: string, fellBackFrom?: string[]): AgentView =>
    ({ kind: "agent", adapter, state, label: "x", agentId: 1, ...(fellBackFrom ? { fellBackFrom } : {}) }) as unknown as AgentView;
  const lines = accountLines([
    agent("claude@work", "done"),
    agent("claude@home", "running", ["claude@work"]),
    agent("claude@home", "done"),
    agent("codex", "done"),
  ]);
  assert.deepEqual(lines, ["accounts of claude: claude@home 2 agents, 1 running · claude@work 1 agent, 1 moved on (quota or login)"]);
  assert.deepEqual(accountLines([agent("codex", "done")]), []);
});
