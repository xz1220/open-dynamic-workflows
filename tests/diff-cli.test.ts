import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// `odw diff` and `odw apply` over a real run whose isolated agents changed a
// real repository (ODW extension).

const EDIT_AGENT = fileURLToPath(new URL("./fixtures/edit-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

const commit = (dir: string, message: string, ...paths: string[]): string =>
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", message, "--", ...paths);

const ten = (first = "1", last = "10"): string => [first, "2", "3", "4", "5", "6", "7", "8", "9", last].join("\n") + "\n";

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

interface Fixture {
  root: string;
  src: string;
  store: RunStore;
  id: string;
  /** A second run whose one agent kept a diff cut at the size cap. */
  cut: string;
  flags: string[];
}

let fx: Fixture;

/** Write the config and script, and run `body` over `src` with the file-editing agent. */
async function run(root: string, src: string, body: string, args: unknown, config: Record<string, unknown> = {}): Promise<string> {
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ defaultAdapter: "edit", ...config, adapters: { edit: { command: [execPath, EDIT_AGENT], stdin: "{prompt}" } } }),
  );
  const script = join(root, `wf-${Date.now()}.js`);
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args, source: src, configPath });
  assert.equal(await executeRun(store.runDir(id)), "done");
  return id;
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-diffcli-"));
  const src = join(root, "repo");
  mkdirSync(src);
  git(src, "init", "-q");
  for (const name of ["a", "b", "d"]) writeFileSync(join(src, `${name}.txt`), ten());
  writeFileSync(join(src, "c.txt"), "c1\nc2\nc3\n");
  writeFileSync(join(src, "e.txt"), "e\n");
  writeFileSync(join(src, "f.txt"), "f\n");
  git(src, "add", "-A");
  commit(src, "init");
  const edits = {
    one: { write: { "a.txt": ten("1", "TEN") } },
    two: { write: { "b.txt": ten("ONE") } },
    clash: { write: { "c.txt": "c1, by the agent\nc2\nc3\n" } },
    far: { write: { "d.txt": ten("ONE") } },
    dup1: { write: { "e.txt": "e, dup\n" } },
    dup2: { write: { "f.txt": "f, dup\n" } },
  };
  const iso = (key: string, label: string) => `  () => agent('EDITS: ' + JSON.stringify(args.${key}), { isolation: 'worktree', label: '${label}' }),\n`;
  const id = await run(
    root,
    src,
    "return await parallel([\n" +
      iso("one", "one") +
      iso("two", "two") +
      "  () => agent('EDITS: {}', { label: 'here' }),\n" +
      iso("clash", "clash") +
      iso("far", "far") +
      iso("dup1", "dup") +
      iso("dup2", "dup") +
      "])\n",
    edits,
  );
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const cut = await run(
    root,
    src,
    "return await agent('EDITS: ' + JSON.stringify(args), { isolation: 'worktree', label: 'big', keep: true })\n",
    { write: { "big1.txt": lines, "big2.txt": lines } },
    { maxDiffBytes: 1024 },
  );
  const store = new RunStore(join(root, "runs"));
  fx = { root, src, store, id, cut, flags: ["--runs-root", store.root] };
});

after(() => {
  if (fx) rmSync(fx.root, { recursive: true, force: true });
});

const diffOf = (agentId: number, runId = fx.id): string => readFileSync(fx.store.agentDiffPath(runId, agentId), "utf8");

test("odw diff prints every kept diff under a line naming its agent; --agent prints one, verbatim", async () => {
  const all = await cli(["diff", fx.id, ...fx.flags]);
  assert.equal(all.code, 0, all.err);
  const expected = [
    [1, "one", 1, 1, 1],
    [2, "two", 1, 1, 1],
    [4, "clash", 1, 1, 1],
    [5, "far", 1, 1, 1],
    [6, "dup", 1, 1, 1],
    [7, "dup", 1, 1, 1],
  ]
    .map(([agentId, label, files, ins, del]) => `# odw: agent ${agentId} · ${label} · ${files} file(s) +${ins} -${del}\n${diffOf(agentId as number)}`)
    .join("");
  assert.equal(all.out, expected, "the agent in the source tree kept nothing");

  const one = await cli(["diff", fx.id, "--agent", "one", ...fx.flags]);
  assert.equal(one.code, 0, one.err);
  assert.equal(one.out, diffOf(1), "a patch git can read, as kept");
  assert.equal((await cli(["diff", fx.id, "--agent", "4", ...fx.flags])).out, diffOf(4));

  const here = await cli(["diff", fx.id, "--agent", "here", ...fx.flags]);
  assert.deepEqual([here.code, here.out], [0, ""]);
  assert.equal(here.err, 'agent 3 (here) kept no diff: it changed nothing, or it did not run with isolation: "worktree"\n');

  const dup = await cli(["diff", fx.id, "--agent", "dup", ...fx.flags]);
  assert.equal(dup.code, 1);
  assert.match(dup.err, /label 'dup' matches 2 agents of run .*: 6 \(done\), 7 \(done\) — pick one: odw diff .* --agent <id>/);
  assert.equal((await cli(["diff", fx.id, "--agent", "nobody", ...fx.flags])).code, 1);
  assert.equal((await cli(["diff", "no-such-run", ...fx.flags])).code, 1);
  assert.equal((await cli(["diff", ...fx.flags])).code, 2, "a missing run id is a usage error");
});

test("odw diff --stat sums each agent's change up, with --agent its files too", async () => {
  const stat = await cli(["diff", fx.id, "--stat", ...fx.flags]);
  assert.equal(stat.code, 0, stat.err);
  const plain = stat.out.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.trimEnd().split("\n");
  assert.match(lines[0]!, /^ID\s+STATE\s+LABEL\s+FILES\s+\+\s+-\s+BRANCH$/);
  assert.deepEqual(
    lines.slice(1).map((l) => l.trim().split(/\s+/)),
    [
      ["1", "done", "one", "1", "+1", "-1", "-"],
      ["2", "done", "two", "1", "+1", "-1", "-"],
      ["4", "done", "clash", "1", "+1", "-1", "-"],
      ["5", "done", "far", "1", "+1", "-1", "-"],
      ["6", "done", "dup", "1", "+1", "-1", "-"],
      ["7", "done", "dup", "1", "+1", "-1", "-"],
    ],
  );
  assert.match(stat.err, new RegExp(`full diff: odw diff ${fx.id} --agent <id\\|label>`));

  const one = await cli(["diff", fx.id, "--agent", "1", "--stat", ...fx.flags]);
  assert.equal(one.code, 0, one.err);
  assert.match(one.out.replace(/\x1b\[[0-9;]*m/g, ""), /\n {2}M a\.txt {2}\+1 -1\n$/);

  const cut = await cli(["diff", fx.cut, "--stat", "--agent", "big", ...fx.flags]);
  const text = cut.out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, new RegExp(`^ 1\\s+done\\s+big\\s+2\\s+\\+400\\s+-0\\s+odw/${fx.cut}/1-big {2}diff cut at maxDiffBytes$`, "m"));
  assert.match(text, /^ {2}# odw: diff truncated at 1\.0 KB — /m);

  const bare = fx.store.create({ script: join(fx.root, "none.js"), args: null, source: fx.src });
  const empty = await cli(["diff", bare, "--stat", ...fx.flags]);
  assert.deepEqual([empty.code, empty.out], [0, ""]);
  assert.match(empty.err, /^run .* kept no changes: agents that run with isolation: "worktree" keep a diff of what they changed\n$/);
});

test("odw apply --check changes nothing; apply stages the change; several agents apply one after another", async () => {
  const src = fx.src;
  const check = await cli(["apply", fx.id, "--agent", "one", "--check", ...fx.flags], src);
  assert.equal(check.code, 0, check.err);
  const preview = `agent 1 (one) of run ${fx.id} applies cleanly to ${realpathSync(src)}:\n  M a.txt  clean\n`;
  assert.equal(check.out, preview);
  assert.equal(git(src, "status", "--porcelain"), "", "a check changes nothing");

  const applied = await cli(["apply", fx.id, "--agent", "one", ...fx.flags], src);
  assert.equal(applied.code, 0, applied.err);
  assert.equal(applied.out, `${preview}applied agent 1 (one) of run ${fx.id} to ${realpathSync(src)} (staged, as git apply --3way does)\n`);
  assert.equal(readFileSync(join(src, "a.txt"), "utf8"), ten("1", "TEN"));
  assert.equal(git(src, "diff", "--cached", "--name-only"), "a.txt\n");

  // The same agent again: its paths now hold uncommitted changes.
  const again = await cli(["apply", fx.id, "--agent", "one", ...fx.flags], src);
  assert.equal(again.code, 1);
  assert.match(again.err, /uncommitted changes in the way of the diff agent 1 \(one\) .* pass --force:\n {2}a\.txt \(staged\)\n$/);

  // Another agent, other files: applies on top.
  const two = await cli(["apply", fx.id, "--agent", "two", ...fx.flags], src);
  assert.equal(two.code, 0, two.err);
  assert.equal(git(src, "diff", "--cached", "--name-only"), "a.txt\nb.txt\n");
  assert.equal(readFileSync(join(src, "b.txt"), "utf8"), ten("ONE"));
  assert.equal(readFileSync(join(src, "a.txt"), "utf8"), ten("1", "TEN"), "the first stays applied");
});

test("odw apply reports conflicts with a check first, then leaves them marked; --force goes past staged edits", async () => {
  const src = fx.src;
  // The user changed the line the agent changed, and committed it.
  writeFileSync(join(src, "c.txt"), "c1, by the user\nc2\nc3\n");
  commit(src, "user edit", "c.txt");

  const check = await cli(["apply", fx.id, "--agent", "clash", "--check", ...fx.flags], src);
  assert.equal(check.code, 1);
  const preview =
    `agent 4 (clash) of run ${fx.id} would apply with 1 conflict(s) to ${realpathSync(src)}:\n` +
    "  M c.txt  CONFLICT\n" +
    "      at line 1:\n" +
    "      <<<<<<< ours\n      c1, by the user\n      =======\n      c1, by the agent\n      >>>>>>> theirs\n" +
    "  (ours: what this tree holds · theirs: the agent's change)\n";
  assert.equal(check.out, preview, "the conflicting lines, as the merge would leave them");
  assert.equal(readFileSync(join(src, "c.txt"), "utf8"), "c1, by the user\nc2\nc3\n", "a check changes nothing");
  assert.equal(git(src, "ls-files", "--unmerged"), "");

  const clash = await cli(["apply", fx.id, "--agent", "4", ...fx.flags], src);
  assert.equal(clash.code, 1);
  assert.equal(
    clash.out,
    `${preview}applied agent 4 (clash) of run ${fx.id} to ${realpathSync(src)} (staged, as git apply --3way does)\n` +
      "1 file(s) conflicted: resolve the <<<<<<< markers, then git add them\n",
  );
  const marked = readFileSync(join(src, "c.txt"), "utf8");
  assert.match(marked, /^<<<<<<< .*\nc1, by the user\n=======\nc1, by the agent\n>>>>>>> /m);
  assert.notEqual(git(src, "ls-files", "--unmerged", "--", "c.txt"), "");

  // A staged edit elsewhere in a file the agent changed: refused, then merged with --force.
  writeFileSync(join(src, "d.txt"), ten("1", "TEN, by the user"));
  git(src, "add", "d.txt");
  const refused = await cli(["apply", fx.id, "--agent", "far", ...fx.flags], src);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /\n {2}d\.txt \(staged\)\n$/);
  const forced = await cli(["apply", fx.id, "--agent", "far", "--force", ...fx.flags], src);
  assert.equal(forced.code, 0, forced.err);
  assert.match(forced.err, /--force: applying over uncommitted changes in:\n {2}d\.txt \(staged\)/);
  assert.equal(readFileSync(join(src, "d.txt"), "utf8"), ten("ONE", "TEN, by the user"), "both edits, merged three-way");
});

test("odw apply refuses a cut diff, a missing --agent, an agent with no diff, and a directory outside git", async () => {
  const cut = await cli(["apply", fx.cut, "--agent", "big", ...fx.flags], fx.src);
  assert.equal(cut.code, 1);
  assert.match(cut.err, /the diff agent 1 \(big\) of run .* kept was cut at maxDiffBytes, so it cannot be applied:\n {2}# odw: diff truncated at 1\.0 KB/);
  assert.match(cut.err, new RegExp(`The whole change is on branch odw/${fx.cut}/1-big`));

  const missing = await cli(["apply", fx.id, ...fx.flags], fx.src);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /--agent <id\|label> or --all is required/);

  const none = await cli(["apply", fx.id, "--agent", "here", ...fx.flags], fx.src);
  assert.equal(none.code, 1);
  assert.match(none.err, /agent 3 \(here\) of run .* kept no diff/);

  const outside = mkdtempSync(join(tmpdir(), "odw-diffcli-plain-"));
  try {
    const r = await cli(["apply", fx.id, "--agent", "two", ...fx.flags], outside);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`run it inside the git repository to apply the change to \\(the run worked in ${fx.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
