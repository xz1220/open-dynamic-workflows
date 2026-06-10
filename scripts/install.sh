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
#                ODW_REF (skill source ref, default: main).
set -eu

REPO="xz1220/open-dynamic-workflows"
VERSION="${ODW_VERSION:-latest}"
REF="${ODW_REF:-main}"
BIN_DIR="${ODW_BIN_DIR:-$HOME/.local/bin}"

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
  echo "  cp -r skill ~/.claude/skills/open-dynamic-workflows" >&2
  exit 1
fi

ASSET="odw-$OS-$ARCH.gz"   # the binary is ~110 MB; the release ships it gzipped (~35 MB)

# Release tags carry a `v` prefix; accept ODW_VERSION both with and without it.
case "$VERSION" in
  latest|v*) ;;
  *) VERSION="v$VERSION" ;;
esac

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

# Stage downloads in a temp dir and move into place only when complete, so a
# failed/interrupted download never clobbers a working install.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- the binary (download compressed, decompress, then move into place) ------
echo "→ downloading $ASSET ($VERSION)"
mkdir -p "$BIN_DIR"
curl -fSL "$BASE/$ASSET" -o "$TMP/odw.gz"
gzip -dc "$TMP/odw.gz" > "$TMP/odw"
chmod +x "$TMP/odw"
mv -f "$TMP/odw" "$BIN_DIR/odw"

# --- the skill (into Claude Code's skills dir, else Codex's) -----------------
SKILL_DIR="$HOME/.claude/skills/open-dynamic-workflows"
if [ ! -d "$HOME/.claude" ]; then
  if [ -d "$HOME/.codex" ]; then
    SKILL_DIR="$HOME/.codex/skills/open-dynamic-workflows"
  else
    echo "  note: neither ~/.claude nor ~/.codex exists — installing the skill to $SKILL_DIR anyway;" >&2
    echo "        your agent will pick it up once it reads that skills directory" >&2
  fi
fi
echo "→ installing skill → $SKILL_DIR"
mkdir -p "$TMP/skill/references"
RAW="https://raw.githubusercontent.com/$REPO/$REF/skill"
curl -fSL "$RAW/SKILL.md"                 -o "$TMP/skill/SKILL.md"
curl -fSL "$RAW/references/primitives.md" -o "$TMP/skill/references/primitives.md"
curl -fSL "$RAW/references/adapters.md"   -o "$TMP/skill/references/adapters.md"
mkdir -p "$SKILL_DIR/references"
mv -f "$TMP/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
mv -f "$TMP/skill/references/primitives.md" "$SKILL_DIR/references/primitives.md"
mv -f "$TMP/skill/references/adapters.md" "$SKILL_DIR/references/adapters.md"

echo "✓ installed $("$BIN_DIR/odw" --version)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "  note: $BIN_DIR is not on your PATH — add it to your shell profile, e.g.:"
    echo "        echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
    ;;
esac
echo ""
echo "next steps:"
echo "  odw --version                       # confirm the binary works"
echo "  odw run <workflow.js> --wait        # run your first workflow"
echo "  or just ask your agent: \"use Open Dynamic Workflows to …\" — it picked up the skill"
