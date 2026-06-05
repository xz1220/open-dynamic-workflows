import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import { ConfigError, WorkflowScriptError } from "../src/errors.js";
import { listWorkflows, resolveWorkflow } from "../src/workflows/resolve.js";

/** A throwaway project + separate global workflows dir, with `config` wired to it. */
function scaffold() {
  const tmp = mkdtempSync(join(tmpdir(), "odw-resolve-"));
  const project = join(tmp, "project");
  const projectWf = join(project, ".odw", "workflows");
  const projectClaudeWf = join(project, ".claude", "workflows");
  const globalWf = join(tmp, "global-workflows");
  const globalClaudeWf = join(tmp, "global-claude-workflows");
  mkdirSync(projectWf, { recursive: true });
  mkdirSync(projectClaudeWf, { recursive: true });
  mkdirSync(globalWf, { recursive: true });
  mkdirSync(globalClaudeWf, { recursive: true });

  const config = defaultConfig();
  config.settings.workflowsRoot = globalWf;
  config.settings.claudeWorkflowsRoot = globalClaudeWf;

  const writeWf = (dir: string, name: string) => {
    const p = join(dir, `${name}.js`);
    writeFileSync(p, `export const meta = { name: "${name}", description: "x" }\nreturn 1\n`);
    return p;
  };
  return { tmp, project, projectWf, projectClaudeWf, globalWf, globalClaudeWf, config, writeWf };
}

test("a .js argument is always a path, even when a same-named workflow exists", () => {
  const s = scaffold();
  try {
    s.writeWf(s.projectWf, "foo"); // a NAME 'foo' also exists in the registry
    const file = join(s.project, "foo.js");
    writeFileSync(file, "export const meta = { name: 'f', description: 'x' }\nreturn 1\n");
    const r = resolveWorkflow("foo.js", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "path");
    assert.equal(r.scriptPath, file);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a relative path resolves against cwd and reports origin 'path'", () => {
  const s = scaffold();
  try {
    mkdirSync(join(s.project, "sub"));
    const file = join(s.project, "sub", "wf.js");
    writeFileSync(file, "export const meta = { name: 'w', description: 'x' }\nreturn 1\n");
    const r = resolveWorkflow("./sub/wf.js", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "path");
    assert.equal(r.scriptPath, file);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a missing path throws the familiar not-found error", () => {
  const s = scaffold();
  try {
    assert.throws(
      () => resolveWorkflow("./nope.js", { cwd: s.project, config: s.config }),
      (e: unknown) => e instanceof WorkflowScriptError && /workflow script not found/.test((e as Error).message),
    );
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a bare name resolves to the project workflows dir", () => {
  const s = scaffold();
  try {
    const p = s.writeWf(s.projectWf, "deep-research");
    const r = resolveWorkflow("deep-research", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "project");
    assert.equal(r.scriptPath, p);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a name only in the global dir resolves there", () => {
  const s = scaffold();
  try {
    const p = s.writeWf(s.globalWf, "ai-news");
    const r = resolveWorkflow("ai-news", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "global");
    assert.equal(r.scriptPath, p);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a name in Claude's project workflows dir resolves there", () => {
  const s = scaffold();
  try {
    const p = s.writeWf(s.projectClaudeWf, "claude-review");
    const r = resolveWorkflow("claude-review", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "project");
    assert.equal(r.provider, "claude");
    assert.equal(r.rootLabel, ".claude/workflows");
    assert.equal(r.scriptPath, p);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a name only in Claude's global workflows dir resolves there", () => {
  const s = scaffold();
  try {
    const p = s.writeWf(s.globalClaudeWf, "personal-research");
    const r = resolveWorkflow("personal-research", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "global");
    assert.equal(r.provider, "claude");
    assert.equal(r.rootLabel, s.globalClaudeWf);
    assert.equal(r.scriptPath, p);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("project shadows global for the same name", () => {
  const s = scaffold();
  try {
    const projP = s.writeWf(s.projectWf, "shared");
    s.writeWf(s.globalWf, "shared");
    const r = resolveWorkflow("shared", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "project");
    assert.equal(r.scriptPath, projP);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("ODW project workflows shadow same-named Claude project workflows", () => {
  const s = scaffold();
  try {
    const p = s.writeWf(s.projectWf, "shared-local");
    s.writeWf(s.projectClaudeWf, "shared-local");
    const r = resolveWorkflow("shared-local", { cwd: s.project, config: s.config });
    assert.equal(r.provider, "odw");
    assert.equal(r.scriptPath, p);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("Claude project workflows shadow ODW global workflows", () => {
  const s = scaffold();
  try {
    const p = s.writeWf(s.projectClaudeWf, "shared-scope");
    s.writeWf(s.globalWf, "shared-scope");
    const r = resolveWorkflow("shared-scope", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "project");
    assert.equal(r.provider, "claude");
    assert.equal(r.scriptPath, p);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a name containing '/' is treated as a path (no namespacing in v1)", () => {
  const s = scaffold();
  try {
    s.writeWf(s.projectWf, "triage"); // exists as a flat name, but "team/triage" must NOT find it
    assert.throws(
      () => resolveWorkflow("team/triage", { cwd: s.project, config: s.config }),
      (e: unknown) => e instanceof WorkflowScriptError && /workflow script not found/.test((e as Error).message),
    );
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a name with an illegal character falls back to a path lookup", () => {
  const s = scaffold();
  try {
    assert.throws(
      () => resolveWorkflow("foo@bar", { cwd: s.project, config: s.config }),
      (e: unknown) => e instanceof WorkflowScriptError && /workflow script not found/.test((e as Error).message),
    );
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a symlink escaping the workflows dir is refused", () => {
  const s = scaffold();
  try {
    const outside = join(s.tmp, "outside.js");
    writeFileSync(outside, "export const meta = { name: 'o', description: 'x' }\nreturn 1\n");
    symlinkSync(outside, join(s.projectWf, "evil.js"));
    assert.throws(
      () => resolveWorkflow("evil", { cwd: s.project, config: s.config }),
      (e: unknown) => e instanceof ConfigError && /outside its workflows directory/.test((e as Error).message),
    );
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a directory named '<name>.js' is skipped, not run", () => {
  const s = scaffold();
  try {
    mkdirSync(join(s.projectWf, "dir.js")); // not a file
    assert.throws(
      () => resolveWorkflow("dir", { cwd: s.project, config: s.config }),
      (e: unknown) => e instanceof WorkflowScriptError && /no workflow named 'dir'/.test((e as Error).message),
    );
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("project and global roots are deduped when they coincide", () => {
  const s = scaffold();
  try {
    // Point the global root AT the project root so the two collapse to one.
    s.config.settings.workflowsRoot = s.projectWf;
    s.writeWf(s.projectWf, "dup");
    const r = resolveWorkflow("dup", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "project");
    // listWorkflows must not double-count the shared directory.
    const dup = listWorkflows(s.project, s.config).filter((e) => e.name === "dup");
    assert.equal(dup.length, 1);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a not-found name suggests near matches and lists the roots searched", () => {
  const s = scaffold();
  try {
    s.writeWf(s.projectWf, "deep-research");
    const err = (() => {
      try {
        resolveWorkflow("deep-resarch", { cwd: s.project, config: s.config });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    assert.ok(err instanceof WorkflowScriptError);
    assert.match(err.message, /did you mean: deep-research/);
    assert.match(err.message, /\.odw\/workflows, project/);
    assert.match(err.message, /\.claude\/workflows, project/);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("an in-dir symlink alias is both listed and runnable (list agrees with resolve)", () => {
  const s = scaffold();
  try {
    s.writeWf(s.projectWf, "real");
    symlinkSync(join(s.projectWf, "real.js"), join(s.projectWf, "alias.js")); // points inside the dir
    // resolve runs it...
    const r = resolveWorkflow("alias", { cwd: s.project, config: s.config });
    assert.equal(r.origin, "project");
    // ...and list must not hide it.
    const names = listWorkflows(s.project, s.config).map((e) => e.name);
    assert.ok(names.includes("alias"), "listWorkflows should include the runnable symlink alias");
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("listWorkflows flags global entries shadowed by the project", () => {
  const s = scaffold();
  try {
    s.writeWf(s.projectWf, "a");
    s.writeWf(s.globalWf, "a");
    s.writeWf(s.globalWf, "b");
    const list = listWorkflows(s.project, s.config);
    const byKey = (origin: string, name: string) => list.find((e) => e.origin === origin && e.name === name);
    assert.equal(byKey("project", "a")?.shadowed, false);
    assert.equal(byKey("global", "a")?.shadowed, true);
    assert.equal(byKey("global", "b")?.shadowed, false);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});
