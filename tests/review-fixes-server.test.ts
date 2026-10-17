import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, listAdapters, loadConfig } from "../src/adapters/config.js";
import { buildContext } from "../src/context.js";
import { loadWorkflowScript, scanDualCompat } from "../src/loader.js";
import { createPrimitives } from "../src/primitives.js";
import { RunStore } from "../src/runtime/run-store.js";
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

// #6 — permissionNote handles value forms and autonomous harness flags.
test("listAdapters surfaces permission postures", () => {
  const cfg = loadConfig(null);
  cfg.adapters["danger"] = { name: "danger", command: ["codex", "exec", "--sandbox=danger-full-access"] };
  cfg.adapters["bypass"] = { name: "bypass", command: ["claude", "-p", "--permission-mode=bypassPermissions"] };
  cfg.adapters["auto"] = { name: "auto", command: ["opencode", "run", "--auto"] };
  cfg.adapters["force"] = { name: "force", command: ["agent", "--print", "--force"] };
  cfg.adapters["kilo-auto"] = { name: "kilo-auto", command: ["kilo", "run", "--auto"] };
  const rows = listAdapters(cfg);
  assert.match(rows.find((r) => r.name === "danger")!.permissionNote, /sandbox: danger-full-access/);
  assert.match(rows.find((r) => r.name === "bypass")!.permissionNote, /permission mode: bypassPermissions/);
  assert.match(rows.find((r) => r.name === "auto")!.permissionNote, /full autonomy.*explicit denies/);
  assert.match(rows.find((r) => r.name === "force")!.permissionNote, /full autonomy.*explicit denies/);
  assert.equal(rows.find((r) => r.name === "kilo-auto")!.permissionNote, "full autonomy");
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
  writeFileSync(
    path,
    JSON.stringify({
      workflowsRoot: join(dir, "gwf"),
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

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// #14 — Content-Type is compared by MIME essence, not substring.
test("writeGuard accepts application/json;charset and rejects text/plain;x=application/json", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  const { handle } = await boot(root);
  try {
    const good = await post(`${handle.url}/api/chat/sessions`, {}, { "content-type": "application/json; charset=utf-8" });
    assert.equal(good.status, 200);
    // A CORS "simple request" disguising JSON in a parameter must NOT pass.
    const bad = await fetch(`${handle.url}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "text/plain; x=application/json" },
      body: "{}",
    });
    assert.equal(bad.status, 415);
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

// #3 — an oversized body settles (413) instead of hanging the handler.
test("an over-cap request body is rejected, not left hanging", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-rf-"));
  const { handle } = await boot(root);
  try {
    const huge = "x".repeat(600 * 1024); // > MAX_BODY_BYTES (128KB)
    const status = await new Promise<number>((resolvePromise) => {
      const req = request(
        { host: "127.0.0.1", port: handle.port, path: "/api/chat/sessions", method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolvePromise(res.statusCode ?? 0));
        },
      );
      // The server answers 413 and drains the rest, so the client reads the
      // answer instead of a connection reset.
      req.on("error", () => resolvePromise(-1));
      req.end(JSON.stringify({ script: huge }));
    });
    assert.equal(status, 413);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
