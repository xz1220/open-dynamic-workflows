# An image for ODW's container sandbox (an ODW extension): Node, git and the
# Claude Code and Codex CLIs. ODW runs each agent CLI in a fresh container of
# it — `<engine> run --rm -i … odw-agents <the CLI's argv>` — and never pulls
# it: build it yourself.
#
#   docker build -t odw-agents \
#     --build-arg UID=$(id -u) --build-arg GID=$(id -g) examples/sandbox
#   odw doctor                       # engine found, image present, smoke run
#   odw run wf.js --sandbox container --sandbox-image odw-agents
#
# (podman build works the same.) UID/GID give your uid a user and a home in
# /etc/passwd, which some tools look up; ODW runs the container as your
# uid:gid either way, so what agents write in your workspace stays yours.
#
# Pin the CLI versions you trust (CLAUDE_CODE_VERSION, CODEX_VERSION) and
# rebuild to update them. Add what your agents' work needs — a language
# toolchain, test runners — here: the container's root filesystem is
# read-only at run time, and only the workspace, a private home and /tmp are
# writable.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG UID=1000
ARG GID=1000

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# Your uid as a named user (the node image's own `node` user is uid 1000).
RUN if ! getent group "${GID}" >/dev/null; then groupadd -g "${GID}" odw; fi \
 && if ! getent passwd "${UID}" >/dev/null; then useradd -m -u "${UID}" -g "${GID}" odw; fi

# ODW sets HOME to a private directory bound at /odw/home, holding a copy of
# the CLI's login; git there needs to know the workspace is yours.
ENV GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*

# No ENTRYPOINT of our own: the node image's runs the command it is given.
