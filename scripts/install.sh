#!/bin/sh
# Open Dynamic Workflows — one-command installer.
#
# Downloads the self-contained `odw` binary (no Node.js required) and installs
# the workflow skill into your coding agent's skills directory. The whole install
# is a binary + a skill.
#
#   curl -fsSL https://raw.githubusercontent.com/xz1220/open-dynamic-workflows/main/scripts/install.sh | sh
#
# Env overrides: ODW_VERSION (default: latest), ODW_BIN_DIR (default: ~/.local/bin),
#                ODW_REF (skill source ref, default: the binary's release tag),
#                ODW_ALLOW_UNVERIFIED=1 (see below),
#                ODW_REQUIRE_CHECKSUMS=1 (see below; the GitHub Action sets it),
#                ODW_SKILL=0 (the binary only: no skill, no `odw init`; what the
#                GitHub Action in action/ installs on a CI runner).
#
# Integrity: the binary is checked against the release's SHA256SUMS asset
# before anything is installed. A checksum mismatch, or a SHA256SUMS that does
# not list the binary, always aborts. Releases before v0.5.0 predate SHA256SUMS
# and install with a warning — or abort under ODW_REQUIRE_CHECKSUMS=1. For any
# newer release, a missing SHA256SUMS (or no sha256sum/shasum on this machine)
# aborts unless ODW_ALLOW_UNVERIFIED=1.
#
# What the check does and does not do: it proves the download is the file the
# release's SHA256SUMS lists — no corruption, nothing swapped on the way. It
# does not prove the release is authentic: SHA256SUMS comes from the same
# release, so whoever can change the release's assets can change both.
set -eu

REPO="xz1220/open-dynamic-workflows"
VERSION="${ODW_VERSION:-latest}"
BIN_DIR="${ODW_BIN_DIR:-$HOME/.local/bin}"
WITH_SKILL=1
[ "${ODW_SKILL:-1}" != 0 ] || WITH_SKILL=0
case "$BIN_DIR" in /*) ;; *) BIN_DIR="$(pwd)/$BIN_DIR" ;; esac

# --- pick the right binary for this machine ---------------------------------
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "unsupported OS: $os — on Windows, download odw-win-x64.exe.gz from Releases" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

# No prebuilt binary for Intel macs (GitHub's Intel runners are retiring).
# odw is NOT on npm yet, so until then the working path is build-from-source.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  echo "No prebuilt binary for Intel macs. Build from source (needs Node >=20):" >&2
  echo "  git clone https://github.com/$REPO && cd open-dynamic-workflows" >&2
  echo "  npm ci && npm run build && npm i -g ." >&2
  echo "then copy the skill:" >&2
  echo "  cp -r skills/open-dynamic-workflows ~/.claude/skills/open-dynamic-workflows" >&2
  exit 1
fi

ASSET="odw-$OS-$ARCH.gz"   # the binary is ~110 MB; the release ships it gzipped (~35 MB)

# Release tags carry a `v` prefix; accept ODW_VERSION both with and without it.
case "$VERSION" in
  latest|v*) ;;
  *) VERSION="v$VERSION" ;;
esac

if [ "$VERSION" = "latest" ]; then
  # Resolve once: a new release during installation must not mix versions.
  # Reading curl's final URL avoids requiring a JSON parser or Node.js.
  RELEASE_URL="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  case "$RELEASE_URL" in
    "https://github.com/$REPO/releases/tag/"*) VERSION="${RELEASE_URL#"https://github.com/$REPO/releases/tag/"}" ;;
    *) echo "Could not resolve the latest release tag: $RELEASE_URL" >&2; exit 1 ;;
  esac
fi
case "$VERSION" in
  v[0-9]*) ;;
  *) echo "Invalid release version: $VERSION" >&2; exit 1 ;;
esac
case "$VERSION" in
  *[!A-Za-z0-9.+-]*) echo "Invalid release version: $VERSION" >&2; exit 1 ;;
esac
BASE="https://github.com/$REPO/releases/download/$VERSION"
REF="${ODW_REF:-$VERSION}"

# Download and validate everything before touching either installed component.
TMP="$(mktemp -d)"
BIN_STAGE=""
SKILL_STAGE=""
COMMITTED=0

# Backups are renamed entries, preserving symlinks/wrappers without following
# their targets. If recovery itself fails, retain the backup for manual recovery.
restore_entry() {
  [ -n "$1" ] || return 0
  if [ -e "$1/old" ] || [ -L "$1/old" ]; then
    rm -rf "$2" && mv "$1/old" "$2"
  elif [ -f "$1/absent" ]; then
    rm -rf "$2"
  fi
}
cleanup() {
  INSTALL_STATUS=$?
  trap - 0 HUP INT TERM
  set +e
  RECOVERED=1
  if [ "$COMMITTED" = 0 ]; then
    restore_entry "$SKILL_STAGE" "${SKILL_DIR:-}" || RECOVERED=0
    restore_entry "$BIN_STAGE" "$BIN_DIR/odw" || RECOVERED=0
  fi
  if [ "$RECOVERED" = 1 ]; then
    [ -z "$BIN_STAGE" ] || rm -rf "$BIN_STAGE"
    [ -z "$SKILL_STAGE" ] || rm -rf "$SKILL_STAGE"
  else
    echo "Upgrade failed; could not restore all files. Backups retained at:" >&2
    printf '  %s\n' "$BIN_STAGE" "$SKILL_STAGE" >&2
    INSTALL_STATUS=1
  fi
  rm -rf "$TMP"
  exit "$INSTALL_STATUS"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Releases before v0.5.0 were published before SHA256SUMS existed.
predates_checksums() {
  core="${VERSION#v}"
  core="${core%%[-+]*}"
  case "$core" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) return 1 ;;
  esac
  major="${core%%.*}"; rest="${core#*.}"; minor="${rest%%.*}"; patch="${rest#*.}"
  case "$major$minor$patch" in *[!0-9]*) return 1 ;; esac
  [ "$major" -eq 0 ] && [ "$minor" -lt 5 ]
}
# Verification is impossible here: abort, unless explicitly allowed.
unverified() {
  if [ "${ODW_ALLOW_UNVERIFIED:-}" = 1 ] && [ "${ODW_REQUIRE_CHECKSUMS:-}" != 1 ]; then
    echo "  warning: $1; installing an UNVERIFIED binary (ODW_ALLOW_UNVERIFIED=1)" >&2
  else
    echo "$1; refusing to install an unverified binary (set ODW_ALLOW_UNVERIFIED=1 to override)" >&2
    exit 1
  fi
}

# --- stage the binary -------------------------------------------------------
echo "→ downloading $ASSET ($VERSION)"
curl -fSL "$BASE/$ASSET" -o "$TMP/odw.gz"
# Only a missing SHA256SUMS counts as "no checksums"; transport failures fail.
if SUMS_HTTP="$(curl -fSL -w '%{http_code}' "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS")"; then
  EXPECTED="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print tolower($1); exit }' "$TMP/SHA256SUMS")"
  [ -n "$EXPECTED" ] || { echo "SHA256SUMS of $VERSION does not list $ASSET" >&2; exit 1; }
  ACTUAL="$({ sha256sum "$TMP/odw.gz" 2>/dev/null || shasum -a 256 "$TMP/odw.gz" 2>/dev/null; } | awk '{ print tolower($1) }')"
  if [ "${#ACTUAL}" -ne 64 ]; then
    unverified "cannot compute SHA-256 here (no sha256sum or shasum)"
  elif [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Checksum mismatch for $ASSET ($VERSION): SHA256SUMS lists $EXPECTED, downloaded $ACTUAL" >&2
    exit 1
  else
    echo "→ verified SHA-256 of $ASSET against SHA256SUMS"
  fi
elif [ "$SUMS_HTTP" = 404 ]; then
  if predates_checksums && [ "${ODW_REQUIRE_CHECKSUMS:-}" = 1 ]; then
    echo "$VERSION predates published checksums (SHA256SUMS); refusing to install it unverified (ODW_REQUIRE_CHECKSUMS=1)" >&2
    exit 1
  elif predates_checksums; then
    echo "  warning: $VERSION predates published checksums (SHA256SUMS); installing unverified" >&2
  else
    unverified "release $VERSION publishes no SHA256SUMS"
  fi
else
  echo "Could not download SHA256SUMS ($VERSION)" >&2; exit 1
fi
gzip -dc "$TMP/odw.gz" > "$TMP/odw"
chmod +x "$TMP/odw"

# --- the skill (into Claude Code's skills dir, else Codex's) -----------------
# (skipped with ODW_SKILL=0, down to its staging and replacement below)
if [ "$WITH_SKILL" = 1 ]; then
SKILL_DIR="$HOME/.claude/skills/open-dynamic-workflows"
if [ ! -d "$HOME/.claude" ]; then
  if [ -d "$HOME/.codex" ]; then
    SKILL_DIR="$HOME/.codex/skills/open-dynamic-workflows"
  else
    echo "  note: neither ~/.claude nor ~/.codex exists — installing the skill to $SKILL_DIR anyway;" >&2
    echo "        your agent will pick it up once it reads that skills directory" >&2
  fi
fi
echo "→ downloading skill ($REF) → $SKILL_DIR"
mkdir -p "$TMP/open-dynamic-workflows/references"
RAW="https://raw.githubusercontent.com/$REPO/$REF/skills/open-dynamic-workflows"
# Releases through v0.4.0 used skill/, before packages were consolidated. Only
# a missing entrypoint selects that layout; transport failures must still fail.
if SKILL_HTTP="$(curl -fSL -w '%{http_code}' "$RAW/SKILL.md" -o "$TMP/open-dynamic-workflows/SKILL.md")"; then
  :
elif [ "$SKILL_HTTP" = 404 ]; then
  RAW="https://raw.githubusercontent.com/$REPO/$REF/skill"
  curl -fSL "$RAW/SKILL.md" -o "$TMP/open-dynamic-workflows/SKILL.md"
else
  echo "Could not download skill entrypoint ($REF)" >&2; exit 1
fi
curl -fSL "$RAW/references/primitives.md" -o "$TMP/open-dynamic-workflows/references/primitives.md"
curl -fSL "$RAW/references/adapters.md"   -o "$TMP/open-dynamic-workflows/references/adapters.md"
for DOC in SKILL.md references/primitives.md references/adapters.md; do
  [ -s "$TMP/open-dynamic-workflows/$DOC" ] || { echo "Downloaded an empty skill file: $DOC" >&2; exit 1; }
done
fi   # WITH_SKILL

ODW_VER="$("$TMP/odw" --version)"
case "$ODW_VER" in
  "open-dynamic-workflows ${VERSION#v}"|"open-dynamic-workflows ${VERSION#v}+"*) ;;
  *) echo "Downloaded binary reports '$ODW_VER'; expected ${VERSION#v}" >&2; exit 1 ;;
esac
HELP_OUT="$("$TMP/odw" --help)"

# Prepare replacements on each destination filesystem, so every mv is a
# rename. Copy the existing skill first to retain custom files. Dereference
# only its root and references directory; replace owned file symlinks in the
# copy, never writing through links into an existing installation.
mkdir -p "$BIN_DIR"
BIN_STAGE="$(mktemp -d "$BIN_DIR/.odw-install.XXXXXX")"
if [ -d "$BIN_DIR/odw" ] && [ ! -L "$BIN_DIR/odw" ]; then
  echo "Refusing to replace a directory: $BIN_DIR/odw" >&2; exit 1
fi
cp -p "$TMP/odw" "$BIN_STAGE/new"
if [ "$WITH_SKILL" = 1 ]; then
mkdir -p "$(dirname "$SKILL_DIR")"
SKILL_STAGE="$(mktemp -d "$(dirname "$SKILL_DIR")/.odw-install.XXXXXX")"
mkdir "$SKILL_STAGE/new"
if [ -d "$SKILL_DIR" ]; then
  cp -pRP "$SKILL_DIR/." "$SKILL_STAGE/new"
elif [ -e "$SKILL_DIR" ] && [ ! -L "$SKILL_DIR" ]; then
  echo "Expected a skill directory: $SKILL_DIR" >&2; exit 1
fi
chmod u+rwx "$SKILL_STAGE/new"
if [ -L "$SKILL_STAGE/new/references" ]; then
  rm "$SKILL_STAGE/new/references"
  mkdir "$SKILL_STAGE/new/references"
  if [ -d "$SKILL_DIR/references" ]; then
    cp -pRP "$SKILL_DIR/references/." "$SKILL_STAGE/new/references"
  fi
else
  mkdir -p "$SKILL_STAGE/new/references"
fi
chmod u+rwx "$SKILL_STAGE/new/references"
for DOC in SKILL.md references/primitives.md references/adapters.md; do
  rm -f "$SKILL_STAGE/new/$DOC"
  cp "$TMP/open-dynamic-workflows/$DOC" "$SKILL_STAGE/new/$DOC"
done
fi   # WITH_SKILL

replace_entry() {
  if [ -e "$2" ] || [ -L "$2" ]; then
    mv "$2" "$1/old"
  else
    : > "$1/absent"
  fi
  mv "$1/new" "$2"
}
replace_entry "$BIN_STAGE" "$BIN_DIR/odw"
[ "$WITH_SKILL" = 0 ] || replace_entry "$SKILL_STAGE" "$SKILL_DIR"
COMMITTED=1

echo "✓ installed $ODW_VER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "  note: $BIN_DIR is not on your PATH — add it to your shell profile, e.g.:"
    echo "        echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
    ;;
esac

# --- pick the default agent ---------------------------------------------------
# With several agent CLIs installed, odw needs to know which one bare agent()
# calls drive; `odw init` detects what's on PATH and settles it now instead of
# at the first failing run. All the logic lives in the binary — the shell only
# routes a keyboard to it: under curl|sh stdin is the script stream, so the
# interactive pick reads /dev/tty; with no keyboard (agent-driven installs, CI)
# init degrades to a report telling the agent to ask its user and run
# `odw init --adapter <name>`. The --help probe skips all of this when
# ODW_VERSION pins a release that predates `odw init`.
if [ "$WITH_SKILL" = 1 ] && printf '%s\n' "$HELP_OUT" | grep -q "odw init"; then
  echo ""
  # Interactive only as the terminal's FOREGROUND job: a backgrounded install
  # (`curl … | sh &`) that read /dev/tty would be stopped cold by SIGTTIN.
  FG_PGID="$(ps -o tpgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
  MY_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
  if [ -z "${CI:-}" ] && [ -z "${ODW_DETACH:-}" ] && [ "$FG_PGID" = "$MY_PGID" ] \
     && ( : </dev/tty ) 2>/dev/null; then
    "$BIN_DIR/odw" init </dev/tty || true
  else
    "$BIN_DIR/odw" init --check || true
  fi
fi   # release predates `odw init`: nothing to run

echo ""
echo "next steps:"
echo "  odw --version                       # confirm the binary works"
if printf '%s\n' "$HELP_OUT" | grep -q "odw init"; then
  echo "  odw init                            # (re)pick the default agent, if you skipped it above"
fi
if printf '%s\n' "$HELP_OUT" | grep -q "odw new"; then
  # The first run, for $0 — the same steps bare `odw` and `odw doctor` show.
  echo "  odw new hello                       # a starter workflow and its test"
  echo "  odw run hello --dry                 # watch it run, every agent stubbed: \$0"
  echo "  odw serve --open                    # the dashboard"
else
  echo "  odw run <workflow.js> --wait        # run your first workflow"
fi
echo "  or just ask your agent: \"use Open Dynamic Workflows to …\" — it picked up the skill"
