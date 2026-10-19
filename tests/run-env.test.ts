/**
 * `odw doctor`'s run-environment checks (ODW extension): the open-file limit
 * against a planned fan-out, free space at the runs root and in the temp dir
 * (and whether that is a tmpfs), and the git on PATH — each warning with a
 * concrete fix, and what does not apply on a platform skipped.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { CommandRunner } from "../src/adapters/runner.ts";
import {
  FD_BASELINE,
  FDS_PER_AGENT,
  LOW_SPACE,
  fdsNeeded,
  gatherRunEnv,
  mountOf,
  parseGitVersion,
  runEnvChecks,
  type RunEnvFacts,
  type SpaceFact,
} from "../src/run-env.ts";

const GiB = 1024 ** 3;
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const space = (path: string, free: number | null, extra: Partial<SpaceFact> = {}): SpaceFact => ({
  path,
  free,
  total: free === null ? null : 100 * GiB,
  fsType: null,
  mount: null,
  ...extra,
});

function facts(over: Partial<RunEnvFacts> = {}): RunEnvFacts {
  return {
    platform: "linux",
    fanout: 8,
    concurrency: 8,
    openFiles: { soft: 1024, hard: 1048576 },
    runsRoot: space("/home/u/.odw/runs", 50 * GiB),
    tmp: space("/tmp", 50 * GiB),
    git: "git version 2.43.0",
    ...over,
  };
}

const byId = (checks: ReturnType<typeof runEnvChecks>, id: string) => {
  const check = checks.find((c) => c.id === id);
  assert.ok(check, `a ${id} check`);
  return check;
};

test("run env: a roomy machine passes every check", () => {
  const checks = runEnvChecks(facts());
  assert.deepEqual(checks.map((c) => c.id), ["open-files", "free-runs", "free-tmp", "git"]);
  for (const c of checks) assert.equal(c.status, "ok", `${c.id}: ${c.detail}`);
  assert.match(byId(checks, "open-files").detail, /1024 per process · a fan-out of 8 agent\(s\) needs ~96/);
  assert.match(byId(checks, "free-runs").detail, /50 GB free of 100 GB at \/home\/u\/\.odw\/runs/);
  assert.equal(byId(checks, "git").detail, "git version 2.43.0");
});

test("run env: the open-file limit is weighed against the fan-out, with a fix that fits the hard limit", () => {
  assert.equal(fdsNeeded(16), FD_BASELINE + 16 * FDS_PER_AGENT);
  // macOS's default 256 is enough for the default caps, not for a fan-out of 64.
  const mac = byId(runEnvChecks(facts({ platform: "darwin", fanout: 64, openFiles: { soft: 256, hard: 256 } })), "open-files");
  assert.equal(mac.status, "warn");
  assert.match(mac.detail, /256 per process \(hard 256\) · a fan-out of 64 agent\(s\) needs ~320 \(one run's concurrency cap is 8/);
  assert.match(mac.hint ?? "", /sudo launchctl limit maxfiles 4096 unlimited/);
  // A soft limit below a hard one that would do: the shell alone lifts it.
  const soft = byId(runEnvChecks(facts({ fanout: 64, openFiles: { soft: 256, hard: 1048576 } })), "open-files");
  assert.equal(soft.status, "warn");
  assert.match(soft.hint ?? "", /`ulimit -n 4096` \(add it to ~\/\.zshrc or ~\/\.bashrc\)/);
  // Linux with a low hard limit: limits.conf (or the unit's / container's own setting).
  const linux = byId(runEnvChecks(facts({ fanout: 2000, openFiles: { soft: 4096, hard: 4096 } })), "open-files");
  assert.equal(linux.status, "warn");
  assert.match(linux.hint ?? "", /nofile.*\/etc\/security\/limits\.conf.*LimitNOFILE=.*ulimit -n 8192/);
  // Unlimited is enough for anything.
  const unlimited = byId(runEnvChecks(facts({ fanout: 100000, openFiles: { soft: Infinity, hard: Infinity } })), "open-files");
  assert.equal(unlimited.status, "ok");
  assert.match(unlimited.detail, /^unlimited per process/);
});

test("run env: Windows and an unreadable limit skip the open-file check, never fail it", () => {
  const win = runEnvChecks(facts({ platform: "win32", openFiles: null }));
  assert.equal(byId(win, "open-files").status, "skip");
  assert.match(byId(win, "open-files").detail, /Windows/);
  assert.equal(byId(runEnvChecks(facts({ openFiles: null })), "open-files").status, "skip");
  assert.ok(win.every((c) => c.status !== "fail"));
});

test("run env: under 1 GiB free at the runs root or in the temp dir is a warning with a fix", () => {
  const low = runEnvChecks(facts({ runsRoot: space("/r", LOW_SPACE - 1), tmp: space("/var/tmp", 200 * 1024 ** 2) }));
  const runs = byId(low, "free-runs");
  assert.equal(runs.status, "warn");
  assert.match(runs.detail, /^only .* free of 100 GB at \/r/);
  assert.match(runs.hint ?? "", /odw gc --yes.*runsRoot/);
  const tmp = byId(low, "free-tmp");
  assert.equal(tmp.status, "warn");
  assert.match(tmp.detail, /200 MB free .*isolation: "worktree"/);
  assert.match(tmp.hint ?? "", /export TMPDIR=~\/\.cache\/odw-tmp/);
  // Exactly 1 GiB is enough.
  assert.equal(byId(runEnvChecks(facts({ tmp: space("/tmp", LOW_SPACE) })), "free-tmp").status, "ok");
  // On Windows the variable is TEMP.
  const win = byId(runEnvChecks(facts({ platform: "win32", openFiles: null, tmp: space("C:\\Temp", 1) })), "free-tmp");
  assert.match(win.hint ?? "", /setx TEMP/);
  // Unknown free space: skipped.
  assert.equal(byId(runEnvChecks(facts({ runsRoot: space("/r", null) })), "free-runs").status, "skip");
});

test("run env: a tmpfs temp dir is named, and its fix grows the mount", () => {
  const roomy = byId(runEnvChecks(facts({ tmp: space("/tmp", 4 * GiB, { fsType: "tmpfs", mount: "/tmp" }) })), "free-tmp");
  assert.equal(roomy.status, "ok");
  assert.match(roomy.detail, /tmpfs \(RAM-backed, mounted at \/tmp\).*in memory/);
  const full = byId(runEnvChecks(facts({ tmp: space("/tmp", 300 * 1024 ** 2, { fsType: "tmpfs", mount: "/tmp" }) })), "free-tmp");
  assert.equal(full.status, "warn");
  assert.match(full.hint ?? "", /sudo mount -o remount,size=8G \/tmp.*TMPDIR/);
});

test("run env: git missing or older than 2.17 is a warning; any newer git passes", () => {
  assert.deepEqual(parseGitVersion("git version 2.39.3 (Apple Git-146)"), [2, 39]);
  assert.deepEqual(parseGitVersion("git version 2.45.1.windows.1"), [2, 45]);
  assert.equal(parseGitVersion("nope"), null);
  const missing = byId(runEnvChecks(facts({ git: null })), "git");
  assert.equal(missing.status, "warn");
  assert.match(missing.hint ?? "", /install git 2\.17 or newer/);
  const old = byId(runEnvChecks(facts({ git: "git version 2.11.0" })), "git");
  assert.equal(old.status, "warn");
  assert.match(old.hint ?? "", /upgrade git to 2\.17/);
  assert.equal(byId(runEnvChecks(facts({ git: "git version 2.17.0" })), "git").status, "ok");
  assert.equal(byId(runEnvChecks(facts({ git: "git version 3.0.0" })), "git").status, "ok");
});

test("run env: the mount holding a path is the longest mount point above it", () => {
  const table = [
    "/dev/vda2 / ext4 rw,relatime 0 0",
    "tmpfs /tmp tmpfs rw,nosuid,size=8G 0 0",
    "tmpfs /tmpfoo tmpfs rw 0 0",
    "/dev/vdb /mnt/my\\040disk xfs rw 0 0",
  ].join("\n");
  assert.deepEqual(mountOf("/tmp/odw-wt-1", table), { mount: "/tmp", fsType: "tmpfs" });
  assert.deepEqual(mountOf("/tmp", table), { mount: "/tmp", fsType: "tmpfs" });
  assert.deepEqual(mountOf("/tmpx/a", table), { mount: "/", fsType: "ext4" });
  assert.deepEqual(mountOf("/mnt/my disk/runs", table), { mount: "/mnt/my disk", fsType: "xfs" });
});

test("run env: gathering reads this machine without throwing, and uses the runner for git", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-run-env-")));
  made.push(dir);
  const asked: string[][] = [];
  const runner: CommandRunner = async (command) => {
    asked.push(command);
    if (command[0] === "git") return { returncode: 0, stdout: "git version 2.40.1\n", stderr: "", timedOut: false, duration: 0 };
    return { returncode: 0, stdout: "512\n4096\n", stderr: "", timedOut: false, duration: 0 };
  };
  const got = await gatherRunEnv({
    runsRoot: join(dir, "not", "made", "yet"),
    tmpRoot: dir,
    fanout: 4,
    concurrency: 4,
    runner,
    mounts: `tmpfs ${dir} tmpfs rw 0 0`,
  });
  assert.equal(got.git, "git version 2.40.1");
  assert.ok(asked.some((c) => c[0] === "git" && c[1] === "--version"));
  // A runs root not made yet is measured where it will be.
  assert.equal(got.runsRoot.path, join(dir, "not", "made", "yet"));
  if (process.platform === "linux") {
    assert.equal(got.tmp.fsType, "tmpfs");
    assert.equal(got.tmp.mount, dir);
  }
  if (process.platform === "win32") {
    assert.equal(got.openFiles, null);
  } else {
    assert.ok(got.openFiles && got.openFiles.soft > 0 && got.openFiles.hard >= got.openFiles.soft);
  }
  assert.ok(got.tmp.free === null || got.tmp.free >= 0);
  // A git that is not there: null, and a warning, not a crash.
  const none = await gatherRunEnv({ runsRoot: dir, tmpRoot: dir, fanout: 1, concurrency: 1, runner: async () => ({ returncode: 127, stdout: "", stderr: "not found", timedOut: false, duration: 0 }) });
  assert.equal(none.git, null);
});

test("run env: off Linux the limit comes from a shell this process starts", async () => {
  const runner: CommandRunner = async (command) =>
    command[0] === "/bin/sh"
      ? { returncode: 0, stdout: "256\nunlimited\n", stderr: "", timedOut: false, duration: 0 }
      : { returncode: 0, stdout: "git version 2.39.3 (Apple Git-146)\n", stderr: "", timedOut: false, duration: 0 };
  const got = await gatherRunEnv({ runsRoot: tmpdir(), tmpRoot: tmpdir(), fanout: 2, concurrency: 2, runner, platform: "darwin" });
  assert.deepEqual(got.openFiles, { soft: 256, hard: Infinity });
  assert.equal(got.tmp.fsType, null, "no mount table off Linux");
  const win = await gatherRunEnv({ runsRoot: tmpdir(), tmpRoot: tmpdir(), fanout: 2, concurrency: 2, runner, platform: "win32" });
  assert.equal(win.openFiles, null);
});
