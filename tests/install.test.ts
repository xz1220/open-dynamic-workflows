import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const installer = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
const repository = "https://github.com/xz1220/open-dynamic-workflows";
const raw = "https://raw.githubusercontent.com/xz1220/open-dynamic-workflows";
const documents = ["SKILL.md", "references/primitives.md", "references/adapters.md"];
const binary = `#!/bin/sh
case "$1" in
  --version) echo 'open-dynamic-workflows 1.2.3' ;;
  --help) echo 'odw init' ;;
  init) printf '%s\\n' "$*" >> "$STUB_INIT_LOG" ;;
  *) exit 2 ;;
esac
`;

function executable(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o755 });
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "odw install test "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const testHome = join(root, "user home");
  const binDir = join(root, "local bin");
  const skillDir = join(testHome, ".codex", "skills", "open-dynamic-workflows");
  const fakeBin = join(root, "test commands");
  const scratch = join(root, "temporary files");
  const archive = join(root, "binary.gz");
  const requests = join(root, "requests.log");
  mkdirSync(join(testHome, ".codex"), { recursive: true });
  mkdirSync(fakeBin);
  mkdirSync(scratch);
  writeFileSync(archive, gzipSync(binary));
  executable(join(fakeBin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n");
  // This stub serves local fixtures only. No request can reach the network.
  executable(join(fakeBin, "curl"), `#!/bin/sh
set -eu
output=''
writeout=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w) writeout="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$STUB_REQUESTS"
if [ "$writeout" = '%{url_effective}' ]; then
  [ -z "\${STUB_FAIL_LATEST:-}" ] || exit 22
  printf '%s' "\${STUB_LATEST_URL:-${repository}/releases/tag/v1.2.3}"
  exit 0
fi
case "$url" in
  */skills/open-dynamic-workflows/*)
    if [ "\${STUB_LAYOUT:-}" = legacy ]; then printf 404; exit 22; fi ;;
esac
case "$url" in
  ${repository}/releases/download/*/odw-linux-x64.gz)
    cp "$STUB_ARCHIVE" "$output" ;;
  ${repository}/releases/download/*/SHA256SUMS)
    [ -z "\${STUB_FAIL_SUMS:-}" ] || { printf 500; exit 22; }
    [ -f "$STUB_SUMS" ] || { printf 404; exit 22; }
    cp "$STUB_SUMS" "$output" ;;
  ${raw}/*/skills/open-dynamic-workflows/*.md|${raw}/*/skill/*.md)
    case "$url" in
      *"/\${STUB_FAIL_FILE:-not-a-file}") printf partial > "$output"; exit 22 ;;
      *"/\${STUB_EMPTY_FILE:-not-a-file}") : > "$output" ;;
      *) printf 'downloaded %s\\n' "$url" > "$output" ;;
    esac ;;
  *) echo "Unexpected URL: $url" >&2; exit 99 ;;
esac
[ "$writeout" != '%{http_code}' ] || printf 200
`);
executable(join(fakeBin, "mv"), `#!/bin/sh
set -eu
case "$1" in
  */.odw-install.*/new)
    if [ "\${STUB_INTERRUPT_MOVE:-}" = "$2" ]; then
      /bin/mv "$@"
      kill -TERM "$PPID"
      exit 0
    fi ;;
esac
if [ ! -e "$STUB_FAILED" ]; then
  case "\${STUB_FAIL_MOVE:-}" in
    skill-backup) [ "$1" != "$STUB_SKILL_DIR" ] || { : > "$STUB_FAILED"; exit 73; } ;;
    binary|skill)
      case "$1" in
        */.odw-install.*/new)
          target="$STUB_SKILL_DIR"
          [ "$STUB_FAIL_MOVE" != binary ] || target="$ODW_BIN_DIR/odw"
          [ "$2" != "$target" ] || { : > "$STUB_FAILED"; exit 73; } ;;
      esac ;;
  esac
fi
exec /bin/mv "$@"
`);
  const sums = join(root, "SHA256SUMS");
  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:/usr/bin:/bin`, HOME: testHome, TMPDIR: scratch,
    CI: "1", ODW_BIN_DIR: binDir, STUB_ARCHIVE: archive, STUB_SUMS: sums,
    STUB_REQUESTS: requests, STUB_INIT_LOG: join(root, "init.log"),
    STUB_SKILL_DIR: skillDir, STUB_FAILED: join(root, "move-failed"),
  };
  const oldBinary = "#!/bin/sh\n# customized wrapper; never execute it during upgrade\nexit 91\n";
  // The release's SHA256SUMS: by default derived from the archive as served at
  // run time (so tests that swap the archive still reach the checks they target);
  // a string serves that content verbatim, null makes the asset a 404.
  let sumsContent: string | null | undefined;
  return {
    root, testHome, binDir, skillDir, scratch, archive, requests, env, oldBinary, fakeBin,
    sums(content: string | null) {
      sumsContent = content;
    },
    run(overrides: NodeJS.ProcessEnv = {}) {
      if (sumsContent === null) rmSync(sums, { force: true });
      else {
        writeFileSync(sums, sumsContent ?? [
          `${"0".repeat(64)}  odw-darwin-arm64.gz`,
          `${sha256(readFileSync(archive))}  odw-linux-x64.gz`,
          `${"f".repeat(64)}  odw-win-x64.exe.gz`,
        ].join("\n") + "\n");
      }
      return spawnSync("/bin/sh", [installer], {
        cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000,
      });
    },
    old() {
      mkdirSync(binDir, { recursive: true });
      executable(join(binDir, "odw"), oldBinary);
      mkdirSync(join(skillDir, "references"), { recursive: true });
      for (const doc of documents) writeFileSync(join(skillDir, doc), `original ${doc}`);
      writeFileSync(join(skillDir, "custom.md"), "personal instructions");
      writeFileSync(join(skillDir, "references", "custom.md"), "personal reference");
    },
    assertOld() {
      assert.equal(readFileSync(join(binDir, "odw"), "utf8"), oldBinary);
      for (const doc of documents) assert.equal(readFileSync(join(skillDir, doc), "utf8"), `original ${doc}`);
      assert.equal(readFileSync(join(skillDir, "custom.md"), "utf8"), "personal instructions");
    },
    assertClean() {
      assert.deepEqual(readdirSync(scratch), []);
      for (const directory of [binDir, dirname(skillDir)]) {
        if (existsSync(directory)) assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith(".odw-install.")), []);
      }
    },
  };
}

function installTest(name: string, fn: (t: TestContext) => void) {
  test(`install: ${name}`, { skip: process.platform === "win32" }, fn);
}

installTest("resolves latest once and installs matching skill without Node or jq", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed open-dynamic-workflows 1\.2\.3/);
  assert.deepEqual(readFileSync(f.requests, "utf8").trim().split("\n"), [
    `${repository}/releases/latest`,
    `${repository}/releases/download/v1.2.3/odw-linux-x64.gz`,
    `${repository}/releases/download/v1.2.3/SHA256SUMS`,
    ...documents.map((doc) => `${raw}/v1.2.3/skills/open-dynamic-workflows/${doc}`),
  ]);
  assert.match(result.stdout, /verified SHA-256 of odw-linux-x64\.gz against SHA256SUMS/);
  assert.equal(readFileSync(join(f.binDir, "odw"), "utf8"), binary);
  assert.equal(readFileSync(f.env.STUB_INIT_LOG!, "utf8"), "init --check\n");
  f.assertClean();
});

installTest("refuses a checksum mismatch or an unlisted asset before replacement, even when unverified installs are allowed", (t) => {
  for (const sums of [
    `${"0".repeat(64)}  odw-linux-x64.gz\n`,
    `${"0".repeat(64)}  odw-darwin-arm64.gz\n`,
    "",
  ]) {
    const f = fixture(t);
    f.old();
    f.sums(sums);
    const result = f.run({ ODW_ALLOW_UNVERIFIED: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Checksum mismatch for odw-linux-x64\.gz|does not list odw-linux-x64\.gz/);
    assert.doesNotMatch(readFileSync(f.requests, "utf8"), /raw\.githubusercontent/, "nothing after the failed check");
    f.assertOld();
    f.assertClean();
  }
});

installTest("accepts binary-mode and uppercase SHA256SUMS entries", (t) => {
  const f = fixture(t);
  f.sums(`${sha256(readFileSync(f.archive)).toUpperCase()} *odw-linux-x64.gz\n`);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.binDir, "odw"), "utf8"), binary);
  f.assertClean();
});

installTest("a release from v0.5.0 on without SHA256SUMS fails closed unless ODW_ALLOW_UNVERIFIED=1", (t) => {
  const f = fixture(t);
  f.old();
  f.sums(null);
  let result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /v1\.2\.3 publishes no SHA256SUMS; refusing .*ODW_ALLOW_UNVERIFIED=1/);
  f.assertOld();
  f.assertClean();
  result = f.run({ ODW_ALLOW_UNVERIFIED: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: release v1\.2\.3 publishes no SHA256SUMS; installing an UNVERIFIED binary/);
  assert.equal(readFileSync(join(f.binDir, "odw"), "utf8"), binary);
  f.assertClean();
});

installTest("releases before v0.5.0 predate SHA256SUMS and install with a warning", (t) => {
  for (const [version, predates] of [
    ["0.4.9", true], ["0.4.0", true], ["0.1.0-rc.1", true], ["0.5.0", false], ["0.5.0-rc.1", false], ["0.9.0", false], ["1.0.0", false],
  ] as const) {
    const f = fixture(t);
    writeFileSync(f.archive, gzipSync(binary.replace("1.2.3", version)));
    f.sums(null);
    const result = f.run({ ODW_VERSION: version });
    if (predates) {
      assert.equal(result.status, 0, `${version}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`warning: v${version.replace(/\./g, "\\.")} predates published checksums`));
    } else {
      assert.notEqual(result.status, 0, version);
      assert.match(result.stderr, /publishes no SHA256SUMS/, version);
    }
    f.assertClean();
  }
});

installTest("ODW_REQUIRE_CHECKSUMS=1 (the GitHub Action's) refuses a release without checksums, even one that predates them", (t) => {
  for (const version of ["0.4.0", "1.2.3"]) {
    const f = fixture(t);
    f.old();
    writeFileSync(f.archive, gzipSync(binary.replace("1.2.3", version)));
    f.sums(null);
    const result = f.run({ ODW_VERSION: version, ODW_REQUIRE_CHECKSUMS: "1", ODW_ALLOW_UNVERIFIED: "1" });
    assert.notEqual(result.status, 0, version);
    assert.match(result.stderr, /predates published checksums \(SHA256SUMS\); refusing|publishes no SHA256SUMS; refusing/, version);
    assert.doesNotMatch(result.stderr, /installing/, version);
    f.assertOld();
    f.assertClean();
  }
  // With checksums it installs as ever.
  const f = fixture(t);
  const result = f.run({ ODW_REQUIRE_CHECKSUMS: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified SHA-256/);
});

installTest("a SHA256SUMS download failure aborts rather than skipping verification", (t) => {
  const f = fixture(t);
  f.old();
  const result = f.run({ STUB_FAIL_SUMS: "1", ODW_ALLOW_UNVERIFIED: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not download SHA256SUMS \(v1\.2\.3\)/);
  f.assertOld();
  f.assertClean();
});

installTest("without sha256sum or shasum the binary cannot be verified and needs the opt-out", (t) => {
  const f = fixture(t);
  // Shadow both digest tools with stand-ins that fail like a missing command.
  for (const tool of ["sha256sum", "shasum"]) executable(join(f.fakeBin, tool), "#!/bin/sh\nexit 127\n");
  f.old();
  let result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot compute SHA-256 here \(no sha256sum or shasum\); refusing/);
  f.assertOld();
  result = f.run({ ODW_ALLOW_UNVERIFIED: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /installing an UNVERIFIED binary/);
  f.assertClean();
});

installTest("accepts pinned versions with or without v and an explicit skill ref", (t) => {
  for (const version of ["1.2.3", "v1.2.3"]) {
    const f = fixture(t);
    const result = f.run({ ODW_VERSION: version });
    assert.equal(result.status, 0, result.stderr);
    const urls = readFileSync(f.requests, "utf8");
    assert.doesNotMatch(urls, /releases\/latest/);
    assert.match(urls, /\/v1\.2\.3\/skills\//);
    f.assertClean();
  }
  const f = fixture(t);
  assert.equal(f.run({ ODW_VERSION: "1.2.3", ODW_REF: "custom/skill" }).status, 0);
  assert.equal(readFileSync(join(f.skillDir, "SKILL.md"), "utf8"), `downloaded ${raw}/custom/skill/skills/open-dynamic-workflows/SKILL.md\n`);
});

installTest("supports legacy skill layouts for old releases and explicit refs", (t) => {
  for (const ref of [undefined, "old/custom-ref"]) {
    const f = fixture(t);
    writeFileSync(f.archive, gzipSync(binary.replace("1.2.3", "0.4.0").replace("echo 'odw init'", "echo 'odw run'")));
    f.sums(null); // published before SHA256SUMS existed
    const result = f.run({
      STUB_LATEST_URL: `${repository}/releases/tag/v0.4.0`,
      STUB_LAYOUT: "legacy", ODW_REF: ref,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /v0\.4\.0 predates published checksums/);
    assert.doesNotMatch(result.stdout, /odw init/);
    assert.equal(existsSync(f.env.STUB_INIT_LOG!), false);
    assert.deepEqual(readFileSync(f.requests, "utf8").trim().split("\n"), [
      `${repository}/releases/latest`,
      `${repository}/releases/download/v0.4.0/odw-linux-x64.gz`,
      `${repository}/releases/download/v0.4.0/SHA256SUMS`,
      `${raw}/${ref ?? "v0.4.0"}/skills/open-dynamic-workflows/SKILL.md`,
      ...documents.map((doc) => `${raw}/${ref ?? "v0.4.0"}/skill/${doc}`),
    ]);
    for (const doc of documents) assert.match(readFileSync(join(f.skillDir, doc), "utf8"), /\/skill\//);
    f.assertClean();
  }
});

installTest("upgrades paths containing spaces while preserving extra skill files", (t) => {
  const f = fixture(t);
  f.old();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.binDir, "odw"), "utf8"), binary);
  for (const doc of documents) assert.match(readFileSync(join(f.skillDir, doc), "utf8"), /downloaded/);
  assert.equal(readFileSync(join(f.skillDir, "custom.md"), "utf8"), "personal instructions");
  assert.equal(readFileSync(join(f.skillDir, "references", "custom.md"), "utf8"), "personal reference");
  f.assertClean();
});

installTest("leaves the previous install intact on partial or empty skill downloads", (t) => {
  for (const doc of documents) {
    for (const failure of ["STUB_FAIL_FILE", "STUB_EMPTY_FILE"]) {
      const f = fixture(t);
      f.old();
      const result = f.run({ [failure]: doc });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(readFileSync(f.requests, "utf8"), /\/v1\.2\.3\/skill\//);
      f.assertOld();
      f.assertClean();
    }
  }
});

installTest("rejects bad gzip, unusable binaries, wrong versions and broken help before replacement", (t) => {
  const invalid = [
    Buffer.from("not gzip"),
    gzipSync(binary).subarray(0, -5),
    gzipSync("#!/bin/sh\nexit 1\n"),
    gzipSync(binary.replace("1.2.3", "0.4.0")),
    gzipSync(binary.replace("--help) echo 'odw init'", "--help) exit 1")),
  ];
  for (const bytes of invalid) {
    const f = fixture(t);
    f.old();
    writeFileSync(f.archive, bytes);
    assert.notEqual(f.run().status, 0);
    f.assertOld();
    f.assertClean();
  }
});

installTest("rejects unavailable or unexpected latest redirects before replacement", (t) => {
  for (const failure of [
    { STUB_FAIL_LATEST: "1" },
    { STUB_LATEST_URL: `${repository}/releases` },
    { STUB_LATEST_URL: `${repository}/releases/tag/not-a-version` },
    { STUB_LATEST_URL: `${repository}/releases/tag/custom/v1.2.3` },
  ]) {
    const f = fixture(t);
    f.old();
    assert.notEqual(f.run(failure).status, 0);
    f.assertOld();
    f.assertClean();
  }
});

installTest("restores both components when any replacement step fails", (t) => {
  for (const failure of ["binary", "skill-backup", "skill"]) {
    const f = fixture(t);
    f.old();
    const result = f.run({ STUB_FAIL_MOVE: failure });
    assert.equal(result.status, 73, result.stderr);
    f.assertOld();
    f.assertClean();
  }
});

installTest("removes newly installed files if a fresh installation cannot complete", (t) => {
  for (const failure of ["binary", "skill"]) {
    const f = fixture(t);
    assert.equal(f.run({ STUB_FAIL_MOVE: failure }).status, 73);
    assert.equal(existsSync(join(f.binDir, "odw")), false);
    assert.equal(existsSync(f.skillDir), false);
    f.assertClean();
  }
});

installTest("rolls back on interruption after a replacement has succeeded", (t) => {
  for (const component of ["binary", "skill"]) {
    const f = fixture(t);
    f.old();
    const result = f.run({ STUB_INTERRUPT_MOVE: component === "binary" ? join(f.binDir, "odw") : f.skillDir });
    assert.equal(result.status, 143, result.stderr);
    f.assertOld();
    f.assertClean();
  }
});

installTest("replaces a binary symlink itself and never modifies its wrapper target", (t) => {
  for (const rollback of [false, true]) {
    const f = fixture(t);
    f.old();
    const wrapper = join(f.root, "private wrapper");
    executable(wrapper, f.oldBinary);
    rmSync(join(f.binDir, "odw"));
    symlinkSync(wrapper, join(f.binDir, "odw"));
    const result = f.run(rollback ? { STUB_FAIL_MOVE: "skill" } : {});
    assert.equal(result.status, rollback ? 73 : 0, result.stderr);
    assert.equal(readFileSync(wrapper, "utf8"), f.oldBinary);
    if (rollback) {
      assert.equal(readlinkSync(join(f.binDir, "odw")), wrapper);
      f.assertOld();
    } else {
      assert.equal(lstatSync(join(f.binDir, "odw")).isSymbolicLink(), false);
      assert.equal(readFileSync(join(f.binDir, "odw"), "utf8"), binary);
    }
    f.assertClean();
  }
});

installTest("preserves skill extras without following root, directory or owned-file symlinks when writing", (t) => {
  for (const rollback of [false, true]) {
    const f = fixture(t);
    f.old();
    const externalSkill = join(f.root, "external skill");
    const externalRefs = join(f.root, "external references");
    const externalDoc = join(f.root, "external instructions.md");
    // All targets stay inside this test's temporary directory.
    mkdirSync(externalSkill);
    mkdirSync(externalRefs);
    writeFileSync(externalDoc, "external original");
    writeFileSync(join(externalSkill, "custom.md"), "keep extra");
    writeFileSync(join(externalRefs, "custom.md"), "keep reference");
    symlinkSync(externalDoc, join(externalSkill, "SKILL.md"));
    symlinkSync("../external references", join(externalSkill, "references"));
    rmSync(f.skillDir, { recursive: true });
    symlinkSync(externalSkill, f.skillDir);
    const result = f.run(rollback ? { STUB_FAIL_MOVE: "skill" } : {});
    assert.equal(result.status, rollback ? 73 : 0, result.stderr);
    assert.equal(readFileSync(externalDoc, "utf8"), "external original");
    assert.equal(readlinkSync(join(externalSkill, "SKILL.md")), externalDoc);
    assert.equal(readlinkSync(join(externalSkill, "references")), "../external references");
    assert.deepEqual(readdirSync(externalRefs), ["custom.md"]);
    if (rollback) {
      assert.equal(readlinkSync(f.skillDir), externalSkill);
      assert.equal(readFileSync(join(f.binDir, "odw"), "utf8"), f.oldBinary);
    } else {
      assert.equal(lstatSync(f.skillDir).isSymbolicLink(), false);
      assert.equal(lstatSync(join(f.skillDir, "references")).isSymbolicLink(), false);
      assert.match(readFileSync(join(f.skillDir, "SKILL.md"), "utf8"), /downloaded/);
      assert.equal(readFileSync(join(f.skillDir, "custom.md"), "utf8"), "keep extra");
      assert.equal(readFileSync(join(f.skillDir, "references", "custom.md"), "utf8"), "keep reference");
    }
    f.assertClean();
  }
});

installTest("restores dangling symlinks and refuses to treat an existing binary directory as a destination", (t) => {
  const f = fixture(t);
  mkdirSync(f.binDir);
  symlinkSync("missing-wrapper", join(f.binDir, "odw"));
  mkdirSync(dirname(f.skillDir), { recursive: true });
  symlinkSync("missing-skill", f.skillDir);
  assert.equal(f.run({ STUB_FAIL_MOVE: "skill" }).status, 73);
  assert.equal(readlinkSync(join(f.binDir, "odw")), "missing-wrapper");
  assert.equal(readlinkSync(f.skillDir), "missing-skill");
  f.assertClean();

  const other = fixture(t);
  mkdirSync(join(other.binDir, "odw"), { recursive: true });
  writeFileSync(join(other.binDir, "odw", "keep"), "directory content");
  assert.notEqual(other.run().status, 0);
  assert.deepEqual(readdirSync(join(other.binDir, "odw")), ["keep"]);
  other.assertClean();
});

installTest("does not move a new binary into the target of a directory symlink", (t) => {
  const f = fixture(t);
  const target = join(f.root, "linked directory");
  mkdirSync(target);
  writeFileSync(join(target, "keep"), "untouched");
  mkdirSync(f.binDir);
  symlinkSync(target, join(f.binDir, "odw"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(target), ["keep"]);
  assert.equal(readFileSync(join(target, "keep"), "utf8"), "untouched");
  assert.equal(readFileSync(join(f.binDir, "odw"), "utf8"), binary);
  f.assertClean();
});

installTest("ODW_SKILL=0 installs the verified binary alone: no skill, no odw init (the GitHub Action's install)", (t) => {
  const f = fixture(t);
  const result = f.run({ ODW_VERSION: "1.2.3", ODW_SKILL: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(f.requests, "utf8").trim().split("\n"), [
    `${repository}/releases/download/v1.2.3/odw-linux-x64.gz`,
    `${repository}/releases/download/v1.2.3/SHA256SUMS`,
  ]);
  assert.match(result.stdout, /verified SHA-256 of odw-linux-x64\.gz against SHA256SUMS/);
  assert.equal(readFileSync(join(f.binDir, "odw"), "utf8"), binary);
  assert.equal(existsSync(f.skillDir), false, "no skill installed");
  assert.equal(existsSync(join(f.root, "init.log")), false, "odw init not run");
  f.assertClean();

  const bad = fixture(t);
  bad.sums(`${"0".repeat(64)}  odw-linux-x64.gz\n`);
  const refused = bad.run({ ODW_VERSION: "1.2.3", ODW_SKILL: "0" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Checksum mismatch for odw-linux-x64\.gz/);
  assert.equal(existsSync(join(bad.binDir, "odw")), false, "nothing installed after a failed check");
});

installTest("next steps: a release with odw new ends on the $0 first run; an older one on odw run", (t) => {
  const f = fixture(t);
  writeFileSync(f.archive, gzipSync(binary.replace("echo 'odw init'", "printf 'odw init\\nodw new\\n'")));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /next steps:[\s\S]*odw new hello[\s\S]*odw run hello --dry .*\$0[\s\S]*odw serve --open/);
  assert.doesNotMatch(result.stdout, /odw run <workflow\.js> --wait/);
  const old = fixture(t);
  const before = old.run();
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /odw run <workflow\.js> --wait/);
  assert.doesNotMatch(before.stdout, /odw new hello/);
});
