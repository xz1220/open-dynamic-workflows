# The image the real-engine sandbox check (scripts/ci/sandbox-real.sh) runs
# agents in: node, plus a stand-in agent CLI that reports what it could do.
FROM node:22-alpine
COPY probe-agent.mjs /usr/local/bin/probe-agent
RUN chmod 755 /usr/local/bin/probe-agent
