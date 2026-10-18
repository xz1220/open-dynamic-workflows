import { test } from "node:test";
import assert from "node:assert/strict";

import type { WorkflowEvent } from "../src/events.js";
import {
  CONTENT_MAX_CHARS,
  clip,
  nanos,
  providerName,
  runTrace,
  spanIdOf,
  traceIdOf,
  transcriptFacts,
  type OtlpAnyValue,
  type OtlpSpan,
  type OtlpTraces,
  type RunRecord,
} from "../src/otel.js";

// OpenTelemetry traces of a run (ODW extension): the pure mapper, on fixture
// runs written as the worker writes them.

const T0 = 1_760_000_000;
const RUN = "20261017-101500-ab12cd";

/** An event `s` seconds into the run. */
const at = (s: number, type: string, fields: Record<string, unknown> = {}): WorkflowEvent => ({ ts: T0 + s, type, ...fields });

function record(events: WorkflowEvent[], extra: Partial<RunRecord> = {}, state = "done"): RunRecord {
  return {
    runId: RUN,
    meta: { runId: RUN, workflowName: "review", createdAt: T0, args: { token: "ARGS-SECRET-VALUE" } },
    status: { state, name: "review", updatedAt: T0 + 100 },
    events,
    ...extra,
  };
}

const spansOf = (trace: OtlpTraces): OtlpSpan[] => trace.resourceSpans[0]!.scopeSpans[0]!.spans;
const named = (trace: OtlpTraces, name: string): OtlpSpan => {
  const span = spansOf(trace).find((s) => s.name === name);
  assert.ok(span, `a span named ${JSON.stringify(name)}; got ${spansOf(trace).map((s) => s.name).join(", ")}`);
  return span;
};

function plain(value: OtlpAnyValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return value.arrayValue!.values.map(plain);
}
const attrs = (span: { attributes: Array<{ key: string; value: OtlpAnyValue }> }): Record<string, unknown> =>
  Object.fromEntries(span.attributes.map((a) => [a.key, plain(a.value)]));
const seconds = (nano: string): number => Number(BigInt(nano) / 1000n) / 1e6;

/** A run with a phase, two agents (one failed), an exec() step and a checkpoint. */
const EVENTS: WorkflowEvent[] = [
  at(0.5, "run_started", { runId: RUN }),
  at(1, "phase_started", { phase: "Search" }),
  at(2, "agent_started", { agentId: 1, label: "find", phase: "Search", adapter: "claude", permissions: "edit", model: "claude-opus-4-5" }),
  at(3, "agent_started", { agentId: 2, label: "check", phase: "Search", adapter: "codex" }),
  at(10, "agent_finished", {
    agentId: 1,
    label: "find",
    phase: "Search",
    adapter: "claude",
    attempts: 1,
    saved: true,
    usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0, costUsd: 0.012 },
  }),
  at(12, "agent_failed", {
    agentId: 2,
    label: "check",
    phase: "Search",
    error: "AdapterExecutionError: adapter 'codex' is out of usage quota: you've hit your usage limit",
    reason: "quota",
    usage: { outputTokens: 4, estimated: true },
  }),
  at(20, "phase_started", { phase: "Verify" }),
  at(21, "command_started", { commandId: 1, label: "npm test", phase: "Verify", command: "npm test -- --token=CMD-SECRET" }),
  at(25, "command_failed", { commandId: 1, label: "npm test", phase: "Verify", command: "npm test", exitCode: 1, durationMs: 4000, error: "exited with code 1" }),
  at(30, "checkpoint_requested", { checkpointId: 1, title: "Ship it?", payload: { plan: "the plan" }, phase: "Verify" }),
  at(40, "checkpoint_resolved", { checkpointId: 1, approved: true, note: "looks right", by: "cli" }),
  at(41, "run_finished", { runId: RUN }),
];

test("a run: workflow, phase, agent, exec and checkpoint spans, parented and timed from its events", () => {
  const trace = runTrace(record(EVENTS));
  const root = named(trace, "invoke_workflow review");
  assert.equal(root.parentSpanId, undefined);
  assert.equal(root.kind, 1, "INTERNAL");
  assert.equal(root.traceId, traceIdOf(RUN));
  assert.equal(root.spanId, spanIdOf(RUN, "run"));
  assert.equal(root.status, undefined, "a successful span's status stays unset");
  assert.deepEqual(attrs(root), {
    "gen_ai.operation.name": "invoke_workflow",
    "gen_ai.workflow.name": "review",
    "odw.run.id": RUN,
    "odw.workflow.name": "review",
    "odw.run.state": "done",
    "odw.run.usage.input_tokens": 1000,
    "odw.run.usage.output_tokens": 54,
    "odw.run.usage.cache_read.input_tokens": 900,
    "odw.run.cost_usd": 0.012,
    "odw.usage.estimated": true,
    "odw.run.agents": 2,
    "odw.run.failed_agents": 1,
  });
  assert.equal(seconds(root.startTimeUnixNano), T0, "from the run's creation");
  assert.equal(seconds(root.endTimeUnixNano), T0 + 100, "to its terminal write");

  const search = named(trace, "phase Search");
  const verify = named(trace, "phase Verify");
  assert.equal(search.parentSpanId, root.spanId);
  assert.equal(seconds(search.startTimeUnixNano), T0 + 1);
  assert.equal(seconds(search.endTimeUnixNano), T0 + 20, "until the next phase began");
  assert.equal(seconds(verify.endTimeUnixNano), T0 + 100, "the last phase lasts to the run's end");

  const find = named(trace, "invoke_agent find");
  assert.equal(find.parentSpanId, search.spanId);
  assert.equal(find.kind, 3, "CLIENT: its CLI runs out of process");
  assert.equal(seconds(find.startTimeUnixNano), T0 + 2);
  assert.equal(seconds(find.endTimeUnixNano), T0 + 10);
  assert.deepEqual(attrs(find), {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": "anthropic",
    "gen_ai.agent.name": "find",
    "gen_ai.agent.id": `${RUN}/agents/1`,
    "gen_ai.request.model": "claude-opus-4-5",
    "odw.agent.id": 1,
    "odw.agent.state": "done",
    "odw.adapter": "claude",
    "odw.agent.permissions": "edit",
    "odw.agent.attempts": 1,
    "gen_ai.usage.input_tokens": 1000,
    "gen_ai.usage.output_tokens": 50,
    "gen_ai.usage.cache_read.input_tokens": 900,
    "odw.agent.cost_usd": 0.012,
  });

  const exec = named(trace, "exec npm test");
  assert.equal(exec.parentSpanId, verify.spanId);
  assert.equal(attrs(exec)["process.exit.code"], 1);
  assert.equal(attrs(exec)["error.type"], "exit");
  assert.deepEqual(exec.status, { code: 2 });
  assert.equal(seconds(exec.endTimeUnixNano) - seconds(exec.startTimeUnixNano), 4);

  const checkpoint = named(trace, "checkpoint Ship it?");
  assert.equal(checkpoint.parentSpanId, verify.spanId);
  assert.equal(seconds(checkpoint.endTimeUnixNano) - seconds(checkpoint.startTimeUnixNano), 10, "the wait");
  assert.deepEqual(attrs(checkpoint), {
    "odw.checkpoint.id": 1,
    "odw.checkpoint.title": "Ship it?",
    "odw.checkpoint.approved": true,
    "odw.checkpoint.by": "cli",
  });

  const json = JSON.stringify(trace);
  assert.doesNotMatch(json, /ARGS-SECRET-VALUE/, "never the args");
  assert.doesNotMatch(json, /CMD-SECRET|the plan|looks right|usage limit/, "no content without captureContent");
});

test("a failed agent: status ERROR, error.type its failure reason — or its error's class without one", () => {
  const events = [
    ...EVENTS.slice(0, -1),
    at(50, "agent_started", { agentId: 3, label: "shape", adapter: "claude" }),
    at(55, "agent_failed", { agentId: 3, label: "shape", error: "SchemaValidationError: adapter 'claude' did not satisfy the schema" }),
    at(56, "agent_started", { agentId: 4, label: "odd", adapter: "claude" }),
    at(57, "agent_failed", { agentId: 4, label: "odd", error: "something odd" }),
  ];
  const trace = runTrace(record(events));
  const quota = named(trace, "invoke_agent check");
  assert.deepEqual(quota.status, { code: 2 }, "no description without captureContent: an error may quote output");
  assert.equal(attrs(quota)["error.type"], "quota");
  assert.equal(attrs(quota)["gen_ai.provider.name"], "openai");
  assert.equal(attrs(quota)["odw.usage.estimated"], true);
  assert.equal(attrs(named(trace, "invoke_agent shape"))["error.type"], "SchemaValidationError");
  assert.equal(attrs(named(trace, "invoke_agent odd"))["error.type"], "_OTHER");
  assert.equal(named(trace, "invoke_agent shape").parentSpanId, spanIdOf(RUN, "run"), "an agent outside any phase hangs off the run");
});

test("a failed run: error.type is its error's class, from error.json's stack", () => {
  const events = [...EVENTS.slice(0, -1), at(41, "run_failed", { runId: RUN, error: "budget spent" })];
  const failed = record(events, { error: { error: "budget spent", stack: "BudgetExhausted: budget spent\n    at x" } }, "failed");
  const root = named(runTrace(failed), "invoke_workflow review");
  assert.equal(attrs(root)["error.type"], "BudgetExhausted");
  assert.deepEqual(root.status, { code: 2 });
  assert.equal(named(runTrace(failed, { captureContent: true }), "invoke_workflow review").status?.message, "budget spent");
});

test("retries, fallbacks and quota waits are span events on their agent, from the structured log lines", () => {
  const events = [
    at(0, "agent_started", { agentId: 1, label: "search", adapter: "codex" }),
    at(1, "log", { message: "search:1 hit a rate limit on codex — retrying in 15s (1/3)", agentId: 1, label: "search", retry: { reason: "rate_limit", n: 1, of: 3, waitSeconds: 15 } }),
    at(2, "log", { message: "search:1 went quiet for 60s — restarting (1/1)", agentId: 1, label: "search", retry: { reason: "stall", n: 1, of: 1 } }),
    at(3, "log", { message: "search:1 → claude after codex quota", agentId: 1, label: "search", adapter: "claude", fellBackFrom: ["codex"], reason: "quota" }),
    at(4, "log", { message: "search:1 waits for claude's quota to reset (quotaWait)", agentId: 1, adapter: "claude", reason: "quota", quotaWait: "start", resumeAt: T0 + 60 }),
    at(60, "log", { message: "search:1 goes on after the quota wait, on claude", agentId: 1, adapter: "claude", quotaWait: "end", fellBackFrom: ["codex"] }),
    at(61, "log", { message: "a note that is not a moment of its own", agentId: 1 }),
    at(70, "agent_finished", { agentId: 1, label: "search", adapter: "claude", fellBackFrom: ["codex"], attempts: 1 }),
  ];
  const agent = named(runTrace(record(events)), "invoke_agent search");
  assert.deepEqual(
    agent.events!.map((e) => [e.name, seconds(e.timeUnixNano) - T0, attrs(e)]),
    [
      ["odw.retry", 1, { "odw.retry.reason": "rate_limit", "odw.retry.attempt": 1, "odw.retry.max": 3, "odw.retry.wait_seconds": 15 }],
      ["odw.retry", 2, { "odw.retry.reason": "stall", "odw.retry.attempt": 1, "odw.retry.max": 1 }],
      ["odw.fallback", 3, { "odw.fallback.from": "codex", "odw.fallback.to": "claude", "odw.fallback.reason": "quota" }],
      ["odw.quota_wait", 4, { "odw.adapter": "claude", "odw.quota.resume_at": T0 + 60 }],
      ["odw.quota_resume", 60, { "odw.adapter": "claude" }],
    ],
  );
  assert.equal(attrs(agent)["gen_ai.provider.name"], "anthropic", "the adapter that produced the value");
  assert.deepEqual(attrs(agent)["odw.agent.fell_back_from"], ["codex"]);
});

test("an expect check's exec() step hangs under its agent; a replayed agent says where it came from", () => {
  const events = [
    at(0, "agent_started", { agentId: 1, label: "fix", adapter: "claude" }),
    at(5, "command_started", { commandId: 1, label: "fix: expect", command: "npm test", forAgentId: 1 }),
    at(6, "command_finished", { commandId: 1, label: "fix: expect", command: "npm test", exitCode: 0, durationMs: 1000, forAgentId: 1 }),
    at(7, "agent_finished", { agentId: 1, label: "fix", adapter: "claude", attempts: 1 }),
    at(8, "agent_started", { agentId: 2, label: "old", adapter: "claude", cached: true, sourceRunId: "20261016-000000-aaaaaa" }),
    at(8, "agent_finished", { agentId: 2, label: "old", adapter: "claude", attempts: 1, cached: true, sourceRunId: "20261016-000000-aaaaaa" }),
  ];
  const trace = runTrace(record(events));
  const check = named(trace, "exec fix: expect");
  assert.equal(check.parentSpanId, spanIdOf(RUN, "agent/1"));
  assert.equal(check.status, undefined);
  assert.equal(attrs(check)["odw.command.for_agent_id"], 1);
  const old = attrs(named(trace, "invoke_agent old"));
  assert.equal(old["odw.agent.cached"], true);
  assert.equal(old["odw.agent.source_run_id"], "20261016-000000-aaaaaa");
});

test("a checkpoint that timed out, and one the run's end withdrew, are errors; a rejection is an answer", () => {
  const events = [
    at(1, "checkpoint_requested", { checkpointId: 1, title: "A?" }),
    at(2, "checkpoint_resolved", { checkpointId: 1, approved: false, note: null, by: "timeout", error: "checkpoint #1 'A?' got no answer within 1s" }),
    at(3, "checkpoint_requested", { checkpointId: 2, title: "B?" }),
    at(4, "checkpoint_resolved", { checkpointId: 2, approved: false, note: null, by: null, error: "run was stopped" }),
    at(5, "checkpoint_requested", { checkpointId: 3, title: "C?" }),
    at(6, "checkpoint_resolved", { checkpointId: 3, approved: false, note: "no", by: "dashboard" }),
  ];
  const trace = runTrace(record(events));
  assert.equal(attrs(named(trace, "checkpoint A?"))["error.type"], "timeout");
  assert.equal(attrs(named(trace, "checkpoint B?"))["error.type"], "cancelled");
  const rejected = named(trace, "checkpoint C?");
  assert.equal(rejected.status, undefined);
  assert.equal(attrs(rejected)["odw.checkpoint.approved"], false);
});

// --- transcripts ---------------------------------------------------------------------

const jsonl = (...events: unknown[]): string[] => events.map((e) => JSON.stringify(e));

/** Claude Code stream-json: Bash fails with exit 1, Edit works, a subagent (Task) reads a file. */
const CLAUDE = jsonl(
  { type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-5", tools: ["Bash"] },
  {
    type: "assistant",
    message: { model: "claude-sonnet-4-5-20250929", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] },
  },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Exit code 1\nnot ok 1", is_error: true }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Edit", input: { file_path: "a.ts" } }, { type: "tool_use", id: "toolu_3", name: "Task", input: { prompt: "look" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "updated" }] }] } },
  { type: "assistant", parent_tool_use_id: "toolu_3", message: { content: [{ type: "tool_use", id: "toolu_4", name: "Read", input: { file_path: "b.ts" } }] } },
  { type: "user", parent_tool_use_id: "toolu_3", message: { content: [{ type: "tool_result", tool_use_id: "toolu_4", content: "b" }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "done looking" }] } },
  { kind: "attempt", n: 2, reason: "schema" },
  { type: "result", subtype: "success", is_error: false, result: "fixed", session_id: "sess-2" },
);

test("transcriptFacts: Claude Code's tool calls with their results, models and session; opencode's times; codex's items", () => {
  const claude = transcriptFacts(CLAUDE);
  assert.equal(claude.lines, 10);
  assert.equal(claude.runs, 2, "one CLI run more after the attempt line");
  assert.equal(claude.model, "claude-sonnet-4-5");
  assert.equal(claude.responseModel, "claude-sonnet-4-5-20250929");
  assert.equal(claude.conversationId, "sess-2");
  assert.deepEqual(
    claude.tools.map((t) => [t.id, t.name, t.callLine, t.resultLine, t.isError, t.exitCode, t.parentId]),
    [
      ["toolu_1", "Bash", 1, 2, true, 1, undefined],
      ["toolu_2", "Edit", 3, 4, false, undefined, undefined],
      ["toolu_3", "Task", 3, 7, false, undefined, undefined],
      ["toolu_4", "Read", 5, 6, false, undefined, "toolu_3"],
    ],
  );

  const opencode = transcriptFacts(
    jsonl(
      { type: "step_start", timestamp: 1 },
      { type: "tool_use", part: { callID: "c1", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a\n", metadata: { exit: 0 }, time: { start: 1_000, end: 3_000 } } } },
      { type: "tool_use", part: { id: "c2", tool: "edit", state: { status: "error", input: {}, error: "denied", time: { start: 4_000, end: 4_500 } } } },
    ),
  );
  assert.deepEqual(
    opencode.tools.map((t) => [t.id, t.name, t.isError, t.exitCode, t.startMs, t.endMs, t.output]),
    [
      ["c1", "bash", false, 0, 1_000, 3_000, "a\n"],
      ["c2", "edit", true, undefined, 4_000, 4_500, "denied"],
    ],
  );

  const codex = transcriptFacts(
    jsonl(
      { type: "thread.started", thread_id: "t" },
      { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } },
      { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", aggregated_output: "x", exit_code: 2, status: "failed" } },
      { type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "gh", tool: "search", arguments: { q: 1 }, status: "completed", result: { content: [{ type: "text", text: "found" }] } } },
      { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "hi" } },
    ),
  );
  assert.deepEqual(
    codex.tools.map((t) => [t.id, t.name, t.callLine, t.resultLine, t.isError, t.exitCode, t.output]),
    [
      ["item_1", "command_execution", 1, 2, true, 2, "x"],
      ["item_2", "gh.search", 3, 3, false, undefined, "found"],
    ],
  );
});

test("execute_tool spans under their agent: ids, ok and error, a subagent's calls under its Task call, estimated times", () => {
  const events = [
    at(0, "agent_started", { agentId: 1, label: "fix", adapter: "claude" }),
    at(10, "agent_finished", { agentId: 1, label: "fix", adapter: "claude", attempts: 2 }),
    at(20, "agent_started", { agentId: 2, label: "oc", adapter: "opencode" }),
    at(30, "agent_finished", { agentId: 2, label: "oc", adapter: "opencode", attempts: 1 }),
  ];
  const opencode = jsonl({
    type: "tool_use",
    part: { callID: "c1", tool: "bash", state: { status: "completed", input: {}, output: "", time: { start: (T0 + 22) * 1000, end: (T0 + 25) * 1000 } } },
  });
  const trace = runTrace(record(events, { transcript: (id) => (id === 1 ? CLAUDE : id === 2 ? opencode : null) }));
  const agent = named(trace, "invoke_agent fix");
  assert.equal(attrs(agent)["gen_ai.response.model"], "claude-sonnet-4-5-20250929");
  assert.equal(attrs(agent)["gen_ai.request.model"], "claude-sonnet-4-5", "the configured model, when the call named none");
  assert.equal(attrs(agent)["gen_ai.conversation.id"], "sess-2");

  const bash = named(trace, "execute_tool Bash");
  assert.equal(bash.parentSpanId, agent.spanId);
  assert.equal(bash.spanId, spanIdOf(RUN, "tool/1/0"));
  assert.deepEqual(attrs(bash), {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "Bash",
    "gen_ai.tool.call.id": "toolu_1",
    "gen_ai.agent.name": "fix",
    "process.exit.code": 1,
    "odw.timing.estimated": true,
    "error.type": "tool_error",
  });
  assert.deepEqual(bash.status, { code: 2 });
  // Placed by line: 10 lines over 10s, the call on line 1 and its result on line 2.
  assert.equal(seconds(bash.startTimeUnixNano), T0 + 1.5);
  assert.equal(seconds(bash.endTimeUnixNano), T0 + 2.5);
  assert.equal(named(trace, "execute_tool Edit").status, undefined, "a tool that worked: status unset");
  assert.equal(named(trace, "execute_tool Read").parentSpanId, named(trace, "execute_tool Task").spanId);

  const reported = named(trace, "execute_tool bash");
  assert.equal(reported.parentSpanId, named(trace, "invoke_agent oc").spanId);
  assert.equal(seconds(reported.startTimeUnixNano), T0 + 22, "opencode's own times");
  assert.equal(seconds(reported.endTimeUnixNano), T0 + 25);
  assert.equal(attrs(reported)["odw.timing.estimated"], undefined);
});

// --- content -------------------------------------------------------------------------

test("content capture: off by default; on, replies, tool input and output, errors and payloads — redacted and cut", () => {
  const long = "x".repeat(CONTENT_MAX_CHARS + 500);
  const events = [
    ...EVENTS.slice(0, -1),
    at(42, "agent_started", { agentId: 5, label: "fix", adapter: "claude" }),
    at(43, "agent_finished", { agentId: 5, label: "fix", adapter: "claude", attempts: 1 }),
  ];
  const fixture = record(events, {
    result: () => ({ verdict: "ship" }),
    agentResult: (id) =>
      id === 1
        ? { agentId: 1, key: "k", label: "find", phase: "Search", adapter: "claude", attempts: 1, startedAt: 0, finishedAt: 1, value: "the answer, with SECRET-IN-REPLY" }
        : id === 5
          ? { agentId: 5, key: "k", label: "fix", phase: null, adapter: "claude", attempts: 1, startedAt: 0, finishedAt: 1, value: long }
          : null,
    transcript: (id) => (id === 5 ? CLAUDE : null),
  });
  const off = JSON.stringify(runTrace(fixture));
  for (const key of ["gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "process.command_line", "odw.checkpoint.payload", "odw.checkpoint.note"]) {
    assert.ok(!off.includes(key), `${key} is content: left out by default`);
  }
  assert.doesNotMatch(off, /"message"/, "no status descriptions either");

  const trace = runTrace(fixture, { captureContent: true, redact: (text) => text.replaceAll("SECRET-IN-REPLY", "«redacted:env:API_KEY»") });
  const find = attrs(named(trace, "invoke_agent find"));
  assert.deepEqual(JSON.parse(String(find["gen_ai.output.messages"])), [
    { role: "assistant", parts: [{ type: "text", content: "the answer, with «redacted:env:API_KEY»" }] },
  ]);
  const cut = JSON.parse(String(attrs(named(trace, "invoke_agent fix"))["gen_ai.output.messages"]))[0].parts[0].content as string;
  assert.equal(cut, `${"x".repeat(CONTENT_MAX_CHARS)}…`, "cut at the limit, the cut marked");
  assert.equal(named(trace, "invoke_agent check").status?.message, "AdapterExecutionError: adapter 'codex' is out of usage quota: you've hit your usage limit");
  const bash = named(trace, "execute_tool Bash");
  assert.equal(attrs(bash)["gen_ai.tool.call.arguments"], JSON.stringify({ command: "npm test" }));
  assert.equal(attrs(bash)["gen_ai.tool.call.result"], undefined, "a failed tool's output is its status description");
  assert.equal(bash.status?.message, "Exit code 1\nnot ok 1");
  assert.equal(attrs(named(trace, "execute_tool Edit"))["gen_ai.tool.call.result"], "updated");
  assert.equal(attrs(named(trace, "exec npm test"))["process.command_line"], "npm test -- --token=CMD-SECRET");
  const checkpoint = attrs(named(trace, "checkpoint Ship it?"));
  assert.equal(checkpoint["odw.checkpoint.payload"], JSON.stringify({ plan: "the plan" }));
  assert.equal(checkpoint["odw.checkpoint.note"], "looks right");
  assert.deepEqual(JSON.parse(String(attrs(named(trace, "invoke_workflow review"))["gen_ai.output.messages"])), [
    { role: "assistant", parts: [{ type: "text", content: JSON.stringify({ verdict: "ship" }) }] },
  ]);
  assert.doesNotMatch(JSON.stringify(trace), /ARGS-SECRET-VALUE/, "never the args, content or not");
});

test("clip never cuts a redaction marker or a surrogate pair in half", () => {
  assert.equal(clip("abc", 5), "abc");
  assert.equal(clip("abcdef", 3), "abc…");
  assert.equal(clip("ab«redacted:env:API_KEY» tail", 6), "ab…");
  assert.equal(clip("a😀b", 2), "a…");
});

// --- OTLP/JSON -------------------------------------------------------------------------

test("valid OTLP/JSON: hex ids of the right length, nanosecond strings, typed attribute values, a tree", () => {
  const trace = runTrace(record(EVENTS, { transcript: (id) => (id === 1 ? CLAUDE : null) }), {
    resource: { "service.name": "pipeline", "deployment.environment": "ci" },
    version: "0.5.0",
  });
  assert.deepEqual(attrs(trace.resourceSpans[0]!.resource), { "service.name": "pipeline", "deployment.environment": "ci" });
  assert.deepEqual(trace.resourceSpans[0]!.scopeSpans[0]!.scope, { name: "odw", version: "0.5.0" });
  const spans = spansOf(trace);
  const ids = new Set(spans.map((s) => s.spanId));
  assert.equal(ids.size, spans.length, "span ids are unique");
  const checkValue = (value: OtlpAnyValue, where: string): void => {
    const kinds = Object.keys(value);
    assert.equal(kinds.length, 1, `${where}: one value field`);
    if (value.stringValue !== undefined) assert.equal(typeof value.stringValue, "string");
    else if (value.intValue !== undefined) assert.match(value.intValue, /^-?\d+$/, `${where}: int64 as a decimal string`);
    else if (value.doubleValue !== undefined) assert.ok(Number.isFinite(value.doubleValue));
    else if (value.boolValue !== undefined) assert.equal(typeof value.boolValue, "boolean");
    else for (const item of value.arrayValue!.values) checkValue(item, where);
  };
  for (const span of spans) {
    assert.match(span.traceId, /^[0-9a-f]{32}$/);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);
    if (span.parentSpanId !== undefined) assert.ok(ids.has(span.parentSpanId), `${span.name}: its parent is in the trace`);
    assert.match(span.startTimeUnixNano, /^\d{19}$/);
    assert.match(span.endTimeUnixNano, /^\d{19}$/);
    assert.ok(BigInt(span.startTimeUnixNano) <= BigInt(span.endTimeUnixNano), `${span.name}: starts before it ends`);
    assert.ok(span.kind === 1 || span.kind === 3);
    for (const a of span.attributes) checkValue(a.value, `${span.name} ${a.key}`);
    for (const e of span.events ?? []) assert.match(e.timeUnixNano, /^\d{19}$/);
    if (span.status) assert.equal(span.status.code, 2);
  }
  assert.equal(spans.filter((s) => s.parentSpanId === undefined).length, 1, "one root");
  assert.equal(nanos(1.5), "1500000000");
});

test("ids are derived from the run id: exporting twice yields the same trace; a resumed run links to its source", () => {
  const once = JSON.stringify(runTrace(record(EVENTS)));
  assert.equal(JSON.stringify(runTrace(record(EVENTS))), once);
  assert.notEqual(traceIdOf(RUN), traceIdOf("20261017-101500-ab12ce"));
  const resumed = record(EVENTS);
  resumed.meta = { ...resumed.meta, resumedFrom: "20261016-000000-aaaaaa" };
  const root = named(runTrace(resumed), "invoke_workflow review");
  assert.deepEqual(root.links, [
    {
      traceId: traceIdOf("20261016-000000-aaaaaa"),
      spanId: spanIdOf("20261016-000000-aaaaaa", "run"),
      attributes: [{ key: "odw.link", value: { stringValue: "resumed_from" } }],
    },
  ]);
});

test("a run still going ends its open spans at its last event", () => {
  const events = [at(1, "agent_started", { agentId: 1, label: "slow", adapter: "claude" }), at(7, "log", { message: "still going" })];
  const trace = runTrace(record(events, {}, "running"));
  assert.equal(seconds(named(trace, "invoke_agent slow").endTimeUnixNano), T0 + 7);
  assert.equal(attrs(named(trace, "invoke_agent slow"))["odw.agent.state"], "running");
  assert.equal(seconds(named(trace, "invoke_workflow review").endTimeUnixNano), T0 + 7);
});

test("gen_ai.provider.name: the conventions' value for the CLIs that have one, else the adapter's name", () => {
  assert.equal(providerName("claude"), "anthropic");
  assert.equal(providerName("codex"), "openai");
  assert.equal(providerName("gemini"), "gcp.gemini");
  assert.equal(providerName("kimi"), "moonshot_ai");
  assert.equal(providerName("opencode"), "opencode");
  assert.equal(providerName("fast-claude", "/usr/local/bin/claude"), "anthropic", "by the command it runs");
  assert.equal(providerName("mine", "C:\\tools\\codex.cmd"), "openai");
  assert.equal(providerName(null), "unknown");
});
