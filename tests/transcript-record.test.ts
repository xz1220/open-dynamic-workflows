import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge, type TranscriptSink } from "../src/bridge.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";
import { STDERR_TAIL_CHARS, TRANSCRIPT_FIELD_BYTES, TranscriptRecorder, type TranscriptPaths } from "../src/transcript.js";

// Keeping each agent's transcript as it runs (ODW extension): the recorder on
// its own, the bridge telling it why each further CLI run happens, and whole
// runs through the worker with mock CLIs.

const MOCK_AGENT = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

const cli = (fields: Partial<CliResult> = {}): CliResult => ({
  returncode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  duration: 0.1,
  ...fields,
});

function scratch(): { dir: string; paths: TranscriptPaths } {
  const dir = mkdtempSync(join(tmpdir(), "odw-transcript-"));
  return { dir, paths: { transcript: join(dir, "agents", "1.transcript.jsonl"), stderr: join(dir, "agents", "1.stderr.txt") } };
}

const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter(Boolean);

// --- the recorder -----------------------------------------------------------------

test("a JSONL adapter's events are kept a line each, as received; blank lines are not", async () => {
  const { dir, paths } = scratch();
  try {
    const recorder = new TranscriptRecorder({ ...paths, format: "jsonl", maxBytes: 1 << 20 });
    recorder.beginRun();
    recorder.stdout('{"type":"system","subtype":"init"}\n{"type":"assi');
    recorder.stdout('stant","message":{}}\n\n  \n');
    recorder.stdout("Debugger attached.\r\n");
    recorder.stdout('{"type":"result","result":"ok"}'); // the last event, unterminated
    // Nothing is written on the hot path: the writer is asynchronous.
    assert.equal(existsSync(paths.transcript), false);
    recorder.endRun(cli({ stderr: "warning: slow\n" }));
    await recorder.close();
    assert.equal(
      readFileSync(paths.transcript, "utf8"),
      '{"type":"system","subtype":"init"}\n{"type":"assistant","message":{}}\nDebugger attached.\r\n{"type":"result","result":"ok"}\n',
    );
    assert.equal(readFileSync(paths.stderr, "utf8"), "warning: slow\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("any other adapter's output is kept as text lines — a long line in 4 KB pieces — that add up to it", async () => {
  const { dir, paths } = scratch();
  try {
    const recorder = new TranscriptRecorder({ ...paths, format: "text", maxBytes: 1 << 20 });
    const printed = ["Plan:\n  1. re", "ad\n", "x".repeat(5000), "字".repeat(3000) + "\n\nend"];
    recorder.beginRun();
    for (const chunk of printed) recorder.stdout(chunk);
    recorder.endRun(cli());
    await recorder.close();
    const kept = lines(paths.transcript).map((line) => JSON.parse(line) as { kind: string; text: string });
    assert.ok(kept.every((line) => line.kind === "text"));
    assert.equal(kept.map((line) => line.text).join(""), printed.join(""));
    assert.deepEqual(
      kept.slice(0, 2).map((line) => line.text),
      ["Plan:\n", "  1. read\n"],
    );
    assert.ok(kept.every((line) => Buffer.byteLength(line.text) <= TRANSCRIPT_FIELD_BYTES));
    assert.ok(kept.length > 5, "the long line came in pieces");
    assert.equal(kept[kept.length - 1]!.text, "end", "the unterminated last line, as printed");
    assert.equal(existsSync(paths.stderr), false, "no stderr, no stderr file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each further CLI run goes on in the same files after an attempt line saying why", async () => {
  const { dir, paths } = scratch();
  try {
    const recorder = new TranscriptRecorder({ ...paths, format: "text", maxBytes: 1 << 20 });
    recorder.beginRun();
    recorder.stdout("not json\n");
    recorder.endRun(cli({ stderr: "first run's warning" }));
    recorder.beginRun("schema");
    recorder.endRun(cli({ stalled: true, returncode: -1 }));
    recorder.beginRun("stall");
    recorder.endRun(cli({ returncode: 1, stderr: "429 Too Many Requests\n" }));
    recorder.beginRun("rate_limit");
    recorder.stdout('{"ok":true}');
    recorder.endRun(cli());
    await recorder.close();
    assert.deepEqual(lines(paths.transcript).map((line) => JSON.parse(line)), [
      { kind: "text", text: "not json\n" },
      { kind: "attempt", n: 2, reason: "schema" },
      { kind: "attempt", n: 3, reason: "stall" },
      { kind: "attempt", n: 4, reason: "rate_limit" },
      { kind: "text", text: '{"ok":true}' },
    ]);
    assert.equal(
      readFileSync(paths.stderr, "utf8"),
      "first run's warning\n--- attempt 3: stall restart ---\n429 Too Many Requests\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("past maxTranscriptBytes nothing more is kept but one truncation line, cut at a line", async () => {
  const { dir, paths } = scratch();
  try {
    const event = (n: number): string => `{"type":"assistant","n":"${String(n).padStart(3, "0")}"}\n`; // 31 bytes
    const recorder = new TranscriptRecorder({ ...paths, format: "jsonl", maxBytes: 100 });
    recorder.beginRun();
    for (let n = 0; n < 10; n++) recorder.stdout(event(n));
    recorder.endRun(cli());
    recorder.beginRun("schema"); // nothing more after the cut, not even an attempt line
    recorder.stdout(event(99));
    recorder.endRun(cli());
    await recorder.close();
    const truncated = JSON.stringify({ kind: "truncated", bytes: 3 * Buffer.byteLength(event(0)) });
    assert.deepEqual(lines(paths.transcript), [event(0), event(1), event(2), truncated].map((l) => l.trimEnd()));
    assert.equal(truncated, '{"kind":"truncated","bytes":93}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an event that can no longer fit ends the transcript at once instead of being held in memory", async () => {
  const { dir, paths } = scratch();
  try {
    const recorder = new TranscriptRecorder({ ...paths, format: "jsonl", maxBytes: 1000 });
    recorder.beginRun();
    recorder.stdout('{"type":"user","message":{"content":"');
    recorder.stdout("y".repeat(2000)); // no newline yet: it cannot fit whatever follows
    recorder.stdout('"}}\n{"type":"result"}\n');
    recorder.endRun(cli());
    await recorder.close();
    assert.equal(readFileSync(paths.transcript, "utf8"), '{"kind":"truncated","bytes":0}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stderr file keeps the last 64 KB, rewritten as stderr arrives", async () => {
  const { dir, paths } = scratch();
  try {
    const recorder = new TranscriptRecorder({ ...paths, format: "text", maxBytes: 1 << 20 });
    recorder.beginRun();
    for (let i = 0; i < 30; i++) recorder.stderr(`${String(i).padStart(2, "0")}${"e".repeat(4000)}\n`);
    recorder.stderr("the last line\n");
    await recorder.close(); // the CLI never ended (a stop): what was seen is still kept
    const kept = readFileSync(paths.stderr, "utf8");
    assert.equal(kept.length, STDERR_TAIL_CHARS);
    assert.ok(kept.endsWith("e\nthe last line\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runner that does not stream hands over its whole stdout at the end; a write that fails is noted once", async () => {
  const { dir, paths } = scratch();
  try {
    const recorder = new TranscriptRecorder({ ...paths, format: "text", maxBytes: 1 << 20 });
    recorder.beginRun();
    recorder.endRun(cli({ stdout: "the whole reply", stderr: "failed to launch 'nope': spawn nope ENOENT" }));
    await recorder.close();
    assert.equal(readFileSync(paths.transcript, "utf8"), '{"kind":"text","text":"the whole reply"}\n');
    assert.equal(readFileSync(paths.stderr, "utf8"), "failed to launch 'nope': spawn nope ENOENT\n");

    const notes: string[] = [];
    const blocked = join(dir, "a-file");
    writeFileSync(blocked, "");
    const broken = new TranscriptRecorder({
      transcript: join(blocked, "1.transcript.jsonl"),
      stderr: join(blocked, "1.stderr.txt"),
      format: "jsonl",
      maxBytes: 1 << 20,
      onNote: (message) => notes.push(message),
    });
    broken.beginRun();
    broken.stdout('{"type":"a"}\n{"type":"b"}\n');
    broken.endRun(cli({ stderr: "boom" }));
    await broken.close();
    assert.equal(notes.length, 2);
    assert.match(notes[0]!, /^could not keep its transcript: /);
    assert.match(notes[1]!, /^could not keep the end of its stderr: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the bridge ----------------------------------------------------------------------

test("the bridge tells the transcript when each CLI run starts and why: stall, rate limit, schema", async () => {
  const config = defaultConfig();
  config.adapters.fake = { name: "fake", command: ["fake"], stdin: "{prompt}", stallTimeout: 1 };
  config.settings.defaultAdapter = "fake";
  const results: CliResult[] = [
    cli({ returncode: -1, stalled: true, stderr: "" }),
    cli({ returncode: 1, stderr: "Rate limit reached for gpt-5. Please try again in 45s." }),
    cli({ stdout: "not json" }),
    cli({ stdout: '{"ok":true}' }),
  ];
  const runner: CommandRunner = async () => results.shift()!;
  const calls: string[] = [];
  const sink: TranscriptSink = {
    beginRun: (reason) => calls.push(`begin ${reason ?? "-"}`),
    stdout: (chunk) => calls.push(`stdout ${chunk}`),
    stderr: (chunk) => calls.push(`stderr ${chunk}`),
    endRun: (result) => calls.push(`end ${result.stdout}`),
  };
  const bridge = new Bridge(config, { runner, sleep: async () => {}, random: () => 0 });
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  const outcome = await bridge.run({ prompt: "p", schema }, { transcript: sink });
  assert.deepEqual(outcome.value, { ok: true });
  assert.deepEqual(calls, ["begin -", "end ", "begin stall", "end ", "begin rate_limit", "end not json", "begin schema", 'end {"ok":true}']);
});

// --- whole runs ---------------------------------------------------------------------------

/** A mock Claude Code printing stream-json, a warning on stderr, and (with `fail` in the prompt) a failed result. */
const MOCK_CLAUDE = [
  execPath,
  "-e",
  `let prompt = '';
process.stdin.on('data', (c) => (prompt += c)).on('end', () => {
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  process.stderr.write('mock: warming up\\n');
  emit({ type: 'system', subtype: 'init', session_id: 's', model: 'mock', tools: ['Bash'] });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\\nb\\n' }] } });
  const failed = prompt.includes('fail');
  emit({ type: 'result', subtype: 'success', is_error: failed, num_turns: 2, result: failed ? 'Credit balance is too low' : 'listed', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
});`,
];

/** Run `body` as a workflow with the given adapters (and settings) through the worker; return the store and run id. */
async function runWorkflow(
  root: string,
  body: string,
  adapters: Record<string, unknown>,
  settings: Record<string, unknown> = {},
): Promise<{ store: RunStore; id: string; state: string }> {
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ ...settings, adapters }));
  const script = join(root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath });
  const state = await executeRun(store.runDir(id));
  return { store, id, state };
}

test("end to end: each agent's stdout and stderr are kept as it runs — JSONL events as printed, text as text lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-e2e-"));
  try {
    const { store, id, state } = await runWorkflow(
      root,
      "const a = await agent('list the files', { adapter: 'mockclaude', label: 'lister' })\n" +
        "const b = await agent('say hi', { adapter: 'plain', label: 'plain' })\n" +
        "let c = null\ntry { c = await agent('fail please', { adapter: 'mockclaude', label: 'broke' }) } catch {}\n" +
        "return [a, b, c]\n",
      {
        mockclaude: { command: MOCK_CLAUDE, stdin: "{prompt}", output: defaultConfig().adapters.claude!.output },
        plain: { command: [execPath, MOCK_AGENT], stdin: "{prompt}" },
      },
    );
    assert.equal(state, "done");
    assert.deepEqual(store.readResult(id), ["listed", "mock reply", null]);

    const lister = store.agentTranscriptPaths(id, 1);
    const events = lines(lister.transcript).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      events.map((e) => e.type),
      ["system", "assistant", "user", "result"],
    );
    assert.deepEqual(events[1], {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    });
    assert.equal(readFileSync(lister.stderr, "utf8"), "mock: warming up\n");

    const plain = store.agentTranscriptPaths(id, 2);
    assert.equal(readFileSync(plain.transcript, "utf8"), '{"kind":"text","text":"mock reply"}\n');
    assert.equal(existsSync(plain.stderr), false);

    // A failed agent's transcript is kept as well: its CLI reported the failure in its result.
    const broke = lines(store.agentTranscriptPaths(id, 3).transcript).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      [broke.length, broke[3]!.type, broke[3]!.is_error, broke[3]!.result],
      [4, "result", true, "Credit balance is too low"],
    );
    assert.equal(store.readEvents(id).find((e) => e.type === "agent_failed")?.reason, "quota");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: a schema retry goes on in the same transcript after an attempt line", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-e2e-"));
  try {
    const counter = JSON.stringify(join(root, "runs-so-far"));
    const flaky = [
      execPath,
      "-e",
      `const fs = require('fs'); const n = fs.existsSync(${counter}) ? Number(fs.readFileSync(${counter}, 'utf8')) : 0;
fs.writeFileSync(${counter}, String(n + 1));
process.stdin.resume().on('end', () => process.stdout.write(n === 0 ? 'Sure! Here it is.\\n' : '{"ok":true}'));`,
    ];
    const schema = "{ type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }";
    const { store, id, state } = await runWorkflow(
      root,
      `return await agent('answer', { schema: ${schema}, label: 'json' })\n`,
      { flaky: { command: flaky, stdin: "{prompt}" } },
      { defaultAdapter: "flaky" },
    );
    assert.equal(state, "done");
    assert.deepEqual(store.readResult(id), { ok: true });
    assert.deepEqual(lines(store.agentTranscriptPaths(id, 1).transcript).map((line) => JSON.parse(line)), [
      { kind: "text", text: "Sure! Here it is.\n" },
      { kind: "attempt", n: 2, reason: "schema" },
      { kind: "text", text: '{"ok":true}' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: maxTranscriptBytes bounds each transcript; 0 keeps none", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-e2e-"));
  try {
    const chatty = [execPath, "-e", "process.stdin.resume().on('end', () => { for (let i = 0; i < 500; i++) console.log('line ' + i) })"];
    const bounded = await runWorkflow(root, "return await agent('talk', { label: 'chatty' })\n", { chatty: { command: chatty, stdin: "{prompt}" } }, {
      defaultAdapter: "chatty",
      maxTranscriptBytes: 1000,
    });
    assert.equal(bounded.state, "done");
    const path = bounded.store.agentTranscriptPaths(bounded.id, 1).transcript;
    const kept = lines(path).map((line) => JSON.parse(line) as { kind: string; bytes?: number });
    const last = kept.pop()!;
    assert.equal(last.kind, "truncated");
    assert.ok(kept.length > 10 && kept.every((line) => line.kind === "text"));
    assert.equal(last.bytes, readFileSync(path).length - Buffer.byteLength(JSON.stringify(last) + "\n"));
    assert.ok(last.bytes! <= 1000);

    const none = await runWorkflow(root, "return await agent('talk', { label: 'chatty' })\n", { chatty: { command: chatty, stdin: "{prompt}" } }, {
      defaultAdapter: "chatty",
      maxTranscriptBytes: 0,
    });
    assert.equal(none.state, "done");
    assert.equal(existsSync(none.store.agentTranscriptPaths(none.id, 1).transcript), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: an agent replayed by odw resume ran no CLI, so it gets no transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-e2e-"));
  try {
    const adapters = { plain: { command: [execPath, MOCK_AGENT], stdin: "{prompt}" } };
    const first = await runWorkflow(root, "return await agent('say hi', { label: 'greeter' })\n", adapters, { defaultAdapter: "plain" });
    assert.equal(first.state, "done");
    const { store } = first;
    assert.equal(readFileSync(store.agentTranscriptPaths(first.id, 1).transcript, "utf8"), '{"kind":"text","text":"mock reply"}\n');
    const meta = store.readMeta(first.id);
    const resumed = store.create({
      script: String(meta.script),
      args: null,
      source: root,
      configPath: String(meta.configPath),
      resumedFrom: { runId: first.id, dir: store.runDir(first.id) },
    });
    assert.equal(await executeRun(store.runDir(resumed)), "done");
    assert.equal(store.readEvents(resumed).find((e) => e.type === "agent_finished")?.cached, true);
    assert.equal(existsSync(store.agentTranscriptPaths(resumed, 1).transcript), false);
    assert.equal(existsSync(store.agentTranscriptPaths(resumed, 1).stderr), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maxTranscriptBytes loads, defaults to 5 MB, and rejects malformed values", () => {
  assert.equal(defaultConfig().settings.maxTranscriptBytes, 5 * 1024 * 1024);
  const example = JSON.parse(readFileSync(new URL("../odw.config.example.json", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.equal(example.maxTranscriptBytes, 5 * 1024 * 1024);
  assert.deepEqual(collectConfigWarnings({ maxTranscriptBytes: 1 }), []);
  const dir = mkdtempSync(join(tmpdir(), "odw-transcript-config-"));
  try {
    const load = (raw: Record<string, unknown>) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify(raw));
      return loadConfig(path, { quiet: true }).settings;
    };
    assert.equal(load({ maxTranscriptBytes: 4096 }).maxTranscriptBytes, 4096);
    assert.equal(load({ maxTranscriptBytes: 0 }).maxTranscriptBytes, 0);
    assert.equal(load({ maxTranscriptBytes: null }).maxTranscriptBytes, 5 * 1024 * 1024);
    for (const bad of [-1, 1.5, "lots", true]) {
      assert.throws(() => load({ maxTranscriptBytes: bad }), /"maxTranscriptBytes" must be a whole number of bytes, or 0 to keep no transcripts/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
