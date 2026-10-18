#!/usr/bin/env bash
# The container sandbox on a real engine (CI: Docker on ubuntu-latest). The unit
# and fake-engine tests pin the argv; this checks what the engine does with it:
# the workspace is writable at its own path, the agent runs as the host's uid,
# the root filesystem is read-only, the host's PATH stays out, and exec() steps
# have no network.
set -euo pipefail
engine="${ODW_SANDBOX_ENGINE:-docker}"
here="$(cd "$(dirname "$0")/../.." && pwd)"
image="odw-sandbox-ci:1"
"$engine" build -q -t "$image" "$here/tests/fixtures/sandbox-ci" >/dev/null

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
proj="$work/proj"
mkdir -p "$proj/.odw/workflows"
git -C "$proj" init -q
cat > "$proj/odw.config.json" <<JSON
{
  "defaultAdapter": "probe",
  "runsRoot": "$work/runs",
  "adapters": { "probe": { "command": ["probe-agent"], "stdin": "{prompt}" } },
  "sandbox": { "kind": "container", "engine": "$engine", "image": "$image", "cliConfig": "none" }
}
JSON
cat > "$proj/.odw/workflows/probe.js" <<'JS'
export const meta = { name: "probe", description: "what an agent can do in its container" };
const report = JSON.parse(await agent("probe the sandbox", { label: "probe" }));
const offline = await exec(["node", "-e", "require('dns').lookup('example.com', (e) => process.exit(e ? 7 : 0))"], { label: "net" });
return { report, offlineExit: offline.exitCode };
JS

cd "$proj"
node "$here/dist/cli.js" doctor --json > "$work/doctor.json" || true
run="$(node "$here/dist/cli.js" run probe --wait 2>"$work/run.err" | tail -1 || true)"
id="$(ls "$work/runs/probe" | head -1)"
result="$work/runs/probe/$id/result.json"
if [ ! -f "$result" ]; then
  echo "the sandboxed run left no result" >&2
  cat "$work/run.err" >&2
  cat "$work/runs/probe/$id/error.json" >&2 2>/dev/null || true
  tail -40 "$work/runs/probe/$id/events.jsonl" >&2 2>/dev/null || true
  exit 1
fi
cat "$result"
node - "$result" "$proj" "$(id -u)" <<'NODE'
const [file, proj, uid] = process.argv.slice(2);
const { readFileSync, existsSync } = require("node:fs");
const raw = JSON.parse(readFileSync(file, "utf8"));
const { report, offlineExit } = raw.value ?? raw;
const fail = (why) => { console.error(`sandbox check failed: ${why}`); process.exit(1); };
if (report.cwd !== proj) fail(`workspace at ${report.cwd}, not ${proj}`);
if (String(report.uid) !== uid) fail(`ran as uid ${report.uid}, not the host's ${uid}`);
if (!report.wroteWorkspace || !existsSync(`${proj}/from-container.txt`)) fail("could not write its workspace");
if (report.wroteRoot) fail("could write the root filesystem");
if (report.wroteGit) fail("could write the workspace's .git");
if (!report.wroteTmp) fail("could not write /tmp");
if (report.hostPathLeaked) fail("the host's PATH reached the container");
if (offlineExit === 0) fail("an exec() step reached the network");
console.log("sandbox on a real engine: ok");
NODE
