import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { ACP_OUTPUT, acpHandshake, acpRunner, permits, type AcpPermission } from "../src/adapters/acp.js";
import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { declaredTiers, planPermissions } from "../src/adapters/permissions.js";
import { runCommand } from "../src/adapters/runner.js";
import type { Adapter, Config, PermissionTier } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { runDoctor } from "../src/doctor.js";
import { AdapterExecutionError, ConfigError } from "../src/errors.js";
import { RunStore } from "../src/runtime/run-store.js";
import { normalizeTranscript } from "../src/runtime/transcript-view.js";
import { executeRun } from "../src/runtime/worker.js";

// ACP adapters (ODW extension; src/adapters/acp.ts): `"protocol": "acp"`
// drives an Agent Client Protocol agent over JSON-RPC on stdio. Every test
// runs against tests/fixtures/fake-acp-agent.mjs — a fake agent written for
// these tests, never a real one.

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-acp-")));
  made.push(dir);
  return dir;
}

/** A config whose `gem` adapter is the fake ACP agent playing `scenario`, logging what it was sent to `log`. */
function acpConfig(scenario: string, log: string, settings: Partial<Config["settings"]> = {}): Config {
  const config = defaultConfig();
  config.adapters = {
    gem: { name: "gem", command: [execPath, FAKE_ACP, scenario], protocol: "acp", output: ACP_OUTPUT, env: { FAKE_ACP_LOG: log } },
  };
  Object.assign(config.settings, { defaultAdapter: "gem", recordVersions: false, transientRetries: 0 }, settings);
  return config;
}

/** What the client sent the fake agent, in order. */
function sent(log: string): Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }> {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** Run one agent call on the fake playing `scenario` at `tier`: its outcome or error, the permissions told, what it was sent. */
async function call(scenario: string, options: { tier?: PermissionTier; prompt?: string; timeout?: number; untrustedInput?: boolean } = {}) {
  const dir = tempDir();
  const log = join(dir, "acp.log");
  const config = acpConfig(scenario, log, { permissions: options.tier ?? "edit", ...(options.timeout ? { timeout: options.timeout } : {}) });
  const bridge = new Bridge(config, { source: dir, runner: runCommand, ...(options.untrustedInput ? { withholdSecrets: true } : {}) });
  const permissions: Array<AcpPermission & { adapter: string }> = [];
  try {
    const outcome = await bridge.run(
      { prompt: options.prompt ?? "say the word PINEAPPLE", adapter: "gem", label: "t" },
      { onAcpPermission: (p) => permissions.push(p) },
    );
    return { outcome, error: null, permissions, sent: sent(log), dir };
  } catch (error) {
    return { outcome: null, error: error as Error, permissions, sent: sent(log), dir };
  }
}

// --- the tiers ----------------------------------------------------------------------------

test("a tier allows tool kinds: read looks (and fetches and searches, unless untrusted input meets an open network), edit changes files, full runs anything", () => {
  const kinds = ["read", "search", "think", "fetch", "edit", "delete", "move", "execute", "switch_mode", "other", "made-up"];
  const allowed = (tier: PermissionTier, noWeb = false) => kinds.filter((k) => permits(tier, k, noWeb));
  assert.deepEqual(allowed("read"), ["read", "search", "think", "fetch"]);
  assert.deepEqual(allowed("read", true), ["read", "think"]);
  assert.deepEqual(allowed("edit"), ["read", "search", "think", "fetch", "edit", "delete", "move"]);
  assert.deepEqual(allowed("full"), kinds);
});

// --- the config ---------------------------------------------------------------------------

test("config: protocol acp decodes with ODW's own rules, runs every tier, and refuses stdin, output or another protocol", () => {
  const dir = tempDir();
  const write = (adapters: unknown) => {
    const path = join(dir, `c${Math.random()}.json`);
    writeFileSync(path, JSON.stringify({ adapters }));
    return path;
  };
  const config = loadConfig(write({ gem: { protocol: "acp", command: ["gemini", "--experimental-acp", "{permission_args}"], permissionArgs: { edit: [] } } }), { quiet: true });
  const gem = config.adapters.gem!;
  assert.equal(gem.protocol, "acp");
  assert.deepEqual(gem.output, ACP_OUTPUT);
  assert.deepEqual(declaredTiers(gem), ["read", "edit", "full"]);
  assert.deepEqual(planPermissions(gem, "read"), { requested: "read", tier: "read", args: [] }, "read runs: ODW answers its permission requests");
  assert.deepEqual(planPermissions(gem, "full").tier, "full");
  assert.deepEqual(collectConfigWarnings({ adapters: { gem: { protocol: "acp", command: ["x"] } } }), []);
  assert.throws(() => loadConfig(write({ gem: { protocol: "mcp", command: ["x"] } }), { quiet: true }), (e: unknown) => e instanceof ConfigError && /'protocol' must be "acp"/.test(e.message));
  assert.throws(() => loadConfig(write({ gem: { protocol: "acp", command: ["x"], stdin: "{prompt}" } }), { quiet: true }), /speaks ACP: .* takes no 'stdin'/);
  assert.throws(() => loadConfig(write({ gem: { protocol: "acp", command: ["x"], output: { format: "text" } } }), { quiet: true }), /takes no 'output'/);
  // A built-in changed into an ACP agent keeps its own stdin and output: it is told to take a name of its own.
  assert.throws(() => loadConfig(write({ gemini: { protocol: "acp" } }), { quiet: true }), /give the ACP agent a name of its own/);
});

// --- a session ----------------------------------------------------------------------------

test("a session: initialize with no client capabilities, session/new in the workspace, the prompt as one text block — and the reply after the last tool call", async () => {
  const { outcome, error, permissions, sent: messages, dir } = await call("reply", { prompt: "please answer PINEAPPLE" });
  assert.equal(error, null, String(error));
  assert.equal(outcome!.text, "ACP-OK PINEAPPLE");
  const init = messages.find((m) => m.method === "initialize")!;
  assert.equal(init.params!.protocolVersion, 1);
  assert.deepEqual(init.params!.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  const opened = messages.find((m) => m.method === "session/new")!;
  assert.deepEqual(opened.params, { cwd: dir, mcpServers: [] });
  const prompt = messages.find((m) => m.method === "session/prompt")!;
  assert.equal(prompt.params!.sessionId, "sess-1");
  const blocks = prompt.params!.prompt as Array<{ type: string; text: string }>;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "text");
  assert.match(blocks[0]!.text, /please answer PINEAPPLE$/);
  // The read was asked for and allowed once — never "always".
  const answer = messages.find((m) => m.id === 1000)!;
  assert.deepEqual(answer.result, { outcome: { outcome: "selected", optionId: "ao" } });
  assert.deepEqual(
    permissions.map((p) => [p.title, p.kind, p.decision, p.option, p.tier, p.adapter]),
    [["Read README.md", "read", "allowed", "allow_once", "edit", "gem"]],
  );
});

test("permission requests are answered by the tier: read refuses edits and commands, edit refuses commands and mode switches, full allows all", async () => {
  const by = async (tier: PermissionTier) => (await call("permissions", { tier })).outcome!.text;
  assert.equal(await by("read"), "read=ao fetch=ao edit=ro execute=ro switch_mode=ro");
  assert.equal(await by("edit"), "read=ao fetch=ao edit=ao execute=ro switch_mode=ro");
  assert.equal(await by("full"), "read=ao fetch=ao edit=ao execute=ao switch_mode=ao");
  // Each answer is told, and what was refused is recorded on the reply (permissionDenials: "warn").
  const { outcome, permissions } = await call("permissions", { tier: "read" });
  assert.deepEqual(
    permissions.map((p) => `${p.kind}:${p.decision}`),
    ["read:allowed", "fetch:allowed", "edit:rejected", "execute:rejected", "switch_mode:rejected"],
  );
  assert.deepEqual(outcome!.denied, ["do edit [edit] (do edit)", "do execute [execute] (do execute)", "do switch_mode [switch_mode] (do switch_mode)"]);
});

test("a refusal with no reject option cancels the request; a write beyond the tier that never asked is reported as unasked", async () => {
  const none = await call("no-reject", { tier: "edit" });
  assert.equal(none.outcome!.text, "execute=cancelled");
  assert.deepEqual(none.permissions.map((p) => [p.decision, p.option]), [["rejected", undefined]]);
  const unasked = await call("unasked", { tier: "read" });
  assert.equal(unasked.outcome!.text, "wrote it");
  assert.deepEqual(unasked.permissions.map((p) => [p.title, p.kind, p.decision]), [["Write notes.txt", "edit", "unasked"]]);
  // Within the tier, nothing to report.
  assert.deepEqual((await call("unasked", { tier: "edit" })).permissions, []);
});

test("untrusted input on an open network: a read agent's fetch and search requests are refused; trusted, they are allowed", async () => {
  const answers = async (withholdSecrets: boolean) => {
    const dir = tempDir();
    const bridge = new Bridge(acpConfig("web", join(dir, "acp.log"), { permissions: "read" }), { source: dir, runner: runCommand, withholdSecrets });
    return (await bridge.run({ prompt: "look", adapter: "gem", label: "t" })).text;
  };
  assert.equal(await answers(true), "read=ao fetch=ro search=ro");
  assert.equal(await answers(false), "read=ao fetch=ao search=ao");
});

test("a tool that ran without asking is reported unless it only looks: other, switch_mode and unknown kinds too", async () => {
  const read = await call("unasked-kinds", { tier: "read" });
  assert.equal(read.outcome!.text, "ran them");
  assert.deepEqual(
    read.permissions.map((p) => `${p.kind}:${p.decision}`),
    ["other:unasked", "switch_mode:unasked", "made-up:unasked", "other:unasked"],
  );
  assert.deepEqual((await call("unasked-kinds", { tier: "full" })).permissions, []);
  // Untrusted input without a boxed network: a web search or fetch that never asked is said too — it can carry data out.
  const untrusted = await call("unasked-kinds", { tier: "read", untrustedInput: true });
  assert.deepEqual(
    untrusted.permissions.map((p) => `${p.kind}:${p.decision}`),
    ["search:unasked", "fetch:unasked", "other:unasked", "switch_mode:unasked", "made-up:unasked", "other:unasked"],
  );
});

test("a client capability ODW does not declare is answered method-not-found", async () => {
  assert.equal((await call("fs")).outcome!.text, "fs=-32601");
});

// --- failures -----------------------------------------------------------------------------

test("failures: a login the agent needs, another protocol version, a turn that is not end_turn, an agent that exits mid-turn", async () => {
  const auth = await call("auth");
  assert.ok(auth.error instanceof AdapterExecutionError, String(auth.error));
  assert.equal((auth.error as AdapterExecutionError).reason, "auth");
  assert.match(auth.error!.message, /session\/new failed: Authentication required \(code -32000\)/);

  const version = await call("version");
  assert.match(String(version.error), /speaks protocol version 2; odw speaks 1/);
  assert.equal(version.sent.some((m) => m.method === "session/new"), false, "no session on a protocol it does not speak");

  const stopped = await call("max_tokens");
  assert.match(String(stopped.error), /the ACP agent stopped: max_tokens/);

  const crash = await call("crash");
  assert.match(String(crash.error), /exited \(3\) before its prompt turn ended: fake agent: something broke/);
});

test("a timeout cancels the turn with session/cancel before the agent is killed", async () => {
  const { error, sent: messages } = await call("hang", { timeout: 1 });
  assert.ok(error instanceof AdapterExecutionError);
  assert.equal((error as AdapterExecutionError).reason, "timeout");
  assert.deepEqual(messages.find((m) => m.method === "session/cancel")?.params, { sessionId: "sess-1" });
});

test("an agent that lingers once its turn ended is closed, then killed — a clean exit", async () => {
  const { outcome, error } = await call("linger");
  assert.equal(error, null, String(error));
  assert.equal(outcome!.text, "ACP-LINGER");
});

test("acpRunner hands the caller ODW's acp.* events, not the protocol", async () => {
  const dir = tempDir();
  const seen: string[] = [];
  const run = acpRunner(runCommand, { prompt: "x WORD", cwd: dir, tier: "edit" });
  const result = await run([execPath, FAKE_ACP, "reply"], { cwd: dir, timeout: 30, observeStdout: (c) => seen.push(c) });
  assert.equal(result.returncode, 0, result.stderr);
  const types = seen.join("").trim().split("\n").map((l) => JSON.parse(l).type);
  assert.deepEqual(types, [
    "acp.initialized",
    "acp.session",
    "acp.thought",
    "acp.message",
    "acp.tool_call",
    "acp.permission",
    "acp.tool_result",
    "acp.plan",
    "acp.usage",
    "acp.message",
    "acp.result",
  ]);
  const last = JSON.parse(result.stdout.trim().split("\n").pop()!);
  assert.deepEqual(last, {
    type: "acp.result",
    stopReason: "end_turn",
    text: "ACP-OK WORD",
    usage: { inputTokens: 300, outputTokens: 40 },
    costUsd: 0.02,
  });
});

// --- bounds -------------------------------------------------------------------------------

const FLOOD_ACP = fileURLToPath(new URL("./fixtures/flood-acp-agent.mjs", import.meta.url));

/** Run the flooding agent through acpRunner: its result, and every acp.* event it handed on (their longest line too). */
async function flood(mode: string, count: number, chars: number, maxOutputBytes: number, tier: PermissionTier = "read") {
  const dir = tempDir();
  let longest = 0;
  const events: Array<Record<string, unknown>> = [];
  const run = acpRunner(runCommand, { prompt: "x", cwd: dir, tier });
  const result = await run([execPath, FLOOD_ACP, mode, String(count), String(chars)], {
    cwd: dir,
    timeout: 60,
    maxOutputBytes,
    onStdout: (line) => {
      longest = Math.max(longest, line.length);
      events.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { result, events, longest };
}

test("an ACP agent's stdout counts against maxOutputBytes: past it the run is stopped as any CLI's overrun", async () => {
  const MiB = 1024 * 1024;
  const { result, longest } = await flood("message", 40, MiB, 2 * MiB);
  assert.notEqual(result.returncode, 0);
  assert.match(result.stderr, /\[process output exceeded 2097152 bytes; terminated\]/);
  assert.ok(longest < 3 * MiB, `the longest event handed on: ${longest}`);
  // The same words a buffered CLI's overrun has.
  const plain = await runCommand([execPath, "-e", "process.stdout.write('x'.repeat(4096))"], { timeout: 30, maxOutputBytes: 1024 });
  assert.match(plain.stderr, /\[process output exceeded 1024 bytes; terminated\]/);
});

test("an ACP session's text is bounded: a message and the reply at 4 MiB, a thought at 256 KiB, denied at 1000 listed", async () => {
  const MiB = 1024 * 1024;
  const message = await flood("message", 6, MiB, 64 * MiB);
  assert.equal(message.result.returncode, 0, message.result.stderr);
  const reply = message.events.find((e) => e.type === "acp.result")!;
  const cut = `\n[… cut at ${4 * MiB} characters]`;
  assert.equal(String(reply.text).length, 4 * MiB + cut.length);
  assert.ok(String(reply.text).endsWith(cut));
  assert.ok(message.longest < 5 * MiB, `the longest event: ${message.longest}`);

  const thought = await flood("thought", 4, 128 * 1024, 64 * MiB);
  const said = thought.events.find((e) => e.type === "acp.thought")!;
  assert.ok(String(said.text).endsWith(`\n[… cut at ${256 * 1024} characters]`));
  assert.equal(thought.events.find((e) => e.type === "acp.result")!.text, "done");

  const denied = await flood("denied", 1100, 0, 64 * MiB);
  const result = denied.events.find((e) => e.type === "acp.result")!;
  const list = result.denied as Array<{ tool_name: string }>;
  assert.equal(list.length, 1001);
  assert.equal(list[0]!.tool_name, "run 0 [execute]");
  assert.equal(list[1000]!.tool_name, "… and 100 more");
});

// --- end to end ---------------------------------------------------------------------------

function workflowRun(script: string, scenario: string, settings: Record<string, unknown> = {}) {
  const root = tempDir();
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "gem",
      recordVersions: false,
      ...settings,
      adapters: { gem: { protocol: "acp", command: [execPath, FAKE_ACP, scenario] } },
    }),
  );
  const file = join(root, "wf.js");
  writeFileSync(file, `export const meta = { name: 'acp', description: 'd' }\n${script}\n`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script: file, args: null, source: root, configPath });
  return { store, id };
}

test("end to end through the worker: the reply, its usage and cost, an acp_permission event per answer, a readable transcript", async () => {
  const { store, id } = workflowRun("return await agent('answer GRAPE', { label: 'scout' })", "reply", { permissions: "read" });
  assert.equal(await executeRun(store.runDir(id)), "done", JSON.stringify(store.readError(id)));
  assert.equal(store.readResult(id), "ACP-OK GRAPE");
  const events = store.readEvents(id);
  const finished = events.find((e) => e.type === "agent_finished")!;
  assert.deepEqual(finished.usage, { inputTokens: 300, outputTokens: 40, costUsd: 0.02 });
  const answers = events.filter((e) => e.type === "acp_permission");
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.decision, "allowed");
  assert.equal(answers[0]!.tier, "read");
  assert.equal(answers[0]!.label, "scout");
  assert.match(String(answers[0]!.message), /^scout:1 on gem asked to run Read README\.md \[read\]: allowed by its "read" tier$/);
  const entries = normalizeTranscript(readFileSync(store.agentTranscriptPaths(id, 1).transcript, "utf8"));
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["raw", "raw", "text", "text", "tool_call", "raw", "tool_result", "raw", "text", "result"],
  );
  assert.equal(entries[0]!.text, "Fake ACP Agent 0.0.1 (ACP protocol 1)");
  assert.equal(entries[2]!.thinking, true);
  assert.equal(entries[2]!.text, "Thinking it over.");
  assert.deepEqual([entries[4]!.tool, entries[4]!.text], ["Read README.md", "README.md"]);
  assert.deepEqual([entries[6]!.tool, entries[6]!.output, entries[6]!.isError], ["Read README.md", "# readme", false]);
  assert.equal(entries[9]!.costUsd, 0.02);
});

test("end to end: an agent's toolCalls limit counts the ACP agent's tool calls", async () => {
  const { store, id } = workflowRun("return await agent('go', { label: 'busy', limits: { toolCalls: 2 } })", "permissions", { permissions: "full" });
  assert.equal(await executeRun(store.runDir(id)), "failed");
  const failed = store.readEvents(id).find((e) => e.type === "agent_failed")!;
  assert.equal(failed.reason, "runaway");
  assert.match(String(failed.error), /3 tool calls > 2/);
});

// --- doctor -------------------------------------------------------------------------------

test("doctor --adapter on an ACP agent: a handshake and what it says it can do — and why not", async () => {
  const dir = tempDir();
  const path = join(dir, "odw.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      runsRoot: join(dir, "runs"),
      adapters: {
        gem: { protocol: "acp", command: [execPath, FAKE_ACP, "reply"] },
        old: { protocol: "acp", command: [execPath, FAKE_ACP, "version"] },
      },
    }),
  );
  const config = loadConfig(path, { quiet: true });
  const report = await runDoctor({ config, configPath: path, cwd: dir, smoke: [], handshake: ["gem", "old", "claude"] });
  const gem = report.checks.find((c) => c.id === "acp:gem")!;
  assert.equal(gem.status, "ok", gem.detail);
  assert.equal(gem.detail, "Fake ACP Agent 0.0.1 · protocol 1 · loadSession: no · prompt: text, embeddedContext · MCP: stdio · auth: fake-login");
  const old = report.checks.find((c) => c.id === "acp:old")!;
  assert.equal(old.status, "fail");
  assert.match(old.detail, /speaks protocol version 2; odw speaks 1/);
  assert.equal(report.checks.some((c) => c.id === "acp:claude"), false, "a CLI that is not an ACP agent gets no handshake");
  // The handshake opens no session and sends no prompt.
  const log = join(dir, "hs.log");
  const { info } = await acpHandshake(runCommand, [execPath, FAKE_ACP, "reply"], { cwd: dir, env: { ...process.env, FAKE_ACP_LOG: log } as Record<string, string>, timeout: 30 });
  assert.equal(info?.agentInfo?.name, "fake-acp");
  assert.deepEqual(sent(log).map((m) => m.method), ["initialize"]);
});

// Keep the type import honest: an Adapter is what the config yields.
void ((a: Adapter) => a.protocol);
