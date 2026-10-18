/**
 * `odw new` (an ODW extension; src/new.ts): every embedded template writes its
 * workflow, starter test and (review-ish) eval skeleton, the workflow loads,
 * and its starter test passes under `odw test` at once; a file is never
 * overwritten without --force; the .worktreeinclude suggestion in a git
 * repository; and the templates really are the embedded copies of their
 * sources.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { main } from "../src/cli.js";
import { loadEvalFile } from "../src/eval/definition.js";
import { loadWorkflowScript } from "../src/loader.js";
import { cmdNew, listTemplates, suggestWorktreeInclude } from "../src/new.js";
import { TEMPLATES } from "../src/templates.generated.js";
import { loadTestFile } from "../src/wftest/definition.js";

const posix = { skip: process.platform === "win32" ? "fix-until-green's starter test runs `exit 0` through the POSIX shell" : false };

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-new-")));
  try {
    // Keep the developer's own config out of it: odw test answers every agent itself.
    writeFileSync(join(dir, "odw.config.json"), "{}\n");
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `odw …` in-process, from `cwd`, its stdout and stderr captured. */
async function odw(cwd: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  const was = process.cwd();
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  process.chdir(cwd);
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.chdir(was);
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

function sink(tty = false): PassThrough & { text(): string } {
  const s = new PassThrough() as PassThrough & { text(): string };
  (s as { isTTY?: boolean }).isTTY = tty;
  let buf = "";
  s.on("data", (c: Buffer) => (buf += String(c)));
  s.text = () => buf;
  return s;
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
}

const REVIEWISH = ["review-swarm", "pr-shepherd"];

test("the six templates, hello first, each with a one-line description", () => {
  assert.deepEqual(
    listTemplates().map((t) => t.name),
    ["hello", "review-swarm", "fix-until-green", "plan-approve-execute", "pr-shepherd", "fan-out-reduce"],
  );
  for (const t of listTemplates()) assert.doesNotMatch(t.description, /\n/, t.name);
  assert.deepEqual(TEMPLATES.filter((t) => t.eval !== null).map((t) => t.name), REVIEWISH);
});

test("odw new with no template lists them, on stdout", () =>
  withDir(async (dir) => {
    const r = await odw(dir, ["new"]);
    assert.equal(r.code, 0, r.err);
    for (const t of TEMPLATES) assert.match(r.out, new RegExp(`^${t.name} +${t.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.equal(existsSync(join(dir, ".odw")), false);
  }));

for (const t of TEMPLATES) {
  test(`odw new ${t.name}: writes the workflow, a starter test that passes under odw test, and loads`, posix, () =>
    withDir(async (dir) => {
      const r = await odw(dir, ["new", t.name]);
      assert.equal(r.code, 0, r.err);
      const wf = join(dir, ".odw", "workflows", `${t.name}.js`);
      const loaded = loadWorkflowScript(readFileSync(wf, "utf8"), wf);
      assert.equal(loaded.meta.name, t.name);
      assert.doesNotMatch(readFileSync(wf, "utf8"), /examples\//, "an example's comments name it as the named workflow it now is");
      assert.equal(loadTestFile(join(dir, ".odw", "tests", `${t.name}.json`)).workflow, t.name);
      const evalFile = join(dir, ".odw", "evals", `${t.name}.json`);
      assert.equal(existsSync(evalFile), REVIEWISH.includes(t.name));
      if (existsSync(evalFile)) assert.equal(loadEvalFile(evalFile).workflow, t.name);
      assert.match(r.err, new RegExp(`odw test ${t.name} +the starter tests`));
      assert.match(r.err, new RegExp(`odw run ${t.name} --dry`));

      const tested = await odw(dir, ["test", t.name]);
      assert.equal(tested.code, 0, tested.out + tested.err);
      assert.match(tested.out, /\d+ passed · no model called, \$0/);
      assert.doesNotMatch(tested.out, /\d+ failed/);
    }));
}

test("odw new --name renames the workflow, its test and its eval; odw test <name> passes", () =>
  withDir(async (dir) => {
    const r = await odw(dir, ["new", "review-swarm", "--name", "pre-merge"]);
    assert.equal(r.code, 0, r.err);
    const wf = join(dir, ".odw", "workflows", "pre-merge.js");
    assert.equal(loadWorkflowScript(readFileSync(wf, "utf8"), wf).meta.name, "pre-merge");
    assert.equal(loadTestFile(join(dir, ".odw", "tests", "pre-merge.json")).workflow, "pre-merge");
    assert.equal(loadEvalFile(join(dir, ".odw", "evals", "pre-merge.json")).workflow, "pre-merge");
    assert.match(readFileSync(join(dir, ".odw", "tests", "pre-merge.json"), "utf8"), /odw test pre-merge/);
    assert.equal(existsSync(join(dir, ".odw", "workflows", "review-swarm.js")), false);
    const tested = await odw(dir, ["test", "pre-merge"]);
    assert.equal(tested.code, 0, tested.out + tested.err);
  }));

test("odw new refuses to overwrite without --force — and then writes nothing at all", () =>
  withDir(async (dir) => {
    assert.equal((await odw(dir, ["new", "hello"])).code, 0);
    const wf = join(dir, ".odw", "workflows", "hello.js");
    const testFile = join(dir, ".odw", "tests", "hello.json");
    writeFileSync(wf, "// mine\n");
    unlinkSync(testFile);
    const r = await odw(dir, ["new", "hello"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /\.odw\/workflows\/hello\.js exists/);
    assert.match(r.err, /refusing to overwrite — nothing written; pass --force/);
    assert.equal(readFileSync(wf, "utf8"), "// mine\n");
    assert.equal(existsSync(testFile), false, "a refusal writes none of the files");

    const forced = await odw(dir, ["new", "hello", "--force"]);
    assert.equal(forced.code, 0, forced.err);
    assert.equal(readFileSync(wf, "utf8"), TEMPLATES[0]!.workflow);
    assert.equal(existsSync(testFile), true);
    // The same files again: nothing to overwrite, nothing refused.
    const again = await odw(dir, ["new", "hello"]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.err, /hello\.js is already this template/);
  }));

test("odw new: an unknown template or a name odw run would not resolve as a name is a usage error", () =>
  withDir(async (dir) => {
    const unknown = await odw(dir, ["new", "nope"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /no template 'nope'; there are: hello, review-swarm/);
    for (const bad of [".hidden", "a/b", "x.js", "-x", "a b", "x".repeat(129)]) {
      const r = await odw(dir, ["new", "hello", "--name", bad]);
      assert.equal(r.code, 2, bad);
    }
    assert.equal((await odw(dir, ["new", "--name", "x"])).code, 2);
    assert.equal((await odw(dir, ["new", "hello", "fan-out-reduce"])).code, 2);
    assert.equal(existsSync(join(dir, ".odw")), false);
  }));

test("suggestWorktreeInclude: lockfiles name dependency dirs (linked), .env files are copied, examples are not", () =>
  withDir(async (dir) => {
    assert.equal(suggestWorktreeInclude(dir), null, "nothing to bring in: no suggestion");
    for (const f of ["pnpm-lock.yaml", "yarn.lock", "uv.lock", ".env", ".env.local", ".env.example", ".envrc"]) writeFileSync(join(dir, f), "");
    const text = suggestWorktreeInclude(dir)!;
    const lines = text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    assert.deepEqual(lines, [".env", ".env.local", "symlink: node_modules", "symlink: .venv"]);
    assert.match(text, /# yarn\.lock, uv\.lock: the dependencies, linked rather than copied \(symlink: is an ODW extension/);
    writeFileSync(join(dir, ".worktreeinclude"), ".env\n");
    assert.equal(suggestWorktreeInclude(dir), null, "a repository's own .worktreeinclude is left alone");
  }));

test("odw new in a git repository with a lockfile: prints the .worktreeinclude, writes it only with --yes", () =>
  withDir(async (dir) => {
    gitInit(dir);
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
    writeFileSync(join(dir, ".env"), "TOKEN=placeholder\n");
    const include = join(dir, ".worktreeinclude");

    const shown = await odw(dir, ["new", "hello"]);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.err, /this repository has no \.worktreeinclude/);
    assert.match(shown.err, /^ {2}\.env$/m);
    assert.match(shown.err, /^ {2}symlink: node_modules$/m);
    assert.match(shown.err, /not written — to write it: odw new hello --yes/);
    assert.equal(existsSync(include), false, "never written unasked off a terminal");

    const written = await odw(dir, ["new", "hello", "--yes"]);
    assert.equal(written.code, 0, written.err);
    assert.match(written.err, /wrote \.worktreeinclude/);
    const text = readFileSync(include, "utf8");
    assert.deepEqual(text.split("\n").filter((l) => l !== "" && !l.startsWith("#")), [".env", "symlink: node_modules"]);

    const later = await odw(dir, ["new", "fan-out-reduce"]);
    assert.doesNotMatch(later.err, /worktreeinclude/, "once there is one, no suggestion");
  }));

test("odw new at a terminal asks before writing the .worktreeinclude", () =>
  withDir(async (dir) => {
    gitInit(dir);
    writeFileSync(join(dir, "yarn.lock"), "");
    const ask = async (answer: string) => {
      const input = sink(true);
      const err = sink(true);
      const done = cmdNew({ template: "hello", force: true }, { cwd: dir, input, out: sink(), err, env: { TERM: "xterm" } });
      input.write(answer);
      assert.equal(await done, 0);
      return err.text();
    };
    assert.match(await ask("\n"), /write \.worktreeinclude\? \[y\/N\][\s\S]*not written/); // Enter: no
    assert.equal(existsSync(join(dir, ".worktreeinclude")), false);
    assert.match(await ask("y\n"), /wrote \.worktreeinclude/);
    assert.match(readFileSync(join(dir, ".worktreeinclude"), "utf8"), /^symlink: node_modules$/m);
  }));

test("outside a git repository there is no .worktreeinclude suggestion", () =>
  withDir(async (dir) => {
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
    const r = await odw(dir, ["new", "hello", "--yes"]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /worktreeinclude/);
    assert.equal(existsSync(join(dir, ".worktreeinclude")), false);
  }));
