import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";
import { RunStore } from "../src/runtime/run-store.js";
import type { AgentView } from "../src/runtime/runs-view.js";
import { shareBar, spendByPhase, spendLines } from "../src/runtime/spend-view.js";
import { detectCaps, displayWidth } from "../src/tty.js";

// Where a run spent, in the terminal (ODW extension): `odw status`'s "spend by
// phase" block — the dashboard's spend receipt in text — and `odw list`'s cost column.

const PLAIN = { color: false, truecolor: false, unicode: true };
const ESC = "\x1b";

function agent(label: string, phase: string | null, usage?: AgentView["usage"], state: AgentView["state"] = "done"): AgentView {
  return {
    agentId: null,
    kind: "agent",
    label,
    phase,
    state,
    adapter: "claude",
    attempts: 1,
    error: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    cached: false,
    ...(usage ? { usage } : {}),
  } as AgentView;
}

const RUN = {
  phases: [{ title: "Research" }, { title: "Write" }, { title: "Review" }],
  phaseOrder: ["Research", "Write", "Review"],
  agents: [
    agent("r1", "Research", { inputTokens: 30_000, outputTokens: 2_000, costUsd: 0.3 }),
    agent("r2", "Research", { inputTokens: 10_000, outputTokens: 1_000, costUsd: 0.1 }),
    agent("w1", "Write", { inputTokens: 5_000, outputTokens: 500, costUsd: 0.1 }),
    agent("x", null, { inputTokens: 100, outputTokens: 10, costUsd: 0.001 }),
  ],
};

test("spend by phase: the declared phases in order, those not started too, then the agents outside every phase", () => {
  const sp = spendByPhase(RUN)!;
  assert.equal(sp.by, "cost");
  assert.deepEqual(
    sp.phases.map((l) => [l.key, l.agents, l.tokens, l.costUsd]),
    [
      ["Research", 2, 43_000, 0.4],
      ["Write", 1, 5_500, 0.1],
      ["Review", 0, 0, null],
      ["", 1, 110, 0.001],
    ],
  );
  assert.equal(spendByPhase({ ...RUN, agents: RUN.agents.map((a) => ({ ...a, usage: undefined })) }), null, "nothing reported: no block");
  // One agent without dollars: the shares are of tokens.
  const mixed = spendByPhase({ ...RUN, agents: [...RUN.agents, agent("codex", "Write", { inputTokens: 900, outputTokens: 100 })] })!;
  assert.equal(mixed.by, "tokens");
});

test("the share bar: Unicode blocks to the eighth, a sliver for any share, # without Unicode", () => {
  assert.equal(shareBar(1, 20, true), "█".repeat(20));
  assert.equal(shareBar(0.5, 20, true), "█".repeat(10));
  assert.equal(shareBar(0.53, 20, true), "██████████▋");
  assert.equal(shareBar(0.0001, 20, true), "▏");
  assert.equal(shareBar(0, 20, true), "");
  assert.equal(shareBar(0.5, 20, false), "#".repeat(10));
  assert.equal(shareBar(0.0001, 20, false), "#");
});

test("the spend block: phase, agents, tokens, cost, share and bar — within 100 columns", () => {
  const lines = spendLines(RUN, PLAIN);
  assert.deepEqual(lines, [
    "  spend by phase (share of cost):",
    `    01  Research        2 agents      43k   $0.400  80%  ${"█".repeat(16)}`,
    `    02  Write           1 agent      5.5k   $0.100  20%  ${"█".repeat(4)}`,
    "    03  Review          not started     —        —",
    "    ··  outside phases  1 agent       110  $0.0010  <1%  ▏",
  ]);
  // A long phase name is cut, never the line.
  const long = { ...RUN, phaseOrder: ["R".repeat(80)], agents: [agent("a", "R".repeat(80), { inputTokens: 1, outputTokens: 1, costUsd: 1234.5 })] };
  for (const line of spendLines(long, PLAIN)) assert.ok(displayWidth(line) <= 100, line);
  assert.match(spendLines(long, PLAIN)[1]!, /R{23}…/);
});

test("the spend block says what is running and what is estimated, and keeps tokens when not every agent reported dollars", () => {
  const run = {
    ...RUN,
    agents: [...RUN.agents, agent("codex", "Write", { inputTokens: 900, outputTokens: 100, estimated: true }), agent("late", "Review", undefined, "running")],
  };
  const lines = spendLines(run, PLAIN);
  assert.equal(lines[0], "  spend by phase (share of tokens):");
  assert.equal(lines[2], "    02  Write           2 agents  6.5k~   $0.100  13%  ██▋");
  assert.equal(lines[3], "    03  Review          1 agent       0        —   0%", "a running agent has spent nothing yet");
  assert.deepEqual(lines.slice(-3), [
    "    running agents add theirs when they finish",
    "    not every agent reported dollars, so shares are of tokens",
    "    ~ partly estimated: a CLI that reports no count is measured as characters / 4",
  ]);
});

test("the spend block is plain under NO_COLOR, styled in a color terminal, and ASCII without Unicode", () => {
  const tty = { isTTY: true };
  const noColor = spendLines(RUN, detectCaps(tty, { TERM: "xterm", LANG: "en_US.UTF-8", NO_COLOR: "1" }));
  assert.deepEqual(noColor, spendLines(RUN, PLAIN));
  const colored = spendLines(RUN, detectCaps(tty, { TERM: "xterm", LANG: "en_US.UTF-8" }));
  assert.ok(colored.some((l) => l.includes(ESC)), "the bars are colored");
  for (const line of colored) assert.ok(displayWidth(line) <= 100);
  const ascii = spendLines(RUN, detectCaps(tty, { TERM: "xterm", LANG: "C", NO_COLOR: "1" }));
  assert.equal(ascii[1], `    01  Research        2 agents      43k   $0.400  80%  ${"#".repeat(16)}`);
  assert.equal(ascii[3], "    03  Review          not started     -        -");
  assert.equal(ascii[4], "    --  outside phases  1 agent       110  $0.0010  <1%  #");
  assert.ok(ascii.every((l) => /^[\x20-\x7e]*$/.test(l)), "nothing but ASCII");
});

// --- odw status and odw list ---------------------------------------------------------------

/** Run the CLI with stdout captured, in a UTF-8 locale whatever the test's (color: by the pipe alone). */
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const keys = ["LANG", "LC_ALL", "LC_CTYPE", "FORCE_COLOR", "NO_COLOR"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.LANG = "en_US.UTF-8";
  const out: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = () => true;
  try {
    return { code: await main(argv), out: out.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function storedRun(store: RunStore, name: string, events: Array<Record<string, unknown>>): string {
  const id = store.create({ script: `/tmp/never-read/${name}.js`, args: null, source: store.root, workflowName: name });
  store.updateStatus(id, { state: "done", name, phases: [{ title: "Plan" }, { title: "Build" }] });
  for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  return id;
}

const finished = (agentId: number, phase: string | null, usage?: Record<string, unknown>) => [
  { ts: 1, type: "agent_started", agentId, label: `a${agentId}`, phase, adapter: "claude" },
  { ts: 2, type: "agent_finished", agentId, label: `a${agentId}`, phase, adapter: "claude", attempts: 1, ...(usage ? { usage } : {}) },
];

test("odw status shows the spend by phase; odw list a cost column once a listed run has a cost", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-spend-"));
  const store = new RunStore(root);
  try {
    const plain = storedRun(store, "plain", finished(1, "Plan"));
    const before = await cli(["list", "--runs-root", root]);
    assert.equal(before.code, 0);
    assert.equal(before.out, `${plain}  done      plain\n`, "no run has a cost: no column");

    const paid = storedRun(store, "paid", [
      { ts: 0, type: "phase_started", phase: "Plan" },
      ...finished(1, "Plan", { inputTokens: 1_000, outputTokens: 200, costUsd: 0.75 }),
      { ts: 3, type: "phase_started", phase: "Build" },
      ...finished(2, "Build", { inputTokens: 3_000, outputTokens: 800, costUsd: 2.25 }),
    ]);
    const status = await cli(["status", paid, "--runs-root", root]);
    assert.equal(status.code, 0);
    assert.ok(!status.out.includes(ESC), "no color in a pipe");
    assert.match(
      status.out,
      new RegExp(
        [
          "^ {2}spend by phase \\(share of cost\\):",
          ` {4}01 {2}Plan {3}1 agent {2}1\\.2k {2}\\$0\\.750 {2}25% {2}█{5}`,
          ` {4}02 {2}Build {2}1 agent {2}3\\.8k {2}\\$2\\.250 {2}75% {2}█{15}$`,
        ].join("\n"),
        "m",
      ),
    );
    const none = await cli(["status", plain, "--runs-root", root]);
    assert.doesNotMatch(none.out, /spend by phase/, "a run that reported nothing has no block");

    const after = await cli(["list", "--runs-root", root]);
    const rows = after.out.trimEnd().split("\n");
    assert.deepEqual(new Set(rows), new Set([`${plain}  done           —  plain`, `${paid}  done      $3.000  paid`]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
