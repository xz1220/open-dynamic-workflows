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
