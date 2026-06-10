import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { loadConfig } from "../src/adapters/config.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { startServer, type ServeHandle } from "../src/runtime/server.js";

// L3 (launch.md §3.1 + §3.5): the server's write endpoints and their guards.

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-launchsrv-"));

const NO_AGENT_SCRIPT =
  "export const meta = { name: 'noop-wf', description: 'd', phases: [{ title: 'Only' }] }\nreturn { ok: true, n: (args && args.n) || 0 }\n";

/** Config file with a mock adapter that replies with a fixed JSON script payload. */
function writeMockConfig(dir: string, opts: { workflowsRoot?: string } = {}): string {
  const path = join(dir, "odw.config.json");
  const reply = JSON.stringify({ script: NO_AGENT_SCRIPT });
  const js =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
    `process.stdout.write(${JSON.stringify(reply)})})`;
  writeFileSync(
    path,
    JSON.stringify({
      defaultAdapter: "mock",
      workspaceMode: "inplace",
      ...(opts.workflowsRoot ? { workflowsRoot: opts.workflowsRoot } : {}),
      adapters: { mock: { command: [execPath, "-e", js], stdin: "{prompt}" } },
    }),
  );
  return path;
}

async function boot(root: string, host = "127.0.0.1"): Promise<{ handle: ServeHandle; store: RunStore; configPath: string }> {
  const configPath = writeMockConfig(root, { workflowsRoot: join(root, "global-wf") });
  const store = new RunStore(join(root, "runs"));
  const handle = await startServer({
    store,
    port: 0,
    host,
    cwd: root,
    config: loadConfig(configPath),
    configPath,
    claudeProjectsRoot: join(root, "no-claude"),
  });
  return { handle, store, configPath };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function waitTerminal(store: RunStore, runId: string, ms = 15000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = String(store.readStatus(runId).state ?? "");
    if (TERMINAL_STATES.has(state)) return state;
    if (Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("GET /api/adapters lists configured adapters with install/default/permission info", async () => {
  const root = tempRoot();
  const { handle } = await boot(root);
  try {
    const rows = (await (await fetch(`${handle.url}/api/adapters`)).json()) as Array<
      Record<string, unknown>
    >;
    const mock = rows.find((r) => r.name === "mock");
    assert.ok(mock, "the config's adapter is listed");
    assert.equal(mock!.isDefault, true);
    assert.equal(mock!.installed, true, "node executable resolves");
    assert.equal(typeof mock!.permissionNote, "string");
    // Built-ins from the base layer are present too (claude/codex/...).
    assert.ok(rows.some((r) => r.name === "claude"));
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/runs with an inline script starts a run that completes with a result", async () => {
  const root = tempRoot();
  const { handle, store } = await boot(root);
  try {
    const res = await post(`${handle.url}/api/runs`, { script: NO_AGENT_SCRIPT, args: { n: 5 } });
    assert.equal(res.status, 200);
    const { runId } = (await res.json()) as { runId: string };
    assert.ok(runId);
    assert.equal(store.readMeta(runId).origin, "launch");
    assert.equal(await waitTerminal(store, runId), "done");
    assert.deepEqual(store.readResult(runId), { ok: true, n: 5 });
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/runs rejects a non-compiling inline script with 400 and no run", async () => {
  const root = tempRoot();
  const { handle, store } = await boot(root);
  try {
    const res = await post(`${handle.url}/api/runs`, { script: "return 1\n" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /export const meta/);
    assert.equal(store.listRuns().length, 0, "no run directory was created");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/runs validates its inputs: script XOR name, adapter, source", async () => {
  const root = tempRoot();
  const { handle } = await boot(root);
  try {
    let res = await post(`${handle.url}/api/runs`, { script: NO_AGENT_SCRIPT, name: "x" });
    assert.equal(res.status, 400);
    res = await post(`${handle.url}/api/runs`, {});
    assert.equal(res.status, 400);
    res = await post(`${handle.url}/api/runs`, { name: "definitely-not-a-workflow" });
    assert.equal(res.status, 404);
    res = await post(`${handle.url}/api/runs`, { script: NO_AGENT_SCRIPT, adapter: "ghost" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /unknown adapter/);
    res = await post(`${handle.url}/api/runs`, { script: NO_AGENT_SCRIPT, source: join(root, "missing") });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /source directory/);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/generate runs the built-in generator to a script result", async () => {
  const root = tempRoot();
  const { handle, store } = await boot(root);
  try {
    const res = await post(`${handle.url}/api/generate`, { task: "make a noop workflow", adapter: "mock" });
    assert.equal(res.status, 200);
    const { runId } = (await res.json()) as { runId: string };
    assert.equal(store.readMeta(runId).workflowName, "generate-workflow");
    assert.equal(store.readMeta(runId).adapter, "mock");
    assert.equal(await waitTerminal(store, runId), "done");
    const result = store.readResult(runId) as { script: string; attempts: number };
    assert.equal(result.attempts, 1);
    assert.match(result.script, /noop-wf/);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/generate requires a task", async () => {
  const root = tempRoot();
  const { handle } = await boot(root);
  try {
    const res = await post(`${handle.url}/api/generate`, { task: "  " });
    assert.equal(res.status, 400);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/workflows saves into the managed dir; duplicates 409; list sees it", async () => {
  const root = tempRoot();
  const { handle } = await boot(root);
  try {
    const res = await post(`${handle.url}/api/workflows`, {
      name: "noop-wf",
      source: NO_AGENT_SCRIPT,
      scope: "global",
    });
    assert.equal(res.status, 200);
    const { path } = (await res.json()) as { path: string };
    assert.equal(path, join(root, "global-wf", "noop-wf.js"));
    assert.equal(readFileSync(path, "utf8"), NO_AGENT_SCRIPT);

    const dup = await post(`${handle.url}/api/workflows`, {
      name: "noop-wf",
      source: NO_AGENT_SCRIPT,
      scope: "global",
    });
    assert.equal(dup.status, 409);

    const listed = (await (await fetch(`${handle.url}/api/workflows`)).json()) as Array<{ name: string }>;
    assert.ok(listed.some((w) => w.name === "noop-wf"), "Workspace list sees the saved workflow");

    // Bad names and bad sources are rejected before any write.
    assert.equal((await post(`${handle.url}/api/workflows`, { name: "../evil", source: NO_AGENT_SCRIPT, scope: "global" })).status, 400);
    assert.equal((await post(`${handle.url}/api/workflows`, { name: "ok", source: "return 1", scope: "global" })).status, 400);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/workflows scope=project writes under <projectDir>/.odw/workflows", async () => {
  const root = tempRoot();
  const { handle } = await boot(root);
  try {
    const res = await post(`${handle.url}/api/workflows`, {
      name: "proj-wf",
      source: NO_AGENT_SCRIPT,
      scope: "project",
      projectDir: root,
    });
    assert.equal(res.status, 200);
    assert.ok(existsSync(join(root, ".odw", "workflows", "proj-wf.js")));
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- §3.5 guards ----------------------------------------------------------------

test("writeGuard: wrong content-type 415, cross-origin 403, same-origin passes", async () => {
  const root = tempRoot();
  const { handle } = await boot(root);
  try {
    const raw = await fetch(`${handle.url}/api/generate`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "task=x",
    });
    assert.equal(raw.status, 415);

    const cross = await post(`${handle.url}/api/runs`, { script: NO_AGENT_SCRIPT }, { origin: "https://evil.example" });
    assert.equal(cross.status, 403);

    const same = await post(
      `${handle.url}/api/runs`,
      { script: NO_AGENT_SCRIPT },
      { origin: handle.url },
    );
    assert.equal(same.status, 200);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Host-header allowlist rejects DNS-rebinding names on loopback binds", async () => {
  const root = tempRoot();
  const { handle } = await boot(root);
  // fetch() refuses to forge Host, which is exactly the point of the guard — a
  // rebinding attack arrives with the hostile name in Host. Speak raw HTTP.
  const rawGet = (host: string) =>
    new Promise<number>((resolvePromise, reject) => {
      const req = request(
        { host: "127.0.0.1", port: handle.port, path: "/api/runs", method: "GET", setHost: false, headers: { host } },
        (res) => {
          res.resume();
          resolvePromise(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    assert.equal(await rawGet("attacker.example"), 403);
    assert.equal(await rawGet(`127.0.0.1:${handle.port}`), 200);
    assert.equal(await rawGet("localhost:9999"), 200, "any loopback name passes regardless of port");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("off-loopback binds refuse every write with 409 but still serve reads", async () => {
  const root = tempRoot();
  const { handle } = await boot(root, "0.0.0.0");
  try {
    const reads = await fetch(`http://127.0.0.1:${handle.port}/api/runs`);
    assert.equal(reads.status, 200);
    const write = await post(`http://127.0.0.1:${handle.port}/api/runs`, { script: NO_AGENT_SCRIPT });
    assert.equal(write.status, 409);
    const control = await post(`http://127.0.0.1:${handle.port}/api/runs/whatever/control`, { action: "stop" });
    assert.equal(control.status, 409);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
