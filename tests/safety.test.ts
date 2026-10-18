import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { AdapterOutput, CliResult } from "../src/adapters/types.js";
import { DestructiveGitWatch, destructiveGitCommands, type DestructiveGitHit } from "../src/destructive-git.js";
import { event, type WorkflowEvent } from "../src/events.js";
import { BEHAVIOUR_SETTINGS } from "../src/provenance.js";
import { safetyRef, takeSafetySnapshot } from "../src/safety.js";
import { formatEvent, safetyLines } from "../src/runtime/live-view.js";
import { restoreSnapshot } from "../src/runtime/restore.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail, summarize } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

// T3 (ODW extension): before a run's first in-place agent that may change the
// user's tree, ODW snapshots its uncommitted work at refs/odw/safety/<run>;
// `odw restore <run>` puts it back. What agents run is read for destructive
// git commands — `git reset --hard` and its kin — recorded as
// destructive_git events ("warn") or failing the agent ("fail").

const EXPECT_AGENT = fileURLToPath(new URL("./fixtures/expect-agent.mjs", import.meta.url));
const CLAUDE = defaultConfig().adapters.claude!;
const CODEX = defaultConfig().adapters.codex!;
const TEXT = { ...CLAUDE, output: { format: "text" } as AdapterOutput };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A repository with `committed` in one commit; its path as git names it (macOS: /private/var/…). */
function makeRepo(root: string, committed: Record<string, string>): string {
  const dir = join(root, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q");
  write(dir, committed);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-gpg-sign", "-m", "init");
  return realpathSync(dir);
}

const tempRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "odw-safety-")));

/** What a test sees of a working tree: status, stash list and index — none of which a snapshot may touch. */
function treeState(repo: string): string {
  return [git(repo, "status", "--porcelain=v1", "--untracked-files=all"), git(repo, "stash", "list"), git(repo, "ls-files", "-s")].join("\n--\n");
}

// --- reading a command line ------------------------------------------------------------------

test("destructive git commands are told from the harmless ones", () => {
  const hits = (line: string) => destructiveGitCommands(line).map((h) => `${h.what}|${h.scope}`);
  const cases: Array<[string, string[]]> = [
    ["git reset --hard", ["git reset --hard|worktree"]],
    ["git reset --hard origin/main", ["git reset --hard|worktree"]],
    ["git reset --soft HEAD~1", []],
    ["git reset HEAD file.ts", []],
    ["git checkout .", ["git checkout .|worktree"]],
    ["git checkout -- .", ["git checkout .|worktree"]],
    ["git checkout HEAD -- .", ["git checkout .|worktree"]],
    ["git checkout -f main", ["git checkout --force|worktree"]],
    ["git checkout -b feature", []],
    ["git checkout main", []],
    ["git checkout -- src/a.ts", []],
    ["git restore .", ["git restore .|worktree"]],
    ["git restore --staged .", []],
    ["git restore --staged --worktree :/", ["git restore .|worktree"]],
    ["git clean -fd", ["git clean -f|worktree"]],
    ["git clean -xdf", ["git clean -f|worktree"]],
    ["git clean --force", ["git clean -f|worktree"]],
    ["git clean -nfd", []],
    ["git clean -fd --dry-run", []],
    ["git push --force origin main", ["git push --force|repository"]],
    ["git push -f", ["git push --force|repository"]],
    ["git push --force-with-lease", ["git push --force|repository"]],
    ["git push origin +main", ["git push --force|repository"]],
    ["git push -u origin feature", []],
    ["git stash drop", ["git stash drop|repository"]],
    ["git stash clear", ["git stash clear|repository"]],
    ["git stash", []],
    ["git stash pop", []],
    ["git branch -D old", ["git branch -D|repository"]],
    ["git branch -d --force old", ["git branch -D|repository"]],
    ["git branch -d merged", []],
    ["git status && git diff", []],
  ];
  for (const [line, want] of cases) assert.deepEqual(hits(line), want, line);
});

test("a command line is read as a shell reads it: chains, wrappers, shells' -c scripts, git's global options — not quoted text", () => {
  const whats = (line: string) => destructiveGitCommands(line).map((h) => h.what);
  assert.deepEqual(whats("cd repo && git reset --hard; npm test"), ["git reset --hard"]);
  assert.deepEqual(whats("git stash && git clean -fd || true"), ["git clean -f"]);
  assert.deepEqual(whats("bash -lc 'git reset --hard HEAD'"), ["git reset --hard"]);
  assert.deepEqual(whats('/bin/zsh -c "cd x && git checkout ."'), ["git checkout ."]);
  assert.deepEqual(whats("sudo -u me git clean -f"), ["git clean -f"]);
  assert.deepEqual(whats("GIT_DIR=.git env -u X git reset --hard"), ["git reset --hard"]);
  assert.deepEqual(whats("timeout 60 /usr/bin/git -C /repo -c core.x=1 --no-pager reset --hard"), ["git reset --hard"]);
  assert.deepEqual(whats("echo $(git stash drop)"), ["git stash drop"]);
  assert.deepEqual(whats("git log --oneline | head\ngit branch -D tmp"), ["git branch -D"]);
  // Text that only mentions a command is not one.
  assert.deepEqual(whats('grep -rn "git reset --hard" docs'), []);
  assert.deepEqual(whats("echo git reset --hard"), []);
  assert.deepEqual(whats("git commit -m 'never git reset --hard'"), []);
  assert.deepEqual(whats("# git reset --hard\ngit status"), []);
});

test("review fix: shell keywords, git switch --force, push --mirror/--delete/:refspec, and git pointed at another tree", () => {
  const hits = (line: string) => destructiveGitCommands(line).map((h) => `${h.what}|${h.scope}${h.elsewhere ? "|elsewhere" : ""}`);
  const cases: Array<[string, string[]]> = [
    ["if true; then git reset --hard; fi", ["git reset --hard|worktree"]],
    ["for f in a; do git clean -fd; done", ["git clean -f|worktree"]],
    ["if false; then :; else git checkout .; fi", ["git checkout .|worktree"]],
    ["if a; then :; elif b; then git stash clear; fi", ["git stash clear|repository"]],
    ["while true; do git restore .; done", ["git restore .|worktree"]],
    ["! git reset --hard", ["git reset --hard|worktree"]],
    ["{ git reset --hard; }", ["git reset --hard|worktree"]],
    ["git switch -f main", ["git switch --force|worktree"]],
    ["git switch --force main", ["git switch --force|worktree"]],
    ["git switch --discard-changes main", ["git switch --force|worktree"]],
    ["git switch -c feature", []],
    ["git push --mirror backup", ["git push --mirror|repository"]],
    ["git push --delete origin old", ["git push --delete|repository"]],
    ["git push -d origin old", ["git push --delete|repository"]],
    ["git push origin :old", ["git push --delete|repository"]],
    ["git push origin :", []],
    ["git push origin main", []],
    ["git -C /home/me/project reset --hard", ["git reset --hard|worktree|elsewhere"]],
    ["git --git-dir=/elsewhere/.git --work-tree=/elsewhere checkout .", ["git checkout .|worktree|elsewhere"]],
    ["git --work-tree ../main clean -fd", ["git clean -f|worktree|elsewhere"]],
    ["git -C . reset --hard", ["git reset --hard|worktree"]],
    ["git -C /x push --force", ["git push --force|repository"]],
  ];
  for (const [line, want] of cases) assert.deepEqual(hits(line), want, line);
  // An isolated agent that points git at another tree is reported: ODW cannot tell it is its own.
  const seen: string[] = [];
  const watch = new DestructiveGitWatch((hit) => seen.push(hit.command), true);
  watch.beginRun(undefined, CLAUDE);
  watch.stdout(`${claudeBash("a", "git reset --hard")}\n${claudeBash("b", "git -C /home/me/project reset --hard")}\n`);
  watch.endRun(ok());
  assert.deepEqual(seen, ["git -C /home/me/project reset --hard"]);
  // What runs git without saying so on its command line is not seen (advisory, best effort).
  assert.deepEqual(hits("find . -name x -exec git checkout -- {} +"), []);
  assert.deepEqual(hits("echo . | xargs git checkout --"), []);
});

// --- watching an agent's CLI --------------------------------------------------------------------

const claudeBash = (id: string, command: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const ok = (stdout = ""): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 });

test("the watch reads each CLI's tool calls as they stream, and says each command once", () => {
  const hits: DestructiveGitHit[] = [];
  const watch = new DestructiveGitWatch((hit) => hits.push(hit), false);
  watch.beginRun(undefined, CLAUDE);
  const line = claudeBash("t1", "git status && git reset --hard");
  // A line split across chunks is read once it is whole.
  watch.stdout(line.slice(0, 20));
  assert.equal(hits.length, 0);
  watch.stdout(`${line.slice(20)}\n${claudeBash("t2", "git clean -fd")}\n`);
  watch.stdout(`${claudeBash("t3", "git reset --hard")}\n`);
  watch.endRun(ok());
  assert.deepEqual(
    hits.map((h) => [h.what, h.command]),
    [
      ["git reset --hard", "git status && git reset --hard"],
      ["git clean -f", "git clean -fd"],
      ["git reset --hard", "git reset --hard"],
    ],
  );
  // Codex: a command_execution item shows as it starts and again as it ends — one hit.
  const codexHits: DestructiveGitHit[] = [];
  const codex = new DestructiveGitWatch((hit) => codexHits.push(hit), false);
  codex.beginRun(undefined, CODEX);
  const item = (type: string, status: string) =>
    JSON.stringify({ type, item: { id: "i1", type: "command_execution", command: "bash -lc 'git checkout -- .'", status, aggregated_output: "", exit_code: 0 } });
  codex.stdout(`${item("item.started", "in_progress")}\n${item("item.completed", "completed")}\n`);
  codex.endRun(ok());
  assert.deepEqual(codexHits.map((h) => h.what), ["git checkout ."]);
  assert.equal(codex.summary(), "git checkout .");
});

test("an isolated agent's own worktree is its to reset: only commands that reach the whole repository count", () => {
  const hits: string[] = [];
  const watch = new DestructiveGitWatch((hit) => hits.push(hit.what), true);
  watch.beginRun(undefined, CLAUDE);
  watch.stdout(`${claudeBash("a", "git reset --hard")}\n${claudeBash("b", "git push --force")}\n${claudeBash("c", "git branch -D x")}\n`);
  watch.endRun(ok());
  assert.deepEqual(hits, ["git push --force", "git branch -D"]);
});

test("a whole stdout an injected runner returns is read at the run's end; a text adapter's prose is not read", () => {
  const hits: string[] = [];
  const watch = new DestructiveGitWatch((hit) => hits.push(hit.what), false);
  watch.beginRun(undefined, CLAUDE);
  watch.endRun(ok(`${claudeBash("a", "git stash clear")}\n`));
  assert.deepEqual(hits, ["git stash clear"]);
  const text = new DestructiveGitWatch((hit) => hits.push(hit.what), false);
  text.beginRun(undefined, TEXT);
  text.stdout("I ran git reset --hard for you\n");
  text.endRun(ok("I ran git reset --hard for you\n"));
  assert.deepEqual(hits, ["git stash clear"]);
});

// --- the snapshot ---------------------------------------------------------------------------------

test("a dirty tree is kept at refs/odw/safety/<run>: tracked changes, staged files and untracked ones — the tree, index and stash list untouched", async () => {
  const root = tempRoot();
  try {
    const repo = makeRepo(root, { "a.txt": "a\n", "b.txt": "b\n", ".gitignore": "*.log\nbuild/\n" });
    write(repo, { "a.txt": "a, edited\n", "new.txt": "untracked\n", "debug.log": "ignored\n", "build/out.js": "ignored\n" });
    write(repo, { "staged.txt": "staged\n" });
    git(repo, "add", "staged.txt");
    git(repo, "rm", "-q", "b.txt");
    const before = treeState(repo);
    const outcome = await takeSafetySnapshot(repo, "20261018-101010-abcdef");
    assert.ok("taken" in outcome, JSON.stringify(outcome));
    const info = outcome.taken;
    assert.equal(info.ref, "refs/odw/safety/20261018-101010-abcdef");
    assert.equal(git(repo, "rev-parse", info.ref).trim(), info.commit);
    assert.equal(git(repo, "rev-parse", `${info.commit}^1`).trim(), git(repo, "rev-parse", "HEAD").trim());
    assert.equal(git(repo, "rev-parse", `${info.commit}^2`).trim(), info.stash);
    assert.equal(info.tracked, 3, "a.txt edited, b.txt deleted, staged.txt added");
    assert.equal(info.untracked, 1);
    const files = git(repo, "ls-tree", "-r", "--name-only", info.commit).trim().split("\n").sort();
    assert.deepEqual(files, [".gitignore", "a.txt", "new.txt", "staged.txt"], "ignored files are not kept, a deleted one is gone");
    assert.equal(git(repo, "show", `${info.commit}:a.txt`), "a, edited\n");
    assert.equal(git(repo, "show", `${info.commit}:new.txt`), "untracked\n");
    assert.equal(treeState(repo), before, "status, stash list and index as they were");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean tree gets no snapshot; a directory outside git, or a run id no ref may have, says why", async () => {
  const root = tempRoot();
  try {
    const repo = makeRepo(root, { "a.txt": "a\n" });
    assert.deepEqual(await takeSafetySnapshot(repo, "run-1"), { clean: true });
    assert.equal(execFileSync("git", ["for-each-ref", "refs/odw/"], { cwd: repo, encoding: "utf8" }), "");
    const plain = join(root, "plain");
    mkdirSync(plain);
    const none = await takeSafetySnapshot(plain, "run-1");
    assert.ok("none" in none && /not in a git repository/.test(none.none));
    assert.equal(safetyRef("../x"), null);
    assert.equal(safetyRef("a..b"), null);
    assert.equal(safetyRef("x.lock"), null);
    assert.equal(safetyRef("20261018-101010-abcdef"), "refs/odw/safety/20261018-101010-abcdef");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the run's own directory, when it lies in the tree, is left out of the snapshot", async () => {
  const root = tempRoot();
  try {
    const repo = makeRepo(root, { "a.txt": "a\n" });
    write(repo, { "notes.md": "mine\n", ".odw-runs/r1/events.jsonl": "{}\n" });
    const outcome = await takeSafetySnapshot(repo, "r1", [join(repo, ".odw-runs", "r1")]);
    assert.ok("taken" in outcome);
    assert.equal(outcome.taken.untracked, 1);
    assert.deepEqual(git(repo, "ls-tree", "-r", "--name-only", outcome.taken.commit).trim().split("\n").sort(), ["a.txt", "notes.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the whole stack ------------------------------------------------------------------------------

interface Flow {
  id: string;
  state: string;
  store: RunStore;
  result: Record<string, unknown>;
  events: WorkflowEvent[];
}

/** One agent() call labelled `fix`, run in `repo`, its scripted CLI speaking Claude Code's stream-json. */
async function runAgent(root: string, repo: string, plan: unknown[], opts: Record<string, unknown> = {}, settings: Record<string, unknown> = {}): Promise<Flow> {
  const log = join(root, "calls.jsonl");
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "claude",
      ...settings,
      adapters: {
        claude: { command: [execPath, EXPECT_AGENT, log, "--claude", "{permission_args}"], stdin: "{prompt}", output: CLAUDE.output, permissionArgs: { read: [], edit: [], full: [] } },
      },
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'wf', description: 'd' }\n" +
      "try { return { value: await agent('Fix it. PLAN: ' + JSON.stringify(args.plan), args.opts) } }\n" +
      "catch (err) { return { error: String(err) } }\n",
  );
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: { plan, opts: { label: "fix", ...opts } }, source: repo, configPath });
  const state = await executeRun(store.runDir(id));
  return { id, state, store, result: (store.readResult(id) ?? {}) as Record<string, unknown>, events: store.readEvents(id) };
}

const ofType = (events: WorkflowEvent[], type: string) => events.filter((e) => e.type === type);
const bash = (id: string, command: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });

/** What `odw restore` printed, and its exit code. */
async function restore(runId: string, source: string, flags: { check?: boolean; force?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await restoreSnapshot({
    runId,
    source,
    check: flags.check === true,
    force: flags.force === true,
    out: { write: (text: string) => (out += text) },
    err: { write: (text: string) => (err += text) },
    caps: { color: false, truecolor: false, unicode: false },
    width: 200,
  });
  return { code, out, err };
}

test("an in-place agent's `git reset --hard` is recorded, its run's snapshot named — and odw restore puts the work back", async () => {
  const root = tempRoot();
  try {
    const repo = makeRepo(root, { "src/app.ts": "v1\n", "README.md": "readme\n" });
    write(repo, { "src/app.ts": "v2, two days of work\n", "src/new.ts": "brand new\n" });
    // The agent resets the tracked file and runs the command that would: its untracked file survives, as with git.
    const flow = await runAgent(root, repo, [
      { write: { "src/app.ts": "v1\n" }, stream: [bash("t1", "git stash list; git reset --hard")], reply: "Cleaned up." },
    ]);
    assert.equal(flow.state, "done");
    assert.deepEqual(flow.result, { value: "Cleaned up." }, "warn: the reply stands");
    const types = flow.events.map((e) => e.type);
    const snap = ofType(flow.events, "safety_snapshot")[0]!;
    assert.ok(snap, "a snapshot was taken");
    assert.ok(types.indexOf("safety_snapshot") < types.indexOf("agent_started"), "before the agent started");
    assert.equal(snap.ref, `refs/odw/safety/${flow.id}`);
    assert.equal(snap.tracked, 1);
    assert.equal(snap.untracked, 1);
    assert.match(String(snap.message), new RegExp(`odw restore ${flow.id}`));
    const hit = ofType(flow.events, "destructive_git")[0]!;
    assert.equal(hit.what, "git reset --hard");
    assert.equal(hit.command, "git stash list; git reset --hard");
    assert.equal(hit.agentId, 1);
    assert.equal(hit.policy, "warn");
    assert.equal(hit.snapshot, snap.ref);
    assert.match(String(hit.message), new RegExp(`^fix:1 ran a destructive git command \\(git reset --hard\\): .* odw restore ${flow.id}`));
    assert.match(formatEvent(hit), /destructive_git .*fix:1 ran a destructive git command/);
    assert.match(formatEvent(snap), /safety_snapshot .*kept at refs\/odw\/safety\//);
    const view = detail(flow.store, flow.id);
    assert.deepEqual(view.agents[0]!.destructiveGit, [{ command: "git stash list; git reset --hard", what: "git reset --hard" }]);
    assert.equal(view.safetySnapshot?.ref, snap.ref);
    assert.deepEqual(summarize(flow.store, flow.id).destructiveGit, { agents: 1, restorable: true }, "the run list carries it for Needs you");
    assert.equal(view.safetySnapshot?.commit, snap.commit);
    assert.equal(view.safetySnapshot?.tracked, 1);
    // odw status says both.
    assert.deepEqual(safetyLines(flow.id, view.agents, view.safetySnapshot), [
      `safety snapshot: 1 changed and 1 untracked file(s) at ${snap.ref} (${String(snap.commit).slice(0, 12)}) — odw restore ${flow.id} puts them back`,
      "destructive git: 1 agent — fix:1 git reset --hard",
    ]);

    // --check previews only: the untracked file the reset left is as kept, so only app.ts is in it.
    const check = await restore(flow.id, repo, { check: true });
    assert.equal(check.code, 0, check.err);
    assert.match(check.out, /1 of the snapshot's 2 file\(s\) are as it kept them already; the other 1:/);
    assert.match(check.out, /the safety snapshot of run .* applies cleanly to /);
    assert.equal(readFileSync(join(repo, "src/app.ts"), "utf8"), "v1\n", "--check changed nothing");

    const done = await restore(flow.id, repo);
    assert.equal(done.code, 0, done.err);
    assert.equal(readFileSync(join(repo, "src/app.ts"), "utf8"), "v2, two days of work\n");
    assert.equal(readFileSync(join(repo, "src/new.ts"), "utf8"), "brand new\n");
    // Again: nothing left to put back.
    const again = await restore(flow.id, repo);
    assert.equal(again.code, 0);
    assert.match(again.out, /nothing to restore: .* holds all 2 file\(s\) the snapshot kept/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore after a `git clean -fd` and a changed HEAD: deleted untracked files come back, three-way onto the new HEAD", async () => {
  const root = tempRoot();
  try {
    const repo = makeRepo(root, { "a.txt": "one\ntwo\nthree\n" });
    write(repo, { "a.txt": "one\ntwo\nthree\nfour (mine)\n", "scratch/plan.md": "plan\n" });
    const flow = await runAgent(root, repo, [
      {
        write: { "a.txt": "zero\none\ntwo\nthree\n" },
        remove: ["scratch"],
        commit: "agent's commit",
        stream: [bash("t1", "git clean -fd && git commit -am x")],
      },
    ]);
    assert.equal(flow.state, "done");
    assert.equal(ofType(flow.events, "destructive_git")[0]?.what, "git clean -f");
    const done = await restore(flow.id, repo);
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, /HEAD has moved since: it is at [0-9a-f]{12} now/);
    assert.equal(readFileSync(join(repo, "scratch/plan.md"), "utf8"), "plan\n");
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "zero\none\ntwo\nthree\nfour (mine)\n", "the user's line on top of the agent's commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore refuses over uncommitted changes in a path it touches; without a snapshot it says why", async () => {
  const root = tempRoot();
  try {
    const repo = makeRepo(root, { "a.txt": "a\n" });
    write(repo, { "a.txt": "mine\n" });
    const flow = await runAgent(root, repo, [{ write: { "a.txt": "the agent's\n" }, stream: [bash("t", "git checkout .")] }]);
    const refused = await restore(flow.id, repo);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /uncommitted changes in the way of the diff the safety snapshot of run .* pass --force/);
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "the agent's\n");
    const none = await restore("20200101-000000-000000", repo);
    assert.equal(none.code, 1);
    assert.match(none.err, /has no safety snapshot in .* taken before a run's first in-place agent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('destructiveGit: "fail" fails the agent with reason destructive_git once its CLI is done', async () => {
  const root = tempRoot();
  try {
    const repo = makeRepo(root, { "a.txt": "a\n" });
    write(repo, { "a.txt": "mine\n" });
    const flow = await runAgent(root, repo, [{ stream: [bash("t", "git push --force origin main")], reply: "pushed" }], {}, { destructiveGit: "fail" });
    const failed = ofType(flow.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "destructive_git");
    assert.match(String(failed.error), /ran a destructive git command \(git push --force\): git push --force origin main — destructiveGit: "fail"/);
    assert.match(String(flow.result.error), /destructive git command/);
    assert.equal(ofType(flow.events, "destructive_git")[0]?.policy, "fail");
    assert.equal(detail(flow.store, flow.id).agents[0]!.failureReason, "destructive_git");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no snapshot for a read-only agent, an isolated one, or a clean tree; an isolated agent's reset is no hit", async () => {
  const root = tempRoot();
  try {
    const repo = makeRepo(root, { "a.txt": "a\n" });
    write(repo, { "a.txt": "mine\n" });
    const read = await runAgent(root, repo, [{ reply: "looked" }], { permissions: "read" });
    assert.equal(read.state, "done");
    assert.equal(ofType(read.events, "safety_snapshot").length, 0);
    const isolated = await runAgent(root, repo, [{ stream: [bash("t", "git reset --hard")], reply: "ok" }], { isolation: "worktree" });
    assert.equal(isolated.state, "done");
    assert.equal(ofType(isolated.events, "safety_snapshot").length, 0);
    assert.equal(ofType(isolated.events, "destructive_git").length, 0);
    git(repo, "checkout", "--", "a.txt");
    const clean = await runAgent(root, repo, [{ reply: "ok" }]);
    assert.equal(ofType(clean.events, "safety_snapshot").length, 0);
    assert.equal(execFileSync("git", ["for-each-ref", "refs/odw/safety/"], { cwd: repo, encoding: "utf8" }), "");
    assert.ok(!existsSync(join(repo, "calls.jsonl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a source outside git: the run says once that it has no snapshot, and goes on", async () => {
  const root = tempRoot();
  try {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const flow = await runAgent(root, plain, [{ reply: "ok" }]);
    assert.equal(flow.state, "done");
    const said = ofType(flow.events, "log").filter((e) => e.safety === "none");
    assert.equal(said.length, 1);
    assert.match(String(said[0]!.message), /^safety: no snapshot of the working tree before the first in-place agent — .* not in a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the setting ----------------------------------------------------------------------------------

test("destructiveGit is a setting: warn by default, fail when asked, anything else refused; runs record it", () => {
  const root = tempRoot();
  try {
    assert.equal(defaultConfig().settings.destructiveGit, "warn");
    const path = join(root, "odw.config.json");
    writeFileSync(path, JSON.stringify({ destructiveGit: "fail" }));
    assert.equal(loadConfig(path, { quiet: true }).settings.destructiveGit, "fail");
    writeFileSync(path, JSON.stringify({ destructiveGit: "block" }));
    assert.throws(() => loadConfig(path, { quiet: true }), /destructiveGit/);
    assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("destructiveGit"));
    assert.equal(formatEvent(event("destructive_git", { message: "x ran it" })).endsWith("destructive_git x ran it"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
