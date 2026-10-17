import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultConfig,
  executableCandidates,
  loadConfig,
  resolveAdapter,
  resolveClaudeWorkflowsRoot,
  resolveConcurrency,
  resolveRunsRoot,
} from "../src/adapters/config.js";
import { AdapterNotFound, ConfigError } from "../src/errors.js";
import { Scheduler } from "../src/scheduler.js";

test("defaultConfig ships all nine built-in adapters", () => {
  const cfg = defaultConfig();
  for (const name of ["codex", "claude", "gemini", "qwen", "kimi", "omp", "kilo", "opencode", "cursor"]) {
    assert.ok(cfg.adapters[name], `expected built-in adapter '${name}'`);
  }
});

test("new built-ins declare their automation, model, workspace, and output contracts", () => {
  const { adapters } = defaultConfig();
  assert.deepEqual(adapters.omp!.flags?.model, ["--model"]);
  assert.deepEqual(adapters.omp!.command, [
    "omp",
    "--print",
    "--no-session",
    "--approval-mode",
    "yolo",
    "--cwd",
    "{workspace}",
  ]);
  assert.equal(adapters.omp!.stdin, "{prompt}");
  assert.deepEqual(adapters.gemini!.command, [
    "gemini",
    "--approval-mode",
    "auto_edit",
    "--prompt",
    "{prompt}",
  ]);

  for (const name of ["kilo", "opencode"]) {
    const adapter = adapters[name]!;
    assert.deepEqual(adapter.output, {
      format: "jsonl",
      eventType: "text",
      textPath: ["part", "text"],
      select: "last",
    });
    assert.ok(adapter.command.includes("--auto"));
    assert.ok(adapter.command.includes("--dir"));
    assert.ok(adapter.command.includes("{workspace}"));
    assert.equal(adapter.stdin, "{prompt}");
  }

  assert.ok(adapters.cursor!.command.includes("--force"));
  assert.ok(adapters.cursor!.command.includes("--trust"));
  assert.ok(adapters.cursor!.command.includes("{workspace}"));
  assert.equal(adapters.cursor!.stdin, "{prompt}");
});

test("config example preserves every built-in adapter contract", () => {
  const config = loadConfig(join(process.cwd(), "odw.config.example.json"));
  for (const [name, adapter] of Object.entries(defaultConfig().adapters)) {
    assert.deepEqual(config.adapters[name], adapter, `example adapter '${name}' must match its built-in`);
  }
});

test("loadConfig merges a user file over the built-ins (user wins)", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(
      p,
      JSON.stringify({
        defaultAdapter: "codex",
        concurrency: 3,
        claudeWorkflowsRoot: "/tmp/claude-workflows",
        adapters: {
          mine: {
            command: ["my", "{prompt}"],
            output: { format: "jsonl", eventType: "answer", textPath: ["payload", "text"], select: "last" },
          },
        },
      }),
    );
    const cfg = loadConfig(p);
    assert.equal(cfg.settings.defaultAdapter, "codex");
    assert.equal(cfg.settings.concurrency, 3);
    assert.equal(cfg.settings.claudeWorkflowsRoot, "/tmp/claude-workflows");
    assert.ok(cfg.adapters.mine, "user adapter present");
    assert.ok(cfg.adapters.claude, "built-ins still present");
    assert.deepEqual(cfg.adapters.mine!.command, ["my", "{prompt}"]);
    assert.deepEqual(cfg.adapters.mine!.output, {
      format: "jsonl",
      eventType: "answer",
      textPath: ["payload", "text"],
      select: "last",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeJobsScope defaults to 'all'; only an explicit 'project' narrows it", () => {
  assert.equal(defaultConfig().settings.claudeJobsScope, "all");
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const write = (v: unknown) => {
      const p = join(dir, "odw.config.json");
      writeFileSync(p, JSON.stringify({ claudeJobsScope: v }));
      return loadConfig(p).settings.claudeJobsScope;
    };
    assert.equal(write("project"), "project");
    assert.equal(write("all"), "all");
    assert.equal(write("garbage"), "all"); // unknown value falls back to the default
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAdapter falls back to defaultAdapter and errors clearly", () => {
  const cfg = defaultConfig();
  cfg.settings.defaultAdapter = "claude";
  assert.equal(resolveAdapter(cfg).name, "claude");
  assert.equal(resolveAdapter(cfg, "codex").name, "codex");
  assert.throws(() => resolveAdapter(cfg, "nope"), AdapterNotFound);
});

test("resolveConcurrency: explicit wins; auto is bounded to [1,16]", () => {
  assert.equal(resolveConcurrency(5), 5);
  const auto = resolveConcurrency(null);
  assert.ok(auto >= 1 && auto <= 16, `auto concurrency out of range: ${auto}`);
});

test("resolveRunsRoot defaults under home, honours an explicit path", () => {
  assert.match(resolveRunsRoot(null), /\.odw[\\/]runs$/);
  assert.equal(resolveRunsRoot("/tmp/x"), "/tmp/x");
});

test("resolveClaudeWorkflowsRoot honours explicit root and CLAUDE_CONFIG_DIR", () => {
  const old = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.match(resolveClaudeWorkflowsRoot(null), /\.claude[\\/]workflows$/);
    assert.equal(resolveClaudeWorkflowsRoot("/tmp/claude-wf"), "/tmp/claude-wf");
    process.env.CLAUDE_CONFIG_DIR = "/tmp/custom-claude";
    assert.equal(resolveClaudeWorkflowsRoot(null), join("/tmp/custom-claude", "workflows"));
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = old;
  }
});

test("a missing explicit config path throws", () => {
  assert.throws(() => loadConfig("/no/such/odw.config.json"));
});

test("an invalid adapter (no command) is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(p, JSON.stringify({ adapters: { bad: { label: "x" } } }));
    assert.throws(() => loadConfig(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid adapter output declarations are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(
      p,
      JSON.stringify({
        adapters: {
          bad: {
            command: ["bad"],
            output: { format: "jsonl", eventType: "text", textPath: [], select: "last" },
          },
        },
      }),
    );
    assert.throws(() => loadConfig(p), /output\.textPath/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A NaN setting used to slip through silently: "auto" concurrency deadlocked
// every dispatch, a NaN maxAgents disabled the runaway guard, NaN schemaRetries
// never called the CLI, and a NaN adapter timeout timed every agent out at once.
test("malformed numeric settings are rejected with a ConfigError naming the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    const load = (raw: Record<string, unknown>) => {
      writeFileSync(p, JSON.stringify(raw));
      return loadConfig(p, { quiet: true });
    };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ concurrency: "auto" }, /"concurrency" must be a positive integer, or null for auto; got "auto"/],
      [{ concurrency: 0 }, /"concurrency"/],
      [{ concurrency: 2.5 }, /"concurrency"/],
      [{ maxAgents: "lots" }, /"maxAgents" must be a positive integer/],
      [{ maxAgents: true }, /"maxAgents"/],
      [{ timeout: "soon" }, /"timeout" must be a positive number of seconds/],
      [{ timeout: 0 }, /"timeout"/],
      [{ schemaRetries: "x" }, /"schemaRetries" must be a non-negative integer/],
      [{ schemaRetries: -1 }, /"schemaRetries"/],
      [{ adapters: { mine: { command: ["x"], timeout: "abc" } } }, /adapter 'mine' 'timeout' must be a positive number/],
    ];
    for (const [raw, message] of cases) {
      assert.throws(() => load(raw), (err: Error) => err instanceof ConfigError && message.test(err.message));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid numeric settings still load, including numeric strings and null", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(
      p,
      JSON.stringify({
        concurrency: "4",
        maxAgents: 7,
        timeout: null,
        schemaRetries: 0,
        adapters: { mine: { command: ["x"], timeout: 0.5 }, inherit: { command: ["y"], timeout: null } },
      }),
    );
    const cfg = loadConfig(p, { quiet: true });
    assert.equal(cfg.settings.concurrency, 4);
    assert.equal(cfg.settings.maxAgents, 7);
    assert.equal(cfg.settings.timeout, 1800, "a null setting keeps its default");
    assert.equal(cfg.settings.schemaRetries, 0);
    assert.equal(cfg.adapters.mine!.timeout, 0.5);
    assert.equal(cfg.adapters.inherit!.timeout, undefined, "a null adapter timeout inherits the run-wide one");
    writeFileSync(p, JSON.stringify({ concurrency: null }));
    assert.equal(loadConfig(p, { quiet: true }).settings.concurrency, null, "null still means auto");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stall watchdog is off by default; its settings load run-wide and per adapter", () => {
  const defaults = defaultConfig();
  assert.equal(defaults.settings.stallTimeout, null);
  assert.equal(defaults.settings.stallRestarts, 1);
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(
      p,
      JSON.stringify({
        stallTimeout: "90",
        stallRestarts: 0,
        adapters: {
          mine: { command: ["x"], stallTimeout: 30 },
          quiet: { command: ["y"], stallTimeout: 0 },
          inherit: { command: ["z"], stallTimeout: null },
        },
      }),
    );
    const cfg = loadConfig(p, { quiet: true });
    assert.equal(cfg.settings.stallTimeout, 90);
    assert.equal(cfg.settings.stallRestarts, 0);
    assert.equal(cfg.adapters.mine!.stallTimeout, 30);
    assert.equal(cfg.adapters.quiet!.stallTimeout, 0, "0 opts one adapter out of a run-wide stall timeout");
    assert.equal(cfg.adapters.inherit!.stallTimeout, undefined, "null inherits the run-wide setting");
    writeFileSync(p, JSON.stringify({ stallTimeout: 0 }));
    assert.equal(loadConfig(p, { quiet: true }).settings.stallTimeout, null, "0 means off, like null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed stall settings are rejected with a ConfigError naming the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ stallTimeout: "soon" }, /"stallTimeout" must be a positive number of seconds, or null for no stall watchdog/],
      [{ stallTimeout: -5 }, /"stallTimeout"/],
      [{ stallRestarts: 1.5 }, /"stallRestarts" must be a non-negative integer/],
      [{ stallRestarts: -1 }, /"stallRestarts"/],
      [
        { adapters: { mine: { command: ["x"], stallTimeout: "abc" } } },
        /adapter 'mine' 'stallTimeout' must be a positive number of seconds, or 0 to turn the stall watchdog off/,
      ],
    ];
    for (const [raw, message] of cases) {
      writeFileSync(p, JSON.stringify(raw));
      assert.throws(
        () => loadConfig(p, { quiet: true }),
        (err: Error) => err instanceof ConfigError && message.test(err.message),
        JSON.stringify(raw),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectConfigWarnings knows the stall keys, top-level and per adapter", () => {
  assert.deepEqual(
    collectConfigWarnings({
      stallTimeout: 120,
      stallRestarts: 2,
      adapters: { mine: { command: ["x"], stallTimeout: 0 } },
    }),
    [],
  );
  const [typo] = collectConfigWarnings({ stalTimeout: 120 });
  assert.match(typo!, /did you mean "stallTimeout"/);
});

test("notify is off by default and loads normalized", () => {
  assert.equal(defaultConfig().settings.notify, null);
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    const load = (notify: unknown) => {
      writeFileSync(p, JSON.stringify({ notify }));
      return loadConfig(p, { quiet: true }).settings.notify;
    };
    assert.equal(load(null), null);
    assert.deepEqual(
      load({
        command: ["/usr/local/bin/odw-notify", "--channel", "ops"],
        webhook: "https://hooks.slack.com/services/T0/B0/XYZ",
        on: ["stopped", "failed", "failed"],
      }),
      {
        command: ["/usr/local/bin/odw-notify", "--channel", "ops"],
        webhook: "https://hooks.slack.com/services/T0/B0/XYZ",
        on: ["failed", "stopped"],
      },
    );
    assert.deepEqual(load({ webhook: "http://127.0.0.1:9000/hook" }), {
      command: null,
      webhook: "http://127.0.0.1:9000/hook",
      on: ["done", "failed", "stopped"],
    });
    assert.deepEqual(load({ command: ["say", "done"], on: [] }).on, [], "an empty list mutes the hooks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed notify block is a ConfigError that never echoes a secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    const cases: Array<[unknown, RegExp]> = [
      ["https://hooks.slack.com/services/SECRET", /"notify" must be an object .*; got a string$/],
      [["say"], /"notify" must be an object/],
      [
        { command: "notify-send --token SECRET" },
        /"notify.command" must be a non-empty array of strings \(an argv, run without a shell\); got a string$/,
      ],
      [{ command: [] }, /"notify.command" .*; got an empty list$/],
      [{ command: [""] }, /"notify.command"/],
      [{ command: ["say", 1] }, /"notify.command"/],
      [
        { webhook: "hooks.slack.com/services/SECRET" },
        /"notify.webhook" must be an http\(s\) URL; got a string that is not an absolute URL$/,
      ],
      [{ webhook: "ftp://example.com/SECRET" }, /"notify.webhook" must be an http\(s\) URL; got a ftp: URL$/],
      [{ webhook: 42 }, /"notify.webhook" must be an http\(s\) URL; got a number$/],
      [{ webhook: "https://user:SECRET@example.com/hook" }, /"notify.webhook" must not embed credentials/],
      [
        { webhook: "https://example.com/h", on: ["done", "finished"] },
        /"notify.on" must be a list of "done", "failed", "stopped"; got \["done","finished"\]/,
      ],
      [{ webhook: "https://example.com/h", on: "failed" }, /"notify.on"/],
    ];
    for (const [notify, message] of cases) {
      writeFileSync(p, JSON.stringify({ notify }));
      assert.throws(
        () => loadConfig(p, { quiet: true }),
        (err: Error) => err instanceof ConfigError && message.test(err.message) && !/SECRET/.test(err.message),
        JSON.stringify(notify),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectConfigWarnings knows notify, flags its typos, and a notify with no hook", () => {
  const valid = { command: ["x"], webhook: "https://example.com/h", on: ["done"], $comment: "ok" };
  assert.deepEqual(collectConfigWarnings({ notify: valid }), []);
  const [typo] = collectConfigWarnings({ notify: { comand: ["x"], webhook: "https://example.com/h" } });
  assert.match(typo!, /^notify: unknown field "comand" is ignored — did you mean "command"\?$/);
  const [idle] = collectConfigWarnings({ notify: { on: ["failed"] } });
  assert.match(idle!, /neither "command" nor "webhook", so no hook will fire/);
});

test("a scheduler refuses NaN limits instead of deadlocking", () => {
  assert.throws(() => new Scheduler({ concurrency: NaN, maxAgents: 10 }), ConfigError);
  assert.throws(() => new Scheduler({ concurrency: 2, maxAgents: NaN }), ConfigError);
});

test("Windows executable candidates honor PATHEXT without duplicating extensions", () => {
  assert.deepEqual(executableCandidates("agent", "win32", ".EXE;.CMD;.exe"), [
    "agent",
    "agent.EXE",
    "agent.CMD",
  ]);
  assert.deepEqual(executableCandidates("agent.cmd", "win32", ".EXE;.CMD"), ["agent.cmd"]);
  assert.deepEqual(executableCandidates("agent", "linux", ".EXE;.CMD"), ["agent"]);
});

// --- usability guardrails: unknown-key warnings & zero-config adapter pick ---

import { collectConfigWarnings } from "../src/adapters/config.js";
import { chmodSync, mkdirSync } from "node:fs";

test("collectConfigWarnings flags a nested 'settings' wrapper as ignored", () => {
  const warnings = collectConfigWarnings({
    settings: { defaultAdapter: "claude", runsRoot: "/tmp/x" },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /IGNORED/);
  assert.match(warnings[0]!, /"defaultAdapter", "runsRoot"/);
  assert.match(warnings[0]!, /top level/);
});

test("collectConfigWarnings suggests the nearest key for typos", () => {
  const warnings = collectConfigWarnings({ runsroot: "/tmp/x", defaultAdaptor: "codex" });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /did you mean "runsRoot"/);
  assert.match(warnings[1]!, /did you mean "defaultAdapter"/);
});

test("collectConfigWarnings flags unknown adapter fields", () => {
  const warnings = collectConfigWarnings({
    adapters: { mine: { command: ["x"], stdn: "{prompt}" } },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /adapter "mine"/);
  assert.match(warnings[0]!, /did you mean "stdin"/);
});

test("collectConfigWarnings is silent on a fully valid config and on comment keys", () => {
  assert.deepEqual(
    collectConfigWarnings({
      $comment: "hi",
      "//": "also a comment",
      defaultAdapter: "claude",
      concurrency: 4,
      adapters: {
        mine: {
          command: ["x"],
          stdin: "{prompt}",
          output: { format: "text" },
          $comment: "ok",
        },
      },
    }),
    [],
  );
});

test("loadConfig prints config warnings to stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(p, JSON.stringify({ settings: { runsRoot: "/tmp/x" } }));
    loadConfig(p);
    assert.match(captured, /odw: config warning:/);
    assert.match(captured, /IGNORED/);
  } finally {
    process.stderr.write = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAdapter with no default picks the sole adapter whose CLI is installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-path-"));
  const oldPath = process.env.PATH;
  try {
    mkdirSync(join(dir, "bin"), { recursive: true });
    const stub = join(dir, "bin", "claude");
    writeFileSync(stub, "#!/bin/sh\n");
    chmodSync(stub, 0o755);
    process.env.PATH = join(dir, "bin");
    const cfg = defaultConfig(); // nine builtins, defaultAdapter null
    assert.equal(resolveAdapter(cfg).name, "claude");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAdapter with no default and several installed CLIs errors with guidance", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-path-"));
  const oldPath = process.env.PATH;
  try {
    mkdirSync(join(dir, "bin"), { recursive: true });
    for (const name of ["claude", "codex"]) {
      const stub = join(dir, "bin", name);
      writeFileSync(stub, "#!/bin/sh\n");
      chmodSync(stub, 0o755);
    }
    process.env.PATH = join(dir, "bin");
    const cfg = defaultConfig();
    assert.throws(
      () => resolveAdapter(cfg),
      (err: Error) =>
        err instanceof AdapterNotFound &&
        /installed here: claude, codex/.test(err.message) &&
        /defaultAdapter/.test(err.message) &&
        // every suggested fix names a REAL installed adapter, and the
        // interactive way out (odw init) is discoverable from the error itself
        /odw init --adapter claude/.test(err.message) &&
        /pass --adapter claude to odw run/.test(err.message) &&
        /agent\(prompt, \{ adapter: "claude"/.test(err.message),
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAdapter with no default and no installed CLIs says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-path-"));
  const oldPath = process.env.PATH;
  try {
    mkdirSync(join(dir, "bin"), { recursive: true }); // empty PATH dir
    process.env.PATH = join(dir, "bin");
    const cfg = defaultConfig();
    assert.throws(
      () => resolveAdapter(cfg),
      (err: Error) => err instanceof AdapterNotFound && /none of their CLIs/.test(err.message),
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
