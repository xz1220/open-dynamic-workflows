import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import { RunStore } from "../src/runtime/run-store.js";
import { listWorkflowSummaries, workflowDetail } from "../src/runtime/workflows-view.js";

/** A project cwd plus separate global ODW/Claude roots, with `config` wired to them. */
function scaffold() {
  const tmp = mkdtempSync(join(tmpdir(), "odw-wfview-"));
  const project = join(tmp, "project");
  const globalWf = join(tmp, "global-odw");
  const globalClaudeWf = join(tmp, "global-claude");
  const runs = join(tmp, "runs");
  mkdirSync(join(project, ".odw", "workflows"), { recursive: true });
  mkdirSync(globalWf, { recursive: true });
  mkdirSync(globalClaudeWf, { recursive: true });
  mkdirSync(runs, { recursive: true });
  const config = defaultConfig();
  config.settings.workflowsRoot = globalWf;
  config.settings.claudeWorkflowsRoot = globalClaudeWf;
  const store = new RunStore(runs);
  const write = (dir: string, name: string, body = "return 1\n") =>
    writeFileSync(
      join(dir, `${name}.js`),
      `export const meta = { name: "${name}", description: "${name} desc" }\n${body}`,
    );
  return { tmp, project, globalWf, globalClaudeWf, config, store, write };
}

test("listWorkflowSummaries shows a cross-provider name collision under BOTH providers", () => {
  const s = scaffold();
  try {
    s.write(s.globalWf, "deep-research"); // ODW global
    s.write(s.globalClaudeWf, "deep-research"); // Claude global — same name, lower precedence
    s.write(s.globalClaudeWf, "claude-only"); // a uniquely-named Claude workflow

    const list = listWorkflowSummaries(s.project, s.config, s.store);
    const odwDR = list.find((w) => w.provider === "odw" && w.name === "deep-research");
    const claudeDR = list.find((w) => w.provider === "claude" && w.name === "deep-research");
    const claudeOnly = list.find((w) => w.provider === "claude" && w.name === "claude-only");

    // The whole point of the fix: the Claude entry is NOT dropped behind the ODW one.
    assert.ok(odwDR, "ODW deep-research is listed");
    assert.ok(claudeDR, "Claude deep-research is listed (not hidden by the ODW one)");
    assert.equal(odwDR!.shadowed, false);
    assert.equal(claudeDR!.shadowed, true); // odw run deep-research → the ODW one
    assert.ok(claudeOnly, "a uniquely-named Claude workflow is listed");
    assert.equal(claudeOnly!.shadowed, false);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("workflowDetail(provider) opens the shadowed Claude source, not the ODW winner", () => {
  const s = scaffold();
  try {
    s.write(s.globalWf, "deep-research", "// odw body\nreturn 1\n");
    s.write(s.globalClaudeWf, "deep-research", "// claude body\nreturn 1\n");

    // No provider → the run-resolution winner (ODW wins by precedence).
    const winner = workflowDetail(s.project, s.config, s.store, "deep-research");
    assert.equal(winner?.provider, "odw");
    assert.match(winner!.source, /odw body/);

    // provider=claude → the shadowed Claude entry and its OWN source.
    const claude = workflowDetail(s.project, s.config, s.store, "deep-research", "claude");
    assert.equal(claude?.provider, "claude");
    assert.equal(claude?.shadowed, true);
    assert.match(claude!.source, /claude body/);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a shadowed entry does NOT claim the run-resolution winner's run history", () => {
  const s = scaffold();
  try {
    s.write(s.globalWf, "deep-research"); // ODW — wins `odw run deep-research`
    s.write(s.globalClaudeWf, "deep-research"); // Claude — shadowed
    // Seed a run into the name-keyed bucket. `odw run deep-research` could only ever
    // have produced this against the ODW winner; the Claude entry never ran it.
    s.store.create({ workflowName: "deep-research", script: "/x/deep-research.js", args: null, source: "/x" });

    const list = listWorkflowSummaries(s.project, s.config, s.store);
    const odwDR = list.find((w) => w.provider === "odw" && w.name === "deep-research")!;
    const claudeDR = list.find((w) => w.provider === "claude" && w.name === "deep-research")!;
    assert.equal(odwDR.runCount, 1, "the winner is credited with the run");
    assert.equal(claudeDR.runCount, 0, "the shadowed entry is NOT credited with the winner's run");

    // Detail must agree: the shadowed entry reports no runs, the winner reports its run.
    const winnerDet = workflowDetail(s.project, s.config, s.store, "deep-research");
    const claudeDet = workflowDetail(s.project, s.config, s.store, "deep-research", "claude");
    assert.equal(winnerDet?.runs.length, 1);
    assert.equal(winnerDet?.runCount, 1);
    assert.equal(claudeDet?.runs.length, 0);
    assert.equal(claudeDet?.runCount, 0);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("intra-provider duplicate names still collapse to the higher-precedence root", () => {
  const s = scaffold();
  try {
    // Same name in project .odw AND global .odw → one ODW entry (project wins).
    s.write(join(s.project, ".odw", "workflows"), "shared");
    s.write(s.globalWf, "shared");

    const odw = listWorkflowSummaries(s.project, s.config, s.store).filter(
      (w) => w.provider === "odw" && w.name === "shared",
    );
    assert.equal(odw.length, 1, "the same provider+name is deduped to one row");
    assert.equal(odw[0]!.origin, "project");
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});
