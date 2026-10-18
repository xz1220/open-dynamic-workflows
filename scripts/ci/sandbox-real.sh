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

# The egress allowlist: the agent's container is on an internal network of
# the run, its only way out the proxy sidecar. example.com is allowlisted
# (fetched over TLS through the tunnel), example.org is not (403, and an
# egress_denied event naming the agent), example.com does not resolve inside
# the agent's container (no DNS around the proxy), and a connection around the
# proxy gets nowhere. The doctor's egress check passes, and nothing is left behind.
egress="$work/egress"
mkdir -p "$egress/.odw/workflows"
git -C "$egress" init -q
cat > "$egress/odw.config.json" <<JSON
{
  "defaultAdapter": "probe",
  "runsRoot": "$work/egress-runs",
  "adapters": { "probe": { "command": ["egress-probe"], "stdin": "{prompt}" } },
  "sandbox": { "kind": "container", "engine": "$engine", "image": "$image", "cliConfig": "none",
               "network": { "allow": ["example.com"] } }
}
JSON
cat > "$egress/.odw/workflows/egress.js" <<'JS'
export const meta = { name: "egress", description: "what an agent behind an egress allowlist can reach" };
return JSON.parse(await agent("fetch example.com example.org", { label: "egress" }));
JS
cd "$egress"
node "$here/dist/cli.js" doctor --json > "$work/egress-doctor.json" || true
node "$here/dist/cli.js" run egress --wait 2>"$work/egress.err" >/dev/null || true
eid="$(ls "$work/egress-runs/egress" | head -1)"
edir="$work/egress-runs/egress/$eid"
if [ ! -f "$edir/result.json" ]; then
  echo "the egress run left no result" >&2
  cat "$work/egress.err" >&2
  tail -40 "$edir/events.jsonl" >&2 2>/dev/null || true
  exit 1
fi
cat "$edir/result.json"
node - "$edir" "$work/egress-doctor.json" <<'NODE'
const [dir, doctorFile] = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const fail = (why) => { console.error(`egress check failed: ${why}`); process.exit(1); };
const raw = JSON.parse(readFileSync(`${dir}/result.json`, "utf8"));
const report = raw.value ?? raw;
const allowed = report.fetched["example.com"];
const denied = report.fetched["example.org"];
if (!/^http:\/\/1:odw@odw-/.test(report.proxyVar ?? "")) fail(`HTTPS_PROXY was ${report.proxyVar}`);
if (allowed.proxy !== 200 || !(allowed.https >= 200 && allowed.https < 500)) fail(`example.com through the proxy: ${JSON.stringify(allowed)}`);
if (denied.proxy !== 403) fail(`example.org was not refused: ${JSON.stringify(denied)}`);
if (report.dns !== false) fail(`example.com resolved inside the agent's container: ${JSON.stringify(report.dns)}`);
if (report.direct) fail("a connection around the proxy got out");
const events = readFileSync(`${dir}/events.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const denial = events.find((e) => e.type === "egress_denied" && e.host === "example.org");
if (!denial) fail("no egress_denied event for example.org");
if (denial.agent !== 1) fail(`the denial named agent ${denial.agent}, not 1`);
if (events.some((e) => e.type === "egress_denied" && e.host === "example.com")) fail("example.com was denied");
const doctor = JSON.parse(readFileSync(doctorFile, "utf8"));
const check = (doctor.checks ?? []).find((c) => c.id === "sandbox:egress");
if (!check || check.status !== "ok") fail(`doctor's egress check: ${JSON.stringify(check)}`);
if (!/example\.com did not resolve/.test(check.detail)) fail(`doctor's egress check did not try DNS: ${check.detail}`);
console.log("egress allowlist on a real engine: ok");
NODE
left="$("$engine" ps -a --filter label=odw.role=egress-proxy --format '{{.Names}}')"
nets="$("$engine" network ls --filter label=odw.run --format '{{.Name}}')"
if [ -n "$left" ] || [ -n "$nets" ]; then
  echo "left behind: proxies [$left] networks [$nets]" >&2
  exit 1
fi
