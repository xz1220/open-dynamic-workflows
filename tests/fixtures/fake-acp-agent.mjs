#!/usr/bin/env node
// A fake Agent Client Protocol agent (https://agentclientprotocol.com) for the
// ACP adapter tests: JSON-RPC 2.0 over stdio, one message per line. Never a
// real agent. `node fake-acp-agent.mjs <scenario>`; every message the client
// sends is appended to $FAKE_ACP_LOG (JSONL) when it is set.
//
//   reply        a thought, a read tool call (asks; allowed under any tier),
//                its result, a usage_update with a USD cost, then the reply
//                "ACP-OK <the prompt's last word>" and a draft `usage`
//   permissions  asks for read, fetch, edit, execute and switch_mode tool
//                calls in turn; replies with what each was answered
//   web          asks for read, fetch and search tool calls; replies with the answers
//   no-reject    asks for an execute call offering only allow options
//   unasked      reports an edit tool call that completed without asking
//   unasked-kinds  reports read, search, think, fetch, other, switch_mode, unknown and
//                kindless tool calls that completed without asking
//   auth         session/new fails with auth_required (-32000)
//   version      initialize answers protocol version 2
//   hang         never ends the turn; a session/cancel is logged
//   crash        exits 3 in the middle of the turn
//   linger       ends the turn but ignores its stdin closing
//   fs           asks the client for fs/read_text_file; replies with the error code
//   max_tokens   ends the turn with stopReason max_tokens

import { appendFileSync } from "node:fs";

const scenario = process.argv[2] ?? "reply";
const log = process.env.FAKE_ACP_LOG;
let nextId = 1000;
const waiting = new Map();
let sessionId = null;

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (u) => send({ method: "session/update", params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const permission = (toolCallId, title, kind, options = STANDARD_OPTIONS) =>
  ask("session/request_permission", { sessionId, toolCall: { toolCallId, title, kind, rawInput: { command: title } }, options });

const STANDARD_OPTIONS = [
  { optionId: "ao", name: "Allow once", kind: "allow_once" },
  { optionId: "aa", name: "Allow always", kind: "allow_always" },
  { optionId: "ro", name: "Reject once", kind: "reject_once" },
  { optionId: "ra", name: "Reject always", kind: "reject_always" },
];

const outcome = (answer) => (answer.result?.outcome?.outcome === "selected" ? answer.result.outcome.optionId : "cancelled");

async function turn(id, prompt) {
  const words = prompt.trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  switch (scenario) {
    case "reply": {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking " } });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "it over." } });
      update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Let me look." } });
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read README.md", kind: "read", status: "pending", rawInput: { path: "README.md" } });
      const read = await permission("t1", "Read README.md", "read");
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: outcome(read) === "ao" ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: "# readme" } }],
      });
      update({ sessionUpdate: "plan", entries: [{ content: "answer", priority: "high", status: "completed" }] });
      update({ sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.02, currency: "USD" } });
      update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "ACP-OK " } });
      update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: last } });
      return send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 } } });
    }
    case "permissions": {
      const answers = [];
      for (const kind of ["read", "fetch", "edit", "execute", "switch_mode"]) {
        update({ sessionUpdate: "tool_call", toolCallId: `t-${kind}`, title: `do ${kind}`, kind, status: "pending" });
        answers.push(`${kind}=${outcome(await permission(`t-${kind}`, `do ${kind}`, kind))}`);
      }
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answers.join(" ") } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "web": {
      const answers = [];
      for (const kind of ["read", "fetch", "search"]) {
        answers.push(`${kind}=${outcome(await permission(`w-${kind}`, `do ${kind}`, kind))}`);
      }
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answers.join(" ") } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "no-reject": {
      const answer = await permission("t1", "rm -rf build", "execute", STANDARD_OPTIONS.slice(0, 2));
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `execute=${outcome(answer)}` } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "unasked": {
      update({ sessionUpdate: "tool_call", toolCallId: "w1", title: "Write notes.txt", kind: "edit", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed", content: [{ type: "diff", path: "/tmp/notes.txt", oldText: null, newText: "x" }] });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrote it" } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "unasked-kinds": {
      // Tool calls of every kind that ran without asking: what only looks is not reported, anything else beyond the tier is.
      for (const kind of ["read", "search", "think", "fetch", "other", "switch_mode", "made-up"]) {
        update({ sessionUpdate: "tool_call", toolCallId: `u-${kind}`, title: `ran ${kind}`, kind, status: "completed" });
      }
      update({ sessionUpdate: "tool_call", toolCallId: "u-none", title: "ran nameless", status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ran them" } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "hang":
      // As agents do, it stops its work on SIGTERM in its own time: the cancel before it gets read.
      process.on("SIGTERM", () => {});
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working…" } });
      setInterval(() => {}, 1000);
      return;
    case "crash":
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "about to" } });
      process.stderr.write("fake agent: something broke\n");
      setTimeout(() => process.exit(3), 20);
      return;
    case "linger":
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP-LINGER" } });
      send({ id, result: { stopReason: "end_turn" } });
      process.stdin.removeAllListeners("end");
      setInterval(() => {}, 1000);
      return;
    case "fs": {
      const answer = await ask("fs/read_text_file", { sessionId, path: "/etc/hostname" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fs=${answer.error?.code ?? "answered"}` } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "max_tokens":
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
      return send({ id, result: { stopReason: "max_tokens" } });
    default:
      return send({ id, error: { code: -32603, message: `unknown scenario ${scenario}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (log) appendFileSync(log, JSON.stringify(message) + "\n");
    if (message.method === undefined) {
      const resolve = waiting.get(message.id);
      waiting.delete(message.id);
      resolve?.(message);
      continue;
    }
    switch (message.method) {
      case "initialize":
        send({
          id: message.id,
          result: {
            protocolVersion: scenario === "version" ? 2 : 1,
            agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
            agentInfo: { name: "fake-acp", title: "Fake ACP Agent", version: "0.0.1" },
            authMethods: [{ id: "fake-login", name: "Log in" }],
          },
        });
        break;
      case "session/new":
        if (scenario === "auth") {
          send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
          break;
        }
        sessionId = "sess-1";
        send({ id: message.id, result: { sessionId } });
        break;
      case "session/prompt": {
        const text = (message.params.prompt ?? []).map((b) => b.text ?? "").join("");
        void turn(message.id, text);
        break;
      }
      case "session/cancel":
        break; // logged above
      default:
        if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
