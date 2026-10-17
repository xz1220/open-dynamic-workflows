import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import { ChatHost, type ChatTurnRunner } from "../src/runtime/chat-host.js";
import type { RunSource } from "../src/runtime/run-source.js";
import { RunStore } from "../src/runtime/run-store.js";
import type { RunDetail, RunDisplayState, RunSummary } from "../src/runtime/runs-view.js";

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-chat-host-"));

/** A RunSource stand-in whose runs are plain objects; counts every read. */
class FakeSource implements RunSource {
  readonly provider = "odw" as const;
  readonly controlError = null;
  readonly runs = new Map<string, { state: RunDisplayState; createdAt: number }>();
  calls = { summary: 0, detail: 0, events: 0, result: 0 };

  owns(): boolean {
    return true;
  }
  exists(runId: string): boolean {
    return this.runs.has(runId);
  }
  listSummaries(): RunSummary[] {
    return [...this.runs.keys()].map((id) => this.summary(id)!);
  }
  summary(runId: string): RunSummary | null {
    this.calls.summary++;
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      runId,
      provider: "odw",
      state: run.state,
      rawState: run.state,
      stale: false,
      name: "wf",
      description: null,
      phases: [],
      source: null,
      pid: null,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      counts: { agents: 0, running: 0, done: 0, failed: 0, stale: 0 },
      progress: 0,
      lastActivityTs: null,
    };
  }
  detail(runId: string): RunDetail | null {
    this.calls.detail++;
    const s = this.summary(runId);
    if (!s) return null;
    return { ...s, script: null, args: null, agents: [], phaseOrder: [], hasResult: true, error: null, origin: "chat", adapter: null, workflowName: "wf" };
  }
  events() {
    this.calls.events++;
    return [];
  }
  eventLog() {
    this.calls.events++;
    return [];
  }
  result() {
    this.calls.result++;
    return { has: true, value: "the answer" };
  }
  control(): void {}
}

function host(root: string, source: FakeSource, prompts: string[] = []) {
  const runner: ChatTurnRunner = async ({ prompt }, onChunk) => {
    prompts.push(prompt);
    onChunk("follow-up");
  };
  return new ChatHost({
    store: new RunStore(root),
    sources: [source],
    cwd: root,
    config: defaultConfig(),
    configPath: null,
    runner,
  });
}

const nowSec = () => Date.now() / 1000;

test("completion sync never re-reads runs from before the server started", () => {
  const root = tempRoot();
  try {
    const source = new FakeSource();
    source.runs.set("old-run", { state: "done", createdAt: nowSec() - 3600 });
    const h = host(root, source);
    const session = h.chat.create(root);
    h.chat.appendToolRun(session.id, "old-run", "wf");

    for (let i = 0; i < 5; i++) h.syncCompletedRuns();
    assert.equal(source.calls.summary, 1, "checked once through the cheap summary, then remembered");
    assert.equal(source.calls.detail, 0, "never folds the full detail of a run it will not post");
    assert.equal(source.calls.result, 0);
    assert.equal(h.chat.get(session.id)!.messages.some((m) => m.kind === "chat.odw_result"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion sync polls a running run cheaply and posts its result exactly once", async () => {
  const root = tempRoot();
  try {
    const source = new FakeSource();
    source.runs.set("new-run", { state: "running", createdAt: nowSec() + 1 });
    const prompts: string[] = [];
    const h = host(root, source, prompts);
    const session = h.chat.create(root);
    h.chat.appendToolRun(session.id, "new-run", "wf");

    h.syncCompletedRuns();
    h.syncCompletedRuns();
    assert.equal(source.calls.detail, 0, "a running run costs a summary lookup, not a detail fold");
    assert.equal(source.calls.result, 0);

    source.runs.get("new-run")!.state = "done";
    h.syncCompletedRuns();
    assert.equal(source.calls.detail, 1);
    assert.equal(source.calls.result, 1);
    const posted = h.chat.get(session.id)!.messages.filter((m) => m.kind === "chat.odw_result");
    assert.equal(posted.length, 1);
    assert.match(posted[0]!.text, /the answer/);

    // The follow-up Codex turn finishes; later syncs never touch the run again.
    for (let i = 0; i < 50 && !h.chat.get(session.id)!.messages.some((m) => m.status === "done"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const before = { ...source.calls };
    h.syncCompletedRuns();
    h.syncCompletedRuns();
    assert.deepEqual(source.calls, before);
    assert.equal(prompts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a linked run that no longer exists is skipped and not looked up again", () => {
  const root = tempRoot();
  try {
    const source = new FakeSource();
    const h = host(root, source);
    const session = h.chat.create(root);
    h.chat.appendToolRun(session.id, "gone-run", "wf");
    h.syncCompletedRuns();
    h.syncCompletedRuns();
    assert.equal(source.calls.summary, 0, "exists() already said no");
    assert.equal(source.calls.detail, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
