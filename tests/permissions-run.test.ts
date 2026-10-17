import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { Config } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { AgentError } from "../src/errors.js";
import { AGENT_FAILED, AGENT_STARTED, LOG, MemorySink } from "../src/events.js";
import { ReplayJournal, resumeKey, type AgentResultRecord } from "../src/journal.js";
import { createPrimitives } from "../src/primitives.js";
import { foldAgents } from "../src/runtime/runs-view.js";

// Permission tiers through the engine (ODW extension): what each agent's
// events say, what the run logs once, how a refused agent shows, and what a
// saved record and a replay keep.

/** A run over `config` whose bridge records the argv it would spawn instead of spawning. */
function harness(config: Config, extra: { save?: (rec: AgentResultRecord) => void; replay?: ReplayJournal } = {}) {
  const sink = new MemorySink();
  const spawned: string[][] = [];
  const runner: CommandRunner = async (command) => {
    spawned.push(command);
    return { returncode: 0, stdout: "done", stderr: "", timedOut: false, duration: 0.01 };
  };
  const ctx = buildContext(config, { sink, source: "/repo", saveAgentResult: extra.save, replay: extra.replay });
  ctx.bridge = new Bridge(config, { source: "/repo", runner });
  return { ctx, sink, spawned, p: createPrimitives(ctx) };
}

function claudeConfig(): Config {
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  return config;
}

test("every agent_started says the agent's tier, and the fold carries it to the agent view", async () => {
  const { sink, spawned, p } = harness(claudeConfig());
  await p.agent("TASK a", { label: "writer" });
  await p.agent("TASK b", { label: "reviewer", permissions: "read" });
  assert.deepEqual(sink.ofType(AGENT_STARTED).map((e) => e.permissions), ["edit", "read"]);
  assert.ok(spawned[0]!.includes("acceptEdits") && spawned[1]!.includes("dontAsk"), "each ran its own tier's flags");
  assert.deepEqual(
    foldAgents(sink.events).map((a) => [a.label, a.state, a.permissions]),
    [
      ["writer", "done", "edit"],
      ["reviewer", "done", "read"],
    ],
  );
  // An event file from before tiers folds with no tier at all.
  const legacy = foldAgents([{ ts: 1, type: "agent_started", agentId: 1, label: "old", adapter: "claude" }]);
  assert.equal("permissions" in legacy[0]!, false);
});

test("an agent that asks for more than the run allows fails on its own, naming both tiers", async () => {
  const { ctx, sink, spawned, p } = harness(claudeConfig());
  const results = await p.parallel([
    () => p.agent("TASK greedy", { label: "greedy", permissions: "full" }),
    () => p.agent("TASK fine", { label: "fine" }),
  ]);
  assert.deepEqual(results, [null, "done"], "a recoverable failure: the batch goes on");
  assert.equal(ctx.scheduler.fatalError, undefined);
  assert.equal(spawned.length, 1, "the greedy agent never spawned");
  const failed = sink.ofType(AGENT_FAILED);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.label, "greedy");
  assert.match(String(failed[0]!.error), /^AgentError: agent\(\) asked for permissions "full", but the run allows only "edit"/);
  const greedy = foldAgents(sink.events).find((a) => a.label === "greedy")!;
  assert.deepEqual([greedy.state, greedy.permissions], ["failed", "full"], "the graph shows what it asked for, and that it failed");
  await assert.rejects(() => p.agent("TASK bad", { permissions: "root" as never }), /agent\(\) option permissions must be "read", "edit" or "full"; got "root"/);
});

test("a CLI with no read mode is refused before it spawns, and shows as a failed agent", async () => {
  const config = claudeConfig();
  config.settings.permissions = "read";
  const { sink, spawned, p } = harness(config);
  await assert.rejects(
    () => p.agent("TASK x", { adapter: "kimi", label: "kimi-review" }),
    (err: unknown) => err instanceof AgentError && /^kimi cannot run read-only/.test(err.message),
  );
  assert.equal(spawned.length, 0);
  const [view] = foldAgents(sink.events);
  assert.deepEqual([view!.label, view!.state, view!.permissions], ["kimi-review", "failed", "read"]);
  assert.match(view!.error!, /use an adapter that can \(--adapter \w+/);
});

test("an adapter that cannot run the asked tier is logged once per run, not per agent", async () => {
  const config = claudeConfig();
  config.settings.permissions = "full";
  const { sink, spawned, p } = harness(config);
  await p.parallel([
    ...[1, 2, 3].map((i) => () => p.agent(`TASK k${i}`, { adapter: "kimi" })),
    ...[1, 2].map((i) => () => p.agent(`TASK o${i}`, { adapter: "omp" })),
    () => p.agent("TASK c", { adapter: "claude" }),
  ]);
  const notes = sink.ofType(LOG).filter((e) => /mode/.test(String(e.message)));
  assert.deepEqual(
    notes.map((e) => [e.adapter, e.permissions, e.message]).sort(),
    [
      ["kimi", "edit", `adapter 'kimi' has no "full" mode: its agents run with its "edit" flags`],
      ["omp", "edit", `adapter 'omp' has no "full" mode: its agents run with its "edit" flags (--approval-mode yolo)`],
    ],
  );
  const tiers = sink.ofType(AGENT_STARTED).map((e) => `${e.adapter}:${e.permissions}`).sort();
  assert.deepEqual(tiers, ["claude:full", "kimi:edit", "kimi:edit", "kimi:edit", "omp:edit", "omp:edit"]);
  assert.ok(spawned.every((argv) => argv[0] !== "omp" || argv.includes("yolo")), "omp ran its edit flags");
});

test("an adapter of the user's own runs as configured under any tier, with one note", async () => {
  const config = claudeConfig();
  config.settings.permissions = "read";
  config.adapters.mine = { name: "mine", command: ["mine", "--go"], stdin: "{prompt}" };
  const { sink, spawned, p } = harness(config);
  await p.agent("TASK 1", { adapter: "mine" });
  await p.agent("TASK 2", { adapter: "mine" });
  assert.deepEqual(spawned, [
    ["mine", "--go"],
    ["mine", "--go"],
  ]);
  const notes = sink.ofType(LOG).filter((e) => e.adapter === "mine");
  assert.equal(notes.length, 1);
  assert.match(String(notes[0]!.message), /declares no permissionArgs, so ODW cannot make it run "read"/);
  assert.deepEqual(sink.ofType(AGENT_STARTED).map((e) => e.permissions), ["edit", "edit"], "treated as edit");
});

test("the saved record keeps the tier; a replay shows it, and the option is part of the resume key", async () => {
  const saved: AgentResultRecord[] = [];
  const first = harness(claudeConfig(), { save: (rec) => saved.push(rec) });
  await first.p.agent("TASK r", { label: "reviewer", permissions: "read" });
  assert.equal(saved[0]!.permissions, "read");

  const replayed: AgentResultRecord[] = [];
  const again = harness(claudeConfig(), { save: (rec) => replayed.push(rec), replay: new ReplayJournal("run-0", saved) });
  assert.equal(await again.p.agent("TASK r", { label: "reviewer", permissions: "read" }), "done");
  assert.equal(again.spawned.length, 0, "replayed, not run");
  const [started] = again.sink.ofType(AGENT_STARTED);
  assert.deepEqual([started!.cached, started!.permissions], [true, "read"]);
  assert.equal(replayed[0]!.permissions, "read", "a resume of the resume keeps it too");

  assert.equal(resumeKey("p", {}), resumeKey("p", { permissions: undefined }), "an unset option keys like an absent one");
  assert.notEqual(resumeKey("p", {}), resumeKey("p", { permissions: "read" }), "a read agent cannot make an edit one's change");
});
