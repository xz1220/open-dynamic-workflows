#!/usr/bin/env bash
# `odw run --on ssh://…` against a real sshd (CI: ubuntu-latest). The tests run
# the flow through a fake ssh; this checks it over the real thing: a second
# local user stands in for the server, with its own home, odw config and
# runs root, reached as ssh://odwremote@localhost.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
node_bin="$(command -v node)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The "server": a user with odw on PATH (this checkout's build) and a stand-in agent.
sudo useradd -m -s /bin/bash odwremote
# The checkout's home is not readable by another user: install the build where it is.
sudo mkdir -p /opt/odw && sudo cp -r "$here/dist" "$here/package.json" /opt/odw/ && sudo chmod -R a+rX /opt/odw
sudo tee /usr/local/bin/odw >/dev/null <<SH
#!/bin/sh
exec "$node_bin" /opt/odw/dist/cli.js "\$@"
SH
sudo chmod 755 /usr/local/bin/odw
sudo -u odwremote mkdir -p /home/odwremote/.config/odw /home/odwremote/.ssh
sudo -u odwremote tee /home/odwremote/agent.mjs >/dev/null <<'JS'
let p = ""; process.stdin.on("data", (d) => (p += d)); process.stdin.on("end", () => process.stdout.write("remote answered: " + p.trim().slice(0, 40)));
JS
sudo -u odwremote tee /home/odwremote/.config/odw/config.json >/dev/null <<JSON
{ "defaultAdapter": "stand-in", "runsRoot": "/home/odwremote/runs",
  "adapters": { "stand-in": { "command": ["$node_bin", "/home/odwremote/agent.mjs"], "stdin": "{prompt}" } } }
JSON

# sshd with a key for this user.
sudo apt-get install -y -qq openssh-server >/dev/null
sudo mkdir -p /run/sshd && sudo /usr/sbin/sshd
ssh-keygen -q -t ed25519 -N "" -f "$work/key"
sudo tee /home/odwremote/.ssh/authorized_keys < "$work/key.pub" >/dev/null
sudo chown -R odwremote: /home/odwremote/.ssh && sudo chmod 700 /home/odwremote/.ssh && sudo chmod 600 /home/odwremote/.ssh/authorized_keys
mkdir -p ~/.ssh && ssh-keyscan -H localhost >> ~/.ssh/known_hosts 2>/dev/null
cat > "$work/ssh" <<SH
#!/bin/sh
exec ssh -i "$work/key" -o BatchMode=yes "\$@"
SH
chmod +x "$work/ssh"
export ODW_SSH="$work/ssh"

# The local project: a git repo with a workflow and an uncommitted change.
proj="$work/proj"
mkdir -p "$proj"
git -C "$proj" init -q
cat > "$proj/wf.js" <<'JS'
export const meta = { name: "over-ssh", description: "one agent on the remote" };
return { reply: await agent("hello from the laptop", { label: "a" }), host: args.host };
JS
git -C "$proj" add -A && git -C "$proj" -c user.email=t@t -c user.name=t commit -q -m init
echo "uncommitted" > "$proj/NOTE.txt"

url="ssh://odwremote@localhost"
id="$(node "$here/dist/cli.js" run wf.js --on "$url" --source "$proj" --args '{"host":"ci"}' 2>"$work/run.err" | tail -1)" || { cat "$work/run.err" >&2; exit 1; }
echo "remote run: $id"
for _ in $(seq 1 60); do
  state="$(node "$here/dist/cli.js" status "$id" --on "$url" 2>/dev/null | head -5 || true)"
  echo "$state" | grep -qE "done|failed|stopped" && break
  sleep 1
done
echo "$state"
echo "$state" | grep -q done || { echo "the remote run did not finish done" >&2; exit 1; }
sudo test -f /home/odwremote/odw-remote/proj/NOTE.txt || { echo "the uncommitted file did not travel" >&2; exit 1; }

node "$here/dist/cli.js" pull "$id" --from "$url" --runs-root "$work/local-runs"
result="$(node "$here/dist/cli.js" result "$id" --runs-root "$work/local-runs")"
echo "$result"
# The stand-in echoes the start of its prompt (odw's preamble comes first); args travelled too.
echo "$result" | grep -q '"reply": "remote answered: ' && echo "$result" | grep -q '"host": "ci"' || { echo "the pulled result is wrong" >&2; exit 1; }
if find "$work/local-runs" -type l | grep -q .; then echo "the pull kept links" >&2; exit 1; fi
echo "remote run over a real sshd: ok"
