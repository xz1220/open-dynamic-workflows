import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import { Bridge, type AdapterWarning, type RateLimitRetry } from "../src/bridge.js";
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
  const textConfig = defaultConfig();
  textConfig.settings.defaultAdapter = "codex"; // a text adapter (claude streams stream-json)
  const textBridge = new Bridge(textConfig, {
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

// --- failure classes and rate-limit retries ------------------------------------

function failing(stderr: string, returncode = 1): CliResult {
  return { returncode, stdout: "", stderr, timedOut: false, duration: 0.1 };
}

const RATE_LIMITED = "API Error: 429 Too Many Requests";

/** A bridge whose backoff sleeps on a fake clock, with fixed jitter. */
function backoffBridge(runner: CommandRunner, config = inplaceConfig(), random = 0) {
  const slept: number[] = [];
  const bridge = new Bridge(config, {
    runner,
    sleep: async (ms) => void slept.push(ms),
    random: () => random,
  });
  return { bridge, slept };
}

test("a rate-limited CLI is retried after an exponential backoff, then succeeds", async () => {
  const replies = [failing(RATE_LIMITED), failing(RATE_LIMITED), ok("finally")];
  const prompts: string[] = [];
  const { bridge, slept } = backoffBridge(async (_command, options) => {
    prompts.push(options?.stdin ?? "");
    return replies.shift()!;
  });
  const waits: RateLimitRetry[] = [];
  let guards = 0;
  const started = Date.now();
  const out = await bridge.run(
    { prompt: "busy task" },
    { onRateLimit: (retry) => waits.push(retry), beforeRetry: () => void guards++ },
  );
  assert.equal(out.text, "finally");
  assert.equal(out.attempts, 1, "a retry is not a schema attempt");
  assert.equal(prompts.length, 3, "two retries, then the answer");
  assert.ok(prompts.every((p) => p === prompts[0]), "every retry re-runs the same prompt");
  assert.deepEqual(waits, [
    { adapter: "claude", waitSeconds: 15, retry: 1, maxRetries: 3 },
    { adapter: "claude", waitSeconds: 30, retry: 2, maxRetries: 3 },
  ]);
  assert.deepEqual(slept, [15_000, 30_000], "each wait is announced, then slept");
  assert.equal(guards, 2, "each retry passes the stop/budget guards first");
  assert.ok(Date.now() - started < 1000, "the waits ran on the injected clock");
});

test("backoff jitter stays within 20%, and maxBackoff caps every wait", async () => {
  const cfg = inplaceConfig();
  cfg.settings.maxBackoff = 40;
  const { bridge, slept } = backoffBridge(async () => failing(RATE_LIMITED), cfg, 0.999);
  await assert.rejects(() => bridge.run({ prompt: "x" }), AdapterExecutionError);
  assert.equal(slept.length, 3);
  assert.ok(slept[0]! >= 15_000 && slept[0]! < 18_000, `first wait ${slept[0]}`);
  assert.ok(slept[1]! >= 30_000 && slept[1]! < 36_000, `second wait ${slept[1]}`);
  assert.equal(slept[2], 40_000, "60s doubled past maxBackoff is cut to it");
  assert.ok(slept.reduce((a, b) => a + b, 0) <= 3 * 40_000, "a call never waits longer than retries × maxBackoff");
});

test("a retry-after the CLI printed replaces the exponential wait", async () => {
  const replies = [failing("Rate limit reached for requests. Please try again in 45s."), ok("done")];
  const { bridge, slept } = backoffBridge(async () => replies.shift()!);
  const waits: number[] = [];
  await bridge.run({ prompt: "x" }, { onRateLimit: (r) => waits.push(r.waitSeconds) });
  assert.deepEqual(waits, [45], "the CLI's 45s, not the first exponential step (15s)");
  assert.deepEqual(slept, [45_000]);
});

test("a rate limit that outlasts maxBackoff is not retried, and its error says why", async () => {
  let calls = 0;
  const { bridge, slept } = backoffBridge(async () => {
    calls++;
    return failing("429 Too Many Requests: retry after 600 seconds");
  });
  await assert.rejects(
    () => bridge.run({ prompt: "x" }),
    (err: AdapterExecutionError) =>
      err instanceof AdapterExecutionError &&
      err.reason === "rate_limit" &&
      err.retryAfter === 600 &&
      err.message.startsWith(
        "adapter 'claude' hit a rate limit and asked to wait 10m, longer than maxBackoff (300s) — " +
          "retry later, or raise maxBackoff: 429",
      ),
  );
  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
});

test("rate-limit retries stop at transientRetries; the error counts them", async () => {
  for (const [retries, message] of [
    [3, "adapter 'claude' hit a rate limit and was still limited after 3 retries: API Error: 429"],
    [1, "adapter 'claude' hit a rate limit and was still limited after 1 retry: API Error: 429"],
    [0, "adapter 'claude' hit a rate limit: API Error: 429"],
  ] as const) {
    const cfg = inplaceConfig();
    cfg.settings.transientRetries = retries;
    let calls = 0;
    const { bridge } = backoffBridge(async () => {
      calls++;
      return failing(RATE_LIMITED);
    }, cfg);
    await assert.rejects(
      () => bridge.run({ prompt: "x" }),
      (err: AdapterExecutionError) => err.reason === "rate_limit" && err.message.startsWith(message),
    );
    assert.equal(calls, retries + 1);
  }
});

test("rate-limit retries are capped per call, across schema attempts", async () => {
  const replies = [failing(RATE_LIMITED), ok("not json"), failing(RATE_LIMITED), ok('{"n":1}')];
  const cfg = inplaceConfig();
  cfg.settings.transientRetries = 1;
  const { bridge } = backoffBridge(async () => replies.shift()!, cfg);
  await assert.rejects(
    () => bridge.run({ prompt: "x", schema: { type: "object", properties: { n: { type: "number" } } } }),
    (err: AdapterExecutionError) => err.reason === "rate_limit" && /after 1 retry/.test(err.message),
  );
  assert.equal(replies.length, 1, "the second rate limit (attempt 2) ended the call: no retry was left");
});

test("a stop during a backoff ends the call at once with the run's reason", async () => {
  const reason = new RunStopped("run was stopped");
  const controller = new AbortController();
  let calls = 0;
  // The real (default) sleep: the CLI asked for two minutes.
  const bridge = new Bridge(inplaceConfig(), {
    runner: async () => {
      calls++;
      return failing("429 Too Many Requests. Retry-After: 120");
    },
  });
  const started = Date.now();
  await assert.rejects(
    () =>
      bridge.run(
        { prompt: "x" },
        { signal: controller.signal, onRateLimit: () => setImmediate(() => controller.abort(reason)) },
      ),
    (err) => err === reason,
  );
  assert.ok(Date.now() - started < 2000, `the wait ended with the stop (${Date.now() - started}ms)`);
  assert.equal(calls, 1, "no retry once stopped");

  // An injected sleep gets the run's signal, so it can end early too.
  let seen: AbortSignal | undefined;
  const injected = new AbortController();
  const withSleep = new Bridge(inplaceConfig(), {
    runner: async () => failing(RATE_LIMITED),
    sleep: async (_ms, signal) => {
      seen = signal;
      injected.abort(reason);
    },
  });
  await assert.rejects(() => withSleep.run({ prompt: "x" }, { signal: injected.signal }), (err) => err === reason);
  assert.equal(seen, injected.signal);
});

test("quota and auth failures are never retried; their errors say what to do", async () => {
  const cases = [
    {
      stderr: "You've hit your usage limit. Try again in 3h 22m.",
      reason: "quota",
      retryAfter: 3 * 3600 + 22 * 60,
      message:
        "adapter 'claude' ran out of usage quota — wait for the window to reset (in 3h 22m) and resume the run, " +
        "or switch adapter with --adapter <name>: You've hit your usage limit.",
    },
    {
      stderr: "Invalid API key · Please run /login",
      reason: "auth",
      retryAfter: undefined,
      message:
        "adapter 'claude' could not authenticate — log in to Claude Code and resume the run, " +
        "or switch adapter with --adapter <name>: Invalid API key",
    },
  ];
  for (const { stderr, reason, retryAfter, message } of cases) {
    let calls = 0;
    const { bridge, slept } = backoffBridge(async () => {
      calls++;
      return failing(stderr);
    });
    await assert.rejects(
      () => bridge.run({ prompt: "x" }),
      (err: AdapterExecutionError) =>
        err instanceof AdapterExecutionError &&
        err.reason === reason &&
        err.retryAfter === retryAfter &&
        err.message.startsWith(message),
    );
    assert.equal(calls, 1, `${reason} is not retried`);
    assert.deepEqual(slept, []);
  }
});

test("every failed CLI run is classified: stalled, timeout, not_found, permission, exit", async () => {
  const cases: Array<[CliResult, string, RegExp]> = [
    [stalled(), "stalled", /^adapter 'claude' stalled — no output for 120s/],
    [{ ...failing("still thinking"), returncode: -1, timedOut: true }, "timeout", /^adapter 'claude' timed out: still thinking$/],
    [
      failing("failed to launch 'claude': spawn claude ENOENT", 127),
      "not_found",
      /^adapter 'claude' could not start its CLI — install it or fix the adapter's command/,
    ],
    [failing("ERROR: user cancelled MCP tool call"), "permission", /^adapter 'claude' was refused a permission it needed/],
    [failing("boom"), "exit", /^adapter 'claude' exited with code 1: boom$/],
  ];
  for (const [result, reason, message] of cases) {
    const bridge = new Bridge(stallConfig(0), { runner: async () => result });
    await assert.rejects(
      () => bridge.run({ prompt: "x" }),
      (err: AdapterExecutionError) => err.reason === reason && message.test(err.message),
      reason,
    );
  }
});

test("Claude's text mode: an exit-0 reply that is only an API error is a failure, ridden out or reported", async () => {
  // `claude -p` prints "API Error: Rate limit reached" and exits 0 (anthropics/claude-code#79500).
  const replies = [ok("API Error: Rate limit reached"), ok("API Error: Rate limit reached"), ok("the answer")];
  const seen: string[] = [];
  const { bridge, slept } = backoffBridge(async () => replies.shift()!);
  const out = await bridge.run({ prompt: "x" }, { onReply: (text) => seen.push(text) });
  assert.equal(out.value, "the answer", "never the error line as the agent's answer");
  assert.deepEqual(slept, [15_000, 30_000]);
  assert.deepEqual(seen, ["the answer"], "an error line is not output the run paid for");

  const { bridge: loggedOut } = backoffBridge(async () => ok("Not logged in · Please run /login"));
  await assert.rejects(
    () => loggedOut.run({ prompt: "x" }),
    (err: AdapterExecutionError) =>
      err.reason === "auth" &&
      err.message ===
        "adapter 'claude' could not authenticate — log in to Claude Code and resume the run, " +
          "or switch adapter with --adapter <name>: Not logged in · Please run /login",
  );

  // A JSONL adapter reports errors as events with a non-zero exit: its reply is just its reply.
  const config = defaultConfig();
  config.settings.defaultAdapter = "opencode";
  const jsonl = new Bridge(config, {
    runner: async () => ok(JSON.stringify({ type: "text", part: { type: "text", text: "API Error: Rate limit reached" } })),
  });
  assert.equal((await jsonl.run({ prompt: "x" })).text, "API Error: Rate limit reached");
});

/** What `claude --print --output-format stream-json --verbose` prints: an init event, then the result event. */
function streamJson(result: Record<string, unknown>, returncode = 0, stderr = ""): CliResult {
  const events = [
    { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5", permissionMode: "acceptEdits" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      session_id: "s1",
      total_cost_usd: 0,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      ...result,
    },
  ];
  return { returncode, stdout: events.map((e) => JSON.stringify(e)).join("\n") + "\n", stderr, timedOut: false, duration: 0.1 };
}

const NOTHING_SPENT = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

test("Claude stream-json: an is_error rate limit is ridden out like any, and every run's usage is reported", async () => {
  const limited = streamJson({ is_error: true, result: "API Error: Rate limit reached" });
  const answer = streamJson({
    result: "the answer",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 40 },
  });
  const replies = [limited, limited, answer];
  const { bridge, slept } = backoffBridge(async () => replies.shift()!);
  const replied: Array<[string, unknown]> = [];
  const spent: unknown[] = [];
  const waits: number[] = [];
  const out = await bridge.run(
    { prompt: "x" },
    {
      onReply: (text, usage) => replied.push([text, usage]),
      onUsage: (usage) => spent.push(usage),
      onRateLimit: (retry) => waits.push(retry.waitSeconds),
    },
  );
  assert.equal(out.text, "the answer");
  assert.deepEqual(waits, [15, 30], "the exit-0 error result is retried with backoff");
  assert.deepEqual(slept, [15_000, 30_000]);
  assert.deepEqual(replied, [["the answer", { inputTokens: 100, outputTokens: 40, cacheReadTokens: 90, costUsd: 0.0123 }]]);
  assert.deepEqual(spent, [NOTHING_SPENT, NOTHING_SPENT], "the limited runs reported what they spent: nothing");
});

test("Claude stream-json: an is_error usage limit is a spent quota — not retried, and its error says when it resets", async () => {
  const T = Date.UTC(2026, 9, 17, 12, 0, 0);
  const resets = Math.floor(T / 1000) + 3 * 3600;
  let calls = 0;
  const bridge = new Bridge(inplaceConfig(), {
    runner: async () => {
      calls++;
      return streamJson({ is_error: true, result: `Claude AI usage limit reached|${resets}` });
    },
    sleep: async () => assert.fail("a spent quota is not waited out"),
    now: () => T,
  });
  await assert.rejects(
    () => bridge.run({ prompt: "x" }),
    (err: AdapterExecutionError) =>
      err.reason === "quota" &&
      err.retryAfter === 3 * 3600 &&
      err.message ===
        "adapter 'claude' ran out of usage quota — wait for the window to reset (in 3h) and resume the run, " +
          `or switch adapter with --adapter <name>: Claude AI usage limit reached|${resets}`,
  );
  assert.equal(calls, 1, "a quota is never retried");
});

test("Claude stream-json: the result's own words decide a failed run, not the transcript or stderr", async () => {
  // A login failure with exit 1: the message is the result text, not a JSON tail.
  const loggedOut = new Bridge(inplaceConfig(), {
    runner: async () => streamJson({ is_error: true, result: "Invalid API key · Please run /login" }, 1, "some stderr chatter"),
  });
  await assert.rejects(
    () => loggedOut.run({ prompt: "x" }),
    (err: AdapterExecutionError) =>
      err.reason === "auth" &&
      err.message ===
        "adapter 'claude' could not authenticate — log in to Claude Code and resume the run, " +
          "or switch adapter with --adapter <name>: Invalid API key · Please run /login",
  );
  // An error result no failure class knows (max turns, no text): "reported an error", quoting it.
  const maxTurns = new Bridge(inplaceConfig(), {
    runner: async () => streamJson({ subtype: "error_max_turns", is_error: true }),
  });
  await assert.rejects(
    () => maxTurns.run({ prompt: "x" }),
    (err: AdapterExecutionError) =>
      err.reason === "exit" &&
      err.message.startsWith('adapter \'claude\' reported an error: {"type":"result","subtype":"error_max_turns","is_error":true'),
  );
  // A successful result is the reply even when the transcript quotes an API error.
  const fine = new Bridge(inplaceConfig(), {
    runner: async () => streamJson({ result: "API Error: Rate limit reached — that is what the README documents." }),
  });
  assert.equal((await fine.run({ prompt: "x" })).text, "API Error: Rate limit reached — that is what the README documents.");
});

test("stdout that does not match a structured adapter's format is still the reply, with a note for the run's log", async () => {
  const notes: string[] = [];
  const bridge = new Bridge(inplaceConfig(), { runner: async () => ok("plain text from an old claude") });
  const out = await bridge.run({ prompt: "x" }, { onNote: (note) => notes.push(note) });
  assert.equal(out.text, "plain text from an old claude");
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^adapter 'claude': stdout did not match its 'jsonl' output format \(stdout is not JSONL: line 1: /);
});

test("a CLI that echoes its prompt is judged by its own words, not the task's", async () => {
  let calls = 0;
  const { bridge, slept } = backoffBridge(async (_command, options) => {
    calls++;
    return failing(`User instructions:\n${options?.stdin}\n\nERROR: stream disconnected before completion`);
  });
  await assert.rejects(
    () => bridge.run({ prompt: "Handle 429 Too Many Requests from the billing API: retry with backoff." }),
    (err: AdapterExecutionError) => err.reason === "exit" && /exited with code 1/.test(err.message),
  );
  assert.equal(calls, 1, "the task's words are not a rate limit");
  assert.deepEqual(slept, []);
});

test("an adapter's own failure wording is matched first, and can make a failure retryable", async () => {
  const cfg = inplaceConfig();
  cfg.adapters.claude!.failures = { rate_limit: ["upstream is busy"] };
  const replies = [failing("upstream is busy, come back soon"), ok("served")];
  const { bridge, slept } = backoffBridge(async () => replies.shift()!, cfg);
  assert.equal((await bridge.run({ prompt: "x" })).text, "served");
  assert.deepEqual(slept, [15_000]);
});

test("three quota or auth failures in a row on one adapter warn once; anything else resets the count", async () => {
  let reply: CliResult = failing(`Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3 * 3600}`);
  const bridge = new Bridge(inplaceConfig(), { runner: async () => reply });
  const warnings: AdapterWarning[] = [];
  const onAdapterWarning = (w: AdapterWarning) => warnings.push(w);
  const fail = () => assert.rejects(() => bridge.run({ prompt: "x" }, { onAdapterWarning }), AdapterExecutionError);
  for (let i = 0; i < 5; i++) await fail();
  assert.equal(warnings.length, 1, "one warning per streak, not one per failure");
  assert.deepEqual(
    { adapter: warnings[0]!.adapter, reason: warnings[0]!.reason, streak: warnings[0]!.streak },
    { adapter: "claude", reason: "quota", streak: 3 },
  );
  assert.equal(
    warnings[0]!.message,
    "warning: 3 agents in a row failed on adapter 'claude' (usage quota) — its other agents in this run will likely " +
      "fail too. Wait for its quota window to reset and resume the run (odw resume), or switch adapter with --adapter <name>.",
  );

  // Another adapter's failures are its own; a success on this one ends its streak.
  await assert.rejects(() => bridge.run({ prompt: "x", adapter: "codex" }, { onAdapterWarning }));
  reply = ok("back");
  await bridge.run({ prompt: "x" }, { onAdapterWarning });
  reply = failing("Error: not logged in. Run `claude` to log in.");
  await fail();
  await fail();
  reply = failing("boom"); // an ordinary failure breaks a run of quota/auth failures
  await fail();
  reply = failing("Error: not logged in. Run `claude` to log in.");
  for (let i = 0; i < 3; i++) await fail();
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1]!.reason, "auth");
  assert.match(warnings[1]!.message, /\(not logged in\) — .*Log in to Claude Code and resume the run/);
});

test("a stopped call is no verdict on its adapter", async () => {
  const bridge = new Bridge(inplaceConfig(), { runner: async () => failing("Invalid API key · Please run /login") });
  const warnings: AdapterWarning[] = [];
  const onAdapterWarning = (w: AdapterWarning) => warnings.push(w);
  for (let i = 0; i < 2; i++) await assert.rejects(() => bridge.run({ prompt: "x" }, { onAdapterWarning }));
  const controller = new AbortController();
  controller.abort(new RunStopped("run was stopped"));
  await assert.rejects(() => bridge.run({ prompt: "x" }, { signal: controller.signal, onAdapterWarning }), RunStopped);
  assert.deepEqual(warnings, [], "two failures and a stop are not three in a row");
  await assert.rejects(() => bridge.run({ prompt: "x" }, { onAdapterWarning }));
  assert.equal(warnings.length, 1);
});
