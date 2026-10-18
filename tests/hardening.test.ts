/**
 * What a sandboxed or untrusted agent controls must never turn into code
 * that runs on the host, or into a host file it reads back:
 *   - git config planted in a workspace (core.fsmonitor) does not run when
 *     odw runs git there, and a container gets its workspace's git metadata
 *     read-only;
 *   - a reply file that is a link or a FIFO is refused, not followed or waited on;
 *   - a relative --config is made absolute where odw was started, so a worker
 *     running in the repository never reads the repository's own file instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replyFile } from "../src/adapters/reply-file.js";
import { gitMetadata } from "../src/adapters/sandbox.js";
import { runGit } from "../src/changes.js";
import { startRunFromSource } from "../src/runtime/launcher.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

test("git config an agent planted in its workspace never runs when odw runs git there", { skip: process.platform === "win32" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odw-harden-git-")));
  try {
    const work = join(root, "w");
    mkdirSync(work);
    git(work, "init", "-q");
    const marker = join(root, "ran");
    git(work, "config", "core.fsmonitor", `touch '${marker}'; echo`);
    mkdirSync(join(work, ".git", "hooks"), { recursive: true });
    writeFileSync(join(work, "f.txt"), "x");
    const result = await runGit(work, ["add", "--all", "--", "."]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(marker), false, "the planted fsmonitor did not run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a container gets each workspace's .git read-only over its read-write mount", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odw-harden-mount-")));
  try {
    const repo = join(root, "repo");
    const plain = join(root, "plain");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(plain);
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: /somewhere\n");
    assert.deepEqual(gitMetadata([repo, plain, wt]), [
      { source: join(repo, ".git"), target: join(repo, ".git"), readonly: true },
      { source: join(wt, ".git"), target: join(wt, ".git"), readonly: true },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reply file that is a link or a FIFO is refused, never followed or waited on", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-harden-reply-"));
  try {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "host secret");
    const link = await replyFile();
    symlinkSync(secret, link.path);
    const linked = await link.read();
    assert.equal(linked.text, null);
    assert.match(linked.note ?? "", /link/);
    await link.cleanup();

    const fifo = await replyFile();
    execFileSync("mkfifo", [fifo.path]);
    const started = Date.now();
    const piped = await fifo.read();
    assert.equal(piped.text, null);
    assert.match(piped.note ?? "", /not a regular file/);
    assert.ok(Date.now() - started < 2000, "it did not wait for a writer");
    await fifo.cleanup();

    const plain = await replyFile();
    writeFileSync(plain.path, "the reply");
    assert.equal((await plain.read()).text, "the reply");
    await plain.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relative --config is kept absolute: the worker, running in the repository, reads the file named where odw started", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odw-harden-config-")));
  const cwd = process.cwd();
  try {
    const mine = join(root, "mine");
    const repo = join(root, "repo");
    mkdirSync(mine);
    mkdirSync(repo);
    writeFileSync(join(mine, "odw.config.json"), JSON.stringify({ runsRoot: join(root, "runs") }));
    writeFileSync(join(repo, "odw.config.json"), JSON.stringify({ notify: { command: ["touch", join(root, "theirs")] } }));
    process.chdir(mine);
    const { runId, store } = startRunFromSource("export const meta = { name: 'n', description: 'd' }\nreturn 1\n", {
      configPath: "odw.config.json",
      source: repo,
      trust: "untrusted",
    });
    assert.equal(store.readMeta(runId).configPath, join(mine, "odw.config.json"));
    // Its worker runs in the repository: let it finish before the files go.
    const until = Date.now() + 20_000;
    while (Date.now() < until && !["done", "failed", "stopped"].includes(String(store.readStatus(runId).state))) execFileSync("sleep", ["0.2"]);
    assert.equal(existsSync(join(root, "theirs")), false, "the repository's notify command never ran");
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
