/**
 * `odw schedule run` and its lock: what the OS entry calls. Runs go through
 * the real launcher and worker against a mock adapter; the scheduler side is
 * the fakes of schedule-fixture.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { RunStore } from "../src/runtime/run-store.js";
import { acquireLock, localIso } from "../src/schedule/store.js";
import { capture, odw, withSandbox, type Sandbox } from "./schedule-fixture.js";

const posix = { skip: process.platform === "win32" ? "the fake schedulers are /bin/sh scripts" : false };
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const STAMP = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d`;
const RUN_ID = String.raw`\d{8}-\d{6}-[0-9a-f]{6}`;

/** A pid that is certainly not running: a process that already exited. */
function deadPid(): number {
  const done = spawnSync(execPath, ["-e", ""]);
  assert.equal(done.status, 0);
  return done.pid!;
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "odw-lock-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/** Adds the test schedule; cron unless a test names a backend (the platform default is launchd on macOS). */
function add(box: Sandbox, ...extra: string[]) {
  const backend = extra.includes("--backend") ? [] : ["--backend", "cron"];
  return odw(["schedule", "add", "nightly", "nightly", "--cron", "0 8 * * *", "--cwd", box.proj, ...backend, ...extra]);
}

function lastRun(box: Sandbox, name = "nightly"): Record<string, unknown> {
  return JSON.parse(readFileSync(join(box.stateDir, `${name}.last.json`), "utf8")) as Record<string, unknown>;
}

// --- the lock -----------------------------------------------------------------------

test("the lock is created once, holding pid and start time; a second taker sees the holder", () => {
  withDir((dir) => {
    const path = join(dir, "nightly.lock");
    const first = acquireLock(path);
    assert.equal(first.acquired, true);
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid: number; startedAt: string };
    assert.equal(held.pid, process.pid);
    assert.match(held.startedAt, new RegExp(`^${STAMP}$`));

    const second = acquireLock(path);
    assert.deepEqual(second, { acquired: false, holder: held });

    if (first.acquired) first.lock.release();
    assert.equal(existsSync(path), false);
    const third = acquireLock(path);
    assert.equal(third.acquired, true);
  });
});

test("a lock whose holder is dead is stale and taken over", () => {
  withDir((dir) => {
    const path = join(dir, "nightly.lock");
    writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: localIso(new Date()) }));
    const attempt = acquireLock(path);
    assert.equal(attempt.acquired, true);
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid, process.pid);
    assert.equal(existsSync(`${path}.takeover`), false, "the takeover token is gone");
  });
});

test("a dead holder whose run still goes on keeps the lock", () => {
  withDir((dir) => {
    const path = join(dir, "nightly.lock");
    const holder = { pid: deadPid(), startedAt: localIso(new Date()), runId: "20261017-080000-abcdef", runsRoot: "/runs" };
    writeFileSync(path, JSON.stringify(holder));
    assert.deepEqual(acquireLock(path, { runActive: (h) => h.runId === holder.runId }), { acquired: false, holder });
    assert.equal(acquireLock(path, { runActive: () => false }).acquired, true, "once the run is over, it is stale");
  });
});

test("a lock taken before the machine booted is stale, even if its pid is alive again", () => {
  withDir((dir) => {
    const path = join(dir, "nightly.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: "2026-10-17T03:00:00+00:00" }));
    assert.equal(acquireLock(path, { bootedAt: Date.parse("2026-10-17T02:00:00Z") }).acquired, false, "taken after boot: held");
    assert.equal(acquireLock(path, { bootedAt: Date.parse("2026-10-17T06:00:00Z") }).acquired, true, "taken before boot: stale");
  });
});

test("an empty or garbled lock is being written: held while fresh, stale once old", () => {
  withDir((dir) => {
    const path = join(dir, "nightly.lock");
    for (const garbled of ["", '{"pid":', "not json"]) {
      writeFileSync(path, garbled);
      assert.deepEqual(acquireLock(path), { acquired: false, holder: null }, JSON.stringify(garbled));
      const old = new Date(Date.now() - 60_000);
      utimesSync(path, old, old);
      const attempt = acquireLock(path);
      assert.equal(attempt.acquired, true, JSON.stringify(garbled));
      if (attempt.acquired) attempt.lock.release();
    }
  });
});

test("a takeover token left by a crash does not block the takeover for good", () => {
  withDir((dir) => {
    const path = join(dir, "nightly.lock");
    writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: localIso(new Date()) }));
    writeFileSync(`${path}.takeover`, "12345");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.takeover`, old, old);
    assert.equal(acquireLock(path).acquired, true);
    assert.equal(existsSync(`${path}.takeover`), false);
  });
});

test("release gives up only this process's lock; record() keeps it, naming the run", () => {
  withDir((dir) => {
    const path = join(dir, "nightly.lock");
    const attempt = acquireLock(path);
    assert.ok(attempt.acquired);
    attempt.lock.record({ runId: "20261017-080000-abcdef", runsRoot: "/runs" });
    const held = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(held.pid, process.pid);
    assert.equal(held.runId, "20261017-080000-abcdef");
    assert.equal(held.runsRoot, "/runs");
    // Someone else's lock now (it was taken over meanwhile): release leaves it.
    writeFileSync(path, JSON.stringify({ pid: 1, startedAt: localIso(new Date()) }));
    attempt.lock.release();
    assert.equal(existsSync(path), true);
  });
});

// --- odw schedule run ---------------------------------------------------------------

test("schedule run: a done run exits 0, logs a line per event and becomes the last run", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box)).code, 0);
    const r = await odw(["schedule", "run", "nightly"]);
    assert.equal(r.code, 0, r.err);
    const lines = box.log("nightly").trimEnd().split("\n");
    assert.equal(lines.length, 2, box.log("nightly"));
    const started = new RegExp(`^${STAMP} started (${RUN_ID}) \\(nightly\\)$`).exec(lines[0]!);
    assert.ok(started, lines[0]);
    const runId = started[1]!;
    assert.match(lines[1]!, new RegExp(`^${STAMP} done ${runId} in \\d+s$`));
    assert.match(r.err, new RegExp(`odw schedule run nightly: started ${runId} \\(nightly\\)\\n`), "echoed: stderr is not the log");
    assert.equal(r.out, "");

    const last = lastRun(box);
    assert.equal(last.runId, runId);
    assert.equal(last.state, "done");
    assert.equal(last.runsRoot, join(box.home, ".odw", "runs"));
    assert.match(String(last.finishedAt), new RegExp(`^${STAMP}$`));
    const store = new RunStore(join(box.home, ".odw", "runs"));
    assert.equal(store.readStatus(runId).state, "done");
    assert.equal(store.readMeta(runId).source, box.proj, "the run's working directory is the schedule's");
    assert.equal(existsSync(join(box.stateDir, "nightly.lock")), false, "the lock is released");

    const [row] = JSON.parse((await odw(["schedule", "list", "--json"])).out) as Array<{ lastRun: Record<string, unknown> }>;
    assert.equal(row!.lastRun.runId, runId);
    assert.equal(row!.lastRun.state, "done");
    const table = await odw(["schedule", "list"]);
    assert.match(table.out, new RegExp(`\\nnightly .* done \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d ${runId} `));
  }),
);

test("schedule run: a failed run exits 1 and logs why", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box, "--args", '{"fail":true}')).code, 0);
    const r = await odw(["schedule", "run", "nightly"]);
    assert.equal(r.code, 1);
    const lines = box.log("nightly").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    const runId = new RegExp(`started (${RUN_ID})`).exec(lines[0]!)![1]!;
    assert.match(lines[1]!, new RegExp(`^${STAMP} failed ${runId} after \\d+s: nightly failed on purpose$`));
    const last = lastRun(box);
    assert.equal(last.state, "failed");
    assert.equal(last.error, "nightly failed on purpose");
    const [row] = JSON.parse((await odw(["schedule", "list", "--json"])).out) as Array<{ lastRun: Record<string, unknown> }>;
    assert.equal(row!.lastRun.state, "failed");
  }),
);

test("schedule run: of two at once, one runs and the other is skipped (exit 0)", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box)).code, 0);
    let codes: number[] = [];
    await capture(async () => {
      codes = await Promise.all([main(["schedule", "run", "nightly"]), main(["schedule", "run", "nightly"])]);
      return 0;
    });
    assert.deepEqual(codes, [0, 0]);
    const log = box.log("nightly");
    assert.equal(log.match(/ started /g)?.length, 1, log);
    assert.equal(log.match(/ done /g)?.length, 1, log);
    const runId = new RegExp(`started (${RUN_ID})`).exec(log)![1]!;
    assert.match(
      log,
      new RegExp(`\\n${STAMP} skipped: the previous run is still going \\(run ${runId}, pid ${process.pid}, since ${STAMP}\\)\\n`),
    );
  }),
);

test("schedule run: separate processes at once — one runs, one skips", posix, () =>
  withSandbox(async (box) => {
    // An agent that answers only once the test opens the gate, so the two runs surely overlap.
    const gate = join(box.root, "gate");
    const agent =
      "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=setInterval(()=>{" +
      `if(require('fs').existsSync(${JSON.stringify(gate)})){clearInterval(t);process.stdout.write('ok')}},20)})`;
    writeFileSync(
      join(box.proj, "odw.config.json"),
      JSON.stringify({ defaultAdapter: "gate", adapters: { gate: { command: [execPath, "-e", agent], stdin: "{prompt}" } } }),
    );
    assert.equal((await add(box)).code, 0);
    const start = () => spawn(execPath, [...process.execArgv, CLI, "schedule", "run", "nightly"], { stdio: "ignore" });
    const runs = [start(), start()];
    const exits = runs.map((child) => new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))));
    try {
      const both = await until(() => /started/.test(box.log("nightly")) && /skipped/.test(box.log("nightly")), 30_000);
      assert.ok(both, `one started and one skipped: ${box.log("nightly")}`);
      writeFileSync(gate, "");
      assert.deepEqual(await Promise.all(exits), [0, 0]);
      const log = box.log("nightly");
      assert.equal(log.match(/ started /g)?.length, 1, log);
      assert.equal(log.match(/ done /g)?.length, 1, log);
      assert.equal(log.match(/ skipped: /g)?.length, 1, log);
    } finally {
      writeFileSync(gate, "");
      for (const child of runs) child.kill();
    }
  }),
);

test("schedule run: a stale lock (its holder died) is taken over and the run goes ahead", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box)).code, 0);
    writeFileSync(join(box.stateDir, "nightly.lock"), JSON.stringify({ pid: deadPid(), startedAt: localIso(new Date()) }));
    const r = await odw(["schedule", "run", "nightly"]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(box.log("nightly"), /skipped/);
    assert.match(box.log("nightly"), / done /);
    assert.equal(existsSync(join(box.stateDir, "nightly.lock")), false);
  }),
);

test("schedule run: a live holder in another process makes this run skip", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box)).code, 0);
    const holder = spawn(execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      const since = localIso(new Date());
      writeFileSync(join(box.stateDir, "nightly.lock"), JSON.stringify({ pid: holder.pid, startedAt: since }));
      const r = await odw(["schedule", "run", "nightly"]);
      assert.equal(r.code, 0);
      assert.equal(
        box.log("nightly").replace(/^\S+ /, ""),
        `skipped: the previous run is still going (pid ${holder.pid}, since ${since})\n`,
      );
      assert.equal(existsSync(join(box.stateDir, "nightly.lock")), true, "not ours to remove");
      assert.equal(existsSync(join(box.stateDir, "nightly.last.json")), false, "a skip is not a run");
    } finally {
      holder.kill();
    }
  }),
);

test("schedule run: a dead holder whose run still goes on keeps the schedule skipping", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box)).code, 0);
    const runsRoot = join(box.home, ".odw", "runs");
    const store = new RunStore(runsRoot);
    const runId = store.create({ script: "/x/nightly.js", args: null, source: box.proj });
    store.updateStatus(runId, { state: "running", pid: process.pid }); // its worker: alive
    const lock = { pid: deadPid(), startedAt: localIso(new Date()), runId, runsRoot };
    writeFileSync(join(box.stateDir, "nightly.lock"), JSON.stringify(lock));
    let r = await odw(["schedule", "run", "nightly"]);
    assert.equal(r.code, 0);
    assert.match(box.log("nightly"), new RegExp(`skipped: the previous run is still going \\(run ${runId}, pid ${lock.pid}, since `));

    store.updateStatus(runId, { state: "done" }); // now it is over: the lock is stale
    r = await odw(["schedule", "run", "nightly"]);
    assert.equal(r.code, 0, r.err);
    assert.match(box.log("nightly"), / done /);
  }),
);

test("schedule run: a run that cannot start is logged and recorded, exit 1", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box)).code, 0);
    rmSync(join(box.proj, ".odw", "workflows", "nightly.js"));
    let r = await odw(["schedule", "run", "nightly"]);
    assert.equal(r.code, 1);
    assert.match(box.log("nightly"), new RegExp(`^${STAMP} failed to start: no workflow named 'nightly' searched: `));
    const last = lastRun(box);
    assert.equal(last.runId, null);
    assert.equal(last.state, "failed");
    assert.match(String(last.error), /^no workflow named 'nightly'/);

    rmSync(box.proj, { recursive: true });
    r = await odw(["schedule", "run", "nightly"]);
    assert.equal(r.code, 1);
    assert.match(box.log("nightly"), new RegExp(`failed to start: its directory ${box.proj} no longer exists\\n$`));
    assert.equal(existsSync(join(box.stateDir, "nightly.lock")), false);
  }),
);

test("schedule run of an unknown schedule exits 1 and writes no log", posix, () =>
  withSandbox(async (box) => {
    const r = await odw(["schedule", "run", "ghost"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /odw schedule run: no schedule named 'ghost' in \S+schedules\.json/);
    assert.equal(existsSync(join(box.stateDir, "ghost.log")), false);
    assert.equal((await odw(["schedule", "run", "Bad Name"])).code, 2);
  }),
);

test("the crontab line itself runs the schedule: /bin/sh, cron's bare environment, one log line per event", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box)).code, 0);
    const entry = box.crontab()!.split("\n")[1]!;
    // What cron does with the line: drop the five fields, turn \% into %, hand the rest to /bin/sh.
    const command = entry.split(" ").slice(5).join(" ").replace(/\\%/g, "%");
    const sh = spawnSync("/bin/sh", ["-c", command], {
      cwd: box.home,
      env: { HOME: box.home, LOGNAME: "tester", PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(sh.status, 0, sh.stderr);
    assert.equal(sh.stdout + sh.stderr, "", "all output goes to the schedule's log");
    const lines = box.log("nightly").trimEnd().split("\n");
    assert.equal(lines.length, 2, `no line twice (stderr is the log): ${box.log("nightly")}`);
    assert.match(lines[0]!, new RegExp(`^${STAMP} started ${RUN_ID} \\(nightly\\)$`));
    assert.match(lines[1]!, new RegExp(`^${STAMP} done ${RUN_ID} in \\d+s$`));
  }),
);
