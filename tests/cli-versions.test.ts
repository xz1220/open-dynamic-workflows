import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { RunCommandOptions } from "../src/adapters/runner.js";
import type { Adapter, CliResult } from "../src/adapters/types.js";
import { main } from "../src/cli.js";
import type { WorkflowEvent } from "../src/events.js";
import { VERSION } from "../src/index.js";
import {
  adapterFingerprint,
  CliVersions,
  MIN_REPROBE_MS,
  REPROBE_MS,
  runSetup,
  versionOf,
  versionProbe,
  VERSION_TIMEOUT_SECONDS,
} from "../src/provenance.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

// Recording what ran (ODW extension): each adapter CLI's version, probed once
// per run beside its first agent, never delaying or failing the run; the
// run's behaviour settings on run_started; odw's version and the source hash
// in meta.json.

const adapter = (name: string, command: string[], extra: Partial<Adapter> = {}): Adapter => ({ name, command, ...extra });
const cli = (fields: Partial<CliResult>): CliResult => ({ returncode: 0, stdout: "", stderr: "", timedOut: false, duration: 0, ...fields });

test("which commands are probed: an installed CLI yes; node, interpreters, scripts and relative paths no", () => {
  for (const exe of ["claude", "codex", "agent", "/usr/local/bin/claude", "C:\\Tools\\kilo.exe", "claude.cmd"]) {
    assert.equal(versionProbe(adapter("x", [exe, "{prompt}"])), exe, exe);
  }
  for (const exe of [
    "node",
    "/usr/bin/node",
    "node.exe",
    execPath,
    "python3",
    "python3.12",
    "bun",
    "npx",
    "sh",
    "bash",
    "env",
    "./bin/agent",
    "scripts/agent",
    "agent.mjs",
    "/opt/agents/agent.py",
    "run.sh",
    "{workspace}/agent",
    "",
  ]) {
    assert.equal(versionProbe(adapter("x", [exe, "x"])), null, exe);
  }
  // Every built-in adapter is an installed CLI.
  for (const builtin of Object.values(defaultConfig().adapters)) assert.equal(versionProbe(builtin), builtin.command[0]);
});

test("a probe's finding: the first line it printed, or why there is none", () => {
  assert.deepEqual(versionOf(cli({ stdout: "\n2.1.302 (Claude Code)\nmore\n", stderr: "warning" })), { version: "2.1.302 (Claude Code)" });
  assert.deepEqual(versionOf(cli({ stderr: "gemini 0.9.0\n" })), { version: "gemini 0.9.0" });
  assert.deepEqual(versionOf(cli({ stdout: "\x1b[32mv1\x1b[0m" })), { version: "v1" }, "escapes stripped");
  assert.deepEqual(versionOf(cli({ timedOut: true, returncode: -1 })), { version: null, error: `no answer within ${VERSION_TIMEOUT_SECONDS}s` });
  assert.deepEqual(versionOf(cli({ returncode: 127, stderr: "failed to launch 'x': spawn x ENOENT" })), { version: null, error: "not found" });
  assert.deepEqual(versionOf(cli({ returncode: 2, stderr: "unknown option --version" })), {
    version: null,
    error: "exited 2: unknown option --version",
  });
  assert.deepEqual(versionOf(cli({})), { version: null, error: "printed nothing" });
  assert.equal((versionOf(cli({ stdout: "v".repeat(500) })) as { version: string }).version.length <= 120, true);
});

test("CliVersions probes each adapter once, beside it, and records nothing once the run closes it", async () => {
  const events: WorkflowEvent[] = [];
  const calls: Array<{ command: string[]; options?: RunCommandOptions }> = [];
  const pending: Array<(r: CliResult) => void> = [];
  const versions = new CliVersions({
    emit: (ev) => events.push(ev),
    settings: { agentEnv: "inherit", agentEnvPass: [] },
    cwd: "/src",
    runner: (command, options) => {
      calls.push({ command, options });
      return new Promise<CliResult>((resolve) => {
        pending.push(resolve);
        options?.signal?.addEventListener("abort", () => resolve(cli({ returncode: -1, stderr: "[aborted]" })));
      });
    },
  });
  const claude = adapter("claude", ["claude", "-p"], { env: { CLAUDE_CONFIG_DIR: "/cfg" } });
  versions.note(claude); // returns at once: the probe is not awaited
  versions.note(claude);
  versions.note(adapter("mock", [execPath, "mock.mjs"]));
  versions.note(adapter("codex", ["codex", "exec"]));
  assert.deepEqual(calls.map((c) => c.command), [["claude", "--version"], ["codex", "--version"]]);
  assert.equal(calls[0]!.options!.timeout, VERSION_TIMEOUT_SECONDS);
  assert.equal(calls[0]!.options!.cwd, "/src");
  assert.equal(calls[0]!.options!.env!.CLAUDE_CONFIG_DIR, "/cfg", "the probe gets its adapter's environment");

  pending[0]!(cli({ stdout: "2.1.302 (Claude Code)\n" }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    events.map(({ ts: _ts, ...ev }) => ev),
    [{ type: "cli_version", adapter: "claude", command: "claude", version: "2.1.302 (Claude Code)" }],
  );
  // The run ends with codex's probe still out: it is killed, and records nothing.
  versions.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(events.length, 1);
  versions.note(adapter("gemini", ["gemini"]));
  assert.equal(calls.length, 2, "nothing is probed after close");

  // A runner that throws does not either.
  const quiet = new CliVersions({
    emit: (ev) => events.push(ev),
    settings: { agentEnv: "inherit", agentEnvPass: [] },
    runner: () => {
      throw new Error("bad argv");
    },
  });
  quiet.note(claude);
  await new Promise((r) => setImmediate(r));
  assert.equal(events.at(-1)!.error, "could not start: bad argv");
});

test("a run's setup: the behaviour settings and adapter fingerprints, env values left out", () => {
  const config = defaultConfig();
  config.settings.timeout = 600;
  const setup = runSetup(config);
  assert.equal(setup.settings.timeout, 600);
  assert.equal(setup.settings.permissions, "edit");
  assert.equal("runsRoot" in setup.settings, false, "where things are kept is no behaviour");
  assert.equal("notify" in setup.settings, false, "nor anything that may hold a secret");
  assert.deepEqual(Object.keys(setup.adapters), Object.keys(config.adapters).sort());
  const claude = config.adapters.claude!;
  assert.match(setup.adapters.claude!, /^[0-9a-f]{12}$/);
  assert.equal(adapterFingerprint({ ...claude, label: "renamed" }), setup.adapters.claude, "a label changes nothing");
  assert.notEqual(adapterFingerprint({ ...claude, command: [...claude.command, "--x"] }), setup.adapters.claude);
  const keyed = (value: string) => adapterFingerprint({ ...claude, env: { API_KEY: value } });
  assert.equal(keyed("one-secret-value"), keyed("another-secret"), "env values stay out of it");
});

/** A bin directory on PATH with fake CLIs; Windows runs no shell scripts. */
const posix = { skip: process.platform === "win32" ? "fake CLIs are shell scripts" : false };

function sandbox(): { root: string; bin: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-versions-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  return {
    root,
    bin,
    cleanup: () => {
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function fakeCli(bin: string, name: string, script: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

/**
 * `<name> --version` prints a version and leaves a marker; as an agent it
 * waits (at most a second) for that marker, then says whether it saw it — so
 * the run cannot end before its probe answered.
 */
function versionedCli(bin: string, name: string, marker: string): void {
  fakeCli(
    bin,
    name,
    [
      `if [ "$1" = "--version" ]; then echo "${name} 1.2.3 (test)"; echo "a warning" >&2; touch '${marker}'; exit 0; fi`,
      "cat > /dev/null",
      `i=0; while [ ! -f '${marker}' ] && [ $i -lt 50 ]; do sleep 0.02; i=$((i+1)); done`,
      `if [ -f '${marker}' ]; then echo "probed"; else echo "not probed"; fi`,
    ].join("\n"),
  );
}

function launch(root: string, adapters: Record<string, unknown>, workflow: string, extra: Record<string, unknown> = {}) {
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ adapters, ...extra }));
  const script = join(root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${workflow}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath });
  return { store, id, script };
}

const versionEvents = (events: WorkflowEvent[]) =>
  events.filter((e) => e.type === "cli_version").map(({ ts: _ts, ...ev }) => ev);

test("a fake CLI's --version is recorded as a cli_version event, in the run's views and odw status", posix, async () => {
  const box = sandbox();
  try {
    versionedCli(box.bin, "fakecli", join(box.root, "probed"));
    const { store, id, script } = launch(
      box.root,
      { fake: { command: ["fakecli", "--print"], stdin: "{prompt}" } },
      "const a = await agent('one', { adapter: 'fake', label: 'a', model: 'big' })\nconst b = await agent('two', { adapter: 'fake', label: 'b' })\nreturn [a, b]\n",
    );
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readResult(id), ["probed", "probed"]);
    const events = store.readEvents(id);
    assert.deepEqual(versionEvents(events), [{ type: "cli_version", adapter: "fake", command: "fakecli", version: "fakecli 1.2.3 (test)" }], "once per run");
    assert.equal(events.at(-1)!.type, "run_finished", "nothing follows the terminal event");
    // What else the run recorded: the setup, each call's key and model, odw's version and the source hash.
    const started = events.find((e) => e.type === "run_started")!;
    assert.deepEqual(Object.keys(started.setup as object), ["settings", "adapters"]);
    const agents = events.filter((e) => e.type === "agent_started");
    assert.match(String(agents[0]!.key), /^[0-9a-f]{64}$/);
    assert.deepEqual([agents[0]!.model, "model" in agents[1]!], ["big", false]);
    const meta = store.readMeta(id);
    assert.equal(meta.odwVersion, VERSION);
    assert.equal(meta.sourceHash, createHash("sha256").update(readFileSync(script, "utf8")).digest("hex"));

    const run = detail(store, id);
    assert.deepEqual(run.cliVersions, { fake: { command: "fakecli", version: "fakecli 1.2.3 (test)" } });
    assert.deepEqual([run.odwVersion, run.sourceHash], [VERSION, meta.sourceHash]);
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (s: unknown) => (out.push(String(s)), true);
    try {
      assert.equal(await main(["status", id, "--runs-root", join(box.root, "runs")]), 0);
    } finally {
      process.stdout.write = write;
    }
    assert.match(out.join(""), /^ {2}CLIs: fake fakecli 1\.2\.3 \(test\)$/m);
  } finally {
    box.cleanup();
  }
});

test("a hanging --version never delays the run: it is killed at the end and records nothing", posix, async () => {
  const box = sandbox();
  try {
    const pidFile = join(box.root, "probe.pid");
    fakeCli(box.bin, "hangcli", `if [ "$1" = "--version" ]; then echo $$ > '${pidFile}'; exec sleep 30; fi\ncat > /dev/null\necho done`);
    const { store, id } = launch(box.root, { hang: { command: ["hangcli"], stdin: "{prompt}" } }, "return await agent('x', { adapter: 'hang' })\n");
    const started = Date.now();
    assert.equal(await executeRun(store.runDir(id)), "done");
    const took = Date.now() - started;
    assert.ok(took < VERSION_TIMEOUT_SECONDS * 1000, `the run did not wait for the probe (${took}ms)`);
    const events = store.readEvents(id);
    assert.deepEqual(versionEvents(events), []);
    assert.equal(events.at(-1)!.type, "run_finished");
    // The probe was killed with the run's end, not left to its own timeout.
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    // A probe killed before it wrote its pid never ran: nothing is left of it.
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(), false, "the hanging probe is gone");
  } finally {
    box.cleanup();
  }
});

test("a missing binary is fine: its version is unknown, the run goes on", posix, async () => {
  const box = sandbox();
  try {
    versionedCli(box.bin, "fakecli", join(box.root, "probed"));
    const { store, id } = launch(
      box.root,
      { ghost: { command: ["odw-test-no-such-cli"], stdin: "{prompt}" }, fake: { command: ["fakecli"], stdin: "{prompt}" } },
      "let lost = null\ntry { await agent('x', { adapter: 'ghost' }) } catch (e) { lost = 'failed' }\nreturn [lost, await agent('y', { adapter: 'fake' })]\n",
    );
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readResult(id), ["failed", "probed"]);
    assert.deepEqual(versionEvents(store.readEvents(id)), [
      { type: "cli_version", adapter: "ghost", command: "odw-test-no-such-cli", version: null, error: "not found" },
      { type: "cli_version", adapter: "fake", command: "fakecli", version: "fakecli 1.2.3 (test)" },
    ]);
    assert.deepEqual(detail(store, id).cliVersions!.ghost, { command: "odw-test-no-such-cli", version: null, error: "not found" });
  } finally {
    box.cleanup();
  }
});

test("recordVersions: false runs no probe", posix, async () => {
  const box = sandbox();
  try {
    versionedCli(box.bin, "fakecli", join(box.root, "probed"));
    const { store, id } = launch(
      box.root,
      { fake: { command: ["fakecli"], stdin: "{prompt}" } },
      "return await agent('x', { adapter: 'fake' })\n",
      { recordVersions: false },
    );
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.equal(store.readResult(id), "not probed");
    assert.deepEqual(versionEvents(store.readEvents(id)), []);
    assert.deepEqual(detail(store, id).cliVersions, {});
  } finally {
    box.cleanup();
  }
});

test("recordVersions loads, defaults to true, and rejects a non-boolean", () => {
  assert.equal(defaultConfig().settings.recordVersions, true);
  const dir = mkdtempSync(join(tmpdir(), "odw-cli-versions-cfg-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify({ recordVersions: "no" }));
    assert.throws(() => loadConfig(path, { quiet: true }), /"recordVersions" must be true or false/);
    writeFileSync(path, JSON.stringify({ recordVersions: false }));
    assert.equal(loadConfig(path, { quiet: true }).settings.recordVersions, false);
    assert.deepEqual(collectConfigWarnings({ recordVersions: false }), []);
    assert.equal(loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true }).settings.recordVersions, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLI updated mid-run (ODW extension): asked again after REPROBE_MS, or at once after an odd failure; a new version is a cli_version_changed", async () => {
  const events: WorkflowEvent[] = [];
  const calls: string[][] = [];
  let version = "1.0.0";
  let clock = 0;
  const versions = new CliVersions({
    emit: (ev) => events.push(ev),
    settings: { agentEnv: "inherit", agentEnvPass: [] },
    runner: async (command) => {
      calls.push(command);
      return version === "gone"
        ? cli({ returncode: 127, stderr: "failed to launch 'claude': spawn claude ENOENT" })
        : cli({ stdout: `${version} (Claude Code)\n` });
    },
    now: () => clock,
  });
  const claude = adapter("claude", ["claude", "-p"]);
  const settle = () => new Promise((r) => setImmediate(r));
  versions.note(claude);
  await settle();
  // Within REPROBE_MS, a dispatch asks nothing; nor does a failure that is no sign of an update.
  clock += REPROBE_MS - 1;
  versions.note(claude);
  versions.failed(claude, "rate_limit");
  versions.failed(claude, "timeout");
  assert.equal(calls.length, 1);
  // Past it, the next dispatch asks again: the same version says nothing.
  clock += 1;
  versions.note(claude);
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(events.map((e) => e.type), ["cli_version"]);

  // Updated under the run: an odd failure has it asked at once, and the change is told.
  version = "1.1.0";
  versions.failed(claude, "exit");
  await settle();
  assert.equal(calls.length, 3);
  assert.deepEqual(
    { ...events.at(-1)!, ts: 0 },
    {
      ts: 0,
      type: "cli_version_changed",
      adapter: "claude",
      command: "claude",
      from: "1.0.0 (Claude Code)",
      to: "1.1.0 (Claude Code)",
      message:
        "adapter 'claude' CLI changed version mid-run: 1.0.0 (Claude Code) → 1.1.0 (Claude Code) — " +
        "its agents from here on run on the new one (the run goes on)",
    },
  );
  // A fan-out failing together asks once a MIN_REPROBE_MS.
  versions.failed(claude, "exit");
  versions.failed(claude, "not_found");
  assert.equal(calls.length, 3);
  // A binary gone mid-update records nothing and keeps the version it knew …
  clock += MIN_REPROBE_MS;
  version = "gone";
  versions.failed(claude, "not_found");
  await settle();
  assert.equal(calls.length, 4);
  assert.equal(events.length, 2);
  // … so the next answer is compared with that one.
  clock += REPROBE_MS;
  version = "1.2.0";
  versions.note(claude);
  await settle();
  assert.deepEqual([events.length, events.at(-1)!.from, events.at(-1)!.to], [3, "1.1.0 (Claude Code)", "1.2.0 (Claude Code)"]);
  // Closed: nothing more.
  versions.close();
  clock += REPROBE_MS;
  versions.note(claude);
  versions.failed(claude, "exit");
  assert.equal(calls.length, 5);
});

test("a run whose CLI was updated under it records the change and goes on", posix, async () => {
  const box = sandbox();
  try {
    const r = box.root;
    writeFileSync(join(r, "ver"), "1.0.0\n");
    const waitFor = (file: string) => `i=0; while [ ! -f '${join(r, file)}' ] && [ $i -lt 150 ]; do sleep 0.02; i=$((i+1)); done`;
    fakeCli(
      box.bin,
      "upcli",
      [
        `if [ "$1" = "--version" ]; then echo "upcli $(cat '${join(r, "ver")}')"; n=$(ls '${r}' | grep -c '^probe\\.'); touch '${r}/probe.'$n; exit 0; fi`,
        "cat > /dev/null",
        waitFor("probe.0"),
        // The first agent: the CLI is updated under it, and it dies oddly.
        `if [ ! -f '${join(r, "failed")}' ]; then sleep 0.2; echo 2.0.0 > '${join(r, "ver")}'; touch '${join(r, "failed")}'; echo boom >&2; exit 1; fi`,
        // The next: once the CLI was asked again.
        waitFor("probe.1"),
        "sleep 0.3; echo ok",
      ].join("\n"),
    );
    const { store, id } = launch(
      r,
      { up: { command: ["upcli"], stdin: "{prompt}" } },
      "let first = null\ntry { await agent('x', { adapter: 'up' }) } catch (e) { first = 'failed' }\nreturn [first, await agent('y', { adapter: 'up' })]\n",
    );
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readResult(id), ["failed", "ok"]);
    const events = store.readEvents(id);
    assert.deepEqual(
      versionEvents(events),
      [{ type: "cli_version", adapter: "up", command: "upcli", version: "upcli 1.0.0" }],
      "the run's cli_version stays its first",
    );
    const changed = events.filter((e) => e.type === "cli_version_changed");
    assert.deepEqual(changed.map((e) => [e.from, e.to]), [["upcli 1.0.0", "upcli 2.0.0"]]);
    assert.equal(events.at(-1)!.type, "run_finished");
  } finally {
    box.cleanup();
  }
});
