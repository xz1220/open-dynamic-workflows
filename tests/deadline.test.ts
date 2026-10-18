import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { main } from "../src/cli.js";
import { DEADLINE_EXIT_CODE, deadlineReport, parseDeadline, stoppedByDeadline } from "../src/runtime/deadline.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

// `odw run --deadline <s>` (ODW extension; src/runtime/deadline.ts): the
// worker STOPS the run once its deadline passes — stopped, finished agents
// kept — and --wait prints what finished and exits 3; --timeout only stops
// waiting.

/** An agent CLI that answers at once, unless its prompt says "slow": then it never does. */
const AGENT =
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
  "if(d.includes('slow'))setInterval(()=>{},1000);else process.stdout.write('quick reply')})";

const WORKFLOW = `export const meta = { name: 'deadline-demo', description: 'x' }
const quick = await agent('answer at once', { label: 'quick' })
const slow = await agent('slow: take forever', { label: 'slow' })
return { quick, slow }
`;

function project(): { root: string; config: string; wf: string; runs: string } {
  const root = mkdtempSync(join(tmpdir(), "odw-deadline-"));
  const config = join(root, "odw.config.json");
  writeFileSync(config, JSON.stringify({ adapters: { mock: { command: [execPath, "-e", AGENT], stdin: "{prompt}" } }, defaultAdapter: "mock" }));
  const wf = join(root, "wf.js");
  writeFileSync(wf, WORKFLOW);
  return { root, config, wf, runs: join(root, "runs") };
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("--deadline: the worker stops the run, keeps what finished; --wait prints it and exits 3", async () => {
  const p = project();
  try {
    const r = await cli(["run", p.wf, "--wait", "--deadline", "2", "--config", p.config, "--runs-root", p.runs]);
    assert.equal(r.code, DEADLINE_EXIT_CODE, r.err);
    assert.equal(DEADLINE_EXIT_CODE, 3);
    const report = JSON.parse(r.out) as { state: string; reason: string; deadline: number; finished: Array<{ label: string; value: unknown }> };
    assert.equal(report.state, "stopped");
    assert.equal(report.reason, "deadline");
    assert.equal(report.deadline, 2);
    assert.deepEqual(report.finished.map((a) => [a.label, a.value]), [["quick", "quick reply"]]);
    assert.match(r.err, /stopped at its deadline \(--deadline 2\)/);

    const store = new RunStore(p.runs);
    const runId = store.listRunIds()[0]!;
    const status = store.readStatus(runId);
    assert.equal(status.state, "stopped");
    assert.equal(status.stopReason, "deadline");
    assert.deepEqual(store.readMeta(runId).deadline, { seconds: 2, at: (store.readMeta(runId).createdAt as number) + 2 });
    assert.equal(store.hasResult(runId), false, "a stopped run has no result.json: its finished agents are its result");
    const events = store.readEvents(runId);
    assert.ok(events.some((e) => e.type === "log" && /deadline \(--deadline 2\) passed/.test(String(e.message))));
    assert.equal(events.at(-1)?.type, "run_stopped");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("--deadline must be a positive number of seconds", async () => {
  const p = project();
  try {
    for (const bad of ["0", "-5", "soon", ""]) {
      const r = await cli(["run", p.wf, "--detach", `--deadline=${bad}`, "--config", p.config, "--runs-root", p.runs]);
      assert.equal(r.code, 2, bad);
      assert.match(r.err, /--deadline must be a positive number of seconds/);
    }
    assert.equal(parseDeadline("1.5"), 1.5);
    assert.equal(parseDeadline("Infinity"), null);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a deadline that does not pass changes nothing; one already past stops the run at its start", async () => {
  const p = project();
  try {
    const store = new RunStore(p.runs);
    const quickWf = join(p.root, "quick.js");
    writeFileSync(quickWf, "export const meta = { name: 'q', description: 'x' }\nreturn await agent('answer at once')\n");
    const roomy = store.create({ script: quickWf, args: null, source: p.root, configPath: p.config, deadlineSeconds: 600 });
    assert.equal(await executeRun(store.runDir(roomy)), "done");
    assert.equal(store.readStatus(roomy).stopReason, undefined);
    assert.equal(store.readResult(roomy), "quick reply");

    const late = store.create({ script: p.wf, args: null, source: p.root, configPath: p.config, deadlineSeconds: 0.001 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await executeRun(store.runDir(late)), "stopped");
    const status = store.readStatus(late);
    assert.ok(stoppedByDeadline(status));
    assert.deepEqual((deadlineReport(store, late).finished as unknown[]).length, 0);
    assert.equal(stoppedByDeadline({ state: "stopped" }), false, "a stop by a person is not a deadline");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

/** An agent CLI that writes partial.txt in its working directory, then never answers. */
const EDIT_THEN_HANG =
  "require('node:fs').writeFileSync('partial.txt','half done\\n');process.stdin.resume();setInterval(()=>{},1000)";

/** A git repository to run isolated agents over, and a config whose agent edits then hangs. */
function isolatedProject(): { root: string; repo: string; config: string; wf: string; runs: string } {
  const root = mkdtempSync(join(tmpdir(), "odw-deadline-iso-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init"]);
  const config = join(root, "odw.config.json");
  writeFileSync(config, JSON.stringify({ adapters: { mock: { command: [execPath, "-e", EDIT_THEN_HANG], stdin: "{prompt}" } }, defaultAdapter: "mock" }));
  const wf = join(root, "wf.js");
  writeFileSync(wf, "export const meta = { name: 'iso', description: 'x' }\nreturn await agent('edit', { label: 'worker', isolation: 'worktree' })\n");
  return { root, repo, config, wf, runs: join(root, "runs") };
}

test("--deadline keeps an isolated agent's partial diff, marked partial; a person's stop keeps none (review fix)", { skip: process.platform === "win32" }, async () => {
  const p = isolatedProject();
  try {
    const store = new RunStore(p.runs);
    const id = store.create({ script: p.wf, args: null, source: p.repo, configPath: p.config, deadlineSeconds: 1.5 });
    assert.equal(await executeRun(store.runDir(id)), "stopped");
    assert.ok(stoppedByDeadline(store.readStatus(id)));
    const failed = store.readEvents(id).find((e) => e.type === "agent_failed");
    assert.ok(failed, "the killed agent settled");
    assert.equal(failed.partial, true);
    assert.deepEqual(failed.changes, { files: 1, insertions: 1, deletions: 0, truncated: false });
    const diff = readFileSync(store.agentDiffPath(id, 1), "utf8");
    assert.match(diff, /^\+\+\+ b\/partial\.txt$/m);
    assert.match(diff, /^\+half done$/m);
    const agent = detail(store, id).agents.find((a) => a.agentId === 1);
    assert.equal(agent?.partial, true);
    assert.equal(agent?.changes?.files, 1);

    // The same agent stopped by a person: its work is thrown away, as before.
    const stopped = store.create({ script: p.wf, args: null, source: p.repo, configPath: p.config });
    const run = executeRun(store.runDir(stopped));
    const until = Date.now() + 15_000;
    while (!store.readEvents(stopped).some((e) => e.type === "agent_started") && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500)); // its CLI has written the file by now
    store.writeControl(stopped, "stop");
    assert.equal(await run, "stopped");
    const settled = store.readEvents(stopped).find((e) => e.type === "agent_failed");
    assert.equal(settled?.partial, undefined);
    assert.equal(settled?.changes, undefined);
    assert.equal(existsSync(store.agentDiffPath(stopped, 1)), false);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});
