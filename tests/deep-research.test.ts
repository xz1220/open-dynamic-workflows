import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

const mockAgent = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));
const deepResearch = fileURLToPath(new URL("../examples/deep-research.js", import.meta.url));

// The flagship acceptance: a Claude Code-format workflow script written for
// Claude's runtime runs unchanged on ours, driven by a schema-satisfying mock.
test("deep-research.js runs end-to-end (plan -> search -> extract -> vote -> report)", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-dr-"));
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "mock",
        workspaceMode: "inplace",
        schemaRetries: 1,
        concurrency: 8,
        adapters: { mock: { command: [execPath, mockAgent], stdin: "{prompt}" } },
      }),
    );

    const store = new RunStore(root);
    const id = store.create({
      script: deepResearch,
      args: { question: "What is a token-bucket rate limiter?", maxAngles: 2, sourcesPerAngle: 2 },
      source: root,
      configPath: config,
    });

    const state = await executeRun(store.runDir(id));
    assert.equal(state, "done", `expected done; error=${JSON.stringify(store.readError(id))}`);

    const result = store.readResult(id) as {
      question: string;
      report: { markdown: string };
      verification: { accepted: number; rejected: number; totalVoted: number };
      acceptedClaims: unknown[];
      rejectedClaims: unknown[];
      stats: { angles: number; sources: number; extractedClaims: number; votedClaims: number };
    };
    assert.match(result.question, /rate limiter/);
    assert.equal(typeof result.report.markdown, "string");
    assert.ok(result.stats.angles >= 1, "planned at least one angle");
    assert.ok(result.stats.extractedClaims >= 1, "extracted at least one claim");
    assert.ok(result.stats.votedClaims >= 1, "voted on at least one claim");
    assert.ok(Array.isArray(result.acceptedClaims), "returned accepted claims");
    assert.ok(Array.isArray(result.rejectedClaims), "returned rejected claims");

    // The run emitted lifecycle + agent events across all five phases.
    const phases = new Set(store.readEvents(id).map((e) => e.phase).filter(Boolean));
    for (const p of ["Plan", "Search", "Extract", "Vote", "Report"]) {
      assert.ok(phases.has(p), `expected progress under phase '${p}'`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
