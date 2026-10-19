import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findSection, hasUnreleased, releaseNotes } from "../scripts/changelog.mjs";
import { releaseChangelog, rewritePins } from "../scripts/prepare-release.mjs";

// Release readiness: scripts/changelog.mjs (the release notes and CI's check) and
// scripts/prepare-release.mjs, the latter run on a temp copy of this repository.

const repo = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(repo, path), "utf8");

function node(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
}

function tempDir(t: { after: (fn: () => void) => void }, prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A copy of what prepare-release reads and writes, with the scripts themselves. */
function copyRepo(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t, "odw-release-");
  for (const path of ["package.json", "package-lock.json", "CHANGELOG.md", "README.md", "README.zh-CN.md", "docs", "action"]) {
    cpSync(join(repo, path), join(dir, path), { recursive: true });
  }
  mkdirSync(join(dir, "scripts"));
  for (const script of ["changelog.mjs", "prepare-release.mjs"]) cpSync(join(repo, "scripts", script), join(dir, "scripts", script));
  const at = (path: string) => readFileSync(join(dir, path), "utf8");
  const prepare = (...args: string[]) => node(dir, "scripts/prepare-release.mjs", ...args);
  return { dir, at, prepare };
}

const PIN_PATHS = ["README.md", "README.zh-CN.md", "docs/github-action.md", "action/action.yml"];
const SNAPSHOT_PATHS = ["package.json", "package-lock.json", "CHANGELOG.md", ...PIN_PATHS];

const sample = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- something new",
  "",
  "```md",
  "## 9.9.9 — not a heading, an example",
  "```",
  "",
  "## 1.2.3 — 2026-01-02",
  "",
  "### Changed behavior — check before upgrading",
  "- a thing",
  "",
  "## 1.2.2 — 2025-12-01",
  "",
  "",
  "## v1.0.0",
  "- first",
  "",
].join("\n");

test("changelog: a section is found by its heading's first word, a tag's v ignored, code fences skipped", () => {
  assert.equal(releaseNotes(sample, "v1.2.3"), "### Changed behavior — check before upgrading\n- a thing\n");
  assert.equal(releaseNotes(sample, "1.2.3"), releaseNotes(sample, "v1.2.3"));
  assert.equal(releaseNotes(sample, "v1.0.0"), "- first\n");
  assert.match(findSection(sample, "Unreleased")!.body, /^- something new\n\n```md\n## 9\.9\.9/);
  assert.equal(findSection(sample, "9.9.9"), null);
  assert.equal(findSection(sample, "1.2"), null);
  assert.throws(() => releaseNotes(sample, "v2.0.0"), /no section for v2\.0\.0 \(expected a heading like "## 2\.0\.0 — YYYY-MM-DD"\)/);
  assert.throws(() => releaseNotes(sample, "v1.2.2"), /section for v1\.2\.2 is empty/);
  assert.equal(hasUnreleased(sample), true);
  assert.equal(hasUnreleased(sample.replace("## Unreleased", "## 1.3.0")), false);
  assert.equal(hasUnreleased("# Changelog\n\nUnreleased\n### Unreleased\n"), false);
});

test("changelog CLI: `check` and `notes <tag>` exit 1 when the section is missing", (t) => {
  const dir = tempDir(t, "odw-changelog-");
  writeFileSync(join(dir, "CHANGELOG.md"), sample);
  let r = node(dir, join(repo, "scripts/changelog.mjs"), "check");
  assert.equal(r.status, 0, r.stderr);
  r = node(dir, join(repo, "scripts/changelog.mjs"), "notes", "v1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "### Changed behavior — check before upgrading\n- a thing\n");
  r = node(dir, join(repo, "scripts/changelog.mjs"), "notes", "v1.2.3", "--out", "notes.md");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "### Changed behavior — check before upgrading\n- a thing\n");
  r = node(dir, join(repo, "scripts/changelog.mjs"), "notes", "v2.0.0");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /changelog: CHANGELOG\.md has no section for v2\.0\.0/);

  writeFileSync(join(dir, "OTHER.md"), sample.replace("## Unreleased", "## 1.3.0"));
  r = node(dir, join(repo, "scripts/changelog.mjs"), "check", "--file", "OTHER.md");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /OTHER\.md has no "## Unreleased" section/);
  r = node(dir, join(repo, "scripts/changelog.mjs"), "release");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});

test("this repository: CHANGELOG has an Unreleased section; CI checks it and the release publishes the tag's section", () => {
  const changelog = read("CHANGELOG.md");
  assert.equal(hasUnreleased(changelog), true);
  // "Changed behavior — check before upgrading" leads the unreleased section.
  const unreleased = findSection(changelog, "Unreleased")!;
  const firstSub = unreleased.body.split("\n").find((line) => line.startsWith("### "));
  assert.equal(firstSub, "### Changed behavior — check before upgrading");
  assert.match(unreleased.body, /^Everything since v0\.4\.0 \(2026-06-11\): roadmap 0\.5–0\.9/);

  assert.match(read(".github/workflows/ci.yml"), /run: node scripts\/changelog\.mjs check\n/);
  const release = read(".github/workflows/release.yml");
  assert.match(release, /run: node scripts\/changelog\.mjs notes "\$ODW_RELEASE_TAG" > \/dev\/null/);
  assert.match(release, /run: node scripts\/changelog\.mjs notes "\$GITHUB_REF_NAME" --out "\$RUNNER_TEMP\/release-notes\.md"/);
  assert.match(release, /body_path: \$\{\{ runner\.temp \}\}\/release-notes\.md/);
  assert.match(release, /generate_release_notes: true/);
});

test("docs pin the action with the v0.X.Y placeholder, never a release that does not exist", () => {
  for (const path of PIN_PATHS) {
    const text = read(path);
    assert.match(text, /xz1220\/open-dynamic-workflows\/action@v0\.X\.Y {3}# /, path);
    assert.doesNotMatch(text, /open-dynamic-workflows\/action@v\d+\.\d/, path);
  }
});

test("rewritePins: a release, a prerelease or the placeholder becomes the new tag; other actions are left alone", () => {
  const text = [
    "uses: xz1220/open-dynamic-workflows/action@v0.X.Y   # pin the release you installed",
    "uses: xz1220/open-dynamic-workflows/action@v0.7.0",
    "see `xz1220/open-dynamic-workflows/action@v1.0.0-rc.1`.",
    "uses: xz1220/open-dynamic-workflows/action@v0.9.0",
    "uses: someone/else/action@v0.7.0",
    "uses: xz1220/open-dynamic-workflows/action@main",
  ].join("\n");
  const { text: out, count } = rewritePins(text, "0.9.0");
  assert.equal(count, 3);
  assert.equal(out, [
    "uses: xz1220/open-dynamic-workflows/action@v0.9.0   # pin the release you installed",
    "uses: xz1220/open-dynamic-workflows/action@v0.9.0",
    "see `xz1220/open-dynamic-workflows/action@v0.9.0`.",
    "uses: xz1220/open-dynamic-workflows/action@v0.9.0",
    "uses: someone/else/action@v0.7.0",
    "uses: xz1220/open-dynamic-workflows/action@main",
  ].join("\n"));
});

test("releaseChangelog: Unreleased becomes the release under a new empty Unreleased; refuses an empty or repeated release", () => {
  const out = releaseChangelog(sample, "1.3.0", "2026-10-20");
  assert.match(out, /^# Changelog\n\n## Unreleased\n\n## 1\.3\.0 — 2026-10-20\n\n- something new\n/);
  assert.equal(releaseNotes(out, "v1.3.0").startsWith("- something new\n"), true);
  assert.equal(findSection(out, "Unreleased")!.body, "");
  assert.throws(() => releaseChangelog(out, "1.3.1", "2026-10-21"), /"## Unreleased" section is empty: nothing to release/);
  assert.throws(() => releaseChangelog(sample, "1.2.3", "2026-10-20"), /already has a section for 1\.2\.3/);
  assert.throws(() => releaseChangelog("# Changelog\n", "1.3.0", "2026-10-20"), /no "## Unreleased" section/);
});

test("prepare-release (temp copy): bumps the versions, releases the changelog, rewrites the pins, prints the git commands without running them", (t) => {
  const f = copyRepo(t);
  const researchBefore = f.at("docs/research/user-needs-2026-10-round6.md");
  const unreleasedBefore = findSection(f.at("CHANGELOG.md"), "Unreleased")!.body;
  const r = f.prepare("v0.9.0", "--date", "2026-10-20");
  assert.equal(r.status, 0, r.stderr);

  assert.equal(JSON.parse(f.at("package.json")).version, "0.9.0");
  const lock = JSON.parse(f.at("package-lock.json"));
  assert.equal(lock.version, "0.9.0");
  assert.equal(lock.packages[""].version, "0.9.0");
  // Only the version line changes: npm's formatting is kept.
  assert.equal(f.at("package.json"), read("package.json").replace(/"version": "[^"]+"/, '"version": "0.9.0"'));

  const changelog = f.at("CHANGELOG.md");
  assert.match(changelog, /\n## Unreleased\n\n## 0\.9\.0 — 2026-10-20\n\nEverything since v0\.4\.0/);
  assert.equal(findSection(changelog, "Unreleased")!.body, "");
  assert.equal(releaseNotes(changelog, "v0.9.0"), `${unreleasedBefore}\n`);

  for (const path of PIN_PATHS) {
    assert.doesNotMatch(f.at(path), /action@v0\.X\.Y/, path);
    assert.match(f.at(path), /xz1220\/open-dynamic-workflows\/action@v0\.9\.0/, path);
  }
  // Dated research notes are a record: left as written.
  assert.equal(f.at("docs/research/user-needs-2026-10-round6.md"), researchBefore);

  assert.match(r.stdout, /Prepared v0\.9\.0 \(2026-10-20\):/);
  assert.match(r.stdout, /Nothing is committed, tagged or pushed/);
  assert.match(r.stdout, /\n {2}git add package\.json package-lock\.json CHANGELOG\.md README\.md README\.zh-CN\.md docs\/github-action\.md action\/action\.yml\n/);
  assert.match(r.stdout, /\n {2}git commit -m "chore\(release\): v0\.9\.0"\n {2}git tag -a v0\.9\.0 -m "v0\.9\.0"\n {2}git push origin HEAD v0\.9\.0\n/);
  assert.equal(existsSync(join(f.dir, ".git")), false);

  // A second release has nothing in Unreleased: refused, nothing written.
  const before = SNAPSHOT_PATHS.map(f.at);
  const again = f.prepare("0.9.1", "--date", "2026-10-21");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /prepare-release: CHANGELOG\.md's "## Unreleased" section is empty: nothing to release/);
  assert.deepEqual(SNAPSHOT_PATHS.map(f.at), before);
});

test("prepare-release (temp copy): --dry-run reports and writes nothing; a bad version or date writes nothing", (t) => {
  const f = copyRepo(t);
  const before = SNAPSHOT_PATHS.map(f.at);
  const dry = f.prepare("0.9.0", "--dry-run", "--date=2026-10-20");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would prepare v0\.9\.0 \(2026-10-20\):\n {2}package\.json: \S+ → 0\.9\.0\n/);
  assert.match(dry.stdout, /docs\/github-action\.md: 2 action pins → @v0\.9\.0/);
  assert.match(dry.stdout, /Dry run: nothing written\./);
  assert.doesNotMatch(dry.stdout, /git tag/);
  assert.deepEqual(SNAPSHOT_PATHS.map(f.at), before);

  for (const [args, error] of [
    [["latest"], /version must be a semantic version such as 0\.9\.0; got 'latest'/],
    [["0.9"], /version must be a semantic version/],
    [["0.9.0", "--date", "2026-02-30"], /--date must be a calendar date YYYY-MM-DD; got '2026-02-30'/],
    [["0.9.0", "--date"], /--date needs a value/],
    [["0.4.0"], /version 0\.4\.0 is lower than package\.json's/],
    [["0.9.0", "1.0.0"], /unexpected argument '1\.0\.0'/],
    [[], /usage: prepare-release\.mjs <version>/],
  ] as const) {
    const r = f.prepare(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, error, args.join(" "));
  }
  assert.deepEqual(SNAPSHOT_PATHS.map(f.at), before);
});

test("prepare-release (temp copy): releasing the version package.json already has leaves it alone", (t) => {
  const f = copyRepo(t);
  const current = JSON.parse(f.at("package.json")).version as string;
  const pkg = f.at("package.json");
  const r = f.prepare(current, "--date", "2026-10-20");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.at("package.json"), pkg);
  assert.doesNotMatch(r.stdout, / {2}package\.json:/);
  assert.match(f.at("CHANGELOG.md"), new RegExp(`\\n## ${current.replace(/\./g, "\\.")} — 2026-10-20\\n`));
});
