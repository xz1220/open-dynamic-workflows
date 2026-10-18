import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { branchName, ChangeRecorder } from "../src/changes.js";
import { RunStopped } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { withWorkspace } from "../src/workspace.js";
import { parseDiff } from "../web/src/components/diff.ts";

// What isolated agents changed, kept (ODW extension): the diff in the run
// directory, its counts on the events and records, what stays out of it, the
// size cap, and the branches keep: true makes — all against real git repos.

const POSIX_ONLY = { skip: process.platform === "win32" };
const EDIT_AGENT = fileURLToPath(new URL("./fixtures/edit-agent.mjs", import.meta.url));

/** The flags a kept diff is made with, to diff two commits the same way. */
const DIFF_FLAGS = [
  "-c", "core.quotePath=true", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
  "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index", "-M", "--src-prefix=a/", "--dst-prefix=b/",
];

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function write(dir: string, files: Record<string, string | Buffer>): void {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
}

/** A repo with `committed` in its one commit, and `extra` written over it afterwards. */
function makeRepo(committed: Record<string, string | Buffer>, extra: Record<string, string | Buffer> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-diff-src-"));
  git(dir, "init", "-q");
  write(dir, committed);
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  write(dir, extra);
  return dir;
}

function worktrees(repo: string): number {
  return git(repo, "worktree", "list", "--porcelain").trim().split("\n\n").length;
}

/** Run `body` as a workflow over `source`, with the file-editing agent as the default adapter. */
async function runFlow(opts: {
  root: string;
  source: string;
  body: string;
  args?: unknown;
  config?: Record<string, unknown>;
  resumedFrom?: { runId: string; dir: string };
}): Promise<{ id: string; state: string; store: RunStore }> {
  const configPath = join(opts.root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "edit",
      ...opts.config,
      adapters: { edit: { command: [execPath, EDIT_AGENT], stdin: "{prompt}" } },
    }),
  );
  const script = join(opts.root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${opts.body}`);
  const store = new RunStore(join(opts.root, "runs"));
  const id = store.create({ script, args: opts.args ?? null, source: opts.source, configPath, resumedFrom: opts.resumedFrom });
  return { id, state: await executeRun(store.runDir(id)), store };
}

function terminal(store: RunStore, id: string, agentId: number): WorkflowEvent {
  const ev = store.readEvents(id).find((e) => (e.type === "agent_finished" || e.type === "agent_failed") && e.agentId === agentId);
  assert.ok(ev, `agent ${agentId} settled`);
  return ev;
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

test("an isolated agent's change is kept as a diff: edits, new, deleted, renamed and binary files", async () => {
  const src = makeRepo({
    "a.txt": "one\ntwo\nthree\n",
    "gone.txt": "bye\n",
    "old-name.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\n",
    "img.bin": Buffer.from([0, 1, 2, 3]),
  });
  const root = mkdtempSync(join(tmpdir(), "odw-diff-run-"));
  try {
    const { id, state, store } = await runFlow({
      root,
      source: src,
      args: {
        write: {
          "a.txt": "one\nTWO\nthree\n",
          "new.txt": "fresh\n",
          "new-name.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n",
        },
        remove: ["gone.txt", "old-name.txt"],
        bytes: { "img.bin": [0, 9, 2, 3, 7] },
      },
      body: "return await agent('EDITS: ' + JSON.stringify(args), { isolation: 'worktree', label: 'fix:auth' })\n",
    });
    assert.equal(state, "done");
    const file = store.agentDiffPath(id, 1);
    const text = readFileSync(file, "utf8");
    // The text contract the dashboard reads: a/ b/ headers, renames found, binary files marked.
    assert.match(text, /^diff --git a\/a\.txt b\/a\.txt$/m);
    assert.match(text, /^-two\n\+TWO$/m);
    assert.match(text, /^diff --git a\/new\.txt b\/new\.txt\nnew file mode 100644$/m);
    assert.match(text, /^diff --git a\/gone\.txt b\/gone\.txt\ndeleted file mode 100644$/m);
    assert.match(text, /^rename from old-name\.txt\nrename to new-name\.txt$/m);
    assert.match(text, /^Binary files a\/img\.bin and b\/img\.bin differ$/m);
    const parsed = parseDiff(text);
    assert.deepEqual(
      parsed.files.map((f) => `${f.status} ${f.newPath ?? f.oldPath}${f.binary ? " (binary)" : ""}`).sort(),
      ["added new.txt", "deleted gone.txt", "modified a.txt", "modified img.bin (binary)", "renamed new-name.txt"],
    );
    assert.deepEqual(parsed.notes, []);

    const changes = { files: 5, insertions: 3, deletions: 2, truncated: false };
    const finished = terminal(store, id, 1);
    assert.equal(finished.type, "agent_finished");
    assert.deepEqual(finished.changes, changes);
    assert.equal(finished.branch, null, "no branch without keep");
    assert.deepEqual(store.readAgentResult(id, 1)?.changes, changes);
    const [view] = detail(store, id).agents;
    assert.deepEqual([view!.changes, view!.branch], [changes, null]);

    // The source tree is untouched, the worktree gone, nothing left beside the diff — and it applies.
    assert.equal(git(src, "status", "--porcelain"), "");
    assert.equal(worktrees(src), 1);
    assert.deepEqual(readdirSync(dirname(file)).sort(), ["1.call.json", "1.diff", "1.json", "1.transcript.jsonl"]);
    git(src, "apply", "--check", file);
  } finally {
    cleanup(root, src);
  }
});

test("no diff is kept when an isolated agent changed nothing, nor for an agent in the source tree", async () => {
  const src = makeRepo({ "a.txt": "a\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-diff-run-"));
  try {
    const { id, state, store } = await runFlow({
      root,
      source: src,
      body:
        "return await parallel([\n" +
        "  () => agent('EDITS: {}', { isolation: 'worktree', label: 'idle' }),\n" +
        "  () => agent('EDITS: ' + JSON.stringify({ write: { 'a.txt': 'in place\\n' } }), { label: 'here', keep: true }),\n" +
        "])\n",
    });
    assert.equal(state, "done");
    for (const agentId of [1, 2]) {
      assert.equal(existsSync(store.agentDiffPath(id, agentId)), false, `agent ${agentId} kept no diff`);
      assert.equal("changes" in terminal(store, id, agentId), false);
    }
    assert.deepEqual(
      detail(store, id).agents.map((a) => [a.label, a.changes, a.branch]),
      [
        ["idle", null, null],
        ["here", null, null],
      ],
    );
    assert.equal(readFileSync(join(src, "a.txt"), "utf8"), "in place\n", "an agent in the source tree edits it directly");
    assert.ok(
      store
        .readEvents(id)
        .some((e) => e.type === "log" && e.message === 'here:2: keep: true has no effect without isolation: "worktree" — this agent works in the source tree'),
      "keep without isolation is noted",
    );
    assert.equal(git(src, "branch", "--list", "odw/*"), "");
  } finally {
    cleanup(root, src);
  }
});

test("what .worktreeinclude and worktreeSetup put in the worktree stays out of the diff, unless the agent changed it", POSIX_ONLY, async () => {
  const src = makeRepo(
    { "a.txt": "a\n", ".gitignore": ".env\nnode_modules/\n", "package-lock.json": '{ "v": 1 }\n' },
    {
      ".worktreeinclude": ".env\nnotes.md\nsymlink: node_modules\n",
      ".env": "SECRET=1\n",
      "notes.md": "my notes\n",
      "node_modules/pkg/index.js": "module.exports = 1\n",
    },
  );
  // The setup generates two files and rewrites a tracked one (as `npm install` rewrites a lock file).
  const setup = [
    execPath,
    "-e",
    "const fs = require('fs'); fs.writeFileSync('gen.txt', 'generated\\n'); fs.writeFileSync('gen2.txt', 'generated too\\n');" +
      " fs.writeFileSync('package-lock.json', '{ \"v\": 2 }\\n')",
  ];
  const root = mkdtempSync(join(tmpdir(), "odw-diff-run-"));
  try {
    const { id, state, store } = await runFlow({
      root,
      source: src,
      config: { worktreeSetup: setup },
      args: {
        write: {
          "a.txt": "a, by the agent\n",
          "gen2.txt": "rewritten by the agent\n",
          "notes.md": "my notes, by the agent\n",
          // Through the symlink: lands in the source tree's node_modules, never in the diff.
          "node_modules/pkg/new.js": "through the link\n",
          // Un-ignores the copied .env: it still is not the agent's change.
          ".gitignore": "node_modules/\n",
        },
      },
      body: "return await agent('EDITS: ' + JSON.stringify(args), { isolation: 'worktree', label: 'agent' })\n",
    });
    assert.equal(state, "done");
    const text = readFileSync(store.agentDiffPath(id, 1), "utf8");
    assert.deepEqual(
      parseDiff(text).files.map((f) => `${f.status} ${f.newPath ?? f.oldPath}`).sort(),
      ["added gen2.txt", "added notes.md", "modified .gitignore", "modified a.txt"],
      "only what the agent changed; a placed or generated file it rewrote counts whole",
    );
    assert.match(text, /^\+rewritten by the agent$/m);
    assert.match(text, /^\+my notes, by the agent$/m);
    assert.doesNotMatch(text, /SECRET|node_modules\/pkg|"v": 2|^\+generated$/m);
    // a.txt +1 -1, gen2.txt +1, notes.md +1, .gitignore -1 (the .env line).
    assert.deepEqual(terminal(store, id, 1).changes, { files: 4, insertions: 3, deletions: 2, truncated: false });
    assert.equal(readFileSync(join(src, "node_modules", "pkg", "new.js"), "utf8"), "through the link\n");
    assert.equal(worktrees(src), 1);
  } finally {
    cleanup(root, src);
  }
});

test("a diff over maxDiffBytes keeps its head, cut at a line, and one note; the counts describe the whole change", async () => {
  const src = makeRepo({ "a.txt": "a\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-diff-run-"));
  const lines = (name: string) => Array.from({ length: 100 }, (_, i) => `line ${i} of ${name}`).join("\n") + "\n";
  try {
    const { id, state, store } = await runFlow({
      root,
      source: src,
      config: { maxDiffBytes: 2048 },
      args: { write: { "big1.txt": lines("big1"), "big2.txt": lines("big2"), "big3.txt": lines("big3") } },
      body: "return await agent('EDITS: ' + JSON.stringify(args), { isolation: 'worktree', label: 'big', keep: true })\n",
    });
    assert.equal(state, "done");
    const branch = `odw/${id}/1-big`;
    const text = readFileSync(store.agentDiffPath(id, 1), "utf8");
    const at = text.lastIndexOf("\n", text.length - 2) + 1;
    const head = text.slice(0, at);
    const note = text.slice(at);
    assert.ok(Buffer.byteLength(head) <= 2048, `the head fits the cap: ${Buffer.byteLength(head)} bytes`);
    assert.ok(head.endsWith("\n"), "cut at a line boundary");
    const whole = git(src, ...DIFF_FLAGS, `${branch}~1`, branch);
    assert.ok(Buffer.byteLength(whole) > 2048);
    assert.ok(whole.startsWith(head), "the head is the start of the whole diff, which the branch keeps");
    const shown = (head.match(/^diff --git /gm) ?? []).length;
    const missing = 3 - shown === 1 ? "1 file not shown" : `${3 - shown} files not shown`;
    assert.equal(note, `# odw: diff truncated at 2.0 KB — ${missing}; the full change is on branch ${branch}\n`);
    assert.equal(text.split("\n").filter((l) => l.startsWith("# odw: diff truncated")).length, 1, "one note line");
    assert.deepEqual(terminal(store, id, 1).changes, { files: 3, insertions: 300, deletions: 0, truncated: true });
    assert.deepEqual(parseDiff(text).notes, [note.trimEnd()], "the dashboard shows the note");
  } finally {
    cleanup(root, src);
  }
});

test("keep: true commits the change to odw/<run>/<agent>-<label>; the user's branch, HEAD and index stay as they were", async () => {
  const src = makeRepo({ "a.txt": "a\n", "b.txt": "b\n" });
  // The user is mid-work: a staged new file and an unstaged edit.
  write(src, { "staged.txt": "staged\n" });
  git(src, "add", "staged.txt");
  write(src, { "b.txt": "b, unstaged\n" });
  const snapshot = () => ({
    head: git(src, "rev-parse", "HEAD"),
    branch: git(src, "symbolic-ref", "HEAD"),
    index: git(src, "ls-files", "--stage"),
    staged: git(src, "diff", "--cached"),
    unstaged: git(src, "diff"),
  });
  const before = snapshot();
  const root = mkdtempSync(join(tmpdir(), "odw-diff-run-"));
  try {
    const { id, state, store } = await runFlow({
      root,
      source: src,
      args: { kept: { write: { "a.txt": "a, kept\n" } }, plain: { write: { "c.txt": "c\n" } } },
      body:
        "return await parallel([\n" +
        "  () => agent('EDITS: ' + JSON.stringify(args.kept), { isolation: 'worktree', label: 'Fix: Auth!', keep: true }),\n" +
        "  () => agent('EDITS: ' + JSON.stringify(args.plain), { isolation: 'worktree', label: 'plain' }),\n" +
        "  () => agent('EDITS: {}', { isolation: 'worktree', label: 'idle', keep: true }),\n" +
        "])\n",
    });
    assert.equal(state, "done");
    const branch = `odw/${id}/1-fix-auth`;
    assert.equal(branchName(id, 1, "Fix: Auth!"), branch);
    assert.equal(git(src, "branch", "--list", "odw/*", "--format=%(refname:short)"), `${branch}\n`, "only an agent with keep that changed something");
    const [author, committer, subject, , body] = git(src, "log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%s%n%n%b", branch).split("\n");
    assert.equal(author, "odw <odw@localhost>");
    assert.equal(committer, "odw <odw@localhost>");
    assert.equal(subject, "Fix: Auth!");
    assert.equal(body, `odw run ${id}, agent 1`);
    assert.equal(git(src, "rev-parse", `${branch}~1`), before.head, "on top of the commit the agent started from");
    assert.equal(git(src, "diff", "--name-status", before.head.trim(), branch), "M\ta.txt\n");
    assert.equal(git(src, "show", `${branch}:a.txt`), "a, kept\n");
    assert.equal(readFileSync(store.agentDiffPath(id, 1), "utf8"), git(src, ...DIFF_FLAGS, `${branch}~1`, branch), "the branch holds exactly the diff");

    assert.equal(terminal(store, id, 1).branch, branch);
    assert.equal(store.readAgentResult(id, 1)?.branch, branch);
    assert.deepEqual(
      detail(store, id).agents.map((a) => [a.label, a.changes?.files ?? 0, a.branch]),
      [
        ["Fix: Auth!", 1, branch],
        ["plain", 1, null],
        ["idle", 0, null],
      ],
    );
    assert.deepEqual(snapshot(), before, "HEAD, the current branch, the index and the work in progress are untouched");
  } finally {
    cleanup(root, src);
  }
});

test("keepBranches keeps every isolated agent's change on a branch; keep: false opts one out", async () => {
  const src = makeRepo({ "a.txt": "a\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-diff-run-"));
  try {
    const { id, state, store } = await runFlow({
      root,
      source: src,
      config: { keepBranches: true },
      args: { one: { write: { "one.txt": "1\n" } }, two: { write: { "two.txt": "2\n" } } },
      body:
        "return await parallel([\n" +
        "  () => agent('EDITS: ' + JSON.stringify(args.one), { isolation: 'worktree', label: 'one' }),\n" +
        "  () => agent('EDITS: ' + JSON.stringify(args.two), { isolation: 'worktree', label: 'two', keep: false }),\n" +
        "])\n",
    });
    assert.equal(state, "done");
    assert.equal(git(src, "branch", "--list", "odw/*", "--format=%(refname:short)"), `odw/${id}/1-one\n`);
    assert.deepEqual([terminal(store, id, 1).branch, terminal(store, id, 2).branch], [`odw/${id}/1-one`, null]);
  } finally {
    cleanup(root, src);
  }
});

test("a failed agent's change is kept too, and a resumed run brings a replayed agent's diff along", async () => {
  const src = makeRepo({ "a.txt": "a\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-diff-run-"));
  const flow = {
    source: src,
    args: { good: { write: { "a.txt": "a, good\n" } }, bad: { write: { "b.txt": "half done\n" }, exit: 3 } },
    body:
      "const good = await agent('EDITS: ' + JSON.stringify(args.good), { isolation: 'worktree', label: 'good', keep: true })\n" +
      "await agent('EDITS: ' + JSON.stringify(args.bad), { isolation: 'worktree', label: 'bad' }).catch(() => null)\n" +
      "return good\n",
  };
  try {
    const first = await runFlow({ root, ...flow });
    assert.equal(first.state, "done");
    const failed = terminal(first.store, first.id, 2);
    assert.equal(failed.type, "agent_failed");
    assert.deepEqual(failed.changes, { files: 1, insertions: 1, deletions: 0, truncated: false });
    assert.match(readFileSync(first.store.agentDiffPath(first.id, 2), "utf8"), /^\+half done$/m);
    const bad = detail(first.store, first.id).agents[1]!;
    assert.deepEqual([bad.state, bad.changes?.files], ["failed", 1]);

    const second = await runFlow({ root, ...flow, resumedFrom: { runId: first.id, dir: first.store.runDir(first.id) } });
    assert.equal(second.state, "done");
    const replayed = terminal(second.store, second.id, 1);
    assert.equal(replayed.cached, true);
    assert.deepEqual(replayed.changes, { files: 1, insertions: 1, deletions: 1, truncated: false });
    assert.equal(replayed.branch, `odw/${first.id}/1-good`, "the branch the source run kept it on");
    assert.equal(
      readFileSync(second.store.agentDiffPath(second.id, 1), "utf8"),
      readFileSync(first.store.agentDiffPath(first.id, 1), "utf8"),
      "the replayed agent's diff is in the new run too",
    );
    assert.deepEqual(second.store.readAgentResult(second.id, 1)?.changes, replayed.changes);
  } finally {
    cleanup(root, src);
  }
});

test("every capture writes its whole diff, however quickly git finishes", async () => {
  // Node drains a child's output nobody reads once it exits: a capture must read from the start.
  const src = makeRepo({ "a.txt": "a\n" });
  const out = mkdtempSync(join(tmpdir(), "odw-diff-out-"));
  try {
    for (let n = 1; n <= 6; n++) {
      const path = join(out, `${n}.diff`);
      const captured = await withWorkspace(src, "worktree", async (ws) => {
        writeFileSync(join(ws.path, `f${n}.txt`), "x\n");
        return ws.captureChanges({ path, maxDiffBytes: 1 << 20 });
      });
      assert.deepEqual(captured?.changes, { files: 1, insertions: 1, deletions: 0, truncated: false });
      assert.match(readFileSync(path, "utf8"), new RegExp(`^diff --git a/f${n}\\.txt b/f${n}\\.txt\\n[^]*^\\+x\\n$`, "m"), `capture ${n}`);
    }
    // Nothing changed: no diff, and no file.
    const none = join(out, "none.diff");
    assert.equal(await withWorkspace(src, "worktree", (ws) => ws.captureChanges({ path: none, maxDiffBytes: 1 << 20 })), null);
    assert.equal(existsSync(none), false);
    assert.equal(await withWorkspace(src, "inplace", (ws) => ws.captureChanges({ path: none, maxDiffBytes: 1 })), null);
  } finally {
    cleanup(out, src);
  }
});

// --- one call, several CLI runs ------------------------------------------------------

const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 });

/** A config whose default adapter replies in plain text (the runner is faked: its command never runs). */
function textConfig() {
  const cfg = defaultConfig();
  cfg.adapters.text = { name: "text", command: ["agent"] };
  cfg.settings.defaultAdapter = "text";
  return cfg;
}

const SCHEMA = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };

test("a schema retry that only reformats keeps the change of the attempt that did the work; one that edits replaces it", async () => {
  const src = makeRepo({ "a.txt": "a\n" });
  const dir = mkdtempSync(join(tmpdir(), "odw-diff-keep-"));
  const recorder = (name: string) =>
    new ChangeRecorder({ path: join(dir, name), maxDiffBytes: 1 << 20, branch: null, message: "m" });
  try {
    let calls = 0;
    const reformat = new Bridge(textConfig(), {
      source: src,
      runner: async (_command, options) => {
        // The work, with a reply that is not JSON; then the same answer as JSON, and no edit.
        if (++calls === 1) writeFileSync(join(options!.cwd!, "work.txt"), "the work\n");
        return ok(calls === 1 ? "done: n is one" : '{"n": 1}');
      },
    });
    const first = recorder("1.diff");
    const out = await reformat.run({ prompt: "x", schema: SCHEMA, isolation: "worktree" }, { changes: first });
    assert.deepEqual([out.value, out.attempts], [{ n: 1 }, 2]);
    assert.deepEqual(await first.settle(), { changes: { files: 1, insertions: 1, deletions: 0, truncated: false }, branch: null });
    assert.match(readFileSync(join(dir, "1.diff"), "utf8"), /^\+\+\+ b\/work\.txt$/m);

    calls = 0;
    const redo = new Bridge(textConfig(), {
      source: src,
      runner: async (_command, options) => {
        writeFileSync(join(options!.cwd!, ++calls === 1 ? "first.txt" : "second.txt"), "x\n");
        return ok(calls === 1 ? "not json" : '{"n": 2}');
      },
    });
    const second = recorder("2.diff");
    await redo.run({ prompt: "y", schema: SCHEMA, isolation: "worktree" }, { changes: second });
    await second.settle();
    const text = readFileSync(join(dir, "2.diff"), "utf8");
    assert.match(text, /second\.txt/);
    assert.doesNotMatch(text, /first\.txt/, "the retry redid the work: its change replaces the first");
    assert.deepEqual(readdirSync(dir).sort(), ["1.diff", "2.diff"], "no scratch diff left behind");
  } finally {
    cleanup(dir, src);
  }
});

test("a rate-limit retry redoes the work, so only its change is kept; a stop keeps nothing", async () => {
  const src = makeRepo({ "a.txt": "a\n" });
  const dir = mkdtempSync(join(tmpdir(), "odw-diff-keep-"));
  try {
    let calls = 0;
    const bridge = new Bridge(textConfig(), {
      source: src,
      sleep: async () => {},
      random: () => 0,
      runner: async (_command, options) => {
        writeFileSync(join(options!.cwd!, ++calls === 1 ? "partial.txt" : "final.txt"), "x\n");
        if (calls === 1) {
          return { returncode: 1, stdout: "", stderr: "ERROR: last status: 429 Too Many Requests", timedOut: false, duration: 0.01 };
        }
        return ok("done");
      },
    });
    const recorder = new ChangeRecorder({ path: join(dir, "1.diff"), maxDiffBytes: 1 << 20, branch: null, message: "m" });
    assert.equal((await bridge.run({ prompt: "x", isolation: "worktree" }, { changes: recorder })).value, "done");
    assert.equal(calls, 2);
    assert.equal((await recorder.settle())?.changes.files, 1);
    const text = readFileSync(join(dir, "1.diff"), "utf8");
    assert.match(text, /final\.txt/);
    assert.doesNotMatch(text, /partial\.txt/);

    const controller = new AbortController();
    const stopped = new Bridge(textConfig(), {
      source: src,
      runner: async (_command, options) => {
        writeFileSync(join(options!.cwd!, "stopped.txt"), "x\n");
        controller.abort(new RunStopped("run was stopped"));
        return { returncode: 143, stdout: "", stderr: "", timedOut: false, duration: 0.01 };
      },
    });
    const kept = new ChangeRecorder({
      path: join(dir, "2.diff"),
      maxDiffBytes: 1 << 20,
      branch: null,
      message: "m",
      signal: controller.signal,
    });
    await assert.rejects(
      stopped.run({ prompt: "y", isolation: "worktree" }, { signal: controller.signal, changes: kept }),
      RunStopped,
    );
    await kept.discard();
    assert.deepEqual(readdirSync(dir), ["1.diff"], "nothing kept of the stopped call");
    assert.equal(worktrees(src), 1);
  } finally {
    cleanup(dir, src);
  }
});

test("maxDiffBytes and keepBranches load, default, and reject malformed values", () => {
  const defaults = defaultConfig().settings;
  assert.equal(defaults.maxDiffBytes, 2 * 1024 * 1024);
  assert.equal(defaults.keepBranches, false);
  const example = loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true }).settings;
  assert.equal(example.maxDiffBytes, 2 * 1024 * 1024);
  assert.equal(example.keepBranches, false);
  assert.deepEqual(collectConfigWarnings({ maxDiffBytes: 1, keepBranches: true }), []);

  const dir = mkdtempSync(join(tmpdir(), "odw-diff-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    const load = (raw: Record<string, unknown>) => {
      writeFileSync(p, JSON.stringify(raw));
      return loadConfig(p, { quiet: true }).settings;
    };
    const loaded = load({ maxDiffBytes: 4096, keepBranches: true });
    assert.deepEqual([loaded.maxDiffBytes, loaded.keepBranches], [4096, true]);
    assert.deepEqual([load({ maxDiffBytes: null, keepBranches: null }).maxDiffBytes, load({}).keepBranches], [2 * 1024 * 1024, false]);
    for (const bad of [0, -1, 1.5, "big"]) {
      assert.throws(() => load({ maxDiffBytes: bad }), /"maxDiffBytes" must be a positive whole number of bytes/);
    }
    for (const bad of ["yes", 1, []]) {
      assert.throws(() => load({ keepBranches: bad }), /"keepBranches" must be true or false/);
    }
  } finally {
    cleanup(dir);
  }
});
