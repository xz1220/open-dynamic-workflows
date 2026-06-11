import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig, listAdapters, loadConfig } from "../src/adapters/config.js";
import { buildContext } from "../src/context.js";
import { loadWorkflowScript, scanDualCompat } from "../src/loader.js";
import { createPrimitives } from "../src/primitives.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { startServer, type ServeHandle } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";

// Regression tests for the high-effort review findings fixed on this branch.

const META = "export const meta = { name: 'x', description: 'd' }\n";

// #1 — banned APIs inside template interpolations are now flagged.
test("scanDualCompat catches Date.now() inside a template interpolation", () => {
  assert.equal(scanDualCompat(META + "log(`at ${Date.now()}`)\nreturn 1").length, 1);
  assert.deepEqual(scanDualCompat(META + "log(`Date.now() is banned`)\nreturn 1"), [], "template text is not a false positive");
  assert.deepEqual(scanDualCompat(META + "// Date.now()\nreturn 1"), [], "comments still ignored");
  assert.equal(scanDualCompat(META + "log(`${a ? 'Math.random()' : Math.random()}`)\nreturn 1").length, 1, "string inside interp ignored, code caught");
});

// #2 — a body that declares its own `validate` compiles (Claude-compat both ways).
test("a workflow declaring `const validate` still compiles", () => {
  const w = loadWorkflowScript(META + "const validate = (s) => s.trim()\nreturn validate('  hi  ')", "wf.js");
  assert.equal(w.meta.name, "x");
});

test("the validate() primitive is still injected when the body does not declare it", async () => {
  const ctx = buildContext(defaultConfig());
  const prims = createPrimitives(ctx);
  // Build a tiny workflow that calls validate() and returns its ok flag.
  const w = loadWorkflowScript(META + "return validate(\"export const meta = { name: 'y', description: 'd' }\\nreturn 1\").ok", "wf.js");
  assert.equal(await w.run(prims, null), true);
});

// #6 — permissionNote handles --flag=value forms.
test("listAdapters surfaces --flag=value permission postures", () => {
  const cfg = loadConfig(null);
  cfg.adapters["danger"] = { name: "danger", command: ["codex", "exec", "--sandbox=danger-full-access"] };
  cfg.adapters["bypass"] = { name: "bypass", command: ["claude", "-p", "--permission-mode=bypassPermissions"] };
  const rows = listAdapters(cfg);
  assert.match(rows.find((r) => r.name === "danger")!.permissionNote, /sandbox: danger-full-access/);
  assert.match(rows.find((r) => r.name === "bypass")!.permissionNote, /permission mode: bypassPermissions/);
});

// #10 / #24 — inline runs are flagged, and rerun re-archives them (no divergence note).
test("an inline run records meta.inline and suppresses the run-by-name divergence note", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  try {
    const store = new RunStore(join(root, "runs"));
    // meta.name 'gen' differs from the archived stem 'workflow' — without the
    // inline exemption this would emit the divergence log.
    const id = store.create({
      script: "",
      inlineSource: "export const meta = { name: 'gen', description: 'd' }\nreturn 1\n",
      args: null,
      source: root,
      workflowName: "gen",
    });
    assert.equal(store.readMeta(id).inline, true);
    assert.equal(await executeRun(store.runDir(id)), "done");
    const diverged = store.readEvents(id).some((e) => e.type === "log" && /declares meta\.name/.test(String(e.message)));
    assert.equal(diverged, false, "inline run must not emit the divergence note");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- server-level review fixes -------------------------------------------------

function mockServerConfig(dir: string): string {
  const path = join(dir, "odw.config.json");
  const js = "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('ok'))";
  writeFileSync(
    path,
    JSON.stringify({
      defaultAdapter: "mock",
      workspaceMode: "inplace",
      workflowsRoot: join(dir, "gwf"),
      adapters: {
        mock: { command: [execPath, "-e", js], stdin: "{prompt}" },
        // configured but its CLI is a path that does not exist → not installed
        ghost: { command: [join(dir, "no-such-cli")], stdin: "{prompt}" },
      },
    }),
  );
  return path;
}

async function boot(root: string): Promise<{ handle: ServeHandle; store: RunStore }> {
  const configPath = mockServerConfig(root);
  const store = new RunStore(join(root, "runs"));
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: root,
    config: loadConfig(configPath),
    configPath,
    claudeProjectsRoot: join(root, "no-claude"),
  });
  return { handle, store };
}

const NOOP = "export const meta = { name: 'noop', description: 'd' }\nreturn 1\n";
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// #14 — Content-Type is compared by MIME essence, not substring.
test("writeGuard accepts application/json;charset and rejects text/plain;x=application/json", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  const { handle } = await boot(root);
  try {
    const good = await post(`${handle.url}/api/runs`, { script: NOOP }, { "content-type": "application/json; charset=utf-8" });
    assert.equal(good.status, 200);
    // A CORS "simple request" disguising JSON in a parameter must NOT pass.
    const bad = await fetch(`${handle.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "text/plain; x=application/json" },
      body: JSON.stringify({ script: NOOP }),
    });
    assert.equal(bad.status, 415);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// #26 — a configured-but-not-installed adapter is rejected server-side.
test("POST /api/runs rejects an uninstalled adapter with 400", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  const { handle } = await boot(root);
  try {
    const res = await post(`${handle.url}/api/runs`, { script: NOOP, adapter: "ghost" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not found on PATH/);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// #15 — a name typed with a .js extension is saved as the stem.
test("POST /api/workflows strips a trailing .js so `odw run <name>` resolves", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  const { handle } = await boot(root);
  try {
    const res = await post(`${handle.url}/api/workflows`, { name: "review.js", source: NOOP, scope: "global" });
    assert.equal(res.status, 200);
    const { path } = (await res.json()) as { path: string };
    assert.equal(path, join(root, "gwf", "review.js"), "saved as review.js, not review.js.js");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// #7 — capability probe reflects the bind so the SPA can hide write affordances.
test("GET /api/capabilities reports writable=true on a loopback bind", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  const { handle } = await boot(root);
  try {
    const caps = (await (await fetch(`${handle.url}/api/capabilities`)).json()) as { writable: boolean };
    assert.equal(caps.writable, true);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/capabilities reports writable=false on an off-loopback bind", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  const configPath = mockServerConfig(root);
  const store = new RunStore(join(root, "runs"));
  const handle = await startServer({ store, port: 0, host: "0.0.0.0", cwd: root, config: loadConfig(configPath), configPath, claudeProjectsRoot: join(root, "no-claude") });
  try {
    const caps = (await (await fetch(`http://127.0.0.1:${handle.port}/api/capabilities`)).json()) as { writable: boolean };
    assert.equal(caps.writable, false);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// #3 — an oversized body settles (400) instead of hanging the handler.
test("an over-cap request body is rejected, not left hanging", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  const { handle } = await boot(root);
  try {
    const huge = "x".repeat(600 * 1024); // > MAX_BODY_BYTES (512KB)
    const status = await new Promise<number>((resolvePromise, reject) => {
      const req = request(
        { host: "127.0.0.1", port: handle.port, path: "/api/runs", method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolvePromise(res.statusCode ?? 0));
        },
      );
      // The server destroys the socket past the cap; either a 400 lands first or
      // the socket errors — both prove the handler did not hang silently.
      req.on("error", () => resolvePromise(-1));
      req.end(JSON.stringify({ script: huge }));
    });
    assert.ok(status === 400 || status === -1, `got ${status}`);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
