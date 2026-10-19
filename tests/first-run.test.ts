/**
 * The first 60 seconds (ODW extension): bare `odw` before any run, and
 * `odw doctor` with no run yet, show the first run for $0 — `odw new hello`,
 * its starter test, a dry run, the dashboard — instead of leaving a new user
 * with 150 lines of commands.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { firstRunSteps, formatSteps, noRunsYet, welcomeText } from "../src/first-run.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A project directory with its own config, whose runs root is empty. */
function project(): { dir: string; config: string; runs: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-first-run-")));
  made.push(dir);
  const runs = join(dir, "runs");
  const config = join(dir, "odw.config.json");
  writeFileSync(config, JSON.stringify({ runsRoot: runs, adapters: {} }));
  return { dir, config, runs };
}

function addRun(runs: string): void {
  const run = join(runs, "hello", "20260101-000000-aaaaaa");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "meta.json"), "{}");
}

/** `odw <args>` in `cwd`, as a user would type it (same loader flags as this test, so the TypeScript runs). */
function odw(cwd: string, config: string, ...args: string[]) {
  const env = { ...process.env, ODW_CONFIG: config, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const res = spawnSync(process.execPath, [...process.execArgv, cli, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

test("first run: the steps cost nothing, and skip `odw new hello` once hello.js is there", () => {
  const { dir } = project();
  assert.deepEqual(firstRunSteps(dir).map((s) => s.command), ["odw new hello", "odw test hello", "odw run hello --dry", "odw serve --open"]);
  mkdirSync(join(dir, ".odw", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".odw", "workflows", "hello.js"), "");
  assert.deepEqual(firstRunSteps(dir).map((s) => s.command), ["odw test hello", "odw run hello --dry", "odw serve --open"]);
  assert.deepEqual(formatSteps([{ command: "a", note: "x" }, { command: "abc", note: "y" }]), ["  a    x", "  abc  y"]);
});

test("first run: a runs root with no run (or none at all) is a new user's", () => {
  const { runs } = project();
  assert.equal(noRunsYet(runs), true, "not made yet");
  mkdirSync(runs, { recursive: true });
  assert.equal(noRunsYet(runs), true, "empty");
  addRun(runs);
  assert.equal(noRunsYet(runs), false);
});

test("first run: the welcome names the $0 steps, then doctor, init and the real run, then --help", () => {
  const { dir } = project();
  const text = welcomeText("odw — header", dir);
  assert.match(text, /^odw — header\n\nYour first run costs nothing — no model is called:\n {2}odw new hello /);
  assert.ok(text.indexOf("odw test hello") < text.indexOf("odw run hello --dry"));
  assert.match(text, /Then:\n {2}odw doctor .*open-file limit[\s\S]*odw init [\s\S]*odw run hello /);
  assert.match(text, /Every command: odw --help$/);
});

test("bare odw: a new user gets the first run; once a run exists, every command as before", () => {
  const { dir, config, runs } = project();
  const fresh = odw(dir, config);
  assert.equal(fresh.code, 2);
  assert.match(fresh.out, /^odw — Open Dynamic Workflows \(v[^)]+\)\n/);
  assert.match(fresh.out, /Your first run costs nothing[\s\S]*odw new hello[\s\S]*odw run hello --dry/);
  assert.doesNotMatch(fresh.out, /Usage:/);
  addRun(runs);
  const seasoned = odw(dir, config);
  assert.equal(seasoned.code, 2);
  assert.match(seasoned.out, /Usage:\n {2}odw init/);
  assert.match(odw(dir, config, "--help").out, /odw doctor --fanout <n>/);
});

test("odw doctor: a new user's checklist ends with the first run; --fanout is checked", () => {
  const { dir, config, runs } = project();
  const fresh = odw(dir, config, "doctor");
  assert.match(fresh.out, /Free space \(temp\)/);
  assert.match(fresh.out, /Git /);
  assert.match(fresh.out, /first run, for \$0 — no model called:\n {2}odw new hello /);
  addRun(runs);
  assert.doesNotMatch(odw(dir, config, "doctor").out, /first run, for \$0/);
  const bad = odw(dir, config, "doctor", "--fanout", "0");
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--fanout must be a whole number/);
  const json = JSON.parse(odw(dir, config, "doctor", "--json", "--fanout", "5").out) as { checks: Array<{ id: string; detail: string }> };
  const files = json.checks.find((c) => c.id === "open-files");
  assert.ok(files);
  if (process.platform !== "win32") assert.match(files.detail, /a fan-out of 5 agent\(s\) needs ~84/);
});
