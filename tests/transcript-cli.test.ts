import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// `odw logs <run> --agent <id|label> [--raw] [--follow]` (ODW extension): one
// agent's transcript, readable or as kept, and followed until it settles.

const COUNTING_AGENT = fileURLToPath(new URL("./fixtures/counting-agent.mjs", import.meta.url));

// Plain output whatever the terminal: no colour, Unicode marks.
const ENV = { FORCE_COLOR: "0", LC_ALL: "C.UTF-8" };
const savedEnv: Record<string, string | undefined> = {};

/** Capture what the CLI prints, live, until `restore`. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  return {
    out: () => out.join(""),
    err: () => err.join(""),
    restore: () => {
      process.stdout.write = so;
      process.stderr.write = se;
    },
  };
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = capture();
  try {
    const code = await main(argv);
    return { code, out: io.out(), err: io.err() };
  } finally {
    io.restore();
  }
}

/** Wait until `ready()` holds (polling), or fail after `ms`. */
async function until(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

const jsonl = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const FIXER = jsonl(
  { type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-4-5", tools: ["Bash", "Edit"] },
  { type: "assistant", message: { content: [{ type: "text", text: "I'll run the tests." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 1\nnot ok 1 - adds\n", is_error: true }] } },
  { kind: "attempt", n: 2, reason: "rate_limit" },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/add.ts" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Updated src/add.ts" }] } },
  { type: "result", subtype: "success", is_error: false, num_turns: 3, result: "Fixed.", total_cost_usd: 0.25 },
);

interface Fixture {
  root: string;
  store: RunStore;
  id: string;
  flags: string[];
}
let fx: Fixture;

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

before(() => {
  for (const [key, value] of Object.entries(ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-cli-"));
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "done", name: "demo" });
  const events = [
    { ts: 1, type: "agent_started", agentId: 1, label: "fixer", phase: null, adapter: "claude" },
    { ts: 2, type: "agent_finished", agentId: 1, label: "fixer", phase: null, adapter: "claude", attempts: 1 },
    { ts: 2, type: "agent_started", agentId: 2, label: "again", phase: null, adapter: "claude", cached: true, sourceRunId: "20261001-000000-aaaaaa" },
    { ts: 2, type: "agent_finished", agentId: 2, label: "again", phase: null, adapter: "claude", attempts: 1, cached: true, sourceRunId: "20261001-000000-aaaaaa" },
    { ts: 3, type: "agent_started", agentId: 3, label: "plain", phase: null, adapter: "gemini" },
    { ts: 4, type: "agent_failed", agentId: 3, label: "plain", phase: null, error: "exit 1" },
    { ts: 4, type: "agent_started", agentId: 4, label: "dup", phase: null, adapter: "gemini" },
    { ts: 5, type: "agent_finished", agentId: 4, label: "dup", phase: null, adapter: "gemini", attempts: 1 },
    { ts: 5, type: "agent_started", agentId: 5, label: "dup", phase: null, adapter: "gemini" },
    { ts: 6, type: "agent_finished", agentId: 5, label: "dup", phase: null, adapter: "gemini", attempts: 1 },
    { ts: 6, type: "agent_started", agentId: 6, label: "old", phase: null, adapter: "gemini" },
    { ts: 7, type: "agent_finished", agentId: 6, label: "old", phase: null, adapter: "gemini", attempts: 1 },
    { ts: 8, type: "run_finished", runId: id },
  ];
  for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  store.writeAgentResult(id, {
    agentId: 2,
    key: "k",
    label: "again",
    phase: null,
    adapter: "claude",
    attempts: 1,
    startedAt: 2,
    finishedAt: 2,
    value: "v",
    cached: true,
    sourceRunId: "20261001-000000-aaaaaa",
  });
  write(store.agentTranscriptPaths(id, 1).transcript, FIXER);
  const plain = store.agentTranscriptPaths(id, 3);
  write(plain.transcript, jsonl({ kind: "text", text: "Plan:\n" }, { kind: "text", text: "  1. read \u001b[31mthe\u001b[0m code\n" }));
  write(plain.stderr, Array.from({ length: 25 }, (_, i) => `warning ${i + 1}`).join("\n") + "\n");
  fx = { root, store, id, flags: ["--runs-root", store.root] };
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fx) rmSync(fx.root, { recursive: true, force: true });
});

test("odw logs --agent prints the transcript readably: text, calls, results, retries, the end", async () => {
  const { code, out, err } = await cli(["logs", fx.id, "--agent", "fixer", ...fx.flags]);
  assert.equal(code, 0, err);
  assert.equal(
    out,
    [
      "· model claude-sonnet-4-5 · 2 tools: Bash, Edit",
      "I'll run the tests.",
      "▸ Bash  npm test",
      "✗ Bash error (exit 1, 2 lines): not ok 1 - adds",
      "── attempt 2: rate-limit retry ──",
      "▸ Edit  src/add.ts",
      "✓ Edit result (1 line)",
      "■ done · 3 turns · $0.250",
      "",
    ].join("\n"),
  );
  assert.equal(err, "");
});

test("odw logs --agent --raw prints the lines as they were kept; by id works as by label", async () => {
  const raw = await cli(["logs", fx.id, "--agent", "1", "--raw", ...fx.flags]);
  assert.equal(raw.code, 0, raw.err);
  assert.equal(raw.out, FIXER);
});

test("a text adapter's transcript reads as its output, sanitized, followed by the end of its stderr", async () => {
  const { code, out } = await cli(["logs", fx.id, "--agent", "3", ...fx.flags]);
  assert.equal(code, 0);
  const stderrPath = fx.store.agentTranscriptPaths(fx.id, 3).stderr;
  assert.equal(
    out,
    [
      "Plan:",
      "  1. read the code",
      `── stderr (last 20 of 25 lines; all: ${stderrPath}) ──`,
      ...Array.from({ length: 20 }, (_, i) => `warning ${i + 6}`),
      "",
    ].join("\n"),
  );
});

test("odw logs --agent says why there is nothing to show, and refuses what it cannot", async () => {
  const replayed = await cli(["logs", fx.id, "--agent", "again", ...fx.flags]);
  assert.equal(replayed.code, 0);
  assert.equal(replayed.out, "");
  assert.equal(
    replayed.err,
    'agent 2 (again) was replayed by odw resume: no CLI ran, so it has no transcript — the run that ran it: odw logs 20261001-000000-aaaaaa --agent "again"\n',
  );

  const old = await cli(["logs", fx.id, "--agent", "old", ...fx.flags]);
  assert.equal(old.code, 0);
  assert.equal(old.err, "agent 6 (old) has no transcript: this run kept none (it predates agent transcripts, or maxTranscriptBytes is 0)\n");

  const dup = await cli(["logs", fx.id, "--agent", "dup", ...fx.flags]);
  assert.equal(dup.code, 1);
  assert.match(dup.err, /label 'dup' matches 2 agents of run .*: 4 \(done\), 5 \(done\) — pick one: odw logs .* --agent <id>/);

  const unknown = await cli(["logs", fx.id, "--agent", "nope", ...fx.flags]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /has no agent 'nope'/);

  const rawAlone = await cli(["logs", fx.id, "--raw", ...fx.flags]);
  assert.equal(rawAlone.code, 2);
  assert.match(rawAlone.err, /--raw prints an agent's transcript as kept — name the agent with --agent <id\|label>/);
});

test("odw logs --agent --follow prints what the agent adds and ends when it settles", async () => {
  const { store } = fx;
  const id = store.create({ script: "/demo/live.js", args: null, source: "/demo" });
  // A live run: its worker is this very process.
  store.updateStatus(id, { state: "running", pid: process.pid });
  appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 1, type: "agent_started", agentId: 1, label: "live", phase: null }) + "\n");
  const path = store.agentTranscriptPaths(id, 1).transcript;
  write(path, jsonl({ kind: "text", text: "first\n" }));

  const io = capture();
  try {
    const following = main(["logs", id, "--agent", "live", "--follow", ...fx.flags]);
    await until(() => io.out().includes("first\n"), "the first line");
    appendFileSync(path, jsonl({ kind: "text", text: "second\n" }) + '{"kind":"text","text":"still being writ');
    await until(() => io.out().includes("second\n"), "the second line");
    appendFileSync(path, 'ten"}\n');
    appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 2, type: "agent_failed", agentId: 1, label: "live", phase: null, error: "boom" }) + "\n");
    const code = await following;
    assert.equal(code, 1, "following an agent that failed exits 1");
    assert.equal(io.out(), "first\nsecond\nstill being written\n");
  } finally {
    io.restore();
  }
});

test("end to end: an agent that failed before its CLI started has an empty transcript, and odw logs says why", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-nocli-")); // not a git repository
  try {
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ defaultAdapter: "count", adapters: { count: { command: [execPath, COUNTING_AGENT, join(root, "calls.log")], stdin: "{prompt}" } } }),
    );
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('TASK:x', { isolation: 'worktree', label: 'iso' })\n");
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.equal(existsSync(join(root, "calls.log")), false, "its CLI never ran");
    assert.equal(readFileSync(store.agentTranscriptPaths(id, 1).transcript, "utf8"), "");

    const { code, out, err } = await cli(["logs", id, "--agent", "iso", "--runs-root", store.root]);
    assert.equal(code, 0);
    assert.equal(out, "");
    assert.match(err, /^agent 1 \(iso\) printed nothing on stdout; it failed: .*isolation "worktree" needs a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: odw logs --agent --follow tails a running agent of a real run until it finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-follow-"));
  try {
    const calls = join(root, "calls.log");
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ defaultAdapter: "count", adapters: { count: { command: [execPath, COUNTING_AGENT, calls], stdin: "{prompt}" } } }),
    );
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('TASK:block1', { label: 'slow' })\n");
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    const run = executeRun(store.runDir(id));
    // The transcript is there from the start of the agent's CLI run.
    await until(() => existsSync(store.agentTranscriptPaths(id, 1).transcript) && existsSync(calls), "the agent to start");

    const io = capture();
    let code: number;
    try {
      const following = main(["logs", id, "--agent", "slow", "--follow", "--runs-root", store.root]);
      writeFileSync(`${calls}.release`, "");
      code = await following;
    } finally {
      io.restore();
    }
    assert.equal(await run, "done");
    assert.equal(code, 0, io.err());
    assert.equal(io.out(), "done:block1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
