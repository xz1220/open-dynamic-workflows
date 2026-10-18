import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import { main } from "../src/cli.js";
import { createRedactor } from "../src/redact.js";
import { ChatStore } from "../src/runtime/chat-store.js";
import { startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { OdwRunSource } from "../src/runtime/odw-run-source.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";

// The last stores redaction (ODW extension; src/redact.ts) did not reach: the
// Chat Host's sessions.json, a run's worker.log, and a run's args as the API
// serves them — while `odw rerun` still starts from the args as given.

/** A GitHub-shaped token, made up here so no real-looking one sits in the source. */
const gh = (c: string): string => `ghp_${c.repeat(36)}`;
const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-redact-stores-"));

async function eventually<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

// --- the stream rule the Chat Host shares --------------------------------------------------

test("Redactor.ready keeps whole lines of text still arriving, never part of a line or an open private key", () => {
  const redactor = createRedactor(undefined, {});
  assert.equal(redactor.ready(`done\nhalf a tok ${gh("a").slice(0, 10)}`), "done\n".length);
  assert.equal(redactor.ready("a\nb\n"), 4);
  const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n";
  assert.equal(redactor.ready(`intro\n${key}`), "intro\n".length, "a key waits for its end line");
  // RedactStream lets text go by the same rule.
  const stream = redactor.stream();
  assert.equal(stream.write(`x ${gh("a").slice(0, 12)}`), "");
  assert.equal(stream.write(`${gh("a").slice(12)}\n`), "x «redacted:github»\n");
});

// --- the Chat Host's sessions --------------------------------------------------------------

const CHAT_VALUE = "chat-secret-value-0123";
const CHAT_ENV = { ODW_TEST_CHAT_TOKEN: CHAT_VALUE };
const sessionsFile = (root: string) => join(root, "_chat", "sessions.json");

test("chat sessions: what a person typed loses its token shapes, what an agent said its env values too; marked redacted", () => {
  const root = tempRoot();
  try {
    const store = new ChatStore(root, "/src", { redactor: createRedactor(undefined, { env: [CHAT_ENV] }), streamPersistMs: 60_000 });
    const session = store.create();
    const typed = store.appendUserMessage(session.id, `use ${gh("a")} and ${CHAT_VALUE}`);
    const user = typed.messages.at(-1)!;
    assert.equal(user.text, `use «redacted:github» and ${CHAT_VALUE}`, "the user's data: token shapes only");
    assert.equal(user.redacted, true);
    assert.equal(typed.title, `use «redacted:github» and ${CHAT_VALUE}`, "the title comes from the message as kept");

    const reply = store.appendAssistantMessage(session.id, "", undefined, "streaming").messages.at(-1)!;
    assert.equal(reply.redacted, undefined);
    const textOf = () => store.get(session.id)!.messages.at(-1)!;
    // Streaming: only whole lines are kept, so no part of a secret still arriving is.
    store.updateMessage(session.id, reply.id, { text: `line one\nthe key is ${CHAT_VALUE.slice(0, 12)}` });
    assert.equal(textOf().text, "line one\n");
    store.updateMessage(session.id, reply.id, { text: `line one\nthe key is ${CHAT_VALUE}\nand ${gh("b")}` });
    assert.equal(textOf().text, "line one\nthe key is «redacted:env:ODW_TEST_CHAT_TOKEN»\n");
    assert.equal(textOf().redacted, true);
    // Settled: all of it, redacted.
    store.updateMessage(session.id, reply.id, { text: `line one\nthe key is ${CHAT_VALUE}\nand ${gh("b")}`, status: "done" });
    assert.equal(textOf().text, "line one\nthe key is «redacted:env:ODW_TEST_CHAT_TOKEN»\nand «redacted:github»");
    const disk = readFileSync(sessionsFile(root), "utf8");
    assert.doesNotMatch(disk, new RegExp(`${gh("a")}|${gh("b")}|the key is ${CHAT_VALUE}`));
    assert.match(disk, /"redacted":\s*true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat sessions: a file kept before redaction is redacted as read and written clean; redact false keeps everything", () => {
  const root = tempRoot();
  try {
    const legacy = {
      version: 1,
      sessions: [
        {
          id: "chat_old",
          title: `deploy with ${gh("c")}`,
          source: "/src",
          state: "idle",
          updatedAt: 1,
          linkedRuns: [],
          messages: [
            { id: "m1", role: "user", text: `deploy with ${gh("c")}`, ts: 1 },
            { id: "m2", role: "assistant", text: `ok, ODW_TEST_CHAT_TOKEN=${CHAT_VALUE}`, ts: 2, status: "done" },
          ],
        },
      ],
    };
    mkdirSync(join(root, "_chat"), { recursive: true });
    writeFileSync(sessionsFile(root), JSON.stringify(legacy));
    const off = new ChatStore(root, "/src", { redactor: createRedactor(false) });
    assert.equal(off.get("chat_old")!.messages[0]!.text, `deploy with ${gh("c")}`, "redact: false keeps it as typed");
    assert.equal(off.appendUserMessage("chat_old", `again ${gh("d")}`).messages.at(-1)!.text, `again ${gh("d")}`);
    assert.equal(off.get("chat_old")!.messages.at(-1)!.redacted, undefined);

    const store = new ChatStore(root, "/src", { redactor: createRedactor(undefined, { env: [CHAT_ENV] }) });
    const read = store.get("chat_old")!;
    assert.equal(read.title, "deploy with «redacted:github»");
    assert.deepEqual(
      read.messages.map((m) => [m.text, m.redacted]),
      [
        ["deploy with «redacted:github»", true],
        ["ok, ODW_TEST_CHAT_TOKEN=«redacted:env:ODW_TEST_CHAT_TOKEN»", true],
        ["again «redacted:github»", true],
      ],
    );
    store.create(); // the next write keeps the file clean
    assert.doesNotMatch(readFileSync(sessionsFile(root), "utf8"), new RegExp(`${gh("c")}|${gh("d")}|${CHAT_VALUE}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Chat Host: Codex is given the message as typed, while the session keeps and serves it redacted", async () => {
  const root = tempRoot();
  process.env.ODW_TEST_CHAT_TOKEN = CHAT_VALUE;
  const prompts: string[] = [];
  const handle = await startServer({
    store: new RunStore(join(root, "runs")),
    port: 0,
    host: "127.0.0.1",
    cwd: root,
    config: defaultConfig(),
    claudeProjectsRoot: join(root, "no-claude"),
    chatRunner: async ({ prompt }, onChunk) => {
      prompts.push(prompt);
      onChunk(`I used ${CHAT_VALUE} and ${gh("f")}\n`);
    },
  });
  try {
    const post = (path: string, body: unknown) =>
      fetch(`${handle.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const session = await post("/api/chat/sessions", { source: root });
    await post(`/api/chat/sessions/${session.id}/messages`, { text: `please check ${gh("e")} for me` });
    const settled = await eventually(
      () => fetch(`${handle.url}/api/chat/sessions/${session.id}`).then((r) => r.json()),
      (s: { messages: Array<{ role: string; status?: string }> }) => s.messages.some((m) => m.role === "assistant" && m.status === "done"),
    );
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, new RegExp(`User: please check ${gh("e")} for me`), "the turn's prompt is never redacted");
    const texts = settled.messages.map((m: { text: string }) => m.text);
    assert.ok(texts.includes("please check «redacted:github» for me"));
    assert.ok(texts.includes("I used «redacted:env:ODW_TEST_CHAT_TOKEN» and «redacted:github»"));
    assert.doesNotMatch(readFileSync(sessionsFile(join(root, "runs")), "utf8"), new RegExp(`${gh("e")}|${gh("f")}|${CHAT_VALUE}`));
  } finally {
    await handle.close();
    delete process.env.ODW_TEST_CHAT_TOKEN;
    rmSync(root, { recursive: true, force: true });
  }
});

// --- worker.log ----------------------------------------------------------------------------

const LOG_VALUE = "worker-log-secret-0456";

/** Run `body` as an inline workflow in a real worker process, with `config`, and return its worker.log once it ends. */
async function workerLog(root: string, config: Record<string, unknown>, body: string): Promise<string> {
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const { runId, store } = startRunFromSource(`export const meta = { name: 'loud', description: 'd' }\n${body}`, {
    runsRoot: join(root, "runs"),
    source: root,
    configPath,
  });
  const status = await waitFor(store, runId, { timeoutMs: 20_000, pollIntervalMs: 20 });
  assert.equal(status.state, "done", JSON.stringify(status));
  // The worker writes its last held text as it exits, after the terminal status.
  await eventually(() => readFileSync(store.logPath(runId), "utf8"), (log) => log.includes("tail"));
  return readFileSync(store.logPath(runId), "utf8");
}

test("worker.log: what the worker prints — a workflow's console.log, a split secret, an unfinished line — is redacted", async () => {
  const root = tempRoot();
  const root2 = tempRoot();
  process.env.ODW_TEST_LOG_TOKEN = LOG_VALUE;
  try {
    const body =
      "const token = 'ghp_' + 'g'.repeat(36)\n" +
      "console.log('agent said: ' + token)\n" +
      "console.error('env: ' + process.env.ODW_TEST_LOG_TOKEN)\n" +
      "process.stdout.write('split ' + token.slice(0, 10)); process.stdout.write(token.slice(10) + '\\n')\n" +
      "process.stdout.write('tail ' + token)\n" +
      "return 1\n";
    const log = await workerLog(root, {}, body);
    assert.match(log, /agent said: «redacted:github»\n/);
    assert.match(log, /env: «redacted:env:ODW_TEST_LOG_TOKEN»\n/);
    assert.match(log, /split «redacted:github»\n/);
    assert.match(log, /tail «redacted:github»/, "a line never ended is written, redacted, as the worker exits");
    assert.doesNotMatch(log, new RegExp(`${gh("g")}|${LOG_VALUE}`));

    const clear = await workerLog(root2, { redact: false }, body);
    assert.match(clear, new RegExp(`agent said: ${gh("g")}\n`), "redact: false keeps it as printed");
    assert.match(clear, new RegExp(`env: ${LOG_VALUE}\n`));
  } finally {
    delete process.env.ODW_TEST_LOG_TOKEN;
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

// --- a run's args --------------------------------------------------------------------------

/** Run the CLI with stdout and stderr captured. */
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (out.push(String(s)), true);
  (process.stderr as { write: unknown }).write = () => true;
  try {
    return { code: await main(argv), out: out.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("a run's args are served with their token shapes redacted, and marked; meta.json and odw rerun keep them as given", async () => {
  const root = tempRoot();
  try {
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn args.n\n");
    const runsRoot = join(root, "runs");
    const store = new RunStore(runsRoot);
    const args = { token: gh("h"), note: `NAME_PASSWORD=${LOG_VALUE}`, n: 1 };
    const id = store.create({ script, args, source: root });

    const served = new OdwRunSource(store, { redactor: createRedactor(undefined, { env: [{ ODW_TEST_LOG_TOKEN: LOG_VALUE }] }) }).detail(id)!;
    assert.deepEqual(served.args, { token: "«redacted:github»", note: `NAME_PASSWORD=${LOG_VALUE}`, n: 1 }, "user data: token shapes only");
    assert.equal(served.argsRedacted, true);
    assert.deepEqual(store.readMeta(id).args, args, "meta.json keeps them as given");
    assert.deepEqual(new OdwRunSource(store, { redactor: createRedactor(false) }).detail(id)!.args, args, "redact: false");
    const plain = store.create({ script, args: { n: 2 }, source: root });
    assert.equal("argsRedacted" in new OdwRunSource(store, { redactor: createRedactor(undefined) }).detail(plain)!, false);

    // The dashboard's API serves them redacted.
    const handle = await startServer({ store, port: 0, host: "127.0.0.1", cwd: root, config: defaultConfig(), claudeProjectsRoot: join(root, "no-claude") });
    try {
      const detail = await fetch(`${handle.url}/api/runs/${id}`).then((r) => r.json());
      assert.deepEqual(detail.args, served.args);
      assert.equal(detail.argsRedacted, true);
    } finally {
      await handle.close();
    }

    // odw rerun starts the new run with the args as given.
    const rerun = await cli(["rerun", id, "--runs-root", runsRoot]);
    assert.equal(rerun.code, 0);
    const again = rerun.out.trim();
    assert.deepEqual(store.readMeta(again).args, args);
    await waitFor(store, again, { timeoutMs: 20_000, pollIntervalMs: 20 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
