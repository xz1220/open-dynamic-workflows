import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { captureChanges } from "../src/changes.js";
import { main } from "../src/cli.js";
import { RunStore } from "../src/runtime/run-store.js";

// odw apply's preview (clean / CONFLICT with its lines / already applied),
// --all, and --verify with its rollback (ODW extensions), over real git
// repositories. Each agent's diff is what ODW keeps: captured by
// captureChanges from a real worktree of the repository.

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

const commit = (dir: string, message: string): string =>
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", message);

/** `n` numbered lines, with some of them replaced. */
const lines = (n: number, change: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

/** Run the CLI in `cwd`, capturing what it prints. */
async function cli(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
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

/** What a path holds: text, bytes, or a symlink to `link`. */
type Content = string | Buffer | { link: string };

function put(full: string | Buffer, data: Content): void {
  if (typeof full === "string") mkdirSync(dirname(full), { recursive: true });
  rmSync(full, { force: true });
  if (typeof data === "object" && !Buffer.isBuffer(data)) symlinkSync(data.link, full);
  else writeFileSync(full, data);
}

/** `name` under `root`; a "latin1:" name (top level only) is spelled in Latin-1 bytes, which are not UTF-8. */
function at(root: string, name: string): string | Buffer {
  if (!name.startsWith("latin1:")) return join(root, name);
  return Buffer.concat([Buffer.from(`${root}/`), Buffer.from(name.slice("latin1:".length), "latin1")]);
}

interface AgentSpec {
  label: string;
  /** Path → what the agent leaves there; null deletes it. */
  edit: Record<string, Content | null>;
  /** Paths it makes executable. */
  exec?: string[];
  state?: "done" | "failed";
  /** Cut its kept diff at this many bytes (default 2 MB). */
  maxDiffBytes?: number;
}

interface Fixture {
  root: string;
  repo: string;
  store: RunStore;
  runId: string;
  /** --runs-root, and a --config of its own (no developer config leaks in). */
  flags: string[];
  config: string;
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A repository holding `files` (committed), and a run whose isolated agents
 * each made their `edit` in a worktree of that commit and kept its diff.
 */
async function setup(files: Record<string, Content>, agents: AgentSpec[], config: Record<string, unknown> = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "odw-apply-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  for (const [path, data] of Object.entries(files)) put(at(repo, path), data);
  git(repo, "add", "-A");
  commit(repo, "init");
  const base = git(repo, "rev-parse", "HEAD").trim();
  const store = new RunStore(join(root, "runs"));
  const runId = store.create({ script: join(root, "wf.js"), args: null, source: repo });
  store.updateStatus(runId, { state: "done", name: "wf" });
  for (const [i, spec] of agents.entries()) {
    const agentId = i + 1;
    const work = join(root, `wt-${agentId}`);
    git(repo, "worktree", "add", "-q", "--detach", work, base);
    for (const [path, data] of Object.entries(spec.edit)) {
      if (data === null) rmSync(at(work, path));
      else put(at(work, path), data);
    }
    for (const path of spec.exec ?? []) chmodSync(join(work, path), 0o755);
    const diff = store.agentDiffPath(runId, agentId);
    mkdirSync(dirname(diff), { recursive: true });
    const scratch = mkdtempSync(join(root, "scratch-"));
    const maxDiffBytes = spec.maxDiffBytes ?? 1 << 21;
    const kept = await captureChanges({ top: repo, work, base, scratch }, { paths: new Map(), ignoredDirs: [] }, { path: diff, maxDiffBytes });
    git(repo, "worktree", "remove", "--force", work);
    const fields = { agentId, label: spec.label, phase: null, adapter: "edit" };
    appendFileSync(store.eventsPath(runId), JSON.stringify({ ts: agentId * 10, type: "agent_started", ...fields }) + "\n");
    const settled =
      spec.state === "failed"
        ? { type: "agent_failed", error: "timed out", reason: "timeout", changes: kept?.changes ?? null, branch: null }
        : { type: "agent_finished", attempts: 1, changes: kept?.changes ?? null, branch: null };
    appendFileSync(store.eventsPath(runId), JSON.stringify({ ts: agentId * 10 + 5, ...fields, ...settled }) + "\n");
  }
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { root, repo, store, runId, flags: ["--runs-root", store.root, "--config", configPath], config: configPath };
}

/**
 * Everything a rollback must put back: git's status, the index (every stage),
 * both diffs, and every file's bytes and mode, link and directory in the tree.
 */
function snapshot(repo: string): string {
  const tree: string[] = [];
  // By bytes: a name need not be UTF-8.
  const walk = (dir: Buffer, rel: string): void => {
    for (const bytes of readdirSync(dir, { encoding: "buffer" }).sort(Buffer.compare)) {
      const name = bytes.toString("latin1");
      if (rel === "" && name === ".git") continue;
      const full = Buffer.concat([dir, Buffer.from("/"), bytes]);
      const path = rel ? `${rel}/${name}` : name;
      const info = lstatSync(full);
      if (info.isDirectory()) {
        tree.push(`dir  ${path}`);
        walk(full, path);
      } else if (info.isSymbolicLink()) {
        tree.push(`link ${path} -> ${readlinkSync(full)}`);
      } else {
        const hash = createHash("sha1").update(readFileSync(full)).digest("hex");
        tree.push(`file ${path} ${(info.mode & 0o777).toString(8)} ${hash}`);
      }
    }
  };
  walk(Buffer.from(repo), "");
  return [
    git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    git(repo, "ls-files", "--stage"),
    // Tags: lowercase for assume-unchanged, S for skip-worktree.
    git(repo, "ls-files", "-v"),
    git(repo, "diff"),
    git(repo, "diff", "--cached"),
    tree.join("\n"),
  ].join("\n--\n");
}

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the preview says, file by file, what applies cleanly, what conflicts (with its lines) and what is applied already", async () => {
  const fx = await setup({ "a.txt": lines(10), "c.txt": "c1\nc2\nc3\n", "d.txt": "d\n", "keep.txt": "keep\n" }, [
    { label: "mixed", edit: { "a.txt": lines(10, { 10: "TEN" }), "c.txt": "c1 agent\nc2\nc3\n", "new.txt": "new\n", "d.txt": null } },
  ]);
  const { repo } = fx;
  // The user changed the line the agent changed, made the same new file, and deleted the same file.
  writeFileSync(join(repo, "c.txt"), "c1 user\nc2\nc3\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  rmSync(join(repo, "d.txt"));
  git(repo, "add", "-A");
  commit(repo, "user");
  const head = git(repo, "rev-parse", "HEAD");

  const check = await cli(["apply", fx.runId, "--agent", "mixed", "--check", ...fx.flags], repo);
  assert.equal(check.code, 1, "a conflict: --check exits 1");
  assert.equal(
    plain(check.out),
    `agent 1 (mixed) of run ${fx.runId} would apply with 1 conflict(s) to ${realpathSync(repo)}:\n` +
      "  M a.txt    clean\n" +
      "  M c.txt    CONFLICT\n" +
      "      at line 1:\n" +
      "      <<<<<<< ours\n" +
      "      c1 user\n" +
      "      =======\n" +
      "      c1 agent\n" +
      "      >>>>>>> theirs\n" +
      "  D d.txt    already applied\n" +
      "  A new.txt  already applied\n" +
      "  (ours: what this tree holds · theirs: the agent's change)\n",
  );
  assert.equal(git(repo, "status", "--porcelain"), "", "a check changes nothing");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);

  // Applied, the clean file is staged, the conflict is left marked where the preview said, and the rest is untouched.
  const applied = await cli(["apply", fx.runId, "--agent", "1", ...fx.flags], repo);
  assert.equal(applied.code, 1);
  assert.match(applied.out, /\n1 file\(s\) conflicted: resolve the <<<<<<< markers, then git add them\n$/);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), lines(10, { 10: "TEN" }));
  assert.equal(readFileSync(join(repo, "c.txt"), "utf8"), "<<<<<<< ours\nc1 user\n=======\nc1 agent\n>>>>>>> theirs\nc2\nc3\n");
  assert.equal(git(repo, "status", "--porcelain"), "M  a.txt\nUU c.txt\n");
});

test("a change the tree holds already is reported so, and applying it changes nothing", async () => {
  const fx = await setup({ "a.txt": lines(10), "b.txt": "b\n" }, [
    { label: "done", edit: { "a.txt": lines(10, { 1: "ONE" }), "z.txt": "z\n", "b.txt": null } },
  ]);
  const { repo } = fx;
  writeFileSync(join(repo, "a.txt"), lines(10, { 1: "ONE" }));
  writeFileSync(join(repo, "z.txt"), "z\n");
  rmSync(join(repo, "b.txt"));
  git(repo, "add", "-A");
  commit(repo, "merged the agent's work by hand");

  const preview = `agent 1 (done) of run ${fx.runId} is already applied to ${realpathSync(repo)}:\n  M a.txt  already applied\n  D b.txt  already applied\n  A z.txt  already applied\n`;
  const check = await cli(["apply", fx.runId, "--agent", "done", "--check", ...fx.flags], repo);
  assert.deepEqual([check.code, plain(check.out)], [0, preview]);
  const applied = await cli(["apply", fx.runId, "--agent", "done", "--verify", "exit 1", ...fx.flags], repo);
  assert.deepEqual([applied.code, plain(applied.out), applied.err], [0, preview, ""], "nothing to apply, so nothing to verify");
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("a diff git refuses as a whole — a file it changed is deleted here — is previewed file by file and changes nothing", async () => {
  const fx = await setup({ "a.txt": lines(10), "b.txt": lines(10) }, [
    { label: "both", edit: { "a.txt": lines(10, { 2: "two" }), "b.txt": lines(10, { 3: "three" }) } },
  ]);
  const { repo } = fx;
  git(repo, "rm", "-q", "b.txt");
  commit(repo, "user deletes b");

  const check = await cli(["apply", fx.runId, "--agent", "both", "--check", ...fx.flags], repo);
  assert.equal(check.code, 1);
  assert.equal(
    plain(check.out),
    `agent 1 (both) of run ${fx.runId} cannot be applied to ${realpathSync(repo)}:\n` +
      "  M a.txt  clean\n" +
      "  M b.txt  CONFLICT (deleted here)\n",
  );
  const applied = await cli(["apply", fx.runId, "--agent", "both", ...fx.flags], repo);
  assert.equal(applied.code, 1);
  assert.match(applied.err, /^odw apply: agent 1 \(both\) of run .* cannot be applied, so nothing was changed:\n {2}error: b\.txt: .*\n$/);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("a binary file both sides changed is a conflict with no lines to show", async () => {
  const fx = await setup({ "img.bin": Buffer.from([0, 1, 2, 3]), "a.txt": "a\n" }, [
    { label: "bin", edit: { "img.bin": Buffer.from([0, 9, 9, 9]) } },
  ]);
  writeFileSync(join(fx.repo, "img.bin"), Buffer.from([0, 7, 7, 7]));
  git(fx.repo, "add", "-A");
  commit(fx.repo, "user changes the image");
  const check = await cli(["apply", fx.runId, "--agent", "bin", "--check", ...fx.flags], fx.repo);
  assert.equal(check.code, 1);
  assert.match(plain(check.out), /\n {2}M img\.bin {2}CONFLICT \(binary: changed on both sides\)\n$/);
});

test("what stands where a diff creates a file is never written over: the diff cannot be applied, and nothing changes", async () => {
  const fx = await setup({ "a.txt": lines(20), "c.txt": lines(20) }, [
    // A rename with edits merges from its old path: git would write the result over whatever is at the new one.
    { label: "onto-tracked", edit: { "a.txt": null, "b.txt": lines(20, { 20: "moved" }) } },
    { label: "onto-ignored", edit: { "c.txt": null, "secret.txt": lines(20, { 20: "moved" }) } },
    { label: "add-ignored", edit: { "secret2.txt": "the agent's\n" } },
    { label: "file-in-the-way", edit: { "dir/x.txt": "x\n" } },
    { label: "add-untracked", edit: { "u.txt": "the agent's u\n" } },
  ]);
  const { repo } = fx;
  // Since the agents ran, the user committed a b.txt of their own, keeps two files git ignores, and made a file "dir".
  writeFileSync(join(repo, "b.txt"), "the user's b\n");
  writeFileSync(join(repo, ".gitignore"), "secret.txt\nsecret2.txt\n");
  git(repo, "add", "b.txt", ".gitignore");
  commit(repo, "the user's b.txt");
  writeFileSync(join(repo, "secret.txt"), "the user's secret\n");
  writeFileSync(join(repo, "secret2.txt"), "the user's other secret\n");
  writeFileSync(join(repo, "dir"), "a file where the agent made a directory\n");
  const before = snapshot(repo);
  const expect = async (agent: string, line: RegExp): Promise<void> => {
    const r = await cli(["apply", fx.runId, "--agent", agent, ...fx.flags], repo);
    assert.equal(r.code, 1, agent);
    assert.match(plain(r.out), new RegExp(`^agent \\d \\(${agent}\\) of run .* cannot be applied to [^\\n]*:\\n`), agent);
    assert.match(plain(r.out), line, agent);
    assert.match(r.err, /cannot be applied, so nothing was changed:\n/, agent);
    assert.equal(snapshot(repo), before, agent);
  };
  await expect("onto-tracked", /\n {2}R a\.txt → b\.txt {2}CONFLICT \(renamed onto a file that exists here\)\n/);
  await expect("onto-ignored", /\n {2}R c\.txt → secret\.txt {2}CONFLICT \(a file git does not track is in the way\)\n/);
  await expect("add-ignored", /\n {2}A secret2\.txt {2}CONFLICT \(a file git does not track is in the way\)\n/);
  await expect("file-in-the-way", /\n {2}A dir\/x\.txt {2}CONFLICT \(dir is a file here, where the diff needs a directory\)\n/);
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "the user's b\n");
  assert.equal(readFileSync(join(repo, "secret.txt"), "utf8"), "the user's secret\n");

  // An untracked file where one is created is uncommitted work in the way; --force goes no further, and says what stands there.
  writeFileSync(join(repo, "u.txt"), "the user's untracked u\n");
  const refused = await cli(["apply", fx.runId, "--agent", "add-untracked", ...fx.flags], repo);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /uncommitted changes in the way of the diff agent 5 \(add-untracked\) .*\n {2}u\.txt \(untracked\)\n$/);
  const forced = await cli(["apply", fx.runId, "--agent", "add-untracked", "--force", ...fx.flags], repo);
  assert.equal(forced.code, 1);
  assert.match(plain(forced.out), /\n {2}A u\.txt {2}CONFLICT \(a file git does not track is in the way\)\n$/);
  assert.match(forced.err, /cannot be applied, so nothing was changed:\n {2}u\.txt: a file git does not track is in the way\n {2}uncommitted changes that are not staged in u\.txt\n$/);
  assert.equal(readFileSync(join(repo, "u.txt"), "utf8"), "the user's untracked u\n");
});

test("--all: a rename onto a file an agent before it adds stops the stack there", async () => {
  const fx = await setup({ "a.txt": lines(20) }, [
    { label: "adds-b", edit: { "b.txt": "b, by the first agent\n" } },
    { label: "renames-a-to-b", edit: { "a.txt": null, "b.txt": lines(20, { 20: "moved" }) } },
  ]);
  const r = await cli(["apply", fx.runId, "--all", ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  assert.match(plain(r.out), /\nagent 2 \(renames-a-to-b\) cannot be applied:\n {2}R a\.txt → b\.txt {2}CONFLICT \(renamed onto a file that exists here\)\n/);
  assert.match(plain(r.out), /\nnot applied: agent 2 \(renames-a-to-b\) — stopped at agent 2 \(renames-a-to-b\): it cannot be applied\n$/);
  assert.equal(readFileSync(join(fx.repo, "b.txt"), "utf8"), "b, by the first agent\n", "the first agent's file stands");
  assert.equal(git(fx.repo, "status", "--porcelain"), "A  b.txt\n");
});

test("when git gives up halfway through writing the tree, what it wrote is put back — without --verify too", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const fx = await setup({ "a.txt": lines(10), "ro/keep.txt": "keep\n" }, [
    { label: "half", edit: { "a.txt": lines(10, { 10: "TEN" }), "ro/new.txt": "new\n" } },
  ]);
  const ro = join(fx.repo, "ro");
  chmodSync(ro, 0o555); // git can rewrite a.txt, but cannot create ro/new.txt
  try {
    const before = snapshot(fx.repo);
    const r = await cli(["apply", fx.runId, "--agent", "half", ...fx.flags], fx.repo);
    assert.equal(r.code, 1);
    assert.match(r.err, /^odw apply: git could not apply the diff agent 1 \(half\) of run .*; nothing was changed:\n {2}(error|fatal): /);
    assert.equal(snapshot(fx.repo), before, "a.txt as it was");
  } finally {
    chmodSync(ro, 0o755);
  }
});

test("a type change the tree holds already is applied already, both halves of it", async () => {
  const fx = await setup({ "a.txt": "a\n", "l": "a file\n" }, [{ label: "to-link", edit: { l: { link: "a.txt" } } }]);
  put(join(fx.repo, "l"), { link: "a.txt" });
  git(fx.repo, "add", "-A");
  commit(fx.repo, "the same type change");
  const r = await cli(["apply", fx.runId, "--agent", "to-link", "--check", ...fx.flags], fx.repo);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(plain(r.out), `agent 1 (to-link) of run ${fx.runId} is already applied to ${realpathSync(fx.repo)}:\n  D l  already applied\n  A l  already applied\n`);
});

test("a path that is not UTF-8 is refused before anything is looked up by it", { skip: process.platform !== "linux" }, async () => {
  const fx = await setup({ "latin1:café.txt": lines(10) }, [{ label: "latin1", edit: { "latin1:café.txt": lines(10, { 1: "ONE" }) } }]);
  const before = snapshot(fx.repo);
  const r = await cli(["apply", fx.runId, "--agent", "latin1", "--verify", "true", ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  assert.match(plain(r.out), /cannot be applied to [^\n]*:\n {2}M caf�\.txt {2}CONFLICT \(its path is not UTF-8, which odw cannot apply \(git apply --3way can\)\)\n/);
  assert.equal(snapshot(fx.repo), before);
});

test("an empty directory a created file took the place of comes back with the rollback", async () => {
  const fx = await setup({ "a.txt": "a\n" }, [{ label: "x", edit: { x: "a file\n" } }]);
  mkdirSync(join(fx.repo, "x"));
  const before = snapshot(fx.repo);
  assert.match(before, /\ndir {2}x(\n|$)/);
  const r = await cli(["apply", fx.runId, "--agent", "x", "--verify", "test -f x && exit 1", ...fx.flags], fx.repo);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /`test -f x && exit 1` exited with code 1/, "the file was in place while the command ran");
  assert.equal(snapshot(fx.repo), before);
});

/** Agents that edit one file in turn — the third clashes with the first — and one more after them. */
function stackAgents(): AgentSpec[] {
  return [
    { label: "one", edit: { "s.txt": lines(30, { 2: "line 2 by one" }) } },
    { label: "two", edit: { "s.txt": lines(30, { 28: "line 28 by two" }) } },
    { label: "three", edit: { "s.txt": lines(30, { 2: "line 2 by three", 15: "line 15 by three" }) } },
    // Clashes with three, not with one or two: previewed without three, it applies cleanly.
    { label: "four", edit: { "s.txt": lines(30, { 15: "line 15 by four" }), "t.txt": "t by four\n" } },
    { label: "broken", edit: { "u.txt": "half done\n" }, state: "failed" },
  ];
}

test("--all --check previews every finished agent stacked in order; one that would conflict is left out of the stack", async () => {
  const fx = await setup({ "s.txt": lines(30), "t.txt": "t\n", "u.txt": "u\n" }, stackAgents());
  const before = snapshot(fx.repo);
  const check = await cli(["apply", fx.runId, "--all", "--check", ...fx.flags], fx.repo);
  assert.equal(check.code, 1, "something would conflict");
  assert.equal(
    plain(check.out),
    `previewing 4 agent(s) of run ${fx.runId} against ${realpathSync(fx.repo)}, each on top of the ones before it:\n` +
      "agent 1 (one) applies cleanly:\n  M s.txt  clean\n" +
      "agent 2 (two) applies cleanly:\n  M s.txt  clean\n" +
      "agent 3 (three) would apply with 1 conflict(s):\n" +
      "  M s.txt  CONFLICT\n" +
      "      at line 2:\n" +
      "      <<<<<<< ours\n      line 2 by one\n      =======\n      line 2 by three\n      >>>>>>> theirs\n" +
      "  (ours: what this tree holds · theirs: the agent's change)\n" +
      "agent 4 (four) applies cleanly:\n  M s.txt  clean\n  M t.txt  clean\n",
  );
  assert.equal(
    check.err,
    "odw apply: --all leaves out agent 5 (broken), which failed: apply its diff on its own with --agent 5\n",
    "a failed agent's diff is unfinished work",
  );
  assert.equal(snapshot(fx.repo), before, "a check changes nothing");
});

test("--all applies the agents in agentId order and stops before the first that would conflict", async () => {
  const fx = await setup({ "s.txt": lines(30), "t.txt": "t\n", "u.txt": "u\n" }, stackAgents());
  // Uncommitted work in a path the agents touch: nothing is applied, and the message says whose.
  writeFileSync(join(fx.repo, "t.txt"), "t, mine\n");
  const blocked = await cli(["apply", fx.runId, "--all", ...fx.flags], fx.repo);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /odw apply: uncommitted changes in the way of the diffs — commit or stash them, or pass --force:\n {2}t\.txt \(changed, not staged\) — agent 4 \(four\)\n$/);
  assert.equal(blocked.out, "");
  git(fx.repo, "checkout", "--", "t.txt");

  const applied = await cli(["apply", fx.runId, "--all", ...fx.flags], fx.repo);
  assert.equal(applied.code, 1);
  const report = plain(applied.out);
  assert.ok(report.startsWith(`previewing 4 agent(s) of run ${fx.runId}`), report);
  assert.ok(
    report.endsWith(
      `applied to ${realpathSync(fx.repo)} (staged, as git apply --3way does): agent 1 (one), agent 2 (two)\n` +
        "not applied: agent 3 (three), agent 4 (four) — stopped at agent 3 (three): it would conflict\n" +
        `  to apply it and resolve its conflicts by hand: commit what applied, then odw apply ${fx.runId} --agent 3\n`,
    ),
    report,
  );
  assert.equal(readFileSync(join(fx.repo, "s.txt"), "utf8"), lines(30, { 2: "line 2 by one", 28: "line 28 by two" }), "one, then two on top");
  assert.equal(git(fx.repo, "status", "--porcelain"), "M  s.txt\n", "staged; four and the failed agent untouched; no conflict left");

  // Once the first two are committed, --all finds them applied and stops at the same place.
  commit(fx.repo, "one and two");
  const again = await cli(["apply", fx.runId, "--all", ...fx.flags], fx.repo);
  assert.equal(again.code, 1);
  assert.match(plain(again.out), /\nagent 1 \(one\) is already applied:\n {2}M s\.txt {2}already applied\n/);
  assert.match(plain(again.out), /\nalready applied: agent 1 \(one\), agent 2 \(two\)\nnot applied: agent 3 \(three\), agent 4 \(four\)/);
});

test("--all stops at a diff cut at maxDiffBytes: it cannot be applied", async () => {
  const fx = await setup({ "a.txt": "a\n", "c.txt": "c\n" }, [
    { label: "small", edit: { "a.txt": "a, better\n" } },
    { label: "big", edit: { "big.txt": lines(200) }, maxDiffBytes: 512 },
    { label: "after", edit: { "c.txt": "c, better\n" } },
  ]);
  const hint = "  To keep the whole change next time, give the agent keep: true (or set keepBranches), or raise maxDiffBytes.\n";
  const check = await cli(["apply", fx.runId, "--all", "--check", ...fx.flags], fx.repo);
  assert.equal(check.code, 1);
  const literal = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(plain(check.out), new RegExp(`\nagent 2 \\(big\\) cannot be applied — its diff was cut at maxDiffBytes:\n {2}# odw: diff truncated at 512 bytes — .*\n${literal}agent 3 \\(after\\) applies cleanly:\n`));
  const applied = await cli(["apply", fx.runId, "--all", ...fx.flags], fx.repo);
  assert.equal(applied.code, 1);
  assert.ok(
    plain(applied.out).endsWith(
      `applied to ${realpathSync(fx.repo)} (staged, as git apply --3way does): agent 1 (small)\n` +
        `not applied: agent 2 (big), agent 3 (after) — stopped at agent 2 (big): its diff was cut at maxDiffBytes\n${hint}`,
    ),
    applied.out,
  );
  assert.equal(git(fx.repo, "status", "--porcelain"), "M  a.txt\n");
});

test("--verify keeps a change its command passes; it runs at the repository root, after each agent of --all", async () => {
  const fx = await setup({ "a.txt": lines(10), "b.txt": "b\n", "sub/x.txt": "x\n" }, [
    { label: "one", edit: { "a.txt": lines(10, { 10: "TEN" }) } },
    { label: "two", edit: { "b.txt": "b, better\n" } },
  ]);
  const sub = join(fx.repo, "sub");
  const single = await cli(["apply", fx.runId, "--agent", "one", "--verify", "grep -q TEN a.txt", ...fx.flags], sub);
  assert.equal(single.code, 0, single.err);
  assert.match(single.out, /\napplied agent 1 \(one\) of run .* \(staged, as git apply --3way does\)\nverified agent 1 \(one\) of run .*: `grep -q TEN a\.txt` passed in \d+\.\ds\n$/);
  assert.equal(single.err, `verifying agent 1 (one) of run ${fx.runId}: grep -q TEN a.txt\n`);
  assert.equal(git(fx.repo, "status", "--porcelain"), "M  a.txt\n", "the change stays, staged");
  commit(fx.repo, "one");

  const all = await cli(["apply", fx.runId, "--all", "--verify", "test -f a.txt && test -f b.txt", ...fx.flags], fx.repo);
  assert.equal(all.code, 0, all.err);
  assert.match(plain(all.out), /\nverified agent 2 \(two\): `test -f a\.txt && test -f b\.txt` passed in \d+\.\ds\n/);
  assert.match(plain(all.out), /\napplied to .* \(staged, as git apply --3way does\): agent 2 \(two\)\nalready applied: agent 1 \(one\)\n$/);
  assert.equal(all.err, "verifying agent 2 (two): test -f a.txt && test -f b.txt\n", "an agent already applied is not verified again");
  assert.equal(git(fx.repo, "status", "--porcelain"), "M  b.txt\n");
});

/**
 * A repository with uncommitted work of every kind, beside an agent whose
 * change touches 11 paths in every way: edits, a deletion, a rename, new files
 * in new directories (one with a space and a non-ASCII name), a new executable,
 * a mode change, a retargeted symlink and a new one.
 */
async function dirtyFixture(config: Record<string, unknown> = {}): Promise<Fixture> {
  const fx = await setup(
    {
      "a.txt": lines(10),
      "b.txt": "b\n",
      "c.txt": lines(20),
      "m.txt": lines(10),
      "run.sh": "#!/bin/sh\n",
      "link": { link: "a.txt" },
      "u.txt": "u\n",
      "s.txt": "s\n",
      "mm.txt": "mm\n",
      "deep/keep.txt": "keep\n",
    },
    [
      {
        label: "wide",
        edit: {
          "a.txt": lines(10, { 10: "TEN" }),
          "b.txt": null,
          "c.txt": null,
          "c2.txt": lines(20),
          "new/dir/x.txt": "x\n",
          "sp ace/ü.txt": "umlaut\n",
          "tool.sh": "#!/bin/sh\necho hi\n",
          "m.txt": lines(10, { 1: "ONE" }),
          "link": { link: "m.txt" },
          "newlink": { link: "a.txt" },
        },
        exec: ["tool.sh", "run.sh"],
      },
    ],
    config,
  );
  const { repo } = fx;
  // Index bits git apply drops on the entries it rewrites.
  git(repo, "update-index", "--assume-unchanged", "m.txt");
  git(repo, "update-index", "--skip-worktree", "run.sh");
  // Unrelated uncommitted work: unstaged, staged, staged then changed again, untracked.
  writeFileSync(join(repo, "u.txt"), "u, unstaged\n");
  writeFileSync(join(repo, "s.txt"), "s, staged\n");
  git(repo, "add", "s.txt");
  writeFileSync(join(repo, "mm.txt"), "mm, staged\n");
  git(repo, "add", "mm.txt");
  writeFileSync(join(repo, "mm.txt"), "mm, staged, then changed\n");
  writeFileSync(join(repo, "n.txt"), "untracked\n");
  writeFileSync(join(repo, "deep/n2.txt"), "untracked too\n");
  return fx;
}

test("--verify failure rolls the tree back exactly — the files it touched, the index, and the user's unrelated work", async () => {
  const fx = await dirtyFixture();
  const before = snapshot(fx.repo);
  // The command makes it worse before it fails: it edits a file the apply touched, and leaves its own file.
  const verify = "echo junk >> a.txt; echo log > verify.log; echo 'tests failed: 3' >&2; exit 3";
  const r = await cli(["apply", fx.runId, "--agent", "wide", "--verify", verify, ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  assert.match(r.out, /\napplied agent 1 \(wide\) of run .* \(staged, as git apply --3way does\)\n$/);
  assert.match(r.err, new RegExp(`verify failed for agent 1 \\(wide\\) of run ${fx.runId} — \`echo junk.*\` exited with code 3 after \\d+\\.\\ds; the end of its output:\n {2}tests failed: 3\n`));
  // The edit made after the apply is set aside, not lost.
  const aside = /\nodw apply: a\.txt changed while the verify ran; that version is kept in (\S+)\n/.exec(r.err);
  assert.ok(aside, r.err);
  assert.equal(readFileSync(join(aside[1]!, "a.txt"), "utf8"), `${lines(10, { 10: "TEN" })}junk\n`);
  rmSync(dirname(aside[1]!), { recursive: true, force: true });
  assert.match(r.err, /\nrolled back agent 1 \(wide\) of run .*: the 11 path\(s\) it touched are as they were before the apply\n$/);
  // What the command made itself is its own: everything else is exactly as before.
  assert.equal(readFileSync(join(fx.repo, "verify.log"), "utf8"), "log\n");
  rmSync(join(fx.repo, "verify.log"));
  assert.equal(snapshot(fx.repo), before);
  assert.ok(!existsSync(join(fx.repo, "new")), "the directories the apply made are gone");

  // Rolled back, the tree takes the same apply as before: the restored index entries are fresh.
  const again = await cli(["apply", fx.runId, "--agent", "wide", "--verify", "test -x tool.sh", ...fx.flags], fx.repo);
  assert.equal(again.code, 0, again.err);
  assert.equal(readlinkSync(join(fx.repo, "link")), "m.txt");
  assert.equal(readFileSync(join(fx.repo, "sp ace/ü.txt"), "utf8"), "umlaut\n");
});

test("--force with --verify: a failed verify puts the user's staged edit in a touched file back as it was", async () => {
  const fx = await dirtyFixture();
  const { repo } = fx;
  // An unstaged edit in a file the agent changed: --force does not go past it, and the preview says so.
  writeFileSync(join(repo, "a.txt"), lines(10, { 1: "user's one" }));
  const unstagedBefore = snapshot(repo);
  const unstaged = await cli(["apply", fx.runId, "--agent", "wide", "--force", "--verify", "true", ...fx.flags], repo);
  assert.equal(unstaged.code, 1);
  assert.match(
    plain(unstaged.out),
    /^agent 1 \(wide\) of run .* cannot be applied to [^\n]*:\n {2}M a\.txt +CONFLICT \(uncommitted changes here that are not staged\)\n/,
  );
  assert.match(unstaged.err, /agent 1 \(wide\) of run .* cannot be applied, so nothing was changed:\n {2}uncommitted changes that are not staged in a\.txt\n$/);
  assert.equal(snapshot(repo), unstagedBefore);

  // Staged — away from the agent's line, with more unstaged work elsewhere — it is an edit --force merges over.
  git(repo, "add", "a.txt");
  const marker = join(fx.root, "verified");
  const verify = `touch '${marker}'; exit 1`;
  const refused = await cli(["apply", fx.runId, "--agent", "wide", "--verify", verify, ...fx.flags], repo);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /uncommitted changes in the way of the diff agent 1 \(wide\) .* pass --force:\n {2}a\.txt \(staged\)\n$/);
  assert.ok(!existsSync(marker), "refused before anything ran");

  const before = snapshot(repo);
  const forced = await cli(["apply", fx.runId, "--agent", "wide", "--force", "--verify", verify, ...fx.flags], repo);
  assert.equal(forced.code, 1);
  assert.match(forced.err, /--force: applying over uncommitted changes in:\n {2}a\.txt \(staged\)\n/);
  assert.ok(existsSync(marker), "the verify ran on the merged result");
  assert.match(forced.err, /; it printed nothing\nrolled back agent 1 \(wide\) of run .*: the 11 path\(s\) it touched are as they were before the apply\n$/);
  assert.equal(snapshot(repo), before, "the staged edit, its index entry and everything else as before");

  // And a verify that passes keeps both edits, merged.
  const kept = await cli(["apply", fx.runId, "--agent", "wide", "--force", "--verify", "true", ...fx.flags], repo);
  assert.equal(kept.code, 0, kept.err);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), lines(10, { 1: "user's one", 10: "TEN" }));
});

test("a rollback puts index entries back whatever became of them; a path in the middle of a merge is never applied to", async () => {
  const fx = await setup({ "a.txt": lines(10), "b.txt": lines(10) }, [
    { label: "ab", edit: { "a.txt": lines(10, { 10: "TEN" }), "b.txt": lines(10, { 10: "TEN" }) } },
  ]);
  const { repo } = fx;
  const blob = (text: string): string =>
    execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
  const stages = (path: string): string =>
    `0 ${"0".repeat(40)}\t${path}\n` +
    [lines(10), lines(10, { 1: "ours" }), lines(10, { 1: "theirs" })].map((text, i) => `100644 ${blob(text)} ${i + 1}\t${path}\n`).join("");

  // The verify command leaves a touched path conflicted (stages 1–3) and another out of the index, then fails.
  const info = join(fx.root, "stages.txt");
  writeFileSync(info, stages("a.txt"));
  const before = snapshot(repo);
  const verify = `git update-index --index-info < '${info}' && git rm -q --cached b.txt && exit 1`;
  const r = await cli(["apply", fx.runId, "--agent", "ab", "--verify", verify, ...fx.flags], repo);
  assert.equal(r.code, 1);
  assert.match(r.err, /exited with code 1 after/);
  assert.equal(snapshot(repo), before, "a.txt's one entry and b.txt's are back, the stages gone");

  // b.txt carries a conflict the user is in the middle of resolving: --force or not, git will not apply to it.
  execFileSync("git", ["-C", repo, "update-index", "--index-info"], { input: stages("b.txt") });
  writeFileSync(join(repo, "b.txt"), "<<<<<<< ours\nmid-resolution\n");
  const merging = snapshot(repo);
  assert.match(merging, /100644 \w+ 3\tb\.txt/);
  const refused = await cli(["apply", fx.runId, "--agent", "ab", "--verify", "true", ...fx.flags], repo);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /uncommitted changes in the way .*\n {2}b\.txt \(unmerged\)\n$/);
  const forced = await cli(["apply", fx.runId, "--agent", "ab", "--force", "--verify", "true", ...fx.flags], repo);
  assert.equal(forced.code, 1);
  assert.match(forced.err, /agent 1 \(ab\) of run .* cannot be applied, so nothing was changed:\n {2}error: b\.txt: /);
  assert.equal(snapshot(repo), merging);
});

test("the applyVerify setting verifies every apply; --verify overrides it, --no-verify skips it, --check ignores it", async () => {
  const fx = await setup({ "a.txt": lines(10) }, [{ label: "one", edit: { "a.txt": lines(10, { 10: "TEN" }) } }], { applyVerify: "exit 7" });
  const { repo } = fx;
  const before = snapshot(repo);
  const failed = await cli(["apply", fx.runId, "--agent", "one", ...fx.flags], repo);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /`exit 7` exited with code 7/);
  assert.equal(snapshot(repo), before);

  const check = await cli(["apply", fx.runId, "--agent", "one", "--check", ...fx.flags], repo);
  assert.deepEqual([check.code, check.err], [0, ""], "a check applies nothing, so verifies nothing");

  const overridden = await cli(["apply", fx.runId, "--agent", "one", "--verify", "true", ...fx.flags], repo);
  assert.equal(overridden.code, 0, overridden.err);
  assert.match(overridden.out, /verified agent 1 \(one\) of run .*: `true` passed/);
  git(repo, "reset", "-q", "--hard");

  const skipped = await cli(["apply", fx.runId, "--agent", "one", "--no-verify", ...fx.flags], repo);
  assert.equal(skipped.code, 0, skipped.err);
  assert.doesNotMatch(skipped.out + skipped.err, /verif/);
  assert.equal(git(repo, "status", "--porcelain"), "M  a.txt\n");
});

test("--verify applies only a change that applies cleanly: one that would conflict is left alone", async () => {
  const fx = await setup({ "c.txt": "c1\nc2\n" }, [{ label: "clash", edit: { "c.txt": "c1 agent\nc2\n" } }]);
  writeFileSync(join(fx.repo, "c.txt"), "c1 user\nc2\n");
  git(fx.repo, "add", "-A");
  commit(fx.repo, "user");
  const r = await cli(["apply", fx.runId, "--agent", "clash", "--verify", "true", ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  assert.match(r.err, /agent 1 \(clash\) of run .* was not applied: it would conflict, and --verify takes only a change that applies cleanly/);
  assert.equal(git(fx.repo, "status", "--porcelain"), "", "no markers left");
});

test("a verify command that outlives the timeout setting fails, and its apply is rolled back", async () => {
  const fx = await setup({ "a.txt": lines(10) }, [{ label: "one", edit: { "a.txt": lines(10, { 10: "TEN" }) } }], { timeout: 1 });
  const before = snapshot(fx.repo);
  const r = await cli(["apply", fx.runId, "--agent", "one", "--verify", "sleep 30", ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  assert.match(r.err, /verify failed for agent 1 \(one\) of run .* — `sleep 30` timed out after 1s; it printed nothing\n/);
  assert.equal(snapshot(fx.repo), before);
});

test("--all with --verify keeps the agents that pass and stops at the first that fails, rolled back", async () => {
  const fx = await setup({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" }, [
    { label: "good", edit: { "a.txt": "a, better\n" } },
    { label: "bad", edit: { "b.txt": "b, broken\n", "nb/new.txt": "new\n" } },
    { label: "later", edit: { "c.txt": "c, better\n" } },
  ]);
  const verify = "! grep -q broken b.txt";
  const r = await cli(["apply", fx.runId, "--all", "--verify", verify, ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  assert.match(plain(r.out), /\nverified agent 1 \(good\): `! grep -q broken b\.txt` passed in \d+\.\ds\n/);
  assert.match(
    plain(r.out),
    new RegExp(
      `\napplied to .* \\(staged, as git apply --3way does\\): agent 1 \\(good\\)\n` +
        "not applied: agent 2 \\(bad\\), agent 3 \\(later\\) — stopped at agent 2 \\(bad\\): its verify failed\n$",
    ),
  );
  assert.match(r.err, /verify failed for agent 2 \(bad\) — `! grep -q broken b\.txt` exited with code 1/);
  assert.match(r.err, /\nrolled back agent 2 \(bad\): the 2 path\(s\) it touched are as they were before the apply\n$/);
  assert.equal(git(fx.repo, "status", "--porcelain=v1", "--untracked-files=all"), "M  a.txt\n", "good stays; bad is gone, its new directory too");
});

test("odw apply's usage: --agent or --all, not both; --verify with a command, not with --no-verify", async () => {
  const fx = await setup({ "a.txt": "a\n" }, [{ label: "one", edit: { "a.txt": "A\n" } }]);
  const usage = async (args: string[], message: RegExp): Promise<void> => {
    const r = await cli(["apply", fx.runId, ...args, ...fx.flags], fx.repo);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, message);
  };
  await usage(["--agent", "one", "--all"], /--agent and --all exclude each other/);
  await usage(["--agent", "one", "--verify", "true", "--no-verify"], /--verify and --no-verify exclude each other/);
  await usage(["--agent", "one", "--verify", " "], /--verify needs a command to run/);
  assert.equal(git(fx.repo, "status", "--porcelain"), "");

  const none = await setup({ "a.txt": "a\n" }, []);
  const empty = await cli(["apply", none.runId, "--all", ...none.flags], none.repo);
  assert.deepEqual([empty.code, empty.out], [0, ""]);
  assert.match(empty.err, /^run .* kept no changes/);
});

test("applyVerify loads, defaults to null, and rejects what is not a command line", () => {
  assert.equal(defaultConfig().settings.applyVerify, null);
  assert.deepEqual(collectConfigWarnings({ applyVerify: "npm test" }), []);
  const dir = mkdtempSync(join(tmpdir(), "odw-apply-cfg-"));
  roots.push(dir);
  const p = join(dir, "odw.config.json");
  const load = (raw: Record<string, unknown>) => {
    writeFileSync(p, JSON.stringify(raw));
    return loadConfig(p, { quiet: true }).settings.applyVerify;
  };
  assert.equal(load({ applyVerify: "npm test" }), "npm test");
  assert.equal(load({ applyVerify: null }), null);
  for (const bad of ["", "  ", 1, true, ["npm", "test"]]) {
    assert.throws(() => load({ applyVerify: bad }), /"applyVerify" must be a command line for the shell/);
  }
});

test("a reader that goes away while the verify runs (odw apply … | head) does not stop the rollback", { skip: process.platform === "win32" }, async () => {
  const fx = await dirtyFixture();
  const before = snapshot(fx.repo);
  const child = spawn(process.execPath, [...process.execArgv, CLI, "apply", fx.runId, "--agent", "wide", "--verify", "sleep 1; exit 1", ...fx.flags], {
    cwd: fx.repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  let out = "";
  await new Promise<void>((resolve) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (!out.includes("applied agent 1 (wide)")) return;
      // The change is in the tree, the verify about to run: every write from now on meets a closed pipe.
      child.stdout!.destroy();
      child.stderr!.destroy();
      resolve();
    });
  });
  assert.equal(await exited, 1);
  assert.equal(snapshot(fx.repo), before, "rolled back all the same");
});

test("Ctrl-C during a verify stops the command, rolls the apply back, and ends odw by the signal", { skip: process.platform === "win32" }, async () => {
  const fx = await dirtyFixture();
  const before = snapshot(fx.repo);
  const pids = join(fx.root, "pids");
  const verify = `sleep 30 & echo $! > '${pids}'; wait`;
  // Same loader flags as this test process, so the TypeScript entrypoint runs.
  const child = spawn(process.execPath, [...process.execArgv, CLI, "apply", fx.runId, "--agent", "wide", "--verify", verify, ...fx.flags], {
    cwd: fx.repo,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(pids) || readFileSync(pids, "utf8").trim() === "") {
      assert.ok(Date.now() < deadline, `the verify command started: ${stderr}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const sleeper = Number(readFileSync(pids, "utf8").trim());
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    child.kill("SIGINT");
    assert.equal(await exited, "SIGINT", "odw ends by the signal it got");
    assert.match(stderr, /`sleep 30 & .*` was interrupted after \d+\.\ds; it printed nothing\n/);
    assert.match(stderr, /rolled back agent 1 \(wide\) of run .*: the 11 path\(s\) it touched are as they were before the apply/);
    assert.equal(snapshot(fx.repo), before);
    let alive = true;
    for (const until = Date.now() + 5000; alive && Date.now() < until; await new Promise((r) => setTimeout(r, 25))) {
      try {
        process.kill(sleeper, 0);
      } catch {
        alive = false;
      }
    }
    assert.ok(!alive, "the command's own children are gone too");
  } finally {
    child.kill("SIGKILL");
  }
});
