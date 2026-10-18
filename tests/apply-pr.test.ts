import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { captureChanges } from "../src/changes.js";
import { main } from "../src/cli.js";
import { compareUrl } from "../src/runtime/apply-pr.js";
import { RunStore } from "../src/runtime/run-store.js";

// odw apply --pr (ODW extension): the kept diffs go to a new branch made in a
// temporary worktree, one commit per agent, pushed to a remote — here a local
// bare repository the GitHub-looking origin URL is rewritten to — and a PR is
// opened through a fake gh on PATH that records what it was asked.

const GITHUB_URL = "https://github.com/acme/widgets.git";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Run the CLI in `cwd` with `path` as PATH, capturing what it prints. */
async function cli(argv: string[], cwd: string, path: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  const home = process.cwd();
  const oldPath = process.env.PATH;
  process.chdir(cwd);
  process.env.PATH = path;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.env.PATH = oldPath;
    process.chdir(home);
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** A fake gh: logs each call (argv, and the body file's text) to `log`; FAKE_GH_AUTH=fail makes it not logged in. */
const FAKE_GH = `
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const at = args.indexOf("--body-file");
const body = at === -1 ? null : readFileSync(args[at + 1], "utf8");
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, body, prompt: process.env.GH_PROMPT_DISABLED ?? null }) + "\\n");
if (args[0] === "auth") process.exit(process.env.FAKE_GH_AUTH === "fail" ? 1 : 0);
if (args[0] === "pr" && args[1] === "create") {
  if (process.env.FAKE_GH_CREATE === "fail") { process.stderr.write("GraphQL: no permission\\n"); process.exit(1); }
  process.stdout.write("https://github.example/acme/widgets/pull/7\\n");
}
`;

interface AgentSpec {
  label: string;
  edit: Record<string, string>;
  phase?: string;
  costUsd?: number;
  state?: "done" | "failed";
}

interface Fixture {
  root: string;
  repo: string;
  bare: string;
  runId: string;
  flags: string[];
  /** PATH with the fake gh first; `noGh` has git alone. */
  path: string;
  noGh: string;
  ghLog: string;
}

/**
 * A repository on `main` holding `files`, with an origin (a GitHub URL rewritten
 * to a local bare repository) that has main, and a run whose isolated agents
 * made their `edit` from that commit and kept its diff.
 */
async function setup(files: Record<string, string>, agents: AgentSpec[]): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "odw-pr-test-"));
  roots.push(root);
  const bare = join(root, "remote.git");
  git(root, "init", "-q", "--bare", bare);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  // The user's identity, as any repository has it; odw sets none.
  git(repo, "config", "user.name", "Pat Example");
  git(repo, "config", "user.email", "pat@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", GITHUB_URL);
  git(repo, "config", `url.${bare}.insteadOf`, GITHUB_URL);
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), data);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD").trim();
  const store = new RunStore(join(root, "runs"));
  const runId = store.create({ script: join(root, "wf.js"), args: null, source: repo });
  store.updateStatus(runId, { state: "done", name: "triage" });
  for (const [i, spec] of agents.entries()) {
    const agentId = i + 1;
    const work = join(root, `wt-${agentId}`);
    git(repo, "worktree", "add", "-q", "--detach", work, base);
    for (const [path, data] of Object.entries(spec.edit)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), data);
    }
    const diff = store.agentDiffPath(runId, agentId);
    mkdirSync(dirname(diff), { recursive: true });
    const scratch = mkdtempSync(join(root, "scratch-"));
    const kept = await captureChanges({ top: repo, work, base, scratch }, { paths: new Map(), ignoredDirs: [] }, { path: diff, maxDiffBytes: 1 << 21 });
    git(repo, "worktree", "remove", "--force", work);
    const fields = { agentId, label: spec.label, phase: spec.phase ?? null, adapter: "edit" };
    appendFileSync(store.eventsPath(runId), JSON.stringify({ ts: agentId * 10, type: "agent_started", ...fields }) + "\n");
    const usage = spec.costUsd !== undefined ? { usage: { inputTokens: 1000, outputTokens: 200, costUsd: spec.costUsd } } : {};
    const settled =
      spec.state === "failed"
        ? { type: "agent_failed", error: "timed out", reason: "timeout", changes: kept?.changes ?? null, branch: null }
        : { type: "agent_finished", attempts: 1, changes: kept?.changes ?? null, branch: null, ...usage };
    appendFileSync(store.eventsPath(runId), JSON.stringify({ ts: agentId * 10 + 5, ...fields, ...settled }) + "\n");
  }
  const config = join(root, "odw.config.json");
  writeFileSync(config, "{}");

  const bin = join(root, "bin");
  const gitOnly = join(root, "git-only");
  mkdirSync(bin);
  mkdirSync(gitOnly);
  const ghLog = join(root, "gh.log");
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\n${FAKE_GH}`);
  chmodSync(join(bin, "gh"), 0o755);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const realSh = execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim();
  symlinkSync(realGit, join(gitOnly, "git"));
  symlinkSync(realSh, join(gitOnly, "sh"));
  process.env.FAKE_GH_LOG = ghLog;
  delete process.env.FAKE_GH_AUTH;
  delete process.env.FAKE_GH_CREATE;
  return {
    root,
    repo,
    bare,
    runId,
    flags: ["--runs-root", store.root, "--config", config],
    path: `${bin}:${process.env.PATH}`,
    noGh: gitOnly,
    ghLog,
  };
}

function ghCalls(fx: Fixture): Array<{ args: string[]; body: string | null; prompt: string | null }> {
  return existsSync(fx.ghLog) ? readFileSync(fx.ghLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

/** What the user's checkout is: HEAD, its branch, status, index and every tracked file's content. */
function checkout(repo: string): string {
  return [
    git(repo, "rev-parse", "HEAD"),
    git(repo, "symbolic-ref", "HEAD"),
    git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    git(repo, "diff"),
    git(repo, "diff", "--cached"),
    git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).join("\n"),
  ].join("\n--\n");
}

const remoteBranches = (fx: Fixture): string[] =>
  git(fx.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").filter(Boolean).sort();

test("--pr: a branch from HEAD with the agent's commit under the user's identity, pushed, and a draft PR whose body is the run summary", async () => {
  const fx = await setup({ "a.txt": "one\n", "keep.txt": "keep\n" }, [
    { label: "fix:auth", edit: { "a.txt": "one fixed\n", "b.txt": "new\n" }, phase: "Fix", costUsd: 0.25 },
  ]);
  const before = checkout(fx.repo);
  const main0 = git(fx.repo, "rev-parse", "main").trim();
  const r = await cli(["apply", fx.runId, "--agent", "fix:auth", "--pr", "--verify", "test -f b.txt", ...fx.flags], fx.repo, fx.path);
  assert.equal(r.code, 0, r.err);
  const branch = `odw/${fx.runId}-fix-auth`;
  assert.deepEqual(remoteBranches(fx), [branch, "main"].sort());
  assert.equal(checkout(fx.repo), before, "the user's checkout is untouched (no extra worktree left either)");

  // One commit on top of main, by the user's identity, holding the agent's change.
  assert.equal(git(fx.bare, "rev-parse", `${branch}^`).trim(), main0);
  assert.equal(git(fx.bare, "log", "-1", "--format=%an <%ae>|%cn <%ce>", branch).trim(), "Pat Example <pat@example.com>|Pat Example <pat@example.com>");
  assert.equal(git(fx.bare, "show", `${branch}:a.txt`), "one fixed\n");
  assert.equal(git(fx.bare, "show", `${branch}:b.txt`), "new\n");
  const message = git(fx.bare, "log", "-1", "--format=%B", branch);
  assert.match(message, /^odw: triage: fix:auth\n/);
  assert.match(message, /a\.txt \| 2 \+-/);
  assert.match(message, /2 files changed, 2 insertions\(\+\), 1 deletion\(-\)/);
  assert.match(message, new RegExp(`odw-run: ${fx.runId}\nodw-agent: 1\nodw-cost: \\$0\\.250`));

  // gh: logged in, then a draft PR into main from the branch, never asked anything.
  const calls = ghCalls(fx);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [["auth", "status"], ["pr", "create"]]);
  const create = calls[1]!;
  const flag = (name: string): string | undefined => create.args[create.args.indexOf(name) + 1];
  assert.equal(flag("--head"), branch);
  assert.equal(flag("--base"), "main");
  assert.equal(flag("--title"), "odw: triage: fix:auth");
  assert.ok(create.args.includes("--draft"), "a draft by default");
  assert.equal(create.prompt, "1");
  const body = create.body!;
  assert.match(body, new RegExp(`from run \`${fx.runId}\` of the workflow \\*\\*triage\\*\\*`));
  assert.match(body, /odw never merges/);
  assert.match(body, /\| 1 fix:auth \| Fix \| 2 \| \+2 −1 \| \$0\.250 \| [0-9a-f]{12} \|/);
  assert.match(body, /### Spend[\s\S]*\| Fix \| 1 \| 1\.2k \| \$0\.250 \|[\s\S]*\| \*\*total\*\* \| 1 \|/);
  assert.match(body, /`test -f b\.txt` passed after each agent's change was applied/);
  assert.match(body, new RegExp(`odw diff ${fx.runId} --agent 1`));
  assert.match(r.out, /opened a draft PR: https:\/\/github\.example\/acme\/widgets\/pull\/7 — odw never merges it/);
});

test("--pr --all: one branch, one commit per finished agent in order, one ready PR with the given title and base", async () => {
  const fx = await setup({ "a.txt": "a\n", "b.txt": "b\n" }, [
    { label: "first", edit: { "a.txt": "a1\n" } },
    { label: "broken", edit: { "c.txt": "c\n" }, state: "failed" },
    { label: "second", edit: { "b.txt": "b2\n" } },
  ]);
  // The branch name is taken on the remote: the next one is used.
  git(fx.repo, "push", "-q", "origin", `main:refs/heads/odw/${fx.runId}-all`);
  const r = await cli(["apply", fx.runId, "--all", "--pr", "--base", "main", "--ready", "--title", "Two fixes", ...fx.flags], fx.repo, fx.path);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /--all leaves out agent 2 \(broken\), which failed/);
  const branch = `odw/${fx.runId}-all-2`;
  assert.ok(remoteBranches(fx).includes(branch));
  assert.deepEqual(git(fx.bare, "log", "--format=%s", `main..${branch}`).trim().split("\n"), ["odw: triage: second", "odw: triage: first"]);
  assert.equal(git(fx.bare, "show", `${branch}:a.txt`), "a1\n");
  assert.equal(git(fx.bare, "show", `${branch}:b.txt`), "b2\n");
  assert.equal(git(fx.bare, "ls-tree", "--name-only", branch).split("\n").includes("c.txt"), false, "the failed agent's file is not there");
  const creates = ghCalls(fx).filter((c) => c.args[0] === "pr");
  assert.equal(creates.length, 1, "one PR");
  const args = creates[0]!.args;
  assert.ok(!args.includes("--draft"), "--ready");
  assert.equal(args[args.indexOf("--title") + 1], "Two fixes");
  assert.equal(args[args.indexOf("--base") + 1], "main");
  assert.match(creates[0]!.body!, /No verify command ran/);
  assert.match(creates[0]!.body!, /\| 1 first \|[\s\S]*\| 3 second \|/);
});

test("--pr without gh, or with a gh not logged in, stops after the push and prints the compare URL", async () => {
  const fx = await setup({ "a.txt": "a\n" }, [{ label: "fix", edit: { "a.txt": "b\n" } }]);
  const r = await cli(["apply", fx.runId, "--agent", "1", "--pr", ...fx.flags], fx.repo, fx.noGh);
  assert.equal(r.code, 0, r.err);
  const branch = `odw/${fx.runId}-fix`;
  assert.ok(remoteBranches(fx).includes(branch));
  assert.match(r.out, new RegExp(`no PR opened: gh \\(the GitHub CLI\\) is not installed — open it at https://github\\.com/acme/widgets/compare/main\\.\\.\\.odw/${fx.runId}-fix\\?expand=1`));

  const fx2 = await setup({ "a.txt": "a\n" }, [{ label: "fix", edit: { "a.txt": "b\n" } }]);
  process.env.FAKE_GH_AUTH = "fail";
  const r2 = await cli(["apply", fx2.runId, "--agent", "1", "--pr", ...fx2.flags], fx2.repo, fx2.path);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /no PR opened: gh is not logged in \(gh auth login\) — open it at https:\/\/github\.com\/acme\/widgets\/compare\//);
  assert.deepEqual(ghCalls(fx2).map((c) => c.args[0]), ["auth"], "no pr create");

  // gh logged in but refusing: the branch is pushed, the URL said, and the exit is 1.
  const fx3 = await setup({ "a.txt": "a\n" }, [{ label: "fix", edit: { "a.txt": "b\n" } }]);
  process.env.FAKE_GH_CREATE = "fail";
  const r3 = await cli(["apply", fx3.runId, "--agent", "1", "--pr", ...fx3.flags], fx3.repo, fx3.path);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /gh pr create failed: GraphQL: no permission/);
  assert.match(r3.out, /the branch is pushed: open it at https:\/\/github\.com\//);
});

test("--pr leaves a dirty working tree as it is, and keeps its uncommitted changes out of the PR", async () => {
  const fx = await setup({ "a.txt": "a\n", "other.txt": "o\n" }, [{ label: "fix", edit: { "a.txt": "agent\n" } }]);
  // Uncommitted edits in the very file the agent changed, staged and not, and an untracked file.
  writeFileSync(join(fx.repo, "other.txt"), "staged\n");
  git(fx.repo, "add", "other.txt");
  writeFileSync(join(fx.repo, "a.txt"), "mine\n");
  writeFileSync(join(fx.repo, "scratch.txt"), "untracked\n");
  const before = checkout(fx.repo);
  const r = await cli(["apply", fx.runId, "--agent", "fix", "--pr", ...fx.flags], fx.repo, fx.path);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /your uncommitted changes stay where they are and are not part of the PR: it branches from main/);
  assert.equal(checkout(fx.repo), before);
  assert.equal(readFileSync(join(fx.repo, "a.txt"), "utf8"), "mine\n");
  const branch = `odw/${fx.runId}-fix`;
  assert.equal(git(fx.bare, "show", `${branch}:a.txt`), "agent\n");
  assert.equal(git(fx.bare, "show", `${branch}:other.txt`), "o\n");
  assert.equal(git(fx.bare, "ls-tree", "--name-only", branch).includes("scratch.txt"), false);

  // --force means nothing here, and --check previews only.
  for (const extra of [["--force"], ["--check"], ["--resolve"], ["--draft", "--ready"]]) {
    const bad = await cli(["apply", fx.runId, "--agent", "fix", "--pr", ...extra, ...fx.flags], fx.repo, fx.path);
    assert.equal(bad.code, 2, extra.join(" "));
  }
  const stray = await cli(["apply", fx.runId, "--agent", "fix", "--base", "main", ...fx.flags], fx.repo, fx.path);
  assert.equal(stray.code, 2);
  assert.match(stray.err, /--base goes with --pr/);
});

test("--pr: a failing verify, or a conflict, stops before the push — no branch anywhere, gh never asked", async () => {
  const fx = await setup({ "a.txt": "a\n" }, [{ label: "fix", edit: { "a.txt": "b\n" } }]);
  const before = checkout(fx.repo);
  const r = await cli(["apply", fx.runId, "--agent", "fix", "--pr", "--verify", "echo red; exit 3", ...fx.flags], fx.repo, fx.path);
  assert.equal(r.code, 1);
  assert.match(r.err, /verify failed for agent 1 \(fix\)/);
  assert.match(r.err, /did not apply cleanly and pass its verify: nothing was pushed, and branch odw\/\S+-fix is gone/);
  assert.deepEqual(remoteBranches(fx), ["main"]);
  assert.equal(git(fx.repo, "branch", "--list", "odw/*").trim(), "");
  assert.deepEqual(ghCalls(fx), []);
  assert.equal(checkout(fx.repo), before);

  // main moved on under the agent: its diff conflicts on the new base.
  writeFileSync(join(fx.repo, "a.txt"), "c\n");
  git(fx.repo, "commit", "-qam", "moved");
  const c = await cli(["apply", fx.runId, "--agent", "fix", "--pr", ...fx.flags], fx.repo, fx.path);
  assert.equal(c.code, 1);
  assert.match(c.err, /nothing was pushed/);
  assert.deepEqual(remoteBranches(fx), ["main"]);
  assert.equal(git(fx.repo, "branch", "--list", "odw/*").trim(), "");
  assert.deepEqual(ghCalls(fx), []);
});

test("--pr refuses a repository without the remote, and a base that does not exist", async () => {
  const fx = await setup({ "a.txt": "a\n" }, [{ label: "fix", edit: { "a.txt": "b\n" } }]);
  const noRemote = await cli(["apply", fx.runId, "--agent", "fix", "--pr", "--remote", "upstream", ...fx.flags], fx.repo, fx.path);
  assert.equal(noRemote.code, 1);
  assert.match(noRemote.err, /no remote 'upstream'/);
  const noBase = await cli(["apply", fx.runId, "--agent", "fix", "--pr", "--base", "nope", ...fx.flags], fx.repo, fx.path);
  assert.equal(noBase.code, 1);
  assert.match(noBase.err, /no branch or commit 'nope'/);
  assert.deepEqual(remoteBranches(fx), ["main"]);
});

test("compareUrl: GitHub remotes in every spelling, credentials dropped; other hosts get none", () => {
  const want = "https://github.com/acme/widgets/compare/main...odw/r1-fix?expand=1";
  assert.equal(compareUrl("https://github.com/acme/widgets.git", "main", "odw/r1-fix"), want);
  assert.equal(compareUrl("git@github.com:acme/widgets.git", "main", "odw/r1-fix"), want);
  assert.equal(compareUrl("ssh://git@github.com/acme/widgets", "main", "odw/r1-fix"), want);
  assert.equal(compareUrl("https://user:PLACEHOLDER@github.com/acme/widgets.git", "main", "odw/r1-fix"), want);
  assert.equal(compareUrl("https://gitlab.example.com/acme/widgets.git", "main", "x"), null);
  assert.equal(compareUrl("/srv/git/widgets.git", "main", "x"), null);
});
