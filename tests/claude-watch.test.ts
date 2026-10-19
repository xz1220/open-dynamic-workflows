import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";
import { ClaudeRunSource, encodeProjectDir } from "../src/runtime/claude-run-source.js";
import { claudeAgentLogs, claudeLogs, claudeStatus, EventPrinter, isClaudeRunId, matchClaudeAgents } from "../src/runtime/claude-watch.js";
import { detectCaps } from "../src/tty.js";

// U5 (ODW extension): `odw status|logs|attach <cc-…>` read Claude Code's own
// workflow runs, read-only, from the store the dashboard reads.

const CWD = "/Users/test/watched";
const jsonl = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const caps = detectCaps({ isTTY: false }, { FORCE_COLOR: "0", LC_ALL: "C.UTF-8" });

interface Fx {
  root: string; // the CLAUDE_CONFIG_DIR
  projects: string;
  sess: string;
  live: string; // the live run's dir
}

/** A Claude config dir with one terminal run and one live run (two agents: one done, one running). */
function fixture(): Fx {
  const root = mkdtempSync(join(tmpdir(), "odw-cc-watch-"));
  const projects = join(root, "projects");
  const sess = join(projects, encodeProjectDir(CWD), "5fe06326-session");
  mkdirSync(join(sess, "workflows", "scripts"), { recursive: true });
  writeFileSync(
    join(sess, "workflows", "wf_done1.json"),
    JSON.stringify({
      status: "completed",
      workflowName: "audit",
      startTime: 1780000000000,
      durationMs: 60000,
      logs: ["confirmed 3"],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Find" },
        { type: "workflow_agent", label: "find:a", phaseTitle: "Find", agentId: "aaa111", state: "done", startedAt: 1780000001000, durationMs: 5000 },
        { type: "workflow_agent", label: "find:b", phaseTitle: "Find", agentId: "../escape", state: "failed", startedAt: 1780000001000, durationMs: 5000 },
      ],
    }),
  );
  const done = join(sess, "subagents", "workflows", "wf_done1");
  mkdirSync(done, { recursive: true });
  writeFileSync(
    join(done, "agent-aaa111.jsonl"),
    jsonl(
      { type: "user", message: { role: "user", content: "Look for bugs." } },
      { type: "attachment", attachment: { type: "environment" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Reading the code." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb\n" }] } },
    ),
  );
  writeFileSync(join(sess, "workflows", "scripts", "review-wf_live1.js"), "export const meta = { name: 'review' }");
  const live = join(sess, "subagents", "workflows", "wf_live1");
  mkdirSync(live, { recursive: true });
  writeFileSync(
    join(live, "journal.jsonl"),
    jsonl(
      { type: "launched" },
      { type: "started", key: "v2:k1", agentId: "bbb222", label: "verify:x", phase: "Verify" },
      { type: "started", key: "v2:k2", agentId: "ccc333", label: "verify:y", phase: "Verify" },
      { type: "result", key: "v2:k1", agentId: "bbb222", result: {} },
    ),
  );
  writeFileSync(join(live, "agent-ccc333.jsonl"), jsonl({ type: "assistant", message: { content: [{ type: "text", text: "Checking y." }] } }));
  return { root, projects, sess, live };
}

function sink() {
  const chunks: string[] = [];
  return { write: (s: string) => (chunks.push(s), true), text: () => chunks.join("") };
}

async function until(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

let fx: Fx;
before(() => {
  fx = fixture();
});
after(() => rmSync(fx.root, { recursive: true, force: true }));

const source = () => new ClaudeRunSource({ projectsRoot: fx.projects, cwd: CWD, scope: "all" });

test("isClaudeRunId: a cc- id that is one safe path segment", () => {
  assert.equal(isClaudeRunId("cc-wf_abc-12"), true);
  assert.equal(isClaudeRunId("20261019-000000-abcdef"), false);
  assert.equal(isClaudeRunId("cc-../x"), false);
  assert.equal(isClaudeRunId(undefined), false);
});

test("agentRefs: a terminal run's agents with their ids and transcripts; an unsafe id names no file", () => {
  const refs = source().agentRefs("cc-wf_done1")!;
  assert.deepEqual(
    refs.map((a) => [a.label, a.phase, a.state, a.agentId]),
    [
      ["find:a", "Find", "done", "aaa111"],
      ["find:b", "Find", "failed", null],
    ],
  );
  assert.equal(refs[0]!.transcript, join(fx.sess, "subagents", "workflows", "wf_done1", "agent-aaa111.jsonl"));
  assert.equal(refs[1]!.transcript, null);
  assert.equal(source().agentRefs("cc-wf_nope"), null);
});

test("a live run's agents carry the labels and phases its journal gave them; its events show each settle", () => {
  const src = source();
  const refs = src.agentRefs("cc-wf_live1")!;
  assert.deepEqual(
    refs.map((a) => [a.label, a.phase, a.state, a.agentId]),
    [
      ["verify:x", "Verify", "done", "bbb222"],
      ["verify:y", "Verify", "running", "ccc333"],
    ],
  );
  const detail = src.detail("cc-wf_live1")!;
  assert.deepEqual(detail.agents.map((a) => a.label).sort(), ["verify:x", "verify:y"]);
  const evs = src.eventLog("cc-wf_live1").map((e) => `${e.type}:${e.label ?? ""}`);
  assert.deepEqual(evs, ["run_started:", "agent_started:verify:y", "agent_started:verify:x", "agent_finished:verify:x"]);
});

test("claudeStatus prints the run, read-only, and a line per agent with the id --agent takes", () => {
  const out = sink();
  const err = sink();
  assert.equal(claudeStatus(source(), "cc-wf_live1", { out, err }), 0);
  const text = out.text();
  assert.match(text, /^cc-wf_live1 {2}\[running\] {2}review\n/);
  assert.match(text, /read-only here/);
  assert.match(text, /running +ccc333 +verify:y {2}\(Verify\)/);
  assert.match(text, /odw logs cc-wf_live1 --agent <id\|label>/);
  assert.equal(claudeStatus(source(), "cc-wf_gone", { out: sink(), err }), 1);
  assert.match(err.text(), /no such run: cc-wf_gone/);
});

test("EventPrinter prints a rebuilt list's new events once, repeats of a like event too", () => {
  const p = new EventPrinter();
  const a = { type: "agent_started", ts: 1, label: "x" };
  assert.equal(p.next([a]).length, 1);
  assert.equal(p.next([a]).length, 0);
  assert.equal(p.next([a, { ...a }]).length, 1); // a second agent with the same label
});

test("claudeLogs --follow prints each new event once and ends with the run (exit 0 when it completed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cc-follow-"));
  try {
    const sess = join(dir, encodeProjectDir(CWD), "sess-1");
    const live = join(sess, "subagents", "workflows", "wf_f1");
    mkdirSync(live, { recursive: true });
    mkdirSync(join(sess, "workflows"), { recursive: true });
    writeFileSync(join(live, "journal.jsonl"), jsonl({ type: "started", key: "k1", agentId: "a1", label: "one", phase: "P" }));
    const src = new ClaudeRunSource({ projectsRoot: dir, cwd: CWD });
    const out = sink();
    const done = claudeLogs(src, "cc-wf_f1", true, { out, err: sink(), pollMs: 20 });
    await until(() => out.text().includes("one"), "the first agent");
    appendFileSync(join(live, "journal.jsonl"), jsonl({ type: "started", key: "k2", agentId: "a2", label: "two" }));
    await until(() => out.text().includes("two"), "the second agent");
    // Claude Code writes the terminal journal: the run is done.
    writeFileSync(
      join(sess, "workflows", "wf_f1.json"),
      JSON.stringify({
        status: "completed",
        workflowName: "f",
        startTime: Date.now(),
        durationMs: 10,
        workflowProgress: [
          { type: "workflow_agent", label: "one", phaseTitle: "P", agentId: "a1", state: "done" },
          { type: "workflow_agent", label: "two", agentId: "a2", state: "done" },
        ],
      }),
    );
    assert.equal(await done, 0);
    const lines = out.text().trim().split("\n");
    assert.equal(lines.filter((l) => /agent_started .*\bone$/.test(l)).length, 1, out.text());
    assert.equal(lines.filter((l) => /agent_started +two$/.test(l)).length, 1, out.text());
    assert.ok(lines.some((l) => /agent_finished .*two/.test(l)));
    assert.match(lines.at(-1)!, /run_finished/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matchClaudeAgents: by id, by an id prefix of 6+, else by label", () => {
  const refs = source().agentRefs("cc-wf_live1")!;
  assert.deepEqual(matchClaudeAgents(refs, "ccc333").map((a) => a.label), ["verify:y"]);
  assert.deepEqual(matchClaudeAgents(refs, "verify:x").map((a) => a.agentId), ["bbb222"]);
  assert.deepEqual(matchClaudeAgents(refs, "ccc").map((a) => a.label), []); // too short a prefix
});

test("claudeAgentLogs prints a transcript's messages, not its attachments; --raw prints every line", async () => {
  const out = sink();
  const code = await claudeAgentLogs(source(), "cc-wf_done1", "find:a", { out, err: sink(), raw: false, follow: false, caps, width: 120 });
  assert.equal(code, 0);
  assert.equal(out.text(), ["· Look for bugs.", "Reading the code.", "▸ Bash  ls", "✓ Bash result (2 lines)", ""].join("\n"));
  const raw = sink();
  await claudeAgentLogs(source(), "cc-wf_done1", "aaa111", { out: raw, err: sink(), raw: true, follow: false, caps, width: 120 });
  assert.match(raw.text(), /"attachment"/);
  const err = sink();
  assert.equal(await claudeAgentLogs(source(), "cc-wf_done1", "find:b", { out: sink(), err, raw: false, follow: false, caps, width: 120 }), 1);
  assert.match(err.text(), /no transcript to read/);
});

test("claudeAgentLogs --follow prints what the agent adds until it settles", async () => {
  const out = sink();
  const done = claudeAgentLogs(source(), "cc-wf_live1", "verify:y", { out, err: sink(), raw: false, follow: true, caps, width: 120, pollMs: 20 });
  await until(() => out.text().includes("Checking y."), "the transcript so far");
  appendFileSync(join(fx.live, "agent-ccc333.jsonl"), jsonl({ type: "assistant", message: { content: [{ type: "text", text: "Found it." }] } }));
  await until(() => out.text().includes("Found it."), "the appended line");
  appendFileSync(join(fx.live, "journal.jsonl"), jsonl({ type: "result", key: "v2:k2", agentId: "ccc333", result: {} }));
  assert.equal(await done, 0);
  assert.match(out.text(), /── verify:y: done ──\n$/);
});

test("odw status|logs <cc-…> through the CLI read CLAUDE_CONFIG_DIR's runs", async () => {
  const saved = { dir: process.env.CLAUDE_CONFIG_DIR, color: process.env.FORCE_COLOR };
  process.env.CLAUDE_CONFIG_DIR = fx.root;
  process.env.FORCE_COLOR = "0";
  const out: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: unknown) => (out.push(String(s)), true);
  try {
    assert.equal(await main(["status", "cc-wf_done1"]), 0);
    assert.equal(await main(["logs", "cc-wf_done1"]), 0);
    assert.equal(await main(["logs", "cc-wf_done1", "--agent", "find:a"]), 0);
  } finally {
    process.stdout.write = so;
    if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.dir;
    if (saved.color === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = saved.color;
  }
  const text = out.join("");
  assert.match(text, /cc-wf_done1 {2}\[done\] {2}audit/);
  assert.match(text, /log +confirmed 3/);
  assert.match(text, /Reading the code\./);
});
