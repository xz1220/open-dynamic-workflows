import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

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
  decide(): void {}
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

/** Drive ChatHost.route() without a socket; returns status + parsed body. */
async function call(
  h: ChatHost,
  method: string,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: any }> {
  let status = 0;
  let body = "";
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(b?: string) {
      body = b ?? "";
    },
  } as unknown as ServerResponse;
  const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))];
  const req = Object.assign(Readable.from(chunks), {
    headers: { "content-type": "application/json" },
  }) as unknown as IncomingMessage;
  const routed = await h.route(req, res, method, path, "127.0.0.1");
  assert.ok(routed, `${method} ${path} is a chat route`);
  return { status, body: body ? JSON.parse(body) : null };
}

const get = (h: ChatHost, path: string) => call(h, "GET", path);

test("the session list folds state from cached run summaries, without hydrating tools", async () => {
  const root = tempRoot();
  try {
    const source = new FakeSource();
    source.runs.set("run-a", { state: "running", createdAt: nowSec() - 3600 });
    source.runs.set("run-b", { state: "done", createdAt: nowSec() - 3600 });
    const h = host(root, source);
    const busy = h.chat.create(root);
    h.chat.appendToolRun(busy.id, "run-a", "wf");
    const idle = h.chat.create(root);
    h.chat.appendToolRun(idle.id, "run-b", "wf");
    source.calls = { summary: 0, detail: 0, events: 0, result: 0 };

    const { status, body } = await get(h, "/api/chat/sessions");
    assert.equal(status, 200);
    const byId = new Map(body.map((s: any) => [s.id, s]));
    assert.equal((byId.get(busy.id) as any).state, "running");
    assert.equal((byId.get(idle.id) as any).state, "done");
    assert.equal((byId.get(busy.id) as any).linkedRuns, 1);
    assert.equal((byId.get(busy.id) as any).lastMessage, "ODW run requested by the local Chat Host.");
    assert.deepEqual(
      { detail: source.calls.detail, events: source.calls.events, result: source.calls.result },
      { detail: 0, events: 0, result: 0 },
      "a list row needs a state, not a hydrated transcript",
    );

    // The open session is still fully hydrated.
    const one = await get(h, `/api/chat/sessions/${busy.id}`);
    assert.equal(one.body.messages.find((m: any) => m.role === "tool").tool.status, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streaming change notifications are coalesced to one per 250ms window", async () => {
  const root = tempRoot();
  try {
    const notified: number[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const h = new ChatHost({
      store: new RunStore(root),
      sources: [],
      cwd: root,
      config: defaultConfig(),
      configPath: null,
      notify: () => notified.push(Date.now()),
      // ~600ms of chunks every 10ms: the store is updated every 80ms.
      runner: async (_req, onChunk) => {
        for (let i = 0; i < 60; i++) {
          onChunk(`chunk ${i} `);
          await new Promise((r) => setTimeout(r, 10));
        }
        finish();
      },
    });
    const session = h.chat.create(root);
    const posted = await call(h, "POST", `/api/chat/sessions/${session.id}/messages`, { text: "hello there" });
    assert.equal(posted.status, 200);
    await finished;
    await new Promise((r) => setTimeout(r, 400)); // let the last window flush
    // ~8 store updates (placeholder, 80ms flushes, final) → a handful of notifications.
    assert.ok(notified.length >= 2 && notified.length <= 5, `${notified.length} notifications`);
    for (let i = 1; i < notified.length; i++) {
      assert.ok(notified[i]! - notified[i - 1]! >= 245, `notifications ${notified[i]! - notified[i - 1]!}ms apart`);
    }
    const done = h.chat.get(session.id)!.messages.at(-1)!;
    assert.equal(done.status, "done");
    assert.match(done.text, /chunk 59/);
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
