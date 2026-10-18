import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, listAdapters, loadConfig } from "../src/adapters/config.js";
import { planPermissions, spliceArgs } from "../src/adapters/permissions.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import { planTrust, trustBanner, untrustedPosture } from "../src/adapters/trust.js";
import type { Config } from "../src/adapters/types.js";
import { main } from "../src/cli.js";
import { buildContext } from "../src/context.js";
import { runDoctor } from "../src/doctor.js";
import { ConfigError } from "../src/errors.js";
import { AGENT_STARTED, LOG, MemorySink } from "../src/events.js";
import type { AgentResultRecord } from "../src/journal.js";
import { createPrimitives } from "../src/primitives.js";
import { BEHAVIOUR_SETTINGS } from "../src/provenance.js";
import { agentRows } from "../src/runtime/agents-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { foldAgents } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { applyRunTrust, repositoryConfig, resolveRunTrust } from "../src/untrusted.js";
import { withWorkspace } from "../src/workspace.js";

// Untrusted repositories (ODW extension): each CLI in its documented way of
// ignoring the repository, said loudly where it has none; the repository's
// own worktree setup refused; the trust level everywhere the tier shows.

const ENV_AGENT = fileURLToPath(new URL("./fixtures/env-agent.mjs", import.meta.url));

/** An adapter's argv at the "edit" tier, trusted or not. */
function argv(config: Config, name: string, trust: "trusted" | "untrusted"): string[] {
  const adapter = config.adapters[name]!;
  return spliceArgs(adapter.command, [...planPermissions(adapter, "edit").args, ...planTrust(adapter, trust).args]);
}

test("each built-in runs untrusted with the flags its docs give, and says what it cannot keep out", () => {
  const config = defaultConfig();
  // Claude Code: --safe-mode after the tier's flags.
  assert.deepEqual(argv(config, "claude", "untrusted"), [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "WebSearch",
    "WebFetch",
    "--safe-mode",
    "--no-session-persistence",
  ]);
  assert.deepEqual(argv(config, "qwen", "untrusted"), ["qwen", "--approval-mode", "auto-edit", "--safe-mode", "--output-format", "text", "{prompt}"]);
  assert.deepEqual(argv(config, "omp", "untrusted").slice(0, 9), [
    "omp",
    "--print",
    "--no-session",
    "--approval-mode",
    "yolo",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--cwd",
  ]);
  assert.equal(planTrust(config.adapters.claude!, "untrusted").note, undefined, "a full equivalent: nothing to say");
  assert.equal(planTrust(config.adapters.qwen!, "untrusted").note, undefined);
  assert.match(planTrust(config.adapters.omp!, "untrusted").note!, /has no documented way to ignore its AGENTS\.md, CLAUDE\.md, hooks or MCP config/);
  // The rest keep their argv, and each says so.
  for (const name of ["codex", "gemini", "kimi", "kilo", "opencode", "cursor"]) {
    assert.deepEqual(argv(config, name, "untrusted"), argv(config, name, "trusted"), name);
    assert.match(planTrust(config.adapters[name]!, "untrusted").note!, new RegExp(`^${name} has no documented way to ignore the repository's `), name);
  }
  assert.equal(
    planTrust(config.adapters.codex!, "untrusted").note!.split(" (")[0],
    "codex has no documented way to ignore the repository's AGENTS.md — its instructions still reach the agent",
  );
  // Trusted: no flags, nothing to say, for every one.
  for (const adapter of Object.values(config.adapters)) {
    assert.deepEqual(planTrust(adapter, "trusted"), { trust: "trusted", args: [] }, adapter.name);
  }
  assert.equal(untrustedPosture(config.adapters.claude!), "--safe-mode");
  assert.equal(untrustedPosture(config.adapters.codex!), "no documented way");
  assert.equal(untrustedPosture(config.adapters.omp!), "--no-extensions --no-skills --no-rules (partial)");
  assert.equal(listAdapters(config).find((a) => a.name === "claude")!.untrusted, "--safe-mode");
});

test("an adapter may make itself untrusted; nothing loosens an untrusted run; one of the user's own says it keeps nothing out", () => {
  const config = defaultConfig();
  const claude = config.adapters.claude!;
  assert.equal(planTrust({ ...claude, trust: "untrusted" }, "trusted").trust, "untrusted");
  assert.deepEqual(planTrust({ ...claude, trust: "untrusted" }, "trusted").args, ["--safe-mode"]);
  assert.equal(planTrust({ ...claude, trust: "trusted" }, "untrusted").trust, "untrusted", "an adapter's trusted cannot loosen the run");
  const mine = { name: "mine", command: ["my-agent"] };
  assert.match(planTrust(mine, "untrusted").note!, /^adapter 'mine' declares no untrustedArgs, so ODW cannot keep the repository's instructions/);
  assert.equal(planTrust({ ...mine, command: ["my-agent", "{permission_args}"], untrustedArgs: ["--clean"] }, "untrusted").note, undefined);
});

test("trust, untrustedArgs and untrustedNote load, validate, and merge over a built-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-trust-cfg-"));
  const load = (raw: Record<string, unknown>) => {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true });
  };
  try {
    assert.equal(load({}).settings.trust, "trusted", "the default");
    assert.equal(load({ trust: "untrusted" }).settings.trust, "untrusted");
    assert.throws(() => load({ trust: "maybe" }), (e: unknown) => e instanceof ConfigError && /"trust" must be "trusted" or "untrusted"; got "maybe"/.test(e.message));
    // A built-in with flags of the user's own: the built-in's note no longer describes them.
    const codex = load({ adapters: { codex: { untrustedArgs: ["-c", "project_doc_max_bytes=0"] } } }).adapters.codex!;
    assert.deepEqual(codex.untrustedArgs, ["-c", "project_doc_max_bytes=0"]);
    assert.equal(codex.untrustedNote, undefined);
    assert.equal(load({ adapters: { codex: { trust: "untrusted" } } }).adapters.codex!.untrustedNote?.startsWith("codex has no"), true);
    const mine = load({
      adapters: { mine: { command: ["x", "{permission_args}"], permissionArgs: { edit: [] }, trust: "untrusted", untrustedArgs: ["--clean"], untrustedNote: "x reads .x/rules anyway" } },
    }).adapters.mine!;
    assert.deepEqual([mine.trust, mine.untrustedArgs, mine.untrustedNote], ["untrusted", ["--clean"], "x reads .x/rules anyway"]);
    assert.throws(() => load({ adapters: { mine: { command: ["x"], untrustedArgs: ["--clean"] } } }), /declares "untrustedArgs" but its command has no \{permission_args\} element/);
    assert.throws(() => load({ adapters: { mine: { command: ["x"], trust: "yes" } } }), /adapter 'mine' 'trust' must be "trusted" or "untrusted"/);
    assert.throws(() => load({ adapters: { mine: { command: ["x"], untrustedArgs: "--clean" } } }), /'untrustedArgs' must be a list of argv elements/);
    assert.deepEqual(collectConfigWarnings({ trust: "untrusted", adapters: { codex: { trust: "untrusted", untrustedArgs: [], untrustedNote: "n" } } }), []);
    assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("trust"), "a run's setup records its trust");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A run over `config` whose CLIs are not spawned: the argv each would get is recorded. */
function harness(config: Config, saved: AgentResultRecord[] = []) {
  const sink = new MemorySink();
  const spawned: string[][] = [];
  const runner: CommandRunner = async (command) => {
    spawned.push(command);
    return { returncode: 0, stdout: "done", stderr: "", timedOut: false, duration: 0.01 };
  };
  const ctx = buildContext(config, { sink, source: "/repo", bridge: { runner }, saveAgentResult: (rec) => saved.push(rec) });
  return { sink, spawned, p: createPrimitives(ctx) };
}

function untrustedConfig(): Config {
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  config.settings.trust = "untrusted";
  config.adapters.mine = { name: "mine", command: ["my-agent"] };
  return config;
}

test("an untrusted run adds each CLI's flags, says once per adapter what reaches it anyway, and every agent says it ran untrusted", async () => {
  const saved: AgentResultRecord[] = [];
  const { sink, spawned, p } = harness(untrustedConfig(), saved);
  await p.agent("TASK a", { label: "a" });
  await p.parallel([1, 2].map((n) => () => p.agent(`TASK c${n}`, { adapter: "codex", label: `c${n}` })));
  await p.agent("TASK m", { adapter: "mine", label: "m" });
  assert.ok(spawned[0]!.includes("--safe-mode"), spawned[0]!.join(" "));
  assert.equal(spawned.slice(1).some((cmd) => cmd.includes("--safe-mode")), false);
  const notes = sink.ofType(LOG).filter((e) => e.trust === "untrusted");
  assert.deepEqual(
    notes.map((e) => [e.adapter, String(e.message).split(" — ")[0]]),
    [
      ["codex", "codex has no documented way to ignore the repository's AGENTS.md"],
      ["mine", "adapter 'mine' declares no untrustedArgs, so ODW cannot keep the repository's instructions, settings and hooks from it"],
    ],
    "once per adapter, on the run's log — never for claude, whose --safe-mode keeps it all out",
  );
  assert.deepEqual(sink.ofType(AGENT_STARTED).map((e) => e.trust), ["untrusted", "untrusted", "untrusted", "untrusted"]);
  assert.deepEqual(saved.map((rec) => rec.trust), ["untrusted", "untrusted", "untrusted", "untrusted"]);
  assert.deepEqual(foldAgents(sink.events).map((a) => a.trust), ["untrusted", "untrusted", "untrusted", "untrusted"]);
});

test("a trusted run adds no flags, says nothing, and its events carry no trust field", async () => {
  const config = untrustedConfig();
  config.settings.trust = "trusted";
  const saved: AgentResultRecord[] = [];
  const { sink, spawned, p } = harness(config, saved);
  await p.agent("TASK a");
  await p.agent("TASK c", { adapter: "codex" });
  assert.equal(spawned.flat().includes("--safe-mode"), false);
  assert.equal(sink.ofType(LOG).some((e) => e.trust !== undefined), false);
  assert.equal(sink.ofType(AGENT_STARTED).some((e) => "trust" in e), false);
  assert.equal(saved.some((rec) => "trust" in rec), false);
  assert.equal("trust" in foldAgents(sink.events)[0]!, false);
});

test("the trust banner: one word trusted, else how each installed adapter runs untrusted", () => {
  const config = defaultConfig();
  const installed = (names: string[]) => (adapter: { name: string }) => names.includes(adapter.name);
  assert.equal(trustBanner(config, installed(["claude", "codex"])), "trust: trusted");
  config.settings.trust = "untrusted";
  assert.equal(trustBanner(config, installed(["claude", "codex", "omp"])), "trust: untrusted — claude --safe-mode, codex no documented way, omp --no-extensions --no-skills --no-rules (partial)");
  config.settings.trust = "trusted";
  config.adapters.codex = { ...config.adapters.codex!, trust: "untrusted" };
  assert.equal(trustBanner(config, installed(["claude", "codex"])), "trust: trusted (untrusted adapters) — codex no documented way");
});

// --- the repository's own code -------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A repo with `committed` in its one commit, and `extra` written afterwards (untracked). */
function makeRepo(committed: Record<string, string>, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-trust-repo-"));
  git(dir, "init", "-q");
  write(dir, committed);
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  write(dir, extra);
  return dir;
}

test("untrusted, the repository's .worktreeinclude links nothing (said once), and still copies", async () => {
  const src = makeRepo(
    { "a.txt": "x\n", ".gitignore": "node_modules/\n.env\n" },
    { ".worktreeinclude": "symlink: node_modules\n.env\n", "node_modules/pkg/index.js": "1\n", ".env": "K=v\n" },
  );
  try {
    const refused: string[] = [];
    await withWorkspace(
      src,
      "worktree",
      async (ws) => {
        assert.equal(existsSync(join(ws.path, "node_modules")), false, "not linked, not copied");
        assert.equal(readFileSync(join(ws.path, ".env"), "utf8"), "K=v\n", "a plain line still copies");
      },
      { untrusted: true, onRefused: (message) => refused.push(message) },
    );
    assert.equal(refused.length, 1);
    assert.match(refused[0]!, /^untrusted run: \.worktreeinclude is the repository's own, so its symlink: lines link nothing \(node_modules\)/);
    // Trusted, the same file links as before.
    await withWorkspace(src, "worktree", async (ws) => {
      assert.ok(lstatSync(join(ws.path, "node_modules")).isSymbolicLink() || process.platform === "win32");
    });
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a config inside the repository is its own: untrusted, its worktreeSetup is dropped and the run says so", () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const mine = mkdtempSync(join(tmpdir(), "odw-trust-mine-"));
  try {
    const repoConfig = join(src, "odw.config.json");
    const userConfig = join(mine, "config.json");
    writeFileSync(repoConfig, JSON.stringify({ worktreeSetup: "touch pwned" }));
    writeFileSync(userConfig, JSON.stringify({ worktreeSetup: "npm ci" }));
    assert.equal(repositoryConfig(repoConfig, src), repoConfig);
    assert.equal(repositoryConfig(userConfig, src), null);
    assert.equal(repositoryConfig(null, join(src), src), join(src, "odw.config.json"), "found as ./odw.config.json");

    const theirs = loadConfig(repoConfig, { quiet: true });
    const untrusted = applyRunTrust(theirs, resolveRunTrust({ flag: "untrusted", config: theirs, configPath: repoConfig, source: src }));
    assert.equal(untrusted.config.settings.trust, "untrusted");
    assert.equal(untrusted.config.settings.worktreeSetup, null);
    assert.equal(theirs.settings.worktreeSetup, "touch pwned", "the loaded config itself is left alone");
    assert.match(untrusted.notes[0]!, /^untrusted run \(--untrusted\): /);
    assert.ok(untrusted.notes.some((n) => n.startsWith(`untrusted run: not running the worktreeSetup that the repository's own config (${repoConfig}) sets`)));
    assert.ok(untrusted.notes.some((n) => /the config in use is the repository's own .* pass --config with a file of your own/.test(n)));

    // The user's own config's setup runs; trusted, nothing changes.
    const ours = loadConfig(userConfig, { quiet: true });
    const kept = applyRunTrust(ours, resolveRunTrust({ flag: "untrusted", config: ours, configPath: userConfig, source: src }));
    assert.equal(kept.config.settings.worktreeSetup, "npm ci");
    assert.equal(kept.notes.length, 1, "only the untrusted line");
    const trusted = applyRunTrust(theirs, resolveRunTrust({ flag: null, config: theirs, configPath: repoConfig, source: src }));
    assert.deepEqual([trusted.config.settings.worktreeSetup, trusted.notes], ["touch pwned", []]);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(mine, { recursive: true, force: true });
  }
});

test("a repository's own config cannot loosen the trust your ~/.config/odw/config.json sets", () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const home = mkdtempSync(join(tmpdir(), "odw-trust-home-"));
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    write(home, { ".config/odw/config.json": JSON.stringify({ trust: "untrusted" }) });
    const repoConfig = join(src, "odw.config.json");
    writeFileSync(repoConfig, JSON.stringify({ trust: "trusted" }));
    const config = loadConfig(repoConfig, { quiet: true });
    const run = resolveRunTrust({ flag: null, config, configPath: null, source: src, cwd: src });
    assert.equal(run.trust, "untrusted");
    assert.match(run.why!, /~\/\.config\/odw\/config\.json, which the repository's own config cannot loosen/);
    // A config of the user's own (outside the repository) is theirs to decide.
    const outside = join(home, "elsewhere.json");
    writeFileSync(outside, JSON.stringify({ trust: "trusted" }));
    assert.equal(resolveRunTrust({ flag: null, config: loadConfig(outside, { quiet: true }), configPath: outside, source: src }).trust, "trusted");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(src, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/** Run `body` over `source` untrusted, with the env-reporting agent, its config at `configPath`. */
async function untrustedRun(root: string, source: string, configPath: string, body: string) {
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "env",
      worktreeSetup: [execPath, "-e", "require('fs').writeFileSync('setup.out', 'ran')"],
      adapters: { env: { command: [execPath, ENV_AGENT, "setup.out"], stdin: "{prompt}" } },
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source, configPath, trust: "untrusted" });
  return { id, state: await executeRun(store.runDir(id)), store };
}

test("an untrusted run never runs the worktreeSetup of the repository's own config, and records its trust", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-trust-run-"));
  const body = "return JSON.parse(await agent('report', { label: 'iso', isolation: 'worktree' })).files['setup.out']\n";
  try {
    const theirs = await untrustedRun(root, src, join(src, "odw.config.json"), body);
    assert.equal(theirs.state, "done");
    assert.equal(theirs.store.readResult(theirs.id), null, "the repository's setup did not run");
    assert.equal(theirs.store.readMeta(theirs.id).trust, "untrusted");
    const events = theirs.store.readEvents(theirs.id);
    const started = events.find((e) => e.type === "run_started")!;
    const settings = (started.setup as { settings: Record<string, unknown> }).settings;
    assert.deepEqual([settings.trust, settings.worktreeSetup], ["untrusted", null], "the setup records what ran");
    const logs = events.filter((e) => e.type === LOG).map((e) => String(e.message));
    assert.ok(logs.some((m) => m.startsWith("untrusted run: not running the worktreeSetup that the repository's own config")), logs.join("\n"));
    assert.ok(logs.some((m) => m.startsWith("adapter 'env' declares no untrustedArgs")), "its adapter keeps nothing out: said once");
    assert.equal(events.find((e) => e.type === AGENT_STARTED)!.trust, "untrusted");
    const row = agentRows(theirs.store, theirs.id)[0]!;
    assert.equal(row.trust, "untrusted");

    // The same setup from a config of the user's own runs.
    const ours = await untrustedRun(root, src, join(root, "mine.json"), body);
    assert.equal(ours.state, "done");
    assert.equal(ours.store.readResult(ours.id), "ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

// --- the command line ------------------------------------------------------------

/** Replies with the flags it was started with. */
const ECHO_ARGS = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(process.argv.slice(1).join(' ')||'(none)'))";

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

test("odw run --untrusted: the banner's trust line, the flags, meta, and a rerun that stays untrusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-trust-cli-"));
  const source = join(root, "repo");
  mkdirSync(source);
  try {
    const config = join(root, "mine.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "probe",
        adapters: {
          probe: { command: [execPath, "-e", ECHO_ARGS, "{permission_args}"], stdin: "{prompt}", permissionArgs: { edit: ["tier:edit"] }, untrustedArgs: ["clean:yes"] },
        },
      }),
    );
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('TASK')\n");
    const runsRoot = join(root, "runs");
    const flags = ["--config", config, "--runs-root", runsRoot, "--source", source, "--wait"];
    let r = await cli(["run", script, "--untrusted", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "tier:edit clean:yes");
    assert.match(r.err, /\ntrust: untrusted — [^\n]*probe clean:yes/);
    const id = /running (\S+) \.\.\./.exec(r.err)![1]!;
    const store = new RunStore(runsRoot);
    assert.equal(store.readMeta(id).trust, "untrusted");

    r = await cli(["rerun", id, "--runs-root", runsRoot, "--wait"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "tier:edit clean:yes", "a rerun of an untrusted run is untrusted");
    assert.match(r.err, /\ntrust: untrusted/);

    r = await cli(["run", script, ...flags]);
    assert.equal(JSON.parse(r.out), "tier:edit");
    assert.match(r.err, /\ntrust: trusted\n/);
    assert.equal("trust" in store.readMeta(/running (\S+) \.\.\./.exec(r.err)![1]!), false, "nothing in meta without the flag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw doctor shows the trust level, and how each adapter runs untrusted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-trust-doctor-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify({ trust: "untrusted", runsRoot: join(dir, "runs"), adapters: { bare: { command: [execPath] } } }));
    const report = await runDoctor({ config: loadConfig(path, { quiet: true }), configPath: path, cwd: dir, smoke: [] });
    const check = (id: string) => report.checks.find((c) => c.id === id)!;
    assert.equal(check("trust").status, "warn", "an untrusted config that is the repository's own");
    assert.match(check("trust").detail, /^untrusted \("trust": "untrusted" in the config\) — odw run --untrusted runs .*bare no way declared/);
    assert.match(check("trust").hint!, /the config in use is the repository's own/);
    assert.equal(check("adapter:bare").untrusted, "no way declared");
    assert.equal(check("adapter:claude").untrusted, "--safe-mode", "uninstalled ones too");
    assert.match(check("adapter:claude").detail, / · untrusted: --safe-mode$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an untrusted run never reads a config ODW found by itself inside the repository: its adapters would be the repository's code", async () => {
  const src = makeRepo({ "a.txt": "x\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-trust-swap-"));
  const home = mkdtempSync(join(tmpdir(), "odw-trust-home-"));
  const marker = join(root, "theirs-ran");
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  const oldEnv = process.env.ODW_CONFIG;
  try {
    // The repository's ./odw.config.json would run a command of its choosing as the agent.
    writeFileSync(
      join(src, "odw.config.json"),
      JSON.stringify({ defaultAdapter: "theirs", adapters: { theirs: { command: [execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], stdin: "{prompt}" } } }),
    );
    // The user's own config, outside the repository, names an agent of theirs.
    mkdirSync(join(home, ".config", "odw"), { recursive: true });
    writeFileSync(join(home, ".config", "odw", "config.json"), JSON.stringify({ defaultAdapter: "mine", adapters: { mine: { command: [execPath, "-e", "process.stdout.write('mine answered')"], stdin: "{prompt}" } } }));
    process.env.HOME = home;
    delete process.env.ODW_CONFIG;
    process.chdir(src);
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('hi', { label: 'a' })\n");
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: src, configPath: null, trust: "untrusted" });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.equal(store.readResult(id), "mine answered", "the user's own config ran");
    assert.equal(existsSync(marker), false, "the repository's adapter never ran");
    const logs = store.readEvents(id).filter((e) => e.type === LOG).map((e) => String(e.message));
    assert.ok(logs.some((m) => m.startsWith("untrusted run: not reading the repository's own config")), logs.join("\n"));
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldEnv !== undefined) process.env.ODW_CONFIG = oldEnv;
    rmSync(src, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
