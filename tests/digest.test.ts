/**
 * `odw digest` (ODW extension): the cross-run report built from what runs
 * recorded, printed or sent through the notify hooks. Runs are written
 * straight into a RunStore (meta, status, events); webhooks go to a local
 * fake HTTP server; no model runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { loadConfig } from "../src/adapters/config.js";
import { announceServe, ensureApproveSecret } from "../src/runtime/approve-links.js";
import { DIGEST_DIR, MARKS_FILE, parseSince, readMark } from "../src/runtime/digest-cli.js";
import { collectDigest, digestLine, digestMarkdown, formatDigest } from "../src/runtime/digest.js";
import { RunStore } from "../src/runtime/run-store.js";
import { capture, odw, withSandbox } from "./schedule-fixture.js";
import { main } from "../src/cli.js";

const HOUR = 3600;
const now = () => Date.now() / 1000;

/** What an agent replied: a digest never repeats it. */
const CLAIM = "ALL DONE, every test passes, trust me";

interface Box {
  root: string;
  runsRoot: string;
  store: RunStore;
  script: string;
  cleanup(): void;
}

function scratch(): Box {
  const root = mkdtempSync(join(tmpdir(), "odw-digest-"));
  const runsRoot = join(root, "runs");
  const store = new RunStore(runsRoot);
  const script = join(root, "wf.js");
  writeFileSync(script, "export const meta = { name: 'w', description: 'd' }\nreturn 1");
  return { root, runsRoot, store, script, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A run of `workflow` in `state`, last written `hoursAgo`, with `events` (ts filled in). */
function fakeRun(
  box: Box,
  workflow: string,
  state: string,
  hoursAgo: number,
  events: Array<Record<string, unknown>>,
  extra: { status?: Record<string, unknown>; error?: string; dry?: boolean } = {},
): string {
  const runId = box.store.create({ script: box.script, args: null, source: box.root, workflowName: workflow, dry: extra.dry ?? null });
  const at = now() - hoursAgo * HOUR;
  const dir = box.store.runDir(runId);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ runId, name: workflow, state, updatedAt: at, ...extra.status }));
  for (const ev of events) appendFileSync(box.store.eventsPath(runId), JSON.stringify({ ts: at - 60, ...ev }) + "\n");
  if (extra.error) box.store.writeError(runId, { error: extra.error });
  if (state === "done") box.store.writeResult(runId, { reply: CLAIM });
  return runId;
}

const started = (agentId: number, label: string) => ({ type: "agent_started", agentId, label, adapter: "mock" });
const usage = (costUsd: number, tokens: number) => ({ inputTokens: tokens / 2, outputTokens: tokens / 2, costUsd });

/** One of each kind of run, and some that must stay out. */
function seed(box: Box) {
  const waiting = fakeRun(box, "deploy", "running", 0.5, [
    { type: "run_started" },
    { type: "checkpoint_requested", checkpointId: 1, title: "Ship it?", payload: null },
    { type: "checkpoint_requested", checkpointId: 2, title: "Which DB?", payload: null, question: { agentId: 3, label: "planner", adapter: "mock", questions: [{ question: "Which DB?" }] } },
  ], { status: { pid: process.pid } });
  const failed = fakeRun(box, "nightly", "failed", 2, [
    started(0, "build"),
    { type: "agent_failed", agentId: 0, label: "build", error: "exit 1", reason: "timeout", usage: usage(2, 4000) },
    started(1, "lint"),
    { type: "agent_finished", agentId: 1, label: "lint", adapter: "mock", result: CLAIM, usage: usage(0.5, 1000) },
  ], { error: "nightly failed: build timed out" });
  const unmet = fakeRun(box, "refactor", "done", 3, [
    started(0, "fix-tests"),
    { type: "agent_failed", agentId: 0, label: "fix-tests", error: "unmet", reason: "unmet_expectation", misses: ["command `npm test` exited 1"] },
    started(1, "docs"),
    { type: "agent_finished", agentId: 1, label: "docs", adapter: "mock", result: CLAIM, outOfScope: ["README.md"], usage: usage(0.25, 500) },
  ]);
  const changed = fakeRun(box, "docs", "done", 4, [
    started(0, "writer"),
    { type: "agent_finished", agentId: 0, label: "writer", adapter: "mock", result: CLAIM, changes: { files: 3, insertions: 40, deletions: 2, truncated: false }, usage: usage(1, 2000) },
    started(1, "reader"),
    { type: "agent_finished", agentId: 1, label: "reader", adapter: "mock", result: CLAIM, changes: null },
  ]);
  const old = fakeRun(box, "nightly", "failed", 48, [], { error: "an old failure" });
  const dry = fakeRun(box, "nightly", "failed", 1, [], { error: "a dry failure", dry: true });
  // A run whose worker died without recording an end: stale.
  const stale = fakeRun(box, "sweep", "running", 1, [started(0, "a")], { status: { pid: 2 ** 22 + 12345 } });
  return { waiting, failed, unmet, changed, old, dry, stale };
}

test("a digest groups the window's runs by what they need, from their recorded evidence only", () => {
  const box = scratch();
  try {
    const ids = seed(box);
    const until = now();
    const d = collectDigest(box.store, { since: until - 12 * HOUR, until });

    assert.deepEqual(d.needsYou.map((w) => [w.runId, w.checkpointId, w.kind]), [[ids.waiting, 1, "checkpoint"], [ids.waiting, 2, "question"]]);
    assert.equal(d.needsYou[0]!.approve, `odw approve ${ids.waiting} --checkpoint 1`);
    assert.equal(d.needsYou[1]!.asker, "planner");
    assert.match(d.needsYou[1]!.approve, /--note "<answer>"$/);

    assert.deepEqual(d.failed.map((f) => [f.runId, f.state]).sort(), [[ids.failed, "failed"], [ids.stale, "stale"]].sort());
    const failed = d.failed.find((f) => f.runId === ids.failed)!;
    assert.equal(failed.error, "nightly failed: build timed out");
    assert.deepEqual(failed.reasons, { timeout: 1 });
    assert.deepEqual(failed.agents, { total: 2, failed: 1 });
    assert.equal(failed.resume, `odw resume ${ids.failed}`);

    assert.equal(d.unmet.length, 1);
    assert.equal(d.unmet[0]!.runId, ids.unmet);
    assert.deepEqual(d.unmet[0]!.agents, [
      { agentId: 0, label: "fix-tests", failed: "unmet_expectation", misses: ["command `npm test` exited 1"] },
      { agentId: 1, label: "docs", outOfScope: ["README.md"] },
    ]);

    assert.equal(d.changes.length, 1);
    assert.equal(d.changes[0]!.runId, ids.changed);
    assert.deepEqual(d.changes[0]!.agents, [{ agentId: 0, label: "writer", files: 3, insertions: 40, deletions: 2, branch: null }]);
    assert.equal(d.changes[0]!.check, `odw apply ${ids.changed} --all --check`);

    // The old run and the dry one stay out; the waiting one counts.
    assert.deepEqual(d.counts, { runs: 5, done: 2, failed: 1, stopped: 0, running: 0, waiting: 1, stale: 1 });
    assert.equal(d.spend.costUsd, 3.75);
    assert.equal(d.spend.tokens, 7500);
    assert.deepEqual(d.spend.top, { runId: ids.failed, workflow: "nightly", costUsd: 2.5, tokens: 5000 });

    const all = [JSON.stringify(d), formatDigest(d), digestMarkdown(d), digestLine(d)].join("\n");
    assert.ok(!all.includes(CLAIM), "an agent's own claims are never repeated");
    assert.ok(!all.includes("an old failure") && !all.includes("a dry failure"));
    assert.match(digestLine(d), /^odw digest · last 12h00m · 2 need you · 2 failed · 1 missed checks · 1 with changes · \$3\.750 over 5 runs$/);
    const text = formatDigest(d);
    for (const s of ["Needs you (2)", "Failed (2)", "Done, but checks were not met (1)", "Done, with changes to review (1)", `odw resume ${ids.failed}`, 'agent 0 "fix-tests" missed: command `npm test` exited 1', 'agent 1 "docs" wrote outside its scope: README.md', "most: nightly"]) {
      assert.ok(text.includes(s), `text has ${s}`);
    }
    const md = digestMarkdown(d);
    assert.match(md, /^### odw digest · last 12h00m · 5 runs/);
    assert.ok(md.includes(`\`odw apply ${ids.changed} --all --check\``));
    assert.ok(md.includes("command 'npm test' exited 1") || md.includes("command \\`npm test\\` exited 1"));
  } finally {
    box.cleanup();
  }
});

test("a quiet window says nothing needs you; --workflow narrows to one workflow's runs", () => {
  const box = scratch();
  try {
    const ids = seed(box);
    const until = now();
    const d = collectDigest(box.store, { since: until - 12 * HOUR, until, workflow: "docs" });
    assert.equal(d.workflow, "docs");
    assert.deepEqual(d.changes.map((c) => c.runId), [ids.changed]);
    assert.equal(d.failed.length + d.needsYou.length + d.unmet.length, 0);
    const quiet = collectDigest(box.store, { since: until - 60, until, workflow: "refactor" });
    assert.match(formatDigest(quiet), /Nothing needs you/);
    assert.match(digestLine(quiet), /nothing needs you · 0 runs$/);
  } finally {
    box.cleanup();
  }
});

test("--since takes 90m, 12h, 2d, 1w", () => {
  assert.equal(parseSince("90m"), 5400);
  assert.equal(parseSince("12h"), 43_200);
  assert.equal(parseSince("2d"), 172_800);
  assert.equal(parseSince("1w"), 604_800);
  for (const bad of ["12", "h", "-1h", "0h", "1y", ""]) assert.equal(parseSince(bad), null, bad);
});

test("odw digest: usage errors exit 2; --json and --markdown print the digest", async () => {
  const box = scratch();
  try {
    const ids = seed(box);
    const rr = ["--runs-root", box.runsRoot];
    for (const args of [["--since", "1h", "--since-last"], ["--json", "--markdown"], ["--since", "soon"], ["extra"]]) {
      const r = await capture(() => main(["digest", ...args, ...rr]));
      assert.equal(r.code, 2, args.join(" "));
    }
    const json = await capture(() => main(["digest", "--json", "--since", "12h", ...rr]));
    assert.equal(json.code, 0, json.err);
    const d = JSON.parse(json.out);
    assert.equal(d.version, 1);
    assert.equal(d.failed.find((f: { runId: string }) => f.runId === ids.failed).resume, `odw resume ${ids.failed} --runs-root ${box.runsRoot}`);
    const md = await capture(() => main(["digest", "--markdown", ...rr]));
    assert.equal(md.code, 0);
    assert.match(md.out, /^### odw digest · last 24h00m/);
    const text = await capture(() => main(["digest", ...rr]));
    assert.match(text.out, /Needs you \(2\)/);
    assert.ok(!text.out.includes(CLAIM));
  } finally {
    box.cleanup();
  }
});

/** A local webhook receiver: records each POSTed body, answers `status`. */
async function fakeWebhook(status = 200) {
  const posts: Array<Record<string, unknown>> = [];
  const server = createServer((req, res: ServerResponse) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => {
      posts.push(JSON.parse(data));
      res.statusCode = status;
      res.end(status === 200 ? "ok" : "no_service");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/YOUR/PATH`,
    posts,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function writeConfig(box: Box, notify: Record<string, unknown> | null, more: Record<string, unknown> = {}): string {
  const path = join(box.root, "odw.config.json");
  writeFileSync(path, JSON.stringify({ runsRoot: box.runsRoot, ...(notify ? { notify } : {}), ...more }));
  return path;
}

test("--notify posts the digest as JSON and markdown, with approve links, redacted; the mark moves and --since-last starts there", async () => {
  const box = scratch();
  const hook = await fakeWebhook();
  const saved = process.env.ODW_DIGEST_TEST_TOKEN;
  process.env.ODW_DIGEST_TEST_TOKEN = "digest-secret-value-4242";
  try {
    const ids = seed(box);
    fakeRun(box, "leaky", "failed", 1, [], { error: "failed with digest-secret-value-4242 in it" });
    // An odw serve --public-url answers links for this runs root.
    ensureApproveSecret(box.runsRoot);
    announceServe(box.runsRoot, "https://odw.example.com");
    const config = writeConfig(box, { webhook: hook.url, on: ["failed", "digest"] });

    assert.equal(readMark(box.runsRoot, null), null);
    const r = await capture(() => main(["digest", "--since-last", "--notify", "--config", config]));
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /odw digest: sent — odw digest · last 24h00m/);
    assert.equal(hook.posts.length, 1);
    const body = hook.posts[0]!;
    assert.equal(body.kind, "digest");
    assert.equal(body.state, "digest");
    assert.equal(body.redacted, true);
    assert.equal(typeof body.markdown, "string");
    assert.equal(body.text, body.markdown);
    assert.ok(!JSON.stringify(body).includes("digest-secret-value-4242"));
    assert.ok(!JSON.stringify(body).includes(CLAIM));
    const needs = body.needsYou as Array<Record<string, string>>;
    assert.equal(needs.length, 2);
    assert.match(needs[0]!.approveUrl!, /^https:\/\/odw\.example\.com\/approve\//);
    assert.match(needs[0]!.rejectUrl!, /^https:\/\/odw\.example\.com\/approve\//);
    assert.ok((body.markdown as string).includes(`[approve](${needs[0]!.approveUrl})`));
    assert.ok((body.failed as Array<{ runId: string }>).some((f) => f.runId === ids.failed));

    // The mark is where that digest ended; the next --since-last starts there.
    const mark = readMark(box.runsRoot, null);
    assert.ok(mark !== null && Math.abs(mark - now()) < 60);
    assert.ok(existsSync(join(box.runsRoot, DIGEST_DIR, MARKS_FILE)));
    const next = await capture(() => main(["digest", "--since-last", "--json", "--config", config]));
    const d = JSON.parse(next.out);
    assert.equal(d.sinceLast, true);
    assert.equal(d.since, mark);
    // Only what is still waiting stays: the failures were in the last digest.
    assert.equal(d.failed.length, 0);
    assert.equal(d.needsYou.length, 2);
    // Looking never moved it.
    assert.equal(readMark(box.runsRoot, null), mark);
  } finally {
    if (saved === undefined) delete process.env.ODW_DIGEST_TEST_TOKEN;
    else process.env.ODW_DIGEST_TEST_TOKEN = saved;
    await hook.close();
    box.cleanup();
  }
});

test("--notify: a failing webhook exits 1 and leaves the mark; no hook for digest is an error", async () => {
  const box = scratch();
  const hook = await fakeWebhook(500);
  try {
    seed(box);
    const config = writeConfig(box, { webhook: hook.url, on: ["digest"] });
    const r = await capture(() => main(["digest", "--since-last", "--notify", "--config", config]));
    assert.equal(r.code, 1);
    assert.match(r.err, /answered 500/);
    assert.ok(!r.err.includes("/hooks/YOUR/PATH"), "the webhook's secret path never reaches the log");
    assert.equal(hook.posts.length, 1);
    assert.equal(readMark(box.runsRoot, null), null);

    const off = writeConfig(box, { webhook: hook.url, on: ["failed"] });
    const r2 = await capture(() => main(["digest", "--notify", "--config", off]));
    assert.equal(r2.code, 1);
    assert.match(r2.err, /"notify\.on" does not list "digest"/);
    const none = writeConfig(box, null);
    const r3 = await capture(() => main(["digest", "--notify", "--config", none]));
    assert.equal(r3.code, 1);
    assert.match(r3.err, /no "notify" hook is configured/);
    assert.equal(hook.posts.length, 1);
  } finally {
    await hook.close();
    box.cleanup();
  }
});

test("--notify runs the notify command with the digest's files and one-line summary", async () => {
  const box = scratch();
  try {
    seed(box);
    const out = join(box.root, "hook-out.json");
    const script = join(box.root, "hook.mjs");
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from "node:fs";
const e = process.env;
writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  state: e.ODW_RUN_STATE, text: e.ODW_DIGEST_TEXT, since: e.ODW_DIGEST_SINCE, needs: e.ODW_DIGEST_NEEDS_YOU, failed: e.ODW_DIGEST_FAILED,
  json: JSON.parse(readFileSync(e.ODW_DIGEST_FILE, "utf8")), md: readFileSync(e.ODW_DIGEST_MARKDOWN_FILE, "utf8"),
  file: e.ODW_DIGEST_FILE,
}));
`,
    );
    const config = writeConfig(box, { command: [execPath, script], on: ["digest"] });
    const r = await capture(() => main(["digest", "--workflow", "nightly", "--notify", "--config", config]));
    assert.equal(r.code, 0, r.err);
    const got = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(got.state, "digest");
    assert.match(got.text, /^odw digest \(nightly\) · last 24h00m · 1 failed/);
    assert.equal(got.needs, "0");
    assert.equal(got.failed, "1");
    assert.equal(got.json.workflow, "nightly");
    assert.match(got.md, /\*\*Failed \(1\)\*\*/);
    assert.ok(!existsSync(got.file), "the digest's files are gone once the hook ran");
    // A workflow's mark is its own.
    assert.notEqual(readMark(box.runsRoot, "nightly"), null);
    assert.equal(readMark(box.runsRoot, null), null);
  } finally {
    box.cleanup();
  }
});

test("config: notify.on takes \"digest\"; digest.cron is checked", () => {
  const box = scratch();
  try {
    const at = (raw: unknown) => {
      const path = join(box.root, "c.json");
      writeFileSync(path, JSON.stringify(raw));
      return () => loadConfig(path, { quiet: true }).settings;
    };
    assert.deepEqual(at({ notify: { command: ["true"], on: ["digest", "failed"] } })().notify!.on, ["failed", "digest"]);
    assert.equal(at({})().digest, null);
    assert.deepEqual(at({ digest: { cron: "0 8 * * 1-5" } })().digest, { cron: "0 8 * * 1-5" });
    assert.throws(at({ digest: { cron: "8am" } }), /"digest\.cron"/);
    assert.throws(at({ digest: { cron: "0 8 * * *", at: 1 } }), /unknown key 'at'/);
    assert.throws(at({ digest: "0 8 * * *" }), /"digest" must be/);
  } finally {
    box.cleanup();
  }
});

const posix = { skip: process.platform === "win32" ? "the fake schedulers are /bin/sh scripts" : false };

test("odw schedule add --digest: the config's digest.cron, refused without a digest hook; schedule run sends it", posix, () =>
  withSandbox(async (box) => {
    const hook = await fakeWebhook();
    try {
      const runsRoot = join(box.root, "runs");
      const store = new RunStore(runsRoot);
      const write = (raw: Record<string, unknown>) => writeFileSync(join(box.proj, "odw.config.json"), JSON.stringify({ runsRoot, ...raw }));

      write({ notify: { webhook: hook.url, on: ["failed"] }, digest: { cron: "0 8 * * 1-5" } });
      const refused = await odw(["schedule", "add", "morning", "--digest", "--cwd", box.proj]);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /"notify\.on" does not list "digest"/);
      assert.equal(box.definitions().length, 0);

      write({ notify: { webhook: hook.url, on: ["digest"] } });
      const noCron = await odw(["schedule", "add", "morning", "--digest", "--cwd", box.proj]);
      assert.equal(noCron.code, 2);
      assert.match(noCron.err, /missing --cron/);
      const withWorkflow = await odw(["schedule", "add", "morning", "nightly", "--digest", "--cron", "0 8 * * *", "--cwd", box.proj]);
      assert.equal(withWorkflow.code, 2);

      write({ notify: { webhook: hook.url, on: ["digest"] }, digest: { cron: "0 8 * * 1-5" } });
      const added = await odw(["schedule", "add", "morning", "--digest", "--cwd", box.proj]);
      assert.equal(added.code, 0, added.err);
      assert.match(added.err, /added schedule 'morning': the digest \(odw digest --since-last --notify\) at "0 8 \* \* 1-5" through cron/);
      const [def] = box.definitions();
      assert.equal(def!.cron, "0 8 * * 1-5");
      assert.deepEqual(def!.digest, { workflow: null });
      assert.match(box.crontab()!, /^0 8 \* \* 1-5 .* schedule run morning >> /m);

      // A failed run in the window, then the OS entry fires.
      const script = join(box.root, "wf.js");
      writeFileSync(script, "return 1");
      const runId = store.create({ script, args: null, source: box.proj, workflowName: "nightly" });
      store.updateStatus(runId, { state: "failed" });
      store.writeError(runId, { error: "nightly broke" });
      const fired = await odw(["schedule", "run", "morning"]);
      assert.equal(fired.code, 0, fired.err);
      assert.equal(hook.posts.length, 1);
      assert.equal(hook.posts[0]!.kind, "digest");
      assert.deepEqual((hook.posts[0]!.failed as Array<{ runId: string }>).map((f) => f.runId), [runId]);
      assert.match(box.log("morning"), /sent: odw digest · last 24h00m · 1 failed/);
      const last = JSON.parse(readFileSync(join(box.stateDir, "morning.last.json"), "utf8"));
      assert.equal(last.state, "done");
      assert.equal(last.runId, null);
      assert.notEqual(readMark(runsRoot, null), null);

      // The next fire starts where that one ended: the failure is not sent again.
      const again = await odw(["schedule", "run", "morning"]);
      assert.equal(again.code, 0, again.err);
      assert.equal((hook.posts[1]!.failed as unknown[]).length, 0);
      assert.match(box.log("morning"), /sent: odw digest · since the last digest, .* · nothing needs you · 0 runs/);

      const list = await odw(["schedule", "list"]);
      assert.match(list.out, /morning\s+0 8 \* \* 1-5\s+cron\s+odw digest\s+done /);
    } finally {
      await hook.close();
    }
  }),
);
