import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

// @ts-expect-error -- a plain ESM script (the Action's runner has no TypeScript); its exports are checked here.
import * as action from "../action/odw-action.mjs";
import { parseArgsValue } from "../src/cli.js";

// The composite GitHub Action (action/action.yml) cannot run here: these
// test the script its steps run — each decision as a pure function, and the
// run and summary steps end to end against a stand-in `odw` on PATH.

const script = fileURLToPath(new URL("../action/odw-action.mjs", import.meta.url));
const actionYml = readFileSync(fileURLToPath(new URL("../action/action.yml", import.meta.url)), "utf8");

test("version: the input, else the action's own package version; nothing else", () => {
  assert.equal(action.resolveVersion("v0.7.1", '{"version":"0.5.0"}'), "0.7.1");
  assert.equal(action.resolveVersion("", '{"version":"0.7.0"}'), "0.7.0");
  assert.throws(() => action.resolveVersion("latest", "{}"), /version must be a release/);
  assert.throws(() => action.resolveVersion("1.0; rm -rf /", "{}"), /version must be a release/);
});

test("install: a release without published checksums is refused, not installed with a warning (review fix)", () => {
  for (const version of ["0.4.0", "0.4.9", "0.4.0-rc.1", "0.1.0"]) {
    assert.throws(() => action.requireChecksums(version), /predates published checksums/, version);
  }
  for (const version of ["0.5.0", "0.5.0-rc.1", "0.5.1", "0.9.0", "1.0.0"]) assert.equal(action.requireChecksums(version), version);
  // The install step tells install.sh the same, and never allows an unverified binary.
  const src = readFileSync(script, "utf8");
  assert.match(src, /ODW_ALLOW_UNVERIFIED: "", ODW_REQUIRE_CHECKSUMS: "1"/);
});

test("untrusted: auto for fork PRs and events anyone can write; explicit values win", () => {
  const pr = (head: string, fork = false) => ({ pull_request: { head: { repo: { full_name: head, fork } }, base: { repo: { full_name: "acme/app" } } } });
  assert.equal(action.untrustedFor("auto", "pull_request", pr("someone/app", true)), true);
  assert.equal(action.untrustedFor("auto", "pull_request_target", pr("someone/app", true)), true);
  assert.equal(action.untrustedFor("auto", "pull_request", pr("acme/app")), false, "a branch of the same repository");
  assert.equal(action.untrustedFor("auto", "pull_request", {}), true, "unknown head: untrusted");
  // pull_request_target runs with the base's secrets: untrusted whatever the head (review fix).
  assert.equal(action.untrustedFor("auto", "pull_request_target", pr("acme/app")), true);
  // workflow_run after a fork's run: its head repository is not this one (review fix).
  const run = (head: string | undefined) => ({ workflow_run: { head_repository: head ? { full_name: head } : null }, repository: { full_name: "acme/app" } });
  assert.equal(action.untrustedFor("auto", "workflow_run", run("someone/app")), true);
  assert.equal(action.untrustedFor("auto", "workflow_run", run(undefined)), true, "unknown head: untrusted");
  assert.equal(action.untrustedFor("auto", "workflow_run", run("acme/app")), false, "a run of this repository");
  for (const event of ["issues", "issue_comment", "pull_request_review_comment", "discussion"]) {
    assert.equal(action.untrustedFor("auto", event, {}), true, event);
  }
  for (const event of ["push", "schedule", "workflow_dispatch"]) assert.equal(action.untrustedFor("auto", event, {}), false, event);
  assert.equal(action.untrustedFor("true", "push", {}), true);
  assert.equal(action.untrustedFor("false", "issues", {}), false);
  assert.throws(() => action.untrustedFor("maybe", "push", {}), /auto, true or false/);
});

test("deadline: the job's timeout less the margin and the time already spent", () => {
  assert.equal(action.deadlineSeconds({ timeoutMinutes: "30", marginSeconds: "300" }), 1500);
  assert.equal(action.deadlineSeconds({ timeoutMinutes: "30", marginSeconds: "300", elapsedSeconds: 42.5 }), 1457);
  assert.equal(action.deadlineSeconds({ timeoutMinutes: "360", marginSeconds: "0" }), 21600);
  assert.throws(() => action.deadlineSeconds({ timeoutMinutes: "5", marginSeconds: "300" }), /leaves no time/);
  assert.throws(() => action.deadlineSeconds({ timeoutMinutes: "soon", marginSeconds: "300" }), /timeout-minutes/);
  assert.throws(() => action.deadlineSeconds({ timeoutMinutes: "30", marginSeconds: "-1" }), /margin-seconds/);
});

test("the odw run argv: --wait --deadline, --untrusted when untrusted, the optional inputs", () => {
  assert.deepEqual(action.runArgv({ workflow: "review" }, 1500, false), ["run", "review", "--wait", "--deadline", "1500"]);
  assert.deepEqual(
    action.runArgv({ workflow: ".odw/workflows/fix.js", args: '{"issue":7}', config: "ci.json", adapter: "codex", permissions: "edit" }, 60, true, "/tmp/r/args.txt"),
    ["run", ".odw/workflows/fix.js", "--wait", "--deadline", "60", "--untrusted", "--untrusted-input", "--args=@/tmp/r/args.txt", "--config=ci.json", "--adapter=codex", "--permissions=edit"],
  );
  // The args input is never an argument of its own (review fix): it goes through the file.
  for (const args of ["@/proc/self/environ", "--untrusted=false", "-x"]) {
    const argv = action.runArgv({ workflow: "review", args }, 60, false, "/tmp/r/args.txt");
    assert.deepEqual(argv.slice(5), ["--args=@/tmp/r/args.txt"], args);
    assert.ok(!argv.includes(args), args);
  }
  assert.throws(() => action.runArgv({ workflow: "review", args: "x" }, 60, false), /needs a file/);
  assert.throws(() => action.runArgv({ workflow: "--help" }, 60, false), /a path or a workflow name/);
  assert.throws(() => action.runArgv({ workflow: " " }, 60, false), /workflow input is required/);
  assert.equal(action.runIdFrom("odw: note\nrunning 20261018-120000-abc123 ...\npermissions: edit\n"), "20261018-120000-abc123");
  assert.equal(action.runIdFrom("nothing here"), null);
  assert.deepEqual([0, 1, 3, 124, 2].map(action.stateFor), ["done", "failed", "stopped-at-deadline", "timed-out", "failed"]);
});

const STATUS = [
  "20261018-120000-abc123  [stopped]  review",
  "  dispatched: 3 agent(s)",
  "  usage: 12.3k tokens · $0.42",
  "  spend by phase (share of cost):",
  "    01  Review  2 agents  10.1k  $0.40  95%  ███████",
  "    ··  outside phases  1 agent  2.2k  $0.02  5%  █",
  "  CLIs: claude 2.1.0",
  "  resumed from: x",
].join("\n");

test("summary: outcome, spend receipt, agent table and failures — all agent text escaped", () => {
  const md = action.renderSummary({
    runId: "20261018-120000-abc123",
    workflow: "review",
    exitCode: 3,
    statusText: `\u001b[1m${STATUS}\u001b[0m`,
    agents: [
      { agentId: 0, state: "done", label: "scan | files", phase: "Review", adapter: "claude", durationMs: 65_000, preview: "<script>alert(1)</script> ```" },
      { agentId: 1, state: "failed", label: "fix", phase: "Review", adapter: "codex", durationMs: 1200, error: "quota\nexceeded" },
      { agentId: 2, state: "running", label: "slow", phase: null, adapter: "claude", durationMs: null, preview: null },
    ],
    runError: "run was stopped at its deadline (--deadline 1500); finished agents kept: 1",
  });
  assert.match(md, /^## ⏱️ odw · review · stopped-at-deadline/);
  assert.match(md, /stopped: its finished agents and their diffs are kept in the bundle/);
  assert.match(md, /### Spend\n\n```text\n {2}dispatched: 3 agent\(s\)\n {2}usage: 12\.3k tokens · \$0\.42\n {2}spend by phase/);
  assert.match(md, /CLIs: claude 2\.1\.0\n```/);
  assert.doesNotMatch(md, /resumed from/, "only the receipt");
  assert.doesNotMatch(md, /\u001b/);
  assert.match(md, /\| 0 \| done \| scan \\\| files \| Review \| claude \| 1m05s \| &lt;script&gt;alert\(1\)&lt;\/script&gt; ''' \|/);
  assert.match(md, /\| 1 \| failed \| fix \| Review \| codex \| 1s \| quota exceeded \|/);
  assert.match(md, /### Failures\n\n- \*\*fix\*\* \(agent 1\): quota exceeded\n- \*\*run\*\*: run was stopped at its deadline/);
  assert.match(md, /download the `odw-20261018-120000-abc123` artifact/);

  const done = action.renderSummary({ runId: "r1", workflow: "w", exitCode: 0, statusText: "r1 [done] w\n  dispatched: 0 agent(s)\n", agents: [] });
  assert.match(done, /^## ✅ odw · w · done/);
  assert.doesNotMatch(done, /### Agents|### Failures/);
  // A receipt quoting backticks gets a longer fence.
  const fenced = action.renderSummary({ runId: "r", workflow: "w", exitCode: 1, statusText: "  usage: ````x", agents: [] });
  assert.match(fenced, /`````text\n {2}usage: ````x\n`````/);
});

test("action.yml: every step runs a subcommand the script has; no expression lands in a shell script", () => {
  for (const step of actionYml.matchAll(/odw-action\.mjs" (\w+)/g)) assert.ok(["install", "run", "summary"].includes(step[1]!), step[1]);
  const declared = new Set([...actionYml.matchAll(/^ {2}([a-z][a-z-]*):\n {4}description:/gm)].map((m) => m[1]));
  for (const used of actionYml.matchAll(/\$\{\{[^}]*inputs\.([a-z-]+)/g)) assert.ok(declared.has(used[1]!), `input ${used[1]} is declared`);
  // Inputs reach scripts through env only (no ${{ }} inside run: blocks: script injection).
  const lines = actionYml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run: (.*)$/.exec(lines[i]!);
    if (!m) continue;
    const body = [m[2]!];
    for (let j = i + 1; j < lines.length && (lines[j]!.trim() === "" || lines[j]!.search(/\S/) > m[1]!.length); j++) body.push(lines[j]!);
    assert.doesNotMatch(body.join("\n"), /\$\{\{/, `the run: at line ${i + 1}`);
  }
  assert.match(actionYml, /--wait --deadline/);
  assert.match(actionYml, /using: composite/);
});

/** A stand-in `odw` on PATH: records its argv, answers run/status/agents as a stopped run would. */
function fakeOdw(dir: string, runExit: number): string {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const js = join(bin, "odw.mjs");
  writeFileSync(
    js,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "argv.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
const [cmd] = process.argv.slice(2);
if (cmd === "run") {
  process.stderr.write("running 20261018-120000-fake01 ...\\n");
  process.stdout.write(JSON.stringify({ state: "stopped", reason: "deadline", finished: [] }) + "\\n");
  process.stderr.write("run was stopped at its deadline (--deadline 60); finished agents kept: 0\\n");
  process.exit(${runExit});
}
if (cmd === "status") process.stdout.write("x [stopped] demo\\n  dispatched: 1 agent(s)\\n");
if (cmd === "agents") process.stdout.write(JSON.stringify([{ agentId: 0, state: "failed", label: "a", error: "boom" }]));
`,
  );
  writeFileSync(join(bin, "odw"), `#!/bin/sh\nexec ${JSON.stringify(execPath)} ${JSON.stringify(js)} "$@"\n`, { mode: 0o755 });
  return bin;
}

test("the run and summary steps, against a stand-in odw", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-action-"));
  try {
    const bin = fakeOdw(dir, 3);
    const output = join(dir, "output.txt");
    const summary = join(dir, "summary.md");
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { head: { repo: { full_name: "fork/app", fork: true } }, base: { repo: { full_name: "acme/app" } } } }));
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: event,
      ODW_INPUT_WORKFLOW: "review",
      ODW_INPUT_TIMEOUT_MINUTES: "10",
      ODW_INPUT_MARGIN_SECONDS: "120",
    };
    const run = spawnSync(execPath, [script, "run"], { env, encoding: "utf8" });
    assert.equal(run.status, 3, run.stderr);
    const argv = JSON.parse(readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n")[0]!) as string[];
    assert.deepEqual(argv.slice(0, 4), ["run", "review", "--wait", "--deadline"]);
    assert.ok(Number(argv[4]) > 470 && Number(argv[4]) <= 480, argv[4]);
    assert.ok(argv.includes("--untrusted"), "a fork's pull request runs untrusted");
    assert.ok(argv.includes("--untrusted-input"), "and its input is untrusted input");
    const outputs = readFileSync(output, "utf8");
    assert.match(outputs, /^run-id=20261018-120000-fake01$/m);
    assert.match(outputs, /^exit-code=3$/m);
    assert.match(outputs, /^state=stopped-at-deadline$/m);
    assert.match(outputs, /^untrusted=true$/m);
    assert.match(outputs, /^untrusted-input=true$/m);

    const sum = spawnSync(execPath, [script, "summary"], {
      env: { ...env, ODW_INPUT_RUN_ID: "20261018-120000-fake01", ODW_INPUT_EXIT_CODE: "3" },
      encoding: "utf8",
    });
    assert.equal(sum.status, 0, sum.stderr);
    const md = readFileSync(summary, "utf8");
    assert.match(md, /odw · review · stopped-at-deadline/);
    assert.match(md, /dispatched: 1 agent\(s\)/);
    assert.match(md, /- \*\*a\*\* \(agent 0\): boom/);
    assert.match(md, /- \*\*run\*\*: run was stopped at its deadline/);

    // An args input that looks like a file to read or a flag goes through a file, as given (review fix).
    for (const args of ["@/proc/self/environ", "-x --untrusted=false"]) {
      const again = spawnSync(execPath, [script, "run"], { env: { ...env, ODW_INPUT_ARGS: args }, encoding: "utf8" });
      assert.equal(again.status, 3, again.stderr);
      const logged = readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const passed = logged.filter((a) => a[0] === "run").at(-1)!;
      const file = join(dir, "odw-action", "args.txt");
      assert.equal(passed.at(-1), `--args=@${file}`);
      assert.equal(readFileSync(file, "utf8"), args);
      // odw reads that file once, and takes its text as a plain string: no second @, no flag.
      assert.equal(parseArgsValue(`@${file}`), args);
    }

    // Untrusted input, and a token actions/checkout left in git's config: named — never shown — on stderr and in the summary (review fix).
    const header = ["AUTHORIZATION: basic ", "eC1hY2Nlc3M", "6ZmFrZQ=="].join("");
    const persisted = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: header };
    writeFileSync(summary, "");
    const warned = spawnSync(execPath, [script, "run"], { env: { ...env, ...persisted }, cwd: dir, encoding: "utf8" });
    assert.equal(warned.status, 3, warned.stderr);
    assert.match(warned.stderr, /::warning::odw action: untrusted input, and git's config holds an HTTP auth header \(http\.https:\/\/github\.com\/\.extraheader\)/);
    assert.match(warned.stderr, /persist-credentials: false/);
    assert.match(readFileSync(summary, "utf8"), /^> ⚠️ untrusted input, and git's config holds an HTTP auth header/m);
    assert.ok(!warned.stderr.includes("eC1hY2Nlc3M") && !readFileSync(summary, "utf8").includes("eC1hY2Nlc3M"), "the token itself is never printed");
    // The user's own input, or nothing persisted: no warning.
    const own = spawnSync(execPath, [script, "run"], { env: { ...env, ...persisted, ODW_INPUT_UNTRUSTED_INPUT: "false" }, cwd: dir, encoding: "utf8" });
    assert.ok(!own.stderr.includes("::warning::"), own.stderr);
    const clean = spawnSync(execPath, [script, "run"], { env, cwd: dir, encoding: "utf8" });
    assert.ok(!clean.stderr.includes("extraheader"), clean.stderr);

    // A timeout too short for the margin fails the step before anything runs.
    const tooShort = spawnSync(execPath, [script, "run"], { env: { ...env, ODW_INPUT_TIMEOUT_MINUTES: "1" }, encoding: "utf8" });
    assert.equal(tooShort.status, 1);
    assert.match(tooShort.stderr, /::error::odw action: timeout-minutes 1 leaves no time/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a token actions/checkout persisted: its config names are read, never its value, and a warning names them", () => {
  assert.deepEqual(action.EXTRAHEADER_PATTERNS, ["^http\\..*\\.extraheader$", "^http\\.extraheader$"]);
  assert.deepEqual(action.configNames("http.https://github.com/.extraheader AUTHORIZATION: basic x\nhttp.extraheader y\n"), [
    "http.https://github.com/.extraheader",
    "http.extraheader",
  ]);
  assert.deepEqual(action.configNames(""), []);
  assert.equal(action.persistedCredentialsWarning([]), null);
  assert.match(action.persistedCredentialsWarning(["http.extraheader"]) as string, /\(http\.extraheader\).*persist-credentials: false/);
  // The docs' examples (a fork's PR, an issue) check out without persisting the token; apply-pr pushes through gh instead.
  const docs = readFileSync(fileURLToPath(new URL("../docs/github-action.md", import.meta.url)), "utf8");
  const checkouts = [...docs.matchAll(/- uses: actions\/checkout@v4\n(?: {8}.*\n)*/g)].map((m) => m[0]);
  assert.ok(checkouts.length >= 2);
  for (const step of checkouts) assert.match(step, /persist-credentials: false/);
  assert.match(actionYml, /GIT_CONFIG_KEY_0: credential\.https:\/\/github\.com\.helper\n\s+GIT_CONFIG_VALUE_0: "!gh auth git-credential"/);
});

test("untrusted-input follows untrusted unless the job says otherwise, and only the run step's answer adds --accept-untrusted-input to apply --pr", () => {
  assert.equal(action.untrustedInputFor("auto", true), true);
  assert.equal(action.untrustedInputFor("", false), false);
  assert.equal(action.untrustedInputFor("false", true), false);
  assert.equal(action.untrustedInputFor("TRUE", false), true);
  assert.throws(() => action.untrustedInputFor("maybe", true), /untrusted-input must be auto, true or false/);
  const argv = action.runArgv({ workflow: "fix" }, 60, true, null, false) as string[];
  assert.ok(argv.includes("--untrusted") && !argv.includes("--untrusted-input"), "an issue workflow that must write opts out knowingly");
  assert.ok((action.runArgv({ workflow: "fix" }, 60, false, null, true) as string[]).includes("--untrusted-input"));
  assert.match(actionYml, /ODW_INPUT_UNTRUSTED_INPUT: \$\{\{ inputs\.untrusted-input \}\}/);
  assert.match(actionYml, /\[ "\$UNTRUSTED_INPUT" != "true" \] \|\| set -- "\$@" --accept-untrusted-input/);
});
