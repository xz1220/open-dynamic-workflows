import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import { Bridge } from "../src/bridge.js";
import type { CliResult } from "../src/adapters/types.js";
import { AdapterExecutionError, RunStopped } from "../src/errors.js";

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

function inplaceConfig() {
  const cfg = defaultConfig();
  cfg.settings.defaultAdapter = "claude";
  return cfg;
}

test("a no-schema agent call returns trimmed reply text", async () => {
  const bridge = new Bridge(inplaceConfig(), { runner: async () => ok("  the answer  ") });
  const out = await bridge.run({ prompt: "hi" });
  assert.equal(out.value, "the answer");
  assert.equal(out.text, "the answer");
  assert.equal(out.adapter, "claude");
  assert.equal(out.attempts, 1);
});

test("the prompt is wrapped with the independence preamble", async () => {
  let stdin = "";
  const bridge = new Bridge(inplaceConfig(), {
    runner: async (_command, options) => {
      stdin = options?.stdin ?? "";
      return ok("ok");
    },
  });
  await bridge.run({ prompt: "do the thing" });
  assert.match(stdin, /automated multi-agent workflow/);
  assert.match(stdin, /do the thing/);
});

test("a failing CLI surfaces as AdapterExecutionError", async () => {
  const bridge = new Bridge(inplaceConfig(), {
    runner: async () => ({ returncode: 1, stdout: "", stderr: "boom", timedOut: false, duration: 0 }),
  });
  await assert.rejects(() => bridge.run({ prompt: "x" }), AdapterExecutionError);
});

test("the chosen adapter can be overridden per call", async () => {
  const bridge = new Bridge(inplaceConfig(), { runner: async () => ok("hi") });
  const out = await bridge.run({ prompt: "x", adapter: "codex" });
  assert.equal(out.adapter, "codex");
});

test("T2: a declared model flag reaches the command with its value", async () => {
  let cmd: string[] = [];
  const bridge = new Bridge(inplaceConfig(), {
    runner: async (command) => {
      cmd = command;
      return ok("hi");
    },
  });
  await bridge.run({ prompt: "x", model: "claude-sonnet-4-6" });
  const i = cmd.indexOf("--model");
  assert.ok(i >= 0, `expected --model in ${JSON.stringify(cmd)}`);
  assert.equal(cmd[i + 1], "claude-sonnet-4-6");
});

test("T2: with no model the command carries no --model (no dangling flag)", async () => {
  let cmd: string[] = [];
  const bridge = new Bridge(inplaceConfig(), {
    runner: async (command) => {
      cmd = command;
      return ok("hi");
    },
  });
  await bridge.run({ prompt: "x" });
  assert.equal(cmd.includes("--model"), false);
});

test("T3: agentType injects a persona into the prompt (universal, every CLI)", async () => {
  let stdin = "";
  const bridge = new Bridge(inplaceConfig(), {
    runner: async (_command, options) => {
      stdin = options?.stdin ?? "";
      return ok("ok");
    },
  });
  await bridge.run({ prompt: "do it", agentType: "code-reviewer" });
  assert.match(stdin, /code-reviewer/);
  assert.match(stdin, /role/i);
  assert.match(stdin, /do it/);
});

test("T5: an option with no native carrier surfaces as an outcome note, never dropped", async () => {
  const bridge = new Bridge(inplaceConfig(), { runner: async () => ok("hi") });
  const out = await bridge.run({ prompt: "x", agentType: "qa-reviewer" });
  assert.ok(
    out.notes.some((n) => /qa-reviewer/.test(n) && /prompt injection/.test(n)),
    `expected a routing note, got ${JSON.stringify(out.notes)}`,
  );
});

test("new harness adapters send prompts on stdin and route workspace and model flags", async () => {
  for (const name of ["omp", "kilo", "opencode", "cursor"]) {
    const config = defaultConfig();
    config.settings.defaultAdapter = name;
    let command: string[] = [];
    let stdin = "";
    const raw =
      name === "kilo" || name === "opencode"
        ? JSON.stringify({ type: "text", part: { type: "text", text: `${name} answer` } })
        : `${name} answer`;
    const bridge = new Bridge(config, {
      source: "/repo",
      runner: async (actual, options) => {
        command = actual;
        stdin = options?.stdin ?? "";
        return ok(raw);
      },
    });

    const out = await bridge.run({ prompt: `ask ${name}`, model: `${name}/model` });
    assert.equal(out.text, `${name} answer`);
    assert.match(stdin, new RegExp(`ask ${name}`));
    assert.equal(command.includes("{prompt}"), false);
    assert.ok(command.includes("/repo"), `expected workspace in ${JSON.stringify(command)}`);
    const modelFlag = command.indexOf("--model");
    assert.ok(modelFlag >= 0, `expected model flag in ${JSON.stringify(command)}`);
    assert.equal(command[modelFlag + 1], `${name}/model`);
  }
});

test("JSONL replies are decoded while the runner streams them; text replies are not streamed", async () => {
  const lines = [
    JSON.stringify({ type: "step_start", part: {} }),
    JSON.stringify({ type: "text", part: { type: "text", text: "draft" } }),
    JSON.stringify({ type: "text", part: { type: "text", text: "streamed answer" } }),
  ].join("\n");
  const config = defaultConfig();
  config.settings.defaultAdapter = "opencode";
  let streamedTo: unknown;
  const bridge = new Bridge(config, {
    runner: async (_command, options) => {
      streamedTo = options?.onStdout;
      // Like runCommand with a consumer: feed it in pieces, keep only a tail.
      for (let at = 0; at < lines.length; at += 5) options!.onStdout!(lines.slice(at, at + 5), () => {});
      return ok("");
    },
  });
  const out = await bridge.run({ prompt: "p" });
  assert.equal(typeof streamedTo, "function");
  assert.equal(out.text, "streamed answer");

  let textStreamed: unknown = "unset";
  const textBridge = new Bridge(inplaceConfig(), {
    runner: async (_command, options) => {
      textStreamed = options?.onStdout;
      return ok("plain answer");
    },
  });
  assert.equal((await textBridge.run({ prompt: "p" })).text, "plain answer");
  assert.equal(textStreamed, undefined, "text adapters keep the runner's capped buffer");
});

test(
  "a worktree-isolated agent never computes the (discarded) workspace diff",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw-gitspy-"));
    const oldPath = process.env.PATH;
    try {
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const repo = join(dir, "repo");
      mkdirSync(repo);
      writeFileSync(join(repo, "a.txt"), "a\n");
      const git = (...args: string[]) => execFileSync(realGit, ["-C", repo, ...args], { encoding: "utf8" });
      git("init", "-q");
      git("add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
      // A logging git first on PATH records every call the workspace makes.
      const log = join(dir, "git.log");
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "bin", "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
      chmodSync(join(dir, "bin", "git"), 0o755);
      process.env.PATH = `${join(dir, "bin")}:${oldPath}`;

      const bridge = new Bridge(inplaceConfig(), {
        source: repo,
        runner: async (_command, options) => {
          writeFileSync(join(options!.cwd!, "agent-output.txt"), "edited\n");
          return ok("done");
        },
      });
      const out = await bridge.run({ prompt: "edit", isolation: "worktree" });
      assert.equal(out.text, "done");
      assert.equal("diff" in out, false, "the outcome carries no diff field");
      const calls = readFileSync(log, "utf8");
      assert.match(calls, /worktree add/, "the agent did run in a worktree");
      assert.doesNotMatch(calls, /(^|\s)diff\s|intent-to-add/m, `unexpected diff work:\n${calls}`);
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("the zero-config adapter auto-pick scans PATH once per run and then sticks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-autopick-"));
  const oldPath = process.env.PATH;
  try {
    for (const name of ["claude", "codex"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, name), "#!/bin/sh\n");
      chmodSync(join(dir, name, name), 0o755);
    }
    const config = defaultConfig(); // nine built-ins, no defaultAdapter
    const used: string[] = [];
    const bridge = new Bridge(config, {
      runner: async (command) => {
        used.push(command[0]!);
        return ok("hi");
      },
    });
    process.env.PATH = join(dir, "claude");
    assert.equal(bridge.adapterFor().name, "claude");
    // PATH changes mid-run: this run keeps the CLI it picked.
    process.env.PATH = join(dir, "codex");
    assert.equal((await bridge.run({ prompt: "x" })).adapter, "claude");
    assert.deepEqual(used, ["claude"]);
    // An explicit name is still honoured, and a new run picks afresh.
    assert.equal(bridge.adapterFor("codex").name, "codex");
    assert.equal(new Bridge(config).adapterFor().name, "codex");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted call ends with the run's reason, not a CLI failure", async () => {
  const controller = new AbortController();
  const reason = new RunStopped("run was stopped");
  let received: AbortSignal | undefined;
  const bridge = new Bridge(inplaceConfig(), {
    runner: async (_command, options) => {
      received = options?.signal;
      controller.abort(reason); // the stop lands while the CLI runs
      return { returncode: -1, stdout: "", stderr: "[aborted; process terminated]", timedOut: false, duration: 0 };
    },
  });
  await assert.rejects(() => bridge.run({ prompt: "x" }, { signal: controller.signal }), (err) => err === reason);
  assert.equal(received, controller.signal, "the runner gets the run's signal");

  let calls = 0;
  const idle = new Bridge(inplaceConfig(), {
    runner: async () => {
      calls++;
      return ok("never");
    },
  });
  await assert.rejects(() => idle.run({ prompt: "x" }, { signal: controller.signal }), (err) => err === reason);
  assert.equal(calls, 0, "an already-aborted run starts no CLI");
});

test("a failure message keeps both ends of a long diagnostic", async () => {
  const stderr = `Error: the real cause\n${"noise ".repeat(500)}\n[process output exceeded 10 bytes; terminated]`;
  const bridge = new Bridge(inplaceConfig(), {
    runner: async () => ({ returncode: 1, stdout: "", stderr, timedOut: false, duration: 0 }),
  });
  await assert.rejects(
    () => bridge.run({ prompt: "x" }),
    (err: Error) =>
      err instanceof AdapterExecutionError &&
      /Error: the real cause/.test(err.message) &&
      /process output exceeded 10 bytes; terminated\]$/.test(err.message),
  );
});

test("Gemini runs headlessly with an expanded --prompt argument", async () => {
  const config = defaultConfig();
  config.settings.defaultAdapter = "gemini";
  let command: string[] = [];
  let stdin: string | undefined;
  const bridge = new Bridge(config, {
    runner: async (actual, options) => {
      command = actual;
      stdin = options?.stdin;
      return ok("gemini answer");
    },
  });

  const out = await bridge.run({ prompt: "ask gemini", model: "gemini-3" });
  assert.equal(out.text, "gemini answer");
  const promptFlag = command.indexOf("--prompt");
  assert.ok(promptFlag >= 0, `expected --prompt in ${JSON.stringify(command)}`);
  assert.match(command[promptFlag + 1]!, /automated multi-agent workflow/);
  assert.match(command[promptFlag + 1]!, /ask gemini/);
  assert.equal(stdin, undefined);
  const modelFlag = command.indexOf("--model");
  assert.ok(modelFlag >= 0, `expected --model in ${JSON.stringify(command)}`);
  assert.equal(command[modelFlag + 1], "gemini-3");
});

// --- the stall watchdog: restarts --------------------------------------------

function stalled(): CliResult {
  return { returncode: -1, stdout: "", stderr: "", timedOut: false, stalled: true, duration: 120 };
}

function stallConfig(stallRestarts: number) {
  const cfg = inplaceConfig();
  cfg.settings.stallTimeout = 120;
  cfg.settings.stallRestarts = stallRestarts;
  return cfg;
}

test("a stalled CLI is restarted with the same prompt, announced before each restart", async () => {
  const prompts: string[] = [];
  const bridge = new Bridge(stallConfig(2), {
    runner: async (_command, options) => {
      prompts.push(options?.stdin ?? "");
      return prompts.length <= 2 ? stalled() : ok("finally");
    },
  });
  const stalls: unknown[] = [];
  let guards = 0;
  const out = await bridge.run(
    { prompt: "slow task" },
    { onStall: (stall) => stalls.push(stall), beforeRetry: () => void guards++ },
  );
  assert.equal(out.text, "finally");
  assert.equal(out.attempts, 1, "a restart is not a schema attempt");
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((p) => p === prompts[0]), "every restart re-runs the same prompt");
  assert.deepEqual(stalls, [
    { quietSeconds: 120, restart: 1, maxRestarts: 2 },
    { quietSeconds: 120, restart: 2, maxRestarts: 2 },
  ]);
  assert.equal(guards, 2, "each restart passes the stop/budget guards first");
});

test("a CLI that keeps stalling fails the call once stallRestarts is spent", async () => {
  for (const cap of [1, 0]) {
    let calls = 0;
    const stalls: number[] = [];
    const bridge = new Bridge(stallConfig(cap), {
      runner: async () => {
        calls++;
        return { ...stalled(), stderr: "waiting for the model…" };
      },
    });
    await assert.rejects(
      () => bridge.run({ prompt: "x" }, { onStall: (s) => stalls.push(s.restart) }),
      (err: Error) =>
        err instanceof AdapterExecutionError &&
        err.message.startsWith("adapter 'claude' stalled — no output for 120s") &&
        (cap === 0 ? !/again/.test(err.message) : /, and again after 1 restart:/.test(err.message)) &&
        /waiting for the model…$/.test(err.message),
    );
    assert.equal(calls, cap + 1);
    assert.deepEqual(stalls, cap ? [1] : []);
  }
});

test("stall restarts are capped per call, across schema retries", async () => {
  const replies = [stalled(), ok("not json"), stalled(), ok('{"n":1}')];
  const bridge = new Bridge(stallConfig(1), { runner: async () => replies.shift()! });
  await assert.rejects(
    () => bridge.run({ prompt: "x", schema: { type: "object", properties: { n: { type: "number" } } } }),
    (err: Error) => err instanceof AdapterExecutionError && /stalled/.test(err.message),
  );
  assert.equal(replies.length, 1, "the second stall (attempt 2) ended the call: no restart was left");
});

test("a stop wins over a stall: no restart, the run's reason propagates", async () => {
  const reason = new RunStopped("run was stopped");
  // The stop lands while the stalled CLI is being killed.
  const controller = new AbortController();
  let calls = 0;
  const bridge = new Bridge(stallConfig(3), {
    runner: async () => {
      calls++;
      controller.abort(reason);
      return stalled();
    },
  });
  await assert.rejects(() => bridge.run({ prompt: "x" }, { signal: controller.signal }), (err) => err === reason);
  assert.equal(calls, 1);

  // The stop arrives at the restart's guard (e.g. the run was stopped while paused).
  calls = 0;
  const guarded = new Bridge(stallConfig(3), {
    runner: async () => {
      calls++;
      return stalled();
    },
  });
  await assert.rejects(
    () => guarded.run({ prompt: "x" }, { beforeRetry: () => Promise.reject(reason) }),
    (err) => err === reason,
  );
  assert.equal(calls, 1, "no CLI starts once the guard refuses the restart");
});

test("the stall timeout is off by default, run-wide when set, and per adapter (0 opts out)", async () => {
  const seen: Array<number | undefined> = [];
  const runner = async (_command: string[], options?: { stallTimeout?: number }) => {
    seen.push(options?.stallTimeout);
    return ok("hi");
  };
  const cfg = inplaceConfig();
  assert.equal(cfg.settings.stallTimeout, null, "off by default");
  for (const adapter of Object.values(cfg.adapters)) assert.equal(adapter.stallTimeout, undefined, adapter.name);
  await new Bridge(cfg, { runner }).run({ prompt: "x" });

  cfg.settings.stallTimeout = 60;
  await new Bridge(cfg, { runner }).run({ prompt: "x" });
  cfg.adapters.claude!.stallTimeout = 5;
  await new Bridge(cfg, { runner }).run({ prompt: "x" });
  cfg.adapters.claude!.stallTimeout = 0;
  await new Bridge(cfg, { runner }).run({ prompt: "x" });
  assert.deepEqual(seen, [undefined, 60, 5, undefined]);
});
