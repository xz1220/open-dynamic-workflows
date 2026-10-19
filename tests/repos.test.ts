import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/adapters/config.js";
import { main } from "../src/cli.js";
import { ConfigError } from "../src/errors.js";
import { loadWorkflowScript } from "../src/loader.js";
import { buildRepos, parseRepoFlags, resolveRunRepos } from "../src/repos.js";
import { agentRows } from "../src/runtime/agents-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// Multi-repository runs (U6; ODW extension): the repos setting and --repo,
// agent(…, { repo }) and exec(…, { repo }), and odw diff/apply/restore per
// repository.

const EDIT_AGENT = fileURLToPath(new URL("./fixtures/edit-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** A fresh repository at `dir` with `files` committed. */
function repo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return realpathSync(dir);
}

/** Run the CLI in `cwd`, capturing what it prints. */
async function cli(argv: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
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
  const home = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.chdir(home);
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

interface Ran {
  id: string;
  state: string;
  store: RunStore;
  events: Array<Record<string, unknown>>;
}

/** Run `body` over `source` with the file-editing agent; `repos` are its --repo flags. */
async function run(
  root: string,
  source: string,
  body: string,
  opts: { args?: unknown; repos?: Record<string, string>; config?: Record<string, unknown>; configDir?: string; meta?: string } = {},
): Promise<Ran> {
  const configPath = join(opts.configDir ?? root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ defaultAdapter: "edit", ...opts.config, adapters: { edit: { command: [execPath, EDIT_AGENT], stdin: "{prompt}" } } }),
  );
  const script = join(root, `wf-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd'${opts.meta ?? ""} }\n${body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: opts.args ?? null, source, configPath, ...(opts.repos ? { repos: opts.repos } : {}) });
  const state = await executeRun(store.runDir(id));
  return { id, state, store, events: store.readEvents(id) as Array<Record<string, unknown>> };
}

const logs = (r: Ran): string[] => r.events.filter((e) => e.type === "log").map((e) => String(e.message));
const errorOf = (r: Ran): string => String(r.events.find((e) => e.type === "run_failed")?.error ?? "");
const staged = (dir: string): string => git(dir, "diff", "--cached", "--name-only").trim();

describe("the repos setting and --repo", () => {
  test("the setting is alias → path; a bad alias or path is a ConfigError", () => {
    assert.deepEqual(buildRepos({ api: " ../api ", "web-2": "~/web" }), { api: "../api", "web-2": "~/web" });
    assert.throws(() => buildRepos(["../api"]), ConfigError);
    assert.throws(() => buildRepos({ "1api": "../api" }), /not an alias/);
    assert.throws(() => buildRepos({ api: "" }), /must be the path/);
    const dir = mkdtempSync(join(tmpdir(), "odw-repos-config-"));
    try {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify({ repos: { api: "../api" } }));
      assert.deepEqual(loadConfig(path).settings.repos, { api: "../api" });
      writeFileSync(path, JSON.stringify({}));
      assert.deepEqual(loadConfig(path).settings.repos, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--repo is name=path, made absolute; a malformed or repeated one is refused", () => {
    assert.deepEqual(parseRepoFlags(["api=../api", "web=/x/web"], "/w/src"), { api: "/w/api", web: "/x/web" });
    assert.throws(() => parseRepoFlags(["api"], "/w"), /name=path/);
    assert.throws(() => parseRepoFlags(["../api=x"], "/w"), /not an alias/);
    assert.throws(() => parseRepoFlags(["api=a", "api=b"], "/w"), /given twice/);
  });

  test("meta.repos must be a list of aliases", () => {
    assert.throws(() => loadWorkflowScript("export const meta = { name: 'w', description: 'd', repos: 'api' }\nreturn 1", "w.js"), /meta.repos must be a list/);
    assert.deepEqual(loadWorkflowScript("export const meta = { name: 'w', description: 'd', repos: ['api'] }\nreturn 1", "w.js").meta.repos, ["api"]);
  });

  test("a path that is not a git repository is refused; an untrusted run drops the repository's own config's outside paths", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "odw-repos-resolve-")));
    try {
      const src = repo(join(root, "src"), { "a.txt": "a\n" });
      const api = repo(join(root, "api"), { "b.txt": "b\n" });
      const inner = repo(join(src, "inner"), { "c.txt": "c\n" });
      mkdirSync(join(root, "plain"));
      assert.throws(
        () => resolveRunRepos({ setting: { p: "../plain" }, flags: null, source: src, sourceRoot: src, untrusted: false, repositoryConfig: null }),
        /not in a git repository/,
      );
      const trusted = resolveRunRepos({ setting: { api: "../api" }, flags: null, source: src, sourceRoot: src, untrusted: false, repositoryConfig: join(src, "odw.config.json") });
      assert.deepEqual(trusted.repos, [{ name: "api", path: api, from: "config" }]);
      const untrusted = resolveRunRepos({
        setting: { api: "../api", inner: "inner" },
        flags: null,
        source: src,
        sourceRoot: src,
        untrusted: true,
        repositoryConfig: join(src, "odw.config.json"),
      });
      assert.deepEqual(untrusted.repos.map((r) => r.name), ["inner"]);
      assert.equal(untrusted.repos[0]!.path, inner);
      assert.match(untrusted.notes[0]!, /untrusted run: not using the repository 'api'/);
      // The user's own config, and --repo, still name any.
      const own = resolveRunRepos({ setting: { api: "../api" }, flags: null, source: src, sourceRoot: src, untrusted: true, repositoryConfig: null });
      assert.deepEqual(own.repos.map((r) => r.name), ["api"]);
      const flagged = resolveRunRepos({ setting: { api: "../api" }, flags: { api: api }, source: src, sourceRoot: src, untrusted: true, repositoryConfig: "x" });
      assert.deepEqual(flagged.repos, [{ name: "api", path: api, from: "flag" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("agents and commands in another repository", () => {
  let root: string;
  let src: string;
  let api: string;
  let web: string;
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "odw-repos-run-")));
    src = repo(join(root, "src"), { "a.txt": "a\n" });
    api = repo(join(root, "api"), { "b.txt": "b\n", "keep.txt": "k\n" });
    web = repo(join(root, "web"), { "c.txt": "c\n" });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("an isolated agent works in a worktree of its repository: its diff, scope and expect are that repository's", async () => {
    const r = await run(
      root,
      src,
      "return await parallel([\n" +
        "  () => agent('EDITS: ' + JSON.stringify({ write: { 'a.txt': 'a, here\\n' } }), { isolation: 'worktree', label: 'here' }),\n" +
        "  () => agent('EDITS: ' + JSON.stringify({ write: { 'b.txt': 'b, there\\n', 'x.txt': 'x\\n' } }), { isolation: 'worktree', label: 'there', repo: 'api', scope: ['b.txt'] }),\n" +
        "  () => agent('EDITS: ' + JSON.stringify({ write: { 'c.txt': 'c, web\\n' } }), { isolation: 'worktree', label: 'web', repo: 'web', scope: ['b.txt', 'c.txt'], expect: { files: ['c.txt'], untouched: ['keep.txt'] } }),\n" +
        "])\n",
      { repos: { api, web: join(root, "web") } },
    );
    assert.equal(r.state, "done", errorOf(r));
    const started = r.events.filter((e) => e.type === "agent_started");
    assert.deepEqual(
      // Parallel agents start in any order: compare by label.
      started.map((e) => [e.label, e.repo ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["here", null],
        ["there", { name: "api", path: api }],
        ["web", { name: "web", path: web }],
      ],
    );
    // Its diff is of its repository; a scope in another repository never waits for it.
    assert.match(readFileSync(r.store.agentDiffPath(r.id, 2), "utf8"), /b\.txt/);
    assert.doesNotMatch(readFileSync(r.store.agentDiffPath(r.id, 2), "utf8"), /a\.txt/);
    assert.ok(!logs(r).some((m) => /waits for/.test(m)), logs(r).join("\n"));
    // Its scope is read in its repository: x.txt is outside it, a.txt (the source's) is nobody's business.
    const finished = r.events.find((e) => e.type === "agent_finished" && e.agentId === 2)!;
    assert.deepEqual(finished.outOfScope, ["x.txt"]);
    // Its expect is read in its repository too: c.txt changed there, in its scope.
    const web3 = r.events.find((e) => e.type === "agent_finished" && e.agentId === 3)!;
    assert.equal(web3.outOfScope, undefined);
    // The run says which repositories it has, and status.json keeps them.
    assert.ok(logs(r).some((m) => m.startsWith("repositories besides the source: api → ")));
    assert.deepEqual(r.store.readStatus(r.id).repos, { api, web });
    assert.deepEqual(agentRows(r.store, r.id).map((row) => row.repo?.name ?? "."), [".", "api", "web"]);

    // odw diff names each one's repository.
    const flags = ["--runs-root", r.store.root];
    const stat = await cli(["diff", r.id, "--stat", ...flags]);
    assert.equal(stat.code, 0, stat.err);
    assert.match(stat.out, /REPO/);
    assert.match(stat.out, /there\s+api\s+2/);
    const whole = await cli(["diff", r.id, ...flags]);
    assert.match(whole.out, /# odw: agent 2 · there · repo api · 2 file\(s\)/);
    const one = await cli(["diff", r.id, "--repo", "web", "--stat", ...flags]);
    assert.doesNotMatch(one.out, /there/);
    assert.match(one.out, /web/);
    // So does the review queue.
    const queue = await cli(["review", ...flags]);
    assert.equal(queue.code, 0, queue.err);
    assert.match(queue.out, /agent 2 \(there\) · repo api ·/);
    assert.match(queue.out, /agent 1 \(here\) · 1 file/);

    // --pr opens one repository's PR at a time.
    const pr = await cli(["apply", r.id, "--all", "--pr", ...flags], src);
    assert.equal(pr.code, 1);
    assert.match(pr.err, /worked in 3 repositories \(\., api, web\).*add --repo <name>/);

    // odw apply --all previews every repository, then writes each to its own.
    const check = await cli(["apply", r.id, "--all", "--check", ...flags], src);
    assert.equal(check.code, 0, check.err);
    assert.match(check.out, /repository 'api' \(/);
    assert.equal(staged(src), "");
    assert.equal(staged(api), "");
    // Not from inside another repository of the run: the source's diffs do not belong there.
    const wrong = await cli(["apply", r.id, "--all", ...flags], api);
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /this working tree is the repository 'api' of the run/);
    const applied = await cli(["apply", r.id, "--all", ...flags], src);
    assert.equal(applied.code, 0, applied.err + applied.out);
    assert.equal(staged(src), "a.txt");
    assert.equal(staged(api), "b.txt\nx.txt");
    assert.equal(staged(web), "c.txt");
    assert.equal(readFileSync(join(api, "b.txt"), "utf8"), "b, there\n");
    for (const dir of [src, api, web]) git(dir, "reset", "-q", "--hard");
  });

  test("odw apply --all writes nothing when one repository would not apply cleanly; --agent applies to its own", async () => {
    const r = await run(
      root,
      src,
      "await agent('EDITS: ' + JSON.stringify({ write: { 'a.txt': 'a, agent\\n' } }), { isolation: 'worktree', label: 'here' })\n" +
        "await agent('EDITS: ' + JSON.stringify({ write: { 'b.txt': 'b, agent\\n' } }), { isolation: 'worktree', label: 'there', repo: 'api' })\n" +
        "return 'ok'\n",
      { repos: { api } },
    );
    assert.equal(r.state, "done", errorOf(r));
    const flags = ["--runs-root", r.store.root];
    // api's b.txt moves on meanwhile: its agent's diff now conflicts.
    writeFileSync(join(api, "b.txt"), "b, moved on\n");
    git(api, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-am", "moved");
    const all = await cli(["apply", r.id, "--all", ...flags], src);
    assert.equal(all.code, 1);
    assert.match(all.err, /nothing applied — repository 'api' would not apply cleanly/);
    assert.equal(staged(src), "", "the source is not written either");
    assert.equal(staged(api), "");
    // One repository at a time: the source's agents alone.
    const mine = await cli(["apply", r.id, "--all", "--repo", ".", ...flags], src);
    assert.equal(mine.code, 0, mine.err);
    assert.equal(staged(src), "a.txt");
    git(src, "reset", "-q", "--hard");
    // --agent goes to the agent's repository, wherever odw runs.
    const one = await cli(["apply", r.id, "--agent", "there", ...flags], src);
    assert.equal(one.code, 1, "it conflicts");
    assert.match(one.out, /to .*api/);
    git(api, "reset", "-q", "--hard");
  });

  test("an in-place agent and exec() run in the repository; its snapshot is its own, odw restore --repo puts it back", async () => {
    writeFileSync(join(api, "wip.txt"), "uncommitted\n");
    const r = await run(
      root,
      src,
      "const pwd = await exec(['pwd'], { repo: 'api' })\n" +
        "const sub = await exec('pwd', { repo: 'api', cwd: 'sub' }).catch((e) => String(e.message))\n" +
        "await agent('EDITS: ' + JSON.stringify({ write: { 'b.txt': 'b, in place\\n' } }), { repo: 'api', expect: { files: ['b.txt'] } })\n" +
        "return { pwd: pwd.stdout.trim(), sub }\n",
      { repos: { api } },
    );
    assert.equal(r.state, "done", errorOf(r));
    const result = r.store.readResult(r.id) as { pwd: string; sub: string };
    assert.equal(result.pwd, api);
    assert.match(result.sub, /cwd .*api\/sub does not exist/);
    assert.equal(readFileSync(join(api, "b.txt"), "utf8"), "b, in place\n");
    assert.equal(readFileSync(join(src, "a.txt"), "utf8"), "a\n");
    const snap = r.events.find((e) => e.type === "safety_snapshot")!;
    assert.equal(snap.repo, "api");
    assert.match(String(snap.message), /odw restore \S+ --repo api/);
    assert.equal(git(api, "rev-parse", "--verify", "-q", String(snap.ref)).trim(), snap.commit);
    assert.ok(r.events.some((e) => e.type === "command_started" && e.repo === "api"));

    const flags = ["--runs-root", r.store.root];
    const unknown = await cli(["restore", r.id, "--repo", "nope", ...flags], src);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /has no repository 'nope' — it worked in api/);
    rmSync(join(api, "wip.txt"));
    const back = await cli(["restore", r.id, "--repo", "api", "--force", ...flags], src);
    assert.equal(back.code, 0, back.err + back.out);
    assert.equal(readFileSync(join(api, "wip.txt"), "utf8"), "uncommitted\n");
    git(api, "reset", "-q", "--hard");
    rmSync(join(api, "wip.txt"), { force: true });
  });

  test("an alias the run does not declare is refused — and so is a meta.repos it lacks", async () => {
    const r = await run(root, src, "return await agent('EDITS: {}', { repo: 'nope' })\n", { repos: { api } });
    assert.equal(r.state, "failed");
    assert.match(errorOf(r), /repo 'nope' is not a repository this run declares; the run declares 'api'/);
    assert.ok(!r.events.some((e) => e.type === "agent_started"));
    const path = await run(root, src, "return await agent('EDITS: {}', { repo: '../api' })\n");
    assert.equal(path.state, "failed");
    assert.match(errorOf(path), /the run declares none/);
    const needs = await run(root, src, "return 1\n", { meta: ", repos: ['api', 'web']", repos: { api } });
    assert.equal(needs.state, "failed");
    assert.match(errorOf(needs), /needs the repository 'web' \(its meta.repos\)/);
    const has = await run(root, src, "return 1\n", { meta: ", repos: ['api']", config: { repos: { api: "../api" } } });
    assert.equal(has.state, "done", errorOf(has));
  });

  test("an untrusted run does not take a repository its own config names outside it", async () => {
    const r = await run(root, src, "return await exec('pwd', { repo: 'api' })\n", {
      config: { trust: "untrusted", repos: { api: "../api" } },
      configDir: src,
    });
    assert.equal(r.state, "failed");
    assert.ok(logs(r).some((m) => /untrusted run: not using the repository 'api'/.test(m)), logs(r).join("\n"));
    assert.match(errorOf(r), /repo 'api' is not a repository this run declares/);
    rmSync(join(src, "odw.config.json"));
  });

  test("odw run --repo checks each path first, and is refused with --on", async () => {
    const bad = await cli(["run", "x.js", "--repo", "api"], src);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /name=path/);
    const remote = await cli(["run", "x.js", "--on", "ssh://host", "--repo", `api=${api}`], src);
    assert.equal(remote.code, 2);
    assert.match(remote.err, /multi-repository runs are local only/);
    writeFileSync(join(root, "w.js"), "export const meta = { name: 'w', description: 'd' }\nreturn 1\n");
    const missing = await cli(["run", join(root, "w.js"), "--repo", `api=${join(root, "plain-missing")}`, "--runs-root", join(root, "runs2"), "--detach"], src);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /repository 'api': .* is not a directory/);
  });
});
