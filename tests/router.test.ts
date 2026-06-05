import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/adapters/config.js";
import type { Adapter } from "../src/adapters/types.js";
import type { AgentRequest } from "../src/bridge.js";
import { LiteralRouter } from "../src/router.js";

const cfg = defaultConfig();
const router = new LiteralRouter();
const claude = cfg.adapters.claude!; // built-in: flags.model = ["--model"]
const settings = cfg.settings;

function plan(request: AgentRequest, adapter: Adapter = claude, s = settings) {
  return router.plan({ request, adapter, settings: s });
}

test("T2: a declared model flag becomes extraArgs, with no note", () => {
  const p = plan({ prompt: "x", model: "claude-opus-4-8" });
  assert.deepEqual(p.extraArgs, ["--model", "claude-opus-4-8"]);
  assert.equal(p.notes.length, 0);
  assert.equal(p.context.model, undefined); // flag path, not the {model} token path
});

test("T2: no model → no extraArgs (never a dangling --model)", () => {
  const p = plan({ prompt: "x" });
  assert.deepEqual(p.extraArgs, []);
  assert.deepEqual(p.context, {});
  assert.equal(p.notes.length, 0);
});

test("T2: an adapter with a {model} token gets the token filled, not extraArgs", () => {
  const tokenAdapter: Adapter = { name: "tok", command: ["foo", "--model", "{model}"] };
  const p = plan({ prompt: "x", model: "m" }, tokenAdapter);
  assert.equal(p.context.model, "m");
  assert.deepEqual(p.extraArgs, []);
  assert.equal(p.notes.length, 0);
});

test("T5: a model with no carrier is noted, not silently dropped", () => {
  const noFlag: Adapter = { name: "noflag", command: ["foo"] };
  const p = plan({ prompt: "x", model: "m" }, noFlag);
  assert.deepEqual(p.extraArgs, []);
  assert.equal(p.context.model, undefined);
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0]!, /model 'm'/);
  assert.match(p.notes[0]!, /no model flag/);
});

test("T5: agentType always produces a note (persona via prompt injection)", () => {
  const p = plan({ prompt: "x", agentType: "code-reviewer" });
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0]!, /code-reviewer/);
  assert.match(p.notes[0]!, /prompt injection/);
});

test("T4: isolation 'worktree' forces copy mode and notes it, even when default is inplace", () => {
  const inplace = { ...settings, workspaceMode: "inplace" as const };
  const p = plan({ prompt: "x", isolation: "worktree" }, claude, inplace);
  assert.equal(p.workspaceMode, "copy");
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0]!, /worktree/);
});

test("no options → the plan mirrors the run's default workspace mode, with no notes", () => {
  const p = plan({ prompt: "x" });
  assert.equal(p.workspaceMode, settings.workspaceMode);
  assert.equal(p.notes.length, 0);
});

test("T5: every set-but-unhonored option is covered at once (model, isolation, agentType)", () => {
  const noFlag: Adapter = { name: "noflag", command: ["foo"] };
  const p = plan({ prompt: "x", model: "m", agentType: "qa", isolation: "worktree" }, noFlag);
  assert.equal(p.notes.length, 3, JSON.stringify(p.notes));
  assert.ok(p.notes.some((n) => /model 'm'/.test(n)));
  assert.ok(p.notes.some((n) => /qa/.test(n)));
  assert.ok(p.notes.some((n) => /worktree/.test(n)));
});
