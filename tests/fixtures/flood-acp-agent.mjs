#!/usr/bin/env node
// A fake ACP agent that floods its client, for the ACP adapter's bounds tests.
// Never a real agent. `node flood-acp-agent.mjs <mode> <count> <chars>`:
//
//   message   <count> agent_message_chunks of <chars> characters, then ends the turn
//   thought   <count> agent_thought_chunks of <chars> characters, then a short reply
//   denied    <count> execute permission requests (refused at read), then a short reply

import { createInterface } from "node:readline";

const [mode = "message", countArg = "8", charsArg = "1048576"] = process.argv.slice(2);
const count = Number(countArg);
const chunk = "A".repeat(Number(charsArg));
const send = (message) =>
  new Promise((resolve) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n", resolve));
const update = (u) => send({ method: "session/update", params: { sessionId: "s", update: u } });
let nextId = 1000;

createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1 } });
  if (m.method === "session/new") return send({ id: m.id, result: { sessionId: "s" } });
  if (m.method !== "session/prompt") return;
  for (let i = 0; i < count; i++) {
    if (mode === "message") await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
    else if (mode === "thought") await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk } });
    else {
      const toolCall = { toolCallId: `x${i}`, title: `run ${i}`, kind: "execute" };
      await send({ id: nextId++, method: "session/request_permission", params: { sessionId: "s", toolCall, options: [{ optionId: "r", kind: "reject_once" }] } });
    }
  }
  if (mode !== "message") await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
  await send({ id: m.id, result: { stopReason: "end_turn" } });
});
