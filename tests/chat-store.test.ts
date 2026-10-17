import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatStore } from "../src/runtime/chat-store.js";

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-chat-store-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fileOf = (root: string) => join(root, "_chat", "sessions.json");
const onDisk = (root: string) => JSON.parse(readFileSync(fileOf(root), "utf8"));
/** Every write is temp-file + rename, so a new inode means a new write. */
const inode = (root: string) => statSync(fileOf(root)).ino;

test("streaming text stays in memory and is written at most once per window; settling writes at once", async () => {
  const root = tempRoot();
  try {
    const store = new ChatStore(root, "/src", { streamPersistMs: 150 });
    const session = store.create();
    const withPlaceholder = store.appendAssistantMessage(session.id, "", undefined, "streaming");
    const msg = withPlaceholder.messages.at(-1)!;
    const before = inode(root);

    let text = "";
    for (let i = 0; i < 25; i++) {
      text += `chunk ${i} `;
      store.updateMessage(session.id, msg.id, { text });
    }
    assert.equal(store.get(session.id)!.messages.at(-1)!.text, text, "readers see the stream live");
    assert.equal(inode(root), before, "no write per chunk");

    await sleep(300);
    const afterWindow = inode(root);
    assert.notEqual(afterWindow, before, "the pending text was persisted once the window passed");
    assert.equal(onDisk(root).sessions[0].messages.at(-1).text, text);

    store.updateMessage(session.id, msg.id, { text: `${text}end`, status: "done" });
    assert.notEqual(inode(root), afterWindow, "a settled message is written immediately");
    assert.equal(onDisk(root).sessions[0].messages.at(-1).status, "done");
    assert.equal(onDisk(root).sessions[0].state, "idle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flush() persists pending streaming text (server shutdown)", () => {
  const root = tempRoot();
  try {
    const store = new ChatStore(root, "/src", { streamPersistMs: 60_000 });
    const session = store.create();
    const msg = store.appendAssistantMessage(session.id, "", undefined, "streaming").messages.at(-1)!;
    store.updateMessage(session.id, msg.id, { text: "partial answer" });
    assert.equal(onDisk(root).sessions[0].messages.at(-1).text, "");
    store.flush();
    assert.equal(onDisk(root).sessions[0].messages.at(-1).text, "partial answer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handed-out sessions are snapshots: later updates never mutate them", () => {
  const root = tempRoot();
  try {
    const store = new ChatStore(root, "/src");
    const session = store.create();
    const snapshot = store.get(session.id)!;
    const records = store.records();
    store.appendUserMessage(session.id, "hello");
    assert.equal(snapshot.messages.length, 1);
    assert.equal(records[0]!.messages.length, 1);
    assert.equal(store.get(session.id)!.messages.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the existing pretty-printed sessions.json and picks up another process's writes", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "_chat"), { recursive: true });
    const legacy = {
      version: 1,
      sessions: [
        {
          id: "chat_old",
          title: "Old session",
          source: "/src",
          state: "idle",
          updatedAt: 1,
          linkedRuns: [],
          messages: [{ id: "msg_1", role: "user", text: "from the old format", ts: 1 }],
        },
        { id: "broken" }, // invalid rows are dropped, as before
      ],
    };
    writeFileSync(fileOf(root), JSON.stringify(legacy, null, 2));
    const store = new ChatStore(root, "/src");
    assert.deepEqual(store.list().map((s) => s.lastMessage), ["from the old format"]);

    const other = new ChatStore(root, "/src"); // e.g. a second `odw serve` on the same runs root
    other.create("/elsewhere");
    assert.equal(store.list().length, 2, "an outside write is noticed on the next read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed write rolls a request's change back; a failed stream write is reported, not thrown", async () => {
  const root = tempRoot();
  try {
    // `_chat` is a FILE, so creating the store's directory fails (even as root).
    writeFileSync(join(root, "_chat"), "not a dir");
    const broken = new ChatStore(root, "/src");
    assert.throws(() => broken.create());
    assert.deepEqual(broken.list(), [], "the failed create left nothing behind");
    rmSync(join(root, "_chat"));

    const errors: unknown[] = [];
    const store = new ChatStore(root, "/src", { streamPersistMs: 50, onError: (err) => errors.push(err) });
    const session = store.create();
    const msg = store.appendAssistantMessage(session.id, "", undefined, "streaming").messages.at(-1)!;
    store.updateMessage(session.id, msg.id, { text: "streamed" });
    rmSync(join(root, "_chat"), { recursive: true });
    writeFileSync(join(root, "_chat"), "not a dir"); // the disk goes bad mid-stream
    await sleep(150);
    assert.ok(errors.length >= 1, "the background write failure reached onError instead of crashing");

    assert.throws(() => store.updateMessage(session.id, msg.id, { text: "final", status: "done" }));
    const settled = store.get(session.id)!.messages.at(-1)!;
    assert.equal(settled.status, "done", "memory keeps the settled message, so the session is not stuck streaming");

    rmSync(join(root, "_chat"));
    store.flush();
    assert.equal(onDisk(root).sessions[0].messages.at(-1).text, "final", "the retry lands once the disk is back");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two servers sharing sessions.json merge their writes instead of wiping each other's sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-chat-merge-"));
  try {
    const a = new ChatStore(root, "/a", { streamPersistMs: 20 });
    const b = new ChatStore(root, "/b", { streamPersistMs: 20 });
    const sa = a.create();
    const msg = a.appendAssistantMessage(sa.id, "", undefined, "streaming").messages.at(-1)!;
    a.updateMessage(sa.id, msg.id, { text: "partial…" }); // A is mid-stream, its memory dirty
    await new Promise((r) => setTimeout(r, 5));
    const sb = b.create(); // B writes a new session meanwhile
    a.updateMessage(sa.id, msg.id, { text: "done", status: "done" }); // A's write lands after B's
    const fresh = new ChatStore(root, "/c");
    const ids = fresh.list().map((s) => s.id);
    assert.ok(ids.includes(sa.id), "A's session survives");
    assert.ok(ids.includes(sb.id), "B's session survives A's later write");
    assert.equal(fresh.get(sa.id)!.messages.at(-1)!.text, "done");
    // A deletion merges the same way.
    b.delete(sb.id);
    a.updateMessage(sa.id, msg.id, { text: "done again", status: "done" });
    assert.deepEqual(new ChatStore(root, "/c").list().map((s) => s.id), [sa.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
