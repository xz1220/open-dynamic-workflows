import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { PassThrough } from "node:stream";

import type { WorkflowEvent } from "../src/events.js";
import { askYesNo, estimateBeforeRun } from "../src/runtime/estimate-cli.js";
import { loadEstimate } from "../src/runtime/estimate.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { startServer } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";
import { cli, until } from "./checkpoint-project.js";

// costGate and the fan-out forecast through real runs of a mock adapter that
// reports a cost, and `odw estimate` / `odw run --estimate` / GET
// /api/estimate over them.

/** Replies {"text","cost"}: the cost a prompt's COST:<usd> names, else $0.50; logs each TASK:<name>. */
const MOCK = `
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const task = /TASK:(\\S+)/.exec(input)?.[1] ?? "?";
  appendFileSync(process.argv[2], task + "\\n");
  const cost = Number(/COST:([0-9.]+)/.exec(input)?.[1] ?? "0.5");
  process.stdout.write(JSON.stringify({ text: "done:" + task, cost }));
});
`;

interface Project {
  root: string;
  store: RunStore;
  configPath: string;
  script: string;
  /** Write the workflow (meta name 'gated') and run it in-process under `config`. */
  start(body: string, config?: Record<string, unknown>): { id: string; run: Promise<string> };
  calls(): string[];
  cleanup(): Promise<void>;
}

function project(): Project {
  const root = mkdtempSync(join(tmpdir(), "odw-gate-"));
  const mock = join(root, "mock.mjs");
  writeFileSync(mock, MOCK);
  const log = join(root, "calls.log");
  const store = new RunStore(join(root, "runs"));
  const script = join(root, "gated.js");
  const configPath = join(root, "odw.config.json");
  const runs: Array<{ id: string; run: Promise<string> }> = [];
  const writeConfig = (extra: Record<string, unknown>) =>
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultAdapter: "mock",
        concurrency: 4,
        adapters: { mock: { command: [execPath, mock, log], stdin: "{prompt}", output: { format: "json", textPath: ["text"], costPath: ["cost"] } } },
        ...extra,
      }),
    );
  writeConfig({});
  return {
    root,
    store,
    configPath,
    script,
    start(body, config = {}) {
      writeConfig(config);
      writeFileSync(script, "export const meta = { name: 'gated', description: 'd' }\n" + body);
      const id = store.create({ script, args: null, source: root, configPath, workflowName: "gated" });
      const started = { id, run: executeRun(store.runDir(id)) };
      runs.push(started);
      return started;
    },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    async cleanup() {
      for (const r of runs) if (!TERMINAL_STATES.has(String(store.readStatus(r.id).state))) store.writeControl(r.id, "stop");
      await Promise.allSettled(runs.map((r) => r.run));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The history the gate reads: one run whose Work phase fanned out three $0.50 agents. */
const HISTORY = "phase('Work')\nawait parallel([1, 2, 3].map((i) => () => agent('TASK:h' + i, { label: 'w-' + i })))\nreturn 'ok'\n";

/** A fan-out of four Work agents — forecast at 4 × $0.50 = $2 — whose rejection the script catches. */
const FAN_OUT =
  "phase('Work')\n" +
  "try {\n" +
  "  const out = await parallel([1, 2, 3, 4].map((i) => () => agent('TASK:f' + i, { label: 'w-' + i })))\n" +
  "  return { ran: out }\n" +
  "} catch (e) { return { rejected: e.name, message: e.message } }\n";

const logs = (store: RunStore, id: string): WorkflowEvent[] => store.readEvents(id).filter((e) => e.type === "log");
const pending = (store: RunStore, id: string) => detail(store, id).pendingCheckpoints ?? [];

test("with no history the gate lets fan-outs through and says so once", async () => {
  const p = project();
  try {
    const body = HISTORY.replace("return 'ok'", "await pipeline([1, 2], (_, i) => agent('TASK:p' + i))\nreturn 'ok'");
    const { id, run } = p.start(body, { costGate: { usd: 0.01 } });
    assert.equal(await run, "done");
    const notes = logs(p.store, id).filter((e) => /^costGate: no forecast/.test(String(e.message)));
    assert.equal(notes.length, 1, "two fan-outs, one note");
    assert.equal(notes[0]!.message, "costGate: no forecast — no finished runs of this workflow yet, so the gate lets fan-outs through");
    assert.equal(p.store.readEvents(id).filter((e) => e.type === "checkpoint_requested").length, 0);
    assert.equal(p.calls().length, 5);
  } finally {
    await p.cleanup();
  }
});

test("a fan-out forecast over costGate waits at a checkpoint; a rejection throws a catchable CostGateRejected", async () => {
  const p = project();
  try {
    assert.equal(await p.start(HISTORY).run, "done");
    const before = p.calls().length;
    const { id, run } = p.start(FAN_OUT, { costGate: { usd: 1 } });
    await until(() => pending(p.store, id).length === 1);
    const [cp] = pending(p.store, id);
    assert.equal(cp!.title, "This fan-out is forecast to cost ~$2.000 (p90 $2.000) — go?");
    const payload = cp!.payload as { width: number; forecast: Record<string, unknown> };
    assert.equal(payload.width, 4);
    assert.equal(payload.forecast.usd, 2);
    assert.equal(payload.forecast.agents, 4);
    assert.equal(payload.forecast.basis, "phase");
    assert.equal(payload.forecast.match, "name", "another body than the history's: matched by the workflow's name");
    assert.deepEqual(payload.forecast.perAgentUsd, { p50: 0.5, p90: 0.5, n: 3 });
    // The forecast was logged before it asked.
    const forecast = logs(p.store, id).find((e) => e.forecast);
    assert.match(String(forecast!.message), /^cost forecast: parallel\(\) of 4 tasks in phase "Work" ~\$2\.000 \(p90 \$2\.000\) — 4 × \$0\.500 per agent, the median of 3 agents of 1 earlier run \(of another source\);/);

    p.store.requestCheckpointDecision(id, { action: "reject", checkpointId: 1, note: "too much", by: "cli" });
    assert.equal(await run, "done");
    const result = p.store.readResult(id) as { rejected: string; message: string };
    assert.equal(result.rejected, "CostGateRejected");
    assert.match(result.message, /^parallel\(\) of 4 tasks: its cost gate \(\$1\.000\) was rejected — too much; it did not start$/);
    assert.equal(p.calls().length, before, "no agent of the rejected fan-out ran");
    const resolved = p.store.readEvents(id).find((e) => e.type === "checkpoint_resolved");
    assert.equal(resolved!.approved, false);
  } finally {
    await p.cleanup();
  }
});

test("dry and test runs feed no estimate: 20 dry runs neither zero it nor turn costGate off (review fix)", async () => {
  const p = project();
  try {
    assert.equal(await p.start(HISTORY).run, "done");
    // Twenty dry runs of the same source and one of `odw test`'s, all newer: no model answered any of them.
    for (let i = 0; i < 21; i++) {
      const id = p.store.create({ script: p.script, args: null, source: p.root, configPath: p.configPath, workflowName: "gated", ...(i < 20 ? { dry: true } : { origin: "test" }) });
      assert.equal(await executeRun(p.store.runDir(id)), "done");
    }
    const before = p.calls().length;
    const est = loadEstimate(p.store, { workflow: "gated", sourceHash: null });
    assert.equal(est.runs.length, 1, "based on the one real run");
    assert.deepEqual(est.total!.costUsd, { p50: 1.5, p90: 1.5, n: 1 });

    const { id, run } = p.start(FAN_OUT, { costGate: { usd: 1 } });
    await until(() => pending(p.store, id).length === 1);
    assert.equal((pending(p.store, id)[0]!.payload as { forecast: { usd: number } }).forecast.usd, 2, "the gate still forecasts and asks");
    p.store.requestCheckpointDecision(id, { action: "reject", checkpointId: 1, by: "cli" });
    assert.equal(await run, "done");
    assert.equal(p.calls().length, before, "the dry runs called no model either");
  } finally {
    await p.cleanup();
  }
});

test("an approved gate runs the fan-out; under the gate, or lifted with costGate: null, nothing asks", async () => {
  const p = project();
  try {
    assert.equal(await p.start(HISTORY).run, "done");
    const approved = p.start(FAN_OUT, { costGate: { usd: 1 } });
    await until(() => pending(p.store, approved.id).length === 1);
    p.store.requestCheckpointDecision(approved.id, { action: "approve", checkpointId: 1, by: "cli" });
    assert.equal(await approved.run, "done");
    assert.deepEqual(p.store.readResult(approved.id), { ran: ["done:f1", "done:f2", "done:f3", "done:f4"] });

    // A gate the forecast stays under: logged, not asked.
    const under = p.start(FAN_OUT, { costGate: { usd: 5 } });
    assert.equal(await under.run, "done");
    const underLine = logs(p.store, under.id).find((e) => e.forecast && e.costGate === 5);
    // The approved run had the same source: it is matched first, alone.
    assert.deepEqual(
      { match: (underLine!.forecast as { match: string }).match, runs: (underLine!.forecast as { runs: number }).runs },
      { match: "sourceHash", runs: 1 },
    );
    assert.equal(p.store.readEvents(under.id).filter((e) => e.type === "checkpoint_requested").length, 0);

    // parallel(…, { costGate: null }) lifts the setting; { costGate } on the call sets one.
    const lifted = p.start(
      "phase('Work')\nconst a = await parallel([1, 2, 3, 4].map((i) => () => agent('TASK:l' + i)), { costGate: null })\n" +
        "try { await parallel([() => agent('TASK:never')], { costGate: { usd: 0.1 } }); return 'ran' } catch (e) { return [a.length, e.name] }\n",
      { costGate: { usd: 1 } },
    );
    await until(() => pending(p.store, lifted.id).length === 1);
    assert.match(pending(p.store, lifted.id)[0]!.title, /~\$0\.500/);
    p.store.requestCheckpointDecision(lifted.id, { action: "reject", by: "cli" });
    assert.equal(await lifted.run, "done");
    assert.deepEqual(p.store.readResult(lifted.id), [4, "CostGateRejected"]);
  } finally {
    await p.cleanup();
  }
});

test("an agent()'s costGate gates that agent by its label prefix; fanOutWarn alone only logs the forecast", async () => {
  const p = project();
  try {
    // History: Work agents labelled w-* cost $0.50, one labelled 'big' $3.
    assert.equal(await p.start(HISTORY).run, "done");
    const withBig = "phase('Work')\nawait parallel([1, 2, 3].map((i) => () => agent('TASK:h' + i, { label: 'w-' + i })))\nawait agent('TASK:big COST:3', { label: 'big' })\nreturn 'ok'\n";
    assert.equal(await p.start(withBig).run, "done");

    const one = p.start("phase('Work')\nreturn await agent('TASK:one', { label: 'big', costGate: { usd: 1 } })\n");
    await until(() => pending(p.store, one.id).length === 1);
    assert.equal(pending(p.store, one.id)[0]!.title, "This fan-out is forecast to cost ~$3.000 (p90 $3.000) — go?");
    assert.equal((pending(p.store, one.id)[0]!.payload as { forecast: { basis: string; label: string } }).forecast.basis, "label");
    p.store.requestCheckpointDecision(one.id, { action: "approve", by: "cli" });
    assert.equal(await one.run, "done");
    assert.equal(p.store.readResult(one.id), "done:one");

    // A label whose agents cost less passes its gate without asking.
    const small = p.start("phase('Work')\nreturn await agent('TASK:small', { label: 'w-9', costGate: { usd: 1 } })\n");
    assert.equal(await small.run, "done");
    assert.ok(logs(p.store, small.id).some((e) => /^cost forecast: agent\(\) in phase "Work" ~\$0\.500/.test(String(e.message))));

    // No gate, but as wide as fanOutWarn: the forecast is logged, nothing asks.
    const wide = p.start("phase('Work')\nawait parallel([1, 2, 3].map((i) => () => agent('TASK:x' + i)))\nreturn 1\n", { fanOutWarn: 3 });
    assert.equal(await wide.run, "done");
    const line = logs(p.store, wide.id).find((e) => e.forecast);
    assert.ok(line, "the forecast is logged");
    assert.equal(line!.costGate, undefined);
    assert.equal(p.store.readEvents(wide.id).filter((e) => e.type === "checkpoint_requested").length, 0);
    // A bad gate is the script's mistake.
    const bad = p.start("try { await agent('TASK:z', { costGate: 5 }) } catch (e) { return e.message }\n");
    assert.equal(await bad.run, "done");
    assert.match(String(p.store.readResult(bad.id)), /agent\(\): costGate must be \{ usd: <dollars> \}/);
  } finally {
    await p.cleanup();
  }
});

test("odw estimate, odw run --estimate and GET /api/estimate read the same history", async () => {
  const p = project();
  try {
    assert.equal(await p.start(HISTORY).run, "done");
    assert.equal(await p.start(HISTORY).run, "done");
    const flags = ["--config", p.configPath, "--runs-root", p.store.root];

    const json = await cli(["estimate", p.script, ...flags, "--json"]);
    assert.equal(json.code, 0, json.err);
    const est = JSON.parse(json.out);
    assert.equal(est.workflow, "gated");
    assert.equal(est.match, "sourceHash");
    assert.equal(est.runs.length, 2);
    assert.deepEqual(est.total.costUsd, { p50: 1.5, p90: 1.5, n: 2 });
    assert.deepEqual(est.phases.map((ph: { phase: string; agents: { p50: number } }) => [ph.phase, ph.agents.p50]), [["Work", 3]]);
    assert.deepEqual(est.adapters.map((a: { adapter: string }) => a.adapter), ["mock"]);

    const text = await cli(["estimate", p.script, ...flags, "--args", '{"n":1}']);
    assert.equal(text.code, 0);
    assert.match(text.out, /^estimate for gated \(2 runs, matched by source\)\n/);
    assert.match(text.out, /phase Work\s+3\s/);
    assert.match(text.out, /none of those runs had these args/);

    // Edited since: by name, and it says so.
    writeFileSync(p.script, readFileSync(p.script, "utf8") + "\n// edited\n");
    const edited = JSON.parse((await cli(["estimate", p.script, ...flags, "--json"])).out);
    assert.equal(edited.match, "name");
    assert.match(edited.notes[0], /whose source differed/);

    // A workflow with no finished runs, and one known by its name only.
    const other = join(p.root, "other.js");
    writeFileSync(other, "export const meta = { name: 'other', description: 'd' }\nreturn 1\n");
    const none = await cli(["estimate", other, ...flags]);
    assert.equal(none.code, 0);
    assert.equal(none.out, "other: no estimate: no finished runs of this workflow yet\n");
    const byName = JSON.parse((await cli(["estimate", "gated", ...flags, "--source", join(p.root, "nowhere"), "--json"])).out);
    assert.equal(byName.match, "name");
    assert.ok(byName.notes.some((n: string) => /estimated by its name alone/.test(n)));
    assert.equal((await cli(["estimate", ...flags])).code, 2);

    // odw run --estimate: no terminal and no --yes — printed, not started.
    const runs = p.store.listRuns().length;
    const refused = await cli(["run", p.script, ...flags, "--estimate"]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /estimate for gated/);
    assert.match(refused.err, /no terminal to ask on — pass --yes to start it after the estimate/);
    assert.equal(p.store.listRuns().length, runs, "no run was started");
    assert.equal((await cli(["run", p.script, ...flags, "--yes"])).code, 2, "--yes goes with --estimate");

    // On a terminal it asks; y starts it, anything else does not.
    const ask = async (answer: string) => {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      const err = Object.assign(new PassThrough(), { isTTY: true });
      let said = "";
      err.on("data", (c) => (said += String(c)));
      const go = estimateBeforeRun(p.script, { config: p.configPath, runsRoot: p.store.root }, null, false, { input, err });
      input.write(answer + "\n");
      return { go: await go, said };
    };
    const yes = await ask("y");
    assert.equal(yes.go, true);
    assert.match(yes.said, /estimate for gated[\s\S]*start the run\? \[y\/N\] /);
    const no = await ask("");
    assert.equal(no.go, false);
    assert.match(no.said, /not started/);
    const eof = new PassThrough();
    const closed = askYesNo("go? ", eof, new PassThrough());
    eof.end();
    assert.equal(await closed, false, "EOF is no");

    const handle = await startServer({ store: p.store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(p.root, "none") });
    try {
      const get = (query: string) => fetch(`${handle.url}/api/estimate${query}`);
      const res = await get("?workflow=gated");
      assert.equal(res.status, 200);
      // Matched by the newest run's source: the history runs'.
      const served = await res.json();
      assert.equal(served.match, "sourceHash");
      assert.deepEqual(served, JSON.parse(JSON.stringify(loadEstimate(p.store, { workflow: "gated", sourceHash: served.sourceHash }))));
      assert.equal((await (await get(`?workflow=gated&sourceHash=${"c".repeat(64)}`)).json()).match, "name");
      assert.equal((await (await get("?workflow=nothing-here")).json()).notes[0], "no estimate: no finished runs of this workflow yet");
      for (const query of ["", "?workflow=", "?workflow=%20", `?workflow=${"x".repeat(201)}`, "?workflow=a%00b", "?workflow=gated&sourceHash=../x"]) {
        assert.equal((await get(query)).status, 400, query);
      }
      assert.equal((await (await get("?workflow=..%2F..%2Fetc")).json()).match, null, "a name only ever picks a bucket");
    } finally {
      await handle.close();
    }
  } finally {
    await p.cleanup();
  }
});
