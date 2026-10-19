import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeRunSource, encodeProjectDir } from "../src/runtime/claude-run-source.js";
import { RunStore } from "../src/runtime/run-store.js";
import { cmdTmux, odwWatchedRun, runOverview, type WatchedRun, type WatchPoll } from "../src/runtime/tmux.js";

// U5 (ODW extension): `odw tmux <run>` — a window with an overview pane and a
// pane per running agent. tmux itself is faked: every call is recorded.

function sink() {
  const chunks: string[] = [];
  return { write: (s: string) => (chunks.push(s), true), text: () => chunks.join("") };
}

/** A fake tmux: records each call; `fail` makes the matching subcommand throw. */
function fakeTmux(fail: (args: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  return {
    calls,
    exec: (args: string[]): string => {
      calls.push(args);
      if (fail(args)) throw new Error("no space for new pane");
      return "";
    },
  };
}

/** A run that answers each poll from a script, then ends. */
function scripted(polls: WatchPoll[]): WatchedRun {
  let i = 0;
  return { poll: () => polls[Math.min(i++, polls.length - 1)]! };
}

const agent = (id: string) => ({ key: id, label: `agent ${id}`, args: ["logs", "R", "--agent", id, "--follow"] });

let root: string;
let store: RunStore;
let runId: string;
const storeFrom = () => store;

before(() => {
  root = mkdtempSync(join(tmpdir(), "odw-tmux-"));
  store = new RunStore(join(root, "runs"));
  runId = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(runId, { state: "running", name: "demo", pid: process.pid });
  const events = [
    { ts: 1, type: "run_started", runId },
    { ts: 1, type: "agent_started", agentId: 1, label: "fixer", phase: null, adapter: "mock" },
    { ts: 2, type: "agent_started", agentId: 2, label: "it's done", phase: null, adapter: "mock" },
    { ts: 3, type: "agent_finished", agentId: 2, label: "it's done", phase: null, adapter: "mock", attempts: 1 },
  ];
  for (const ev of events) appendFileSync(store.eventsPath(runId), JSON.stringify(ev) + "\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("the overview splits a pane per running agent up to the cap, lists the rest, and ends with the run", async () => {
  const tmux = fakeTmux();
  const out = sink();
  const run = scripted([
    { lines: ["started"], running: [agent("1"), agent("2")], ended: null },
    { lines: [], running: [agent("1"), agent("2"), agent("3")], ended: null },
    { lines: ["finished"], running: [], ended: { code: 0, line: "run R done" } },
  ]);
  const code = await runOverview(run, { tmux: tmux.exec, pane: "%7", layout: "tiled", maxPanes: 2, odw: ["/bin/odw"], cwd: "/repo", out, pollMs: 1 });
  assert.equal(code, 0);
  assert.deepEqual(tmux.calls[0], ["set-option", "-w", "-t", "%7", "remain-on-exit", "on"]);
  const splits = tmux.calls.filter((c) => c[0] === "split-window");
  assert.deepEqual(splits, [
    ["split-window", "-d", "-t", "%7", "-c", "/repo", "/bin/odw logs R --agent 1 --follow"],
    ["split-window", "-d", "-t", "%7", "-c", "/repo", "/bin/odw logs R --agent 2 --follow"],
  ]);
  assert.equal(tmux.calls.filter((c) => c[0] === "select-layout" && c.at(-1) === "tiled").length, 2);
  const text = out.text();
  assert.match(text, /^started\n\+ pane: agent 1\n\+ pane: agent 2\n/);
  assert.match(text, /no pane for agent 3 \(2 of 2 open\): odw logs R --agent 3 --follow\n/);
  assert.match(text, /finished\nrun R done\n$/);
});

test("an agent tmux has no room for is listed, not lost; the exit code follows the run", async () => {
  const tmux = fakeTmux((args) => args[0] === "split-window");
  const out = sink();
  const run = scripted([
    { lines: [], running: [agent("9")], ended: null },
    { lines: [], running: [], ended: { code: 1, line: "run R failed" } },
  ]);
  assert.equal(await runOverview(run, { tmux: tmux.exec, pane: "%1", layout: "even-vertical", maxPanes: 6, odw: ["odw"], cwd: "/", out, pollMs: 1 }), 1);
  assert.match(out.text(), /no pane for agent 9 \(0 of 6 open\)/);
});

test("an ODW run, watched: its events, and its running agents with commands that find it", () => {
  const seen = odwWatchedRun(store, runId).poll();
  assert.ok(seen.lines.some((l) => /agent_started +fixer/.test(l)));
  assert.deepEqual(seen.running.map((a) => a.args), [["logs", runId, "--agent", "1", "--follow", "--runs-root", store.root]]);
  assert.equal(seen.ended, null);
});

test("odw tmux without tmux prints the commands that follow the run by hand", async () => {
  const out = sink();
  const code = await cmdTmux([runId, "--runs-root", store.root], storeFrom, { out, err: sink(), installed: () => false, env: {} });
  assert.equal(code, 0);
  const text = out.text();
  assert.match(text, /tmux is not installed/);
  assert.match(text, new RegExp(`odw attach ${runId} --runs-root ${store.root}\\n`));
  assert.match(text, new RegExp(`odw logs ${runId} --agent 1 --follow --runs-root ${store.root} +# fixer\\n`));
  assert.doesNotMatch(text, /--agent 2/); // finished: no pane
});

test("odw tmux outside a tmux session prints the tmux new-session command that runs the overview", async () => {
  const out = sink();
  const tmux = fakeTmux();
  const code = await cmdTmux([runId, "--runs-root", store.root, "--max-panes", "3"], storeFrom, { out, err: sink(), tmux: tmux.exec, installed: () => true, env: {} });
  assert.equal(code, 0);
  assert.match(out.text(), /tmux new-session '.* tmux [^ ]+ --overview --layout tiled --max-panes 3 --runs-root /);
  assert.equal(tmux.calls.length, 0);
});

test("odw tmux inside tmux opens one window whose pane runs the overview", async () => {
  const out = sink();
  const tmux = fakeTmux();
  const code = await cmdTmux([runId, "--runs-root", store.root, "--layout", "main-vertical"], storeFrom, {
    out,
    err: sink(),
    tmux: tmux.exec,
    installed: () => true,
    env: { TMUX: "/tmp/tmux-1/default,1,0" },
  });
  assert.equal(code, 0);
  assert.equal(tmux.calls.length, 1);
  const [sub, , name, , , command] = tmux.calls[0]!;
  assert.equal(sub, "new-window");
  assert.equal(name, `odw:${runId.slice(0, 24)}`);
  assert.match(command!, new RegExp(`tmux ${runId} --overview --layout main-vertical --max-panes 6 --runs-root ${store.root}$`));
  assert.match(out.text(), /opened a window/);
});

test("odw tmux refuses a bad layout, pane cap or run id, and an unknown run", async () => {
  const io = () => ({ out: sink(), err: sink(), installed: () => false, env: {} });
  assert.equal(await cmdTmux([runId, "--layout", "spiral"], storeFrom, io()), 2);
  assert.equal(await cmdTmux([runId, "--max-panes", "1.5"], storeFrom, io()), 2);
  assert.equal(await cmdTmux([runId, "--max-panes", "99"], storeFrom, io()), 2);
  assert.equal(await cmdTmux(["../etc"], storeFrom, io()), 2);
  assert.equal(await cmdTmux([], storeFrom, io()), 2);
  assert.equal(await cmdTmux(["20990101-000000-zzzzzz"], storeFrom, io()), 1);
  const err = sink();
  assert.equal(await cmdTmux([runId, "--overview"], storeFrom, { out: sink(), err, env: {} }), 2);
  assert.match(err.text(), /TMUX_PANE/);
});

test("odw tmux on a Claude Code run: panes follow its running agents by their Claude ids (read-only)", async () => {
  const projects = join(root, "claude-projects");
  const live = join(projects, encodeProjectDir("/w"), "sess", "subagents", "workflows", "wf_t1");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "journal.jsonl"), JSON.stringify({ type: "started", key: "k", agentId: "abc123", label: "scan" }) + "\n");
  const claude = () => new ClaudeRunSource({ projectsRoot: projects, cwd: "/w" });
  const out = sink();
  assert.equal(await cmdTmux(["cc-wf_t1"], storeFrom, { out, err: sink(), installed: () => false, env: {}, claude }), 0);
  assert.match(out.text(), /odw attach cc-wf_t1\n/);
  assert.match(out.text(), /odw logs cc-wf_t1 --agent abc123 --follow +# scan\n/);
  assert.equal(await cmdTmux(["cc-wf_none"], storeFrom, { out: sink(), err: sink(), installed: () => false, env: {}, claude }), 1);
});
