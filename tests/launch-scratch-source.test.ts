import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { loadConfig } from "../src/adapters/config.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { startServer, type ServeHandle } from "../src/runtime/server.js";
import { withWorkspace } from "../src/workspace.js";

// Regression for the desktop-app failure (ERR_FS_CP_EINVAL): the sidecar runs
// with cwd `/`, a GUI launch with an empty source dir inherited it, and
// copy-mode workspace isolation tried to copy `/` into a temp subdirectory.

// --- the workspace copy guard -------------------------------------------------

test("copy mode refuses a source that contains the temp workspace (root), with a clear error", async () => {
  await assert.rejects(
    () => withWorkspace("/", "copy", async () => "unreached"),
    /cannot copy-isolate from '\/'|copy a directory into itself/,
  );
});

test("copy mode still works for an ordinary project directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-proj-"));
  try {
    writeFileSync(join(dir, "a.txt"), "hello");
    const out = await withWorkspace(dir, "copy", async (ws) => ws.path);
    assert.ok(out.includes("odw-ws-"), "ran inside an isolated copy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a GUI launch with no source uses a copy-safe scratch dir ------------------

/** Mock CLI that ignores its workspace and replies with a fixed script payload. */
function copyModeConfig(dir: string): string {
  const path = join(dir, "odw.config.json");
  const reply = JSON.stringify({ script: "export const meta = { name: 'noop', description: 'd' }\nreturn 1\n" });
  const js =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(" +
    JSON.stringify(reply) +
    "))";
  writeFileSync(
    path,
    JSON.stringify({
      defaultAdapter: "mock",
      // copy mode is the DEFAULT and the mode that hit the bug — assert it here,
      // not the inplace path the other server tests use.
      workspaceMode: "copy",
      adapters: { mock: { command: [execPath, "-e", js], stdin: "{prompt}" } },
    }),
  );
  return path;
}

async function bootRootCwd(root: string): Promise<{ handle: ServeHandle; store: RunStore }> {
  const configPath = copyModeConfig(root);
  const store = new RunStore(join(root, "runs"));
  // cwd: "/" reproduces the desktop app's sidecar working directory exactly.
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: "/",
    config: loadConfig(configPath),
    configPath,
    claudeProjectsRoot: join(root, "no-claude"),
  });
  return { handle, store };
}

async function waitTerminal(store: RunStore, runId: string, ms = 20000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = String(store.readStatus(runId).state ?? "");
    if (TERMINAL_STATES.has(state)) return state;
    if (Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("POST /api/runs with copy mode and NO source runs in a scratch dir, not the serve cwd `/`", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-scratch-"));
  const { handle, store } = await bootRootCwd(root);
  try {
    const res = await post(`${handle.url}/api/runs`, {
      script: "export const meta = { name: 'w', description: 'd' }\nreturn await agent('hi')\n",
    });
    assert.equal(res.status, 200);
    const { runId } = (await res.json()) as { runId: string };
    // The run must NOT inherit source `/` (which would EINVAL on the copy).
    assert.notEqual(store.readMeta(runId).source, "/");
    assert.match(String(store.readMeta(runId).source), /odw-launch-scratch/);
    const state = await waitTerminal(store, runId);
    assert.equal(state, "done", "the agent ran in copy mode without an EINVAL");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/generate with cwd `/` and no source does not fail on the workspace copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-scratch-"));
  const { handle, store } = await bootRootCwd(root);
  try {
    const res = await post(`${handle.url}/api/generate`, { task: "make a noop workflow", adapter: "mock" });
    assert.equal(res.status, 200);
    const { runId } = (await res.json()) as { runId: string };
    assert.match(String(store.readMeta(runId).source), /odw-launch-scratch/);
    const state = await waitTerminal(store, runId);
    assert.equal(state, "done", "generation completed instead of EINVAL on copying /");
    assert.match((store.readResult(runId) as { script: string }).script, /noop/);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit but non-existent source is still rejected with 400", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-scratch-"));
  const { handle } = await bootRootCwd(root);
  try {
    const res = await post(`${handle.url}/api/runs`, {
      script: "export const meta = { name: 'w', description: 'd' }\nreturn 1\n",
      source: join(root, "does-not-exist"),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /source directory does not exist/);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
