import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cronBlock,
  hasCronBlock,
  install,
  launchdPlist,
  planInstall,
  replaceCronBlock,
  schtasksLine,
  shQuote,
  systemdService,
  systemdTimer,
  uninstall,
  winQuote,
  ScheduleError,
  type EntrySpec,
  type ExecResult,
  type Executor,
} from "../src/schedule/backends.js";
import { launchdIntervals, parseCron, systemdCalendars } from "../src/schedule/cron.js";

const ENTRY: EntrySpec = {
  name: "digest",
  cron: "0 8 * * 1-5",
  odwCommand: ["/usr/local/bin/node", "/opt/odw/dist/cli.js"],
  path: "/usr/local/bin:/usr/bin:/bin",
  log: "/home/u/.local/state/odw/schedules/digest.log",
};

const BLOCK =
  "# odw:begin digest\n" +
  "0 8 * * 1-5 PATH='/usr/local/bin:/usr/bin:/bin' '/usr/local/bin/node' '/opt/odw/dist/cli.js' schedule run digest" +
  " >> '/home/u/.local/state/odw/schedules/digest.log' 2>&1\n" +
  "# odw:end digest\n";

const FOREIGN = [
  "SHELL=/bin/sh",
  "MAILTO=me@example.com",
  "",
  "# backups (keep the trailing spaces)   ",
  "15 3 * * * /usr/bin/backup --quiet > /dev/null 2>&1",
  "@reboot /usr/bin/startup %not-ours",
  "",
].join("\n");

test("cronBlock: markers around one entry that sets PATH and appends to the log", () => {
  assert.equal(cronBlock(ENTRY), BLOCK);
});

test("cronBlock single-quotes every path for /bin/sh and escapes cron's %", () => {
  const block = cronBlock({
    ...ENTRY,
    odwCommand: ["/Users/o'brien/my tools/node", "/opt/100%/cli.js"],
    path: "/a b:/c",
    log: "/home/u/it's/digest.log",
  });
  assert.equal(
    block,
    "# odw:begin digest\n" +
      `0 8 * * 1-5 PATH='/a b:/c' '/Users/o'\\''brien/my tools/node' '/opt/100\\%/cli.js' schedule run digest` +
      ` >> '/home/u/it'\\''s/digest.log' 2>&1\n` +
      "# odw:end digest\n",
  );
});

test("shQuote round-trips through /bin/sh", { skip: process.platform === "win32" }, () => {
  for (const word of ["plain", "with space", "it's", "'", "''", "$HOME", "`date`", "a\\b", "*", "-n", ""]) {
    const echoed = spawnSync("/bin/sh", ["-c", `printf '%s' ${shQuote(word)}`], { encoding: "utf8" });
    assert.equal(echoed.stdout, word, JSON.stringify(word));
  }
});

test("an entry value with a line break is refused, never split across crontab lines", () => {
  assert.throws(() => cronBlock({ ...ENTRY, log: "/tmp/a\nb.log" }), ScheduleError);
  assert.throws(() => systemdService({ ...ENTRY, path: "/bin\n/evil" }), ScheduleError);
});

test("replaceCronBlock appends, replaces and removes only odw's block", () => {
  const added = replaceCronBlock(FOREIGN, "digest", BLOCK);
  assert.equal(added, FOREIGN + BLOCK);
  assert.equal(hasCronBlock(added, "digest"), true);
  assert.equal(hasCronBlock(added, "digest-2"), false);

  const other = BLOCK.replace("0 8 * * 1-5", "*/5 * * * *");
  const replaced = replaceCronBlock(added, "digest", other);
  assert.equal(replaced, FOREIGN + other, "the old block goes, the new one is appended");

  assert.equal(replaceCronBlock(replaced, "digest", null), FOREIGN, "every foreign line, byte for byte");
  assert.equal(replaceCronBlock("", "digest", BLOCK), BLOCK, "a missing crontab is an empty one");
  assert.equal(replaceCronBlock(BLOCK, "digest", null), "", "nothing left");
  assert.equal(replaceCronBlock(FOREIGN, "digest", null), FOREIGN, "nothing to remove: unchanged");
});

test("replaceCronBlock keeps a foreign last line that had no newline", () => {
  assert.equal(replaceCronBlock("15 3 * * * backup", "digest", BLOCK), "15 3 * * * backup\n" + BLOCK);
  assert.equal(replaceCronBlock("15 3 * * * backup\n" + BLOCK, "digest", null), "15 3 * * * backup\n");
});

test("replaceCronBlock leaves another schedule's block alone", () => {
  const second = cronBlock({ ...ENTRY, name: "digest-2", log: "/l/digest-2.log" });
  const both = FOREIGN + BLOCK + second;
  assert.equal(replaceCronBlock(both, "digest", null), FOREIGN + second);
  assert.equal(replaceCronBlock(both, "digest-2", null), FOREIGN + BLOCK);
  // A block in the middle of foreign lines: the lines around it stay where they were.
  assert.equal(replaceCronBlock(`a\n${BLOCK}b\n`, "digest", null), "a\nb\n");
});

test("replaceCronBlock copes with markers edited away by hand", () => {
  const [begin, line] = BLOCK.split("\n");
  // The end marker is gone: the begin marker and odw's entry right after it go, nothing else.
  assert.equal(replaceCronBlock(`a\n${begin}\n${line}\nb\n`, "digest", null), "a\nb\n");
  // ...and a foreign line right after a lone begin marker stays.
  assert.equal(replaceCronBlock(`a\n${begin}\nb\n`, "digest", null), "a\nb\n");
  // A lone end marker goes.
  assert.equal(replaceCronBlock(`a\n# odw:end digest\nb\n`, "digest", null), "a\nb\n");
  // A lone begin marker never swallows the next schedule's block.
  const second = cronBlock({ ...ENTRY, name: "nightly", log: "/l/nightly.log" });
  assert.equal(replaceCronBlock(`${begin}\n${second}`, "digest", null), second);
});

test("launchdPlist: argument vector, PATH, calendar entries and the log, byte for byte", () => {
  const spec = parseCron("30 6 1,15 * mon");
  const plist = launchdPlist({ ...ENTRY, log: "/Users/u/R&D <logs>/digest.log" }, launchdIntervals(spec));
  assert.equal(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>dev.odw.schedule.digest</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/usr/local/bin/node</string>
\t\t<string>/opt/odw/dist/cli.js</string>
\t\t<string>schedule</string>
\t\t<string>run</string>
\t\t<string>digest</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/usr/local/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>StartCalendarInterval</key>
\t<array>
\t\t<dict>
\t\t\t<key>Day</key>
\t\t\t<integer>1</integer>
\t\t\t<key>Hour</key>
\t\t\t<integer>6</integer>
\t\t\t<key>Minute</key>
\t\t\t<integer>30</integer>
\t\t</dict>
\t\t<dict>
\t\t\t<key>Day</key>
\t\t\t<integer>15</integer>
\t\t\t<key>Hour</key>
\t\t\t<integer>6</integer>
\t\t\t<key>Minute</key>
\t\t\t<integer>30</integer>
\t\t</dict>
\t\t<dict>
\t\t\t<key>Weekday</key>
\t\t\t<integer>1</integer>
\t\t\t<key>Hour</key>
\t\t\t<integer>6</integer>
\t\t\t<key>Minute</key>
\t\t\t<integer>30</integer>
\t\t</dict>
\t</array>
\t<key>StandardOutPath</key>
\t<string>/Users/u/R&amp;D &lt;logs&gt;/digest.log</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/u/R&amp;D &lt;logs&gt;/digest.log</string>
</dict>
</plist>
`,
  );
  assert.match(launchdPlist(ENTRY, launchdIntervals(parseCron("* * * * *"))), /\t<array>\n\t\t<dict\/>\n\t<\/array>/);
});

test("systemd units: a oneshot service and its timer, byte for byte", () => {
  const entry = { ...ENTRY, odwCommand: ["/usr/bin/node", "/opt/my odw/cli.js", "/opt/$HOME/x"], path: "/usr/bin:/opt/100%" };
  assert.equal(
    systemdService(entry),
    `[Unit]
Description=odw schedule digest

[Service]
Type=oneshot
Environment="PATH=/usr/bin:/opt/100%%"
ExecStart=/usr/bin/node "/opt/my odw/cli.js" "/opt/$$HOME/x" schedule run digest
StandardOutput=append:/home/u/.local/state/odw/schedules/digest.log
StandardError=append:/home/u/.local/state/odw/schedules/digest.log
`,
  );
  const spec = parseCron("30 6 1,15 * mon");
  assert.equal(
    systemdTimer({ ...ENTRY, cron: spec.expr }, systemdCalendars(spec)),
    `[Unit]
Description=odw schedule digest (30 6 1,15 * mon)

[Timer]
OnCalendar=*-*-01,15 06:30:00
OnCalendar=Mon *-*-* 06:30:00
AccuracySec=1s
Persistent=true

[Install]
WantedBy=timers.target
`,
  );
});

test("winQuote quotes like the Windows C runtime splits", () => {
  assert.equal(winQuote("plain"), "plain");
  assert.equal(winQuote(""), '""');
  assert.equal(winQuote("C:\\Program Files\\nodejs\\node.exe"), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(winQuote('{"q":"a b"}'), '"{\\"q\\":\\"a b\\"}"');
  assert.equal(winQuote("C:\\my dir\\"), '"C:\\my dir\\\\"');
  assert.equal(winQuote('say \\"hi\\"'), '"say \\\\\\"hi\\\\\\""');
});

test("schtasksLine: a cmd.exe line creating the task, byte for byte", () => {
  const argv = ["C:\\Program Files\\nodejs\\node.exe", "C:\\odw\\dist\\cli.js", "run", "digest", "--wait", "--source", "C:\\work\\proj"];
  const { line, task, exact } = schtasksLine("digest", parseCron("0 8 * * 1-5"), argv);
  assert.equal(task, '"C:\\Program Files\\nodejs\\node.exe" C:\\odw\\dist\\cli.js run digest --wait --source C:\\work\\proj');
  assert.equal(
    line,
    "schtasks /Create /TN odw-digest /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:00 " +
      '/TR "\\"C:\\Program Files\\nodejs\\node.exe\\" C:\\odw\\dist\\cli.js run digest --wait --source C:\\work\\proj"',
  );
  assert.equal(exact, true);
});

// --- install / uninstall through a recording executor ------------------------------

interface FakeOs {
  exec: Executor;
  calls: string[];
  crontab: string | null;
  loaded: Set<string>;
  /** Answers to force, by command prefix. */
  answers: Map<string, ExecResult>;
}

/** An in-memory scheduler: enough to see which commands run, in what order, with what input. */
function fakeOs(): FakeOs {
  const os: FakeOs = { calls: [], crontab: null, loaded: new Set(), answers: new Map(), exec: () => ok() };
  os.exec = (argv, input) => {
    const call = argv.join(" ");
    os.calls.push(call);
    for (const [prefix, answer] of os.answers) if (call.startsWith(prefix)) return answer;
    const [cmd, ...args] = argv;
    if (cmd === "crontab" && args[0] === "-l") {
      return os.crontab === null ? fail(1, "no crontab for tester\n") : ok(os.crontab);
    }
    if (cmd === "crontab" && args[0] === "-") {
      os.crontab = input ?? "";
      return ok();
    }
    if (cmd === "launchctl") {
      const label = args[0] === "bootstrap" ? args[2]!.replace(/^.*\/|\.plist$/g, "") : args[1]!.replace(/^.*\//, "");
      if (args[0] === "bootstrap") {
        if (os.loaded.has(label)) return fail(37, "Bootstrap failed: 37: Operation already in progress\n");
        os.loaded.add(label);
        return ok();
      }
      if (args[0] === "bootout") return os.loaded.delete(label) ? ok() : fail(3, "Boot-out failed: 3: No such process\n");
      if (args[0] === "print") return os.loaded.has(label) ? ok("state = waiting") : fail(113, "Could not find service\n");
    }
    if (cmd === "systemctl") return ok();
    return fail(127, `spawn ${cmd} ENOENT`);
  };
  return os;
}

function ok(stdout = ""): ExecResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(status: number, stderr: string): ExecResult {
  return { status, stdout: "", stderr };
}

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "odw-backend-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("cron: install reads the crontab (none is an empty one), appends the block; uninstall takes it out", () => {
  withHome((home) => {
    const os = fakeOs();
    const env = { exec: os.exec, home, uid: 501 };
    const spec = parseCron(ENTRY.cron);
    install(planInstall("cron", ENTRY, spec, env), "digest", env);
    assert.deepEqual(os.calls, ["crontab -l", "crontab -"]);
    assert.equal(os.crontab, BLOCK);

    os.crontab = FOREIGN + os.crontab;
    assert.equal(uninstall("cron", "digest", env), true);
    assert.equal(os.crontab, FOREIGN);
    os.calls.length = 0;
    assert.equal(uninstall("cron", "digest", env), false, "idempotent");
    assert.deepEqual(os.calls, ["crontab -l"], "nothing written when nothing changes");
  });
});

test("cron: no crontab command is an install error but nothing to uninstall", () => {
  withHome((home) => {
    const os = fakeOs();
    os.answers.set("crontab", fail(127, "spawn crontab ENOENT"));
    const env = { exec: os.exec, home, uid: 501 };
    assert.throws(
      () => install(planInstall("cron", ENTRY, parseCron(ENTRY.cron), env), "digest", env),
      /crontab is not available here \(spawn crontab ENOENT\) — install cron, or pick another --backend/,
    );
    assert.equal(uninstall("cron", "digest", env), false);
    os.answers.delete("crontab");
    os.answers.set("crontab -l", fail(1, "crontab: permission denied"));
    assert.throws(() => uninstall("cron", "digest", env), /crontab -l failed \(exit 1\): crontab: permission denied/);
  });
});

test("launchd: the plist is written and bootstrapped; a job still loaded is replaced; already-loaded is fine", () => {
  withHome((home) => {
    const os = fakeOs();
    const env = { exec: os.exec, home, uid: 501 };
    const plan = planInstall("launchd", ENTRY, parseCron(ENTRY.cron), env);
    const plist = join(home, "Library", "LaunchAgents", "dev.odw.schedule.digest.plist");
    assert.deepEqual(plan.commands, [["launchctl", "bootstrap", "gui/501", plist]]);
    install(plan, "digest", env);
    assert.equal(readFileSync(plist, "utf8"), plan.files[0]!.content);
    assert.deepEqual(os.calls, [
      "launchctl bootout gui/501/dev.odw.schedule.digest",
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
    assert.ok(os.loaded.has("dev.odw.schedule.digest"));

    // A leftover job of the same label: booted out first, then loaded from the new plist.
    os.calls.length = 0;
    install(plan, "digest", env);
    assert.deepEqual(os.calls, [
      "launchctl bootout gui/501/dev.odw.schedule.digest",
      `launchctl bootstrap gui/501 ${plist}`,
    ]);

    // launchd refuses the bootstrap but has the job ("already loaded"): tolerated.
    os.answers.set("launchctl bootstrap", fail(5, "Bootstrap failed: 5: Input/output error\n"));
    os.answers.set("launchctl bootout", fail(3, "Boot-out failed: 3: No such process\n"));
    install(plan, "digest", env);
    // ...but not when launchd does not have it.
    os.answers.set("launchctl print", fail(113, "Could not find service\n"));
    assert.throws(
      () => install(plan, "digest", env),
      (err: unknown) =>
        err instanceof ScheduleError &&
        err.message === `launchctl bootstrap gui/501 ${plist} failed (exit 5): Bootstrap failed: 5: Input/output error`,
    );
  });
});

test("launchd: uninstall boots the job out and deletes the plist; a job already gone is fine", () => {
  withHome((home) => {
    const os = fakeOs();
    const env = { exec: os.exec, home, uid: 501 };
    install(planInstall("launchd", ENTRY, parseCron(ENTRY.cron), env), "digest", env);
    os.calls.length = 0;
    assert.equal(uninstall("launchd", "digest", env), true);
    assert.deepEqual(os.calls, ["launchctl bootout gui/501/dev.odw.schedule.digest"]);
    assert.equal(existsSync(join(home, "Library", "LaunchAgents", "dev.odw.schedule.digest.plist")), false);
    assert.equal(uninstall("launchd", "digest", env), false, "idempotent");
  });
});

test("systemd: both units are written, then daemon-reload and enable --now; uninstall reverses it", () => {
  withHome((home) => {
    const os = fakeOs();
    const env = { exec: os.exec, home, uid: 1000 };
    const plan = planInstall("systemd", ENTRY, parseCron(ENTRY.cron), env);
    install(plan, "digest", env);
    const dir = join(home, ".config", "systemd", "user");
    assert.deepEqual(
      plan.files.map((f) => f.path),
      [join(dir, "odw-digest.service"), join(dir, "odw-digest.timer")],
    );
    for (const file of plan.files) assert.equal(readFileSync(file.path, "utf8"), file.content);
    assert.deepEqual(os.calls, ["systemctl --user daemon-reload", "systemctl --user enable --now odw-digest.timer"]);

    os.calls.length = 0;
    assert.equal(uninstall("systemd", "digest", env), true);
    assert.deepEqual(os.calls, ["systemctl --user disable --now odw-digest.timer", "systemctl --user daemon-reload"]);
    assert.equal(existsSync(join(dir, "odw-digest.service")) || existsSync(join(dir, "odw-digest.timer")), false);

    os.answers.set("systemctl --user enable", fail(1, "Failed to connect to bus: No medium found"));
    assert.throws(
      () => install(plan, "digest", env),
      /systemctl --user enable --now odw-digest.timer failed \(exit 1\): Failed to connect to bus: No medium found/,
    );
  });
});
