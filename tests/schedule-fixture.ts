/**
 * Shared sandbox for the `odw schedule` tests. Never the real scheduler: HOME
 * is a temp directory, and fake `crontab`, `launchctl` and `systemctl` go
 * first on PATH. The fakes keep their state in `<root>/os` — the crontab, what
 * is loaded or enabled, and every call in calls.log — and answer like the
 * real tools do (`no crontab for …`, `Boot-out failed: 3`, `Unit file … does
 * not exist`). POSIX only: they are /bin/sh scripts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";

export const MOCK_AGENT = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

/** The scheduled workflow: one agent call; `args.fail` makes the run fail after it. */
export const NIGHTLY = `export const meta = { name: 'nightly', description: 'scheduled test workflow' }
const reply = await agent('summarize the day')
if (args && args.fail) throw new Error('nightly failed on purpose')
return { reply }
`;

const FAKE_CRONTAB = `#!/bin/sh
dir=@DIR@
echo "crontab $*" >> "$dir/calls.log"
case "$*" in
  "-l") if [ -f "$dir/crontab" ]; then cat "$dir/crontab"; else echo "no crontab for tester" >&2; exit 1; fi ;;
  "-") cat > "$dir/crontab" ;;
  *) echo "fake crontab: unexpected arguments: $*" >&2; exit 2 ;;
esac
`;

const FAKE_LAUNCHCTL = `#!/bin/sh
dir=@DIR@
echo "launchctl $*" >> "$dir/calls.log"
case "$1" in
  bootstrap)
    label=$(basename "$3" .plist)
    if [ -f "$dir/loaded.$label" ]; then echo "Bootstrap failed: 37: Operation already in progress" >&2; exit 37; fi
    cp "$3" "$dir/loaded.$label" ;;
  bootout)
    label=\${2##*/}
    if [ ! -f "$dir/loaded.$label" ]; then echo "Boot-out failed: 3: No such process" >&2; exit 3; fi
    rm "$dir/loaded.$label" ;;
  print)
    label=\${2##*/}
    if [ ! -f "$dir/loaded.$label" ]; then echo "Could not find service \\"$label\\" in domain" >&2; exit 113; fi
    echo "$label = { state = waiting }" ;;
  *) echo "fake launchctl: unexpected arguments: $*" >&2; exit 2 ;;
esac
`;

const FAKE_SYSTEMCTL = `#!/bin/sh
dir=@DIR@
echo "systemctl $*" >> "$dir/calls.log"
if [ "$1" != "--user" ]; then echo "fake systemctl: expected --user" >&2; exit 2; fi
units="$HOME/.config/systemd/user"
case "$2" in
  daemon-reload) ;;
  enable)
    if [ ! -f "$units/$4" ]; then echo "Failed to enable unit: Unit file $4 does not exist." >&2; exit 1; fi
    touch "$dir/enabled.$4" ;;
  disable)
    if [ ! -f "$units/$4" ] && [ ! -f "$dir/enabled.$4" ]; then echo "Failed to disable unit: Unit file $4 does not exist." >&2; exit 1; fi
    rm -f "$dir/enabled.$4" ;;
  *) echo "fake systemctl: unexpected arguments: $*" >&2; exit 2 ;;
esac
`;

export interface Sandbox {
  root: string;
  home: string;
  /** The project a schedule runs in: .odw/workflows/nightly.js and an odw.config.json with a mock adapter. */
  proj: string;
  /** Where the fakes keep the crontab, loaded/enabled markers and calls.log. */
  os: string;
  /** The fake bin directory first on PATH. */
  bin: string;
  calls(): string[];
  crontab(): string | null;
  /** schedules.json's entries. */
  definitions(): Array<Record<string, unknown>>;
  stateDir: string;
  log(name: string): string;
}

/**
 * Run `fn` with HOME, PATH and ODW_CONFIG pointing into a fresh sandbox; all
 * restored (and the sandbox removed) afterwards.
 */
export async function withSandbox<T>(fn: (box: Sandbox) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "odw-schedule-"));
  const home = join(root, "home");
  const proj = join(root, "proj");
  const os = join(root, "os");
  const bin = join(root, "bin");
  for (const dir of [home, join(proj, ".odw", "workflows"), os, bin]) mkdirSync(dir, { recursive: true });
  for (const [name, script] of [
    ["crontab", FAKE_CRONTAB],
    ["launchctl", FAKE_LAUNCHCTL],
    ["systemctl", FAKE_SYSTEMCTL],
  ] as const) {
    writeFileSync(join(bin, name), script.replace("@DIR@", `'${os}'`));
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(proj, ".odw", "workflows", "nightly.js"), NIGHTLY);
  writeFileSync(
    join(proj, "odw.config.json"),
    JSON.stringify({ defaultAdapter: "mock", adapters: { mock: { command: [execPath, MOCK_AGENT], stdin: "{prompt}" } } }),
  );

  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, ODW_CONFIG: process.env.ODW_CONFIG };
  process.env.HOME = home;
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  delete process.env.ODW_CONFIG;
  // The guard this whole file rests on: every scheduler command resolves to a fake.
  const which = spawnSync("/bin/sh", ["-c", 'for c in crontab launchctl systemctl; do command -v "$c"; done'], {
    encoding: "utf8",
  });
  assert.deepEqual(which.stdout.trim().split("\n"), [join(bin, "crontab"), join(bin, "launchctl"), join(bin, "systemctl")]);

  const stateDir = join(home, ".local", "state", "odw", "schedules");
  const box: Sandbox = {
    root,
    home,
    proj,
    os,
    bin,
    stateDir,
    calls: () => (existsSync(join(os, "calls.log")) ? readFileSync(join(os, "calls.log"), "utf8").trim().split("\n") : []),
    crontab: () => (existsSync(join(os, "crontab")) ? readFileSync(join(os, "crontab"), "utf8") : null),
    definitions: () => {
      const file = join(home, ".config", "odw", "schedules.json");
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { schedules: Array<Record<string, unknown>> }).schedules : [];
    },
    log: (name) => {
      const file = join(stateDir, `${name}.log`);
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
  };
  try {
    return await fn(box);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run the CLI in-process, capturing what it writes. */
export function odw(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  return capture(() => main(argv));
}

/** Run a command function in-process, capturing what it writes. */
export async function capture(command: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    // node:test sends its protocol as buffers during asynchronous commands.
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
    err.push(String(s));
    return true;
  };
  try {
    const code = await command();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}
