import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { main } from "../src/cli.js";
import { compareRuns, readCompareRun } from "../src/runtime/compare.js";
import { planReplay, REPLAY_WORKFLOW, ReplayError } from "../src/runtime/replay.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

// `odw replay <run> --agent <id|label>` (ODW extension): one saved agent()
// call dispatched again as a new run — a text agent, a schema agent and an
// isolated one (at the commit the original saw), with --prompt, --adapter and
// --model — and `odw compare` matching the replay to its original.

/**
 * The mock CLI: argv[2] is its adapter's tag. A prompt with a schema gets a
 * verdict; `READ` gets base.txt of its working directory; anything else
 * `<tag>|<model>|<the TASK line>`.
 */
const MOCK = `import { readFileSync } from "node:fs";
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  const tag = process.argv[2];
  const m = process.argv.indexOf("--model");
  const model = m >= 0 ? process.argv[m + 1] : "-";
  if (d.includes("JSON Schema:")) return process.stdout.write(JSON.stringify({ verdict: "pass", tag }));
  if (d.includes("READ")) return process.stdout.write("base:" + readFileSync("base.txt", "utf8").trim());
  process.stdout.write(tag + "|" + model + "|" + ((d.match(/TASK[^\\n]*/) || [""])[0]));
});
`;

const WORKFLOW = `export const meta = { name: 'rp', description: 'replay me', phases: [{ title: 'Plan' }, { title: 'Judge' }] }
phase('Plan')
const plan = await agent('TASK plan ' + args.topic, { label: 'plan' })
const twins = await parallel([() => agent('TASK twin one', { label: 'twin' }), () => agent('TASK twin two', { label: 'twin' })])
phase('Judge')
const verdict = await agent('TASK judge', {
  label: 'judge',
  schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' }, tag: { type: 'string' } } },
})
const seen = await agent('READ the base', { label: 'reader', isolation: 'worktree' })
return { plan, twins, verdict, seen }
`;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
}

interface Fixture {
  root: string;
  repo: string;
  store: RunStore;
  configPath: string;
  runId: string;
}

async function original(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "odw-replay-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "base.txt"), "v1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--no-gpg-sign", "-m", "v1");
  const mock = join(root, "mock.mjs");
  writeFileSync(mock, MOCK);
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "main",
      adapters: {
        main: { command: [execPath, mock, "main"], stdin: "{prompt}", flags: { model: ["--model"] } },
        alt: { command: [execPath, mock, "alt"], stdin: "{prompt}", flags: { model: ["--model"] } },
      },
    }),
  );
  const script = join(root, "rp.js");
  writeFileSync(script, WORKFLOW);
  const store = new RunStore(join(root, "runs"));
  const runId = store.create({ script, args: { topic: "auth" }, source: repo, configPath });
  assert.equal(await executeRun(store.runDir(runId)), "done");
  return { root, repo, store, configPath, runId };
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** `odw replay … --wait`: the new run's id (the one run that is not `known`) and what the CLI said. */
async function replay(f: Fixture, ...args: string[]): Promise<{ id: string; code: number; out: string; err: string }> {
  const known = new Set(f.store.listRunIds());
  const r = await cli(["replay", f.runId, ...args, "--wait", "--timeout", "60", "--runs-root", f.store.root]);
  const id = f.store.listRunIds().find((runId) => !known.has(runId)) ?? "";
  return { id, ...r };
}

const startedOf = (store: RunStore, runId: string) => store.readEvents(runId).filter((ev) => ev.type === "agent_started");

test("every agent() call is saved as it starts — prompt, options, adapter, model — and an isolated one's base is on agent_started", async () => {
  const f = await original();
  try {
    const head = git(f.repo, "rev-parse", "HEAD").trim();
    const call = f.store.readAgentCall(f.runId, 1);
    assert.deepEqual(call, {
      agentId: 1,
      label: "plan",
      phase: "Plan",
      prompt: "TASK plan auth",
      adapter: "main",
      model: null,
      options: { label: "plan" },
    });
    const reader = startedOf(f.store, f.runId).find((ev) => ev.label === "reader")!;
    assert.equal(reader.base, head);
    assert.equal(f.store.readAgentCall(f.runId, reader.agentId as number)?.base, head);
    // Only an isolated agent names a base.
    assert.equal(startedOf(f.store, f.runId).find((ev) => ev.label === "plan")!.base, undefined);
    // The call file is no saved result: odw result / agents / bundles do not list it.
    assert.equal(f.store.listAgentResults(f.runId).length, 5);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("odw replay re-dispatches a text agent as a small new run, linked to its original, and odw compare matches the two", async () => {
  const f = await original();
  try {
    const r = await replay(f, "--agent", "plan");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "main|-|TASK plan auth");
    assert.match(r.err, new RegExp(`replaying agent 1 \\(plan\\) of ${f.runId}`));
    assert.ok(r.err.includes(`compare it with the original: odw compare ${f.runId} ${r.id} --agent plan --runs-root ${f.store.root}`), r.err);
    const meta = f.store.readMeta(r.id);
    assert.equal(meta.origin, "replay");
    assert.deepEqual(meta.replayOf, { runId: f.runId, agentId: 1, label: "plan" });
    // The prompt is kept out of meta.json — whose args are served — in the run's call.json (review fix).
    assert.deepEqual(meta.args, { replayOf: { runId: f.runId, agentId: 1, label: "plan" } });
    assert.deepEqual(f.store.readRunCall(r.id), { prompt: "TASK plan auth", options: { label: "plan", phase: "Plan", adapter: "main" } });
    assert.deepEqual(detail(f.store, r.id).args, meta.args);
    assert.doesNotMatch(JSON.stringify(detail(f.store, r.id)), /TASK plan auth/, "the run's detail does not carry the prompt");
    const [started] = startedOf(f.store, r.id);
    assert.equal(started!.label, "plan");
    assert.equal(started!.phase, "Plan");

    const cmp = compareRuns(readCompareRun(f.store, f.runId), readCompareRun(f.store, r.id));
    const row = cmp.agents.find((a) => a.a?.label === "plan")!;
    assert.equal(row.match, "label");
    assert.equal(row.b?.agentId, 1);
    assert.equal(row.reply.status, "identical");
    assert.ok(cmp.notes.some((n) => n.includes(`run B replays agent 1 of run A (odw replay)`)), cmp.notes.join("\n"));
    const c = await cli(["compare", f.runId, r.id, "--agent", "plan", "--json", "--runs-root", f.store.root]);
    assert.equal(c.code, 0, c.err);
    assert.equal(JSON.parse(c.out).b.agentId, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("odw replay of a schema agent validates its reply again and returns the object", async () => {
  const f = await original();
  try {
    const r = await replay(f, "--agent", "judge");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { verdict: "pass", tag: "main" });
    const opts = f.store.readAgentCall(r.id, 1)!.options;
    assert.equal(opts.label, "judge");
    assert.equal(opts.phase, "Judge");
    assert.deepEqual((opts.schema as { required: string[] }).required, ["verdict"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("odw replay of an isolated agent checks out the commit the original started from, not today's HEAD", async () => {
  const f = await original();
  try {
    const base = git(f.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(f.repo, "base.txt"), "v2\n");
    git(f.repo, "commit", "-q", "--no-gpg-sign", "-am", "v2");
    assert.equal(f.store.readResult(f.runId) && (f.store.readResult(f.runId) as { seen: string }).seen, "base:v1");
    const r = await replay(f, "--agent", "reader");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "base:v1");
    assert.match(r.err, new RegExp(`worktree: at the commit the original started from, ${base.slice(0, 12)}`));
    assert.equal(startedOf(f.store, r.id)[0]!.base, base);
    assert.equal((f.store.readMeta(r.id).replayOf as { base?: string }).base, base);
    // odw rerun of a replay replays it again, at the same commit.
    const known = new Set(f.store.listRunIds());
    const again = await cli(["rerun", r.id, "--wait", "--timeout", "60", "--runs-root", f.store.root]);
    assert.equal(again.code, 0, again.err);
    assert.equal(JSON.parse(again.out), "base:v1");
    const rerunId = f.store.listRunIds().find((id) => !known.has(id))!;
    assert.deepEqual(f.store.readMeta(rerunId).replayOf, f.store.readMeta(r.id).replayOf);
    // A base the repository does not have fails the replay with the reason — never today's HEAD in its place.
    const reader = startedOf(f.store, f.runId).find((ev) => ev.label === "reader")!.agentId as number;
    const plan = planReplay(f.store, f.runId, reader);
    const gone = f.store.create({
      script: "",
      inlineSource: REPLAY_WORKFLOW,
      args: plan.args,
      source: f.repo,
      configPath: f.configPath,
      origin: "replay",
      replayOf: { ...plan.link, base: "0".repeat(40) },
    });
    assert.equal(await executeRun(f.store.runDir(gone)), "failed");
    assert.match(String(f.store.readError(gone)?.error), /the worktree base 0{40} is not a commit of the repository/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("--prompt @file|TEXT, --adapter and --model replace the original's, and say so", async () => {
  const f = await original();
  try {
    const promptFile = join(f.root, "prompt.txt");
    writeFileSync(promptFile, "TASK plan it better\n");
    let r = await replay(f, "--agent", "plan", "--prompt", `@${promptFile}`, "--adapter", "alt", "--model", "big-1");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "alt|big-1|TASK plan it better");
    assert.match(r.err, /adapter: alt \(the original ran on main\)/);
    assert.match(r.err, /model: big-1 \(the original asked for the adapter's default\)/);
    assert.match(r.err, /prompt: replaced \(20 characters; the original had 14\)/);
    r = await replay(f, "--agent", "plan", "--prompt", "TASK inline prompt");
    assert.equal(JSON.parse(r.out), "main|-|TASK inline prompt");
    // An adapter the config lacks fails before any run starts.
    const before = f.store.listRunIds().length;
    r = await replay(f, "--agent", "plan", "--adapter", "nope");
    assert.equal(r.code, 1);
    assert.match(r.err, /nope/);
    assert.equal(f.store.listRunIds().length, before);
    r = await replay(f, "--agent", "plan", "--prompt", "@" + join(f.root, "missing.txt"));
    assert.equal(r.code, 1);
    assert.match(r.err, /--prompt @.*missing\.txt: cannot read it/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a label two agents share is replayed by id; compare is pointed at the id and pairs the replay with that agent", async () => {
  const f = await original();
  try {
    let r = await replay(f, "--agent", "twin");
    assert.equal(r.code, 1);
    assert.match(r.err, /label 'twin' matches 2 agents/);
    r = await replay(f, "--agent", "3");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "main|-|TASK twin two");
    assert.ok(r.err.includes(`odw compare ${f.runId} ${r.id} --agent 3 `), r.err);
    const cmp = compareRuns(readCompareRun(f.store, f.runId), readCompareRun(f.store, r.id));
    const paired = cmp.agents.filter((row) => row.a && row.b);
    assert.equal(paired.length, 1);
    assert.equal(paired[0]!.a!.agentId, 3);
    assert.equal(paired[0]!.match, "label");
    const c = await cli(["compare", f.runId, r.id, "--agent", "3", "--json", "--runs-root", f.store.root]);
    assert.equal(c.code, 0, c.err);
    assert.equal(JSON.parse(c.out).reply.status, "identical");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a replay of a triggered run with untrusted input keeps both: its untrustedInput and its strict script context (review fix)", async () => {
  const f = await original();
  try {
    // approve: false — the mock adapter has no read-only flags, so its agents may write and would wait for a go.
    const untrustedInput = { why: "trigger:issue", args: ["topic"], approve: false };
    const triggered = f.store.create({
      script: join(f.root, "rp.js"),
      args: { topic: "auth" },
      source: f.repo,
      configPath: f.configPath,
      origin: "trigger",
      untrustedInput,
    });
    assert.equal(await executeRun(f.store.runDir(triggered)), "done");
    const plan = planReplay(f.store, triggered, 1);
    assert.deepEqual(plan.start.untrustedInput, untrustedInput);
    assert.equal(plan.start.sourceOrigin, "trigger");
    const known = new Set(f.store.listRunIds());
    const r = await cli(["replay", triggered, "--agent", "plan", "--wait", "--timeout", "60", "--runs-root", f.store.root]);
    assert.equal(r.code, 0, r.err);
    const id = f.store.listRunIds().find((runId) => !known.has(runId))!;
    const meta = f.store.readMeta(id);
    assert.equal(meta.origin, "replay");
    assert.deepEqual(meta.untrustedInput, untrustedInput, "the args the original's input covered, not { replayOf }");
    assert.equal(meta.sourceOrigin, "trigger");
    assert.equal(f.store.readStatus(id).scriptContext, "strict");
    // Its agents ran under the tier the original's did.
    assert.equal(startedOf(f.store, id)[0]!.permissions, startedOf(f.store, triggered)[0]!.permissions);
    // A replay of the user's own run: neither.
    const own = planReplay(f.store, f.runId, 1);
    assert.equal(own.start.untrustedInput, null);
    assert.equal(own.start.sourceOrigin, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an agent with no saved call cannot be replayed, and says why", async () => {
  const f = await original();
  try {
    unlinkSync(join(f.store.runDir(f.runId), "agents", "1.call.json"));
    assert.throws(() => planReplay(f.store, f.runId, 1), (err: unknown) => err instanceof ReplayError && /no saved call to replay/.test(err.message));
    const r = await cli(["replay", f.runId, "--agent", "plan", "--runs-root", f.store.root]);
    assert.equal(r.code, 1);
    assert.match(r.err, /odw replay: agent 1 of run .* has no saved call to replay .*odw rerun/);
    assert.equal((await cli(["replay", f.runId, "--runs-root", f.store.root])).code, 2, "--agent is required");
    assert.equal((await cli(["replay", "no-such-run", "--agent", "plan", "--runs-root", f.store.root])).code, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
