import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentBaseEnv } from "../src/adapters/agent-env.js";
import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { RunCommandOptions } from "../src/adapters/runner.js";
import { Bridge } from "../src/bridge.js";
import { ConfigError } from "../src/errors.js";

// agentEnv (ODW extension): "inherit" hands agent CLIs ODW's whole
// environment, as before; "minimal" only what they need to start, the
// built-in CLIs' documented auth and config variables, agentEnvPass, the
// adapter's env and ODW's own variables. Values here are placeholders.

const SHELL_ENV: Record<string, string> = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  USER: "u",
  LOGNAME: "u",
  SHELL: "/bin/zsh",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm",
  TMPDIR: "/tmp",
  TZ: "UTC",
  ANTHROPIC_API_KEY: "placeholder",
  CLAUDE_CONFIG_DIR: "/home/u/.claude",
  OPENAI_BASE_URL: "https://llm.example.com/v1",
  CODEX_HOME: "/home/u/.codex",
  GEMINI_API_KEY: "placeholder",
  GOOGLE_CLOUD_PROJECT: "demo",
  DASHSCOPE_API_KEY: "placeholder",
  QWEN_CODE_SUPPRESS_YOLO_WARNING: "1",
  MOONSHOT_API_KEY: "placeholder",
  KIMI_BASE_URL: "https://kimi.example.com",
  CURSOR_API_KEY: "placeholder",
  OPENCODE_CONFIG: "/home/u/opencode.json",
  HTTPS_PROXY: "http://proxy.example.com:3128",
  no_proxy: "localhost",
  NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  ODW_CONFIG: "/home/u/odw.json",
  AWS_SECRET_ACCESS_KEY: "placeholder",
  AWS_REGION: "us-east-1",
  GITHUB_TOKEN: "placeholder",
  DATABASE_URL: "postgres://localhost/app",
  NPM_TOKEN: "placeholder",
  MY_SERVICE_KEY: "placeholder",
};

const KEPT = Object.keys(SHELL_ENV).filter(
  (name) => !["AWS_SECRET_ACCESS_KEY", "AWS_REGION", "GITHUB_TOKEN", "DATABASE_URL", "NPM_TOKEN", "MY_SERVICE_KEY"].includes(name),
);

test("agentEnv and agentEnvPass load and validate; agentEnvPass alone is flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-agent-env-"));
  const load = (raw: Record<string, unknown>) => {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true }).settings;
  };
  try {
    assert.deepEqual([defaultConfig().settings.agentEnv, defaultConfig().settings.agentEnvPass], ["inherit", []]);
    const settings = load({ agentEnv: "minimal", agentEnvPass: ["AWS_*", "GH_TOKEN"] });
    assert.deepEqual([settings.agentEnv, settings.agentEnvPass], ["minimal", ["AWS_*", "GH_TOKEN"]]);
    for (const [raw, message] of [
      [{ agentEnv: "none" }, /"agentEnv" must be "inherit" or "minimal"; got "none"/],
      [{ agentEnvPass: "AWS_*" }, /"agentEnvPass" must be a list of variable names or globs/],
      [{ agentEnvPass: ["A=B"] }, /"agentEnvPass"/],
      [{ agentEnvPass: [""] }, /"agentEnvPass"/],
    ] as const) {
      assert.throws(() => load(raw), (err) => err instanceof ConfigError && message.test(err.message));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(collectConfigWarnings({ agentEnv: "minimal", agentEnvPass: ["X"] }), []);
  assert.deepEqual(collectConfigWarnings({ agentEnvPass: ["AWS_*"] }), [
    `"agentEnvPass" has no effect unless "agentEnv" is "minimal" (agents get the whole environment)`,
  ]);
});

test("inherit (the default) passes the whole environment", () => {
  assert.deepEqual(agentBaseEnv(SHELL_ENV, {}), SHELL_ENV);
  assert.deepEqual(agentBaseEnv(SHELL_ENV, { agentEnv: "inherit", agentEnvPass: ["X"] }), SHELL_ENV);
  assert.equal(defaultConfig().settings.agentEnv, "inherit");
});

test("minimal passes the basics, the CLIs' documented variables and ODW_* — and nothing else", () => {
  const env = agentBaseEnv(SHELL_ENV, { agentEnv: "minimal", agentEnvPass: [] }, "linux");
  assert.deepEqual(Object.keys(env).sort(), [...KEPT].sort());
  for (const name of KEPT) assert.equal(env[name], SHELL_ENV[name], name);
});

test("agentEnvPass adds names and * globs; matching is exact on POSIX", () => {
  const env = agentBaseEnv(SHELL_ENV, { agentEnv: "minimal", agentEnvPass: ["AWS_*", "GITHUB_TOKEN", "MY_*_KEY"] }, "linux");
  for (const name of ["AWS_SECRET_ACCESS_KEY", "AWS_REGION", "GITHUB_TOKEN", "MY_SERVICE_KEY"]) assert.equal(env[name], SHELL_ENV[name], name);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  // A dot or a bracket in a pattern is literal, not a regular expression.
  assert.deepEqual(Object.keys(agentBaseEnv({ "A.B": "1", AXB: "1" }, { agentEnv: "minimal", agentEnvPass: ["A.B"] }, "linux")), ["A.B"]);
  // POSIX names are case-sensitive: `path` is not PATH.
  assert.deepEqual(agentBaseEnv({ path: "/x", aws_region: "y" }, { agentEnv: "minimal", agentEnvPass: ["AWS_*"] }, "linux"), {});
});

test("on Windows, names match without regard to case, and the system variables pass", () => {
  const windows = { Path: "C:\\bin", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", PATHEXT: ".EXE", USERPROFILE: "C:\\u", APPDATA: "C:\\u\\a", aws_region: "x", Secret: "y" };
  const env = agentBaseEnv(windows, { agentEnv: "minimal", agentEnvPass: ["AWS_*"] }, "win32");
  assert.deepEqual(Object.keys(env).sort(), ["APPDATA", "ComSpec", "PATHEXT", "Path", "SystemRoot", "USERPROFILE", "aws_region"]);
});

test("the bridge starts each agent CLI with the minimal environment, plus its adapter env and ODW variables", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "placeholder",
      APP_SECRET_TOKEN: "placeholder",
      EXTRA_ONE: "1",
      ODW_PORT: "1", // a parent agent's: never inherited
    });
    const seen: Array<RunCommandOptions["env"]> = [];
    const config = defaultConfig();
    config.adapters.mock = { name: "mock", command: ["mock"], stdin: "{prompt}", env: { MY_FLAG: "on" } };
    config.settings.defaultAdapter = "mock";
    config.settings.portRange = [47100, 47199];
    const bridge = new Bridge(config, {
      source: "/repo",
      runId: "run-1",
      runner: async (_command, options) => {
        seen.push(options?.env);
        return { returncode: 0, stdout: "ok", stderr: "", timedOut: false, duration: 0 };
      },
    });

    await bridge.run({ prompt: "x" }, { agentId: 7 });
    assert.equal(seen[0]!.APP_SECRET_TOKEN, "placeholder", "inherit: everything");

    config.settings.agentEnv = "minimal";
    config.settings.agentEnvPass = ["EXTRA_*"];
    await bridge.run({ prompt: "x" }, { agentId: 8 });
    const env = seen[1]!;
    assert.equal(env.APP_SECRET_TOKEN, undefined, "not in any allowlist");
    assert.equal(env.ANTHROPIC_API_KEY, "placeholder");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.EXTRA_ONE, "1", "agentEnvPass");
    assert.equal(env.MY_FLAG, "on", "the adapter's own env");
    assert.equal(env.ODW_RUN_ID, "run-1");
    assert.equal(env.ODW_AGENT_ID, "8");
    assert.ok(Number(env.ODW_PORT) >= 47100 && Number(env.ODW_PORT) <= 47199, "this agent's port, not the parent's");
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
