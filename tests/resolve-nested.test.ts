import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import { main } from "../src/cli.js";
import { WorkflowScriptError } from "../src/errors.js";
import { listWorkflows, resolveWorkflow, workflowCandidates } from "../src/workflows/resolve.js";

// Workflow lookup in a monorepo (Claude Code dialect): every `.odw/workflows`
// and `.claude/workflows` from the working directory up to the repository
// root, nearest first.

/** A repository `repo/` (a `.git` directory marks its root) with a package `repo/packages/foo`, and empty global roots. */
function monorepo(opts: { git?: boolean } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "odw-nested-"));
  const repo = join(tmp, "repo");
  const pkg = join(repo, "packages", "foo");
  mkdirSync(pkg, { recursive: true });
  if (opts.git !== false) mkdirSync(join(repo, ".git"));
  const globalWf = join(tmp, "global-workflows");
  const globalClaudeWf = join(tmp, "global-claude-workflows");
  mkdirSync(globalWf);
  mkdirSync(globalClaudeWf);
  const config = defaultConfig();
  config.settings.workflowsRoot = globalWf;
  config.settings.claudeWorkflowsRoot = globalClaudeWf;
  const configPath = join(tmp, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ workflowsRoot: globalWf, claudeWorkflowsRoot: globalClaudeWf }));
  const writeWf = (base: string, kind: ".odw" | ".claude", name: string) => {
    const dir = join(base, kind, "workflows");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${name}.js`);
    writeFileSync(p, `export const meta = { name: "${name}", description: "x" }\nreturn 1\n`);
    return p;
  };
  return { tmp, repo, pkg, globalWf, config, configPath, writeWf };
}

async function cli(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  const home = process.cwd();
  process.chdir(cwd);
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.chdir(home);
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("from a package, a name only the repository root has resolves there", () => {
  const m = monorepo();
  try {
    const root = m.writeWf(m.repo, ".claude", "audit");
    const r = resolveWorkflow("audit", { cwd: m.pkg, config: m.config });
    assert.equal(r.scriptPath, root);
    assert.equal(r.origin, "project");
    assert.equal(r.provider, "claude");
    assert.equal(r.rootLabel, "../../.claude/workflows");
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("the nearest directory wins a name: a package's workflow shadows the root's", () => {
  const m = monorepo();
  try {
    m.writeWf(m.repo, ".odw", "audit");
    m.writeWf(m.repo, ".claude", "audit");
    const own = m.writeWf(m.pkg, ".claude", "audit");
    const r = resolveWorkflow("audit", { cwd: m.pkg, config: m.config });
    assert.equal(r.scriptPath, own, "the package's .claude beats the root's .odw: nearer first");
    assert.equal(r.rootLabel, ".claude/workflows");
    // From the root, the package's is not on the path.
    assert.equal(resolveWorkflow("audit", { cwd: m.repo, config: m.config }).rootLabel, ".odw/workflows");
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("at one level .odw still comes before .claude", () => {
  const m = monorepo();
  try {
    const odw = m.writeWf(m.repo, ".odw", "audit");
    m.writeWf(m.repo, ".claude", "audit");
    assert.equal(resolveWorkflow("audit", { cwd: m.pkg, config: m.config }).scriptPath, odw);
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("project directories up the path come before the global ones", () => {
  const m = monorepo();
  try {
    const root = m.writeWf(m.repo, ".odw", "audit");
    writeFileSync(join(m.globalWf, "audit.js"), "export const meta = { name: 'audit', description: 'x' }\nreturn 1\n");
    const r = resolveWorkflow("audit", { cwd: m.pkg, config: m.config });
    assert.equal(r.scriptPath, root);
    assert.equal(r.origin, "project");
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("outside a git repository only the working directory is searched", () => {
  const m = monorepo({ git: false });
  try {
    m.writeWf(m.repo, ".claude", "audit");
    assert.throws(
      () => resolveWorkflow("audit", { cwd: m.pkg, config: m.config }),
      (e: unknown) => e instanceof WorkflowScriptError && /no workflow named 'audit'/.test((e as Error).message),
    );
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("the walk stops at the repository root: a workflow above it is not found", () => {
  const m = monorepo();
  try {
    m.writeWf(m.tmp, ".claude", "audit"); // above repo/, which holds .git
    assert.throws(() => resolveWorkflow("audit", { cwd: m.pkg, config: m.config }), WorkflowScriptError);
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("an untrusted run resolves no repository workflow by name, at any level", () => {
  const m = monorepo();
  try {
    m.writeWf(m.repo, ".claude", "audit");
    assert.throws(
      () => resolveWorkflow("audit", { cwd: m.pkg, config: m.config, trust: "untrusted" }),
      (e: unknown) => e instanceof WorkflowScriptError && /pass its path \(\.\.\/\.\.\/\.claude\/workflows\/audit\.js\)/.test((e as Error).message),
    );
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("listWorkflows says which layer each name comes from and which one shadows it", () => {
  const m = monorepo();
  try {
    const own = m.writeWf(m.pkg, ".claude", "audit");
    m.writeWf(m.repo, ".odw", "audit");
    m.writeWf(m.repo, ".claude", "release");
    const list = listWorkflows(m.pkg, m.config).filter((e) => e.origin !== "plugin");
    const rows = list.map((e) => [e.name, e.rootLabel, e.shadowed, e.shadowedBy?.rootLabel ?? null]);
    assert.deepEqual(rows, [
      ["audit", ".claude/workflows", false, null],
      ["audit", "../../.odw/workflows", true, ".claude/workflows"],
      ["release", "../../.claude/workflows", false, null],
    ]);
    assert.equal(list[1]!.shadowedBy?.path, own);
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("workflowCandidates is the whole chain, nearest first, then global", () => {
  const m = monorepo();
  try {
    const own = m.writeWf(m.pkg, ".odw", "audit");
    const root = m.writeWf(m.repo, ".claude", "audit");
    const global = join(m.globalWf, "audit.js");
    writeFileSync(global, "export const meta = { name: 'audit', description: 'x' }\nreturn 1\n");
    assert.deepEqual(
      workflowCandidates("audit", m.pkg, m.config).map((c) => [c.path, c.origin, c.rootLabel]),
      [
        [own, "project", ".odw/workflows"],
        [root, "project", "../../.claude/workflows"],
        [global, "global", m.globalWf],
      ],
    );
    assert.deepEqual(workflowCandidates("no-such", m.pkg, m.config), []);
    assert.deepEqual(workflowCandidates("../x", m.pkg, m.config), [], "not a name");
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

test("odw workflows where prints the candidate chain; list names what shadows an entry", async () => {
  const m = monorepo();
  try {
    const own = m.writeWf(m.pkg, ".claude", "audit");
    const root = m.writeWf(m.repo, ".odw", "audit");
    m.writeWf(m.repo, ".claude", "solo");
    const where = await cli(["workflows", "where", "audit", "--config", m.configPath], m.pkg);
    assert.equal(where.code, 0, where.err);
    const lines = where.out.trimEnd().split("\n");
    assert.match(lines[0]!, new RegExp(`^${escape(own)}  \\(claude:project \\.claude/workflows\\)$`));
    assert.equal(lines[1], "candidates, in precedence order:");
    assert.match(lines[2]!, new RegExp(`^  runs      ${escape(own)}  \\(claude:project \\.claude/workflows\\)$`));
    assert.match(lines[3]!, new RegExp(`^  shadowed  ${escape(root)}  \\(odw:project \\.\\./\\.\\./\\.odw/workflows\\)$`));
    assert.equal(lines.length, 4);
    // One candidate: just the line it always printed.
    const solo = await cli(["workflows", "where", "solo", "--config", m.configPath], m.pkg);
    assert.equal(solo.out.trimEnd().split("\n").length, 1);
    const list = await cli(["workflows", "list", "--project", "--config", m.configPath], m.pkg);
    assert.match(list.out, /audit .*\.\.\/\.\.\/\.odw\/workflows\).*shadowed by \.claude\/workflows\/audit\.js/);
  } finally {
    rmSync(m.tmp, { recursive: true, force: true });
  }
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
