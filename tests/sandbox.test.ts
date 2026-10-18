/**
 * The container sandbox (ODW extension): the argv a container run is built
 * from (a pure function), the config, the tighten-only planning, the private
 * home with the CLI's config copied in, and the doctor checks — no engine.
 * The run path, stop and timeout against a fake engine are in
 * sandbox-run.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadConfig } from "../src/adapters/config.ts";
import {
  CONTAINER_DEFAULTS,
  CONTAINER_HOME,
  DEFAULT_PIDS,
  TMPFS,
  buildSandboxSetting,
  containerArgv,
  containerEnv,
  containerName,
  memoryBytes,
  planSandbox,
  prepareHome,
  sandboxBanner,
  sandboxFlagOf,
  withSandboxFlag,
  type ContainerRun,
} from "../src/adapters/sandbox.ts";
import type { CliResult, ContainerSandbox } from "../src/adapters/types.ts";
import { sandboxChecks } from "../src/doctor.ts";
import { ConfigError } from "../src/errors.ts";
import { BEHAVIOUR_SETTINGS, runSetup } from "../src/provenance.ts";
import { foldAgents } from "../src/runtime/runs-view.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix = "odw-sandbox-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const box = (over: Partial<ContainerSandbox> = {}): ContainerSandbox => ({ ...CONTAINER_DEFAULTS, image: "odw-agents:1", mounts: [], ...over });

function run(over: Partial<ContainerRun> = {}): ContainerRun {
  return {
    engine: "docker",
    image: "odw-agents:1",
    name: "odw-r1-3-abcdef",
    user: { uid: 1000, gid: 1000 },
    workdir: "/work/repo",
    mounts: [
      { source: "/work/repo", target: "/work/repo", readonly: false },
      { source: "/tmp/odw-home-x", target: CONTAINER_HOME, readonly: false },
    ],
    network: "default",
    passEnv: ["ANTHROPIC_API_KEY", "ODW_PORT"],
    setEnv: { HOME: CONTAINER_HOME, TMPDIR: "/tmp" },
    memory: null,
    cpus: null,
    pids: DEFAULT_PIDS,
    labels: { "odw.run": "r1" },
    command: ["claude", "--print"],
    ...over,
  };
}

/** The value after each occurrence of `flag`. */
const valuesOf = (argv: string[], flag: string): string[] => argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1]!] : []));

test("containerArgv: a hardened run of the CLI, the image last before its argv, never a pull", () => {
  const argv = containerArgv(run());
  assert.deepEqual(argv.slice(0, 9), ["docker", "run", "--rm", "-i", "--init", "--pull", "never", "--name", "odw-r1-3-abcdef"]);
  assert.deepEqual(valuesOf(argv, "--user"), ["1000:1000"]);
  assert.deepEqual(valuesOf(argv, "--cap-drop"), ["ALL"]);
  assert.deepEqual(valuesOf(argv, "--security-opt"), ["no-new-privileges"]);
  assert.ok(argv.includes("--read-only"));
  assert.deepEqual(valuesOf(argv, "--tmpfs"), [TMPFS]);
  assert.equal(TMPFS, "/tmp:rw,nosuid,nodev,exec", "tmpfs is noexec by default on podman: say exec");
  assert.deepEqual(valuesOf(argv, "--pids-limit"), ["512"]);
  assert.deepEqual(valuesOf(argv, "--workdir"), ["/work/repo"]);
  assert.deepEqual(valuesOf(argv, "--label"), ["odw.run=r1"]);
  assert.deepEqual(valuesOf(argv, "--mount"), [
    "type=bind,source=/work/repo,target=/work/repo",
    `type=bind,source=/tmp/odw-home-x,target=${CONTAINER_HOME}`,
  ]);
  // The default network: no --network flag at all (the engine's own default).
  assert.equal(argv.includes("--network"), false);
  assert.equal(argv.includes("--memory"), false);
  assert.equal(argv.includes("--cpus"), false);
  assert.equal(argv.includes("--userns"), false, "docker gets no keep-id");
  // Secrets go by name; only HOME and TMPDIR have values in the argv.
  assert.deepEqual(valuesOf(argv, "--env"), [`HOME=${CONTAINER_HOME}`, "TMPDIR=/tmp", "ANTHROPIC_API_KEY", "ODW_PORT"]);
  assert.deepEqual(argv.slice(-3), ["odw-agents:1", "claude", "--print"]);
  // Every option comes before the image: nothing after it is the engine's.
  assert.ok(argv.indexOf("odw-agents:1") > argv.lastIndexOf("--env"));
});

test("containerArgv: no network, limits, read-only binds, podman keep-id, no user where the platform has none", () => {
  const argv = containerArgv(
    run({
      engine: "podman",
      network: "none",
      memory: "4g",
      cpus: 1.5,
      pids: 64,
      mounts: [{ source: "/data/ref", target: "/ref", readonly: true }],
    }),
  );
  assert.equal(argv[0], "podman");
  assert.deepEqual(valuesOf(argv, "--network"), ["none"]);
  assert.deepEqual(valuesOf(argv, "--memory"), ["4g"]);
  assert.deepEqual(valuesOf(argv, "--cpus"), ["1.5"]);
  assert.deepEqual(valuesOf(argv, "--pids-limit"), ["64"]);
  assert.deepEqual(valuesOf(argv, "--mount"), ["type=bind,source=/data/ref,target=/ref,readonly"]);
  assert.deepEqual(valuesOf(argv, "--userns"), ["keep-id"]);
  const bare = containerArgv(run({ user: null }));
  assert.equal(bare.includes("--user"), false);
});

test("containerName: engine-safe, per run and agent, never twice the same", () => {
  const a = containerName("20261018-101010-abc123", 7, () => 0.5);
  assert.equal(a, "odw-20261018-101010-abc123-7-800000");
  assert.match(containerName("run/with spaces", "c1"), /^odw-run-with-spaces-c1-[0-9a-f]{6}$/);
  assert.notEqual(containerName("r", 1), containerName("r", 1));
});

test("containerEnv: the container gets agentEnv's names minus the host's paths; the client gets engine vars and the values", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    AWS_SECRET_ACCESS_KEY: "nope",
  };
  const agent = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    TMPDIR: "/var/tmp/me",
    XDG_CONFIG_HOME: "/home/me/.config",
    CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
    ANTHROPIC_API_KEY: "sk-test-placeholder",
    ODW_PORT: "41000",
    LANG: "C.UTF-8",
  };
  const { pass, client } = containerEnv(agent, host);
  assert.deepEqual(pass, ["ANTHROPIC_API_KEY", "LANG", "ODW_PORT"]);
  assert.equal(client.ANTHROPIC_API_KEY, "sk-test-placeholder");
  assert.equal(client.DOCKER_HOST, "unix:///var/run/docker.sock", "the client finds its engine");
  assert.equal(client.XDG_RUNTIME_DIR, "/run/user/1000", "rootless podman needs its runtime dir");
  assert.equal(client.PATH, "/usr/bin");
  assert.equal(client.HOME, "/home/me");
  assert.equal("AWS_SECRET_ACCESS_KEY" in client, false, "what agentEnv kept out stays out of the client too");
});

test("memoryBytes: the engines' size suffixes", () => {
  assert.equal(memoryBytes("512m"), 512 * 1024 ** 2);
  assert.equal(memoryBytes("4g"), 4 * 1024 ** 3);
  assert.equal(memoryBytes("1024"), 1024);
  assert.ok(Number.isNaN(memoryBytes("lots")));
});

// --- config ---------------------------------------------------------------------

function configFile(body: Record<string, unknown>): string {
  const path = join(tmp(), "odw.config.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

test("config: sandbox defaults to none; a container needs an image and gets the defaults", () => {
  assert.equal(loadConfig(configFile({}), { quiet: true }).settings.sandbox, "none");
  const settings = loadConfig(configFile({ sandbox: { kind: "container", image: "odw-agents:1" } }), { quiet: true }).settings;
  assert.deepEqual(settings.sandbox, {
    kind: "container",
    engine: null,
    image: "odw-agents:1",
    network: "default",
    mounts: [],
    cliConfig: "copy",
    memory: null,
    cpus: null,
    pids: 512,
  });
  assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("sandbox"), "odw compare holds runs to their sandbox");
  assert.deepEqual(runSetup(loadConfig(configFile({ sandbox: { kind: "container", image: "i" } }), { quiet: true })).settings.sandbox, {
    ...CONTAINER_DEFAULTS,
    image: "i",
    mounts: [],
  });
});

test("config: a bad sandbox is a ConfigError that names the field", () => {
  const bad: Array<[unknown, RegExp]> = [
    [{ kind: "container" }, /sandbox\.image" is required/],
    ["container", /sandbox\.image" is required/],
    [{ kind: "vm", image: "x" }, /kind must be "container"/],
    [{ kind: "container", image: "--privileged" }, /image reference/],
    [{ kind: "container", image: "x", network: "host" }, /network must be "none" or "default"/],
    [{ kind: "container", image: "x", engine: "lxc" }, /engine must be "docker" or "podman"/],
    [{ kind: "container", image: "x", cliConfig: "share" }, /cliConfig must be/],
    [{ kind: "container", image: "x", memory: "lots" }, /memory must be a size/],
    [{ kind: "container", image: "x", pids: 0 }, /pids must be a positive whole number/],
    [{ kind: "container", image: "x", cpus: -1 }, /cpus must be a positive number/],
    [{ kind: "container", image: "x", mounts: [{ source: "relative/path" }] }, /must be an absolute path/],
    [{ kind: "container", image: "x", mounts: [{ source: "/a,b" }] }, /comma/],
    [{ kind: "container", image: "x", mounts: [{ source: "/a", rw: true }] }, /unknown field "rw"/],
    [{ kind: "container", image: "x", privileged: true }, /unknown field "privileged"/],
  ];
  for (const [raw, message] of bad) assert.throws(() => buildSandboxSetting(raw), (err: Error) => err instanceof ConfigError && message.test(err.message), JSON.stringify(raw));
  // Mounts are read-only unless the config says otherwise, and bind at the same path by default.
  const setting = buildSandboxSetting({ kind: "container", image: "x", mounts: [{ source: "/data" }, { source: "/out", target: "/o", readonly: false }] });
  assert.ok(setting !== "none");
  assert.deepEqual(setting.mounts, [
    { source: "/data", target: "/data", readonly: true },
    { source: "/out", target: "/o", readonly: false },
  ]);
});

test("config: an adapter's sandbox may only turn the container on, and needs an image from somewhere", () => {
  assert.throws(
    () => loadConfig(configFile({ adapters: { codex: { sandbox: "none" } } }), { quiet: true }),
    /adapter 'codex' 'sandbox' cannot be "none"/,
  );
  assert.throws(
    () => loadConfig(configFile({ adapters: { codex: { sandbox: { kind: "container", network: "none" } } } }), { quiet: true }),
    /adapter 'codex' 'sandbox' needs an "image"/,
  );
  const config = loadConfig(
    configFile({
      sandbox: { kind: "container", image: "base:1" },
      adapters: { codex: { sandbox: { kind: "container", image: "codex-box:1", network: "none" } } },
    }),
    { quiet: true },
  );
  assert.deepEqual(config.adapters.codex!.sandbox, { kind: "container", image: "codex-box:1", network: "none" });
  assert.deepEqual(config.adapters.codex!.command, loadConfig(configFile({}), { quiet: true }).adapters.codex!.command, "the built-in command stays");
});

test("withSandboxFlag: --sandbox container uses the config's container, or --sandbox-image's", () => {
  const base = box();
  assert.equal(withSandboxFlag("none", null), "none");
  assert.equal(withSandboxFlag(base, { kind: "container", image: null }), base);
  assert.deepEqual(withSandboxFlag(base, { kind: "container", image: "other:2" }), { ...base, image: "other:2" });
  assert.deepEqual(withSandboxFlag("none", { kind: "container", image: "other:2" }), { ...CONTAINER_DEFAULTS, image: "other:2", mounts: [] });
  assert.throws(() => withSandboxFlag("none", { kind: "container", image: null }), /--sandbox container needs an image/);
  assert.deepEqual(sandboxFlagOf({ kind: "container", image: "x" }), { kind: "container", image: "x" });
  assert.equal(sandboxFlagOf(null), null);
  assert.equal(sandboxFlagOf({ kind: "vm" }), null);
});

// --- planning -------------------------------------------------------------------------

test("planSandbox: the adapter's fields over the run's — its image, stricter network and limits, more mounts", () => {
  const run = box({ memory: "8g", pids: 256, mounts: [{ source: "/a", target: "/a", readonly: true }] });
  const merged = planSandbox(run, {
    sandbox: { kind: "container", image: "codex:1", network: "none", memory: "16g", pids: 128, mounts: [{ source: "/b", target: "/b", readonly: true }] },
  }).box!;
  assert.equal(merged.image, "codex:1");
  assert.equal(merged.network, "none");
  assert.equal(merged.memory, "8g", "the stricter memory wins");
  assert.equal(merged.pids, 128);
  assert.deepEqual(merged.mounts.map((m) => m.source), ["/a", "/b"]);
  // The adapter turns it on in a run without one.
  assert.equal(planSandbox("none", { sandbox: { kind: "container", image: "codex:1" } }).box!.image, "codex:1");
  assert.equal(planSandbox("none", {}).box, null);
});

test("planSandbox: a call may only tighten — on, offline, lower, without config — never loosen", () => {
  const run = box({ memory: "4g", cpus: 2 });
  const ok = (option: unknown, base: ContainerSandbox | "none" = run) => {
    const plan = planSandbox(base, {}, option);
    assert.equal(plan.error, undefined, JSON.stringify(option));
    return plan.box;
  };
  const refused = (option: unknown, message: RegExp, base: ContainerSandbox | "none" = run) => {
    const plan = planSandbox(base, {}, option);
    assert.match(plan.error ?? "", message, JSON.stringify(option));
  };
  assert.equal(ok(undefined), run);
  assert.equal(ok("container"), run);
  assert.equal(ok("none", "none"), null);
  assert.equal(ok({ network: "none" })!.network, "none");
  assert.deepEqual(
    ok({ memory: "1g", cpus: 1, pids: 32, cliConfig: "none" }),
    { ...run, memory: "1g", cpus: 1, pids: 32, cliConfig: "none" },
  );
  assert.equal(ok({ image: "box:1" }, "none")!.image, "box:1", "turning it on from the host may name the image");
  assert.equal(ok({ image: "odw-agents:1" })!.image, "odw-agents:1", "the same image is no change");
  refused("none", /may only tighten/);
  refused("container", /needs an image/, "none");
  refused({ network: "none" }, /needs an image/, "none");
  refused({ network: "default" }, /network "default"/, box({ network: "none" }));
  refused({ memory: "8g" }, /memory "8g" is more than/);
  refused({ cpus: 4 }, /cpus 4 is more than/);
  refused({ pids: 4096 }, /pids 4096 is more than/);
  refused({ cliConfig: "mount-ro" }, /cliConfig may only be "none"/);
  refused({ image: "other:1" }, /cannot change the image/);
  refused({ mounts: [{ source: "/etc" }] }, /unknown field "mounts"/);
  refused({ engine: "podman" }, /unknown field "engine"/);
  refused({ network: "host" }, /network must be/);
  refused(42, /must be "none", "container" or/);
});

test("sandboxBanner: none, or the container in a few words — and adapters with their own", () => {
  const onPath = (cmd: string) => cmd === "podman";
  const none = loadConfig(configFile({}), { quiet: true });
  assert.equal(sandboxBanner(none), "sandbox: none — agents run on this machine as you");
  const config = loadConfig(
    configFile({
      sandbox: { kind: "container", image: "base:1", memory: "4g" },
      adapters: { codex: { sandbox: { kind: "container", image: "codex:1", network: "none" } } },
    }),
    { quiet: true },
  );
  assert.equal(
    sandboxBanner(config, onPath),
    "sandbox: container (podman, image base:1, network default, cli config copy, memory 4g, pids 512) — agents and exec() steps run in it; " +
      "codex: image codex:1, no network",
  );
});

test("AgentView: an agent's sandbox comes from its agent_started event", () => {
  const sandbox = { kind: "container", engine: "docker", image: "odw-agents:1", network: "none" };
  const agents = foldAgents([
    { type: "agent_started", ts: 1, agentId: 1, label: "a", phase: null, adapter: "claude", sandbox },
    { type: "agent_started", ts: 1, agentId: 2, label: "b", phase: null, adapter: "claude" },
  ]);
  assert.deepEqual(agents[0]!.sandbox, sandbox);
  assert.equal("sandbox" in agents[1]!, false);
});

// --- the private home -------------------------------------------------------------------

function fakeHome(): string {
  const home = tmp("odw-fakehome-");
  mkdirSync(join(home, ".claude", "projects", "-some-repo"), { recursive: true });
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), '{"token":"placeholder"}', { mode: 0o600 });
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  writeFileSync(join(home, ".claude", "agents", "reviewer.md"), "# reviewer");
  writeFileSync(join(home, ".claude", "projects", "-some-repo", "session.jsonl"), "history");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "you@example.com" }, projects: { "/secret/repo": {} } }));
  return home;
}

test("prepareHome copy: the CLI's documented files, not its history; ~/.claude.json without other projects; removed after", async () => {
  const home = fakeHome();
  const made = await prepareHome(["claude", "--print"], "copy", {}, home);
  try {
    assert.deepEqual(made.mounts, []);
    assert.equal(made.note, undefined);
    assert.equal(readFileSync(join(made.dir, ".claude", ".credentials.json"), "utf8"), '{"token":"placeholder"}');
    assert.ok(existsSync(join(made.dir, ".claude", "settings.json")));
    assert.ok(existsSync(join(made.dir, ".claude", "agents", "reviewer.md")));
    assert.equal(existsSync(join(made.dir, ".claude", "projects")), false, "session history stays home");
    const global = JSON.parse(readFileSync(join(made.dir, ".claude.json"), "utf8"));
    assert.deepEqual(global, { oauthAccount: { emailAddress: "you@example.com" } });
    // What the agent writes in its copy never reaches yours.
    writeFileSync(join(made.dir, ".claude", ".credentials.json"), "changed");
    assert.equal(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"), '{"token":"placeholder"}');
  } finally {
    await made.cleanup();
  }
  assert.equal(existsSync(made.dir), false);
});

test("prepareHome: CLAUDE_CONFIG_DIR moves the files; mount-ro binds them read-only; none is empty", async () => {
  const home = fakeHome();
  const moved = tmp("odw-claudedir-");
  writeFileSync(join(moved, ".credentials.json"), "moved");
  writeFileSync(join(moved, ".claude.json"), "{}");
  const copy = await prepareHome(["/usr/local/bin/claude"], "copy", { CLAUDE_CONFIG_DIR: moved }, home);
  assert.equal(readFileSync(join(copy.dir, ".claude", ".credentials.json"), "utf8"), "moved");
  assert.ok(existsSync(join(copy.dir, ".claude.json")));
  await copy.cleanup();

  const ro = await prepareHome(["claude"], "mount-ro", {}, home);
  assert.deepEqual(
    ro.mounts.map((m) => [m.source, m.target, m.readonly]),
    [
      [join(home, ".claude", ".credentials.json"), `${CONTAINER_HOME}/.claude/.credentials.json`, true],
      [join(home, ".claude", "settings.json"), `${CONTAINER_HOME}/.claude/settings.json`, true],
      [join(home, ".claude", "agents"), `${CONTAINER_HOME}/.claude/agents`, true],
      [join(home, ".claude.json"), `${CONTAINER_HOME}/.claude.json`, true],
    ],
  );
  assert.equal(readFileSync(join(ro.dir, ".claude", ".credentials.json"), "utf8"), "", "an empty mount point, not the file");
  await ro.cleanup();

  const none = await prepareHome(["claude"], "none", {}, home);
  assert.equal(existsSync(join(none.dir, ".claude")), false);
  await none.cleanup();
});

test("prepareHome: codex and gemini by their docs; nothing to copy, or a CLI ODW does not know, says how to log in", async () => {
  const home = tmp("odw-fakehome-");
  mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), "{}");
  writeFileSync(join(home, ".codex", "config.toml"), "");
  writeFileSync(join(home, ".codex", "history.jsonl"), "");
  const codex = await prepareHome(["codex", "exec"], "copy", {}, home);
  assert.ok(existsSync(join(codex.dir, ".codex", "auth.json")));
  assert.equal(existsSync(join(codex.dir, ".codex", "sessions")), false);
  assert.equal(existsSync(join(codex.dir, ".codex", "history.jsonl")), false);
  await codex.cleanup();

  const gemini = await prepareHome(["gemini"], "copy", {}, home);
  assert.match(gemini.note ?? "", /no gemini login or config in .*\.gemini to copy — set GEMINI_API_KEY/);
  await gemini.cleanup();

  const claude = await prepareHome(["claude"], "copy", {}, home);
  assert.match(claude.note ?? "", /CLAUDE_CODE_OAUTH_TOKEN .*Keychain/);
  await claude.cleanup();

  const other = await prepareHome(["qwen"], "copy", {}, home);
  assert.match(other.note ?? "", /knows no config files of 'qwen'.*empty home/);
  await other.cleanup();
});

// --- doctor --------------------------------------------------------------------------

function fakeRunner(script: Record<string, number>) {
  const calls: string[][] = [];
  const runner = async (command: string[]): Promise<CliResult> => {
    calls.push(command);
    const sub = command.slice(1, 3).join(" ");
    const code = sub.startsWith("image inspect") ? (script.inspect ?? 0) : sub.startsWith("run") ? (script.run ?? 0) : 0;
    return { returncode: code, stdout: "", stderr: code ? "Error: something" : "", timedOut: false, duration: 0 };
  };
  return { calls, runner };
}

test("doctor: no sandbox is one ok line; a container checks engine, image and a smoke run — no pull, no model", async () => {
  const onPath = (cmd: string) => cmd === "docker";
  const none = await sandboxChecks(loadConfig(configFile({}), { quiet: true }), fakeRunner({}).runner, {}, onPath, "linux");
  assert.equal(none.length, 1);
  assert.equal(none[0]!.status, "ok");
  assert.match(none[0]!.detail, /^none — agents run on this machine/);

  const config = loadConfig(configFile({ sandbox: { kind: "container", image: "odw-agents:1" } }), { quiet: true });
  const good = fakeRunner({});
  const [ok] = await sandboxChecks(config, good.runner, {}, onPath, "linux");
  assert.equal(ok!.status, "ok");
  assert.match(ok!.detail, /engine found, image present/);
  assert.deepEqual(good.calls, [
    ["docker", "image", "inspect", "--format", "{{.Id}}", "odw-agents:1"],
    ["docker", "run", "--rm", "--pull", "never", "--network", "none", "odw-agents:1", "true"],
  ]);

  const [missing] = await sandboxChecks(config, fakeRunner({ inspect: 1 }).runner, {}, onPath, "linux");
  assert.equal(missing!.status, "fail");
  assert.match(missing!.detail, /image 'odw-agents:1' is not present in docker \(ODW never pulls\)/);
  assert.match(missing!.hint ?? "", /docker build -t odw-agents:1 examples\/sandbox/);

  const [smoke] = await sandboxChecks(config, fakeRunner({ run: 125 }).runner, {}, onPath, "linux");
  assert.equal(smoke!.status, "fail");
  assert.match(smoke!.detail, /exited 125/);

  const [noEngine] = await sandboxChecks(config, fakeRunner({}).runner, {}, () => false, "linux");
  assert.equal(noEngine!.status, "fail");
  assert.match(noEngine!.detail, /no container engine on PATH/);

  const [windows] = await sandboxChecks(config, fakeRunner({}).runner, {}, onPath, "win32");
  assert.match(windows!.detail, /Linux or macOS host/);
});
