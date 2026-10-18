/**
 * `odw schedule add | list | remove` end to end through the CLI, against fake
 * crontab / launchctl / systemctl first on PATH and a temp HOME (see
 * schedule-fixture.ts) — never this machine's scheduler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execPath } from "node:process";

import { COMMANDS, helpText, parseArgsValue } from "../src/cli.js";
import { cronBlock } from "../src/schedule/backends.js";
import { cmdSchedule } from "../src/schedule/command.js";
import { capture, odw, withSandbox, type Sandbox } from "./schedule-fixture.js";

const posix = { skip: process.platform === "win32" ? "the fake schedulers are /bin/sh scripts" : false };

const FOREIGN = "MAILTO=me@example.com\n# nightly backup\n15 3 * * * /usr/bin/backup --quiet %not-ours\n";

/** Adds the test schedule; cron unless a test names a backend (the platform default is launchd on macOS). */
function add(box: Sandbox, ...extra: string[]) {
  const backend = extra.includes("--backend") ? [] : ["--backend", "cron"];
  return odw(["schedule", "add", "nightly", "nightly", "--cron", "0 8 * * 1-5", "--cwd", box.proj, ...backend, ...extra]);
}

test("help and COMMANDS cover odw schedule", () => {
  assert.ok((COMMANDS as readonly string[]).includes("schedule"));
  const help = helpText();
  assert.match(help, /odw schedule add <name> <workflow> --cron EXPR/);
  assert.match(help, /odw schedule list \[--json\] \| remove\|run <name>/);
  assert.match(help, /\nSchedules \(odw schedule, ODW extension/);
  assert.match(help, /--backend cron\|launchd\|systemd\] \[--dry-run\]/);
});

test("odw schedule without a known subcommand is a usage error", async () => {
  for (const argv of [["schedule"], ["schedule", "frobnicate"]]) {
    const r = await odw(argv);
    assert.equal(r.code, 2);
    assert.match(r.err, /odw schedule: expected add, list, remove or run/);
  }
});

test("cron: add, list, remove round trip", posix, () =>
  withSandbox(async (box) => {
    const added = await add(box, "--args", '{"topic":"ci"}');
    assert.equal(added.code, 0, added.err);
    assert.match(added.err, /added schedule 'nightly': nightly at "0 8 \* \* 1-5" through cron/);
    assert.match(added.err, /next run {2}\d{4}-\d\d-\d\d 08:00 \(local time\)/);
    assert.match(added.err, new RegExp(`log {7}${join(box.stateDir, "nightly.log")}`));

    const [def] = box.definitions();
    assert.deepEqual(Object.keys(def!), ["name", "workflow", "cron", "args", "cwd", "backend", "createdAt", "odwCommand", "path"]);
    assert.equal(def!.workflow, "nightly", "a name stays a name");
    assert.deepEqual(def!.args, { topic: "ci" });
    assert.equal(def!.cwd, box.proj);
    assert.equal(def!.backend, "cron");
    assert.equal((def!.odwCommand as string[])[0], execPath);
    const path = (def!.path as string).split(":");
    assert.ok(path.includes(box.bin), "this shell's PATH");
    assert.ok(path.includes(dirname(execPath)), "with node's own directory, for #!/usr/bin/env node CLIs");
    assert.ok(existsSync(box.stateDir), "the log's directory exists before the first run");

    assert.deepEqual(box.calls(), ["crontab -l", "crontab -"]);
    const crontab = box.crontab()!;
    assert.match(crontab, /^# odw:begin nightly\n0 8 \* \* 1-5 PATH='[^']+' '[^']+node[^']*' .* schedule run nightly >> '[^']+nightly\.log' 2>&1\n# odw:end nightly\n$/);

    const listed = await odw(["schedule", "list", "--json"]);
    assert.equal(listed.code, 0, listed.err);
    const [row] = JSON.parse(listed.out) as Array<Record<string, unknown>>;
    assert.equal(row!.name, "nightly");
    assert.equal(row!.installed, true);
    assert.equal(row!.lastRun, null);
    assert.match(String(row!.nextRun), /^\d{4}-\d\d-\d\dT08:00:00[+-]\d\d:\d\d$/);
    const table = await odw(["schedule", "list"]);
    assert.match(table.out, /^NAME {5}CRON {9}BACKEND {2}WORKFLOW {2}LAST RUN {2}NEXT RUN\n/);
    assert.match(table.out, /\nnightly {2}0 8 \* \* 1-5 {2}cron {5}nightly {3}- {9}\d{4}-\d\d-\d\d 08:00\n$/);

    const removed = await odw(["schedule", "remove", "nightly"]);
    assert.equal(removed.code, 0, removed.err);
    assert.match(removed.err, /removed schedule 'nightly' and its cron entry/);
    assert.equal(box.crontab(), "");
    assert.deepEqual(box.definitions(), []);

    const again = await odw(["schedule", "remove", "nightly"]);
    assert.equal(again.code, 0, "remove is idempotent");
    assert.match(again.err, /no schedule named 'nightly' — nothing to remove/);
    const empty = await odw(["schedule", "list"]);
    assert.equal(empty.code, 0);
    assert.match(empty.err, /no schedules — add one/);
  }),
);

test("cron: the block leaves foreign crontab lines untouched, through add and remove", posix, () =>
  withSandbox(async (box) => {
    writeFileSync(join(box.os, "crontab"), FOREIGN);
    assert.equal((await add(box)).code, 0);
    assert.ok(box.crontab()!.startsWith(FOREIGN), "foreign lines first, byte for byte");
    assert.equal((await odw(["schedule", "remove", "nightly"])).code, 0);
    assert.equal(box.crontab(), FOREIGN);
  }),
);

test("launchd: add writes and bootstraps the LaunchAgent; remove boots it out", posix, () =>
  withSandbox(async (box) => {
    const added = await add(box, "--backend", "launchd");
    assert.equal(added.code, 0, added.err);
    const plist = join(box.home, "Library", "LaunchAgents", "dev.odw.schedule.nightly.plist");
    const text = readFileSync(plist, "utf8");
    assert.match(text, /<key>Label<\/key>\n\t<string>dev\.odw\.schedule\.nightly<\/string>/);
    assert.match(text, /\t\t<string>schedule<\/string>\n\t\t<string>run<\/string>\n\t\t<string>nightly<\/string>\n/);
    assert.equal((text.match(/<key>Weekday<\/key>/g) ?? []).length, 5);
    assert.match(text, new RegExp(`<key>StandardErrorPath</key>\\n\\t<string>${join(box.stateDir, "nightly.log")}</string>`));
    const uid = process.getuid!();
    assert.deepEqual(box.calls(), [
      `launchctl bootout gui/${uid}/dev.odw.schedule.nightly`,
      `launchctl bootstrap gui/${uid} ${plist}`,
    ]);
    assert.ok(existsSync(join(box.os, "loaded.dev.odw.schedule.nightly")));

    const [row] = JSON.parse((await odw(["schedule", "list", "--json"])).out) as Array<Record<string, unknown>>;
    assert.equal(row!.backend, "launchd");
    assert.equal(row!.installed, true);

    const removed = await odw(["schedule", "remove", "nightly"]);
    assert.equal(removed.code, 0, removed.err);
    assert.match(removed.err, /removed schedule 'nightly' and its launchd entry/);
    assert.equal(existsSync(plist), false);
    assert.equal(existsSync(join(box.os, "loaded.dev.odw.schedule.nightly")), false);
    assert.deepEqual(box.definitions(), []);
  }),
);

test("launchd refuses an expression it would need more than 64 entries for", posix, () =>
  withSandbox(async (box) => {
    const r = await odw(["schedule", "add", "busy", "nightly", "--cron", "*/2 9-17 * * 1-5", "--cwd", box.proj, "--backend", "launchd"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /launchd needs 1350 StartCalendarInterval entries .* use --backend cron \(macOS runs cron too\) or --backend systemd/);
    assert.deepEqual(box.definitions(), []);
    assert.deepEqual(box.calls(), []);
  }),
);

test("systemd: add writes the units, reloads and enables the timer; remove disables and deletes them", posix, () =>
  withSandbox(async (box) => {
    const added = await add(box, "--backend", "systemd");
    assert.equal(added.code, 0, added.err);
    assert.match(added.err, /loginctl enable-linger/);
    const dir = join(box.home, ".config", "systemd", "user");
    const service = readFileSync(join(dir, "odw-nightly.service"), "utf8");
    const timer = readFileSync(join(dir, "odw-nightly.timer"), "utf8");
    assert.match(service, /\nType=oneshot\n/);
    assert.match(service, / schedule run nightly\n/);
    assert.match(service, new RegExp(`\\nStandardOutput=append:${join(box.stateDir, "nightly.log")}\\n`));
    assert.match(timer, /\nOnCalendar=Mon,Tue,Wed,Thu,Fri \*-\*-\* 08:00:00\n/);
    assert.match(timer, /\nPersistent=true\n/);
    assert.deepEqual(box.calls(), ["systemctl --user daemon-reload", "systemctl --user enable --now odw-nightly.timer"]);
    assert.ok(existsSync(join(box.os, "enabled.odw-nightly.timer")));

    const removed = await odw(["schedule", "remove", "nightly"]);
    assert.equal(removed.code, 0, removed.err);
    assert.match(removed.err, /removed schedule 'nightly' and its systemd entry/);
    assert.equal(existsSync(join(dir, "odw-nightly.service")) || existsSync(join(dir, "odw-nightly.timer")), false);
    assert.equal(existsSync(join(box.os, "enabled.odw-nightly.timer")), false);
    assert.deepEqual(box.calls().slice(-2), ["systemctl --user disable --now odw-nightly.timer", "systemctl --user daemon-reload"]);
  }),
);

test("the default backend is launchd on macOS and cron elsewhere", posix, () =>
  withSandbox(async (box) => {
    const args = ["add", "nightly", "nightly", "--cron", "0 8 * * *", "--cwd", box.proj, "--dry-run"];
    const mac = await capture(() => cmdSchedule(args, { parseArgsValue, platform: "darwin" }));
    assert.equal(mac.code, 0, mac.err);
    assert.match(mac.out, /"backend": "launchd"/);
    assert.match(mac.out, /# \S+\/Library\/LaunchAgents\/dev\.odw\.schedule\.nightly\.plist:\n<\?xml/);
    assert.match(mac.out, /# then:\nlaunchctl bootstrap gui\/\d+ \S+dev\.odw\.schedule\.nightly\.plist\n/);
    const linux = await capture(() => cmdSchedule(args, { parseArgsValue, platform: "linux" }));
    assert.match(linux.out, /"backend": "cron"/);
    assert.match(linux.out, /# odw:begin nightly\n0 8 \* \* \* PATH=/);
  }),
);

test("--dry-run prints what add would write, and writes nothing", posix, () =>
  withSandbox(async (box) => {
    const r = await add(box, "--dry-run", "--backend", "systemd");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^# odw schedule add --dry-run: nothing was written\n\n# \S+\/\.config\/odw\/schedules\.json gains:\n\{\n {2}"name": "nightly",/);
    assert.match(r.out, /# \S+\/odw-nightly\.service:\n\[Unit\]\nDescription=odw schedule nightly\n/);
    assert.match(r.out, /# \S+\/odw-nightly\.timer:\n\[Unit\]\n/);
    assert.match(r.out, /# then:\nsystemctl --user daemon-reload\nsystemctl --user enable --now odw-nightly\.timer\n/);
    assert.match(r.out, /# next run: \d{4}-\d\d-\d\d 08:00 \(local time\)\n$/);
    assert.deepEqual(box.calls(), [], "no scheduler command ran");
    assert.equal(existsSync(join(box.home, ".config")), false, "no definition, no units");
    assert.equal(existsSync(join(box.home, ".local")), false, "no state directory");
  }),
);

test("add refuses a bad name, cron expression or backend as usage errors, and writes nothing", posix, () =>
  withSandbox(async (box) => {
    const cases: Array<[string[], RegExp]> = [
      [["add", "Nightly", "nightly", "--cron", "0 8 * * *"], /invalid schedule name 'Nightly' — use up to 63 lowercase letters/],
      [["add", "-x", "nightly", "--cron", "0 8 * * *"], /./],
      [["add", "nightly", "nightly"], /missing --cron "<minute hour day-of-month month day-of-week>"/],
      [["add", "nightly", "--cron", "0 8 * * *"], /expected <name> <workflow>/],
      [["add", "nightly", "nightly", "extra", "--cron", "0 8 * * *"], /got an extra 'extra'/],
      [["add", "nightly", "nightly", "--cron", "0 8 * *"], /odw schedule add: invalid cron expression "0 8 \* \*": expected 5 fields/],
      [["add", "nightly", "nightly", "--cron", "@daily"], /@daily is not supported — write the five fields instead: "0 0 \* \* \*"/],
      [["add", "nightly", "nightly", "--cron", "0 8 * * *", "--backend", "at"], /--backend must be one of cron, launchd, systemd, got 'at'/],
      [["add", "nightly", "nightly", "--cron", "0 8 * * *", "--cwd", "/no/such/dir"], /--cwd \/no\/such\/dir is not a directory/],
      [["add", "nightly", "nightly", "--cron", "0 8 * * *", "--frobnicate"], /--frobnicate/],
    ];
    for (const [argv, message] of cases) {
      const r = await odw(["schedule", ...argv, ...(argv.includes("--cwd") ? [] : ["--cwd", box.proj])]);
      assert.equal(r.code, 2, `${argv.join(" ")}: ${r.err}`);
      assert.match(r.err, message, argv.join(" "));
    }
    assert.deepEqual(box.definitions(), []);
    assert.deepEqual(box.calls(), []);
  }),
);

test("add fails fast on a workflow, adapter or config that does not load, and writes nothing", posix, () =>
  withSandbox(async (box) => {
    writeFileSync(join(box.proj, ".odw", "workflows", "broken.js"), "export const meta = { name: 'broken' }\nreturn (\n");
    const cases: Array<[string[], RegExp]> = [
      [["add", "x", "missing"], /no workflow named 'missing'/],
      [["add", "x", "broken"], /odw schedule add: workflow \S+broken\.js does not load: /],
      [["add", "x", "nightly", "--adapter", "nope"], /unknown adapter 'nope'/],
      [["add", "x", "nightly", "--config", join(box.root, "missing.json")], /config file not found/],
      [["add", "x", "nightly", "--args", "{oops"], /--args looks like JSON but failed to parse/],
    ];
    for (const [argv, message] of cases) {
      const r = await odw(["schedule", ...argv, "--cron", "0 8 * * *", "--cwd", box.proj]);
      assert.equal(r.code, 1, `${argv.join(" ")}: ${r.err}`);
      assert.match(r.err, message, argv.join(" "));
    }
    assert.deepEqual(box.definitions(), []);
    assert.deepEqual(box.calls(), []);
  }),
);

test("add refuses a name that exists already", posix, () =>
  withSandbox(async (box) => {
    assert.equal((await add(box)).code, 0);
    const r = await add(box, "--backend", "systemd");
    assert.equal(r.code, 1);
    assert.match(r.err, /a schedule named 'nightly' already exists — remove it first: odw schedule remove nightly/);
    assert.equal(box.definitions().length, 1);
  }),
);

test("add pins a script path, --args @file, --config and --cwd as absolute values", posix, () =>
  withSandbox(async (box) => {
    const config = join(box.root, "pinned.json");
    writeFileSync(config, readFileSync(join(box.proj, "odw.config.json")));
    const argsFile = join(box.root, "args.json");
    writeFileSync(argsFile, '{"depth": 2}');
    const r = await odw([
      "schedule", "add", "pinned", "./.odw/workflows/nightly.js", "--cron", "0 8 * * *",
      "--cwd", box.proj, "--args", `@${argsFile}`, "--config", config, "--adapter", "mock",
    ]);
    assert.equal(r.code, 0, r.err);
    const [def] = box.definitions();
    assert.equal(def!.workflow, join(box.proj, ".odw", "workflows", "nightly.js"));
    assert.deepEqual(def!.args, { depth: 2 });
    assert.equal(def!.configPath, config);
    assert.equal(def!.adapter, "mock");
  }),
);

test("remove is safe after the OS entry was edited away by hand", posix, () =>
  withSandbox(async (box) => {
    // cron: the user deleted the block (and wrote other lines).
    assert.equal((await add(box)).code, 0);
    writeFileSync(join(box.os, "crontab"), FOREIGN);
    const listed = await odw(["schedule", "list"]);
    assert.match(listed.out, /\nnightly .* cron \(entry missing\) /);
    assert.match(listed.err, /an OS entry is missing/);
    let r = await odw(["schedule", "remove", "nightly"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /removed schedule 'nightly' \(its cron entry was already gone\)/);
    assert.equal(box.crontab(), FOREIGN, "not rewritten");
    assert.deepEqual(box.definitions(), []);

    // launchd: the plist was deleted and the job unloaded.
    assert.equal((await add(box, "--backend", "launchd")).code, 0);
    rmSync(join(box.home, "Library", "LaunchAgents", "dev.odw.schedule.nightly.plist"));
    rmSync(join(box.os, "loaded.dev.odw.schedule.nightly"));
    r = await odw(["schedule", "remove", "nightly"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /\(its launchd entry was already gone\)/);

    // systemd: the units were deleted.
    assert.equal((await add(box, "--backend", "systemd")).code, 0);
    rmSync(join(box.home, ".config", "systemd", "user"), { recursive: true });
    rmSync(join(box.os, "enabled.odw-nightly.timer"));
    r = await odw(["schedule", "remove", "nightly"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /\(its systemd entry was already gone\)/);
    assert.deepEqual(box.definitions(), []);
  }),
);

test("remove without a definition still clears a leftover crontab block", posix, () =>
  withSandbox(async (box) => {
    const block = cronBlock({ name: "nightly", cron: "0 8 * * *", odwCommand: ["/usr/bin/node", "/x/cli.js"], path: "/usr/bin", log: "/l/nightly.log" });
    writeFileSync(join(box.os, "crontab"), FOREIGN + block);
    const r = await odw(["schedule", "remove", "nightly"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /removed the cron entry of 'nightly', which had no definition left/);
    assert.equal(box.crontab(), FOREIGN);
  }),
);

test("a failed install leaves no definition behind", posix, () =>
  withSandbox(async (box) => {
    // A crontab that cannot be written.
    writeFileSync(join(box.bin, "crontab"), "#!/bin/sh\n[ \"$1\" = -l ] && exit 0\necho 'crontab: cannot write: permission denied' >&2\nexit 1\n");
    const r = await add(box);
    assert.equal(r.code, 1);
    assert.match(r.err, /could not install the cron entry: crontab - failed \(exit 1\): crontab: cannot write: permission denied/);
    assert.deepEqual(box.definitions(), []);
  }),
);

test("Windows: not supported yet — prints a schtasks line, writes nothing", posix, () =>
  withSandbox(async (box) => {
    const args = ["add", "nightly", "nightly", "--cron", "0 8 * * 1-5", "--cwd", box.proj, "--args", '{"topic":"ci"}'];
    const r = await capture(() => cmdSchedule(args, { parseArgsValue, platform: "win32" }));
    assert.equal(r.code, 1);
    assert.match(r.err, /scheduling on Windows is not supported yet — no task was created and nothing was saved/);
    assert.match(r.out, /^schtasks \/Create \/TN odw-nightly \/SC WEEKLY \/D MON,TUE,WED,THU,FRI \/ST 08:00 \/TR "/);
    assert.match(r.out, / run nightly --wait --source \S+ --args \\"\{\\\\\\"topic\\\\\\":\\\\\\"ci\\\\\\"\}\\""\n$/);
    assert.match(r.err, /schtasks \/Delete \/TN odw-nightly \/F/);
    assert.deepEqual(box.definitions(), []);
    assert.deepEqual(box.calls(), []);
    const dry = await capture(() => cmdSchedule([...args, "--dry-run"], { parseArgsValue, platform: "win32" }));
    assert.equal(dry.code, 0);
  }),
);

test("GET /api/schedules serves what odw schedule list --json prints", { skip: process.platform === "win32" }, () =>
  withSandbox(async (box) => {
    const add = await odw(["schedule", "add", "nightly", "nightly", "--cron", "15 2 * * 1-5", "--cwd", box.proj, "--backend", "cron"]);
    assert.equal(add.code, 0, add.err);
    const { startServer } = await import("../src/runtime/server.js");
    const { RunStore } = await import("../src/runtime/run-store.js");
    const handle = await startServer({ store: new RunStore(join(box.root, "runs")), port: 0, host: "127.0.0.1", claudeProjectsRoot: join(box.root, "no-claude") });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${handle.port}/api/schedules`)).json()) as Array<Record<string, unknown>>;
      const listed = JSON.parse((await odw(["schedule", "list", "--json"])).out) as Array<Record<string, unknown>>;
      assert.equal(body.length, 1);
      assert.equal(body[0]!.name, "nightly");
      assert.equal(body[0]!.cron, "15 2 * * 1-5");
      assert.equal(body[0]!.installed, true, "the fake crontab holds its block");
      assert.equal(body[0]!.nextRun, listed[0]!.nextRun);
      assert.equal(body[0]!.lastRun, null);
    } finally {
      await handle.close();
    }
  }),
);

test("GET /api/schedules serves a schedule's args with their token shapes redacted; the schedule keeps them", { skip: process.platform === "win32" }, () =>
  withSandbox(async (box) => {
    const token = `ghp_${"a".repeat(36)}`;
    const add = await odw(["schedule", "add", "nightly", "nightly", "--cron", "15 2 * * 1-5", "--cwd", box.proj, "--backend", "cron", "--args", JSON.stringify({ token, n: 1 })]);
    assert.equal(add.code, 0, add.err);
    const { startServer } = await import("../src/runtime/server.js");
    const { RunStore } = await import("../src/runtime/run-store.js");
    const handle = await startServer({ store: new RunStore(join(box.root, "runs")), port: 0, host: "127.0.0.1", claudeProjectsRoot: join(box.root, "no-claude") });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${handle.port}/api/schedules`)).json()) as Array<Record<string, unknown>>;
      assert.deepEqual(body[0]!.args, { token: "«redacted:github»", n: 1 });
      assert.equal(body[0]!.redacted, true);
      // What its runs start with is the schedule as kept.
      const listed = JSON.parse((await odw(["schedule", "list", "--json"])).out) as Array<Record<string, unknown>>;
      assert.deepEqual(listed[0]!.args, { token, n: 1 });
    } finally {
      await handle.close();
    }
  }),
);
