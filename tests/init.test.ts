import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { writeDefaultAdapter } from "../src/adapters/config.js";
import { AdapterNotFound, ConfigError, isFatalError } from "../src/errors.js";
import { cmdInit, type InitFlags } from "../src/init.js";

/** A temp dir with `bin/` stubs for the given CLIs, plus an isolating config file. */
function sandbox(clis: string[]): { dir: string; configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odw-init-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const name of clis) {
    const stub = join(dir, "bin", name);
    writeFileSync(stub, "#!/bin/sh\n");
    chmodSync(stub, 0o755);
  }
  // An explicit config path keeps the test away from the developer's real
  // ./odw.config.json and ~/.config/odw/config.json.
  const configPath = join(dir, "odw.config.json");
  writeFileSync(configPath, "{}\n");
  const oldPath = process.env.PATH;
  process.env.PATH = join(dir, "bin");
  return {
    dir,
    configPath,
    cleanup: () => {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Fake stderr that records everything written. */
function sink(tty = false): PassThrough & { text(): string } {
  const s = new PassThrough() as PassThrough & { text(): string };
  (s as { isTTY?: boolean }).isTTY = tty;
  let buf = "";
  s.on("data", (c: Buffer) => (buf += String(c)));
  s.text = () => buf;
  return s;
}

function ttyInput(): PassThrough {
  const s = new PassThrough();
  (s as { isTTY?: boolean }).isTTY = true;
  return s;
}

test("init: non-TTY with several CLIs reports the gap, tells the agent what to run, exit 1", async () => {
  const sb = sandbox(["claude", "codex"]);
  try {
    const err = sink();
    const code = await cmdInit({ config: sb.configPath }, { input: sink(), err, env: {} });
    assert.equal(code, 1);
    assert.match(err.text(), /several agent CLIs are installed \(claude, codex\)/);
    assert.match(err.text(), /odw init --adapter <name>/);
    assert.match(err.text(), /not installed/); // the table marks the missing CLIs
  } finally {
    sb.cleanup();
  }
});

test("init: sole installed CLI already resolves — no setup needed, exit 0", async () => {
  const sb = sandbox(["claude"]);
  try {
    const err = sink();
    const code = await cmdInit({ config: sb.configPath }, { input: sink(), err, env: {} });
    assert.equal(code, 0);
    assert.match(err.text(), /a run resolves to claude — no setup needed/);
  } finally {
    sb.cleanup();
  }
});

test("init: no CLI installed at all reports it, exit 1", async () => {
  const sb = sandbox([]);
  try {
    const err = sink();
    const code = await cmdInit({ config: sb.configPath }, { input: sink(), err, env: {} });
    assert.equal(code, 1);
    assert.match(err.text(), /no agent CLI found on PATH/);
  } finally {
    sb.cleanup();
  }
});

test("init --adapter persists non-interactively and preserves sibling keys", async () => {
  const sb = sandbox(["claude", "codex"]);
  try {
    writeFileSync(sb.configPath, JSON.stringify({ concurrency: 3 }));
    const err = sink();
    const code = await cmdInit(
      { adapter: "codex", config: sb.configPath },
      { input: sink(), err, env: {} },
    );
    assert.equal(code, 0);
    assert.match(err.text(), /wrote defaultAdapter "codex"/);
    const cfg = JSON.parse(readFileSync(sb.configPath, "utf8"));
    assert.equal(cfg.defaultAdapter, "codex");
    assert.equal(cfg.concurrency, 3);
  } finally {
    sb.cleanup();
  }
});

test("init --adapter rejects an unknown name (usage error 2) and an uninstalled CLI (1)", async () => {
  const sb = sandbox(["claude"]);
  try {
    assert.equal(
      await cmdInit({ adapter: "nope", config: sb.configPath }, { input: sink(), err: sink(), env: {} }),
      2,
    );
    const err = sink();
    assert.equal(
      await cmdInit({ adapter: "codex", config: sb.configPath }, { input: sink(), err, env: {} }),
      1,
    );
    assert.match(err.text(), /'codex' is not on PATH/);
  } finally {
    sb.cleanup();
  }
});

test("init: interactive digit pick writes the chosen default", async () => {
  const sb = sandbox(["claude", "codex"]);
  try {
    const input = ttyInput();
    const err = sink(true);
    const done = cmdInit({ config: sb.configPath }, { input, err, env: { TERM: "xterm" } });
    input.write("2\n"); // listAdapters sorts by name: 1) claude 2) codex
    const code = await done;
    assert.equal(code, 0);
    assert.match(err.text(), /wrote defaultAdapter "codex"/);
    assert.equal(JSON.parse(readFileSync(sb.configPath, "utf8")).defaultAdapter, "codex");
  } finally {
    sb.cleanup();
  }
});

test("init: interactive Enter skips without writing, exit 1", async () => {
  const sb = sandbox(["claude", "codex"]);
  try {
    const input = ttyInput();
    const err = sink(true);
    const done = cmdInit({ config: sb.configPath }, { input, err, env: { TERM: "xterm" } });
    input.write("\n");
    assert.equal(await done, 1);
    assert.match(err.text(), /skipped — nothing written/);
    assert.equal(JSON.parse(readFileSync(sb.configPath, "utf8")).defaultAdapter, undefined);
  } finally {
    sb.cleanup();
  }
});

test("init: --check forces report-only even at a TTY; CI/ODW_DETACH/dumb TERM do too", async () => {
  const sb = sandbox(["claude", "codex"]);
  try {
    const cases: Array<readonly [InitFlags, Record<string, string | undefined>]> = [
      [{ check: true }, { TERM: "xterm" }],
      [{}, { TERM: "xterm", CI: "1" }],
      [{}, { TERM: "xterm", ODW_DETACH: "1" }],
      [{}, { TERM: "dumb" }],
    ];
    if (process.platform !== "win32") cases.push([{}, {}]); // POSIX requires TERM; Windows consoles do not set it.
    for (const [flags, env] of cases) {
      const err = sink(true);
      const code = await cmdInit(
        { ...flags, config: sb.configPath },
        { input: ttyInput(), err, env: env as Record<string, string | undefined> },
      );
      assert.equal(code, 1);
      assert.match(err.text(), /odw init --adapter <name>/, "must report, not prompt");
    }
  } finally {
    sb.cleanup();
  }
});

test("writeDefaultAdapter targets the user-global file and warns when shadowed by ./odw.config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-write-"));
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  try {
    process.env.HOME = dir;
    mkdirSync(join(dir, "project"));
    process.chdir(join(dir, "project"));

    const clean = writeDefaultAdapter("claude");
    assert.equal(clean.path, join(dir, ".config", "odw", "config.json"));
    assert.equal(clean.shadowWarning, null);
    assert.equal(JSON.parse(readFileSync(clean.path, "utf8")).defaultAdapter, "claude");

    writeFileSync(join(dir, "project", "odw.config.json"), "{}");
    const shadowed = writeDefaultAdapter("codex");
    assert.ok(shadowed.shadowWarning, "expected a shadow warning");
    assert.match(shadowed.shadowWarning!, /takes precedence/);
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config errors are fatal: they must not become silent null slots in parallel()", () => {
  assert.equal(isFatalError(new AdapterNotFound("x")), true);
  assert.equal(isFatalError(new ConfigError("x")), true);
  assert.equal(isFatalError(new Error("x")), false);
});

test("init: --check with --adapter is a usage error and writes nothing", async () => {
  const sb = sandbox(["claude"]);
  try {
    const err = sink();
    const code = await cmdInit(
      { adapter: "claude", check: true, config: sb.configPath },
      { input: sink(), err, env: {} },
    );
    assert.equal(code, 2);
    assert.match(err.text(), /--check and --adapter cannot be combined/);
    assert.equal(JSON.parse(readFileSync(sb.configPath, "utf8")).defaultAdapter, undefined);
  } finally {
    sb.cleanup();
  }
});

test("init --adapter bootstraps a --config file that does not exist yet", async () => {
  const sb = sandbox(["claude"]);
  try {
    const fresh = join(sb.dir, "brand-new.json");
    const code = await cmdInit(
      { adapter: "claude", config: fresh },
      { input: sink(), err: sink(), env: {} },
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(fresh, "utf8")).defaultAdapter, "claude");
  } finally {
    sb.cleanup();
  }
});

test("init: a configured default whose CLI is missing is NOT an all-clear", async () => {
  const sb = sandbox(["codex"]); // claude configured as default but not on PATH
  try {
    writeFileSync(sb.configPath, JSON.stringify({ defaultAdapter: "claude" }));
    const err = sink();
    const code = await cmdInit({ config: sb.configPath }, { input: sink(), err, env: {} });
    assert.equal(code, 1);
    assert.match(err.text(), /defaultAdapter "claude" is set but its CLI is not on PATH/);
    assert.match(err.text(), /odw init --adapter codex/);
    assert.doesNotMatch(err.text(), /no setup needed/);
  } finally {
    sb.cleanup();
  }
});

test("init: CI='' (set but empty) counts as NOT CI — the prompt still fires", async () => {
  const sb = sandbox(["claude", "codex"]);
  try {
    const input = ttyInput();
    const err = sink(true);
    const done = cmdInit(
      { config: sb.configPath },
      { input, err, env: { TERM: "xterm", CI: "" } },
    );
    input.write("\n"); // reaching the prompt at all is the assertion
    assert.equal(await done, 1);
    assert.match(err.text(), /skipped — nothing written/);
  } finally {
    sb.cleanup();
  }
});

test("writeDefaultAdapter honours $ODW_CONFIG and suppresses the shadow warning there", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-envcfg-"));
  const oldEnv = process.env.ODW_CONFIG;
  const oldCwd = process.cwd();
  try {
    const target = join(dir, "env-config.json");
    writeFileSync(target, JSON.stringify({ concurrency: 2 }));
    process.env.ODW_CONFIG = target;
    // A ./odw.config.json cannot shadow $ODW_CONFIG (env wins in the search order).
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "project", "odw.config.json"), "{}");
    process.chdir(join(dir, "project"));

    const w = writeDefaultAdapter("codex");
    assert.equal(w.path, target);
    assert.equal(w.shadowWarning, null);
    const cfg = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(cfg.defaultAdapter, "codex");
    assert.equal(cfg.concurrency, 2);
  } finally {
    process.chdir(oldCwd);
    if (oldEnv === undefined) delete process.env.ODW_CONFIG;
    else process.env.ODW_CONFIG = oldEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the odw run/rerun launch preflight ---------------------------------------

import { warnIfNoDefaultAdapter } from "../src/cli.js";

function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test("run preflight warns on an ambiguous default, stays quiet when resolved or explicit", () => {
  const sb = sandbox(["claude", "codex"]);
  try {
    const out = captureStderr(() =>
      warnIfNoDefaultAdapter(null, sb.configPath, null, "run"),
    );
    assert.match(out, /odw run: warning: bare agent\(\) calls in this run will fail/);

    writeFileSync(sb.configPath, JSON.stringify({ defaultAdapter: "claude" }));
    assert.equal(captureStderr(() => warnIfNoDefaultAdapter(null, sb.configPath, null, "run")), "");
    assert.equal(captureStderr(() => warnIfNoDefaultAdapter("codex", sb.configPath, null, "run")), "");
  } finally {
    sb.cleanup();
  }
});

test("run preflight reads the config through the WORKER's eyes: --source, not launcher cwd", () => {
  const sb = sandbox(["claude", "codex"]);
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  try {
    process.env.HOME = sb.dir; // keep the developer's real ~/.config out of the search
    const launcherCwd = join(sb.dir, "launcher");
    const sourceDir = join(sb.dir, "source");
    mkdirSync(launcherCwd);
    mkdirSync(sourceDir);
    process.chdir(launcherCwd);

    // Case A (was a false alarm): the SOURCE dir has a default; launcher cwd has none.
    writeFileSync(join(sourceDir, "odw.config.json"), JSON.stringify({ defaultAdapter: "claude" }));
    assert.equal(captureStderr(() => warnIfNoDefaultAdapter(null, null, sourceDir, "run")), "");

    // Case B (was a missed alarm): the launcher cwd has a default; the source dir does not.
    rmSync(join(sourceDir, "odw.config.json"));
    writeFileSync(join(launcherCwd, "odw.config.json"), JSON.stringify({ defaultAdapter: "claude" }));
    assert.match(
      captureStderr(() => warnIfNoDefaultAdapter(null, null, sourceDir, "run")),
      /warning: bare agent\(\) calls in this run will fail/,
    );
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    sb.cleanup();
  }
});

// The first run, for $0 (ODW extension): at a keyboard init offers `odw new
// hello` and runs `odw run hello --dry` — every agent stubbed — then prints
// the dashboard command and the real run; elsewhere it only prints the commands.
import { main } from "../src/cli.js";
import { RunStore } from "../src/runtime/run-store.js";

test("init at a fake TTY: Enter writes hello and dry-runs it — no model called — then names the dashboard and the real run", async () => {
  const sb = sandbox(["claude"]);
  const runs = join(sb.dir, "runs");
  const was = process.cwd();
  const se = process.stderr.write.bind(process.stderr);
  const dryErr: string[] = [];
  const calls: string[][] = [];
  try {
    const input = ttyInput();
    const err = sink(true);
    const done = cmdInit(
      { config: sb.configPath },
      {
        input,
        err,
        env: { TERM: "xterm" },
        cwd: sb.dir,
        // The real `odw run hello --dry`, from the project, its output captured.
        runDry: async (argv) => {
          calls.push(argv);
          process.chdir(sb.dir);
          (process.stderr as { write: unknown }).write = (s: unknown) => (dryErr.push(String(s)), true);
          try {
            return await main([...argv, "--wait", "--runs-root", runs, "--config", sb.configPath]);
          } finally {
            process.stderr.write = se;
            process.chdir(was);
          }
        },
      },
    );
    input.write("\n"); // the default: yes
    const code = await done;
    assert.equal(code, 0, err.text() + dryErr.join(""));
    assert.deepEqual(calls, [["run", "hello", "--dry"]]);
    const text = err.text().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    assert.match(text, /a run resolves to claude — no setup needed/);
    assert.match(text, /try a first run for \$0\? write \.odw\/workflows\/hello\.js \(odw new hello\) and run it with --dry/);
    assert.match(text, /wrote \.odw\/workflows\/hello\.js\n.*wrote \.odw\/tests\/hello\.json/);
    assert.match(text, /odw serve --open/);
    assert.match(text, /odw run hello {2,}the real run: it calls your agent CLI/);
    assert.match(readFileSync(join(sb.dir, ".odw", "workflows", "hello.js"), "utf8"), /name: 'hello'/);
    assert.match(readFileSync(join(sb.dir, ".odw", "tests", "hello.json"), "utf8"), /"workflow": "hello"/);
    assert.match(dryErr.join(""), /dry run \S+ done: 2 agents started, no model called \(\$0\)/);
    const store = new RunStore(runs);
    const [ref] = store.listRuns();
    assert.equal(store.readMeta(ref!.runId).dry, true);
    assert.equal(store.readStatus(ref!.runId).state, "done");
  } finally {
    process.stderr.write = se;
    process.chdir(was);
    sb.cleanup();
  }
});

test("init at a fake TTY: 'n' declines the first run — nothing written, nothing run", async () => {
  const sb = sandbox(["claude"]);
  try {
    const input = ttyInput();
    const err = sink(true);
    let ran = false;
    const done = cmdInit({ config: sb.configPath }, { input, err, env: { TERM: "xterm" }, cwd: sb.dir, runDry: async () => ((ran = true), 0) });
    input.write("n\n");
    assert.equal(await done, 0);
    assert.equal(ran, false);
    assert.match(err.text(), /later: odw new hello && odw run hello --dry/);
    assert.throws(() => readFileSync(join(sb.dir, ".odw", "workflows", "hello.js")));
  } finally {
    sb.cleanup();
  }
});

test("init off a terminal (or --check) never runs anything: it names the $0 first run, or not at all", async () => {
  const sb = sandbox(["claude"]);
  try {
    let ran = false;
    const runDry = async () => ((ran = true), 0);
    const err = sink();
    assert.equal(await cmdInit({ config: sb.configPath }, { input: sink(), err, env: {}, cwd: sb.dir, runDry }), 0);
    assert.match(err.text(), /first run, for \$0 \(every agent stubbed, no model called\): odw new hello && odw run hello --dry/);
    const checked = sink(true);
    assert.equal(
      await cmdInit({ config: sb.configPath, check: true }, { input: ttyInput(), err: checked, env: { TERM: "xterm" }, cwd: sb.dir, runDry }),
      0,
    );
    assert.doesNotMatch(checked.text(), /first run/);
    assert.equal(ran, false);
  } finally {
    sb.cleanup();
  }
});

test("init with hello already there dry-runs it as it is", async () => {
  const sb = sandbox(["claude"]);
  try {
    mkdirSync(join(sb.dir, ".odw", "workflows"), { recursive: true });
    writeFileSync(join(sb.dir, ".odw", "workflows", "hello.js"), "// mine\nreturn 1\n");
    const input = ttyInput();
    const err = sink(true);
    const calls: string[][] = [];
    const done = cmdInit(
      { config: sb.configPath },
      { input, err, env: { TERM: "xterm" }, cwd: sb.dir, runDry: async (argv) => (calls.push(argv), 0) },
    );
    input.write("y\n");
    assert.equal(await done, 0);
    assert.deepEqual(calls, [["run", "hello", "--dry"]]);
    assert.match(err.text(), /run \.odw\/workflows\/hello\.js with --dry/);
    assert.equal(readFileSync(join(sb.dir, ".odw", "workflows", "hello.js"), "utf8"), "// mine\nreturn 1\n");
  } finally {
    sb.cleanup();
  }
});
