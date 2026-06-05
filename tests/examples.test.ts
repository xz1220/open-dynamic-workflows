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
const exampleDir = fileURLToPath(new URL("../examples/", import.meta.url));

async function runExample(
  file: string,
  args: unknown,
): Promise<{ state: string; result: unknown; error: Record<string, unknown> | null }> {
  const root = mkdtempSync(join(tmpdir(), "odw-ex-"));
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
      script: join(exampleDir, file),
      args,
      source: root,
      configPath: config,
    });
    const state = await executeRun(store.runDir(id));
    return { state, result: store.readResult(id), error: store.readError(id) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("fan-out-reduce.js runs to a synthesized answer", async () => {
  const { state, result, error } = await runExample("fan-out-reduce.js", {
    question: "Design a cache.",
    drafts: 3,
  });
  assert.equal(state, "done", JSON.stringify(error));
  assert.equal(typeof result, "string");
});

test("adversarial-verify.js runs and returns confirmed findings", async () => {
  const { state, result, error } = await runExample("adversarial-verify.js", {
    target: "Review x",
    voters: 3,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { considered: number; confirmed: unknown[] };
  assert.ok(r.considered >= 1);
  assert.ok(Array.isArray(r.confirmed));
});

test("loop-until-dry.js runs bounded by maxRounds", async () => {
  const { state, result, error } = await runExample("loop-until-dry.js", {
    target: "find x",
    finders: 2,
    maxRounds: 2,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { rounds: number; discovered: unknown[] };
  assert.ok(r.rounds <= 2);
  assert.ok(Array.isArray(r.discovered));
});

test("routing.js classifies, routes, and grades", async () => {
  const { state, result, error } = await runExample("routing.js", {
    request: "Add dark mode to settings",
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { category: string; output: string; grade: { verdict: string } };
  assert.equal(typeof r.category, "string");
  assert.equal(typeof r.output, "string");
  assert.equal(typeof r.grade.verdict, "string");
});

test("generate-and-filter.js generates, dedupes, and keeps survivors", async () => {
  const { state, result, error } = await runExample("generate-and-filter.js", {
    topic: "Cut build times",
    generators: 3,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { unique: number; generated: number; kept: unknown[] };
  assert.ok(r.generated >= 1);
  assert.ok(Array.isArray(r.kept));
  assert.ok(r.kept.length >= 1);
});

test("tournament.js runs a bracket to a single winner", async () => {
  const { state, result, error } = await runExample("tournament.js", {
    task: "Design a cache",
    approaches: ["simple", "scalable", "safe", "fast"],
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { winner: { seed: number }; rounds: unknown[] };
  assert.ok(r.winner && typeof r.winner.seed === "number");
  assert.ok(Array.isArray(r.rounds) && r.rounds.length >= 1);
});

test("agent-daily-digest.js runs end-to-end (discover -> extract -> synthesize -> verify -> report)", async () => {
  const { state, result, error } = await runExample("agent-daily-digest.js", {
    date: "2026-06-04",
    maxSessions: 5,
    maxVerify: 3,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as {
    date: string;
    scope: { agents: string[]; sessionCount: number };
    digest: { headline: string; sections: Record<string, unknown[]> };
    markdown: string;
    stats: { sessions: number; candidateItems: number };
  };
  assert.equal(typeof r.markdown, "string");
  assert.ok(r.markdown.length > 0, "rendered a non-empty digest");
  assert.ok(Array.isArray(r.digest.sections.progress), "digest has a progress section");
  assert.ok(Array.isArray(r.digest.sections.followups), "digest has a followups section");
  assert.ok(r.stats.sessions >= 1, "scanned at least one session");
});
