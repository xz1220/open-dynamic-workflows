import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultConfig,
  loadConfig,
  resolveAdapter,
  resolveClaudeWorkflowsRoot,
  resolveConcurrency,
  resolveRunsRoot,
} from "../src/adapters/config.js";
import { AdapterNotFound } from "../src/errors.js";

test("defaultConfig ships the five built-in adapters", () => {
  const cfg = defaultConfig();
  for (const name of ["codex", "claude", "gemini", "qwen", "kimi"]) {
    assert.ok(cfg.adapters[name], `expected built-in adapter '${name}'`);
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
        adapters: { mine: { command: ["my", "{prompt}"] } },
      }),
    );
    const cfg = loadConfig(p);
    assert.equal(cfg.settings.defaultAdapter, "codex");
    assert.equal(cfg.settings.concurrency, 3);
    assert.equal(cfg.settings.claudeWorkflowsRoot, "/tmp/claude-workflows");
    assert.ok(cfg.adapters.mine, "user adapter present");
    assert.ok(cfg.adapters.claude, "built-ins still present");
    assert.deepEqual(cfg.adapters.mine!.command, ["my", "{prompt}"]);
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

// --- usability guardrails: unknown-key warnings & zero-config adapter pick ---

import { collectConfigWarnings } from "../src/adapters/config.js";
import { chmodSync, mkdirSync } from "node:fs";

test("collectConfigWarnings flags a nested 'settings' wrapper as ignored", () => {
  const warnings = collectConfigWarnings({
    settings: { defaultAdapter: "claude", workspaceMode: "inplace" },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /IGNORED/);
  assert.match(warnings[0]!, /"defaultAdapter", "workspaceMode"/);
  assert.match(warnings[0]!, /top level/);
});

test("collectConfigWarnings suggests the nearest key for typos", () => {
  const warnings = collectConfigWarnings({ workspacemode: "inplace", defaultAdaptor: "codex" });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /did you mean "workspaceMode"/);
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
      adapters: { mine: { command: ["x"], stdin: "{prompt}", $comment: "ok" } },
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
    writeFileSync(p, JSON.stringify({ settings: { workspaceMode: "inplace" } }));
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
    const cfg = defaultConfig(); // five builtins, defaultAdapter null
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
        /agent\(prompt, \{ adapter:/.test(err.message),
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
