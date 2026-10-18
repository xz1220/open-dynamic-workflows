import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig } from "../src/adapters/config.js";
import { main } from "../src/cli.js";
import { WorkflowScriptError } from "../src/errors.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { listWorkflowSummaries, workflowDetail } from "../src/runtime/workflows-view.js";
import { discoverPluginWorkflows, parsePluginRef } from "../src/workflows/plugins.js";
import { listWorkflows, resolveWorkflow } from "../src/workflows/resolve.js";

// Workflows shipped in installed Claude Code plugins (ODW extension): found
// read-only under a fake ~/.claude/plugins, enabled or not by enabledPlugins,
// named <plugin>:<meta.name>, run through the ordinary loader, never modified.

const flow = (name: string, body = "return 'ran ' + (await agent('TASK'))\n") =>
  `export const meta = { name: '${name}', description: '${name} from a plugin', phases: [{ title: 'Only' }] }\n${body}`;

interface Fixture {
  home: string;
  project: string;
  plugins: string;
  /** Install a plugin: its files under cache/<market>/<name>/<version>/, recorded in installed_plugins.json. */
  install(name: string, files: Record<string, string>, opts?: { manifest?: Record<string, unknown> | null; scope?: string; projectPath?: string }): string;
  settings(path: string, enabled: Record<string, boolean>): void;
  cleanup(): void;
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "odw-plugin-home-"));
  const project = mkdtempSync(join(tmpdir(), "odw-plugin-proj-"));
  const plugins = join(home, ".claude", "plugins");
  mkdirSync(plugins, { recursive: true });
  const installed: Record<string, unknown[]> = {};
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CACHE: process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR };
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  return {
    home,
    project,
    plugins,
    install(name, files, opts = {}) {
      const dir = join(plugins, "cache", "test-market", name, "1.0.0");
      const manifest = opts.manifest === undefined ? { name } : opts.manifest;
      if (manifest) write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
      for (const [path, text] of Object.entries(files)) write(join(dir, path), text);
      const record: Record<string, unknown> = { scope: opts.scope ?? "user", installPath: dir, version: "1.0.0" };
      if (opts.projectPath) record.projectPath = opts.projectPath;
      installed[`${name}@test-market`] = [record];
      write(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installed }));
      return dir;
    },
    settings(path, enabled) {
      write(path, JSON.stringify({ enabledPlugins: enabled }));
    },
    cleanup() {
      for (const [key, value] of [["HOME", saved.HOME], ["CLAUDE_CONFIG_DIR", saved.CLAUDE_CONFIG_DIR], ["CLAUDE_CODE_PLUGIN_CACHE_DIR", saved.CACHE]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    },
  };
}

/** Every file under `dir` with its sha256 and mtime: what "never modified" compares. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path] = `${createHash("sha256").update(readFileSync(path)).digest("hex")} ${statSync(path).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test("plugin workflows are found read-only: enabled ones, by <plugin>:<meta.name>, through the dual-compat audit", () => {
  const f = fixture();
  try {
    f.install("acme-tools", {
      "workflows/release-audit.js": flow("release-audit"),
      "workflows/renamed-file.js": flow("triage"),
      "workflows/impure.js": "const n = 'x'\nexport const meta = { name: n, description: 'd' }\nreturn 1\n",
      "workflows/notes.md": "not a workflow",
    });
    f.install("custom-dirs", { "workflows/ignored.js": flow("ignored"), "flows/kept.js": flow("kept") }, {
      manifest: { name: "custom-dirs", workflows: ["./flows/", "./../escape/", "outside.js"] },
    });
    f.install("off-by-setting", { "workflows/x.js": flow("x") });
    f.install("off-by-default", { "workflows/y.js": flow("y") }, { manifest: { name: "off-by-default", defaultEnabled: false } });
    f.install("no-manifest", { "workflows/z.js": flow("z") }, { manifest: null });
    f.install("elsewhere", { "workflows/w.js": flow("w") }, { scope: "project", projectPath: join(f.home, "another-project") });
    f.install("here", { "workflows/v.js": flow("v") }, { scope: "local", projectPath: f.project });
    f.settings(join(f.home, ".claude", "settings.json"), { "off-by-setting@test-market": false, "off-by-default@test-market": false });

    const { workflows, notes } = discoverPluginWorkflows({ cwd: f.project });
    assert.deepEqual(
      workflows.map((w) => [w.name, w.provider, w.scope]),
      [
        ["acme-tools:release-audit", "claude-plugin:acme-tools", "user"],
        ["acme-tools:triage", "claude-plugin:acme-tools", "user"],
        ["custom-dirs:kept", "claude-plugin:custom-dirs", "user"],
        ["here:v", "claude-plugin:here", "local"],
        ["no-manifest:z", "claude-plugin:no-manifest", "user"],
      ],
    );
    assert.equal(workflows[1]!.path.endsWith("renamed-file.js"), true, "named by meta.name, not the file");
    assert.ok(notes.some((n) => /impure\.js is left out — /.test(n)), "a meta that is not a pure literal is left out, as Claude Code leaves it out");
    assert.ok(notes.some((n) => /lies outside the plugin; left out/.test(n)));
    assert.ok(notes.some((n) => /"outside\.js" is not a \.\/ path/.test(n)));
    assert.equal(parsePluginRef("acme-tools:release-audit")?.plugin, "acme-tools");
    assert.equal(parsePluginRef("C:release"), null, "a drive letter is a path");

    // odw workflows / /api/workflows list them after the managed directories.
    const listed = listWorkflows(f.project, defaultConfig()).filter((e) => e.origin === "plugin");
    assert.equal(listed[0]!.rootLabel, "Claude Code plugin acme-tools@test-market 1.0.0 (user scope)");
    const summaries = listWorkflowSummaries(f.project, defaultConfig()).filter((w) => w.origin === "plugin");
    assert.deepEqual(summaries[0], {
      name: "acme-tools:release-audit",
      origin: "plugin",
      provider: "claude-plugin:acme-tools",
      rootLabel: "Claude Code plugin acme-tools@test-market 1.0.0 (user scope)",
      path: workflows[0]!.path,
      description: "release-audit from a plugin",
      phases: [{ title: "Only" }],
      runCount: 0,
      shadowed: false,
    });
  } finally {
    f.cleanup();
  }
});

test("the project's settings may disable a plugin; untrusted, they cannot enable one", () => {
  const f = fixture();
  try {
    f.install("acme-tools", { "workflows/a.js": flow("a") });
    f.install("dormant", { "workflows/b.js": flow("b") });
    f.settings(join(f.home, ".claude", "settings.json"), { "dormant@test-market": false });
    f.settings(join(f.project, ".claude", "settings.json"), { "acme-tools@test-market": false, "dormant@test-market": true });
    const names = (trust?: "trusted" | "untrusted") => discoverPluginWorkflows({ cwd: f.project, trust }).workflows.map((w) => w.name);
    assert.deepEqual(names(), ["dormant:b"], "project settings win over the user's, key by key");
    assert.deepEqual(names("untrusted"), [], "the repository may switch a plugin off, never on");
    f.settings(join(f.project, ".claude", "settings.local.json"), { "acme-tools@test-market": true });
    assert.deepEqual(names(), ["acme-tools:a", "dormant:b"], "local settings come last");
  } finally {
    f.cleanup();
  }
});

test("a name a project workflow also has runs the project's, with a note; <plugin>:<name> runs the plugin's", () => {
  const f = fixture();
  try {
    const dir = f.install("acme-tools", { "workflows/audit.js": flow("audit"), "workflows/solo.js": flow("solo") });
    f.install("other-tools", { "workflows/solo.js": flow("solo"), "workflows/only.js": flow("only") });
    mkdirSync(join(f.project, ".claude", "workflows"), { recursive: true });
    writeFileSync(join(f.project, ".claude", "workflows", "audit.js"), flow("audit"));
    const config = defaultConfig();

    const bare = resolveWorkflow("audit", { cwd: f.project, config });
    assert.equal(bare.origin, "project");
    assert.equal(bare.scriptPath, join(f.project, ".claude", "workflows", "audit.js"));
    assert.deepEqual(bare.notes, [
      "Claude Code plugin acme-tools@test-market 1.0.0 (user scope) also ships 'audit': this runs .claude/workflows/audit.js " +
        "(the project one wins) — run acme-tools:audit for the plugin's",
    ]);
    const qualified = resolveWorkflow("acme-tools:audit", { cwd: f.project, config });
    assert.deepEqual([qualified.origin, qualified.provider, qualified.scriptPath], ["plugin", "claude-plugin:acme-tools", join(dir, "workflows", "audit.js")]);
    assert.equal(qualified.plugin?.id, "acme-tools@test-market");

    // Listed with the same note; a bare name only one plugin has resolves to it; two is ambiguous.
    const entry = listWorkflows(f.project, config).find((e) => e.name === "acme-tools:audit")!;
    assert.equal(entry.note, "'audit' alone runs .claude/workflows/audit.js (the project one wins)");
    assert.equal(resolveWorkflow("only", { cwd: f.project, config }).provider, "claude-plugin:other-tools");
    assert.throws(
      () => resolveWorkflow("solo", { cwd: f.project, config }),
      (e: unknown) => e instanceof WorkflowScriptError && /'solo' is a workflow of 2 Claude Code plugins: .*acme-tools:solo, other-tools:solo/.test(e.message),
    );
    assert.throws(() => resolveWorkflow("acme-tools:nope", { cwd: f.project, config }), /no workflow named 'acme-tools:nope' in an installed, enabled Claude Code plugin/);

    // Untrusted: the repository's own workflow never answers to a name, so the plugin's runs, and the run says why.
    const untrusted = resolveWorkflow("audit", { cwd: f.project, config, trust: "untrusted" });
    assert.equal(untrusted.provider, "claude-plugin:acme-tools");
    assert.match(untrusted.notes![0]!, /^untrusted run: not running the repository's own \.claude\/workflows\/audit\.js by name — pass its path \(\.\/\.claude\/workflows\/audit\.js\)/);
  } finally {
    f.cleanup();
  }
});

/** Run the CLI with stdout/stderr captured (node:test's own buffer writes pass through). */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("odw run <plugin>:<name> runs a plugin's workflow with the mock adapter, says where it came from, and leaves the plugin as it was", async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "odw-plugin-run-"));
  try {
    const dir = f.install("acme-tools", {
      // An ODW-only primitive in a branch that never runs: labelled, as validate() labels it.
      "workflows/release-audit.js": flow("release-audit", "if (args === 'never') await exec('true')\nreturn 'ran ' + (await agent('TASK'))\n"),
    });
    const before = snapshot(dir);
    const config = join(root, "mine.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "mock",
        adapters: { mock: { command: [execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('ok'))"], stdin: "{prompt}" } },
      }),
    );
    const runsRoot = join(root, "runs");
    const flags = ["--config", config, "--runs-root", runsRoot, "--source", f.project, "--wait"];
    const r = await cli(["run", "acme-tools:release-audit", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "ran ok");
    assert.match(r.err, /\nworkflow: acme-tools:release-audit from Claude Code plugin acme-tools@test-market 1\.0\.0 \(user scope\) \(run in place, never modified\)\n/);

    const store = new RunStore(runsRoot);
    const id = /running (\S+) \.\.\./.exec(r.err)![1]!;
    const meta = store.readMeta(id);
    assert.equal(meta.script, join(dir, "workflows", "release-audit.js"), "it runs from the plugin's own directory");
    assert.equal(meta.workflowName, "acme-tools:release-audit");
    assert.deepEqual(meta.plugin, { name: "acme-tools:release-audit", id: "acme-tools@test-market", version: "1.0.0", scope: "user" });
    const logs = store.readEvents(id).filter((e) => e.type === "log").map((e) => String(e.message));
    assert.ok(logs.some((m) => m.startsWith("workflow acme-tools:release-audit comes from Claude Code plugin acme-tools@test-market 1.0.0 (user scope), run in place from ")), logs.join("\n"));
    assert.ok(logs.some((m) => /^workflow acme-tools:release-audit: exec\(\) is an ODW extension, not portable to Claude Code/.test(m)), "ODW-only primitive use is labelled");
    assert.equal(logs.some((m) => /run it by name as/.test(m)), false, "no file-stem note for a plugin's workflow");
    assert.equal(store.listRunsForWorkflow("acme-tools:release-audit").length, 1, "bucketed by its <plugin>:<name>");
    assert.deepEqual(snapshot(dir), before, "not a byte or an mtime changed in the plugin");

    // Untrusted runs allow it — the user installed it — and say so.
    const u = await cli(["run", "acme-tools:release-audit", "--untrusted", ...flags]);
    assert.equal(u.code, 0, u.err);
    const uid = /running (\S+) \.\.\./.exec(u.err)![1]!;
    assert.ok(store.readEvents(uid).some((e) => e.type === "log" && /; allowed in an untrusted run: you installed it$/.test(String(e.message))));

    // A rerun runs it from its path, and still knows where it came from.
    const again = await cli(["rerun", id, "--runs-root", runsRoot, "--wait"]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.err, /\nworkflow: acme-tools:release-audit from Claude Code plugin/);

    // odw workflows (list) shows it, labelled by its plugin.
    const cwd = process.cwd();
    process.chdir(f.project);
    try {
      const listed = await cli(["workflows", "list", "--plugins", "--config", config]);
      assert.equal(listed.code, 0, listed.err);
      assert.match(listed.out, /^acme-tools:release-audit {2}\(claude-plugin:acme-tools Claude Code plugin acme-tools@test-market 1\.0\.0 \(user scope\)\) {2}\S+release-audit\.js\n$/);
      const where = await cli(["workflows", "where", "acme-tools:release-audit", "--config", config]);
      assert.match(where.out, /release-audit\.js {2}\(claude-plugin:acme-tools Claude Code plugin acme-tools@test-market 1\.0\.0 \(user scope\)\)\n$/);
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(snapshot(dir), before);
  } finally {
    f.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/workflows lists a plugin's workflows under claude-plugin:<plugin>; ?provider= opens one", async () => {
  const f = fixture();
  const runs = mkdtempSync(join(tmpdir(), "odw-plugin-api-"));
  try {
    f.install("acme-tools", { "workflows/audit.js": flow("audit") });
    mkdirSync(join(f.project, ".odw", "workflows"), { recursive: true });
    writeFileSync(join(f.project, ".odw", "workflows", "audit.js"), flow("audit"));
    const store = new RunStore(runs);
    const handle = await startServer({ store, port: 0, host: "127.0.0.1", cwd: f.project, config: defaultConfig() });
    try {
      const list = (await fetch(`${handle.url}/api/workflows`).then((r) => r.json())) as Array<Record<string, unknown>>;
      const plugin = list.find((w) => w.provider === "claude-plugin:acme-tools")!;
      assert.deepEqual([plugin.name, plugin.origin, plugin.note], ["acme-tools:audit", "plugin", "'audit' alone runs .odw/workflows/audit.js (the project one wins)"]);
      const det = await fetch(`${handle.url}/api/workflows/${encodeURIComponent("acme-tools:audit")}?provider=${encodeURIComponent("claude-plugin:acme-tools")}`).then((r) => r.json());
      assert.equal(det.provider, "claude-plugin:acme-tools");
      assert.match(det.source, /audit from a plugin/);
      assert.equal(workflowDetail(f.project, defaultConfig(), store, "acme-tools:audit")?.origin, "plugin");
    } finally {
      await handle.close();
    }
  } finally {
    f.cleanup();
    rmSync(runs, { recursive: true, force: true });
  }
});
