/**
 * `odw doctor`: the readiness checklist, including the opt-in smoke prompt that
 * catches CLIs which exit 0 without answering when run headless.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { loadConfig, locateConfig } from "../src/adapters/config.ts";
import { runDoctor, SMOKE_TOKEN } from "../src/doctor.ts";

const answer = "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=d.match(/ODW_\\w+_OK/);process.stdout.write(m?m[0]:'?')})";
const silent = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('sure, done'))";
const broken = "process.stderr.write('please log in');process.exit(3)";

/** Every temp dir this file made, removed once its tests are done. */
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function setup(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "odw-doctor-"));
  made.push(dir);
  const path = join(dir, "odw.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      runsRoot: join(dir, "runs"),
      defaultAdapter: "good",
      adapters: {
        good: { command: [execPath, "-e", answer], stdin: "{prompt}" },
        mute: { command: [execPath, "-e", silent], stdin: "{prompt}" },
        bad: { command: [execPath, "-e", broken], stdin: "{prompt}" },
        ghost: { command: ["definitely-not-installed-odw-cli"], stdin: "{prompt}" },
      },
      ...extra,
    }),
  );
  return { dir, path, config: loadConfig(path, { quiet: true }) };
}

const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)!;

test("doctor: a healthy machine passes; missing CLIs are skipped, not failed", async () => {
  const { dir, path, config } = setup();
  const report = await runDoctor({ config, configPath: path, cwd: dir, smoke: [] });
  assert.equal(report.ok, true);
  assert.equal(byId(report, "node").status, "ok");
  assert.equal(byId(report, "config").detail, path);
  assert.equal(byId(report, "runs-root").status, "ok");
  assert.equal(byId(report, "default-adapter").status, "ok");
  assert.equal(byId(report, "adapter:good").status, "ok"); // `node --version` answers
  assert.equal(byId(report, "adapter:ghost").status, "skip");
});

test("doctor: --smoke tells an answering CLI from one that exits 0 without answering", async () => {
  const { dir, path, config } = setup();
  const report = await runDoctor({ config, configPath: path, cwd: dir, smoke: ["good", "mute", "bad", "ghost"] });
  assert.equal(byId(report, "smoke:good").status, "ok");
  assert.match(byId(report, "smoke:good").detail, /answered headless/);
  const mute = byId(report, "smoke:mute");
  assert.equal(mute.status, "fail");
  assert.match(mute.detail, /did not answer/);
  assert.match(mute.hint ?? "", /login|trust|approval/);
  assert.equal(byId(report, "smoke:bad").status, "fail");
  assert.equal(byId(report, "smoke:ghost").status, "skip");
  assert.equal(report.ok, false);
  assert.ok(SMOKE_TOKEN.length > 0);
});

test("doctor: --smoke reports a rate-limited CLI at once instead of waiting it out", async () => {
  const limited = "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('429 Too Many Requests');process.exit(1)})";
  const { dir, path, config } = setup({ adapters: { limited: { command: [execPath, "-e", limited], stdin: "{prompt}" } } });
  const started = Date.now();
  const report = await runDoctor({ config, configPath: path, cwd: dir, smoke: ["limited"] });
  const smoke = byId(report, "smoke:limited");
  assert.equal(smoke.status, "fail");
  assert.match(smoke.detail, /^adapter 'limited' hit a rate limit: 429 Too Many Requests/);
  assert.ok(Date.now() - started < 10_000, "no backoff in a smoke check");
});

test("doctor: --smoke reads codex's exec --json — its reply file answers, and a failed turn says why", async () => {
  // codex's full config entry (the example's), run on the fake codex.
  const fake = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
  const example = JSON.parse(readFileSync(join(process.cwd(), "odw.config.example.json"), "utf8"));
  const entry = example.adapters.codex;
  const as = (prompt: string) => ({ ...entry, command: [execPath, fake, ...entry.command.slice(1)], stdin: `${prompt} {prompt}` });
  const { dir, path, config } = setup({ adapters: { codex: as("CASE:ok"), spent: as("CASE:quota") } });
  const report = await runDoctor({ config, configPath: path, cwd: dir, smoke: ["codex", "spent"] });
  assert.equal(byId(report, "adapter:codex").status, "ok");
  assert.match(byId(report, "adapter:codex").detail, /sandbox: workspace-write/, "the posture still read from its argv");
  assert.equal(byId(report, "smoke:codex").status, "ok");
  assert.match(byId(report, "smoke:codex").detail, /answered headless/);
  const spent = byId(report, "smoke:spent");
  assert.equal(spent.status, "fail");
  assert.match(spent.detail, /^adapter 'spent' ran out of usage quota — .*: Quota exceeded\./, "codex's own words, from its turn.failed");
});

test("doctor: a broken config fails fast with the loader's message", async () => {
  const report = await runDoctor({ config: new Error("could not parse config x.json"), configPath: null, cwd: tmpdir(), smoke: [] });
  assert.equal(report.ok, false);
  assert.equal(byId(report, "config").status, "fail");
  assert.match(byId(report, "config").detail, /could not parse/);
});

test("doctor: no default adapter warns; an uninstalled default fails", async () => {
  const unset = setup({ defaultAdapter: null });
  const r1 = await runDoctor({ config: unset.config, configPath: unset.path, cwd: unset.dir, smoke: [] });
  assert.equal(byId(r1, "default-adapter").status, "warn");
  assert.match(byId(r1, "default-adapter").hint ?? "", /odw init/);
  const missing = setup({ defaultAdapter: "ghost" });
  const r2 = await runDoctor({ config: missing.config, configPath: missing.path, cwd: missing.dir, smoke: [] });
  assert.equal(byId(r2, "default-adapter").status, "fail");
  assert.equal(r2.ok, false);
});

test("locateConfig reports the file loadConfig reads", () => {
  const { dir, path } = setup();
  assert.equal(locateConfig(path, dir), path);
  assert.throws(() => locateConfig(join(dir, "nope.json")), /not found/);
});
