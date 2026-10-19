#!/usr/bin/env node
// Get the checkout ready to tag a release — it never commits, tags or pushes.
//
//   node scripts/prepare-release.mjs <version> [--date YYYY-MM-DD] [--dry-run]
//
// It sets package.json and package-lock.json to <version>, renames CHANGELOG.md's
// "## Unreleased" to "## <version> — <date>" (today by default) under a new, empty
// "## Unreleased", and points every `xz1220/open-dynamic-workflows/action@v…` pin
// (a release, or the `v0.X.Y` placeholder) in README*.md, docs/ (not the dated
// notes in docs/research/) and action/action.yml at the new tag. Then it prints the
// git commands that commit, tag and push it, for the maintainer to run.
// --dry-run reports the same and writes nothing.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findSection } from "./changelog.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const PIN = /xz1220\/open-dynamic-workflows\/action@v(?:0\.X\.Y|\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)(?![0-9A-Za-z.-]*[0-9A-Za-z])/g;
const PIN_FILES = /\.(md|html|ya?ml)$/;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** -1, 0 or 1 comparing major.minor.patch; a prerelease sorts before its release. */
function compareVersions(a, b) {
  const parse = (v) => { const [core, pre] = v.split(/-(.*)/s); return [...core.split(".").map(Number), pre ?? null]; };
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1;
  if (y[3] === null) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/** CHANGELOG.md with "## Unreleased" renamed to the release, under a new empty one. */
export function releaseChangelog(text, version, date) {
  const unreleased = findSection(text, "Unreleased");
  if (!unreleased) throw new Error('CHANGELOG.md has no "## Unreleased" section to release');
  if (!unreleased.body) throw new Error('CHANGELOG.md\'s "## Unreleased" section is empty: nothing to release');
  if (findSection(text, version)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const lines = text.split("\n");
  lines.splice(unreleased.start, 1, "## Unreleased", "", `## ${version} — ${date}`);
  return lines.join("\n");
}

/** `text` with every action pin pointing at `v<version>`, and how many changed. */
export function rewritePins(text, version) {
  let count = 0;
  const out = text.replace(PIN, (pin) => {
    const next = `xz1220/open-dynamic-workflows/action@v${version}`;
    if (pin !== next) count++;
    return next;
  });
  return { text: out, count };
}

/** The files whose action pins are rewritten, relative to root. */
export function pinFiles(root) {
  const files = readdirSync(root).filter((f) => /^README.*\.md$/.test(f) && statSync(join(root, f)).isFile());
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split("\\").join("/");
      if (entry.isDirectory()) { if (rel !== "docs/research") walk(path); }
      else if (entry.isFile() && PIN_FILES.test(entry.name)) files.push(rel);
    }
  };
  if (existsSync(join(root, "docs"))) walk(join(root, "docs"));
  if (existsSync(join(root, "action", "action.yml"))) files.push("action/action.yml");
  // In a git checkout, only what git tracks: an ignored local draft would break the printed `git add`.
  const tracked = trackedFiles(root);
  return tracked ? files.filter((f) => tracked.has(f)) : files;
}

/** The files git tracks in `root`, or null outside a git checkout. */
function trackedFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Plan the release edits in `root`: `{ version, tag, date, changes: [{ file, text, note }] }`.
 * Throws, before anything is written, when the version, date or changelog is wrong.
 */
export function planRelease(root, input, date = today()) {
  const version = String(input ?? "").replace(/^v(?=\d)/, "");
  if (!SEMVER.test(version)) throw new Error(`version must be a semantic version such as 0.9.0; got '${input ?? ""}'`);
  if (!validDate(date)) throw new Error(`--date must be a calendar date YYYY-MM-DD; got '${date}'`);
  const read = (file) => readFileSync(join(root, file), "utf8");
  const changes = [];

  const pkg = JSON.parse(read("package.json"));
  if (compareVersions(version, pkg.version) < 0) throw new Error(`version ${version} is lower than package.json's ${pkg.version}`);
  if (pkg.version !== version) {
    changes.push({ file: "package.json", text: `${JSON.stringify({ ...pkg, version }, null, 2)}\n`, note: `${pkg.version} → ${version}` });
  }
  if (existsSync(join(root, "package-lock.json"))) {
    const lock = JSON.parse(read("package-lock.json"));
    if (lock.version !== version || lock.packages?.[""]?.version !== version) {
      lock.version = version;
      if (lock.packages?.[""]) lock.packages[""].version = version;
      changes.push({ file: "package-lock.json", text: `${JSON.stringify(lock, null, 2)}\n`, note: `→ ${version}` });
    }
  }

  changes.push({ file: "CHANGELOG.md", text: releaseChangelog(read("CHANGELOG.md"), version, date), note: `"## Unreleased" → "## ${version} — ${date}", new empty "## Unreleased"` });

  for (const file of pinFiles(root)) {
    const { text, count } = rewritePins(read(file), version);
    if (count) changes.push({ file, text, note: `${count} action pin${count === 1 ? "" : "s"} → @v${version}` });
  }
  return { version, tag: `v${version}`, date, changes };
}

/** The commands the maintainer runs after reviewing the edits. */
export function nextSteps(plan) {
  const files = plan.changes.map((c) => c.file).join(" ");
  return [
    "git diff",
    `git add ${files}`,
    `git commit -m "chore(release): ${plan.tag}"`,
    `git tag -a ${plan.tag} -m "${plan.tag}"`,
    `git push origin HEAD ${plan.tag}`,
  ];
}

function main(argv) {
  let version = null;
  let date;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--date") { date = argv[++i]; if (date === undefined) throw new Error("--date needs a value YYYY-MM-DD"); }
    else if (arg.startsWith("--date=")) date = arg.slice("--date=".length);
    else if (arg.startsWith("-") || version !== null) throw new Error(`unexpected argument '${arg}'\nusage: prepare-release.mjs <version> [--date YYYY-MM-DD] [--dry-run]`);
    else version = arg;
  }
  if (version === null) throw new Error("usage: prepare-release.mjs <version> [--date YYYY-MM-DD] [--dry-run]");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const plan = planRelease(root, version, date);
  console.log(`${dryRun ? "Would prepare" : "Prepared"} ${plan.tag} (${plan.date}):`);
  for (const change of plan.changes) {
    if (!dryRun) writeFileSync(join(root, change.file), change.text);
    console.log(`  ${change.file}: ${change.note}`);
  }
  if (dryRun) { console.log("\nDry run: nothing written."); return; }
  console.log("\nNothing is committed, tagged or pushed. Review, then run:");
  for (const command of nextSteps(plan)) console.log(`  ${command}`);
  console.log(`\nThe tag's push runs .github/workflows/release.yml: it publishes ${plan.tag} with the`);
  console.log(`"## ${plan.version} — ${plan.date}" section of CHANGELOG.md as the release notes.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(`prepare-release: ${err.message}`);
    process.exit(1);
  }
}
