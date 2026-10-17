import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { runDoctor } from "../src/doctor.js";
import { createRedactor, marker } from "../src/redact.js";
import { RunStore } from "../src/runtime/run-store.js";
import { normalizeTranscript } from "../src/runtime/transcript-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { STDERR_TAIL_CHARS, TranscriptRecorder } from "../src/transcript.js";

// Redaction (ODW extension) where odw writes: an agent's transcript and stderr
// tail, its saved result, the run's events, error and result, exec() failures,
// webhook payloads — with mock agents that print a fake key from their own
// environment, through the real worker. Every test secret is built at runtime
// from fragments (GitHub push protection scans for realistic ones).

/** Letters and digits, deterministic per seed. */
function chars(n: number, seed = 1): string {
  const alphabet = "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z";
  return Array.from({ length: n }, (_, i) => alphabet[(i * 7 + seed * 13) % alphabet.length]).join("");
}

/** The fake key the mock agents are given, and print. */
const KEY = "demo-" + chars(28);
const KEY_MARK = marker("env:DEMO_API_KEY");
/** A token of a well-known shape, as JavaScript source that builds it at runtime. */
const GH_SOURCE = `'gh' + 'p_' + ${JSON.stringify(chars(36, 3))}`;
const GH = "gh" + "p_" + chars(36, 3);

const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter(Boolean);

/** Every file under `dir`, recursively, with its text. */
function filesUnder(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

/** A text-mode mock CLI that reads the prompt, then prints its DEMO_API_KEY — on stdout in two chunks, and on stderr. */
const LEAKY = [
  execPath,
  "-e",
  `process.stdin.resume().on('end', () => {
  const key = process.env.DEMO_API_KEY;
  process.stderr.write('debug: using ' + key + '\\n');
  process.stdout.write('reading .env\\nthe key is ' + key.slice(0, 9));
  setTimeout(() => process.stdout.write(key.slice(9) + ' — done'), 60);
});`,
];

/** A mock Claude Code printing stream-json: the key in its text, in a tool's result, in its result. */
const LEAKY_CLAUDE = [
  execPath,
  "-e",
  `process.stdin.resume().on('end', () => {
  const key = process.env.DEMO_API_KEY;
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: 's', model: 'mock', tools: ['Bash'] });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the env.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'DEMO_API_KEY=' + key + '\\nDEBUG=1\\n' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'the key is ' + key, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
});`,
];

/** Run `body` as a workflow with the given adapters and settings through the worker. */
async function runWorkflow(
  root: string,
  body: string,
  adapters: Record<string, unknown>,
  settings: Record<string, unknown> = {},
): Promise<{ store: RunStore; id: string; state: string; configPath: string }> {
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ ...settings, adapters }));
  const script = join(root, `wf-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath });
  const state = await executeRun(store.runDir(id));
  return { store, id, state, configPath };
}

const leaky = { leaky: { command: LEAKY, stdin: "{prompt}", env: { DEMO_API_KEY: KEY } } };

test("an agent that prints a key from its env: transcript, stderr tail, saved result and events keep it redacted", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-redact-run-"));
  try {
    const { store, id, state } = await runWorkflow(
      root,
      "const reply = await agent('read the env', { adapter: 'leaky', label: 'reader' })\n" +
        "log('the agent said: ' + reply)\n" +
        `return { reply, token: ${GH_SOURCE} }\n`,
      leaky,
    );
    assert.equal(state, "done");

    // The transcript: the key arrived in two chunks, and is redacted whole; its line says so.
    const paths = store.agentTranscriptPaths(id, 1);
    const kept = lines(paths.transcript).map((line) => JSON.parse(line) as { kind: string; text: string; redacted?: boolean });
    assert.deepEqual(kept, [
      { kind: "text", text: "reading .env\n" },
      { kind: "text", text: `the key is ${KEY_MARK} — done`, redacted: true },
    ]);
    assert.equal(readFileSync(paths.stderr, "utf8"), `debug: using ${KEY_MARK}\n`);
    // The transcript API marks the entry that had a secret kept out.
    const entries = normalizeTranscript(readFileSync(paths.transcript, "utf8"));
    assert.deepEqual(
      entries.map((e) => e.redacted ?? false),
      [false, true],
    );

    // The saved result: the reply redacted, the record marked.
    const record = store.readAgentResult(id, 1)!;
    assert.equal(record.value, `reading .env\nthe key is ${KEY_MARK} — done`);
    assert.equal(record.redacted, true);
    assert.equal(record.label, "reader");

    // The run's log line quoting the reply.
    const log = store.readEvents(id).find((e) => e.type === "log" && String(e.message).startsWith("the agent said"))!;
    assert.equal(log.message, `the agent said: reading .env\nthe key is ${KEY_MARK} — done`);
    assert.equal(log.redacted, true);

    // The workflow's own value is the user's data: the token shape is redacted,
    // the environment's value is not — and the workflow got the reply as printed.
    const result = JSON.parse(readFileSync(join(store.runDir(id), "result.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(result, { value: { reply: `reading .env\nthe key is ${KEY} — done`, token: marker("github") }, redacted: true });

    // Nowhere else in the run directory is the key kept in clear.
    for (const file of filesUnder(store.runDir(id))) {
      if (file.path.endsWith("result.json")) continue;
      assert.equal(file.text.includes(KEY), false, `${file.path} keeps the key`);
      assert.equal(file.text.includes(GH), false, `${file.path} keeps the token`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a JSONL adapter's events that held a secret are written anew and marked; the rest as received", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-redact-run-"));
  try {
    const { store, id, state } = await runWorkflow(root, "return await agent('look', { adapter: 'mockclaude', label: 'looker' })\n", {
      mockclaude: { command: LEAKY_CLAUDE, stdin: "{prompt}", output: defaultConfig().adapters.claude!.output, env: { DEMO_API_KEY: KEY } },
    });
    assert.equal(state, "done");
    const raw = lines(store.agentTranscriptPaths(id, 1).transcript);
    const events = raw.map((line) => JSON.parse(line) as Record<string, any>);
    assert.deepEqual(
      events.map((e) => [e.type, e.redacted ?? false]),
      [
        ["system", false],
        ["assistant", false],
        ["user", true],
        ["result", true],
      ],
    );
    assert.equal(raw[0], JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "mock", tools: ["Bash"] }));
    assert.equal(events[2]!.message.content[0].content, `DEMO_API_KEY=${KEY_MARK}\nDEBUG=1\n`);
    assert.equal(events[3]!.result, `the key is ${KEY_MARK}`);
    assert.equal(raw.some((line) => line.includes(KEY)), false);

    const entries = normalizeTranscript(raw.join("\n"));
    const tagged = entries.filter((e) => e.redacted).map((e) => e.kind);
    assert.deepEqual(tagged, ["tool_result", "result"]);
    assert.equal(store.readAgentResult(id, 1)!.value, `the key is ${KEY_MARK}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("what is passed to agents is never redacted: the prompt and the environment arrive as given", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-redact-run-"));
  try {
    // It checks what it got against its own copies, and says only whether they matched.
    const checker = [
      execPath,
      "-e",
      `let prompt = ''; process.stdin.on('data', (c) => (prompt += c)).on('end', () => {
  const intact = prompt.includes(process.env.EXPECT_TOKEN) && prompt.includes(process.env.EXPECT_KEY) && process.env.DEMO_API_KEY === process.env.EXPECT_KEY;
  process.stdout.write(intact ? 'intact' : 'altered');
});`,
    ];
    const { store, id, state } = await runWorkflow(
      root,
      `return await agent('use ' + ${GH_SOURCE} + ' and ' + ${JSON.stringify(KEY)}, { adapter: 'checker' })\n`,
      { checker: { command: checker, stdin: "{prompt}", env: { DEMO_API_KEY: KEY, EXPECT_KEY: KEY, EXPECT_TOKEN: GH } } },
    );
    assert.equal(state, "done");
    assert.equal(store.readResult(id), "intact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redact: false keeps everything as printed", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-redact-run-"));
  try {
    const { store, id, state } = await runWorkflow(root, "return await agent('read the env', { adapter: 'leaky' })\n", leaky, { redact: false });
    assert.equal(state, "done");
    const paths = store.agentTranscriptPaths(id, 1);
    assert.ok(readFileSync(paths.transcript, "utf8").includes(KEY));
    assert.ok(readFileSync(paths.stderr, "utf8").includes(KEY));
    const record = store.readAgentResult(id, 1)!;
    assert.ok(String(record.value).includes(KEY));
    assert.equal(record.redacted, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent's failure quotes its CLI's output redacted before it is cut: no secret is kept in half", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-redact-run-"));
  try {
    // 240 characters, then the key across the 250th: the error keeps the first 250 and the last 250.
    const failing = [
      execPath,
      "-e",
      "process.stdin.resume().on('end', () => { process.stderr.write('x'.repeat(240) + ' ' + process.env.DEMO_API_KEY + ' ' + 'y'.repeat(600)); process.exit(1) })",
    ];
    const { store, id, state } = await runWorkflow(
      root,
      "let reply = null\ntry { reply = await agent('fail', { adapter: 'failing' }) } catch (err) { log('caught: ' + err.message) }\n" +
        "await agent('fail again', { adapter: 'failing' })\n",
      { failing: { command: failing, stdin: "{prompt}", env: { DEMO_API_KEY: KEY } } },
    );
    assert.equal(state, "failed");
    const events = store.readEvents(id);
    const failed = events.filter((e) => e.type === "agent_failed");
    assert.equal(failed.length, 2);
    for (const ev of [...failed, events.find((e) => e.type === "log" && String(e.message).startsWith("caught"))!]) {
      const text = String(ev.error ?? ev.message);
      assert.ok(text.includes(KEY_MARK), text.slice(0, 300));
      for (const piece of [KEY.slice(0, 8), KEY.slice(10, 18), KEY.slice(-8)]) assert.equal(text.includes(piece), false, piece);
      // Redacted before it got to the event: the event still says so.
      assert.equal(ev.redacted, true);
    }
    // The run failed with the second one: its error (and error.json) are redacted the same way.
    const error = store.readError(id)!;
    assert.equal(String(error.error).includes(KEY.slice(-8)), false);
    assert.ok(String(error.error).includes("«redacted:env:DEMO"));
    assert.equal(String(error.stack).includes(KEY.slice(-8)), false);
    assert.equal(error.redacted, true);
    const runFailed = events.find((e) => e.type === "run_failed")!;
    assert.equal(runFailed.error, error.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exec(): its events and a failed check redact the command and its output; what exec() returns is untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-redact-run-"));
  const before = process.env.ODW_TEST_DEPLOY_TOKEN;
  process.env.ODW_TEST_DEPLOY_TOKEN = KEY; // odw's own environment: what exec() commands start with
  try {
    const node = JSON.stringify(execPath);
    const { store, id, state } = await runWorkflow(
      root,
      `const shown = await exec([${node}, '-e', 'process.stdout.write(process.env.ODW_TEST_DEPLOY_TOKEN)'])\n` +
        // What exec() hands the workflow is the output as printed.
        "if (shown.stdout !== process.env.ODW_TEST_DEPLOY_TOKEN) throw new Error('exec() output was altered')\n" +
        `await exec([${node}, '-e', '0 // ' + ${GH_SOURCE}])\n` +
        "log('exec said ' + shown.stdout)\n" +
        `await exec([${node}, '-e', 'process.stderr.write("deploy failed for " + process.env.ODW_TEST_DEPLOY_TOKEN); process.exit(1)'], { check: true })\n`,
      {},
    );
    assert.equal(state, "failed");
    const events = store.readEvents(id);
    // The command as events show it, label included: the token shape is redacted, not cut in half.
    const started = events.filter((e) => e.type === "command_started");
    assert.equal(started.length, 3);
    assert.ok(String(started[1]!.command).endsWith(`0 // ${marker("github")}'`));
    assert.equal(String(started[1]!.label).includes(GH.slice(0, 6)), false);
    // exec() handed the workflow its output as printed; the log line quoting it is redacted.
    const log = events.find((e) => e.type === "log" && String(e.message).startsWith("exec said"))!;
    assert.equal(log.message, `exec said ${marker("env:ODW_TEST_DEPLOY_TOKEN")}`);
    // The failed check's ExecError fails the run: its message quotes stderr, redacted.
    const error = store.readError(id)!;
    assert.match(String(error.error), /deploy failed for «redacted:env:ODW_TEST_DEPLOY_TOKEN»/);
    assert.equal(error.redacted, true);
    assert.equal(readFileSync(store.eventsPath(id), "utf8").includes(KEY), false);
  } finally {
    if (before === undefined) delete process.env.ODW_TEST_DEPLOY_TOKEN;
    else process.env.ODW_TEST_DEPLOY_TOKEN = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a webhook is sent the run's error and a checkpoint's title redacted, marked redacted", async () => {
  const posts: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      posts.push(JSON.parse(data) as Record<string, any>);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/YOUR/PATH`;
  const root = mkdtempSync(join(tmpdir(), "odw-redact-run-"));
  try {
    const { store, id, state } = await runWorkflow(
      root,
      `await checkpoint('Ship with ' + ${GH_SOURCE} + '?', { timeout: 0.05, onTimeout: 'approve' })\n` +
        "const reply = await agent('read the env', { adapter: 'leaky' })\n" +
        "throw new Error('upload failed: ' + reply)\n",
      leaky,
      { notify: { webhook: url, on: ["failed", "waiting"] } },
    );
    assert.equal(state, "failed");
    assert.equal(posts.length, 2);
    const waiting = posts.find((p) => p.state === "waiting")!;
    assert.equal(waiting.checkpoint.title, `Ship with ${marker("github")}?`);
    assert.equal(waiting.redacted, true);
    const failed = posts.find((p) => p.state === "failed")!;
    assert.equal(failed.error, `upload failed: reading .env\nthe key is ${KEY_MARK} — done`);
    assert.equal(failed.redacted, true);
    assert.equal(failed.runId, id);
    assert.equal(JSON.stringify(posts).includes(KEY), false);
    assert.equal(JSON.stringify(posts).includes(GH), false);
    const requested = store.readEvents(id).find((e) => e.type === "checkpoint_requested")!;
    assert.equal(requested.title, `Ship with ${marker("github")}?`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resumed run replays a redacted result as saved, marked, and says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-redact-run-"));
  try {
    const first = await runWorkflow(root, "return await agent('read the env', { adapter: 'leaky', label: 'reader' })\n", leaky);
    assert.equal(first.state, "done");
    const { store } = first;
    const meta = store.readMeta(first.id);
    const resumed = store.create({
      script: String(meta.script),
      args: null,
      source: root,
      configPath: first.configPath,
      resumedFrom: { runId: first.id, dir: store.runDir(first.id) },
    });
    assert.equal(await executeRun(store.runDir(resumed)), "done");
    const record = store.readAgentResult(resumed, 1)!;
    assert.equal(record.cached, true);
    assert.equal(record.redacted, true);
    assert.equal(record.value, `reading .env\nthe key is ${KEY_MARK} — done`);
    const note = store.readEvents(resumed).find((e) => e.type === "log" && String(e.message).includes("whose secrets were redacted"));
    assert.ok(note, "the replay says its value had secrets redacted");
    assert.equal(note!.agentId, 1);
    // The workflow got the value as saved: the marker stands in for the key.
    assert.equal(store.readResult(resumed), `reading .env\nthe key is ${KEY_MARK} — done`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the recorder and the bridge on their own ------------------------------------------

const cli = (fields: Partial<CliResult> = {}): CliResult => ({ returncode: 0, stdout: "", stderr: "", timedOut: false, duration: 0.1, ...fields });

test("the recorder redacts text that streams in pieces, a long line included, and its stderr from a line's start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-redact-rec-"));
  try {
    const redactor = createRedactor(undefined, { env: [{ DEMO_API_KEY: KEY }] });
    const paths = { transcript: join(dir, "1.transcript.jsonl"), stderr: join(dir, "1.stderr.txt") };
    const recorder = new TranscriptRecorder({ ...paths, format: "text", maxBytes: 1 << 22, redactor });
    recorder.beginRun();
    const long = "z".repeat(50_000) + ` ${KEY} ` + "z".repeat(50_000);
    const printed = `start\nkey ${KEY.slice(0, 3)}`;
    recorder.stdout(printed);
    recorder.stdout(`${KEY.slice(3)} end\n${long}\nbye`);
    // stderr longer than the tail kept: its kept end starts at a line, never inside the key.
    const stderrLine = `${"w".repeat(100)} ${KEY}\n`;
    let stderr = "";
    while (stderr.length < STDERR_TAIL_CHARS + 5000) stderr += stderrLine;
    recorder.stderr(stderr.slice(37)); // the first line starts cut
    recorder.endRun(cli({ stderr: stderr.slice(-STDERR_TAIL_CHARS) }));
    await recorder.close();
    const kept = lines(paths.transcript).map((line) => JSON.parse(line) as { text: string; redacted?: boolean });
    const text = kept.map((line) => line.text).join("");
    assert.equal(text, redactor.text(`start\nkey ${KEY} end\n${long}\nbye`));
    assert.equal(text.includes(KEY.slice(0, 8)), false);
    assert.deepEqual(kept[1], { kind: "text", text: `key ${KEY_MARK} end\n`, redacted: true });
    assert.ok(kept.some((line) => line.redacted && line.text.includes(KEY_MARK) && line.text.startsWith("z")));
    const tail = readFileSync(paths.stderr, "utf8");
    assert.ok(tail.length <= STDERR_TAIL_CHARS);
    assert.ok(tail.startsWith("w".repeat(100)), "the kept end starts at a line");
    assert.equal(tail.includes(KEY.slice(-8)), false);
    assert.equal(tail.split("\n").filter(Boolean).every((line) => line === `${"w".repeat(100)} ${KEY_MARK}`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bridge redacts a failed CLI's output before cutting it into the error", async () => {
  const config = defaultConfig();
  config.adapters.fake = { name: "fake", command: ["fake"], stdin: "{prompt}" };
  config.settings.defaultAdapter = "fake";
  const token = ["sk", "ant", "api03", chars(93)].join("-");
  // The token straddles both cuts: characters 250 from the start, and 250 from the end.
  const stderr = "a".repeat(230) + " " + token + " " + "b".repeat(300) + " " + token + " " + "c".repeat(200);
  const runner: CommandRunner = async () => cli({ returncode: 1, stderr });
  const redactor = createRedactor(undefined, {});
  const bridge = new Bridge(config, { runner, redactor });
  await assert.rejects(bridge.run({ prompt: "p" }), (err: Error) => {
    assert.equal(err.message.includes(token.slice(0, 12)), false);
    assert.equal(err.message.includes(token.slice(-12)), false);
    assert.ok(err.message.includes("«redacted:anth"));
    return true;
  });
  // Without a redactor, the error quotes the output as it was (the excerpt cuts it).
  const plain = new Bridge(config, { runner });
  await assert.rejects(plain.run({ prompt: "p" }), (err: Error) => err.message.includes(token.slice(0, 12)));
});

// --- doctor and config ---------------------------------------------------------------------

test("odw doctor reports whether redaction is on, and what it covers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-redact-doctor-"));
  try {
    const check = async (settings: Record<string, unknown>, env: Record<string, string>) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify({ runsRoot: join(dir, "runs"), adapters: {}, ...settings }));
      const report = await runDoctor({ config: loadConfig(path, { quiet: true }), configPath: path, cwd: dir, smoke: [], env });
      return report.checks.find((c) => c.id === "redaction")!;
    };
    const on = await check({}, { GITHUB_TOKEN: "t".repeat(20), HOME: "/home/x" });
    assert.equal(on.status, "ok");
    assert.match(on.detail, /^on — the values of 1 secret-named variable \(GITHUB_TOKEN\), NAME=value of secret-looking names, token shapes$/);
    const many = await check({ redact: { extra: ["corp-[0-9]+"] } }, Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`T${i}_TOKEN`, "v".repeat(10)])));
    assert.match(many.detail, /7 secret-named variables \(T0_TOKEN, T1_TOKEN, T2_TOKEN, T3_TOKEN, T4_TOKEN, and 2 more\).*1 extra pattern$/);
    const off = await check({ redact: false }, {});
    assert.equal(off.status, "warn");
    assert.equal(off.detail, 'off ("redact": false)');
    assert.match(off.hint!, /kept and served in clear/);
    const nothing = await check({ redact: { env: false, patterns: false } }, {});
    assert.equal(nothing.status, "warn");
    const shapes = await check({ redact: { env: false } }, { GITHUB_TOKEN: "t".repeat(20) });
    assert.deepEqual([shapes.status, shapes.detail], ["ok", "on — token shapes"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
