import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { CliResult, Config } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { modelPairs, runDoctor } from "../src/doctor.js";
import { baselineOf, DriftWatch, shortVersion } from "../src/drift.js";
import { AdapterExecutionError } from "../src/errors.js";
import { AGENT_FAILED, LOG, MemorySink, event, type WorkflowEvent } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";
import { RunStore } from "../src/runtime/run-store.js";
import { summarize } from "../src/runtime/runs-view.js";
import { executeRun, type DriftEvalLaunch } from "../src/runtime/worker.js";

// Drift (ODW extensions): a model the CLI does not have fails fast and falls
// back; `odw doctor --models` probes every adapter/model pair the config and
// the workflows name; drift watch notices a CLI or a model that changed since
// the workflow's last run, suggests its eval, and with driftEval starts it.

const posix = { skip: process.platform === "win32" ? "POSIX shell fake CLIs" : false };

const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.1 });
const failing = (stderr: string): CliResult => ({ returncode: 1, stdout: "", stderr, timedOut: false, duration: 0.1 });

// As tests/failures.test.ts samples them.
const NO_MODEL = "ERROR: unexpected status 404 Not Found: The model `gpt-9` does not exist or you do not have access to it.";
const QUOTA = "You've hit your usage limit. Upgrade to Pro or try again in 3h 22m.";

function routingConfig(fallback: Record<string, string[]>): Config {
  const config = defaultConfig();
  for (const name of ["a", "b", "c"]) {
    config.adapters[name] = { name, command: [`${name}-cli`], stdin: "{prompt}", flags: { model: ["--model"] } };
  }
  config.settings.defaultAdapter = "a";
  config.settings.fallback = fallback;
  return config;
}

function routed(config: Config, replies: Record<string, CliResult[]>) {
  const calls: string[] = [];
  const runner: CommandRunner = async (command) => {
    const adapter = command[0]!.replace(/-cli$/, "");
    calls.push(adapter);
    return replies[adapter]?.shift() ?? ok(`${adapter} answered`);
  };
  const sink = new MemorySink();
  const ctx = buildContext(config, { sink });
  ctx.bridge = new Bridge(config, { runner, sleep: async () => {}, random: () => 0 });
  return { ctx, sink, calls };
}

// --- model_unavailable --------------------------------------------------------------

test("a model the CLI does not have fails fast — no retry — and moves the call down its chain", async () => {
  const { ctx, sink, calls } = routed(routingConfig({ a: ["b", "c"] }), { a: [failing(NO_MODEL)], b: [failing(QUOTA)] });
  assert.equal(await createPrimitives(ctx).agent("x", { label: "x", model: "gpt-9" }), "c answered");
  assert.deepEqual(calls, ["a", "b", "c"], "one run on a, never retried");
  const hops = sink.ofType(LOG).filter((e) => Array.isArray(e.fellBackFrom));
  assert.deepEqual(hops.map((e) => [e.message, e.reason]), [
    ["x:1 → b after a model_unavailable", "model_unavailable"],
    ["x:1 → c after b quota", "quota"],
  ]);
  // At the chain's end it is the call's failure, with what to do.
  const end = routed(routingConfig({}), { a: [failing(NO_MODEL)] });
  await assert.rejects(
    createPrimitives(end.ctx).agent("x", { label: "x" }),
    (err: Error) =>
      err instanceof AdapterExecutionError && err.reason === "model_unavailable" && /could not use the model .*odw doctor --models/.test(err.message),
  );
  assert.deepEqual(end.calls, ["a"]);
  assert.equal(end.sink.ofType(AGENT_FAILED)[0]!.reason, "model_unavailable");
});

// --- odw doctor --models ------------------------------------------------------------

/** A fake CLI: answers the doctor's marker, unless its --model is "gone" — then it says the model does not exist. */
const FAKE_MODEL_CLI = `
const i = process.argv.indexOf("--model");
const model = i === -1 ? null : process.argv[i + 1];
let input = "";
process.stdin.on("data", (c) => (input += c)).on("end", () => {
  if (model === "gone") {
    process.stderr.write("ERROR: unexpected status 404 Not Found: The model \`gone\` does not exist or you do not have access to it.\\n");
    process.exit(1);
  }
  if (model === "flaky") {
    process.stderr.write("segmentation fault\\n");
    process.exit(2);
  }
  const m = input.match(/ODW_\\w+_OK/);
  process.stdout.write(m ? m[0] : "?");
});
`;

function doctorProject(extra: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "odw-drift-doctor-"));
  const cli = join(dir, "fake-model-cli.mjs");
  writeFileSync(cli, FAKE_MODEL_CLI);
  const adapter = { command: [execPath, cli], stdin: "{prompt}", flags: { model: ["--model"] } };
  const path = join(dir, "odw.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      runsRoot: join(dir, "runs"),
      defaultAdapter: "one",
      adapters: { one: adapter, two: adapter, ghost: { command: ["definitely-not-installed-odw-cli"], stdin: "{prompt}" } },
      ...extra,
    }),
  );
  return { dir, path, config: loadConfig(path, { quiet: true }) };
}

test("modelPairs: the models tiers, the default adapter, fallback chains and the workflows' phases, each once", () => {
  const { dir, config } = doctorProject({
    models: { fast: { one: "small", two: "gone" } },
    fallback: { one: ["two"] },
  });
  try {
    mkdirSync(join(dir, ".odw", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".odw", "workflows", "review.js"),
      "export const meta = { name: 'review', description: 'd', phases: [" +
        "{ title: 'Plan', model: '@fast' }, { title: 'Build', adapter: ['two', 'ghost'], model: 'big' }, 'Ship'] }\nreturn 1\n",
    );
    writeFileSync(join(dir, ".odw", "workflows", "broken.js"), "export const meta = nope\n");
    const pairs = modelPairs(config, dir).map((p) => [p.adapter, p.model, p.from.join(" | ")]);
    assert.deepEqual(pairs, [
      ["one", "small", "models.fast | workflow review: phase Plan"],
      ["two", "gone", "models.fast"],
      ["one", null, "default adapter | fallback"],
      ["two", null, "fallback"],
      ["two", "big", "workflow review: phase Build"],
      ["ghost", "big", "workflow review: phase Build"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor --models: one tiny prompt per pair, on that adapter alone — ok, model_unavailable, other, skipped", async () => {
  const { dir, path, config } = doctorProject({
    models: { fast: { one: "small", two: "gone" }, odd: { one: "flaky" }, far: { ghost: "x" } },
    fallback: { two: ["one"] },
  });
  try {
    const report = await runDoctor({ config, configPath: path, cwd: dir, smoke: [], models: true });
    const models = report.checks.filter((c) => c.id.startsWith("model:"));
    const byId = (id: string) => models.find((c) => c.id === id)!;
    assert.deepEqual([byId("model:one:small").status, byId("model:one:small").model!.result], ["ok", "ok"]);
    assert.match(byId("model:one:small").detail, /^answered in [\d.]+s · named by models\.fast$/);
    const gone = byId("model:two:gone");
    assert.deepEqual([gone.status, gone.model!.result], ["fail", "model_unavailable"], "no fallback to 'one' hides it");
    assert.match(gone.detail, /^model_unavailable: adapter 'two' could not use the model/);
    assert.deepEqual([byId("model:one:flaky").status, byId("model:one:flaky").model!.result], ["warn", "other"]);
    assert.match(byId("model:one:flaky").detail, /^other \(exit\)/);
    assert.equal(byId("model:ghost:x").status, "skip");
    assert.equal(byId("model:one:").title, "Model one (default model)");
    assert.equal(byId("model:one:").status, "ok");
    assert.equal(report.ok, false, "a missing model fails the doctor");
    // Without --models no pair is probed.
    const plain = await runDoctor({ config, configPath: path, cwd: dir, smoke: [] });
    assert.equal(plain.checks.filter((c) => c.id.startsWith("model")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- drift watch ----------------------------------------------------------------------

test("DriftWatch compares what both runs recorded, logs each change once, and a version as its number", () => {
  const previous: WorkflowEvent[] = [
    event("run_started", { setup: { settings: { models: { big: { claude: "opus-4" } } } } }),
    event("cli_version", { adapter: "claude", command: "claude", version: "2.1.302 (Claude Code)" }),
    event("cli_version", { adapter: "codex", command: "codex", version: null, error: "not found" }),
    event("agent_started", { agentId: 1, label: "review", adapter: "claude", model: "@big" }),
    event("agent_started", { agentId: 2, label: "fix", adapter: "claude" }),
    event("agent_started", { agentId: 3, label: "test", adapter: "codex", model: "gpt-5" }),
  ];
  const baseline = baselineOf("prev-run", previous);
  assert.deepEqual(baseline.cli, { claude: "2.1.302 (Claude Code)" });
  assert.deepEqual(baseline.models.review, { adapter: "claude", model: "opus-4" });
  const logged: WorkflowEvent[] = [];
  const watch = new DriftWatch({ workflow: "review-swarm", baseline, tiers: { big: { claude: "opus-5" } }, emit: (ev) => logged.push(ev) });
  watch.observe(event("cli_version", { adapter: "claude", command: "claude", version: "2.1.330 (Claude Code)" }));
  watch.observe(event("cli_version", { adapter: "codex", command: "codex", version: "0.9.0" })); // unknown before: no drift
  watch.observe(event("agent_started", { agentId: 1, label: "review", adapter: "claude", model: "@big" }));
  watch.observe(event("agent_started", { agentId: 2, label: "review", adapter: "claude", model: "@big" })); // its label again
  watch.observe(event("agent_started", { agentId: 3, label: "fix", adapter: "claude", model: "sonnet" }));
  watch.observe(event("agent_started", { agentId: 4, label: "test", adapter: "claude", model: "x" })); // another adapter
  watch.observe(event("agent_started", { agentId: 5, label: "new", adapter: "claude", model: "x" })); // a label it never had
  assert.deepEqual(
    logged.map((e) => e.message),
    [
      "drift: claude CLI 2.1.302 → 2.1.330 since the last run of review-swarm (prev-run)",
      "drift: review asks claude for model opus-4 → opus-5 since the last run of review-swarm (prev-run)",
      "drift: fix asks claude for model (the CLI's default) → sonnet since the last run of review-swarm (prev-run)",
    ],
  );
  assert.deepEqual(watch.drift, {
    since: "prev-run",
    changes: [
      { kind: "cli", adapter: "claude", from: "2.1.302 (Claude Code)", to: "2.1.330 (Claude Code)" },
      { kind: "model", adapter: "claude", label: "review", from: "opus-4", to: "opus-5" },
      { kind: "model", adapter: "claude", label: "fix", from: null, to: "sonnet" },
    ],
  });
  assert.equal(watch.pendingEval, null, "no eval file: nothing to start");
  assert.deepEqual([shortVersion("codex-cli 0.9.1"), shortVersion("v1.2.3-beta.1 (x)"), shortVersion("nightly")], ["0.9.1", "1.2.3-beta.1", "nightly"]);
});

function sandbox(): { root: string; bin: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "odw-drift-"));
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

/**
 * `fakecli --version` prints `<root>/version.txt` and leaves a marker; as an
 * agent it waits (at most a second) for that marker, so its version is
 * recorded before the run ends, then echoes the model it was given.
 */
function fakeCli(root: string, bin: string): void {
  const marker = join(root, "probed");
  writeFileSync(
    join(bin, "fakecli"),
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then cat '${join(root, "version.txt")}'; touch '${marker}'; exit 0; fi`,
      "cat > /dev/null",
      `i=0; while [ ! -f '${marker}' ] && [ $i -lt 50 ]; do sleep 0.02; i=$((i+1)); done`,
      'model=""; while [ $# -gt 0 ]; do if [ "$1" = "--model" ]; then model="$2"; fi; shift; done',
      'echo "answered by ${model:-default}"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "fakecli"), 0o755);
}

/** One run of workflow `wf` with the CLI at `version` and the `big` tier at `model`. */
async function runOnce(
  root: string,
  version: string,
  model: string,
  extra: Record<string, unknown> = {},
  launches?: DriftEvalLaunch[],
  dry = false,
) {
  rmSync(join(root, "probed"), { force: true });
  writeFileSync(join(root, "version.txt"), `fakecli ${version} (test)\n`);
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      adapters: { fake: { command: ["fakecli"], stdin: "{prompt}", flags: { model: ["--model"] } } },
      models: { big: { fake: model } },
      ...extra,
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('one', { adapter: 'fake', label: 'a', model: '@big' })\n");
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath, dry });
  const state = await executeRun(store.runDir(id), { startDriftEval: (launch) => launches?.push(launch) });
  assert.equal(state, "done");
  const logs = store
    .readEvents(id)
    .filter((e) => e.type === LOG)
    .map((e) => String(e.message))
    .filter((m) => m.startsWith("drift:"));
  return { store, id, logs };
}

test("drift between two runs: a new CLI version and a re-pointed model tier are logged once and on the run's summary", posix, async () => {
  const box = sandbox();
  try {
    fakeCli(box.root, box.bin);
    const first = await runOnce(box.root, "1.0.0", "m-1");
    assert.deepEqual(first.logs, [], "no earlier run: nothing to compare with");
    assert.equal(summarize(first.store, first.id).drift, undefined);
    const same = await runOnce(box.root, "1.0.0", "m-1");
    assert.deepEqual(same.logs, [], "nothing changed");

    const second = await runOnce(box.root, "1.1.0", "m-2");
    assert.equal(second.store.readResult(second.id), "answered by m-2");
    assert.deepEqual(second.logs.sort(), [
      `drift: a asks fake for model m-1 → m-2 since the last run of wf (${same.id})`,
      `drift: fake CLI 1.0.0 → 1.1.0 since the last run of wf (${same.id})`,
    ]);
    const drift = summarize(second.store, second.id).drift!;
    assert.equal(drift.since, same.id);
    assert.deepEqual(
      drift.changes.sort((x, y) => x.kind.localeCompare(y.kind)),
      [
        { kind: "cli", adapter: "fake", from: "fakecli 1.0.0 (test)", to: "fakecli 1.1.0 (test)" },
        { kind: "model", adapter: "fake", label: "a", from: "m-1", to: "m-2" },
      ],
    );
    // A dry run is not watched, and is no baseline.
    const dry = await runOnce(box.root, "2.0.0", "m-3", {}, undefined, true);
    assert.deepEqual(dry.logs, []);
    const third = await runOnce(box.root, "1.1.0", "m-2");
    assert.deepEqual(third.logs, [], "compared with the last real run, not the dry one nor the first");
  } finally {
    box.cleanup();
  }
});

test("drift with an eval file suggests the eval against its last report; driftEval starts it once the run ends", posix, async () => {
  const box = sandbox();
  try {
    fakeCli(box.root, box.bin);
    mkdirSync(join(box.root, ".odw", "evals"), { recursive: true });
    writeFileSync(join(box.root, ".odw", "evals", "wf.json"), "{}");
    await runOnce(box.root, "1.0.0", "m-1");

    // No report kept yet: run the eval as it is.
    const bare = await runOnce(box.root, "1.1.0", "m-1");
    assert.deepEqual(bare.logs.at(-1), "drift: wf has an eval, with no report kept yet — run it: odw eval wf");

    const reports = join(box.root, "runs", "_evals", "wf");
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, "20261001-000000-aaaa.json"), "{}");
    writeFileSync(join(reports, "20261017-000000-bbbb.json"), "{}");
    const last = join(reports, "20261017-000000-bbbb.json");
    const launches: DriftEvalLaunch[] = [];
    const suggested = await runOnce(box.root, "1.2.0", "m-1", {}, launches);
    assert.deepEqual(suggested.logs, [
      `drift: fake CLI 1.1.0 → 1.2.0 since the last run of wf (${bare.id})`,
      `drift: wf has an eval — check it still passes against its last report: odw eval wf --baseline ${last}`,
    ]);
    assert.deepEqual(launches, [], "only suggested without driftEval");

    const auto = await runOnce(box.root, "1.3.0", "m-1", { driftEval: true }, launches);
    assert.equal(auto.logs.at(-1), `drift: driftEval — \`odw eval wf --baseline ${last}\` starts once the run ends (its output in drift-eval.log)`);
    assert.deepEqual(launches, [
      {
        args: ["eval", "wf", "--baseline", last, "--runs-root", join(box.root, "runs"), "--config", join(box.root, "odw.config.json")],
        cwd: box.root,
        log: join(auto.store.runDir(auto.id), "drift-eval.log"),
      },
    ]);
    // No drift, no eval.
    await runOnce(box.root, "1.3.0", "m-1", { driftEval: true }, launches);
    assert.equal(launches.length, 1);
    assert.equal(existsSync(join(auto.store.runDir(auto.id), "drift-eval.log")), false, "the seam started nothing");
  } finally {
    box.cleanup();
  }
});

test("driftEval loads, defaults to false, and rejects a non-boolean", () => {
  assert.equal(defaultConfig().settings.driftEval, false);
  const dir = mkdtempSync(join(tmpdir(), "odw-drift-cfg-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify({ driftEval: "yes" }));
    assert.throws(() => loadConfig(path, { quiet: true }), /"driftEval" must be true or false/);
    writeFileSync(path, JSON.stringify({ driftEval: true }));
    assert.equal(loadConfig(path, { quiet: true }).settings.driftEval, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
