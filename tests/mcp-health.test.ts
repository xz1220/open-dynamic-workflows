import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { decodeOutput } from "../src/adapters/output.js";
import type { Adapter, CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { AdapterExecutionError, AgentError, UnmetExpectationError } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { Expectations, planChecks } from "../src/expect.js";
import { resumeKey } from "../src/journal.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

// MCP health (ODW extension): Claude Code's stream-json starts with an init
// event listing the MCP servers it started the agent with. One that is not
// connected is recorded on the agent and logged once per run; "mcpFailures":
// "fail" fails agents whose server failed or needs authentication; and
// expect.mcp makes a listed server that is not there a miss.

const EXPECT_AGENT = fileURLToPath(new URL("./fixtures/expect-agent.mjs", import.meta.url));

/** The built-in claude adapter's output declaration, for the scripted agent's --claude mode. */
const CLAUDE_LIKE = {
  format: "jsonl",
  eventType: "result",
  textPath: ["result"],
  select: "last",
  errorPath: ["is_error"],
  deniedPath: ["permission_denials"],
  mcpEvent: "system",
  mcpPath: ["mcp_servers"],
};

interface Flow {
  id: string;
  state: string;
  store: RunStore;
  result: Record<string, unknown>;
  events: WorkflowEvent[];
  calls: number;
}

/**
 * Run a workflow over the scripted agent in Claude Code's stream-json mode (as
 * the "claude" adapter): `body` calls agent() with prompts carrying `PLAN:`.
 */
async function runFlow(opts: { root: string; body: string; args?: unknown; config?: Record<string, unknown>; output?: unknown }): Promise<Flow> {
  const log = join(opts.root, "calls.jsonl");
  const configPath = join(opts.root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "claude",
      ...opts.config,
      adapters: {
        claude: { command: [execPath, EXPECT_AGENT, log, "--claude"], stdin: "{prompt}", output: opts.output ?? CLAUDE_LIKE },
      },
    }),
  );
  const script = join(opts.root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${opts.body}`);
  const store = new RunStore(join(opts.root, "runs"));
  const id = store.create({ script, args: opts.args ?? null, source: opts.root, configPath });
  const state = await executeRun(store.runDir(id));
  return {
    id,
    state,
    store,
    result: (store.readResult(id) ?? {}) as Record<string, unknown>,
    events: store.readEvents(id),
    calls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0,
  };
}

/** One agent() call labelled `fix-auth` whose CLI runs the steps of `plan`, in order. */
function runAgent(root: string, plan: unknown[], opts: Record<string, unknown> = {}, config?: Record<string, unknown>): Promise<Flow> {
  const body =
    "try { return { value: await agent('Fix the auth bug. PLAN: ' + JSON.stringify(args.plan), args.opts) } }\n" +
    "catch (err) { return { error: String(err) } }\n";
  return runFlow({ root, body, args: { plan, opts: { label: "fix-auth", ...opts } }, config });
}

const ofType = (events: WorkflowEvent[], type: string) => events.filter((e) => e.type === type);
const mcpLogs = (events: WorkflowEvent[]) => ofType(events, "log").filter((e) => Array.isArray(e.mcp));
const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-mcp-"));

const GITHUB_FAILED = { name: "github", status: "failed" };
const LINEAR_AUTH = { name: "linear", status: "needs-auth" };
const DOCS_UP = { name: "docs", status: "connected" };

/** Claude Code's stream-json, as `claude -p --output-format stream-json --verbose` prints it: init first, result last. */
const claudeStream = (servers: unknown[] | undefined, result: Record<string, unknown> = {}): string =>
  [
    {
      type: "system",
      subtype: "init",
      cwd: "/repo",
      session_id: "s",
      tools: ["Read", "Edit", "Bash", "mcp__docs__search"],
      ...(servers ? { mcp_servers: servers } : {}),
      model: "claude-x",
      permissionMode: "acceptEdits",
    },
    { type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 10, error_status: 529, error: "overloaded", session_id: "s" },
    { type: "result", subtype: "success", is_error: false, result: "Fixed the auth bug.", session_id: "s", permission_denials: [], ...result },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n";

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

function config(settings: Record<string, unknown> = {}) {
  const cfg = defaultConfig();
  Object.assign(cfg.settings, { defaultAdapter: "claude", ...settings });
  return cfg;
}

// --- reading the init event ------------------------------------------------------------

test("the decoder reads every MCP server the init event lists (mcpEvent + mcpPath), connected or not", () => {
  const claude = defaultConfig().adapters.claude!;
  assert.deepEqual(claude.output, { ...claude.output, mcpEvent: "system", mcpPath: ["mcp_servers"] }, "the built-in declares it");
  const servers = [GITHUB_FAILED, LINEAR_AUTH, DOCS_UP, { name: "slow", status: "pending", source: "project" }];
  assert.deepEqual(decodeOutput(claude, claudeStream(servers)).mcp, [GITHUB_FAILED, LINEAR_AUTH, DOCS_UP, { name: "slow", status: "pending" }]);
  assert.deepEqual(decodeOutput(claude, claudeStream([])).mcp, [], "an empty list: no servers at all");
  assert.equal("mcp" in decodeOutput(claude, claudeStream(undefined)), false, "no list: the CLI said nothing");
  // Only the declared event type counts; entries without a name are left out, a missing status reads "unknown".
  const other = { type: "assistant", mcp_servers: [GITHUB_FAILED] };
  assert.equal(decodeOutput(claude, JSON.stringify(other) + "\n" + claudeStream(undefined)).mcp, undefined);
  assert.deepEqual(decodeOutput(claude, claudeStream([{ status: "failed" }, { name: "x" }, "y"])).mcp, [{ name: "x", status: "unknown" }]);
  // Any CLI can declare its own: a JSON document too, with no event type.
  const json: Adapter = { name: "j", command: ["j"], output: { format: "json", textPath: ["text"], mcpPath: ["session", "mcp"] } };
  assert.deepEqual(decodeOutput(json, JSON.stringify({ text: "ok", session: { mcp: [GITHUB_FAILED] } })), { text: "ok", mcp: [GITHUB_FAILED] });
  // An adapter that declares nothing reads nothing, whatever its stream holds.
  const { mcpEvent: _event, mcpPath: _path, ...lenient } = claude.output as Extract<Adapter["output"], { format: "jsonl" }>;
  assert.equal(decodeOutput({ ...claude, output: lenient }, claudeStream([GITHUB_FAILED])).mcp, undefined);
});

// --- recording and logging ---------------------------------------------------------------

test("a failed server: the reply stands, the server is kept on the agent's event, record and view, and logged once", async () => {
  const root = tempRoot();
  try {
    const flow = await runAgent(root, [{ reply: "Fixed it.", mcp: [GITHUB_FAILED, DOCS_UP] }]);
    assert.deepEqual(flow.result, { value: "Fixed it." });
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.deepEqual(finished.mcp, [GITHUB_FAILED], "only the servers that were not connected");
    assert.deepEqual(flow.store.readAgentResult(flow.id, 1)?.mcp, [GITHUB_FAILED]);
    assert.deepEqual(detail(flow.store, flow.id).agents[0]!.mcp, [GITHUB_FAILED]);
    const logs = mcpLogs(flow.events);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.message, "MCP server github failed to start (claude agent `fix-auth`): its tools were unavailable");
    assert.deepEqual([logs[0]!.mcp, logs[0]!.agentId, logs[0]!.adapter], [[GITHUB_FAILED], 1, "claude"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("needs-auth, pending and disabled are recorded and logged, each in its own words", async () => {
  const root = tempRoot();
  try {
    const servers = [LINEAR_AUTH, { name: "slow", status: "pending" }, { name: "old", status: "disabled" }];
    const flow = await runAgent(root, [{ reply: "Done.", mcp: servers }]);
    assert.deepEqual(flow.result, { value: "Done." });
    assert.deepEqual(ofType(flow.events, "agent_finished")[0]!.mcp, servers);
    assert.deepEqual(
      mcpLogs(flow.events).map((e) => e.message),
      [
        "MCP server linear needs authentication (claude agent `fix-auth`): its tools were unavailable — sign in to it (/mcp in claude)",
        "MCP server slow was still connecting when the agent started (claude agent `fix-auth`): its tools came only once it connected, if it did",
        "MCP server old is disabled (claude agent `fix-auth`): its tools were unavailable",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all servers connected — or none configured — records nothing and logs nothing", async () => {
  const root = tempRoot();
  const root2 = tempRoot();
  try {
    const flow = await runAgent(root, [{ reply: "Done.", mcp: [DOCS_UP, { name: "github", status: "connected" }] }]);
    assert.deepEqual(flow.result, { value: "Done." });
    assert.equal(ofType(flow.events, "agent_finished")[0]!.mcp, undefined);
    assert.equal(flow.store.readAgentResult(flow.id, 1)?.mcp, undefined);
    assert.equal(detail(flow.store, flow.id).agents[0]!.mcp, undefined);
    assert.equal(mcpLogs(flow.events).length, 0);
    const none = await runAgent(root2, [{ reply: "Done." }]);
    assert.equal(ofType(none.events, "agent_finished")[0]!.mcp, undefined);
    assert.equal(mcpLogs(none.events).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("a log line once per run for each server and status, however many agents see it", async () => {
  const root = tempRoot();
  try {
    const body =
      "const plan = (servers) => 'PLAN: ' + JSON.stringify([{ reply: 'ok', mcp: servers }])\n" +
      "const failed = [{ name: 'github', status: 'failed' }]\n" +
      "await parallel([1, 2, 3].map((i) => () => agent(plan(failed), { label: 'a' + i })))\n" +
      "await agent(plan([{ name: 'github', status: 'needs-auth' }]), { label: 'later' })\n" +
      "await agent(plan(failed), { label: 'last' })\n" +
      "return 'ok'\n";
    const flow = await runFlow({ root, body });
    assert.equal(flow.state, "done");
    const logs = mcpLogs(flow.events);
    assert.deepEqual(
      logs.map((e) => (e.mcp as Array<{ status: string }>)[0]!.status),
      ["failed", "needs-auth"],
      "github failed is said once; github needing auth is another state, said once",
    );
    assert.match(String(logs[0]!.message), /^MCP server github failed to start \(claude agent `a[123]`\)/);
    assert.match(String(logs[1]!.message), /^MCP server github needs authentication \(claude agent `later`\)/);
    // Every agent still keeps what its own CLI reported.
    assert.equal(ofType(flow.events, "agent_finished").filter((e) => Array.isArray(e.mcp)).length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- mcpFailures: "fail" -----------------------------------------------------------------

test("mcpFailures \"fail\": a server that failed or needs auth fails the agent with reason mcp_unavailable, at once", async () => {
  const root = tempRoot();
  const root2 = tempRoot();
  try {
    const flow = await runAgent(root, [{ reply: "Fixed it.", mcp: [GITHUB_FAILED, LINEAR_AUTH, DOCS_UP] }], {}, { mcpFailures: "fail" });
    assert.match(
      String(flow.result.error),
      /^AdapterExecutionError: adapter 'claude' started the agent without an MCP server it is configured with \(mcpFailures: "fail"\) — fix the server \(claude mcp list\) and resume the run, or switch adapter with --adapter <name>: MCP servers not connected: github \(failed\); linear \(needs-auth\)$/,
    );
    const failed = ofType(flow.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "mcp_unavailable");
    assert.deepEqual(failed.mcp, [GITHUB_FAILED, LINEAR_AUTH], "the failed agent keeps what its CLI reported");
    assert.equal(detail(flow.store, flow.id).agents[0]!.failureReason, "mcp_unavailable");
    assert.deepEqual(detail(flow.store, flow.id).agents[0]!.mcp, [GITHUB_FAILED, LINEAR_AUTH]);
    assert.equal(flow.calls, 1, "not retried");
    assert.equal(mcpLogs(flow.events).length, 2, "still logged");

    // Pending and disabled servers never fail it.
    const kept = await runAgent(root2, [{ reply: "Done.", mcp: [{ name: "slow", status: "pending" }, { name: "old", status: "disabled" }] }], {}, { mcpFailures: "fail" });
    assert.deepEqual(kept.result, { value: "Done." });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("the bridge: warn keeps the reply and reports the servers; fail fails; a failure the CLI reported still comes first", async () => {
  const stream = claudeStream([GITHUB_FAILED, DOCS_UP]);
  const reports: unknown[] = [];
  const warned = await new Bridge(config(), { runner: async () => ok(stream) }).run({ prompt: "x" }, { onMcp: (r) => reports.push(r) });
  assert.equal(warned.value, "Fixed the auth bug.");
  assert.deepEqual(warned.mcp, [GITHUB_FAILED]);
  assert.deepEqual(reports, [{ adapter: "claude", servers: [GITHUB_FAILED] }]);
  const fine = await new Bridge(config(), { runner: async () => ok(claudeStream([DOCS_UP])) }).run({ prompt: "x" }, { onMcp: (r) => reports.push(r) });
  assert.equal(fine.mcp, undefined);
  assert.deepEqual(reports.at(-1), { adapter: "claude", servers: [] }, "a run with every server up says so too");

  await assert.rejects(
    new Bridge(config({ mcpFailures: "fail" }), { runner: async () => ok(stream) }).run({ prompt: "x" }),
    (err: unknown) => err instanceof AdapterExecutionError && err.reason === "mcp_unavailable",
  );
  const loggedOut = new Bridge(config({ mcpFailures: "fail" }), {
    runner: async () => ok(claudeStream([GITHUB_FAILED], { is_error: true, result: "Not logged in · Please run /login" })),
  });
  await assert.rejects(loggedOut.run({ prompt: "x" }), (err: unknown) => err instanceof AdapterExecutionError && err.reason === "auth");
});

// --- expect.mcp --------------------------------------------------------------------------

test("expect.mcp: a listed server that is not connected is a miss — retried, then unmet_expectation", async () => {
  const root = tempRoot();
  const root2 = tempRoot();
  try {
    const failing = await runAgent(root, [{ reply: "Fixed it.", mcp: [GITHUB_FAILED] }], { expect: { mcp: ["github", "jira"] } });
    const failed = ofType(failing.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "unmet_expectation");
    assert.deepEqual(failed.misses, [
      'MCP server "github" must be connected, and it failed to start',
      'MCP server "jira" must be connected, and the CLI did not start it — it is not configured for this agent',
    ]);
    assert.equal(failing.calls, 2, "one retry, as for any miss");
    const retried = ofType(failing.events, "log").filter((e) => Array.isArray(e.misses));
    assert.equal(retried.length, 1);
    assert.match(String(failing.result.error), /^UnmetExpectationError: adapter 'claude' did not meet its expectations after 1 retry: MCP server "github"/);

    // Connected on the retry: it passes, and the value rests on the work that had it.
    const passing = await runAgent(
      root2,
      [{ reply: "Tried.", mcp: [LINEAR_AUTH] }, { reply: "Fixed it.", mcp: [{ name: "linear", status: "connected" }] }],
      { expect: { mcp: ["linear"] } },
    );
    assert.deepEqual(passing.result, { value: "Fixed it." });
    assert.equal(ofType(passing.events, "agent_finished")[0]!.mcp, undefined);
    assert.equal(ofType(passing.events, "agent_finished")[0]!.attempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("expect.mcp: pending passes, the retry is told what was missing, and a listed server is a miss, not a failure, under \"fail\"", async () => {
  const plan = planChecks({ expect: { mcp: ["github"] } }).expect!;
  const checks = () => new Expectations(plan, 1, { exec: async () => assert.fail("no command to run") });
  const pending = await new Bridge(config(), { runner: async () => ok(claudeStream([{ name: "github", status: "pending" }])) }).run(
    { prompt: "x" },
    { expect: checks() },
  );
  assert.equal(pending.attempts, 1);
  assert.deepEqual(pending.mcp, [{ name: "github", status: "pending" }]);

  // Under "fail", github — which the call lists — is a miss handed back; linear, which it does not, fails it at once.
  const prompts: string[] = [];
  const listed = new Bridge(config({ mcpFailures: "fail" }), {
    runner: async (_command, options) => {
      prompts.push(options?.stdin ?? "");
      return ok(claudeStream(prompts.length === 1 ? [GITHUB_FAILED] : [{ name: "github", status: "connected" }]));
    },
  });
  const out = await listed.run({ prompt: "fix it" }, { expect: checks() });
  assert.equal(out.attempts, 2);
  assert.match(
    prompts[1]!,
    /^- MCP server "github" must be connected, and it failed to start\. If its tools are missing again, do not claim the task is done/m,
  );
  await assert.rejects(
    new Bridge(config({ mcpFailures: "fail" }), { runner: async () => ok(claudeStream([GITHUB_FAILED, LINEAR_AUTH])) }).run(
      { prompt: "x" },
      { expect: checks() },
    ),
    (err: unknown) => err instanceof AdapterExecutionError && err.reason === "mcp_unavailable" && /linear \(needs-auth\)$/.test(err.message) && !/github/.test(err.message.split(": MCP")[1]!),
  );
  // A CLI that says nothing about its servers misses too.
  await assert.rejects(
    new Bridge(config(), { runner: async () => ok(claudeStream(undefined)) }).run({ prompt: "x" }, { expect: checks() }),
    (err: unknown) =>
      err instanceof UnmetExpectationError && err.misses[0] === 'MCP server "github" must be connected, and its CLI did not say which MCP servers it started',
  );
});

test("expect.mcp: misuse is an AgentError before dispatch, and an adapter that reports no servers cannot be checked", async () => {
  assert.deepEqual(planChecks({ expect: { mcp: ["github", "github", "linear"] } }).expect?.mcp, ["github", "linear"]);
  assert.equal(planChecks({ expect: { mcp: [] } }).expect, null, "no server, nothing to check (as for files: [])");
  for (const bad of ["github", [""], [1]]) {
    assert.throws(
      () => planChecks({ expect: { mcp: bad } }),
      (err: unknown) => err instanceof AgentError && /^agent\(\): expect\.mcp must be an array of MCP server names \(non-empty strings\)/.test(err.message),
    );
  }
  // It keys the resume key, like any check.
  assert.notEqual(resumeKey("p", { expect: { mcp: ["github"] } }), resumeKey("p", { expect: {} }));

  let runs = 0;
  const codex = { ...config(), settings: { ...config().settings, defaultAdapter: "codex" } };
  const plan = planChecks({ expect: { mcp: ["github"] } }).expect!;
  await assert.rejects(
    new Bridge(codex, { runner: async () => (runs++, ok("done")) }).run({ prompt: "x" }, { expect: new Expectations(plan, 1, { exec: async () => assert.fail() }) }),
    (err: unknown) =>
      err instanceof AgentError &&
      err.message === "agent(): expect.mcp needs a CLI that says which MCP servers it started — adapter 'codex' declares no output.mcpPath (the built-in claude does)",
  );
  assert.equal(runs, 0, "nothing ran");
});

// --- config ------------------------------------------------------------------------------

test("mcpFailures, output.mcpEvent and output.mcpPath load, default, and reject malformed values", () => {
  const dir = tempRoot();
  try {
    const load = (raw: Record<string, unknown>) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify(raw));
      return loadConfig(path, { quiet: true });
    };
    assert.equal(defaultConfig().settings.mcpFailures, "warn");
    assert.equal(load({ mcpFailures: "fail" }).settings.mcpFailures, "fail");
    assert.equal(load({ mcpFailures: null }).settings.mcpFailures, "warn");
    assert.throws(() => load({ mcpFailures: "error" }), /"mcpFailures" must be "warn" or "fail"; got "error"/);
    assert.deepEqual(collectConfigWarnings({ mcpFailures: "fail" }), []);

    const output = { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", mcpEvent: "system", mcpPath: ["mcp_servers"] };
    assert.deepEqual(load({ adapters: { mine: { command: ["x"], output } } }).adapters.mine!.output, output);
    assert.deepEqual(collectConfigWarnings({ adapters: { mine: { command: ["x"], output } } }), []);
    assert.throws(() => load({ adapters: { mine: { command: ["x"], output: { ...output, mcpPath: "mcp_servers" } } } }), /adapter 'mine' 'output\.mcpPath' must be a non-empty array of strings/);
    assert.throws(() => load({ adapters: { mine: { command: ["x"], output: { ...output, mcpEvent: "" } } } }), /adapter 'mine' 'output\.mcpEvent' must be a non-empty string/);
    const json = { format: "json", textPath: ["text"], mcpPath: ["mcp"] };
    assert.deepEqual(load({ adapters: { mine: { command: ["x"], output: json } } }).adapters.mine!.output, json);

    const example = loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true });
    assert.equal(example.settings.mcpFailures, "warn");
    assert.deepEqual(example.adapters.claude!.output, defaultConfig().adapters.claude!.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
