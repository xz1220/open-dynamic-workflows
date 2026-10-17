import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";

// The background refresh loop of `odw serve`: the runs-root watcher and the
// liveness tick. Both run outside any request.

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-refresh-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Counts run-list computations (each one lists the runs root). */
class CountingStore extends RunStore {
  lists = 0;
  fail = false;
  override listRunIds(): string[] {
    this.lists++;
    if (this.fail) throw new Error("EACCES: simulated unreadable runs root");
    return super.listRunIds();
  }
}

/** Open /api/stream and collect `runs` frames in the background. */
async function collectRuns(url: string) {
  const abort = new AbortController();
  const frames: any[] = [];
  const res = await fetch(`${url}/api/stream`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = /^event: runs\ndata: (.*)$/m.exec(frame)?.[1];
          if (data) frames.push(JSON.parse(data));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    frames,
    async close() {
      abort.abort();
      await pump;
    },
  };
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await sleep(20);
  }
}

test("a burst of event appends is coalesced into a few run-list refreshes, not one per write", async () => {
  const root = tempRoot();
  const store = new CountingStore(root);
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "running", pid: process.pid, name: "demo" });
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  const sse = await collectRuns(handle.url);
  try {
    await until(() => sse.frames.length > 0); // the initial frame
    const appends = 60;
    const before = store.lists;
    for (let i = 0; i < appends; i++) {
      appendFileSync(
        store.eventsPath(id),
        JSON.stringify({ ts: i, type: "agent_started", agentId: i, label: `a${i}` }) + "\n",
      );
      await sleep(5); // separate writes, so each one reaches the watcher on its own
    }
    // The final state is still pushed promptly …
    await until(() => sse.frames.some((runs) => runs[0]?.counts.agents === appends));
    // … but the list was computed a handful of times, not once per append.
    const refreshes = store.lists - before;
    assert.ok(refreshes <= appends / 3, `${refreshes} run-list refreshes for ${appends} appends`);
  } finally {
    await sse.close();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a server that fails to listen rejects cleanly and closes its fs watcher", async () => {
  const root = tempRoot();
  const first = await startServer({ store: new RunStore(root), port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  // Count watchers opened/closed through node:fs (synced into ESM imports).
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const realWatch = fs.watch;
  let open = 0;
  fs.watch = ((...args: Parameters<typeof realWatch>) => {
    const watcher = realWatch(...args);
    open++;
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      open--;
      close();
    };
    return watcher;
  }) as typeof realWatch;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      startServer({ store: new RunStore(root), port: first.port, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") }),
      /already in use/,
    );
    assert.equal(open, 0, "the server that never listened closed its runs watcher");
  } finally {
    fs.watch = realWatch;
    syncBuiltinESMExports();
    await first.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing background refresh is logged and the server keeps serving", async () => {
  const root = tempRoot();
  const store = new CountingStore(root);
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  const sse = await collectRuns(handle.url);
  const logged: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).includes("simulated")) {
      logged.push(String(chunk));
      return true;
    }
    return realWrite(chunk, ...(rest as []));
  }) as typeof process.stderr.write;
  try {
    await until(() => sse.frames.length > 0);
    store.fail = true; // the 1s liveness tick now throws inside a timer
    await until(() => logged.length > 0);
    assert.match(logged[0]!, /odw serve: run list refresh: EACCES: simulated/);
    const caps = await fetch(`${handle.url}/api/capabilities`);
    assert.equal(caps.status, 200, "still serving after the background failure");
    store.fail = false;
    assert.equal((await fetch(`${handle.url}/api/runs`)).status, 200);
  } finally {
    process.stderr.write = realWrite;
    await sse.close();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Open /api/stream?delta=1 and collect every `runs` / `runs-delta` frame. */
async function collectFrames(url: string, query = "?delta=1") {
  const abort = new AbortController();
  const frames: Array<{ event: string; data: any }> = [];
  const res = await fetch(`${url}/api/stream${query}`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const m = /^event: (runs(?:-delta)?)\ndata: (.*)$/m.exec(raw);
          if (m) frames.push({ event: m[1]!, data: JSON.parse(m[2]!) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    frames,
    async close() {
      abort.abort();
      await pump;
    },
  };
}

test("delta clients get one full list, then only the runs that changed", async () => {
  const root = tempRoot();
  const store = new RunStore(root);
  const ids = [0, 1, 2].map((i) => {
    const id = store.create({ script: `/demo/wf${i}.js`, args: null, source: "/demo" });
    store.updateStatus(id, { state: i === 0 ? "running" : "done", pid: process.pid, name: `wf${i}` });
    return id;
  });
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  const delta = await collectFrames(handle.url);
  const full = await collectFrames(handle.url, "");
  try {
    await until(() => delta.frames.length > 0 && full.frames.length > 0);
    assert.equal(delta.frames[0]!.event, "runs");
    assert.equal(delta.frames[0]!.data.length, 3);
    const live = ids[0]!;
    appendFileSync(store.eventsPath(live), JSON.stringify({ ts: 1, type: "agent_started", agentId: 0, label: "a" }) + "\n");
    await until(() => delta.frames.some((f) => f.event === "runs-delta"));
    const d = delta.frames.find((f) => f.event === "runs-delta")!.data;
    assert.deepEqual(d.upsert.map((r: { runId: string }) => r.runId), [live]);
    assert.deepEqual(d.remove, []);
    assert.equal(d.upsert[0].counts.running, 1);
    // Full-list clients never see a delta frame.
    assert.ok(full.frames.every((f) => f.event === "runs"));
    // A run that disappears is announced as a removal.
    rmSync(join(store.runDir(ids[2]!)), { recursive: true, force: true });
    await until(() => delta.frames.some((f) => f.event === "runs-delta" && f.data.remove.includes(ids[2])));
  } finally {
    await delta.close();
    await full.close();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
