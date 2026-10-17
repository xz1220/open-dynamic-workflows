import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig } from "../src/adapters/config.js";
import type { NotifySettings } from "../src/adapters/types.js";
import {
  formatDuration,
  notifyRunEnd,
  summaryLine,
  webhookOrigin,
  webhookPayload,
  type RunEnd,
} from "../src/runtime/notify.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";

// --- helpers --------------------------------------------------------------------

interface Post {
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
}

/** A local incoming-webhook endpoint that records every POST; `respond` answers it. */
async function receiver(respond: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end("ok")) {
  const posts: Post[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      posts.push({ path: req.url, headers: req.headers, body: JSON.parse(data) });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    // The path and query stand in for the secret of a real incoming webhook.
    url: `http://127.0.0.1:${port}/services/T000/B000/SECRETPATH?token=SECRETQUERY`,
    posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const HOOK_VARS =
  /^ODW_(RUN_ID|RUN_STATE|WORKFLOW|RUN_DIR|RESULT_FILE|DURATION_SEC|AGENTS|FAILED_AGENTS|CHECKPOINT_ID|CHECKPOINT_TITLE)$/;

/** A notify command that appends its ODW_* environment to `file`, one JSON line per call. */
function recordingCommand(file: string): string[] {
  return [
    execPath,
    "-e",
    `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ${HOOK_VARS}.test(k)));` +
      `require('fs').appendFileSync(${JSON.stringify(file)}, JSON.stringify(env) + '\\n')`,
  ];
}

function readLines(file: string): Array<Record<string, string>> {
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

/** Capture what the worker writes to stderr (its worker.log) while `fn` runs. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** A run root with mock adapters ('mock' answers at once, 'slow' never does) and a notify block. */
function project(notify: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "odw-notify-"));
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "mock",
      adapters: {
        mock: { command: [execPath, "-e", "process.stdout.write('ok')"] },
        slow: { command: [execPath, "-e", "setTimeout(() => {}, 30000)"] },
      },
      notify,
    }),
  );
  const store = new RunStore(join(root, "runs"));
  let n = 0;
  const create = (body: string) => {
    const script = join(root, `wf-${++n}.js`);
    writeFileSync(script, `export const meta = { name: 'nightly', description: 'd' }\n${body}`);
    return store.create({ script, args: null, source: root, configPath });
  };
  return { root, store, create };
}

// --- through the worker -----------------------------------------------------------

test("hooks fire once per terminal state, with the run in the env and the webhook payload", async () => {
  const hook = await receiver();
  const envFile = join(tmpdir(), `odw-notify-env-${process.pid}-${Date.now()}`);
  const { root, store, create } = project({ command: recordingCommand(envFile), webhook: hook.url });
  // Inherited from whatever started the worker: must not leak into a run without a result.
  const inherited = process.env.ODW_RESULT_FILE;
  process.env.ODW_RESULT_FILE = "/stale/result.json";
  try {
    const done = create("await agent('a')\nreturn { answer: 42 }");
    assert.equal(await executeRun(store.runDir(done)), "done");

    const failed = create("await agent('a')\nthrow new Error('kaboom')");
    assert.equal(await executeRun(store.runDir(failed)), "failed");

    const stopped = create("await agent('hangs', { adapter: 'slow' })\nreturn 'unreachable'");
    const run = executeRun(store.runDir(stopped));
    assert.ok(await waitUntil(() => store.readEvents(stopped).some((e) => e.type === "agent_started"), 10_000));
    store.writeControl(stopped, "stop");
    assert.equal(await run, "stopped");

    assert.equal(hook.posts.length, 3, "one POST per run");
    const envs = readLines(envFile);
    assert.equal(envs.length, 3, "one command per run");

    const expected = {
      [done]: { state: "done", counts: { agents: 1, done: 1, failed: 0 }, verb: "finished in" },
      [failed]: { state: "failed", counts: { agents: 1, done: 1, failed: 0 }, verb: "failed after" },
      [stopped]: { state: "stopped", counts: { agents: 1, done: 0, failed: 1 }, verb: "stopped after" },
    };
    for (const [runId, want] of Object.entries(expected)) {
      const posts = hook.posts.filter((p) => p.body.runId === runId);
      assert.equal(posts.length, 1, `exactly one POST for the ${want.state} run`);
      const { body, headers, path } = posts[0]!;
      assert.equal(path, "/services/T000/B000/SECRETPATH?token=SECRETQUERY", "the full configured URL is called");
      assert.match(String(headers["content-type"]), /^application\/json/);
      assert.equal(body.workflow, "nightly");
      assert.equal(body.state, want.state);
      assert.deepEqual(body.counts, want.counts);
      assert.equal(typeof body.createdAt, "number");
      assert.ok(body.finishedAt >= body.createdAt);
      assert.ok(Number.isInteger(body.durationSec) && body.durationSec >= 0);
      assert.equal(body.text, body.content, "Slack's text and Discord's content carry the same summary");
      const agents = want.counts.failed ? "1 agent, 1 failed" : "1 agent";
      assert.match(body.text, new RegExp(`^odw · nightly ${want.verb} \\d+s · ${agents}$`));

      const env = envs.find((e) => e.ODW_RUN_ID === runId)!;
      assert.ok(env, `the command ran for the ${want.state} run`);
      assert.equal(env.ODW_RUN_STATE, want.state);
      assert.equal(env.ODW_WORKFLOW, "nightly");
      assert.equal(env.ODW_RUN_DIR, store.runDir(runId));
      assert.equal(env.ODW_DURATION_SEC, String(body.durationSec));
      assert.equal(env.ODW_AGENTS, String(want.counts.agents));
      assert.equal(env.ODW_FAILED_AGENTS, String(want.counts.failed));

      // Nothing is appended after the terminal event: readers fold the stream.
      const events = store.readEvents(runId);
      assert.match(events[events.length - 1]!.type, /^run_(finished|failed|stopped)$/);
    }

    const doneEnv = envs.find((e) => e.ODW_RUN_ID === done)!;
    assert.equal(doneEnv.ODW_RESULT_FILE, join(store.runDir(done), "result.json"));
    assert.deepEqual(JSON.parse(readFileSync(doneEnv.ODW_RESULT_FILE!, "utf8")), { value: { answer: 42 } });
    for (const id of [failed, stopped]) {
      const env = envs.find((e) => e.ODW_RUN_ID === id)!;
      assert.equal(env.ODW_RESULT_FILE, undefined, "no result.json, no ODW_RESULT_FILE");
    }

    const body = (id: string) => hook.posts.find((p) => p.body.runId === id)!.body;
    assert.equal("error" in body(done), false);
    assert.equal(body(failed).error, "kaboom");
    assert.equal(body(stopped).error, "run was stopped");
  } finally {
    if (inherited === undefined) delete process.env.ODW_RESULT_FILE;
    else process.env.ODW_RESULT_FILE = inherited;
    await hook.close();
    rmSync(envFile, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("notify.on narrows which terminal states fire the hooks", async () => {
  const hook = await receiver();
  const { root, store, create } = project({ webhook: hook.url, on: ["failed"] });
  try {
    assert.equal(await executeRun(store.runDir(create("return 1"))), "done");
    assert.equal(hook.posts.length, 0, "a done run is not reported when only failures are wanted");
    const failed = create("throw new Error('boom')");
    assert.equal(await executeRun(store.runDir(failed)), "failed");
    assert.equal(hook.posts.length, 1);
    assert.equal(hook.posts[0]!.body.runId, failed);
  } finally {
    await hook.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("'waiting' (opt-in) fires the hooks once per checkpoint() while the run waits on", async () => {
  const hook = await receiver();
  const envFile = join(tmpdir(), `odw-notify-wait-${process.pid}-${Date.now()}`);
  const { root, store, create } = project({ command: recordingCommand(envFile), webhook: hook.url, on: ["waiting", "done"] });
  const id = create("await checkpoint('First?')\nawait checkpoint('Second?')\nreturn 'ok'");
  const run = executeRun(store.runDir(id));
  try {
    const asked = (n: number) => store.readEvents(id).some((e) => e.type === "checkpoint_requested" && e.checkpointId === n);
    assert.ok(await waitUntil(() => asked(1), 10_000));
    store.requestCheckpointDecision(id, { action: "approve", checkpointId: 1, by: "cli" });
    assert.ok(await waitUntil(() => asked(2), 10_000));
    store.requestCheckpointDecision(id, { action: "approve", checkpointId: 2, by: "cli" });
    assert.equal(await run, "done");

    assert.deepEqual(hook.posts.map((p) => p.body.state).sort(), ["done", "waiting", "waiting"], "once per checkpoint, plus the end");
    const first = hook.posts.find((p) => p.body.state === "waiting" && p.body.checkpoint.checkpointId === 1)!.body;
    assert.deepEqual(Object.keys(first), [
      "runId",
      "workflow",
      "state",
      "createdAt",
      "durationSec",
      "counts",
      "checkpoint",
      "text",
      "content",
      "allowed_mentions",
    ]);
    assert.equal(first.runId, id);
    assert.equal(first.workflow, "nightly");
    assert.deepEqual(Object.keys(first.checkpoint).sort(), ["checkpointId", "since", "title"]);
    assert.equal(first.checkpoint.title, "First?");
    assert.equal(first.text, `odw · nightly waits for a decision: First? · odw approve|reject ${id} --checkpoint 1`);
    assert.equal(first.content, first.text);

    const envs = readLines(envFile);
    const waiting = envs.filter((e) => e.ODW_RUN_STATE === "waiting");
    assert.deepEqual(waiting.map((e) => [e.ODW_CHECKPOINT_ID, e.ODW_CHECKPOINT_TITLE]).sort(), [
      ["1", "First?"],
      ["2", "Second?"],
    ]);
    assert.ok(waiting.every((e) => e.ODW_RUN_ID === id && e.ODW_RESULT_FILE === undefined));
    const end = envs.find((e) => e.ODW_RUN_STATE === "done")!;
    assert.equal(end.ODW_CHECKPOINT_ID, undefined, "the end hook carries no checkpoint");
    const events = store.readEvents(id);
    assert.equal(events[events.length - 1]!.type, "run_finished", "hooks never write to events.jsonl");
  } finally {
    store.writeControl(id, "stop"); // a failed assertion must not leave the run waiting forever
    await run.catch(() => {});
    await hook.close();
    rmSync(envFile, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("without 'waiting' in notify.on, a checkpoint fires no hook", async () => {
  const hook = await receiver();
  const { root, store, create } = project({ webhook: hook.url });
  try {
    const id = create("return await checkpoint('Nobody told?', { timeout: 0.05, onTimeout: 'approve' })");
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(hook.posts.map((p) => p.body.state), ["done"]);
  } finally {
    await hook.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing hook changes nothing about the run; the failure goes to stderr, without secrets", async () => {
  const hook = await receiver((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("no_service");
  });
  const { root, store, create } = project({
    command: [execPath, "-e", "process.stderr.write('hook broke'); process.exit(3)", "--", "--token=SECRETARG"],
    webhook: hook.url,
  });
  try {
    const id = create("await agent('a')\nreturn 'fine'");
    const { value: state, stderr } = await captureStderr(() => executeRun(store.runDir(id)));
    assert.equal(state, "done");
    assert.equal(store.readStatus(id).state, "done");
    assert.equal(store.readResult(id), "fine");
    assert.ok(stderr.includes(`odw: notify: command '${execPath}' exited with code 3: hook broke\n`), stderr);
    assert.ok(stderr.includes(`odw: notify: webhook ${hook.origin} answered 500 Internal Server Error: no_service\n`), stderr);
    assert.doesNotMatch(stderr, /SECRET/, "neither the webhook's path/query nor the command's arguments are logged");
    const events = store.readEvents(id);
    assert.equal(events[events.length - 1]!.type, "run_finished", "hook failures never reach events.jsonl");
    assert.equal(events.some((e) => /notify/.test(String(e.message ?? ""))), false);
  } finally {
    await hook.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the terminal state is on disk before a slow hook finishes", async () => {
  const release = join(tmpdir(), `odw-notify-release-${process.pid}-${Date.now()}`);
  // The hook waits until the test releases it (or 10s pass).
  const waiting = [
    execPath,
    "-e",
    `const fs = require('fs'); const until = Date.now() + 10000; const t = setInterval(() => {` +
      `if (fs.existsSync(${JSON.stringify(release)}) || Date.now() > until) clearInterval(t) }, 20)`,
  ];
  const { root, store, create } = project({ command: waiting });
  try {
    const id = create("return 'quick'");
    let settled = false;
    const run = executeRun(store.runDir(id)).finally(() => (settled = true));
    assert.ok(await waitUntil(() => store.readStatus(id).state === "done", 10_000), "done is written first");
    assert.equal(store.readResult(id), "quick");
    assert.equal(settled, false, "the worker is still waiting on its hook");
    writeFileSync(release, "go");
    assert.equal(await run, "done");
  } finally {
    rmSync(release, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the hooks themselves -------------------------------------------------------------

test("a hook that hangs is cut off at its limit and reported", async () => {
  const hook = await receiver(() => {
    /* never answers */
  });
  const root = mkdtempSync(join(tmpdir(), "odw-notify-"));
  try {
    const store = new RunStore(root);
    const runId = store.create({ script: join(root, "wf.js"), args: null, source: root });
    store.updateStatus(runId, { state: "done" });
    const notify: NotifySettings = {
      command: [execPath, "-e", "setTimeout(() => {}, 30000)"],
      webhook: hook.url,
      on: ["done", "failed", "stopped"],
    };
    const lines: string[] = [];
    const started = Date.now();
    await notifyRunEnd(notify, { store, runId, state: "done" }, {
      log: (line) => lines.push(line),
      commandTimeoutSec: 0.3,
      webhookTimeoutMs: 300,
    });
    assert.ok(Date.now() - started < 6000, `the hooks took ${Date.now() - started}ms`);
    assert.equal(hook.posts.length, 1, "the POST was sent");
    assert.ok(lines.some((l) => /^notify: command '.+' timed out after 0\.3s/.test(l)), lines.join("\n"));
    assert.ok(lines.includes(`notify: webhook ${hook.origin} failed: timed out after 0.3s`), lines.join("\n"));
  } finally {
    await hook.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreachable webhook or a missing command is logged, never thrown", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-notify-"));
  try {
    const store = new RunStore(root);
    const runId = store.create({ script: join(root, "wf.js"), args: null, source: root });
    store.updateStatus(runId, { state: "failed" });
    // Grab a free port, then close it again: nothing listens there.
    const gone = await receiver();
    await gone.close();
    const lines: string[] = [];
    await notifyRunEnd(
      { command: ["odw-no-such-notify-command"], webhook: gone.url, on: ["failed"] },
      { store, runId, state: "failed", error: "boom" },
      { log: (line) => lines.push(line) },
    );
    const logged = lines.join("\n");
    assert.match(logged, /^notify: command 'odw-no-such-notify-command' exited with code 127: failed to launch/m);
    assert.ok(lines.some((l) => l.startsWith(`notify: webhook ${gone.origin} failed: `)), logged);
    assert.doesNotMatch(logged, /SECRET/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the summary line reads like a chat message", () => {
  const end: RunEnd = {
    runId: "20261017-041600-abc123",
    runDir: "/runs/deep-research/20261017-041600-abc123",
    workflow: "deep-research",
    state: "done",
    createdAt: 1_000,
    finishedAt: 1_252,
    durationSec: 252,
    counts: { agents: 12, done: 11, failed: 1 },
    resultFile: null,
  };
  assert.equal(summaryLine(end), "odw · deep-research finished in 4m12s · 12 agents, 1 failed");
  assert.equal(
    summaryLine({ ...end, state: "failed", durationSec: 3, counts: { agents: 0, done: 0, failed: 0 }, error: "x" }),
    "odw · deep-research failed after 3s · no agents",
  );
  assert.equal(
    summaryLine({ ...end, state: "stopped", durationSec: 3725, counts: { agents: 1, done: 1, failed: 0 } }),
    "odw · deep-research stopped after 1h02m · 1 agent",
  );
  assert.deepEqual(
    ["0s", "45s", "1m05s", "4m12s", "59m59s", "1h00m"],
    [0, 45, 65, 252, 3599, 3600].map(formatDuration),
  );

  const payload = webhookPayload({ ...end, state: "failed", error: "kaboom" });
  assert.deepEqual(Object.keys(payload), [
    "runId",
    "workflow",
    "state",
    "createdAt",
    "finishedAt",
    "durationSec",
    "counts",
    "error",
    "text",
    "content",
    "allowed_mentions",
  ]);
  assert.equal(payload.error, "kaboom");
  assert.equal(payload.text, "odw · deep-research failed after 4m12s · 12 agents, 1 failed", "no error in the text");
  assert.deepEqual(payload.allowed_mentions, { parse: [] }, "Discord never pings from a run's text");
  assert.equal("error" in webhookPayload(end), false);

  assert.equal(webhookOrigin("https://hooks.slack.com/services/T0/B0/XYZ?x=1"), "https://hooks.slack.com");
  assert.equal(webhookOrigin("http://127.0.0.1:8080/hook"), "http://127.0.0.1:8080");
});

test("/api/settings shows which hooks are set, never their secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-notify-"));
  const config = defaultConfig();
  const handle = await startServer({
    store: new RunStore(root),
    port: 0,
    host: "127.0.0.1",
    cwd: root,
    config,
    claudeProjectsRoot: join(root, "no-claude"),
  });
  try {
    let settings = await fetch(`${handle.url}/api/settings`).then((r) => r.json());
    assert.deepEqual(settings.notify, { command: false, webhook: null, on: ["done", "failed", "stopped"] });

    config.settings.notify = {
      command: ["notify-send", "--token", "SECRETARG"],
      webhook: "https://hooks.slack.com/services/T0/B0/SECRETPATH?token=SECRETQUERY",
      on: ["failed"],
    };
    const raw = await fetch(`${handle.url}/api/settings`).then((r) => r.text());
    settings = JSON.parse(raw);
    assert.deepEqual(settings.notify, { command: true, webhook: "https://hooks.slack.com", on: ["failed"] });
    assert.doesNotMatch(raw, /SECRET/);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
