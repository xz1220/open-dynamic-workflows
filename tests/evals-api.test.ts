/**
 * GET /api/evals and GET /api/evals/:name/:id (ODW extension): the reports
 * `odw eval` keeps under the runs root, served read only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evalHash, parseEvalDefinition } from "../src/eval/definition.js";
import { saveReport, type EvalReport } from "../src/eval/report.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";

test("GET /api/evals lists the kept reports, newest first; /api/evals/:name/:id serves one; names are checked", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-eval-api-"));
  try {
    const store = new RunStore(join(root, "runs"));
    const def = parseEvalDefinition({ workflow: "echo", cases: [{ name: "one", args: { word: "x" } }] }, "/p/echo.json", "echo");
    const { name, description, ...definition } = def;
    const report = (id: string, passed: number): EvalReport => ({
      version: 1,
      name,
      id,
      file: "/p/echo.json",
      description,
      evalHash: evalHash(def),
      definition,
      workflow: { ref: "echo", script: "/p/echo.js", sourceHash: null },
      odwVersion: "0.5.0",
      cliVersions: {},
      startedAt: "2026-10-18T12:00:00.000Z",
      finishedAt: "2026-10-18T12:00:05.000Z",
      wallMs: 5000,
      totals: { runs: 1, passed, failed: 1 - passed, passRate: passed, costUsd: null, inputTokens: null, outputTokens: null },
      cells: [{ case: "one", adapter: "a", runs: 1, passed, passRate: passed, medianMs: 100, costUsd: null, meanCostUsd: null, meanTokens: null, runIds: ["r1"] }],
      runs: [],
      baseline: null,
    });
    const older = report("20261017-090000-aaaaaa", 1);
    const newer = report("20261018-090000-bbbbbb", 0);
    saveReport(store.root, older);
    saveReport(store.root, newer);
    writeFileSync(join(store.root, "_evals", "echo", "junk.json"), "not json");

    const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "none") });
    try {
      const list = await fetch(`${handle.url}/api/evals`);
      assert.equal(list.status, 200);
      const rows = (await list.json()) as Array<Record<string, unknown>>;
      assert.deepEqual(rows.map((row) => row.id), [newer.id, older.id], "newest first; a file that is no report is skipped");
      assert.deepEqual(rows[0], {
        name: "echo",
        id: newer.id,
        description: null,
        workflow: "echo",
        evalHash: newer.evalHash,
        startedAt: newer.startedAt,
        finishedAt: newer.finishedAt,
        totals: newer.totals,
        adapters: ["a"],
        cases: 1,
        regressed: null,
      });

      const one = await fetch(`${handle.url}/api/evals/echo/${older.id}`);
      assert.equal(one.status, 200);
      assert.ok(one.headers.get("etag"));
      assert.deepEqual(await one.json(), older);

      assert.equal((await fetch(`${handle.url}/api/evals/echo/20990101-000000-cccccc`)).status, 404);
      assert.equal((await fetch(`${handle.url}/api/evals/other/${older.id}`)).status, 404);
      for (const path of ["echo", `echo/${older.id}/x`, "a%2Fb/x", "echo/x%20y", ".../x", "echo/..."]) {
        const bad = await fetch(`${handle.url}/api/evals/${path}`);
        assert.equal(bad.status, 400, path);
      }
      const write = await fetch(`${handle.url}/api/evals`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.notEqual(write.status, 200, "read only");
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
