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
  *) echo "unsupported OS: $os — on Windows, download odw-win-x64.exe from Releases" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
ASSET="odw-$OS-$ARCH"

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

# --- the binary --------------------------------------------------------------
echo "→ downloading $ASSET ($VERSION)"
mkdir -p "$BIN_DIR"
curl -fSL "$BASE/$ASSET" -o "$BIN_DIR/odw"
chmod +x "$BIN_DIR/odw"

# --- the skill (into Claude Code's skills dir, else Codex's) -----------------
SKILL_DIR="$HOME/.claude/skills/open-dynamic-workflows"
[ -d "$HOME/.claude" ] || { [ -d "$HOME/.codex" ] && SKILL_DIR="$HOME/.codex/skills/open-dynamic-workflows"; }
echo "→ installing skill → $SKILL_DIR"
mkdir -p "$SKILL_DIR/references"
RAW="https://raw.githubusercontent.com/$REPO/$REF/skill"
curl -fSL "$RAW/SKILL.md"                 -o "$SKILL_DIR/SKILL.md"
curl -fSL "$RAW/references/primitives.md" -o "$SKILL_DIR/references/primitives.md"
curl -fSL "$RAW/references/adapters.md"   -o "$SKILL_DIR/references/adapters.md"

echo "✓ installed $("$BIN_DIR/odw" --version)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  note: add $BIN_DIR to your PATH — e.g.  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
