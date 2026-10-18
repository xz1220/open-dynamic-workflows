import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { CliResult } from "../src/adapters/types.js";
import type { WorkflowEvent } from "../src/events.js";
import { diffStat, HANDOFF_HEADER, HANDOFF_MAX_BYTES, handoffBrief, HandoffLog, planText } from "../src/handoff.js";
import { RunStore } from "../src/runtime/run-store.js";
import { normalizeTranscript } from "../src/runtime/transcript-view.js";
import { executeRun } from "../src/runtime/worker.js";

// A fallback that hands the work over (ODW extension): the next adapter goes on
// in the worktree the last one left, its prompt starting with a brief of what
// that one did — kept as agents/<id>.handoff.md, told by a `handoff` event and
// a transcript line — and `expect` and the kept diff judge the final state.
// Off (the default), a fallback starts the work over, as before.

const POSIX_ONLY = { skip: process.platform === "win32" };
const AGENT = fileURLToPath(new URL("./fixtures/handoff-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-handoff-src-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "repo\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return dir;
}

function worktrees(repo: string): number {
  return git(repo, "worktree", "list", "--porcelain").trim().split("\n\n").length;
}

interface Flow {
  id: string;
  state: string;
  store: RunStore;
  prompts: string;
  root: string;
}

/**
 * Run `body` over `source` with two adapters of the fixture: `quit` (spends
 * its quota halfway) falls back to `finish` (or to `chain`). `handoff` is the
 * `fallback.handoff` setting.
 */
async function runFlow(opts: {
  source: string;
  body: string;
  handoff?: boolean;
  chain?: string[];
  /** More adapters: a fixture mode each, with fields over it. */
  adapters?: Record<string, { mode: string } & Record<string, unknown>>;
  /** The start adapter (default quit). */
  start?: string;
  settings?: Record<string, unknown>;
}): Promise<Flow> {
  const root = mkdtempSync(join(tmpdir(), "odw-handoff-run-"));
  const prompts = join(root, "prompts");
  mkdirSync(prompts);
  const cli = (mode: string, env: Record<string, string> = {}) => ({
    command: [execPath, AGENT, mode],
    stdin: "{prompt}",
    env: { HANDOFF_PROMPT_DIR: prompts, ...env },
  });
  const more = Object.fromEntries(
    Object.entries(opts.adapters ?? {}).map(([name, { mode, env, ...fields }]) => [name, { ...cli(mode, env as Record<string, string>), ...fields }]),
  );
  const start = opts.start ?? "quit";
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: start,
      fallback: { [start]: opts.chain ?? ["finish"], ...(opts.handoff !== undefined ? { handoff: opts.handoff } : {}) },
      adapters: { quit: cli("quit"), quit2: cli("quit"), finish: cli("finish"), ...more },
      ...opts.settings,
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${opts.body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: opts.source, configPath });
  return { id, state: await executeRun(store.runDir(id)), store, prompts, root };
}

function prompt(flow: Flow, mode: string): string {
  return readFileSync(join(flow.prompts, `${mode}.txt`), "utf8");
}

function ofType(flow: Flow, type: string): WorkflowEvent[] {
  return flow.store.readEvents(flow.id).filter((e) => e.type === type);
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

// --- end to end -----------------------------------------------------------------------

test("handoff: a quota failure after partial edits hands the worktree and a brief to the fallback", POSIX_ONLY, async () => {
  const src = makeRepo();
  let flow: Flow | undefined;
  try {
    flow = await runFlow({ source: src, handoff: true, body: "return await agent('build it', { isolation: 'worktree' })\n" });
    assert.equal(flow.state, "done");
    // The fallback found the partial edits in its worktree, and the brief in its prompt.
    assert.equal(flow.store.readResult(flow.id), "partial:yes brief:yes");
    const brief = readFileSync(flow.store.agentHandoffPath(flow.id, 1), "utf8").trimEnd();
    assert.ok(brief.startsWith(HANDOFF_HEADER), brief);
    assert.match(brief, /It ran on quit and stopped before it finished — its usage quota ran out — so the work moved to you \(finish\)/);
    assert.match(brief, /### Why it stopped\nadapter 'quit' ran out of usage quota/);
    assert.match(brief, /### Files it changed \(diff stat\)\n partial\.txt \| \+1 -0/);
    assert.match(brief, /### The end of its output\n> Plan: write partial\.txt, then done\.txt\n> wrote partial\.txt/);
    const given = prompt(flow, "finish");
    assert.ok(given.includes(brief), "the brief starts the fallback's prompt");
    assert.ok(given.indexOf(brief) < given.indexOf("build it"), "ahead of the task");
    assert.ok(!prompt(flow, "quit").includes(HANDOFF_HEADER), "the first adapter got no brief");

    const [handoff] = ofType(flow, "handoff");
    assert.ok(handoff, "a handoff event");
    assert.deepEqual(
      [handoff.agentId, handoff.from, handoff.to, handoff.reason, handoff.bytes, handoff.saved],
      [1, "quit", "finish", "quota", Buffer.byteLength(brief), true],
    );
    const [finished] = ofType(flow, "agent_finished");
    assert.deepEqual([finished!.adapter, finished!.fellBackFrom], ["finish", ["quit"]]);
    // The kept diff is the shared worktree's, from its base: both adapters' work.
    const diff = readFileSync(flow.store.agentDiffPath(flow.id, 1), "utf8");
    assert.match(diff, /^diff --git a\/partial\.txt b\/partial\.txt$/m);
    assert.match(diff, /^diff --git a\/done\.txt b\/done\.txt$/m);
    assert.deepEqual(finished!.changes, { files: 2, insertions: 2, deletions: 0, truncated: false });

    // The transcript marks the handoff, its brief folded in, before the fallback's attempt line.
    const entries = normalizeTranscript(readFileSync(flow.store.agentTranscriptPaths(flow.id, 1).transcript, "utf8"));
    const at = entries.findIndex((e) => e.kind === "handoff");
    assert.ok(at > 0, "a handoff entry after the first run's output");
    const entry = entries[at]!;
    assert.deepEqual([entry.from, entry.adapter, entry.reason, entry.bytes], ["quit", "finish", "quota", Buffer.byteLength(brief)]);
    assert.match(entry.text!, /^handoff from quit to finish — a brief of /);
    assert.ok(entry.output?.startsWith(HANDOFF_HEADER));
    assert.deepEqual([entries[at + 1]!.kind, entries[at + 1]!.reason], ["attempt", "fallback"]);
    assert.equal(worktrees(src), 1, "the held worktree is gone");
  } finally {
    cleanup(src, ...(flow ? [flow.root] : []));
  }
});

test("handoff off (the default) starts the work over in a fresh worktree; an agent()'s own handoff overrides the setting", POSIX_ONLY, async () => {
  const src = makeRepo();
  const flows: Flow[] = [];
  try {
    for (const [handoff, option] of [[undefined, ""], [true, ", handoff: false"]] as const) {
      const flow = await runFlow({ source: src, handoff, body: `return await agent('build it', { isolation: 'worktree'${option} })\n` });
      flows.push(flow);
      assert.equal(flow.state, "done");
      assert.equal(flow.store.readResult(flow.id), "partial:no brief:no", "as before: a fresh start");
      assert.ok(!existsSync(flow.store.agentHandoffPath(flow.id, 1)));
      assert.deepEqual(ofType(flow, "handoff"), []);
      assert.ok(!prompt(flow, "finish").includes(HANDOFF_HEADER));
      const diff = readFileSync(flow.store.agentDiffPath(flow.id, 1), "utf8");
      assert.doesNotMatch(diff, /partial\.txt/, "what the first adapter changed is not the agent's change");
      assert.match(diff, /^diff --git a\/done\.txt b\/done\.txt$/m);
    }
    const on = await runFlow({ source: src, body: "return await agent('build it', { isolation: 'worktree', handoff: true })\n" });
    flows.push(on);
    assert.equal(on.store.readResult(on.id), "partial:yes brief:yes", "handoff: true on the call, with the setting off");
    const bad = await runFlow({ source: src, body: "return await agent('build it', { handoff: 'yes' })\n" });
    flows.push(bad);
    assert.equal(bad.state, "failed", "a misuse fails the call before it starts");
    assert.match(JSON.stringify(bad.store.readError(bad.id)), /agent\(\): handoff must be true or false; got a string/);
    assert.equal(worktrees(src), 1);
  } finally {
    cleanup(src, ...flows.map((f) => f.root));
  }
});

test("handoff in place: the fallback works on in the source tree, told what the last adapter did", POSIX_ONLY, async () => {
  const src = makeRepo();
  const flows: Flow[] = [];
  try {
    const on = await runFlow({ source: src, handoff: true, body: "return await agent('build it')\n" });
    flows.push(on);
    assert.equal(on.state, "done");
    assert.equal(on.store.readResult(on.id), "partial:yes brief:yes");
    const brief = readFileSync(on.store.agentHandoffPath(on.id, 1), "utf8");
    assert.match(brief, /What it changed is already in the working tree \(it worked in place, as you do\)/);
    assert.match(brief, /### Files it edited \(from its tool calls\)\nNone yet\./, "a text CLI shows no tool calls");
    assert.ok(existsSync(join(src, "partial.txt")) && existsSync(join(src, "done.txt")));
    rmSync(join(src, "partial.txt"));
    rmSync(join(src, "done.txt"));
    const off = await runFlow({ source: src, body: "return await agent('build it')\n" });
    flows.push(off);
    assert.equal(off.store.readResult(off.id), "partial:yes brief:no", "in place, off: the edits are there, unexplained");
  } finally {
    cleanup(src, ...flows.map((f) => f.root));
  }
});

test("expect judges the state a handoff ends in: both adapters' work in the shared worktree", POSIX_ONLY, async () => {
  const src = makeRepo();
  const flows: Flow[] = [];
  const body =
    "return await agent('build it', { isolation: 'worktree', expectRetries: 0, " +
    "expect: { files: ['partial.txt', 'done.txt'], command: 'test -f partial.txt && test -f done.txt' } })\n";
  try {
    const on = await runFlow({ source: src, handoff: true, body });
    flows.push(on);
    assert.equal(on.state, "done");
    const [finished] = ofType(on, "agent_finished");
    assert.equal(finished?.adapter, "finish", "its work met the checks");
    const off = await runFlow({ source: src, body });
    flows.push(off);
    const [failed] = ofType(off, "agent_failed");
    assert.equal(failed?.reason, "unmet_expectation", "started over, the work lacks partial.txt");
    assert.match(String(failed?.error), /partial\.txt/);
    assert.equal(worktrees(src), 1);
  } finally {
    cleanup(src, ...flows.map((f) => f.root));
  }
});

test("a handoff whose chain runs out still fails the agent, keeps the latest brief, and lets the worktree go", POSIX_ONLY, async () => {
  const src = makeRepo();
  let flow: Flow | undefined;
  try {
    flow = await runFlow({ source: src, handoff: true, chain: ["quit2"], body: "return await agent('build it', { isolation: 'worktree' })\n" });
    const [failed] = ofType(flow, "agent_failed");
    assert.deepEqual([failed?.reason, failed?.adapter, failed?.fellBackFrom], ["quota", "quit2", ["quit"]]);
    assert.ok(prompt(flow, "quit").includes("build it"));
    assert.ok(readFileSync(flow.store.agentHandoffPath(flow.id, 1), "utf8").startsWith(HANDOFF_HEADER));
    // The failed agent's change is kept, as any failed agent's: the shared worktree's.
    assert.match(readFileSync(flow.store.agentDiffPath(flow.id, 1), "utf8"), /^diff --git a\/partial\.txt b\/partial\.txt$/m);
    assert.equal(worktrees(src), 1, "the held worktree was removed");
  } finally {
    cleanup(src, ...(flow ? [flow.root] : []));
  }
});

test("the fallback keeps the handed-over worktree for each of its runs: a rate-limit retry and a schema retry", POSIX_ONLY, async () => {
  const src = makeRepo();
  const flows: Flow[] = [];
  try {
    const rate = await runFlow({
      source: src,
      handoff: true,
      chain: ["flaky"],
      adapters: { flaky: { mode: "flaky" } },
      settings: { maxBackoff: 0.01 },
      body: "return await agent('build it', { isolation: 'worktree' })\n",
    });
    flows.push(rate);
    assert.equal(rate.state, "done", JSON.stringify(rate.store.readError(rate.id)));
    assert.equal(readFileSync(join(rate.prompts, "flaky.runs"), "utf8"), "2", "rate-limited once, then retried");
    // The retry found the partial work and its own first run's, in the same worktree, with the brief.
    assert.equal(rate.store.readResult(rate.id), "partial:yes brief:yes flaky:yes");

    const schema = await runFlow({
      source: src,
      handoff: true,
      chain: ["json"],
      adapters: { json: { mode: "json" } },
      body: "return await agent('build it', { isolation: 'worktree', schema: { type: 'object', required: ['partial'] } })\n",
    });
    flows.push(schema);
    assert.equal(schema.state, "done", JSON.stringify(schema.store.readError(schema.id)));
    assert.equal(readFileSync(join(schema.prompts, "json.runs"), "utf8"), "2", "a schema retry");
    assert.deepEqual(schema.store.readResult(schema.id), { partial: "yes", brief: "yes", json: "yes" });
    assert.equal(worktrees(src), 1, "the carried worktree is gone once the call ends");
  } finally {
    cleanup(src, ...flows.map((f) => f.root));
  }
});

test("a trusted adapter's worktree is not handed to an untrusted fallback: it starts fresh, with a brief that says so", POSIX_ONLY, async () => {
  const src = makeRepo();
  let flow: Flow | undefined;
  try {
    flow = await runFlow({
      source: src,
      handoff: true,
      chain: ["outsider"],
      adapters: { outsider: { mode: "finish", trust: "untrusted" } },
      body: "return await agent('build it', { isolation: 'worktree' })\n",
    });
    assert.equal(flow.state, "done", JSON.stringify(flow.store.readError(flow.id)));
    assert.equal(flow.store.readResult(flow.id), "partial:no brief:yes", "a fresh worktree, and the brief");
    const brief = readFileSync(flow.store.agentHandoffPath(flow.id, 1), "utf8");
    assert.match(brief, /What it changed was NOT carried over: it ran with other trust or in another sandbox than you do/);
    assert.match(brief, /### Files it changed \(diff stat\)\n partial\.txt \| \+1 -0/, "what it had changed is still listed");
    const notes = flow.store.readEvents(flow.id).filter((e) => e.type === "log").map((e) => String(e.message));
    assert.ok(notes.some((m) => /quit's worktree is not handed to outsider — it ran trusted\/host, outsider runs untrusted\/host/.test(m)), notes.join("\n"));
    assert.doesNotMatch(readFileSync(flow.store.agentDiffPath(flow.id, 1), "utf8"), /partial\.txt/, "the trusted run's change is not the agent's");
    assert.equal(worktrees(src), 1);
  } finally {
    cleanup(src, ...(flow ? [flow.root] : []));
  }
});

test("the brief is redacted before it is cut: no part of a secret the cut would split is left", POSIX_ONLY, async () => {
  const src = makeRepo();
  let flow: Flow | undefined;
  // Not a real credential: a value the redactor knows from the adapter's env.
  const secret = "PLACEHOLDER-not-a-real-secret-for-the-handoff-test-tail-words";
  // The brief keeps the last 1281 bytes of the output: "…" + the secret's last 31 characters + " " + pad + "\nwrote partial.txt".
  const pad = 1281 - 31 - 1 - "\nwrote partial.txt".length;
  try {
    flow = await runFlow({
      source: src,
      handoff: true,
      start: "leaky",
      adapters: { leaky: { mode: "secret", env: { HANDOFF_TOKEN: secret, HANDOFF_PAD: String(pad) } } },
      body: "return await agent('build it', { isolation: 'worktree' })\n",
    });
    assert.equal(flow.state, "done", JSON.stringify(flow.store.readError(flow.id)));
    const brief = readFileSync(flow.store.agentHandoffPath(flow.id, 1), "utf8");
    assert.match(brief, /### The end of its output\n> …/, "the output was cut");
    assert.doesNotMatch(brief, /tail-words|handoff-test/, "no end of the secret");
    assert.doesNotMatch(prompt(flow, "finish"), /tail-words|handoff-test/);
  } finally {
    cleanup(src, ...(flow ? [flow.root] : []));
  }
});

// --- the brief ------------------------------------------------------------------------

const cliEnd: CliResult = { returncode: 1, stdout: "", stderr: "", timedOut: false, duration: 1 };

/** Claude Code stream-json, as its CLI prints it. */
function claudeLines(): string[] {
  const assistant = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } });
  const result = (id: string, content: string, isError = false) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
  return [
    JSON.stringify({ type: "system", subtype: "init", model: "m", tools: [] }),
    assistant([{ type: "text", text: "I will add the parser first." }]),
    assistant([
      {
        type: "tool_use",
        id: "t1",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Add the parser", status: "completed" },
            { content: "Wire it into the CLI", status: "in_progress" },
            { content: "Write tests", status: "pending" },
          ],
        },
      },
    ]),
    assistant([{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/parse.ts", old_string: "a", new_string: "b" } }]),
    result("t2", "ok"),
    assistant([{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }]),
    result("t3", "Exit code 1\n2 passing\n1 failing: parse rejects empty input", true),
    assistant([{ type: "thinking", thinking: "secret reasoning" }]),
    assistant([{ type: "tool_use", id: "t4", name: "Bash", input: { command: "npm run build" } }]),
    result("t4", "built"),
    assistant([{ type: "text", text: "The empty-input case fails; fixing it next." }]),
    assistant([{ type: "tool_use", id: "t5", name: "Bash", input: { command: "npm test -- parse" } }]),
  ];
}

test("the brief: why it stopped, the diff stat, the last plan, the commands and how they ended, the last messages", () => {
  const log = new HandoffLog();
  log.beginRun("jsonl");
  // Chunks cut anywhere: lines are read whole.
  const text = claudeLines().join("\n") + "\n";
  for (let i = 0; i < text.length; i += 37) log.stdout(text.slice(i, i + 37));
  log.endRun(cliEnd);
  const diff =
    "diff --git a/src/parse.ts b/src/parse.ts\nindex 1..2 100644\n--- a/src/parse.ts\n+++ b/src/parse.ts\n@@ -1,2 +1,3 @@\n-a\n+b\n+c\n" +
    "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n" +
    "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
  const brief = handoffBrief({
    from: "claude",
    reason: "quota",
    to: "codex",
    why: "adapter 'claude' ran out of usage quota — wait for the window to reset",
    isolated: true,
    diff,
    log,
  });
  assert.equal(
    brief,
    [
      HANDOFF_HEADER,
      "You are continuing work another agent started on this same task. It ran on claude and stopped before it finished — " +
        "its usage quota ran out — so the work moved to you (codex). What it changed is already in your working directory " +
        "(the same worktree it worked in): check it, keep what is right, and finish the task from where it stopped rather " +
        "than starting over. Its reasoning was not kept; below is what it left behind.",
      "### Why it stopped\nadapter 'claude' ran out of usage quota — wait for the window to reset",
      "### Files it changed (diff stat)\n src/parse.ts | +2 -1\n old.ts → new.ts | +0 -0\n logo.png | binary",
      "### Its last plan\n- [x] Add the parser\n- [~] Wire it into the CLI\n- [ ] Write tests",
      "### Commands it ran (latest last)\n" +
        "- `npm test` — failed (exit 1, 3 lines): 1 failing: parse rejects empty input\n" +
        "- `npm run build` — ok (1 line)\n" +
        "- `npm test -- parse` — no result (it stopped here)",
      "### Its last messages (latest last)\n> I will add the parser first.\n\n> The empty-input case fails; fixing it next.",
      "The task follows: the same one it was given.",
    ].join("\n\n"),
  );
  assert.doesNotMatch(brief, /secret reasoning/, "thinking is not a message");
  // In place, the files are the ones its edit tool calls named.
  const inPlace = handoffBrief({ from: "claude", reason: "auth", to: "codex", why: "", isolated: false, log });
  assert.match(inPlace, /— its login was refused —/);
  assert.match(inPlace, /### Why it stopped\nits login was refused/);
  assert.match(inPlace, /### Files it edited \(from its tool calls\)\n src\/parse\.ts\n/);
});

test("the brief is capped at 6 KB, each section within its own share, the latest commands and messages kept", () => {
  const log = new HandoffLog();
  log.beginRun("jsonl");
  const lines: string[] = [];
  const steps = Array.from({ length: 300 }, (_, i) => ({ content: `step ${i} ${"x".repeat(40)}`, status: "pending" }));
  lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "p", name: "TodoWrite", input: { todos: steps } }] } }));
  for (let i = 0; i < 100; i++) {
    lines.push(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { command: `make target-${i} ${"y".repeat(200)}` } }] } }),
    );
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `message ${i} ${"z".repeat(3000)}` }] } }));
  }
  for (const line of lines) log.stdout(`${line}\n`);
  log.endRun(cliEnd);
  const diff = Array.from({ length: 500 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n@@ -1 +1 @@\n-a\n+b\n`).join("");
  const brief = handoffBrief({ from: "a", reason: "quota", to: "b", why: "w".repeat(10_000), isolated: true, diff, log });
  assert.ok(Buffer.byteLength(brief) <= HANDOFF_MAX_BYTES, `${Buffer.byteLength(brief)} bytes`);
  assert.ok(brief.startsWith(HANDOFF_HEADER));
  for (const section of ["Why it stopped", "Files it changed", "Its last plan", "Commands it ran", "Its last messages"]) {
    assert.match(brief, new RegExp(`### ${section}`), `${section} is there`);
  }
  assert.match(brief, / f0\.ts \| \+1 -1\n/);
  assert.match(brief, /… and 4\d\d more/, "the rest of the files are counted");
  assert.match(brief, /make target-99/, "the latest command");
  assert.match(brief, /… \d+ earlier not shown/);
  assert.match(brief, /message 99/, "the latest message");
  assert.doesNotMatch(brief, /message 96 /, "only the last three");
  assert.ok(brief.endsWith("The task follows: the same one it was given."), "nothing is cut off its end");
  // A CLI that prints text: the end of its output stands for its messages.
  const text = new HandoffLog();
  text.beginRun("text");
  text.endRun({ ...cliEnd, stdout: `${"early line\n".repeat(400)}the last words` });
  assert.ok(!text.empty);
  const fromText = handoffBrief({ from: "a", reason: "quota", to: "b", why: "w", isolated: true, diff: "", log: text });
  assert.match(fromText, /### Files it changed \(diff stat\)\nNone yet\./);
  assert.match(fromText, /### The end of its output\n> …[^\n]*\n> early line\n[\s\S]*\n> the last words\n/);
  assert.ok(Buffer.byteLength(fromText) <= HANDOFF_MAX_BYTES);
});

test("each piece of the brief is redacted before it is cut; a tail cut mid-line loses that line; work not carried is said", () => {
  const SECRET = "PLACEHOLDER-SECRET-not-real";
  const redact = (text: string): string => text.split(SECRET).join("«redacted:TEST»");
  const log = new HandoffLog();
  log.beginRun("jsonl");
  const plan = { todos: [{ content: `${"p".repeat(1180)} ${SECRET}`, status: "pending" }] };
  log.stdout(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "p", name: "TodoWrite", input: plan }] } }) + "\n");
  log.stdout(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: `${"c".repeat(280)} ${SECRET}` } }] } }) + "\n");
  log.stdout(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `${"m".repeat(600)} ${SECRET} ${"n".repeat(600)}` }] } }) + "\n");
  log.endRun(cliEnd);
  const why = `${"w".repeat(585)} ${SECRET}`;
  const brief = handoffBrief({ from: "a", reason: "quota", to: "b", why, isolated: true, diff: "", log, redact });
  // Cut after redaction, each section ends in (part of) the marker — never in part of the secret.
  assert.doesNotMatch(brief, /PLACEHOLDER|SECRET-not/);
  assert.doesNotMatch(brief, /not-real/);
  // Unredacted, the same cuts leave a piece of it: what the final pass over the whole brief cannot catch.
  const raw = handoffBrief({ from: "a", reason: "quota", to: "b", why, isolated: true, diff: "", log });
  assert.match(raw, /PLACEHOLDER-SEC(?!RET-not-real)/);

  // A text CLI's tail cut in the middle of a line: that line is left out.
  const text = new HandoffLog();
  text.beginRun("text");
  text.endRun({ ...cliEnd, stdout: `${"x".repeat(3000)} token=${SECRET.slice(0, 10)}\nthe last words` });
  const fromText = handoffBrief({ from: "a", reason: "quota", to: "b", why: "w", isolated: true, diff: "", log: text });
  assert.match(fromText, /### The end of its output\n> the last words\n/);

  // Isolated, but the worktree was not handed over (other trust or sandbox): the brief says so.
  const fresh = handoffBrief({ from: "a", reason: "quota", to: "b", why: "w", isolated: true, diff: "", log: text, carried: false });
  assert.match(fresh, /What it changed was NOT carried over: .* you start in a fresh one\. Below is what it did: redo what the task still needs/);
  assert.doesNotMatch(fresh, /already in your working directory/);
});

test("plans are read from Claude Code's todos, Codex's update_plan and to-do list, and a plan's text", () => {
  assert.equal(planText({ plan: [{ step: "a", status: "completed" }, { step: "b", status: "in_progress" }] }), "- [x] a\n- [~] b");
  assert.equal(planText(JSON.stringify({ todos: [{ content: "c", status: "pending" }] })), "- [ ] c");
  assert.equal(planText({ plan: "1. do it" }), "1. do it");
  assert.equal(planText("free text"), "free text");
  assert.equal(planText({ other: 1 }), null);
  const log = new HandoffLog();
  log.beginRun("jsonl");
  log.stdout(
    JSON.stringify({ type: "item.completed", item: { id: "1", type: "todo_list", items: [{ text: "x", completed: true }, { text: "y", completed: false }] } }) + "\n",
  );
  log.stdout(JSON.stringify({ type: "item.started", item: { id: "2", type: "command_execution", command: "cargo test" } }) + "\n");
  log.stdout(
    JSON.stringify({ type: "item.completed", item: { id: "2", type: "command_execution", command: "cargo test", exit_code: 0, aggregated_output: "ok\n" } }) + "\n",
  );
  log.endRun(cliEnd);
  assert.equal(log.plan, "[x] x\n[ ] y");
  assert.deepEqual(log.commands, [{ command: "cargo test", tool: "shell", outcome: "ok (exit 0, 1 line)" }]);
  assert.deepEqual(diffStat("diff --git a/a b/a\nnew file mode 100644\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+x\n"), [" a | +1 -0"]);
});

test("config: fallback.handoff turns handoff on, is no adapter of a chain, and must be a boolean", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-handoff-config-"));
  const load = (raw: unknown) => {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true });
  };
  try {
    assert.equal(defaultConfig().settings.handoff, false);
    assert.equal(load({}).settings.handoff, false);
    const on = load({ fallback: { codex: ["claude"], handoff: true } }).settings;
    assert.deepEqual([on.handoff, on.fallback], [true, { codex: ["claude"] }]);
    assert.equal(load({ fallback: { handoff: false } }).settings.handoff, false);
    assert.throws(() => load({ fallback: { handoff: "yes" } }), /^ConfigError: "fallback\.handoff" must be true or false; got "yes"$/);
    assert.deepEqual(collectConfigWarnings({ fallback: { handoff: true } }), []);
  } finally {
    cleanup(dir);
  }
});
