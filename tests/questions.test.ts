import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { AdapterOutputDecoder, decodeOutput } from "../src/adapters/output.js";
import type { Adapter, AdapterOutput, CliResult } from "../src/adapters/types.js";
import { Bridge, type AgentAsk } from "../src/bridge.js";
import { AdapterExecutionError, NeedsInputError } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { LimitWatch } from "../src/limits.js";
import { BEHAVIOUR_SETTINGS } from "../src/provenance.js";
import { answeredBrief, answerOf, DENY_PROMPT, MAX_QUESTION_ROUNDS, questionTitle } from "../src/questions.js";
import { formatEvent, needsInputLines } from "../src/runtime/live-view.js";
import { waitingEnv, waitingLine, waitingPayload, type RunWaiting } from "../src/runtime/notify.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail, summarize } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

// Agent questions (ODW extension; src/questions.ts): an agent that stops to
// ask the user — Claude Code's AskUserQuestion tool call — gets no answer
// headless, and the model goes on guessing (anthropics/claude-code#50728).
// ODW reads the call from the stream, stops the CLI, and then: "checkpoint"
// asks a person and runs the call again with the answer, "fail" fails it with
// reason needs_input, "deny" takes the tool away and tells it to assume.

const EXPECT_AGENT = fileURLToPath(new URL("./fixtures/expect-agent.mjs", import.meta.url));
const POSIX_ONLY = { skip: process.platform === "win32" };

const CLAUDE = defaultConfig().adapters.claude!;
type Jsonl = Extract<AdapterOutput, { format: "jsonl" }>;

// --- Claude Code's stream-json -----------------------------------------------------------------

const init = { type: "system", subtype: "init", cwd: "/repo", session_id: "s", tools: ["AskUserQuestion", "Bash"], mcp_servers: [] };

/** The AskUserQuestion tool call, as an assistant message's tool_use block. */
const asks = (questions: unknown[], id = "toolu_ask") => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Before I start, one thing:" },
      { type: "tool_use", id, name: "AskUserQuestion", input: { questions } },
    ],
  },
  session_id: "s",
});

const whichDb = {
  question: "Which database should the cache use?",
  header: "Database",
  options: [
    { label: "SQLite", description: "one file, no server" },
    { label: "Postgres", description: "the app's own database" },
  ],
  multiSelect: false,
};

/** Headless, the tool answers at once with nothing — and the model goes on guessing. */
const emptyAnswer = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ask", content: "User did not answer." }] },
  session_id: "s",
};

const result = (text = "Done: I picked Postgres.") => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  session_id: "s",
  permission_denials: [],
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 2 },
});

const stream = (...events: unknown[]): string => [init, ...events].map((event) => JSON.stringify(event)).join("\n") + "\n";

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

function config(settings: Record<string, unknown> = {}) {
  const cfg = defaultConfig();
  Object.assign(cfg.settings, { defaultAdapter: "claude", ...settings });
  return cfg;
}

// --- reading the stream ------------------------------------------------------------------------

test("an AskUserQuestion call is read with its text, heading, option labels and multiSelect; other tool calls are not questions", () => {
  const out = decodeOutput(CLAUDE, stream(asks([whichDb, { question: "Which regions?", options: ["eu", "us"], multiSelect: true }]), emptyAnswer, result()));
  assert.deepEqual(out.questions, [
    { question: "Which database should the cache use?", header: "Database", options: ["SQLite", "Postgres"] },
    { question: "Which regions?", options: ["eu", "us"], multiSelect: true },
  ]);
  assert.equal(out.text, "Done: I picked Postgres.", "the reply is still decoded: the bridge decides what it is worth");
  const bash = { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls", questions: [whichDb] } }] } };
  assert.equal(decodeOutput(CLAUDE, stream(bash, result())).questions, undefined);
  // A call whose input ODW cannot read is still a question, said so.
  const bare = { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "AskUserQuestion", input: {} }] } };
  assert.deepEqual(decodeOutput(CLAUDE, stream(bare)).questions, [{ question: "(the agent asked a question whose text its CLI did not show)" }]);
  // Incrementally, in any chunking: the decoder has the question as soon as its line is in.
  const whole = stream(asks([whichDb]));
  const decoder = new AdapterOutputDecoder(CLAUDE);
  for (let i = 0; i < whole.length; i += 7) decoder.write(whole.slice(i, i + 7));
  assert.equal(decoder.questions.length, 1);
});

test("an adapter that declares no question rules reads none; any JSONL adapter can declare its own", () => {
  const { questions: _q, ...plain } = CLAUDE.output as Jsonl;
  assert.equal(decodeOutput({ ...CLAUDE, output: plain }, stream(asks([whichDb]), result())).questions, undefined);
  const mine: Adapter = {
    name: "mine",
    command: ["mine"],
    output: {
      format: "jsonl",
      eventType: "reply",
      textPath: ["text"],
      select: "last",
      questions: [{ event: "ask", text: [["prompt"], ["title"]], options: ["choices"] }],
    },
  };
  const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  assert.deepEqual(decodeOutput(mine, lines({ type: "ask", title: "Ship it?", choices: ["yes", "no"] })).questions, [
    { question: "Ship it?", options: ["yes", "no"] },
  ]);
});

// --- the bridge ------------------------------------------------------------------------------

test('"fail": the agent fails at once with reason needs_input and its questions — never with the guess it went on to', async () => {
  let runs = 0;
  await assert.rejects(
    new Bridge(config({ questions: "fail" }), { runner: async () => (runs++, ok(stream(asks([whichDb]), emptyAnswer, result()))) }).run({ prompt: "x" }),
    (err: unknown) =>
      err instanceof NeedsInputError &&
      err.reason === "needs_input" &&
      err.questions.length === 1 &&
      err.message ===
        "adapter 'claude' stopped: its agent asked the user a question (questions: \"fail\") — answer it in the prompt, or set " +
          'questions: "checkpoint" to ask a person: Which database should the cache use? (options: SQLite / Postgres)',
  );
  assert.equal(runs, 1, "not retried");
  // An agent()'s own policy beats the run's: "fail" on one call of a "checkpoint" run.
  await assert.rejects(
    new Bridge(config(), { runner: async () => ok(stream(asks([whichDb]))) }).run({ prompt: "x", questions: "fail" }, { onQuestion: async () => assert.fail("not asked") }),
    (err: unknown) => err instanceof AdapterExecutionError && err.reason === "needs_input",
  );
  // So does an adapter's.
  const cfg = config();
  cfg.adapters.claude = { ...cfg.adapters.claude!, questions: "fail" };
  await assert.rejects(
    new Bridge(cfg, { runner: async () => ok(stream(asks([whichDb]))) }).run({ prompt: "x" }, { onQuestion: async () => assert.fail("not asked") }),
    (err: unknown) => err instanceof NeedsInputError,
  );
  // A reply with no question stands as ever.
  const fine = await new Bridge(config({ questions: "fail" }), { runner: async () => ok(stream(result("All good."))) }).run({ prompt: "x" });
  assert.equal(fine.value, "All good.");
});

test("the CLI is stopped at the question: it never runs on with an empty answer", POSIX_ONLY, async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-ask-kill-"));
  try {
    // A CLI that asks, then would go on for a minute.
    const script = join(dir, "asks.mjs");
    writeFileSync(
      script,
      `process.stdout.write(${JSON.stringify(stream(asks([whichDb])))});\n` +
        `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(result()) + "\n")}), 60000);\n`,
    );
    const cfg = config({ questions: "fail" });
    cfg.adapters.claude = { ...cfg.adapters.claude!, command: [execPath, script], stdin: undefined };
    const started = Date.now();
    await assert.rejects(new Bridge(cfg).run({ prompt: "x" }), (err: unknown) => err instanceof NeedsInputError);
    assert.ok(Date.now() - started < 20_000, "stopped, not waited out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('"deny": the CLI runs without its question tool and is told to assume; one that asks anyway fails', async () => {
  const commands: string[][] = [];
  const prompts: string[] = [];
  const bridge = new Bridge(config({ questions: "deny" }), {
    runner: async (command, options) => {
      commands.push(command);
      prompts.push(options?.stdin ?? "");
      return ok(stream(result("Assumed SQLite.")));
    },
  });
  assert.equal((await bridge.run({ prompt: "add a cache" })).value, "Assumed SQLite.");
  const at = commands[0]!.indexOf("--disallowedTools");
  assert.ok(at > 0 && commands[0]![at + 1] === "AskUserQuestion", commands[0]!.join(" "));
  assert.ok(prompts[0]!.includes(DENY_PROMPT));
  // Under the default it keeps the tool, and the prompt says nothing of it.
  const plain: string[][] = [];
  await new Bridge(config(), { runner: async (command) => (plain.push(command), ok(stream(result()))) }).run({ prompt: "x" });
  assert.ok(!plain[0]!.includes("--disallowedTools"));

  await assert.rejects(
    new Bridge(config({ questions: "deny" }), { runner: async () => ok(stream(asks([whichDb]))) }).run({ prompt: "x" }),
    (err: unknown) => err instanceof NeedsInputError && /though it runs under questions: "deny"/.test(err.message),
  );
  // A CLI with question rules but no questionArgs: said once, and the prompt still says to assume.
  const notes: string[] = [];
  const cfg = config({ questions: "deny" });
  cfg.adapters.claude = { ...cfg.adapters.claude!, questionArgs: undefined };
  await new Bridge(cfg, { runner: async () => ok(stream(result())) }).run({ prompt: "x" }, { onNote: (m) => notes.push(m) });
  assert.deepEqual(notes, [
    `questions: "deny" — adapter 'claude' declares no questionArgs to take its question tool away: its agents are told to assume instead, and one that asks anyway fails (needs_input)`,
  ]);
});

test('"checkpoint": the person\'s answer runs the call again, told the question and the answer; a decline fails it', async () => {
  const prompts: string[] = [];
  const asked: AgentAsk[] = [];
  const bridge = new Bridge(config(), {
    runner: async (_command, options) => {
      prompts.push(options?.stdin ?? "");
      return ok(prompts.length === 1 ? stream(asks([whichDb]), emptyAnswer, result("guessed")) : stream(result("Used SQLite.")));
    },
  });
  const outcome = await bridge.run(
    { prompt: "add a cache" },
    { onQuestion: async (ask) => (asked.push(ask), { answer: "SQLite, please" }) },
  );
  assert.equal(outcome.value, "Used SQLite.");
  assert.equal(outcome.attempts, 2);
  assert.deepEqual(asked, [{ adapter: "claude", questions: [{ question: whichDb.question, header: "Database", options: ["SQLite", "Postgres"] }], round: 1 }]);
  assert.ok(!prompts[0]!.includes("Earlier in this task"));
  assert.ok(
    prompts[1]!.endsWith(
      "Earlier in this task you stopped to ask the user:\n- Which database should the cache use? (options: SQLite / Postgres)\n" +
        "The user answered: SQLite, please\n\nGo on with the task with this answer. Do not ask again about what was answered here; " +
        "if something else is unclear, make a reasonable assumption and say so in your reply.",
    ),
    prompts[1],
  );

  // Declined: needs_input, with why.
  await assert.rejects(
    new Bridge(config(), { runner: async () => ok(stream(asks([whichDb]))) }).run({ prompt: "x" }, { onQuestion: async () => ({ declined: "the question was declined: not now" }) }),
    (err: unknown) => err instanceof NeedsInputError && /a question and the question was declined: not now: Which database/.test(err.message),
  );
  // Nobody to ask (no onQuestion): needs_input.
  await assert.rejects(
    new Bridge(config(), { runner: async () => ok(stream(asks([whichDb]))) }).run({ prompt: "x" }),
    (err: unknown) => err instanceof NeedsInputError && /nobody can be asked here/.test(err.message),
  );
  // A call that keeps asking is answered MAX_QUESTION_ROUNDS times, then fails.
  let rounds = 0;
  await assert.rejects(
    new Bridge(config(), { runner: async () => ok(stream(asks([whichDb]))) }).run({ prompt: "x" }, { onQuestion: async () => (rounds++, { answer: null }) }),
    (err: unknown) => err instanceof NeedsInputError && new RegExp(`again after ${MAX_QUESTION_ROUNDS} answered`).test(err.message),
  );
  assert.equal(rounds, MAX_QUESTION_ROUNDS);
});

test("the question helpers: the answer is the note, else an edited payload's answer; the brief and the title", () => {
  assert.equal(answerOf({ note: "  Postgres ", edited: false, payload: null }), "Postgres");
  assert.equal(answerOf({ note: null, edited: true, payload: { answer: "SQLite" } }), "SQLite");
  assert.equal(answerOf({ note: "", edited: false, payload: { answer: "ignored: not an edit" } }), null);
  assert.match(answeredBrief([{ questions: [{ question: "Q?" }], answer: null }]), /The user gave no specific answer: use your best judgement/);
  assert.equal(questionTitle("plan", [{ question: "A?" }, { question: "B?" }]), "plan asks: A? (+1 more)");
});

test("waiting for an answer does not count toward an agent's seconds limit", () => {
  let now = 0;
  const stops: string[] = [];
  const answered = new LimitWatch(() => now);
  answered.startRun({ seconds: 10 }, true, () => stops.push("answered"));
  answered.endRun();
  now = 60_000;
  answered.waited(55_000); // a person took 55s of the minute
  answered.startRun({ seconds: 10 }, true, () => stops.push("answered"));
  answered.endRun();
  assert.equal(answered.hit, null);
  // Without it, the minute counts: the next run is stopped at once.
  now = 0;
  const plain = new LimitWatch(() => now);
  plain.startRun({ seconds: 10 }, true, () => stops.push("plain"));
  plain.endRun();
  now = 60_000;
  plain.startRun({ seconds: 10 }, true, () => stops.push("plain"));
  plain.endRun();
  assert.deepEqual(stops, ["plain"]);
});

// --- config ------------------------------------------------------------------------------------

test("questions, an adapter's questions and questionArgs, and output.questions load, default and validate", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-ask-config-"));
  try {
    const load = (raw: Record<string, unknown>) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify(raw));
      return loadConfig(path, { quiet: true });
    };
    assert.equal(defaultConfig().settings.questions, "checkpoint");
    assert.equal(load({ questions: "deny" }).settings.questions, "deny");
    assert.throws(() => load({ questions: "ask" }), /"questions" must be "fail", "checkpoint" or "deny"; got "ask"/);
    assert.deepEqual(collectConfigWarnings({ questions: "fail" }), []);
    assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("questions"));
    assert.equal(load({ adapters: { claude: { questions: "fail" } } }).adapters.claude!.questions, "fail");
    assert.deepEqual(defaultConfig().adapters.claude!.questionArgs, ["--disallowedTools", "AskUserQuestion"]);
    assert.throws(() => load({ adapters: { claude: { questions: "maybe" } } }), /adapter 'claude' 'questions' must be "fail", "checkpoint", "deny"/);
    assert.throws(() => load({ adapters: { x: { command: ["x"], questionArgs: ["--no-ask"] } } }), /declares "questionArgs" but its command has no \{permission_args\}/);
    // The built-in declaration round-trips, and the example spells it out.
    const output = { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", questions: (CLAUDE.output as Jsonl).questions };
    assert.deepEqual(load({ adapters: { mine: { command: ["x"], output } } }).adapters.mine!.output, output);
    const example = loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true });
    assert.deepEqual(example.adapters.claude!.output, CLAUDE.output);
    assert.deepEqual(example.adapters.claude!.questionArgs, CLAUDE.questionArgs);
    const bad = (questions: unknown) => () => load({ adapters: { mine: { command: ["x"], output: { ...output, questions } } } });
    assert.throws(bad([]), /'output\.questions' must be a non-empty array of rules/);
    assert.throws(bad([{ event: "e" }]), /questions\[0\]'\.text must be a non-empty array of paths/);
    assert.throws(bad([{ event: "e", text: [["q"]], asks: true }]), /unknown key 'asks'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- notify ------------------------------------------------------------------------------------

test("notify's waiting payload tells an agent's question from a checkpoint, and says how to answer it", () => {
  const base: RunWaiting = {
    runId: "r1",
    runDir: "/runs/r1",
    workflow: "wf",
    state: "waiting",
    createdAt: 1,
    durationSec: 5,
    counts: { agents: 1, done: 0, failed: 0 },
    checkpoint: { checkpointId: 2, title: "Ship it?", since: 3 },
  };
  assert.equal((waitingPayload(base).checkpoint as { kind: string }).kind, "checkpoint");
  assert.equal(waitingEnv(base).ODW_CHECKPOINT_KIND, "checkpoint");
  const question: RunWaiting = {
    ...base,
    checkpoint: { checkpointId: 2, title: "cache asks: Which database?", since: 3, question: { agentId: 4, label: "cache", adapter: "claude" } },
  };
  const payload = waitingPayload(question);
  assert.deepEqual(payload.checkpoint, { ...question.checkpoint, kind: "question" });
  assert.equal(waitingEnv(question).ODW_CHECKPOINT_KIND, "question");
  assert.equal(waitingEnv(question).ODW_QUESTION_AGENT, "cache");
  assert.equal(
    waitingLine(question),
    'odw · wf: an agent asks — cache asks: Which database? · answer: odw approve r1 --checkpoint 2 --note "<answer>" · decline: odw reject',
  );
});

// --- the whole stack ---------------------------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** A git repository with one commit, for isolated agents. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-ask-src-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return dir;
}

interface Call {
  n: number;
  cwd: string;
  answered: string | null;
}

/** One agent() call labelled `cache`, on a scripted stream-json CLI; `answer` is told each checkpoint as it is asked. */
async function runAgent(
  source: string,
  plan: unknown[],
  opts: Record<string, unknown>,
  settings: Record<string, unknown>,
  answer?: (store: RunStore, id: string, checkpointId: number) => void,
) {
  const work = mkdtempSync(join(tmpdir(), "odw-ask-run-"));
  const log = join(work, "calls.jsonl");
  const configPath = join(work, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "claude",
      ...settings,
      adapters: { claude: { command: [execPath, EXPECT_AGENT, log, "--claude"], stdin: "{prompt}", output: CLAUDE.output } },
    }),
  );
  const script = join(work, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'wf', description: 'd' }\n" +
      "try { return { value: await agent('Add a cache. PLAN: ' + JSON.stringify(args.plan), args.opts) } }\n" +
      "catch (err) { return { error: String(err) } }\n",
  );
  const store = new RunStore(join(work, "runs"));
  const id = store.create({ script, args: { plan, opts: { label: "cache", ...opts } }, source, configPath });
  const answered = new Set<number>();
  const watcher = setInterval(() => {
    for (const ev of store.readEvents(id)) {
      if (ev.type === "checkpoint_requested" && typeof ev.checkpointId === "number" && !answered.has(ev.checkpointId)) {
        answered.add(ev.checkpointId);
        answer?.(store, id, ev.checkpointId);
      }
    }
  }, 20);
  try {
    const state = await executeRun(store.runDir(id));
    return {
      work,
      id,
      state,
      store,
      result: (store.readResult(id) ?? {}) as Record<string, unknown>,
      events: store.readEvents(id),
      calls: existsSync(log) ? (readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Call[]) : [],
    };
  } finally {
    clearInterval(watcher);
  }
}

const ofType = (events: WorkflowEvent[], type: string) => events.filter((e) => e.type === type);

test("a question becomes a checkpoint; the answer reruns the agent in the same worktree, and the views show it all", POSIX_ONLY, async () => {
  const source = makeRepo();
  let seen: { waiting: unknown; pending: unknown } | undefined;
  try {
    const plan = [
      { write: { "cache.txt": "half done\n" }, stream: [asks([whichDb])], reply: "guessed" },
      { write: { "db.txt": "sqlite\n" }, reply: "Used SQLite." },
    ];
    const flow = await runAgent(source, plan, { isolation: "worktree" }, {}, (store, id, checkpointId) => {
      const run = detail(store, id);
      seen = { waiting: summarize(store, id).waiting, pending: run.pendingCheckpoints };
      store.requestCheckpointDecision(id, { action: "approve", checkpointId, note: "SQLite", by: "cli" });
    });
    try {
      assert.deepEqual(flow.result, { value: "Used SQLite." });
      assert.equal(flow.calls.length, 2);
      assert.equal(flow.calls[0]!.answered, null);
      assert.match(flow.calls[1]!.answered!, /^Earlier in this task you stopped to ask the user:\n- Which database should the cache use\? \(options: SQLite \/ Postgres\)\nThe user answered: SQLite\n/);
      assert.equal(flow.calls[1]!.cwd, flow.calls[0]!.cwd, "the same worktree (removed once the call settled)");
      assert.match(flow.calls[0]!.cwd, /odw-wt-/, "an isolated worktree, not the source tree");

      // The checkpoint carries who asked and what; the waiting run shows it.
      const requested = ofType(flow.events, "checkpoint_requested")[0]!;
      assert.equal(requested.title, "cache asks: Which database should the cache use?");
      assert.deepEqual(requested.question, {
        agentId: 1,
        label: "cache",
        adapter: "claude",
        questions: [{ question: whichDb.question, header: "Database", options: ["SQLite", "Postgres"] }],
      });
      assert.deepEqual(seen!.waiting, { checkpointId: 1, title: requested.title, since: requested.ts, question: { agentId: 1, label: "cache", adapter: "claude" } });
      assert.equal((seen!.pending as Array<{ question?: { label: string } }>)[0]!.question!.label, "cache");
      // The rerun is said, and marked as one.
      const rerun = ofType(flow.events, "log").find((e) => (e.retry as { reason?: string } | undefined)?.reason === "question");
      assert.equal(rerun!.message, "cache:1 was answered — running it again, told the answer");
      const finished = ofType(flow.events, "agent_finished")[0]!;
      assert.equal(finished.attempts, 2);
      // Its kept change holds what both runs did, in the one worktree.
      const diff = readFileSync(flow.store.agentDiffPath(flow.id, 1), "utf8");
      assert.match(diff, /cache\.txt/);
      assert.match(diff, /db\.txt/);
    } finally {
      rmSync(flow.work, { recursive: true, force: true });
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("a declined question, and questions: \"fail\", fail the agent with needs_input — shown in its event, its view and odw status", async () => {
  const source = mkdtempSync(join(tmpdir(), "odw-ask-inplace-"));
  try {
    const plan = [{ stream: [asks([whichDb])], reply: "guessed" }];
    const declined = await runAgent(source, plan, {}, {}, (store, id, checkpointId) =>
      store.requestCheckpointDecision(id, { action: "reject", checkpointId, note: "not now", by: "cli" }),
    );
    try {
      assert.equal(declined.calls.length, 1);
      assert.match(String(declined.result.error), /NeedsInputError: adapter 'claude' stopped: its agent asked the user a question and the question was declined: not now: Which database/);
      const failed = ofType(declined.events, "agent_failed")[0]!;
      assert.equal(failed.reason, "needs_input");
      assert.deepEqual(failed.questions, ["Which database should the cache use? (options: SQLite / Postgres)"]);
      const run = detail(declined.store, declined.id);
      assert.equal(run.agents[0]!.failureReason, "needs_input");
      assert.deepEqual(run.agents[0]!.questions, failed.questions);
      assert.equal(summarize(declined.store, declined.id).needsInput, 1);
      assert.deepEqual(needsInputLines(run.agents), ["needs input: cache:1 stopped to ask: Which database should the cache use? (options: SQLite / Postgres)"]);
      assert.match(formatEvent(failed), /cache — \[needs_input\] NeedsInputError: /);
    } finally {
      rmSync(declined.work, { recursive: true, force: true });
    }

    const failing = await runAgent(source, plan, { questions: "fail" }, {}, () => assert.fail("nobody is asked"));
    try {
      assert.equal(ofType(failing.events, "checkpoint_requested").length, 0);
      assert.equal(ofType(failing.events, "agent_failed")[0]!.reason, "needs_input");
      assert.equal(failing.calls.length, 1);
    } finally {
      rmSync(failing.work, { recursive: true, force: true });
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("agent() refuses a questions option it does not know", async () => {
  const source = mkdtempSync(join(tmpdir(), "odw-ask-bad-"));
  try {
    const flow = await runAgent(source, [{}], { questions: "ask" }, {});
    try {
      assert.match(String(flow.result.error), /agent\(\): questions must be "checkpoint", "fail" or "deny"; got "ask"/);
      assert.equal(flow.calls.length, 0);
    } finally {
      rmSync(flow.work, { recursive: true, force: true });
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
