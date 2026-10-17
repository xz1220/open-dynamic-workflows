import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { MAX_BODY_BYTES, readJsonBody } from "../src/runtime/http-util.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer, type ChatTurnRunner, type ServeHandle } from "../src/runtime/server.js";

// Request parsing at the HTTP edge: bodies, caps, and URL escapes.

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-req-"));
const asRequest = (chunks: Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage;

const quietRunner: ChatTurnRunner = async (_req, onChunk) => onChunk("ok");

async function boot(): Promise<{ root: string; handle: ServeHandle; store: RunStore }> {
  const root = tempRoot();
  const store = new RunStore(join(root, "runs"));
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: root,
    claudeProjectsRoot: join(root, "no-claude"),
    chatRunner: quietRunner,
  });
  return { root, handle, store };
}

/** POST raw body chunks with a pause between them (so they arrive as separate reads). */
function postChunks(port: number, path: string, chunks: Buffer[]): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    (async () => {
      for (const [i, chunk] of chunks.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 30));
        req.write(chunk);
      }
      req.end();
    })();
  });
}

test("readJsonBody decodes a multi-byte character split across chunks", async () => {
  const bytes = Buffer.from(JSON.stringify({ text: "调研下证券ETF" }));
  const cut = bytes.indexOf(Buffer.from("证")) + 1; // inside the 3-byte sequence
  const body = await readJsonBody(asRequest([bytes.subarray(0, cut), bytes.subarray(cut)]));
  assert.deepEqual(body, { ok: true, value: { text: "调研下证券ETF" } });
});

test("readJsonBody counts the cap in bytes, not UTF-16 units", async () => {
  // 50k CJK characters: 50k UTF-16 units (under the cap) but 150KB of UTF-8 (over it).
  const text = "测".repeat(50_000);
  assert.ok(text.length < MAX_BODY_BYTES && Buffer.byteLength(text) > MAX_BODY_BYTES);
  const body = await readJsonBody(asRequest([Buffer.from(JSON.stringify({ text }))]));
  assert.equal(body.ok, false);
  assert.equal(!body.ok && body.status, 413);
});

test("readJsonBody: empty is {}, non-objects and junk are 400", async () => {
  assert.deepEqual(await readJsonBody(asRequest([])), { ok: true, value: {} });
  for (const raw of ["[1,2]", "null", "42", "{ nope"]) {
    const body = await readJsonBody(asRequest([Buffer.from(raw)]));
    assert.equal(!body.ok && body.status, 400, raw);
  }
});

test("HTTP: a chat message split mid-character over the wire is stored intact", async () => {
  const { root, handle, store } = await boot();
  try {
    const created = await fetch(`${handle.url}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    const text = "普通消息：你好，世界";
    const bytes = Buffer.from(JSON.stringify({ text }));
    const cut = bytes.indexOf(Buffer.from("世")) + 2;
    const res = await postChunks(handle.port, `/api/chat/sessions/${created.id}/messages`, [
      bytes.subarray(0, cut),
      bytes.subarray(cut),
    ]);
    assert.equal(res.status, 200, res.body);
    const user = JSON.parse(res.body).messages.find((m: { role: string }) => m.role === "user");
    assert.equal(user.text, text);
    assert.equal(store.listRuns().length, 0);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: malformed percent-escapes in path ids are a 400, not a 500", async () => {
  const { root, handle } = await boot();
  try {
    for (const path of [
      "/api/runs/%E0%A4%A",
      "/api/runs/%ZZ/events",
      "/api/runs/%E0%A4%A/result",
      "/api/workflows/%E0%A4%A",
      "/api/chat/sessions/%E0%A4%A",
    ]) {
      const res = await fetch(`${handle.url}${path}`);
      assert.equal(res.status, 400, path);
      assert.match((await res.json()).error, /malformed URL escape/, path);
    }
    // Writes keep their guard order: CSRF posture is checked before the id.
    const crossSite = await fetch(`${handle.url}/api/runs/%ZZ/control`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(crossSite.status, 415);
    const badId = await fetch(`${handle.url}/api/chat/sessions/%ZZ/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(badId.status, 400);
    // A well-formed escape still decodes as before.
    assert.equal((await fetch(`${handle.url}/api/runs/${encodeURIComponent("no such")}`)).status, 404);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: an over-cap body gets a 413 with connection: close, and the server carries on", async () => {
  const { root, handle } = await boot();
  try {
    const huge = Buffer.from(JSON.stringify({ text: "x".repeat(MAX_BODY_BYTES) }));
    const res = await postChunks(handle.port, "/api/chat/sessions", [huge.subarray(0, 1000), huge.subarray(1000)]);
    assert.equal(res.status, 413);
    assert.equal(res.headers.connection, "close");
    assert.match(JSON.parse(res.body).error, /exceeds 131072 bytes/);
    const ok = await fetch(`${handle.url}/api/chat/sessions`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), [], "the oversized request created nothing");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
